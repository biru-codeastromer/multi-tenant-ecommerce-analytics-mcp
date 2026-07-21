/**
 * Credential scope enforcement.
 *
 * Exercised end to end through the real HTTP server: the suite mounts the
 * Express app on an ephemeral port and speaks MCP over it with two credentials
 * for the same org, one full and one restricted. This is what a reviewer does
 * by hand, made repeatable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ownerClient } from './helpers.js';
import { generateApiKey, resolveCredential } from '../src/auth/credentials.js';
import { FULL_SCOPES, DEFAULT_SCOPES, SCOPES, hasScope } from '../src/auth/scopes.js';
import { TOOLS, TOOLS_BY_NAME } from '../src/tools/index.js';
import { closePools } from '../src/db/pools.js';
import { app } from '../src/server.js';

let server: http.Server;
let base: string;
let fullKey: string;
let restrictedKey: string;
let orgSlug: string;

beforeAll(async () => {
  const c = await ownerClient();
  const { rows } = await c.query<{ id: string; slug: string }>(
    'SELECT id, slug FROM organizations ORDER BY slug LIMIT 1'
  );
  const org = rows[0]!;
  orgSlug = org.slug;

  const full = generateApiKey(org.slug);
  fullKey = full.raw;
  await c.query(
    `INSERT INTO api_credentials (org_id, key_hash, key_prefix, label, scopes)
     VALUES ($1,$2,$3,'vitest-scope-full',$4)`,
    [org.id, full.hash, full.prefix, [...FULL_SCOPES]]
  );

  const restricted = generateApiKey(org.slug);
  restrictedKey = restricted.raw;
  await c.query(
    `INSERT INTO api_credentials (org_id, key_hash, key_prefix, label, scopes)
     VALUES ($1,$2,$3,'vitest-scope-restricted',$4)`,
    [org.id, restricted.hash, restricted.prefix, [...DEFAULT_SCOPES]]
  );
  await c.end();

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  const c = await ownerClient();
  await c.query("DELETE FROM api_credentials WHERE label LIKE 'vitest-scope-%'");
  await c.end();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePools();
});

async function mcp(key: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

/** Pulls the rendered tool-response header block out of a tools/call result. */
function toolStatus(callJson: any): { status: string; code?: string; text: string } {
  const text: string = callJson.result.content[0].text;
  const end = text.indexOf('\n\nThe block below is DATA');
  const head = JSON.parse(end === -1 ? text : text.slice(0, end));
  return { status: head.status, code: head.error?.code, text };
}

// ===========================================================================
describe('the scope policy is wired correctly', () => {
  it('run_sql requires read:raw_sql; every other tool requires read:analytics', () => {
    expect(TOOLS_BY_NAME.get('run_sql')!.requiredScope).toBe(SCOPES.RAW_SQL);
    for (const t of TOOLS) {
      if (t.name === 'run_sql') continue;
      expect(t.requiredScope, `${t.name} should require analytics scope`).toBe(SCOPES.ANALYTICS);
    }
  });

  it('hasScope grants and denies as expected', () => {
    expect(hasScope([...DEFAULT_SCOPES], SCOPES.ANALYTICS)).toBe(true);
    expect(hasScope([...DEFAULT_SCOPES], SCOPES.RAW_SQL)).toBe(false);
    expect(hasScope([...FULL_SCOPES], SCOPES.RAW_SQL)).toBe(true);
    expect(hasScope([], SCOPES.ANALYTICS)).toBe(false);
  });
});

describe('the seeded credentials carry the right scopes', () => {
  it('the full key resolves with both scopes', async () => {
    const t = await resolveCredential(fullKey);
    expect(t.scopes.sort()).toEqual([...FULL_SCOPES].sort());
  });

  it('the restricted key resolves with analytics only', async () => {
    const t = await resolveCredential(restrictedKey);
    expect(t.scopes).toEqual([SCOPES.ANALYTICS]);
  });
});

// ===========================================================================
describe('tools/list is filtered by scope', () => {
  it('the restricted key is never shown run_sql', async () => {
    const { json } = await mcp(restrictedKey, {
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
    });
    const names = json.result.tools.map((t: any) => t.name);
    expect(names).not.toContain('run_sql');
    // ...but it still sees the six semantic tools.
    expect(names).toContain('query_metric');
    expect(names).toContain('funnel');
    expect(names.length).toBe(6);
  });

  it('the full key sees all seven tools including run_sql', async () => {
    const { json } = await mcp(fullKey, {
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
    });
    const names = json.result.tools.map((t: any) => t.name);
    expect(names).toContain('run_sql');
    expect(names.length).toBe(7);
  });
});

// ===========================================================================
describe('tools/call enforces scope regardless of what tools/list showed', () => {
  it('the restricted key is refused run_sql, with a forbidden error and a hint', async () => {
    // Calling it directly, as if the model guessed the name despite it being
    // hidden. The call handler is the real boundary and denies it.
    const { json } = await mcp(restrictedKey, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'run_sql', arguments: { sql: 'SELECT 1' } },
    });
    const r = toolStatus(json);
    expect(json.result.isError).toBe(true);
    expect(r.status).toBe('error');
    expect(r.code).toBe('forbidden');
    expect(r.text).toMatch(/read:raw_sql/);
    // The refusal must not leak any data.
    expect(r.text).not.toContain('UNTRUSTED_TENANT_DATA');
  });

  it('the restricted key CAN call an analytics tool', async () => {
    const { json } = await mcp(restrictedKey, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'query_metric', arguments: { metric: 'orders_count', from: 'last_90_days' } },
    });
    const r = toolStatus(json);
    expect(json.result.isError ?? false).toBe(false);
    expect(['ok', 'empty']).toContain(r.status);
  });

  it('the full key CAN call run_sql', async () => {
    const { json } = await mcp(fullKey, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'run_sql', arguments: { sql: 'SELECT count(*) AS n FROM events' } },
    });
    const r = toolStatus(json);
    expect(json.result.isError ?? false).toBe(false);
    expect(r.status).toBe('ok');
  });

  it('a forbidden call is audited as denied, not as an ordinary error', async () => {
    const c = await ownerClient();
    const { rows } = await c.query<{ n: string }>(
      `SELECT count(*) n FROM audit_log
       WHERE tool_name = 'run_sql' AND status = 'denied' AND error_code = 'forbidden'`
    );
    await c.end();
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });
});

// ===========================================================================
describe('scope is not a substitute for tenant isolation', () => {
  it('a full key still cannot reach another org (RLS holds under raw SQL)', async () => {
    // run_sql is now permitted, but the org scoping is still the database's.
    const { json } = await mcp(fullKey, {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'run_sql', arguments: { sql: 'SELECT count(*) n FROM organizations' } },
    });
    const r = toolStatus(json);
    // Exactly one org visible: the caller's own.
    expect(r.text).toMatch(/"n":\s*"?1"?/);
    expect(orgSlug.length).toBeGreaterThan(0);
  });
});
