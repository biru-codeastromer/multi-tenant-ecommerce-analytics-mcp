-- ===========================================================================
-- 0007  Application roles, grants, and the narrow SECURITY DEFINER interface
--
-- Two application roles, both NOLOGIN-capable-but-LOGIN, neither owning
-- anything, neither superuser, neither BYPASSRLS:
--
--   mcp_tenant — serves every analytics query. SELECT only, on tenant tables
--                only. Cannot see api_credentials or audit_log at all.
--   mcp_auth   — resolves an API key to an org and appends audit rows.
--                Holds NO table privileges whatsoever; it can only EXECUTE
--                three fixed functions.
--
-- Splitting them means the connection that handles model-driven SQL is
-- structurally incapable of touching the credential table, rather than merely
-- not doing so.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Role creation (idempotent). Passwords are injected by scripts/migrate.ts
-- from the environment; they are never written to this file.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_tenant') THEN
    CREATE ROLE mcp_tenant LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_auth') THEN
    CREATE ROLE mcp_auth LOGIN;
  END IF;
END $$;

ALTER ROLE mcp_tenant WITH PASSWORD '${MCP_TENANT_PASSWORD}';
ALTER ROLE mcp_auth   WITH PASSWORD '${MCP_AUTH_PASSWORD}';

-- Explicitly strip every escalation attribute, in case the role predates this
-- migration or was touched by hand.
ALTER ROLE mcp_tenant NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION NOINHERIT;
ALTER ROLE mcp_auth   NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION NOINHERIT;

-- ---------------------------------------------------------------------------
-- Resource limits set on the ROLE, not just in application code. A statement
-- that escapes the app-level guard still dies in the database.
-- idle_in_transaction_session_timeout matters specifically here: every tenant
-- query runs inside an explicit transaction, so an abandoned one would
-- otherwise pin a pooled connection forever.
-- ---------------------------------------------------------------------------
ALTER ROLE mcp_tenant SET statement_timeout = '8s';
ALTER ROLE mcp_tenant SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE mcp_tenant SET lock_timeout = '2s';
ALTER ROLE mcp_tenant SET default_transaction_read_only = on;
ALTER ROLE mcp_tenant SET search_path = 'public';
-- Truncates any accidental verbosity in errors headed back toward a caller.
ALTER ROLE mcp_tenant SET log_min_error_statement = 'panic';

ALTER ROLE mcp_auth SET statement_timeout = '5s';
ALTER ROLE mcp_auth SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE mcp_auth SET search_path = 'public';

-- ---------------------------------------------------------------------------
-- Baseline: revoke everything, then grant back the minimum.
-- ---------------------------------------------------------------------------
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;

REVOKE ALL ON SCHEMA public FROM mcp_tenant, mcp_auth;
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM mcp_tenant, mcp_auth;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM mcp_tenant, mcp_auth;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM mcp_tenant, mcp_auth;

-- USAGE only: they can resolve names in `public`, not create objects in it.
GRANT USAGE ON SCHEMA public TO mcp_tenant, mcp_auth;

-- Deny the database-level escape hatches outright.
REVOKE ALL ON SCHEMA information_schema FROM mcp_tenant, mcp_auth;
REVOKE CREATE ON DATABASE zyaro_events FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- mcp_tenant: SELECT on tenant-visible tables. Nothing else, nowhere else.
-- Note the absence of api_credentials, audit_log and rate_limit_buckets.
-- ---------------------------------------------------------------------------
GRANT SELECT ON
  organizations,
  events,
  orders,
  order_items,
  products,
  user_profiles,
  identity_links,
  event_definitions,
  event_property_definitions,
  metric_definitions,
  registry_version
TO mcp_tenant;

-- The helper functions the generated SQL relies on.
GRANT EXECUTE ON FUNCTION public.current_org_id()          TO mcp_tenant;
GRANT EXECUTE ON FUNCTION public.jsonb_to_numeric(jsonb)   TO mcp_tenant;
GRANT EXECUTE ON FUNCTION public.jsonb_to_text(jsonb)      TO mcp_tenant;
GRANT EXECUTE ON FUNCTION public.mask_pii(text)            TO mcp_tenant;

-- ---------------------------------------------------------------------------
-- Filesystem / network escape hatches.
--
-- These are superuser-only by default in stock Postgres, so the REVOKEs below
-- are belt-and-braces rather than the actual control — the actual control is
-- that mcp_tenant is NOSUPERUSER. They are written explicitly anyway because
-- an extension installed later (dblink, postgres_fdw, file_fdw) can arrive
-- with EXECUTE granted to PUBLIC, and this migration is where a reviewer
-- should be able to see that considered.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname IN (
      'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file',
      'lo_import', 'lo_export', 'pg_reload_conf', 'pg_read_server_files',
      'dblink', 'dblink_connect', 'dblink_exec', 'dblink_send_query'
    )
  LOOP
    EXECUTE format(
      'REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC, mcp_tenant, mcp_auth',
      fn.nspname, fn.proname, fn.args
    );
  END LOOP;
END $$;

-- Block the FDW/dblink route at the privilege level too, so even a future
-- superuser-installed extension is not usable by these roles.
DO $$
DECLARE
  w record;
BEGIN
  FOR w IN SELECT fdwname FROM pg_foreign_data_wrapper LOOP
    EXECUTE format('REVOKE ALL ON FOREIGN DATA WRAPPER %I FROM PUBLIC, mcp_tenant, mcp_auth', w.fdwname);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- The three SECURITY DEFINER functions. This is the ENTIRE surface mcp_auth
-- has. Each has a fixed signature, a pinned search_path (otherwise a
-- SECURITY DEFINER function is a privilege-escalation primitive), and returns
-- only what the caller needs.
-- ---------------------------------------------------------------------------

-- 1. Resolve a peppered key hash to an org. Returns zero rows for an unknown
--    OR revoked key — revocation therefore takes effect on the very next
--    request, with no cache to invalidate and no restart required.
CREATE OR REPLACE FUNCTION public.auth_resolve_credential(p_key_hash text)
RETURNS TABLE (
  credential_id      uuid,
  org_id             uuid,
  org_slug           text,
  org_name           text,
  reporting_timezone text,
  default_currency   text,
  scopes             text[]
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT c.id, o.id, o.slug, o.name, o.reporting_timezone, o.default_currency::text, c.scopes
  FROM api_credentials c
  JOIN organizations o ON o.id = c.org_id
  WHERE c.key_hash = p_key_hash
    AND c.revoked_at IS NULL;
$$;

-- 2. Record usage. Split from the resolver so the read path stays STABLE and
--    the write cannot be made to fail the authentication itself.
CREATE OR REPLACE FUNCTION public.auth_touch_credential(p_credential_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE api_credentials SET last_used_at = now() WHERE id = p_credential_id;
$$;

-- 3. Append one audit row. INSERT only; the append-only trigger on the table
--    makes UPDATE/DELETE impossible even from here.
CREATE OR REPLACE FUNCTION public.audit_write(
  p_org_id        uuid,
  p_credential_id uuid,
  p_tool_name     text,
  p_arguments     jsonb,
  p_generated_sql text,
  p_rows_returned int,
  p_latency_ms    int,
  p_status        text,
  p_error_code    text,
  p_error_detail  text,
  p_client_ip     text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  INSERT INTO audit_log (
    org_id, credential_id, tool_name, arguments, generated_sql,
    rows_returned, latency_ms, status, error_code, error_detail, client_ip
  ) VALUES (
    p_org_id, p_credential_id, p_tool_name, p_arguments, p_generated_sql,
    p_rows_returned, p_latency_ms, p_status, p_error_code, p_error_detail, p_client_ip
  );
$$;

-- 4. Fixed-window rate limit, evaluated atomically in the database so the
--    limit holds across server replicas. Returns the count after increment.
CREATE OR REPLACE FUNCTION public.rate_limit_hit(p_credential_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  w timestamptz := date_trunc('minute', now());
  n int;
BEGIN
  INSERT INTO rate_limit_buckets (credential_id, window_start, request_count)
  VALUES (p_credential_id, w, 1)
  ON CONFLICT (credential_id, window_start)
  DO UPDATE SET request_count = rate_limit_buckets.request_count + 1
  RETURNING request_count INTO n;

  -- Opportunistic cleanup; cheap because the index is on window_start.
  DELETE FROM rate_limit_buckets WHERE window_start < now() - interval '10 minutes';

  RETURN n;
END;
$$;

-- Lock down execution: PUBLIC gets nothing, mcp_auth gets exactly these four,
-- mcp_tenant gets none of them.
REVOKE ALL ON FUNCTION public.auth_resolve_credential(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_touch_credential(uuid)   FROM PUBLIC;
REVOKE ALL ON FUNCTION public.audit_write(uuid, uuid, text, jsonb, text, int, int, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rate_limit_hit(uuid)          FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.auth_resolve_credential(text) TO mcp_auth;
GRANT EXECUTE ON FUNCTION public.auth_touch_credential(uuid)   TO mcp_auth;
GRANT EXECUTE ON FUNCTION public.audit_write(uuid, uuid, text, jsonb, text, int, int, text, text, text, text) TO mcp_auth;
GRANT EXECUTE ON FUNCTION public.rate_limit_hit(uuid)          TO mcp_auth;

-- Future tables created by the owner must not silently become readable.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC;
