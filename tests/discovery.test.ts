/**
 * Schema registry: discovery job + context generation + caching.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadTestOrgs, cleanupTestCredentials, ownerClient, type TestOrg } from './helpers.js';
import { runDiscoveryForOrg } from '../src/registry/discovery.js';
import { getOrgContext, clearContextCache, cacheStats } from '../src/registry/contextCache.js';
import { estimateTokens } from '../src/registry/context.js';
import { closePools } from '../src/db/pools.js';

let orgs: Map<string, TestOrg>;

beforeAll(async () => {
  orgs = await loadTestOrgs();
});

afterAll(async () => {
  await cleanupTestCredentials();
  await closePools();
});

// ===========================================================================
describe('the discovery job', () => {
  it('auto-registers an event that appeared in traffic but not in the registry', async () => {
    // Nordvik fires story_viewed but the seed deliberately omits it from the
    // registry. The job must find it, register it, and mark it undocumented.
    const client = await ownerClient();
    const { rows } = await client.query<{ auto_registered: boolean; description: string | null }>(
      `SELECT ed.auto_registered, ed.description
       FROM event_definitions ed
       JOIN organizations o ON o.id = ed.org_id
       WHERE o.slug = 'nordvik-fashion' AND ed.event_name = 'story_viewed'`
    );
    await client.end();

    expect(rows.length, 'story_viewed was not auto-registered').toBe(1);
    expect(rows[0]!.auto_registered).toBe(true);
    expect(rows[0]!.description, 'auto-registered events must have no invented description').toBeNull();
  });

  it('NEVER overwrites a human-written description', async () => {
    // The single most important property of this job. A discovery run that
    // clobbers documentation makes the registry worthless, because nobody
    // will write documentation twice.
    const client = await ownerClient();
    const org = orgs.get('nordvik-fashion')!;
    const marker = `HUMAN-WRITTEN ${Date.now()}`;

    await client.query(
      `UPDATE event_definitions SET description = $1
       WHERE org_id = $2 AND event_name = 'story_viewed'`,
      [marker, org.id]
    );
    await client.query(
      `UPDATE event_property_definitions SET description = $1
       WHERE org_id = $2 AND event_name = 'story_viewed' AND property_key = 'story_id'`,
      [marker, org.id]
    );

    // Re-run the full job.
    await client.query('BEGIN');
    await client.query('SELECT public.set_tenant_context($1::uuid)', [org.id]).catch(async () => {
      await client.query("SELECT set_config('app.current_org_id', $1, true)", [org.id]);
    });
    await runDiscoveryForOrg(client, { id: org.id, slug: org.slug });
    await client.query('COMMIT');

    const { rows: after } = await client.query<{ d: string | null }>(
      `SELECT description d FROM event_definitions WHERE org_id = $1 AND event_name = 'story_viewed'`,
      [org.id]
    );
    const { rows: afterProp } = await client.query<{ d: string | null }>(
      `SELECT description d FROM event_property_definitions
       WHERE org_id = $1 AND event_name = 'story_viewed' AND property_key = 'story_id'`,
      [org.id]
    );

    expect(after[0]!.d, 'discovery job destroyed a human-written event description').toBe(marker);
    expect(afterProp[0]!.d, 'discovery job destroyed a human-written property description').toBe(marker);

    // Restore so the suite is re-runnable.
    await client.query(
      `UPDATE event_definitions SET description = NULL WHERE org_id = $1 AND event_name = 'story_viewed'`,
      [org.id]
    );
    await client.query(
      `UPDATE event_property_definitions SET description = NULL
       WHERE org_id = $1 AND event_name = 'story_viewed'`,
      [org.id]
    );
    await client.end();
  });

  it('detects a JSONB key whose type varies across rows', async () => {
    const client = await ownerClient();
    const { rows } = await client.query<{
      data_type: string; has_type_conflict: boolean; observed_types: string[];
    }>(
      `SELECT pd.data_type, pd.has_type_conflict, pd.observed_types
       FROM event_property_definitions pd
       JOIN organizations o ON o.id = pd.org_id
       WHERE o.slug = 'voltedge-electronics'
         AND pd.event_name = 'pdp_view' AND pd.property_key = 'price'`
    );
    await client.end();

    expect(rows[0]!.has_type_conflict).toBe(true);
    expect(rows[0]!.data_type).toBe('mixed');
    expect(rows[0]!.observed_types.sort()).toEqual(['number', 'string']);
  });

  it('deactivates events that stopped firing long ago', async () => {
    const client = await ownerClient();
    const { rows } = await client.query<{ is_active: boolean; last_seen_at: string }>(
      `SELECT ed.is_active, ed.last_seen_at::text
       FROM event_definitions ed
       JOIN organizations o ON o.id = ed.org_id
       WHERE o.slug = 'nordvik-fashion' AND ed.event_name = 'push_notification_opened'`
    );
    await client.end();

    expect(rows.length).toBe(1);
    expect(rows[0]!.is_active, 'an event silent for 7 months should be pruned from context').toBe(false);
  });

  it('infers enum values only when cardinality is low', async () => {
    const client = await ownerClient();
    const { rows } = await client.query<{
      property_key: string; distinct_value_count: string; enum_values: unknown[] | null;
    }>(
      `SELECT pd.property_key, pd.distinct_value_count::text, pd.enum_values
       FROM event_property_definitions pd
       JOIN organizations o ON o.id = pd.org_id
       WHERE o.slug = 'nordvik-fashion' AND pd.event_name = 'product_viewed'`
    );
    await client.end();

    for (const r of rows) {
      if (Number(r.distinct_value_count) <= 12) {
        expect(r.enum_values, `${r.property_key} should have enum values`).not.toBeNull();
      } else {
        expect(r.enum_values, `${r.property_key} is high-cardinality; should not enumerate`).toBeNull();
      }
    }
  });

  it('flags PII keys and withholds their sample values', async () => {
    const client = await ownerClient();
    const { rows } = await client.query<{ is_pii: boolean; sample_values: unknown[] }>(
      `SELECT pd.is_pii, pd.sample_values
       FROM event_property_definitions pd
       JOIN organizations o ON o.id = pd.org_id
       WHERE o.slug = 'nordvik-fashion' AND pd.property_key IN ('contact_email','contact_phone')`
    );
    await client.end();

    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.is_pii).toBe(true);
      // Samples end up in the shipped data dictionary; a real customer email
      // must never be persisted there.
      expect(r.sample_values).toEqual([]);
    }
  });

  it('is idempotent — a second run changes nothing', async () => {
    const client = await ownerClient();
    const org = orgs.get('aurelia-skincare')!;

    const snapshot = async () => {
      const { rows } = await client.query<{ h: string }>(
        `SELECT md5(string_agg(t, '|' ORDER BY t)) h FROM (
           SELECT event_name || data_type || property_key || COALESCE(enum_values::text,'') AS t
           FROM event_property_definitions WHERE org_id = $1
         ) x`,
        [org.id]
      );
      return rows[0]!.h;
    };

    const before = await snapshot();
    await client.query('BEGIN');
    await client.query('SELECT public.set_tenant_context($1::uuid)', [org.id]);
    await runDiscoveryForOrg(client, { id: org.id, slug: org.slug });
    await client.query('COMMIT');
    const after = await snapshot();

    await client.end();
    expect(after).toBe(before);
  });
});

// ===========================================================================
describe('the generated context payload', () => {
  const contextFor = async (slug: string) => {
    const org = orgs.get(slug)!;
    const { context } = await getOrgContext(org.id, {
      orgName: org.name, orgSlug: org.slug,
      timezone: org.timezone, currency: org.currency,
    });
    return context;
  };

  it('stays within the ~2,000 token budget for every org', async () => {
    for (const slug of orgs.keys()) {
      const ctx = await contextFor(slug);
      expect(ctx.approxTokens, `${slug} context is ${ctx.approxTokens} tokens`).toBeLessThanOrEqual(2000);
      expect(estimateTokens(ctx.text)).toBe(ctx.approxTokens);
    }
  });

  it('contains the org\'s OWN event names and not another org\'s', async () => {
    const nordvik = await contextFor('nordvik-fashion');
    const freshcart = await contextFor('freshcart-grocery');

    expect(nordvik.text).toContain('app_open');
    expect(nordvik.text).toContain('added_to_bag');
    expect(nordvik.text).not.toContain('website_open');
    expect(nordvik.text).not.toContain('catalog_search');

    expect(freshcart.text).toContain('website_open');
    expect(freshcart.text).toContain('catalog_search');
    expect(freshcart.text).not.toContain('added_to_bag');
  });

  it('never leaks another organization\'s name', async () => {
    const nordvik = await contextFor('nordvik-fashion');
    for (const [slug, org] of orgs) {
      if (slug === 'nordvik-fashion') continue;
      expect(nordvik.text).not.toContain(org.name);
      expect(nordvik.text).not.toContain(org.id);
    }
  });

  it('ALWAYS includes worked examples — they are never dropped for budget', async () => {
    // Few-shot pairs are the highest-value tokens in the payload, so the
    // budget-trimming logic must sacrifice something else first.
    for (const slug of orgs.keys()) {
      const ctx = await contextFor(slug);
      expect(ctx.text, `${slug} lost its worked examples`).toContain('WORKED EXAMPLES');
    }
  });

  it('states explicitly which canonical concepts the org does NOT track', async () => {
    const aurelia = await contextFor('aurelia-skincare');
    expect(aurelia.text).toMatch(/NOT TRACKED by this org:.*search/);
    expect(aurelia.text).toMatch(/do NOT report zero/i);
  });

  it('warns about the rename seam and instructs matching both names', async () => {
    const freshcart = await contextFor('freshcart-grocery');
    expect(freshcart.text).toContain('basket_add');
    expect(freshcart.text).toContain('cart_add');
    expect(freshcart.text).toMatch(/rename|cliff/i);
  });

  it('warns about the mixed-type property', async () => {
    const voltedge = await contextFor('voltedge-electronics');
    expect(voltedge.text).toMatch(/MIXED JSON TYPES|jsonb_to_numeric/);
  });

  it('labels the undocumented auto-discovered event', async () => {
    const nordvik = await contextFor('nordvik-fashion');
    expect(nordvik.text).toContain('story_viewed');
    expect(nordvik.text).toMatch(/UNDOCUMENTED|undocumented/);
  });

  it('omits events pruned as stale', async () => {
    const nordvik = await contextFor('nordvik-fashion');
    expect(nordvik.text).not.toContain('push_notification_opened');
    expect(nordvik.text).toMatch(/inactive events/i);
  });

  it('surfaces the org-specific metric override', async () => {
    const bazaar = await contextFor('bazaarhub-marketplace');
    expect(bazaar.text).toMatch(/ORG-SPECIFIC/);
    expect(bazaar.text).toMatch(/RTO/i);
  });

  it('carries the org\'s timezone and currency', async () => {
    expect((await contextFor('nordvik-fashion')).text).toContain('Asia/Kolkata');
    expect((await contextFor('voltedge-electronics')).text).toContain('Europe/London');
    expect((await contextFor('aurelia-skincare')).text).toContain('America/New_York');
  });
});

// ===========================================================================
describe('context caching', () => {
  it('a second request for an unchanged registry is served from cache', async () => {
    clearContextCache();
    const org = orgs.get('nordvik-fashion')!;
    const input = { orgName: org.name, orgSlug: org.slug, timezone: org.timezone, currency: org.currency };

    const first = await getOrgContext(org.id, input);
    const second = await getOrgContext(org.id, input);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.context.text).toBe(first.context.text);
    expect(cacheStats().hits).toBeGreaterThan(0);
  });

  it('a registry change invalidates the cache on the next request', async () => {
    // README Q2: "how does your context payload change when an org adds a new
    // event tomorrow?" — the version hash changes, so the cache key changes,
    // so the next request regenerates. No restart, no manual invalidation.
    clearContextCache();
    const org = orgs.get('aurelia-skincare')!;
    const input = { orgName: org.name, orgSlug: org.slug, timezone: org.timezone, currency: org.currency };

    const before = await getOrgContext(org.id, input);
    expect(before.cached).toBe(false);
    expect((await getOrgContext(org.id, input)).cached).toBe(true);

    // Simulate a human documenting an event.
    const client = await ownerClient();
    await client.query(
      `UPDATE event_definitions SET description = 'TEMP CHANGE FOR CACHE TEST'
       WHERE org_id = $1 AND event_name = 'app_launch'`,
      [org.id]
    );
    await client.query('BEGIN');
    await client.query('SELECT public.set_tenant_context($1::uuid)', [org.id]);
    await runDiscoveryForOrg(client, { id: org.id, slug: org.slug });
    await client.query('COMMIT');

    const after = await getOrgContext(org.id, input);
    expect(after.cached, 'registry changed but cache was still hit').toBe(false);
    expect(after.context.versionHash).not.toBe(before.context.versionHash);
    expect(after.context.text).toContain('TEMP CHANGE FOR CACHE TEST');

    // Restore.
    await client.query(
      `UPDATE event_definitions SET description = 'Session start.'
       WHERE org_id = $1 AND event_name = 'app_launch'`,
      [org.id]
    );
    await client.query('BEGIN');
    await client.query('SELECT public.set_tenant_context($1::uuid)', [org.id]);
    await runDiscoveryForOrg(client, { id: org.id, slug: org.slug });
    await client.query('COMMIT');
    await client.end();
  });

  it('caches are keyed per org — no cross-org bleed', async () => {
    clearContextCache();
    const a = orgs.get('nordvik-fashion')!;
    const b = orgs.get('freshcart-grocery')!;

    const ca = await getOrgContext(a.id, { orgName: a.name, orgSlug: a.slug, timezone: a.timezone, currency: a.currency });
    const cb = await getOrgContext(b.id, { orgName: b.name, orgSlug: b.slug, timezone: b.timezone, currency: b.currency });

    expect(cb.cached).toBe(false);
    expect(ca.context.text).not.toBe(cb.context.text);
    expect(cb.context.text).toContain('FreshCart');
    expect(cb.context.text).not.toContain('Nordvik');
  });
});
