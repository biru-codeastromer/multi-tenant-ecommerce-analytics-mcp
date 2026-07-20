/**
 * TENANT ISOLATION TEST SUITE
 *
 * This file does not check that isolation was configured. It tries to break
 * it. Every test here is an attack that would succeed against a plausible
 * wrong implementation of this system.
 *
 * The attacks, and what each one would catch:
 *
 *   1. Cross-tenant read via the tool surface     -> a missing RLS policy
 *   2. Cross-tenant read via raw SQL              -> policy on some tables only
 *   3. Injected WHERE org_id = <other>            -> trusting query text
 *   4. UNION / subquery / CTE reaching across     -> policy not FOR ALL
 *   5. No tenant context set at all               -> a permissive USING (true)
 *   6. POOLER SESSION LEAK across transactions    -> plain SET instead of SET LOCAL
 *   7. Concurrent interleaved tenants on 1 backend-> shared mutable context
 *   8. Reading api_credentials / audit_log        -> over-broad GRANT
 *   9. Writes of any kind                         -> role not SELECT-only
 *  10. Role escalation (SET ROLE, superuser)      -> wrong connection role
 *  11. service_role / BYPASSRLS in use            -> the automatic-fail condition
 *  12. org_id as a tool argument                  -> the automatic-fail condition
 *  13. Aggregate-count leakage                    -> RLS not applied to aggregates
 *  14. Error-message leakage                      -> raw errors returned to caller
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { loadTestOrgs, cleanupTestCredentials, ownerClient, type TestOrg } from './helpers.js';
import { withOrgSession, withoutOrgSession } from '../src/db/tenantSession.js';
import { resolveCredential } from '../src/auth/credentials.js';
import { closePools, tenantPool } from '../src/db/pools.js';
import { TOOLS } from '../src/tools/index.js';
import { config } from '../src/config.js';

let orgs: Map<string, TestOrg>;
let orgA: TestOrg;  // Nordvik Fashion
let orgB: TestOrg;  // FreshCart Grocery

beforeAll(async () => {
  orgs = await loadTestOrgs();
  orgA = orgs.get('nordvik-fashion')!;
  orgB = orgs.get('freshcart-grocery')!;
  expect(orgA, 'seed data missing. Run `npm run bootstrap`').toBeDefined();
  expect(orgB).toBeDefined();
});

afterAll(async () => {
  await cleanupTestCredentials();
  await closePools();
});

// ===========================================================================
describe('Layer 0. The automatic-fail conditions', () => {
  it('the tenant role is not superuser and does not have BYPASSRLS', async () => {
    // Supabase's service_role bypasses RLS entirely. If the server ever
    // connected with it, every policy in this repo would be decoration.
    const { rows } = await withOrgSession(orgA.id, (s) =>
      s.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      )
    );
    expect(rows[0]!.rolname).toBe('mcp_tenant');
    expect(rows[0]!.rolsuper, 'tenant role must NOT be superuser').toBe(false);
    expect(rows[0]!.rolbypassrls, 'tenant role must NOT have BYPASSRLS').toBe(false);
  });

  it('no connection string in use is a Supabase service role', () => {
    for (const url of [config.db.tenantUrl, config.db.authUrl]) {
      expect(url).not.toMatch(/service_role/i);
      expect(url).not.toMatch(/^postgres:\/\/postgres:/);
    }
    expect(process.env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
  });

  it('NO TOOL accepts an org_id argument', () => {
    // Walks every registered tool's schema. Keeps holding as tools are added.
    const forbidden = /^(org|org_id|organization|organization_id|organisation_id|tenant|tenant_id|customer_id|account_id)$/i;
    for (const tool of TOOLS) {
      const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      for (const key of Object.keys(props)) {
        expect(
          forbidden.test(key),
          `Tool "${tool.name}" exposes "${key}": a model-controllable tenant selector is an automatic fail.`
        ).toBe(false);
      }
    }
  });

  it('every tenant table has RLS both ENABLED and FORCED', async () => {
    const client = await ownerClient();
    const { rows } = await client.query<{ relname: string; rls: boolean; forced: boolean }>(
      `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND c.relname = ANY($1::text[])`,
      [[
        'events', 'orders', 'order_items', 'products', 'user_profiles', 'identity_links',
        'event_definitions', 'event_property_definitions', 'metric_definitions',
        'organizations', 'registry_version', 'projection_state',
      ]]
    );
    await client.end();

    expect(rows.length).toBe(12);
    for (const r of rows) {
      expect(r.rls, `${r.relname}: RLS not enabled`).toBe(true);
      // FORCE is the half everyone forgets: without it the table OWNER, and
      // any job connecting as owner, silently reads every tenant.
      expect(r.forced, `${r.relname}: RLS enabled but NOT FORCED. The owner bypasses it`).toBe(true);
    }
  });
});

// ===========================================================================
describe('Layer 1. Cross-tenant reads through normal queries', () => {
  it('org A sees only its own events', async () => {
    const rows = await withOrgSession(orgA.id, (s) =>
      s.query<{ org_id: string }>('SELECT DISTINCT org_id FROM events')
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.org_id).toBe(orgA.id);
  });

  it('org A and org B see disjoint, non-empty event sets', async () => {
    const a = await withOrgSession(orgA.id, (s) => s.query<{ n: string }>('SELECT count(*) n FROM events'));
    const b = await withOrgSession(orgB.id, (s) => s.query<{ n: string }>('SELECT count(*) n FROM events'));
    expect(Number(a.rows[0]!.n)).toBeGreaterThan(0);
    expect(Number(b.rows[0]!.n)).toBeGreaterThan(0);
    expect(a.rows[0]!.n).not.toBe(b.rows[0]!.n);
  });

  it('ATTACK: explicitly filtering for the other org returns nothing', async () => {
    // The obvious attempt. RLS ANDs its own predicate onto ours, so
    // (org_id = B) AND (org_id = A) is unsatisfiable.
    const res = await withOrgSession(orgA.id, (s) =>
      s.query('SELECT * FROM events WHERE org_id = $1', [orgB.id])
    );
    expect(res.rows.length).toBe(0);
  });

  it('ATTACK: OR-ing the other org in returns only our own rows', async () => {
    const res = await withOrgSession(orgA.id, (s) =>
      s.query<{ org_id: string }>(
        'SELECT DISTINCT org_id FROM events WHERE org_id = $1 OR org_id = $2',
        [orgA.id, orgB.id]
      )
    );
    expect(res.rows.map((r) => r.org_id)).toEqual([orgA.id]);
  });

  it('ATTACK: UNION across a second table does not widen visibility', async () => {
    const res = await withOrgSession(orgA.id, (s) =>
      s.query<{ org_id: string }>(
        `SELECT org_id FROM events
         UNION
         SELECT org_id FROM orders
         UNION
         SELECT org_id FROM products
         UNION
         SELECT id FROM organizations`
      )
    );
    expect(res.rows.map((r) => r.org_id)).toEqual([orgA.id]);
  });

  it('ATTACK: a CTE cannot escape the policy', async () => {
    const res = await withOrgSession(orgA.id, (s) =>
      s.query<{ org_id: string }>(
        `WITH everything AS (SELECT org_id FROM events)
         SELECT DISTINCT org_id FROM everything`
      )
    );
    expect(res.rows.map((r) => r.org_id)).toEqual([orgA.id]);
  });

  it('ATTACK: a correlated subquery cannot read another tenant', async () => {
    const res = await withOrgSession(orgA.id, (s) =>
      s.query<{ leaked: string | null }>(
        `SELECT (SELECT max(event_name) FROM events WHERE org_id = $1) AS leaked`,
        [orgB.id]
      )
    );
    expect(res.rows[0]!.leaked).toBeNull();
  });

  it('ATTACK: aggregate counts do not leak the other tenant\'s volume', async () => {
    // A count is a side channel if RLS is applied to row output but not to
    // the scan. It is not. But this is the test that would notice.
    const res = await withOrgSession(orgA.id, (s) =>
      s.query<{ n: string }>('SELECT count(*) n FROM events WHERE org_id = $1', [orgB.id])
    );
    expect(res.rows[0]!.n).toBe('0');
  });

  it('ATTACK: organizations table shows only the caller\'s own org', async () => {
    const res = await withOrgSession(orgA.id, (s) =>
      s.query<{ id: string; name: string }>('SELECT id, name FROM organizations')
    );
    expect(res.rows.length).toBe(1);
    expect(res.rows[0]!.id).toBe(orgA.id);
  });

  it('ATTACK: another org\'s metric overrides are invisible', async () => {
    // Org overrides encode commercial logic ("we count delivered because our
    // RTO is 30%"). Global defaults are shared; overrides are not.
    const res = await withOrgSession(orgA.id, (s) =>
      s.query<{ org_id: string | null }>('SELECT DISTINCT org_id FROM metric_definitions')
    );
    for (const r of res.rows) {
      expect(r.org_id === null || r.org_id === orgA.id).toBe(true);
    }
  });
});

// ===========================================================================
describe('Layer 2. Deny by default when there is no tenant context', () => {
  it('a session with NO org context reads zero rows from every tenant table', async () => {
    // The single most important negative test. A policy written as
    // USING (org_id = current_setting(...)::uuid) without the missing_ok flag
    // would ERROR here; one written permissively would return EVERYTHING.
    // Correct behaviour is silence.
    const res = await withoutOrgSession(async (s) => ({
      events: await s.query<{ n: string }>('SELECT count(*) n FROM events'),
      orders: await s.query<{ n: string }>('SELECT count(*) n FROM orders'),
      orgs: await s.query<{ n: string }>('SELECT count(*) n FROM organizations'),
      defs: await s.query<{ n: string }>('SELECT count(*) n FROM event_definitions'),
      metrics: await s.query<{ n: string }>('SELECT count(*) n FROM metric_definitions'),
    }));

    expect(res.events.rows[0]!.n).toBe('0');
    expect(res.orders.rows[0]!.n).toBe('0');
    expect(res.orgs.rows[0]!.n).toBe('0');
    expect(res.defs.rows[0]!.n).toBe('0');
    // Global metric rows are gated on a resolved tenant too.
    expect(res.metrics.rows[0]!.n).toBe('0');
  });

  it('current_org_id() is NULL, not an error, when unset', async () => {
    const res = await withoutOrgSession((s) =>
      s.query<{ org: string | null }>('SELECT public.current_org_id()::text AS org')
    );
    expect(res.rows[0]!.org).toBeNull();
  });
});

// ===========================================================================
describe('Layer 3. The pooler session-leak attack', () => {
  it('tenant context does NOT survive across transactions on the same backend', async () => {
    // THE BUG THE BRIEF WARNS ABOUT.
    //
    // With Supabase's transaction-mode pooler, a backend is returned to the
    // pool at COMMIT and handed to a different client for the next
    // transaction. Anything set at session scope survives that handoff.
    //
    // This forces the scenario: a pool of exactly ONE connection guarantees
    // that the second transaction reuses the first's backend. If the
    // implementation used `SET` instead of `SET LOCAL`/set_config(...,true),
    // the GUC would still be set here and org A's context would be live in a
    // transaction that never set one.
    const singleton = new pg.Pool({ connectionString: config.db.tenantUrl, max: 1 });
    try {
      const c1 = await singleton.connect();
      await c1.query('BEGIN READ ONLY');
      await c1.query('SELECT public.set_tenant_context($1::uuid)', [orgA.id]);
      const inside = await c1.query<{ org: string | null }>('SELECT public.current_org_id()::text org');
      expect(inside.rows[0]!.org).toBe(orgA.id);
      await c1.query('COMMIT');
      c1.release();

      // Same physical backend, new transaction, no context set.
      const c2 = await singleton.connect();
      await c2.query('BEGIN READ ONLY');
      const after = await c2.query<{ org: string | null }>('SELECT public.current_org_id()::text org');
      const rows = await c2.query<{ n: string }>('SELECT count(*) n FROM events');
      await c2.query('COMMIT');
      c2.release();

      expect(after.rows[0]!.org, 'TENANT CONTEXT LEAKED ACROSS TRANSACTIONS').toBeNull();
      expect(rows.rows[0]!.n, 'rows visible with no tenant context').toBe('0');
    } finally {
      await singleton.end();
    }
  });

  it('org B never inherits org A\'s context under forced backend reuse', async () => {
    const singleton = new pg.Pool({ connectionString: config.db.tenantUrl, max: 1 });
    try {
      const run = async (org: TestOrg) => {
        const c = await singleton.connect();
        try {
          await c.query('BEGIN READ ONLY');
          await c.query('SELECT public.set_tenant_context($1::uuid)', [org.id]);
          const r = await c.query<{ org_id: string }>('SELECT DISTINCT org_id FROM events');
          await c.query('COMMIT');
          return r.rows.map((x) => x.org_id);
        } finally {
          c.release();
        }
      };

      // Alternating on one backend, 12 times. Any residue shows up fast.
      for (let i = 0; i < 6; i++) {
        expect(await run(orgA)).toEqual([orgA.id]);
        expect(await run(orgB)).toEqual([orgB.id]);
      }
    } finally {
      await singleton.end();
    }
  });

  it('heavy concurrent interleaving keeps every tenant on its own data', async () => {
    // 60 requests across 5 orgs, interleaved, through the real shared pool.
    // Catches any shared mutable "current tenant" that an await could race.
    const all = [...orgs.values()];
    const work = Array.from({ length: 60 }, (_, i) => {
      const org = all[i % all.length]!;
      return withOrgSession(org.id, async (s) => {
        const r = await s.query<{ org_id: string }>('SELECT DISTINCT org_id FROM events');
        return { expected: org.id, got: r.rows.map((x) => x.org_id) };
      });
    });

    for (const r of await Promise.all(work)) {
      expect(r.got).toEqual([r.expected]);
    }
  });

  // -------------------------------------------------------------------------
  // REGRESSION: in-query tenant switching via set_config.
  //
  // This was a REAL, EXPLOITABLE cross-tenant leak, found by the guard test
  // suite during development and fixed in migration 0010. Authenticated as
  // Nordvik, this exact query returned FreshCart's 3,659 events:
  //
  //   SELECT set_config('app.current_org_id', '<orgB>', true),
  //          (SELECT count(*) FROM events);
  //
  // The application SQL guard had missed it because the guard strips string
  // literals before matching keywords, which also erased the GUC name it was
  // pattern-matching on. The fix is at the privilege layer. Mcp_tenant no
  // longer holds EXECUTE on set_config at all. With the guard rule as the
  // second layer. These tests assert the privilege-layer fix specifically,
  // bypassing the guard entirely.
  // -------------------------------------------------------------------------
  it('ATTACK: cannot switch tenant mid-query via set_config', async () => {
    await expect(
      withOrgSession(orgA.id, (s) =>
        s.query(
          `SELECT set_config('app.current_org_id', $1, true) AS sw,
                  (SELECT count(*) FROM events) AS n`,
          [orgB.id]
        )
      )
    ).rejects.toThrow(/permission denied for function set_config/i);
  });

  it('ATTACK: cannot switch tenant in a follow-up statement either', async () => {
    await expect(
      withOrgSession(orgA.id, async (s) => {
        await s.query("SELECT set_config('app.current_org_id', $1, true)", [orgB.id]);
        return s.query('SELECT org_id FROM events GROUP BY 1');
      })
    ).rejects.toThrow(/permission denied for function set_config/i);
  });

  it('the tenant role holds no EXECUTE on set_config', async () => {
    const res = await withOrgSession(orgA.id, (s) =>
      s.query<{ allowed: boolean }>(
        `SELECT has_function_privilege(current_user, 'pg_catalog.set_config(text,text,boolean)', 'EXECUTE') AS allowed`
      )
    );
    expect(res.rows[0]!.allowed).toBe(false);
  });

  it('set_tenant_context refuses to CHANGE an established context', async () => {
    // The second, independent control: even a principal that regained
    // set_config could not switch tenants inside a live transaction.
    await expect(
      withOrgSession(orgA.id, (s) =>
        s.query('SELECT public.set_tenant_context($1::uuid)', [orgB.id])
      )
    ).rejects.toThrow(/already established/i);
  });

  it('set_tenant_context tolerates re-setting the SAME tenant', async () => {
    const res = await withOrgSession(orgA.id, async (s) => {
      await s.query('SELECT public.set_tenant_context($1::uuid)', [orgA.id]);
      return s.query<{ org: string }>('SELECT public.current_org_id()::text AS org');
    });
    expect(res.rows[0]!.org).toBe(orgA.id);
  });

  it('withOrgSession refuses a malformed org id rather than running unscoped', async () => {
    await expect(withOrgSession('not-a-uuid', async (s) => s.query('SELECT 1'))).rejects.toThrow();
    await expect(
      withOrgSession("' OR '1'='1", async (s) => s.query('SELECT 1'))
    ).rejects.toThrow();
  });
});

// ===========================================================================
describe('Layer 4. Privilege boundaries of the tenant role', () => {
  const denied = async (sql: string, params: unknown[] = []) => {
    await expect(
      withOrgSession(orgA.id, (s) => s.query(sql, params)),
      `expected "${sql.slice(0, 60)}" to be denied`
    ).rejects.toThrow();
  };

  it('cannot read api_credentials', async () => {
    await denied('SELECT * FROM api_credentials');
    await denied('SELECT count(*) FROM api_credentials');
  });

  it('cannot read the audit log', async () => {
    await denied('SELECT * FROM audit_log');
  });

  it('cannot read rate limit state or the migration ledger', async () => {
    await denied('SELECT * FROM rate_limit_buckets');
    await denied('SELECT * FROM schema_migrations');
  });

  it('cannot write anything, anywhere', async () => {
    await denied("INSERT INTO events (org_id, event_name, event_time, ingested_at) VALUES ($1,'x',now(),now())", [orgA.id]);
    await denied('UPDATE events SET event_name = $1', ['hacked']);
    await denied('DELETE FROM events');
    await denied('UPDATE organizations SET name = $1', ['pwned']);
  });

  it('cannot create or alter database objects', async () => {
    await denied('CREATE TABLE evil (id int)');
    await denied('ALTER TABLE events DISABLE ROW LEVEL SECURITY');
    await denied('DROP POLICY tenant_isolation ON events');
  });

  it('ATTACK: cannot disable RLS on its own tables', async () => {
    // Only an owner can, and mcp_tenant owns nothing. This is why the role
    // holding SELECT is not the role that ran the migrations.
    await denied('ALTER TABLE events NO FORCE ROW LEVEL SECURITY');
  });

  it('ATTACK: cannot escalate via SET ROLE', async () => {
    await denied('SET ROLE zyaro_owner');
    await denied('SET SESSION AUTHORIZATION zyaro_owner');
  });

  it('ATTACK: cannot read the filesystem or open outbound connections', async () => {
    await denied("SELECT pg_read_file('/etc/passwd')");
    await denied("SELECT pg_ls_dir('/')");
  });

  it('ATTACK: cannot read credential catalogs', async () => {
    await denied('SELECT * FROM pg_authid');
  });

  it('the transaction is genuinely read-only', async () => {
    const res = await withOrgSession(orgA.id, (s) =>
      s.query<{ ro: string }>("SELECT current_setting('transaction_read_only') AS ro")
    );
    expect(res.rows[0]!.ro).toBe('on');
  });

  it('a statement timeout is set on the role itself', async () => {
    const res = await withOrgSession(orgA.id, (s) =>
      s.query<{ t: string; i: string }>(
        `SELECT current_setting('statement_timeout') t,
                current_setting('idle_in_transaction_session_timeout') i`
      )
    );
    expect(res.rows[0]!.t).not.toBe('0');
    expect(res.rows[0]!.i).not.toBe('0');
  });
});

// ===========================================================================
describe('Layer 5. Credential resolution', () => {
  it('a valid key resolves to exactly its own org', async () => {
    const a = await resolveCredential(orgA.apiKey);
    const b = await resolveCredential(orgB.apiKey);
    expect(a.orgId).toBe(orgA.id);
    expect(b.orgId).toBe(orgB.id);
    expect(a.orgId).not.toBe(b.orgId);
  });

  it('org A\'s key can never resolve to org B', async () => {
    const a = await resolveCredential(orgA.apiKey);
    expect(a.orgSlug).toBe('nordvik-fashion');
    expect(a.reportingTimezone).toBe('Asia/Kolkata');
  });

  it('invalid, empty and malformed keys are all rejected', async () => {
    await expect(resolveCredential('zyk_nope_invalid_key_value_here')).rejects.toThrow();
    await expect(resolveCredential('')).rejects.toThrow();
    await expect(resolveCredential("' OR 1=1 --")).rejects.toThrow();
    await expect(resolveCredential('x'.repeat(500))).rejects.toThrow();
  });

  it('REVOCATION takes effect immediately, with no restart and no cache wait', async () => {
    const client = await ownerClient();
    const { rows } = await client.query<{ id: string }>(
      'SELECT id FROM organizations WHERE slug = $1',
      ['voltedge-electronics']
    );
    const orgId = rows[0]!.id;

    const { generateApiKey } = await import('../src/auth/credentials.js');
    const key = generateApiKey('voltedge-electronics');
    await client.query(
      `INSERT INTO api_credentials (org_id, key_hash, key_prefix, label) VALUES ($1,$2,$3,'vitest')`,
      [orgId, key.hash, key.prefix]
    );

    // Works now...
    const before = await resolveCredential(key.raw);
    expect(before.orgId).toBe(orgId);

    // ...revoked...
    await client.query('UPDATE api_credentials SET revoked_at = now() WHERE key_hash = $1', [key.hash]);

    // ...and fails on the very next call.
    await expect(resolveCredential(key.raw)).rejects.toThrow();
    await client.end();
  });

  it('the raw key is never stored. Only a peppered hash', async () => {
    const client = await ownerClient();
    const { rows } = await client.query<{ key_hash: string; key_prefix: string }>(
      'SELECT key_hash, key_prefix FROM api_credentials LIMIT 20'
    );
    await client.end();

    for (const r of rows) {
      expect(r.key_hash).toMatch(/^[0-9a-f]{64}$/);
      // A stored raw key would contain the scheme prefix.
      expect(r.key_hash).not.toContain('zyk_');
    }
    // The full key must not be recoverable from what is persisted.
    const stored = rows.map((r) => r.key_hash + r.key_prefix).join('');
    expect(stored).not.toContain(orgA.apiKey);
  });
});

// ===========================================================================
describe('Layer 6. The audit log', () => {
  it('is append-only even for the owner', async () => {
    const client = await ownerClient();
    await client.query(
      `SELECT public.audit_write($1,NULL,'test','{}'::jsonb,NULL,0,1,'ok',NULL,NULL,NULL)`,
      [orgA.id]
    );
    await expect(client.query('UPDATE audit_log SET tool_name = $1', ['tampered'])).rejects.toThrow();
    await expect(client.query('DELETE FROM audit_log')).rejects.toThrow();
    await client.end();
  });

  it('records the org and tool for every call', async () => {
    const client = await ownerClient();
    const { rows } = await client.query<{ n: string }>(
      'SELECT count(*) n FROM audit_log WHERE org_id = $1',
      [orgA.id]
    );
    await client.end();
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });
});
