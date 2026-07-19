-- ===========================================================================
-- 0008  Indexes
--
-- Every index leads with org_id. That is not decoration: RLS appends
-- `org_id = current_org_id()` to every scan, so an index that does not start
-- with org_id cannot serve the predicate and the planner falls back to a seq
-- scan over all tenants' rows before filtering. Leading with org_id is what
-- makes tenant isolation cheap as well as correct.
-- ===========================================================================

-- The workhorse. Serves "events of type X in a window", which is what nearly
-- every metric, funnel and top_n reduces to. DESC on event_time because
-- analytics questions are overwhelmingly about the recent end of the stream.
CREATE INDEX IF NOT EXISTS idx_events_org_name_time
  ON events (org_id, event_name, event_time DESC);

-- Time-only scans within a tenant ("everything that happened yesterday"),
-- and the funnel's per-session ordering.
CREATE INDEX IF NOT EXISTS idx_events_org_time
  ON events (org_id, event_time DESC);

CREATE INDEX IF NOT EXISTS idx_events_org_session_time
  ON events (org_id, session_id, event_time)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_org_user_time
  ON events (org_id, user_id, event_time DESC)
  WHERE user_id IS NOT NULL;

-- Late-arrival analysis: "what landed today that happened last week".
CREATE INDEX IF NOT EXISTS idx_events_org_ingested
  ON events (org_id, ingested_at DESC);

-- GIN on properties so JSONB containment filters (`properties @> '{"k":"v"}'`)
-- are index-assisted instead of a seq scan over millions of rows.
-- jsonb_path_ops rather than the default: roughly a third the size and faster
-- for @> specifically, at the cost of not supporting key-existence (?) queries.
-- The tool surface only ever emits @>, so that trade is free here.
CREATE INDEX IF NOT EXISTS idx_events_properties_gin
  ON events USING gin (properties jsonb_path_ops);

-- Derived tables.
CREATE INDEX IF NOT EXISTS idx_orders_org_placed
  ON orders (org_id, placed_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_org_status_placed
  ON orders (org_id, status, placed_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_org_user
  ON orders (org_id, user_id) WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_org_currency
  ON orders (org_id, currency);

CREATE INDEX IF NOT EXISTS idx_order_items_org_product
  ON order_items (org_id, product_id);

CREATE INDEX IF NOT EXISTS idx_products_org_category
  ON products (org_id, category);

-- Trigram index powering the "unknown event -> did you mean?" error path, so
-- a helpful suggestion costs an index lookup rather than a full table scan of
-- the registry.
CREATE INDEX IF NOT EXISTS idx_event_definitions_name_trgm
  ON event_definitions USING gin (event_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_user_profiles_org_source
  ON user_profiles (org_id, acquisition_source);

CREATE INDEX IF NOT EXISTS idx_identity_links_org_user
  ON identity_links (org_id, user_id);
