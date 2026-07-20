-- ===========================================================================
-- 0006  Row Level Security
--
-- ENABLE gives you RLS for ordinary roles. FORCE also applies it to the table
-- OWNER, which is the classic trap: without FORCE, the role that ran these
-- migrations reads every tenant's rows, and any future job or human session
-- connecting as owner silently has god mode.
--
-- The other half of that trap is Supabase's `service_role` key, which bypasses
-- RLS entirely. This server never uses it. There is no SUPABASE_SERVICE_ROLE_KEY
-- in .env.example, no client library that could accept one, and a test asserts
-- the tenant role is neither superuser nor BYPASSRLS.
-- ===========================================================================

DO $$
DECLARE
  t text;
  -- Tables keyed directly by org_id.
  tenant_tables text[] := ARRAY[
    'events', 'orders', 'order_items', 'products', 'user_profiles',
    'identity_links', 'event_definitions', 'event_property_definitions',
    'registry_version', 'projection_state'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    -- FOR ALL, not FOR SELECT. The tenant role only holds SELECT anyway, but
    -- a policy scoped to SELECT would leave a future GRANT INSERT wide open.
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        FOR ALL
        USING      (org_id = public.current_org_id())
        WITH CHECK (org_id = public.current_org_id())
    $p$, t);
  END LOOP;
END $$;

-- organizations is keyed by `id`, not `org_id`: its own policy.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON organizations;
CREATE POLICY tenant_isolation ON organizations
  FOR ALL
  USING      (id = public.current_org_id())
  WITH CHECK (id = public.current_org_id());

-- ---------------------------------------------------------------------------
-- metric_definitions: an org sees its own overrides plus the global defaults
-- (org_id IS NULL). It must never see another org's overrides. Those encode
-- commercial logic like "we treat delivered as the order event because our RTO
-- is 30%", which is a business detail, not public information.
-- ---------------------------------------------------------------------------
ALTER TABLE metric_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_definitions FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON metric_definitions;
CREATE POLICY tenant_isolation ON metric_definitions
  FOR ALL
  -- The org_id IS NULL branch is guarded by requiring a resolved tenant
  -- context, so an unauthenticated session still sees nothing at all.
  USING      (public.current_org_id() IS NOT NULL AND (org_id IS NULL OR org_id = public.current_org_id()))
  WITH CHECK (org_id = public.current_org_id());

-- ---------------------------------------------------------------------------
-- Infrastructure tables: api_credentials, audit_log, rate_limit_buckets.
--
-- These are NOT tenant-scoped data. They are the machinery that decides who a
-- tenant is. They get RLS ENABLEd with zero permissive policies, which is
-- default-deny for every non-owner role: even if somebody later adds a stray
-- GRANT, every row stays invisible.
--
-- They are deliberately NOT FORCEd, unlike the tenant tables above. FORCE would
-- lock out the owner too, and the owner is the only principal that legitimately
-- writes here (issuing a credential, appending an audit row). The application
-- roles reach these tables through three narrow SECURITY DEFINER functions
-- defined in 0007: a fixed, auditable interface rather than table access.
--
-- The asymmetry is the point: tenant tables are FORCEd because nothing should
-- ever read across tenants, including us. Infrastructure tables are owner-only
-- because operating the system requires writing to them.
-- ---------------------------------------------------------------------------
ALTER TABLE api_credentials    ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log          ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_buckets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deny_all ON api_credentials;
DROP POLICY IF EXISTS deny_all ON audit_log;
DROP POLICY IF EXISTS deny_all ON rate_limit_buckets;
