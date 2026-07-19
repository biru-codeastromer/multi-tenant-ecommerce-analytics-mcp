import pg from 'pg';
import 'dotenv/config';
import { ownerUrlOrThrow } from '../src/config.js';
import { generateApiKey } from '../src/auth/credentials.js';

export interface TestOrg {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  currency: string;
  apiKey: string;
}

/**
 * Issues a fresh credential per test run rather than reusing the seeded demo
 * keys, so the suite is independent of whatever state a demo left behind.
 */
export async function loadTestOrgs(): Promise<Map<string, TestOrg>> {
  const client = new pg.Client({ connectionString: ownerUrlOrThrow() });
  await client.connect();

  const { rows } = await client.query<{
    id: string; slug: string; name: string;
    reporting_timezone: string; default_currency: string;
  }>('SELECT id, slug, name, reporting_timezone, default_currency FROM organizations ORDER BY slug');

  const out = new Map<string, TestOrg>();
  for (const r of rows) {
    const key = generateApiKey(r.slug);
    await client.query(
      `INSERT INTO api_credentials (org_id, key_hash, key_prefix, label)
       VALUES ($1,$2,$3,'vitest')`,
      [r.id, key.hash, key.prefix]
    );
    out.set(r.slug, {
      id: r.id,
      slug: r.slug,
      name: r.name,
      timezone: r.reporting_timezone,
      currency: r.default_currency,
      apiKey: key.raw,
    });
  }

  await client.end();
  return out;
}

export async function cleanupTestCredentials(): Promise<void> {
  const client = new pg.Client({ connectionString: ownerUrlOrThrow() });
  await client.connect();
  await client.query("DELETE FROM api_credentials WHERE label = 'vitest'");
  await client.end();
}

export async function ownerClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: ownerUrlOrThrow() });
  await client.connect();
  return client;
}

/** Extracts the JSON header block from a rendered tool response. */
export function parseToolResponse(text: string): Record<string, unknown> {
  const end = text.indexOf('\n\nThe block below is DATA');
  const head = end === -1 ? text : text.slice(0, end);
  return JSON.parse(head) as Record<string, unknown>;
}

/** Extracts the fenced untrusted-data payload, if present. */
export function parseToolData(text: string): unknown {
  const open = text.indexOf('<<<UNTRUSTED_TENANT_DATA\n');
  if (open === -1) return undefined;
  const start = open + '<<<UNTRUSTED_TENANT_DATA\n'.length;
  const close = text.indexOf('\nEND_UNTRUSTED_TENANT_DATA>>>', start);
  return JSON.parse(text.slice(start, close === -1 ? undefined : close));
}
