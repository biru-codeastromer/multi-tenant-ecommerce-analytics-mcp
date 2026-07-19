-- ===========================================================================
-- 0003  Derived e-commerce entities
--
-- These are projections built from the raw event stream by a refresh job, not
-- a second source of truth. Rationale (expanded in README Q1): an analytical
-- question about orders should never require the model to reason about JSONB
-- paths. `SUM(total_amount_minor) WHERE status='placed'` is a query a model
-- gets right first time; `SUM((properties->>'order_total')::numeric)` is one
-- it gets wrong the moment a single row stored that value as a string.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS products (
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id  text NOT NULL,
  title       text,
  category    text,
  brand       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, product_id)
);

CREATE TABLE IF NOT EXISTS user_profiles (
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id            text NOT NULL,
  first_seen_at      timestamptz NOT NULL,
  last_seen_at       timestamptz NOT NULL,
  city               text,
  acquisition_source text,
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS orders (
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id           text NOT NULL,
  user_id            text,
  -- Deliberately NOT an enum type. Orgs invent statuses; a CHECK constraint
  -- here would mean a migration every time a client adds one. The semantic
  -- meaning of each status per org lives in metric_definitions instead.
  status             text NOT NULL,
  -- Integer minor units. Never float. 1999 = ₹19.99 / $19.99 depending on
  -- `currency`, which is stored per row precisely so we never have to guess.
  total_amount_minor bigint NOT NULL,
  currency           char(3) NOT NULL,
  placed_at          timestamptz NOT NULL,
  channel            text,          -- search | browse | direct | recommendation | push
  coupon_code        text,

  PRIMARY KEY (org_id, order_id),
  CONSTRAINT orders_amount_nonneg CHECK (total_amount_minor >= 0),
  CONSTRAINT orders_currency_fmt CHECK (currency ~ '^[A-Z]{3}$')
);

CREATE TABLE IF NOT EXISTS order_items (
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id         text NOT NULL,
  line_no          int  NOT NULL,
  product_id       text NOT NULL,
  qty              int  NOT NULL,
  unit_price_minor bigint NOT NULL,

  PRIMARY KEY (org_id, order_id, line_no),
  FOREIGN KEY (org_id, order_id) REFERENCES orders(org_id, order_id) ON DELETE CASCADE,
  CONSTRAINT order_items_qty_pos CHECK (qty > 0),
  CONSTRAINT order_items_price_nonneg CHECK (unit_price_minor >= 0)
);

-- ---------------------------------------------------------------------------
-- Identity stitching. When an anonymous visitor logs in we learn that an
-- anonymous_id belonged to a user_id all along. Rather than rewriting history
-- in `events` (it is append-only), we record the mapping and resolve through
-- it at query time. See README §Identity for the "does a pre-login session
-- count toward that user's funnel" decision.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS identity_links (
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  anonymous_id text NOT NULL,
  user_id      text NOT NULL,
  linked_at    timestamptz NOT NULL,
  PRIMARY KEY (org_id, anonymous_id, user_id)
);

COMMENT ON TABLE identity_links IS
  'anonymous_id -> user_id. Deliberately many-to-many: shared tablets produce one device with many users, and one user has many devices.';

-- ---------------------------------------------------------------------------
-- Bookkeeping for the projection job so a refresh is incremental and
-- idempotent rather than a full rebuild.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projection_state (
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  projection_name   text NOT NULL,
  last_ingested_at  timestamptz NOT NULL,
  last_run_at       timestamptz NOT NULL DEFAULT now(),
  rows_written      bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, projection_name)
);
