/**
 * SQL guard tests.
 *
 * Note the framing throughout: the guard is a usability and defence-in-depth
 * layer, not the security boundary. The final describe block proves that by
 * bypassing the guard entirely and showing the database still holds the line —
 * which is the property that actually matters.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { guardSql } from '../src/sql/guard.js';
import { McpToolError } from '../src/util/errors.js';
import { withOrgSession } from '../src/db/tenantSession.js';
import { closePools } from '../src/db/pools.js';
import { loadTestOrgs, cleanupTestCredentials } from './helpers.js';

const MAX = 500;
const rejects = (sql: string) => expect(() => guardSql(sql, MAX)).toThrow(McpToolError);
const accepts = (sql: string) => expect(() => guardSql(sql, MAX)).not.toThrow();

afterAll(async () => {
  await cleanupTestCredentials();
  await closePools();
});

describe('accepts legitimate read-only queries', () => {
  it('plain SELECT', () => accepts('SELECT count(*) FROM events'));
  it('WITH ... SELECT', () => accepts('WITH x AS (SELECT 1 a) SELECT a FROM x'));
  it('joins and aggregates', () =>
    accepts(`SELECT p.category, count(*) FROM order_items oi
             JOIN products p ON p.product_id = oi.product_id GROUP BY 1`));
  it('a single trailing semicolon', () => accepts('SELECT 1;'));
  it('JSONB access', () => accepts("SELECT properties->>'product_id' FROM events"));
  it('a comment containing a forbidden word', () =>
    accepts('SELECT 1 -- we could DROP TABLE here but this is a comment'));
  it('a string literal containing a forbidden word', () =>
    accepts("SELECT * FROM products WHERE title = 'DROP TABLE users'"));
  it('a string literal containing a semicolon', () =>
    accepts("SELECT * FROM products WHERE title = 'a; b'"));
});

describe('rejects statement chaining', () => {
  it('two statements', () => rejects('SELECT 1; SELECT 2'));
  it('SELECT then DROP', () => rejects('SELECT 1; DROP TABLE events'));
  it('chained with a comment in between', () => rejects('SELECT 1; /* x */ DELETE FROM events'));
  it('trailing semicolon then whitespace then another', () => rejects('SELECT 1 ;  SELECT 2 ;'));
});

describe('rejects writes and DDL', () => {
  for (const sql of [
    'INSERT INTO events (event_name) VALUES (1)',
    'UPDATE events SET event_name = 1',
    'DELETE FROM events',
    'TRUNCATE events',
    'DROP TABLE events',
    'CREATE TABLE evil (id int)',
    'ALTER TABLE events DISABLE ROW LEVEL SECURITY',
    'GRANT SELECT ON events TO PUBLIC',
    'REVOKE ALL ON events FROM mcp_tenant',
  ]) {
    it(sql.slice(0, 42), () => rejects(sql));
  }
});

describe('rejects writable CTEs', () => {
  it('WITH ... DELETE ... RETURNING', () =>
    rejects('WITH d AS (DELETE FROM events RETURNING *) SELECT * FROM d'));
  it('WITH ... INSERT ... RETURNING', () =>
    rejects("WITH i AS (INSERT INTO events (event_name) VALUES ('x') RETURNING *) SELECT * FROM i"));
  it('WITH ... UPDATE ... RETURNING', () =>
    rejects('WITH u AS (UPDATE orders SET status = $1 RETURNING *) SELECT * FROM u'));
});

describe('rejects identity and session manipulation', () => {
  for (const sql of [
    'SET ROLE zyaro_owner',
    'SET SESSION AUTHORIZATION zyaro_owner',
    "SET app.current_org_id = 'x'",
    "SET LOCAL app.current_org_id = 'x'",
    "SELECT set_config('app.current_org_id','x',false)",
    'RESET ALL',
    'BEGIN',
    'COMMIT',
    'SELECT 1 FOR UPDATE',
  ]) {
    it(sql.slice(0, 42), () => rejects(sql));
  }

  it('reading the tenant GUC is not permitted', () =>
    rejects("SELECT current_setting('app.current_org_id')"));
});

describe('rejects filesystem, network and admin functions', () => {
  for (const sql of [
    "SELECT pg_read_file('/etc/passwd')",
    "SELECT pg_ls_dir('/')",
    "COPY events TO '/tmp/x.csv'",
    "SELECT dblink('host=evil.com', 'SELECT 1')",
    'SELECT pg_sleep(30)',
    'SELECT pg_terminate_backend(1)',
    'SELECT * FROM pg_authid',
    "SELECT lo_import('/etc/passwd')",
  ]) {
    it(sql.slice(0, 42), () => rejects(sql));
  }
});

describe('rejects reads of non-analytics tables', () => {
  it('api_credentials', () => rejects('SELECT * FROM api_credentials'));
  it('audit_log', () => rejects('SELECT * FROM audit_log'));
  it('rate_limit_buckets', () => rejects('SELECT * FROM rate_limit_buckets'));
});

describe('rejects EXPLAIN', () => {
  // EXPLAIN discloses planner row estimates drawn from table-wide statistics,
  // which are computed across ALL tenants' rows. That is a genuine, if narrow,
  // cross-tenant side channel.
  it('EXPLAIN', () => rejects('EXPLAIN SELECT * FROM events'));
  it('EXPLAIN ANALYZE', () => rejects('EXPLAIN ANALYZE SELECT * FROM events'));
});

describe('obfuscation attempts', () => {
  it('mixed case', () => rejects('DrOp TaBlE events'));
  it('block comment inside a keyword region', () =>
    rejects('SELECT 1; DR/**/OP TABLE events'));
  it('dollar-quoted body hiding a statement', () =>
    rejects('SELECT $tag$ anything $tag$; DROP TABLE events'));
  it('nested block comments', () =>
    rejects('SELECT 1 /* outer /* inner */ still comment */ ; DELETE FROM events'));
});

describe('LIMIT enforcement', () => {
  it('appends a LIMIT when absent', () => {
    const r = guardSql('SELECT * FROM events', MAX);
    expect(r.limitApplied).toBe(true);
    expect(r.sql).toMatch(/LIMIT 500$/);
  });

  it('leaves a smaller LIMIT alone', () => {
    const r = guardSql('SELECT * FROM events LIMIT 10', MAX);
    expect(r.limitApplied).toBe(false);
    expect(r.appliedLimit).toBe(10);
  });

  it('clamps an oversized LIMIT rather than rejecting', () => {
    // Rewriting beats rejecting: the question was reasonable, only the bound
    // was not, and rejecting would cost a turn to learn a cap we can apply.
    const r = guardSql('SELECT * FROM events LIMIT 999999', MAX);
    expect(r.appliedLimit).toBe(MAX);
    expect(r.sql).toMatch(/LIMIT 500/);
  });

  it('rejects an over-long query', () => rejects(`SELECT ${'a,'.repeat(5000)}1`));
});

describe('THE ACTUAL BOUNDARY — the database, not the guard', () => {
  // These bypass guardSql entirely and hit the connection directly, proving
  // that if the guard were deleted tomorrow the isolation properties would
  // still hold. This is the difference between a security control and a
  // convenience.
  it('an unguarded cross-tenant SELECT still returns nothing', async () => {
    const orgs = await loadTestOrgs();
    const a = orgs.get('nordvik-fashion')!;
    const b = orgs.get('freshcart-grocery')!;

    const res = await withOrgSession(a.id, (s) =>
      s.query('SELECT * FROM events WHERE org_id = $1', [b.id])
    );
    expect(res.rows.length).toBe(0);
  });

  it('an unguarded write still fails at the privilege layer', async () => {
    const orgs = await loadTestOrgs();
    const a = orgs.get('nordvik-fashion')!;
    await expect(
      withOrgSession(a.id, (s) => s.query('DELETE FROM events'))
    ).rejects.toThrow();
  });

  it('an unguarded credential read still fails', async () => {
    const orgs = await loadTestOrgs();
    const a = orgs.get('nordvik-fashion')!;
    await expect(
      withOrgSession(a.id, (s) => s.query('SELECT * FROM api_credentials'))
    ).rejects.toThrow();
  });
});
