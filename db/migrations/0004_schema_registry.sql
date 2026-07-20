-- ===========================================================================
-- 0004  The schema registry. What makes the MCP self-describing per tenant
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- event_definitions
--
-- One row per (org, raw event name). `canonical_name` is the mechanism that
-- lets a single question work across orgs with different taxonomies:
--   Org A: app_open      -> session_start
--   Org B: website_open  -> session_start
--   Org E: kiosk_open    -> session_start   (plus app_open AND website_open)
-- "How many sessions started yesterday?" resolves through the canonical layer
-- and is correct for all three, while list_events still shows each org its own
-- real names.
--
-- An org with NO event mapped to a requested canonical concept is an explicit
-- "this org doesn't track that" answer, never a silent zero. Enforced in
-- src/registry/canonical.ts, not by convention.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_definitions (
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_name       text NOT NULL,
  display_name     text,
  -- Human-written. The discovery job NEVER overwrites this column.
  description      text,
  category         text NOT NULL DEFAULT 'uncategorised',
  canonical_name   text,
  is_active        boolean NOT NULL DEFAULT true,
  first_seen_at    timestamptz,
  last_seen_at     timestamptz,
  event_count_30d  bigint NOT NULL DEFAULT 0,
  -- True when the row was created by the discovery job and no human has
  -- written a description yet. Such events still appear in the data dictionary
  -- but are explicitly labelled `[undocumented]` so the model knows the name
  -- is all it has to go on.
  auto_registered  boolean NOT NULL DEFAULT false,
  -- Free-text note for known data-quality problems, e.g. a mid-stream rename.
  quality_note     text,
  updated_at       timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, event_name),
  CONSTRAINT event_definitions_category_known CHECK (
    category IN ('lifecycle', 'discovery', 'commerce', 'engagement', 'uncategorised')
  )
);

CREATE INDEX IF NOT EXISTS idx_event_definitions_canonical
  ON event_definitions(org_id, canonical_name) WHERE canonical_name IS NOT NULL;

-- ---------------------------------------------------------------------------
-- event_property_definitions
--
-- Auto-populated by the discovery job from observed JSONB keys: inferred type,
-- cardinality, sample values, and enum values when cardinality is low enough
-- to enumerate. `description` is the human layer on top and is never
-- clobbered. That split is the whole point of the table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_property_definitions (
  org_id               uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_name           text NOT NULL,
  property_key         text NOT NULL,
  data_type            text NOT NULL DEFAULT 'string',
  -- Set when the same key arrives as more than one JSON type across rows.
  -- Recorded rather than resolved: the model needs to know the column is
  -- dirty so it reaches for the defensive cast helper.
  observed_types       text[] NOT NULL DEFAULT ARRAY[]::text[],
  has_type_conflict    boolean NOT NULL DEFAULT false,
  -- Human-written. The discovery job NEVER overwrites this column.
  description          text,
  is_required          boolean NOT NULL DEFAULT false,
  occurrence_rate      numeric(5,4),   -- fraction of that event's rows carrying the key
  distinct_value_count bigint,
  sample_values        jsonb NOT NULL DEFAULT '[]'::jsonb,
  enum_values          jsonb,          -- populated only when cardinality <= 12
  is_pii               boolean NOT NULL DEFAULT false,
  last_seen_at         timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, event_name, property_key),
  FOREIGN KEY (org_id, event_name) REFERENCES event_definitions(org_id, event_name) ON DELETE CASCADE,
  CONSTRAINT epd_data_type_known CHECK (
    data_type IN ('string', 'number', 'boolean', 'timestamp', 'array', 'object', 'mixed')
  )
);

-- ---------------------------------------------------------------------------
-- metric_definitions. The semantic layer.
--
-- This is where "what counts as an order" is answered, per org. One client
-- means status='placed'; another means status='delivered' because they run 30%
-- RTO and a placed order is a guess, not revenue. That distinction belongs
-- here, in data, not in the model's head and not in a prompt.
--
-- org_id NULL = global default, inherited by any org without an override.
--
-- SECURITY NOTE on sql_template: these are operator-authored, seeded from this
-- repo, and never writable through any MCP tool. They are trusted config, on
-- the same footing as application source code. The only values interpolated
-- into them at runtime are (a) bound parameters for the time window and
-- (b) a dimension name validated against `allowed_dimensions` by exact match.
-- Nothing from the model reaches the template as text. See src/metrics/build.ts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS metric_definitions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- NULL = global
  metric_key         text NOT NULL,
  display_name       text NOT NULL,
  description        text NOT NULL,
  unit               text NOT NULL DEFAULT 'count',  -- count | currency_minor | ratio | duration_s
  sql_template       text NOT NULL,
  allowed_dimensions text[] NOT NULL DEFAULT ARRAY[]::text[],
  -- Canonical event concepts this metric needs. If the org maps none of them,
  -- query_metric returns not_tracked instead of zero.
  requires_canonical text[] NOT NULL DEFAULT ARRAY[]::text[],
  -- Surfaced verbatim in the tool response so the stated assumption travels
  -- with the number. "Counts orders with status='placed'; excludes cancelled."
  notes              text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- One definition per key per org; one global default per key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_metric_definitions_org_key
  ON metric_definitions(org_id, metric_key) WHERE org_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_metric_definitions_global_key
  ON metric_definitions(metric_key) WHERE org_id IS NULL;

-- ---------------------------------------------------------------------------
-- registry_version. Cache key for the generated context payload.
--
-- The context string is expensive to build and near-static. It is cached
-- server-side under (org_id, version_hash); the hash changes only when
-- something the context actually renders changes. Bumped by the discovery job
-- and by any registry write.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS registry_version (
  org_id       uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  version_hash text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
