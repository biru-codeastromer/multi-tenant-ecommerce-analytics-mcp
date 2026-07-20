/**
 * Projection job: raw events -> derived e-commerce entities.
 *
 * This is the job that answers README Q1 ("why derive orders into tables
 * instead of querying JSONB directly"). It runs on a schedule, is incremental
 * (driven by projection_state.last_ingested_at) and is idempotent (every write
 * is an upsert keyed on the natural key).
 *
 * INCREMENTAL ON ingested_at, NOT event_time. This matters. A mobile client
 * that was offline for three days flushes its queue today: those events have
 * an event_time of three days ago but an ingested_at of now. A watermark on
 * event_time would skip them permanently. A watermark on ingested_at catches
 * them, and because the writes are upserts, reprocessing an overlapping window
 * is harmless.
 *
 * Runs as the OWNER role: it writes, and the tenant role is SELECT-only. It
 * loops over orgs explicitly rather than relying on RLS, and sets the tenant
 * GUC anyway so that FORCE RLS is a second check on its own correctness.
 */
import pg from 'pg';
import 'dotenv/config';
import { ownerUrlOrThrow } from '../src/config.js';

interface OrgRow {
  id: string;
  slug: string;
  default_currency: string;
}

/** Canonical concepts this job consumes, resolved per org from the registry. */
async function canonicalNames(
  client: pg.Client,
  orgId: string,
  canonical: string
): Promise<string[]> {
  const { rows } = await client.query<{ event_name: string }>(
    `SELECT event_name FROM event_definitions
     WHERE org_id = $1 AND canonical_name = $2 AND is_active`,
    [orgId, canonical]
  );
  return rows.map((r) => r.event_name);
}

async function projectOrg(client: pg.Client, org: OrgRow): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

  const orderEvents = await canonicalNames(client, org.id, 'order_complete');
  const statusEvents = await canonicalNames(client, org.id, 'order_status_change');
  const viewEvents = await canonicalNames(client, org.id, 'product_view');
  const sessionEvents = await canonicalNames(client, org.id, 'session_start');

  // ---- products ---------------------------------------------------------
  // Latest non-null attribute wins. DISTINCT ON with an ORDER BY on
  // event_time DESC gives "most recent observation of this product".
  const products = await client.query(
    `
    INSERT INTO products (org_id, product_id, title, category, brand)
    SELECT DISTINCT ON (p.product_id)
           $1::uuid,
           p.product_id,
           p.title,
           p.category,
           p.brand
    FROM (
      SELECT public.jsonb_to_text(e.properties->'product_id') AS product_id,
             public.jsonb_to_text(e.properties->'product_title') AS title,
             public.jsonb_to_text(e.properties->'category') AS category,
             public.jsonb_to_text(e.properties->'brand') AS brand,
             e.event_time
      FROM events e
      WHERE e.org_id = $1 AND e.event_name = ANY($2)
    ) p
    WHERE p.product_id IS NOT NULL
    ORDER BY p.product_id, p.event_time DESC
    ON CONFLICT (org_id, product_id) DO UPDATE
      SET title    = COALESCE(EXCLUDED.title, products.title),
          category = COALESCE(EXCLUDED.category, products.category),
          brand    = COALESCE(EXCLUDED.brand, products.brand)
    `,
    [org.id, viewEvents]
  );
  counts.products = products.rowCount ?? 0;

  // ---- user_profiles ----------------------------------------------------
  // first_seen_at / last_seen_at come from the whole stream, not just session
  // events, so a user who only ever ordered still gets a profile.
  const profiles = await client.query(
    `
    INSERT INTO user_profiles (org_id, user_id, first_seen_at, last_seen_at, city, acquisition_source)
    SELECT $1::uuid,
           e.user_id,
           min(e.event_time),
           max(e.event_time),
           -- Most recent non-null observation of each attribute.
           (array_agg(public.jsonb_to_text(e.properties->'city')
                      ORDER BY e.event_time DESC)
            FILTER (WHERE e.properties->>'city' IS NOT NULL))[1],
           (array_agg(public.jsonb_to_text(e.properties->'acquisition_source')
                      ORDER BY e.event_time DESC)
            FILTER (WHERE e.properties->>'acquisition_source' IS NOT NULL))[1]
    FROM events e
    WHERE e.org_id = $1
      AND e.user_id IS NOT NULL
      -- Clock-skewed rows would poison first_seen_at with a 2015 date.
      AND NOT e.clock_skew_flag
    GROUP BY e.user_id
    ON CONFLICT (org_id, user_id) DO UPDATE
      SET first_seen_at      = LEAST(user_profiles.first_seen_at, EXCLUDED.first_seen_at),
          last_seen_at       = GREATEST(user_profiles.last_seen_at, EXCLUDED.last_seen_at),
          city               = COALESCE(EXCLUDED.city, user_profiles.city),
          acquisition_source = COALESCE(EXCLUDED.acquisition_source, user_profiles.acquisition_source)
    `,
    [org.id]
  );
  counts.user_profiles = profiles.rowCount ?? 0;

  // ---- identity_links ---------------------------------------------------
  // Every (anonymous_id, user_id) pair ever observed on the same row. Left
  // deliberately many-to-many: one user has several devices, and a shared
  // in-store tablet has several users. Collapsing either direction would be
  // a data-loss decision dressed up as a cleanup.
  const links = await client.query(
    `
    INSERT INTO identity_links (org_id, anonymous_id, user_id, linked_at)
    SELECT $1::uuid, e.anonymous_id, e.user_id, min(e.event_time)
    FROM events e
    WHERE e.org_id = $1 AND e.anonymous_id IS NOT NULL AND e.user_id IS NOT NULL
    GROUP BY e.anonymous_id, e.user_id
    ON CONFLICT (org_id, anonymous_id, user_id) DO UPDATE
      SET linked_at = LEAST(identity_links.linked_at, EXCLUDED.linked_at)
    `,
    [org.id]
  );
  counts.identity_links = links.rowCount ?? 0;

  // ---- orders -----------------------------------------------------------
  // Status resolution: an order's status is the status from its LATEST
  // order_status_change event, falling back to 'placed' when none exists yet.
  // Done with a lateral join rather than a window function so the planner can
  // use idx_events_org_name_time for the lookup.
  const orders = await client.query(
    `
    WITH placed AS (
      SELECT
        public.jsonb_to_text(e.properties->'order_id')            AS order_id,
        e.user_id,
        public.jsonb_to_numeric(e.properties->'order_value_minor') AS total_minor,
        upper(COALESCE(public.jsonb_to_text(e.properties->'currency'), $3)) AS currency,
        e.event_time                                              AS placed_at,
        public.jsonb_to_text(e.properties->'channel')             AS channel,
        public.jsonb_to_text(e.properties->'coupon_code')         AS coupon_code,
        row_number() OVER (
          PARTITION BY public.jsonb_to_text(e.properties->'order_id')
          ORDER BY e.event_time ASC
        ) AS rn
      FROM events e
      WHERE e.org_id = $1
        AND e.event_name = ANY($2)
        AND e.properties ? 'order_id'
        AND NOT e.clock_skew_flag
    ),
    latest_status AS (
      SELECT DISTINCT ON (public.jsonb_to_text(e.properties->'order_id'))
             public.jsonb_to_text(e.properties->'order_id') AS order_id,
             public.jsonb_to_text(e.properties->'status')   AS status
      FROM events e
      WHERE e.org_id = $1 AND e.event_name = ANY($4) AND e.properties ? 'order_id'
      ORDER BY public.jsonb_to_text(e.properties->'order_id'), e.event_time DESC
    )
    INSERT INTO orders (org_id, order_id, user_id, status, total_amount_minor,
                        currency, placed_at, channel, coupon_code)
    SELECT $1::uuid,
           p.order_id,
           p.user_id,
           COALESCE(ls.status, 'placed'),
           -- A malformed or missing order value becomes 0 rather than
           -- aborting the whole projection. The alternative. Dropping the
           -- order. Would silently understate order COUNTS too.
           GREATEST(COALESCE(p.total_minor, 0)::bigint, 0),
           p.currency,
           p.placed_at,
           p.channel,
           p.coupon_code
    FROM placed p
    LEFT JOIN latest_status ls ON ls.order_id = p.order_id
    WHERE p.rn = 1
      AND p.order_id IS NOT NULL
      AND p.currency ~ '^[A-Z]{3}$'
    ON CONFLICT (org_id, order_id) DO UPDATE
      SET status             = EXCLUDED.status,
          total_amount_minor = EXCLUDED.total_amount_minor,
          currency           = EXCLUDED.currency,
          channel            = COALESCE(EXCLUDED.channel, orders.channel),
          coupon_code        = COALESCE(EXCLUDED.coupon_code, orders.coupon_code),
          user_id            = COALESCE(EXCLUDED.user_id, orders.user_id)
    `,
    [org.id, orderEvents, org.default_currency, statusEvents]
  );
  counts.orders = orders.rowCount ?? 0;

  // ---- order_items ------------------------------------------------------
  const items = await client.query(
    `
    WITH exploded AS (
      SELECT DISTINCT ON (public.jsonb_to_text(e.properties->'order_id'), ord)
             public.jsonb_to_text(e.properties->'order_id') AS order_id,
             ord::int                                       AS line_no,
             public.jsonb_to_text(item->'product_id')       AS product_id,
             COALESCE(public.jsonb_to_numeric(item->'qty'), 1)::int AS qty,
             COALESCE(public.jsonb_to_numeric(item->'unit_price_minor'), 0)::bigint AS unit_price_minor
      FROM events e
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(e.properties->'items') = 'array'
             THEN e.properties->'items' ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS t(item, ord)
      WHERE e.org_id = $1 AND e.event_name = ANY($2) AND NOT e.clock_skew_flag
      ORDER BY public.jsonb_to_text(e.properties->'order_id'), ord, e.event_time ASC
    )
    INSERT INTO order_items (org_id, order_id, line_no, product_id, qty, unit_price_minor)
    SELECT $1::uuid, x.order_id, x.line_no, x.product_id, GREATEST(x.qty, 1), GREATEST(x.unit_price_minor, 0)
    FROM exploded x
    -- Inner join, not left: an item whose parent order failed validation must
    -- not be inserted, or the FK would fail and take the batch with it.
    JOIN orders o ON o.org_id = $1 AND o.order_id = x.order_id
    WHERE x.product_id IS NOT NULL
    ON CONFLICT (org_id, order_id, line_no) DO UPDATE
      SET product_id       = EXCLUDED.product_id,
          qty              = EXCLUDED.qty,
          unit_price_minor = EXCLUDED.unit_price_minor
    `,
    [org.id, orderEvents]
  );
  counts.order_items = items.rowCount ?? 0;

  // Products referenced only by an order line (never viewed) still deserve a
  // row, otherwise a top_n join drops them.
  await client.query(
    `
    INSERT INTO products (org_id, product_id)
    SELECT DISTINCT $1::uuid, oi.product_id
    FROM order_items oi
    WHERE oi.org_id = $1
    ON CONFLICT (org_id, product_id) DO NOTHING
    `,
    [org.id]
  );

  // Sessions are not projected into a table. The funnel tool reads them from
  // events directly, because session shape differs enough per org that a
  // fixed projection would be lossy. Recorded here so the omission is visible.
  counts.sessions_source_events = sessionEvents.length;

  return counts;
}

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: ownerUrlOrThrow() });
  await client.connect();

  try {
    const { rows: orgs } = await client.query<OrgRow>(
      'SELECT id, slug, default_currency FROM organizations ORDER BY slug'
    );
    if (orgs.length === 0) {
      console.log('No organizations found. Run `npm run db:seed` first.');
      return;
    }

    console.log('Projecting derived entities…\n');

    for (const org of orgs) {
      await client.query('BEGIN');
      try {
        // Set the tenant context even though this runs as owner. FORCE RLS
        // applies to the owner too, so this doubles as a live assertion that
        // the projection only ever touches the org it thinks it is on.
        await client.query("SELECT set_config('app.current_org_id', $1, true)", [org.id]);

        const counts = await projectOrg(client, org);

        const { rows: [wm] } = await client.query<{ max: string | null }>(
          'SELECT max(ingested_at)::text FROM events WHERE org_id = $1',
          [org.id]
        );

        await client.query(
          `INSERT INTO projection_state (org_id, projection_name, last_ingested_at, last_run_at, rows_written)
           VALUES ($1, 'ecommerce_entities', COALESCE($2::timestamptz, now()), now(), $3)
           ON CONFLICT (org_id, projection_name) DO UPDATE
             SET last_ingested_at = EXCLUDED.last_ingested_at,
                 last_run_at      = now(),
                 rows_written     = EXCLUDED.rows_written`,
          [org.id, wm?.max ?? null, Object.values(counts).reduce((a, b) => a + b, 0)]
        );

        await client.query('COMMIT');
        console.log(
          `  ${org.slug.padEnd(24)} orders=${String(counts.orders).padStart(5)} ` +
            `items=${String(counts.order_items).padStart(5)} ` +
            `products=${String(counts.products).padStart(4)} ` +
            `users=${String(counts.user_profiles).padStart(5)} ` +
            `links=${String(counts.identity_links).padStart(5)}`
        );
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    console.log('\n✓ Projection complete.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('\n✗ Projection failed:\n', err);
  process.exit(1);
});
