/**
 * Incremental projection.
 *
 * The properties that matter, and what each test would catch:
 *
 *   - a re-run with no new events does near-zero work   -> the watermark works
 *   - a late status-change flips its order               -> correct under late arrival
 *   - only the affected order is touched                 -> it is genuinely incremental
 *   - incremental result == full-rebuild result          -> incrementality is not a shortcut that lies
 *
 * The suite restores the derived tables with a full rebuild in afterAll, so it
 * leaves the shared seed exactly as it found it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Client } from 'pg';
import { ownerClient } from './helpers.js';
import { runProjectionForOrg, type ProjectionOrg } from '../src/projection/project.js';
import { closePools } from '../src/db/pools.js';

let client: Client;
let nordvik: ProjectionOrg;

const TEST_DEDUPE = 'projtest-';

async function loadOrg(slug: string): Promise<ProjectionOrg> {
  const { rows } = await client.query<ProjectionOrg>(
    'SELECT id, slug, default_currency FROM organizations WHERE slug = $1',
    [slug]
  );
  return rows[0]!;
}

/** Advance to a fully-projected, up-to-date state for one org. */
async function fullRebuild(org: ProjectionOrg): Promise<void> {
  await client.query('DELETE FROM projection_state WHERE org_id = $1', [org.id]);
  await runProjectionForOrg(client, org); // watermark null -> full
}

beforeAll(async () => {
  client = await ownerClient();
  nordvik = await loadOrg('nordvik-fashion');
});

afterAll(async () => {
  // Remove any injected events and rebuild every org so downstream/rerun sees
  // the pristine seed.
  await client.query(`DELETE FROM events WHERE dedupe_key LIKE '${TEST_DEDUPE}%'`);
  const { rows } = await client.query<ProjectionOrg>(
    'SELECT id, slug, default_currency FROM organizations'
  );
  for (const org of rows) await fullRebuild(org);
  await client.end();
  await closePools();
});

// ===========================================================================
describe('the watermark makes re-runs cheap', () => {
  it('a second run immediately after a full run does zero work', async () => {
    await fullRebuild(nordvik);

    const second = await runProjectionForOrg(client, nordvik);
    expect(second.affected, 'second run should be incremental, not full').not.toBeNull();
    expect(second.affected!.orderIds.length).toBe(0);
    expect(second.affected!.productIds.length).toBe(0);
    expect(second.affected!.userIds.length).toBe(0);
    expect(second.counts.orders).toBe(0);
    expect(second.counts.order_items).toBe(0);
    expect(second.counts.products).toBe(0);
    expect(second.counts.user_profiles).toBe(0);
  });
});

// ===========================================================================
describe('a late-arriving status change is applied correctly', () => {
  it('recomputes only the affected order, and flips its status', async () => {
    await fullRebuild(nordvik);

    // A delivered order to mutate.
    const { rows: target } = await client.query<{ order_id: string; status: string }>(
      `SELECT order_id, status FROM orders
       WHERE org_id = $1 AND status = 'delivered' ORDER BY order_id LIMIT 1`,
      [nordvik.id]
    );
    const orderId = target[0]!.order_id;
    expect(target[0]!.status).toBe('delivered');

    // The order counts before, so we can prove nothing else moved.
    const { rows: before } = await client.query<{ n: string }>(
      'SELECT count(*) n FROM orders WHERE org_id = $1',
      [nordvik.id]
    );

    // Inject a late 'returned' transition: it HAPPENED recently, but its
    // ingested_at is placed just past the current watermark so the run sees it
    // as new. (Seed ingested_at values can sit in the near future, so anchor to
    // the watermark rather than wall-clock now().)
    await client.query(
      `
      INSERT INTO events (org_id, event_name, event_time, ingested_at, properties, dedupe_key)
      SELECT $1::uuid, 'order_status_changed',
             now() - interval '2 hours',
             (SELECT last_ingested_at FROM projection_state
              WHERE org_id = $1 AND projection_name = 'ecommerce_entities') + interval '1 second',
             jsonb_build_object('order_id', $2::text, 'status', 'returned', 'previous_status', 'delivered'),
             $3
      `,
      [nordvik.id, orderId, `${TEST_DEDUPE}${orderId}`]
    );

    const run = await runProjectionForOrg(client, nordvik);

    // Exactly the one order was recomputed.
    expect(run.affected).not.toBeNull();
    expect(run.affected!.orderIds).toContain(orderId);
    expect(run.affected!.orderIds.length).toBe(1);
    expect(run.counts.orders).toBe(1);

    // It flipped, and the order population did not change.
    const { rows: after } = await client.query<{ status: string }>(
      'SELECT status FROM orders WHERE org_id = $1 AND order_id = $2',
      [nordvik.id, orderId]
    );
    expect(after[0]!.status).toBe('returned');

    const { rows: afterCount } = await client.query<{ n: string }>(
      'SELECT count(*) n FROM orders WHERE org_id = $1',
      [nordvik.id]
    );
    expect(afterCount[0]!.n).toBe(before[0]!.n);
  });
});

// ===========================================================================
describe('incremental equals a full rebuild', () => {
  it('the delivered-count after an incremental apply matches a from-scratch rebuild', async () => {
    // Snapshot the full-rebuild truth WITH the late event present.
    await client.query(
      `
      INSERT INTO events (org_id, event_name, event_time, ingested_at, properties, dedupe_key)
      SELECT $1::uuid, 'order_status_changed', now() - interval '3 hours',
             (SELECT last_ingested_at FROM projection_state
              WHERE org_id = $1 AND projection_name = 'ecommerce_entities') + interval '2 seconds',
             jsonb_build_object('order_id', o.order_id, 'status', 'cancelled', 'previous_status', o.status),
             $2 || o.order_id
      FROM (SELECT order_id, status FROM orders
            WHERE org_id = $1 AND status = 'delivered' ORDER BY order_id OFFSET 1 LIMIT 1) o
      `,
      [nordvik.id, TEST_DEDUPE]
    );

    // Incremental apply.
    await runProjectionForOrg(client, nordvik);
    const { rows: incr } = await client.query<{ status: string; total: string }>(
      `SELECT status, count(*)::text total FROM orders WHERE org_id = $1 GROUP BY status ORDER BY status`,
      [nordvik.id]
    );

    // Full rebuild from the same events.
    await fullRebuild(nordvik);
    const { rows: full } = await client.query<{ status: string; total: string }>(
      `SELECT status, count(*)::text total FROM orders WHERE org_id = $1 GROUP BY status ORDER BY status`,
      [nordvik.id]
    );

    // The two must be identical: incremental is not allowed to diverge from
    // the ground truth a full recompute would produce.
    expect(incr).toEqual(full);
  });
});

// ===========================================================================
describe('a brand-new order arriving late is inserted incrementally', () => {
  it('picks up an order whose events all post-date the watermark', async () => {
    await fullRebuild(nordvik);

    const { rows: wm } = await client.query<{ w: string }>(
      `SELECT last_ingested_at::text w FROM projection_state
       WHERE org_id = $1 AND projection_name = 'ecommerce_entities'`,
      [nordvik.id]
    );
    const newOrderId = `${TEST_DEDUPE}neworder-1`;

    await client.query(
      `
      INSERT INTO events (org_id, event_name, event_time, ingested_at, properties, dedupe_key)
      VALUES ($1::uuid, 'order_placed', now() - interval '1 hour', $2::timestamptz + interval '3 seconds',
              jsonb_build_object(
                'order_id', $3::text, 'order_value_minor', 250000, 'currency', 'INR',
                'channel', 'search',
                'items', jsonb_build_array(jsonb_build_object('product_id','nordvik-p0001','qty',1,'unit_price_minor',250000))
              ),
              $4)
      `,
      [nordvik.id, wm[0]!.w, newOrderId, `${TEST_DEDUPE}place-${newOrderId}`]
    );

    const run = await runProjectionForOrg(client, nordvik);
    expect(run.affected!.orderIds).toContain(newOrderId);

    const { rows: got } = await client.query<{ status: string; total_amount_minor: string }>(
      'SELECT status, total_amount_minor FROM orders WHERE org_id = $1 AND order_id = $2',
      [nordvik.id, newOrderId]
    );
    expect(got.length).toBe(1);
    expect(got[0]!.status).toBe('placed');           // no status change yet
    expect(got[0]!.total_amount_minor).toBe('250000');

    const { rows: items } = await client.query<{ n: string }>(
      'SELECT count(*) n FROM order_items WHERE org_id = $1 AND order_id = $2',
      [nordvik.id, newOrderId]
    );
    expect(Number(items[0]!.n)).toBe(1);
  });
});
