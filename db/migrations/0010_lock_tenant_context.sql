-- ===========================================================================
-- 0010  Lock the tenant context against in-query switching
--
-- FIXES A REAL CROSS-TENANT LEAK found by tests/guard.test.ts.
--
-- THE VULNERABILITY
-- -----------------
-- RLS resolves the tenant through current_setting('app.current_org_id'). Any
-- role can call set_config() on a custom GUC. That privilege is granted to
-- PUBLIC by default. So a tenant reaching the raw-SQL tool could send:
--
--     SELECT set_config('app.current_org_id', '<other-org-uuid>', true),
--            (SELECT count(*) FROM events);
--
-- and read another tenant's rows. Verified exploitable before this migration:
-- authenticated as Nordvik, the query above returned FreshCart's 3,659 events.
--
-- The application-level SQL guard missed it because the guard strips string
-- literals before keyword matching (so a keyword hidden in a literal cannot
-- fool it), which also stripped the 'app.current_org_id' argument.
--
-- WHY THE FIX IS HERE AND NOT IN THE REGEX
-- ----------------------------------------
-- The guard is explicitly documented as convenience, not security. A fix that
-- lived only in a regex would contradict that and would fail the moment
-- someone found another spelling. So the capability is removed at the
-- privilege layer, and the guard rule added alongside is defence in depth.
--
-- TWO INDEPENDENT CONTROLS
-- ------------------------
--   1. mcp_tenant loses EXECUTE on set_config() entirely. It cannot write any
--      GUC, by any spelling, from any query.
--   2. set_tenant_context() refuses to change a context that is already set.
--      One tenant per transaction, enforced in the database. So even a role
--      that somehow regained set_config could not switch mid-transaction.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The only way the tenant role can establish its context.
--
-- CRITICAL IMPLEMENTATION NOTE: this function deliberately has NO `SET` clause
-- (no `SET search_path = ...`). A function carrying a SET clause pushes a GUC
-- nest level, and any set_config() performed inside it is REVERTED when the
-- function returns. Which would make this silently do nothing.
--
-- Omitting search_path on a SECURITY DEFINER function is normally a
-- privilege-escalation risk, because an attacker-controlled search_path can
-- hijack an unqualified name. That is neutralised here by fully qualifying
-- every identifier in the body with pg_catalog, so no name resolution depends
-- on search_path at all.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_tenant_context(p_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  existing text;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'tenant context cannot be null'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- NULLIF/COALESCE are SQL constructs, not pg_catalog functions, and cannot
  -- be schema-qualified. Since this function has no search_path SET clause
  -- (see the note above), everything in the body must be either qualified or
  -- a bare SQL construct. Hence the explicit IF rather than a NULLIF.
  existing := pg_catalog.current_setting('app.current_org_id', true);
  IF existing = '' THEN
    existing := NULL;
  END IF;

  -- One tenant per transaction. Re-setting the SAME value is tolerated so a
  -- retry or a nested helper is not a hard error; changing it is refused.
  IF existing IS NOT NULL AND existing <> p_org_id::text THEN
    RAISE EXCEPTION 'tenant context is already established for this transaction and cannot be changed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM pg_catalog.set_config('app.current_org_id', p_org_id::text, true);
END;
$$;

COMMENT ON FUNCTION public.set_tenant_context(uuid) IS
  'The only path by which mcp_tenant may establish its tenant context. Immutable once set within a transaction.';

REVOKE ALL ON FUNCTION public.set_tenant_context(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_tenant_context(uuid) TO mcp_tenant;

-- ---------------------------------------------------------------------------
-- Remove the raw capability.
--
-- set_config is granted to PUBLIC by default; revoking from PUBLIC removes it
-- from every non-superuser role, so it is granted back explicitly to the
-- principals that legitimately need it (the migration/seed/projection owner
-- and the auth role). mcp_tenant is deliberately absent from that list.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) FROM mcp_tenant;
GRANT  EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) TO CURRENT_USER;
GRANT  EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) TO mcp_auth;

-- current_setting() is read-only and cannot change the tenant, so it is not
-- revoked. Current_org_id() itself depends on it. The SQL guard still blocks
-- direct reads of app.current_org_id, purely to keep the tenant id out of
-- query results where it could end up in a model's context window.
