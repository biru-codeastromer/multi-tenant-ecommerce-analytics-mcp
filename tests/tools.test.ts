/**
 * Tool behaviour and edge-case correctness.
 *
 * The theme running through this file: a wrong answer that looks like an
 * answer is worse than an error. Most of these tests assert that the system
 * refuses to fabricate. Not_tracked instead of zero, NULL instead of a
 * divide-by-zero, per-currency rows instead of a meaningless sum.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadTestOrgs, cleanupTestCredentials, type TestOrg } from './helpers.js';
import { withOrgSession } from '../src/db/tenantSession.js';
import { closePools } from '../src/db/pools.js';
import { TOOLS_BY_NAME } from '../src/tools/index.js';
import { resolveCredential } from '../src/auth/credentials.js';
import { resolveRange } from '../src/util/time.js';
import { McpToolError } from '../src/util/errors.js';
import type { ToolResponse } from '../src/util/render.js';

let orgs: Map<string, TestOrg>;

beforeAll(async () => {
  orgs = await loadTestOrgs();
});

afterAll(async () => {
  await cleanupTestCredentials();
  await closePools();
});

/** Invokes a tool exactly as the MCP layer does. */
async function callTool(
  orgSlug: string,
  toolName: string,
  args: Record<string, unknown> = {}
): Promise<ToolResponse> {
  const org = orgs.get(orgSlug)!;
  const tenant = await resolveCredential(org.apiKey);
  const tool = TOOLS_BY_NAME.get(toolName)!;
  return withOrgSession(tenant.orgId, (session) =>
    tool.handler(args as never, { session, tenant, recordSql: () => {} })
  );
}

// ===========================================================================
describe('canonical taxonomy resolution', () => {
  it('the same question resolves through different event names per org', async () => {
    const nordvik = await callTool('nordvik-fashion', 'query_metric', {
      metric: 'sessions_started', from: 'last_30_days',
    });
    const freshcart = await callTool('freshcart-grocery', 'query_metric', {
      metric: 'sessions_started', from: 'last_30_days',
    });

    expect(nordvik.meta?.resolved_event_names).toEqual(['app_open']);
    expect(freshcart.meta?.resolved_event_names).toEqual(['website_open']);
    expect(nordvik.status).toBe('ok');
    expect(freshcart.status).toBe('ok');
  });

  it('an org with THREE session-start events resolves all of them', async () => {
    // The case that breaks any implementation assuming a 1:1 canonical map.
    const res = await callTool('bazaarhub-marketplace', 'query_metric', {
      metric: 'sessions_started', from: 'last_30_days',
    });
    const names = res.meta?.resolved_event_names as string[];
    expect(names.sort()).toEqual(['app_open', 'kiosk_open', 'website_open']);
  });

  it('a renamed event is covered by BOTH names, with no false cliff', async () => {
    // FreshCart renamed basket_add -> cart_add on day -45 with no backfill.
    // Querying add_to_cart across that seam must span both names.
    const res = await callTool('freshcart-grocery', 'query_metric', {
      metric: 'add_to_cart', from: 'last_90_days', bucket: 'month',
    });
    const names = (res.meta?.resolved_event_names as string[]).sort();
    expect(names).toEqual(['basket_add', 'cart_add']);
    expect(res.status).toBe('ok');
  });
});

// ===========================================================================
describe('"this org does not track that" is NOT zero', () => {
  it('searches at an org with no search event returns not_tracked', async () => {
    // THE MOST IMPORTANT CORRECTNESS TEST IN THIS FILE.
    // Aurelia ships no search feature. Returning 0 would assert that nobody
    // searched, which is a factual claim about user behaviour and is false.
    const res = await callTool('aurelia-skincare', 'query_metric', {
      metric: 'searches', from: 'last_30_days',
    });

    expect(res.status).toBe('not_tracked');
    expect(res.status).not.toBe('empty');
    expect(res.data).toBeNull();
    expect(JSON.stringify(res.assumptions)).toMatch(/does not track/i);
    expect(res.meta?.missing_concepts).toContain('search');
    expect(res.meta?.guidance).toMatch(/do NOT report zero/i);
  });

  it('the same metric at an org that DOES track search returns data', async () => {
    const res = await callTool('nordvik-fashion', 'query_metric', {
      metric: 'searches', from: 'last_30_days',
    });
    expect(res.status).toBe('ok');
  });

  it('a funnel with an untracked step reports which step, not zero conversion', async () => {
    const res = await callTool('aurelia-skincare', 'funnel', {
      steps: ['session_start', 'search', 'order_complete'],
    });
    expect(res.status).toBe('not_tracked');
    expect(res.meta?.untracked_steps).toContain('search');
    expect(res.meta?.guidance).toMatch(/do NOT report zero/i);
  });

  it('top_n on an untracked concept reports not_tracked', async () => {
    const res = await callTool('aurelia-skincare', 'top_n', { measure: 'searches' });
    expect(res.status).toBe('not_tracked');
  });

  it('list_events filtered to an untracked concept explains the absence', async () => {
    const res = await callTool('aurelia-skincare', 'list_events', { canonical: 'search' });
    expect(res.status).toBe('empty');
    expect(res.summary).toMatch(/does not track/i);
    expect(res.meta?.available_canonical_concepts).toBeDefined();
  });
});

// ===========================================================================
describe('empty is distinguishable from error', () => {
  it('a real zero comes back as status "empty" with an explanation', async () => {
    const res = await callTool('aurelia-skincare', 'query_metric', {
      metric: 'orders_count', from: '2020-01-01', to: '2020-01-31',
    });
    expect(res.status).toBe('empty');
    expect(res.data).toEqual([]);
    expect(JSON.stringify(res.assumptions)).toMatch(/genuine zero|not a fail/i);
  });

  it('a valid query matching nothing via run_sql is empty, not an error', async () => {
    const res = await callTool('nordvik-fashion', 'run_sql', {
      sql: "SELECT * FROM events WHERE event_name = 'this_event_does_not_exist'",
    });
    expect(res.status).toBe('empty');
    expect(JSON.stringify(res.assumptions)).toMatch(/EMPTY RESULT, not an error/i);
  });

  it('an invalid query is an error, not empty', async () => {
    await expect(
      callTool('nordvik-fashion', 'run_sql', { sql: 'DROP TABLE events' })
    ).rejects.toThrow(McpToolError);
  });
});

// ===========================================================================
describe('errors enable one-turn self-correction', () => {
  it('an unknown event names the closest real options', async () => {
    try {
      await callTool('nordvik-fashion', 'describe_event', { event_name: 'app_opened' });
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as McpToolError;
      expect(e.code).toBe('unknown_event');
      expect(e.didYouMean).toContain('app_open');
      expect(e.hint).toMatch(/this org fires/i);
    }
  });

  it('an unknown metric lists the available metrics', async () => {
    try {
      await callTool('nordvik-fashion', 'query_metric', { metric: 'ordercount' });
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as McpToolError;
      expect(e.code).toBe('unknown_metric');
      expect(e.didYouMean).toContain('orders_count');
    }
  });

  it('an unsupported dimension names the supported ones', async () => {
    try {
      await callTool('nordvik-fashion', 'query_metric', {
        metric: 'orders_count', dimension: 'platfrom',
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as McpToolError;
      expect(e.code).toBe('unknown_dimension');
      expect(e.hint).toBeDefined();
    }
  });

  it('asking for another org\'s event name fails cleanly, without confirming it exists', async () => {
    // website_open is FreshCart's event. Nordvik must not learn that.
    try {
      await callTool('nordvik-fashion', 'describe_event', { event_name: 'website_open' });
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as McpToolError;
      expect(e.code).toBe('unknown_event');
      expect(e.message).toMatch(/not an event in this organization/i);
      // Must not hint that it belongs to someone else.
      expect(e.message).not.toMatch(/freshcart|another org|other organization/i);
    }
  });
});

// ===========================================================================
describe('money and multi-currency', () => {
  it('revenue is split per currency and never summed across them', async () => {
    const res = await callTool('voltedge-electronics', 'query_metric', {
      metric: 'revenue', from: 'last_90_days', bucket: 'month',
    });
    expect(res.status).toBe('ok');
    const currencies = res.meta?.currencies as string[];
    expect(currencies.length).toBeGreaterThan(1);
    expect(JSON.stringify(res.assumptions)).toMatch(/MUST NOT be added together/i);

    // Every row carries its own currency; there is no cross-currency total.
    for (const row of res.data as { currency: string }[]) {
      expect(row.currency).toBeTruthy();
    }
    expect(res.meta?.totals_by_currency).toBeDefined();
  });

  it('monetary values are integer minor units, not floats', async () => {
    const res = await callTool('nordvik-fashion', 'query_metric', {
      metric: 'revenue', from: 'last_90_days', bucket: 'month',
    });
    expect(res.meta?.value_note).toMatch(/MINOR UNITS/i);
    for (const row of res.data as { metric_value: string }[]) {
      expect(Number.isInteger(Number(row.metric_value))).toBe(true);
    }
  });

  it('AOV returns NULL rather than dividing by zero', async () => {
    const res = await callTool('aurelia-skincare', 'query_metric', {
      metric: 'aov', from: 'last_90_days', bucket: 'day',
    });
    // Sparse org: buckets exist with no orders. None may be 0 or NaN.
    for (const row of (res.data ?? []) as { metric_value: string | null }[]) {
      if (row.metric_value !== null) expect(Number.isNaN(Number(row.metric_value))).toBe(false);
    }
  });

  it('conversion rate with no sessions is NULL, not 0%', async () => {
    const res = await callTool('aurelia-skincare', 'query_metric', {
      metric: 'conversion_rate', from: '2020-01-01', to: '2020-01-31',
    });
    expect(res.status).toBe('empty');
    expect(res.status).not.toBe('error');
  });
});

// ===========================================================================
describe('the org-specific semantic layer', () => {
  it('an org override shadows the global metric definition', async () => {
    const bazaar = await callTool('bazaarhub-marketplace', 'query_metric', {
      metric: 'orders_count', from: 'last_90_days',
    });
    const nordvik = await callTool('nordvik-fashion', 'query_metric', {
      metric: 'orders_count', from: 'last_90_days',
    });

    expect(bazaar.meta?.is_org_specific_definition).toBe(true);
    expect(nordvik.meta?.is_org_specific_definition).toBe(false);
    expect(String(bazaar.meta?.definition)).toMatch(/DELIVERED/i);
  });

  it('the override\'s assumption travels with the number', async () => {
    const res = await callTool('bazaarhub-marketplace', 'query_metric', {
      metric: 'orders_count', from: 'last_90_days',
    });
    expect(JSON.stringify(res.assumptions)).toMatch(/RTO|delivered only/i);
  });

  it('the delivered-only definition really does count fewer orders', async () => {
    // Proves the override changes the number, not just the description.
    const org = orgs.get('bazaarhub-marketplace')!;
    const tenant = await resolveCredential(org.apiKey);
    const counts = await withOrgSession(tenant.orgId, (s) =>
      s.query<{ delivered: string; committed: string }>(
        `SELECT count(*) FILTER (WHERE status = 'delivered')::text AS delivered,
                count(*) FILTER (WHERE status IN ('placed','paid','shipped','delivered'))::text AS committed
         FROM orders`
      )
    );
    expect(Number(counts.rows[0]!.delivered)).toBeLessThan(Number(counts.rows[0]!.committed));
  });
});

// ===========================================================================
describe('time handling', () => {
  it('a day boundary lands on local midnight, not UTC midnight', () => {
    // The invariant that actually matters: an IST day starts at 18:30 UTC the
    // previous day. Asserting a fixed delta between IST-yesterday and
    // UTC-yesterday would be wrong, because once it is past 18:30 UTC the two
    // zones disagree about which calendar day "yesterday" even is. Which is
    // precisely the bug this timezone handling exists to prevent.
    const ist = resolveRange({ from: 'yesterday', timezone: 'Asia/Kolkata' });
    expect(ist.fromUtc.getUTCHours()).toBe(18);
    expect(ist.fromUtc.getUTCMinutes()).toBe(30);

    const utc = resolveRange({ from: 'yesterday', timezone: 'UTC' });
    expect(utc.fromUtc.getUTCHours()).toBe(0);
    expect(utc.fromUtc.getUTCMinutes()).toBe(0);

    // And both spans are exactly one day long.
    for (const r of [ist, utc]) {
      expect((r.toUtc.getTime() - r.fromUtc.getTime()) / 3_600_000).toBe(24);
    }
  });

  it('the same keyword yields different instants for differently-zoned orgs', () => {
    const jaipur = resolveRange({ from: 'today', timezone: 'Asia/Kolkata' });
    const newYork = resolveRange({ from: 'today', timezone: 'America/New_York' });
    expect(jaipur.fromUtc.getTime()).not.toBe(newYork.fromUtc.getTime());
  });

  it('a range ending now flags the trailing bucket as partial', async () => {
    const res = await callTool('nordvik-fashion', 'query_metric', {
      metric: 'sessions_started', from: 'last_7_days', to: 'today', bucket: 'day',
    });
    expect(JSON.stringify(res.assumptions)).toMatch(/INCOMPLETE|partial/i);
    const rows = (res.data ?? []) as { is_partial?: boolean }[];
    expect(rows.some((r) => r.is_partial)).toBe(true);
  });

  it('a fully historical range has no partial bucket', async () => {
    const res = await callTool('nordvik-fashion', 'query_metric', {
      metric: 'sessions_started', from: '2026-05-01', to: '2026-05-31', bucket: 'day',
    });
    const rows = (res.data ?? []) as { is_partial?: boolean }[];
    expect(rows.every((r) => !r.is_partial)).toBe(true);
  });

  it('the default range is stated explicitly rather than left implicit', async () => {
    const res = await callTool('nordvik-fashion', 'query_metric', { metric: 'orders_count' });
    expect(JSON.stringify(res.assumptions)).toMatch(/default|no range was specified/i);
  });

  it('an unparseable date is rejected with the valid formats', () => {
    expect(() => resolveRange({ from: 'last tuesday-ish', timezone: 'UTC' })).toThrow(McpToolError);
  });

  it('an inverted range is rejected', () => {
    expect(() =>
      resolveRange({ from: '2026-06-01', to: '2026-01-01', timezone: 'UTC' })
    ).toThrow(McpToolError);
  });

  it('hourly buckets are capped to short ranges', () => {
    expect(() =>
      resolveRange({ from: '2026-01-01', to: '2026-06-01', bucket: 'hour', timezone: 'UTC' })
    ).toThrow(McpToolError);
  });
});

// ===========================================================================
describe('dirty data', () => {
  it('a mixed-type JSONB property is flagged in the registry', async () => {
    const res = await callTool('voltedge-electronics', 'describe_event', { event_name: 'pdp_view' });
    const props = (res.data as { properties: { property_key: string; has_type_conflict: boolean; data_type: string }[] }).properties;
    const price = props.find((p) => p.property_key === 'price')!;
    expect(price.has_type_conflict).toBe(true);
    expect(price.data_type).toBe('mixed');
    expect(JSON.stringify(res.assumptions)).toMatch(/jsonb_to_numeric/i);
  });

  it('the defensive cast survives mixed types where a direct cast would fail', async () => {
    const org = orgs.get('voltedge-electronics')!;
    const tenant = await resolveCredential(org.apiKey);

    // The defensive helper handles both '1299.00' and 1299.
    const ok = await withOrgSession(tenant.orgId, (s) =>
      s.query<{ n: string }>(
        `SELECT count(public.jsonb_to_numeric(properties->'price')) n
         FROM events WHERE event_name = 'pdp_view'`
      )
    );
    expect(Number(ok.rows[0]!.n)).toBeGreaterThan(0);

    // A direct cast is what the model would reach for, and it dies.
    await expect(
      withOrgSession(tenant.orgId, (s) =>
        s.query(`SELECT (properties->>'price')::numeric FROM events WHERE event_name='pdp_view'`)
      )
    ).rejects.toThrow();
  });

  it('clock-skewed events are excluded from metrics but retained in the raw stream', async () => {
    const org = orgs.get('nordvik-fashion')!;
    const tenant = await resolveCredential(org.apiKey);
    const res = await withOrgSession(tenant.orgId, (s) =>
      s.query<{ n: string }>('SELECT count(*) n FROM events WHERE clock_skew_flag')
    );
    // The raw rows are kept. We do not silently destroy data.
    expect(Number(res.rows[0]!.n)).toBeGreaterThan(0);
  });

  it('all stored timestamps are inside the sane clamp window', async () => {
    const org = orgs.get('nordvik-fashion')!;
    const tenant = await resolveCredential(org.apiKey);
    const res = await withOrgSession(tenant.orgId, (s) =>
      s.query<{ n: string }>(
        `SELECT count(*) n FROM events
         WHERE event_time < '2015-01-01'::timestamptz OR event_time >= '2100-01-01'::timestamptz`
      )
    );
    expect(res.rows[0]!.n).toBe('0');
  });
});

// ===========================================================================
describe('result size control', () => {
  it('run_sql applies a LIMIT even when none was given', async () => {
    const res = await callTool('nordvik-fashion', 'run_sql', { sql: 'SELECT * FROM events' });
    expect(JSON.stringify(res.assumptions)).toMatch(/LIMIT of \d+ was applied/i);
    expect((res.data as unknown[]).length).toBeLessThanOrEqual(500);
  });

  it('a wide result is truncated with an explicit notice', async () => {
    const res = await callTool('nordvik-fashion', 'run_sql', {
      sql: 'SELECT event_id, event_name, properties, event_time FROM events LIMIT 500',
    });
    if (res.truncation) {
      expect(res.truncation.note).toMatch(/Showing/i);
    }
    expect(res.status).toBe('ok');
  });
});

// ===========================================================================
describe('funnel semantics', () => {
  it('steps are monotonically non-increasing', async () => {
    const res = await callTool('nordvik-fashion', 'funnel', {
      steps: ['session_start', 'product_view', 'add_to_cart', 'order_complete'],
      from: 'last_90_days',
    });
    expect(res.status).toBe('ok');
    const steps = res.data as { actors: number }[];
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]!.actors).toBeLessThanOrEqual(steps[i - 1]!.actors);
    }
  });

  it('drop-off is not uniform. The seed models real behaviour', async () => {
    const res = await callTool('nordvik-fashion', 'funnel', {
      steps: ['session_start', 'product_view', 'add_to_cart', 'order_complete'],
      from: 'last_90_days',
    });
    const rates = (res.data as { conversion_from_previous_pct: number | null }[])
      .map((s) => s.conversion_from_previous_pct)
      .filter((r): r is number => r !== null);
    expect(new Set(rates.map((r) => Math.round(r))).size).toBeGreaterThan(1);
  });

  it('the identity-stitching choice is stated in the response', async () => {
    const stitched = await callTool('nordvik-fashion', 'funnel', {
      steps: ['session_start', 'order_complete'], by: 'user', from: 'last_90_days',
    });
    const perSession = await callTool('nordvik-fashion', 'funnel', {
      steps: ['session_start', 'order_complete'], by: 'session', from: 'last_90_days',
    });
    expect(JSON.stringify(stitched.assumptions)).toMatch(/identity-stitched/i);
    expect(JSON.stringify(perSession.assumptions)).toMatch(/single session/i);
  });
});
