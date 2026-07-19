-- ===========================================================================
-- 0001  Extensions + tenant-context helpers
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- similarity() for "did you mean" errors

-- ---------------------------------------------------------------------------
-- app.current_org_id is the single source of tenant truth inside the database.
-- It is set with SET LOCAL inside an explicit transaction, never plain SET,
-- because Supabase's transaction-mode pooler hands the same backend to
-- different clients between transactions. A plain SET would survive the
-- handoff and leak Org A's context into Org B's next query.
--
-- current_org_id() is written so that an UNSET context is a hard denial rather
-- than an error or a wildcard:
--   * current_setting(..., true) returns NULL when the GUC was never set
--   * an empty string is normalised to NULL by nullif
--   * NULL = anything is NULL, which RLS treats as "row not visible"
-- So a query that forgets to open a tenant session returns zero rows. It never
-- returns everyone's rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_org_id()
RETURNS uuid
LANGUAGE sql
STABLE
-- No SECURITY DEFINER: this must run with the caller's privileges.
SET search_path = pg_catalog, public
AS $$
  SELECT nullif(current_setting('app.current_org_id', true), '')::uuid;
$$;

COMMENT ON FUNCTION public.current_org_id() IS
  'Resolves the tenant for the current transaction. NULL (deny-all) when unset.';

-- ---------------------------------------------------------------------------
-- Defensive JSONB casting. Client SDKs are inconsistent: the same property key
-- arrives as 199, "199", "199.00" or "" across rows in the same org. A plain
-- ::numeric cast raises and kills the whole aggregate. These helpers return
-- NULL for anything unparseable so null-safe aggregates keep working.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jsonb_to_numeric(val jsonb)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  txt text;
BEGIN
  IF val IS NULL OR jsonb_typeof(val) IN ('null', 'object', 'array', 'boolean') THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(val) = 'number' THEN
    RETURN val::text::numeric;
  END IF;

  -- string: strip currency symbols, thousands separators and whitespace
  txt := regexp_replace(trim(both '"' from val::text), '[^0-9.\-]', '', 'g');
  IF txt = '' OR txt = '-' OR txt = '.' THEN
    RETURN NULL;
  END IF;

  RETURN txt::numeric;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.jsonb_to_numeric(jsonb) IS
  'Best-effort numeric coercion for mixed-type JSONB properties. NULL on failure, never raises.';

CREATE OR REPLACE FUNCTION public.jsonb_to_text(val jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN val IS NULL OR jsonb_typeof(val) = 'null' THEN NULL
    WHEN jsonb_typeof(val) = 'string' THEN val #>> '{}'
    ELSE val::text
  END;
$$;

-- ---------------------------------------------------------------------------
-- PII masking. Applied at read time to property values that look like contact
-- details, so an analytics answer never carries a raw email or phone number
-- into the model's context window. See docs/pii-policy.md for the policy and
-- its (real) limits.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mask_pii(val text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN val IS NULL THEN NULL
    -- email: keep first char of local part + domain, mask the rest
    WHEN val ~ '^[^@[:space:]]+@[^@[:space:]]+\.[a-zA-Z]{2,}$'
      THEN left(val, 1) || '***@' || split_part(val, '@', 2)
    -- phone: 8+ digits with optional separators -> keep last 2
    WHEN regexp_replace(val, '[^0-9]', '', 'g') ~ '^[0-9]{8,15}$'
         AND val ~ '^[+0-9][0-9()+\-. ]{7,}$'
      THEN '***' || right(regexp_replace(val, '[^0-9]', '', 'g'), 2)
    ELSE val
  END;
$$;
