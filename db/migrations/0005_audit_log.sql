-- ===========================================================================
-- 0005  Audit log — append-only, and NOT readable by tenants
-- ===========================================================================

CREATE TABLE IF NOT EXISTS audit_log (
  id             bigserial PRIMARY KEY,
  ts             timestamptz NOT NULL DEFAULT now(),
  org_id         uuid,             -- NOT a FK: audit rows outlive org deletion
  credential_id  uuid,
  tool_name      text NOT NULL,
  arguments      jsonb NOT NULL DEFAULT '{}'::jsonb,
  generated_sql  text,
  rows_returned  int,
  latency_ms     int,
  status         text NOT NULL,    -- ok | empty | error | denied | rate_limited
  error_code     text,
  -- Full internal error text. Deliberately stored here and NEVER returned to
  -- the caller: a raw Postgres error can carry another tenant's table or
  -- constraint details. Callers get a sanitised code + hint instead.
  error_detail   text,
  client_ip      text,

  CONSTRAINT audit_status_known CHECK (
    status IN ('ok', 'empty', 'error', 'denied', 'rate_limited')
  )
);

CREATE INDEX IF NOT EXISTS idx_audit_org_ts ON audit_log(org_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_cred_ts ON audit_log(credential_id, ts DESC);

-- Append-only by construction: the trigger below rejects UPDATE and DELETE for
-- every role including the owner. Revoking the privilege alone would still let
-- a superuser or a future owner-role mistake rewrite history.
CREATE OR REPLACE FUNCTION audit_log_is_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (attempted %)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_log_append_only ON audit_log;
CREATE TRIGGER trg_audit_log_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_is_append_only();

-- ---------------------------------------------------------------------------
-- Rate limiting state, per credential, fixed one-minute windows.
--
-- In the database rather than in process memory on purpose: the server is
-- meant to run more than one replica, and an in-memory counter would give an
-- attacker N x the limit by spreading requests across replicas.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  credential_id uuid NOT NULL,
  window_start  timestamptz NOT NULL,
  request_count int NOT NULL DEFAULT 0,
  PRIMARY KEY (credential_id, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_window ON rate_limit_buckets(window_start);
