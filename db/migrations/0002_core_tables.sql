-- ===========================================================================
-- 0002  Core tables: organizations, credentials, raw event stream
-- ===========================================================================

CREATE TABLE IF NOT EXISTS organizations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  slug               text NOT NULL UNIQUE,
  vertical           text NOT NULL,
  -- Every date bucket the MCP produces is rendered in this zone. "Orders
  -- yesterday" for a Jaipur client is a UTC+05:30 day, not a UTC day.
  reporting_timezone text NOT NULL DEFAULT 'UTC',
  default_currency   char(3) NOT NULL DEFAULT 'INR',
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT organizations_slug_fmt CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  -- Rejects a typo'd zone at write time instead of at query time.
  CONSTRAINT organizations_tz_valid CHECK (now() AT TIME ZONE reporting_timezone IS NOT NULL),
  CONSTRAINT organizations_currency_fmt CHECK (default_currency ~ '^[A-Z]{3}$')
);

-- ---------------------------------------------------------------------------
-- api_credentials — how an MCP connection resolves to an org.
--
-- The org is derived from the credential and NOTHING else. No tool takes an
-- org_id argument, so there is no path from model output to tenant selection.
--
-- key_hash is sha256(pepper || raw_key). The raw key is shown once at creation
-- and never persisted. The pepper lives in the server env, so a database dump
-- alone does not let an attacker verify guessed keys offline.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_credentials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key_hash      text NOT NULL UNIQUE,
  key_prefix    text NOT NULL,          -- first 12 chars, for support/debug only
  label         text NOT NULL,
  scopes        text[] NOT NULL DEFAULT ARRAY['read:analytics'],
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,            -- checked on EVERY request, no cache

  CONSTRAINT api_credentials_hash_fmt CHECK (key_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_api_credentials_org ON api_credentials(org_id);
-- Partial index: revoked keys are dead weight on the hot lookup path.
CREATE INDEX IF NOT EXISTS idx_api_credentials_active
  ON api_credentials(key_hash) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- events — the append-only raw stream.
--
-- NOT partitioned. Justification in README §"Why no partitioning": at 20k seed
-- rows and a realistic near-term ceiling of low millions, a partitioned parent
-- costs planning time on every query and complicates the RLS story (policies
-- must be declared per partition or inherited carefully), while buying nothing
-- until retention-driven drops matter. The composite btree below is what
-- actually makes these queries fast. Monthly RANGE partitioning on event_time
-- is the documented next step, not a thing done for show.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  event_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_name     text NOT NULL,             -- raw name exactly as the client sent it
  event_time     timestamptz NOT NULL,      -- when it happened (client clock, clamped)
  ingested_at    timestamptz NOT NULL DEFAULT now(),
  user_id        text,                      -- logged-in identity, nullable
  anonymous_id   text,                      -- device / cookie id
  session_id     text,
  platform       text,                      -- ios | android | web | kiosk | pos
  properties     jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key     text,
  -- Set by the ingest clamp when the client clock was implausible. Surfaced in
  -- the data dictionary so the model knows the org has a clock problem rather
  -- than silently trusting a 1970 timestamp.
  clock_skew_flag boolean NOT NULL DEFAULT false,

  CONSTRAINT events_name_len CHECK (char_length(event_name) BETWEEN 1 AND 128),
  CONSTRAINT events_props_is_object CHECK (jsonb_typeof(properties) = 'object'),
  -- Hard clamp. Anything outside this window was rewritten at ingest time.
  CONSTRAINT events_time_sane CHECK (
    event_time >= timestamptz '2015-01-01' AND event_time < timestamptz '2100-01-01'
  )
);

-- Idempotent ingestion. Scoped to org so two tenants can independently use the
-- same client-side dedupe key without colliding.
CREATE UNIQUE INDEX IF NOT EXISTS uq_events_org_dedupe
  ON events(org_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
