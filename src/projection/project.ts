/**
 * Projection: raw events -> derived e-commerce entities.
 *
 * Lives in src/ (not scripts/) so it is importable by the test suite and by any
 * scheduled runner, mirroring how the discovery job is split. scripts/project.ts
 * is the thin cron entrypoint.
 *
 * This is the job that answers README Q1 ("why derive orders into tables
 * instead of querying JSONB directly"). Every write is an idempotent upsert
 * keyed on the natural key.
 *
 * INCREMENTAL, AND CORRECT UNDER LATE ARRIVALS
 * --------------------------------------------
 * The naive "process events newer than the watermark" is wrong for anything
 * whose value depends on an entity's WHOLE history. An order placed last week
 * and delivered today arrives as a lone status-change event: seen in isolation
 * it has no amount, no currency, no placed_at. So the job does this instead:
 *
 *   1. Take a REPEATABLE READ snapshot, so every read sees one consistent view
 *      and the watermark recorded at the end matches exactly what was
 *      processed. No lookback fudge, no boundary race.
 *   2. From events ingested since the last watermark, derive the AFFECTED KEYS:
 *      which order_ids, product_ids and user_ids changed.
 *   3. Recompute those specific entities FROM THEIR FULL HISTORY. The late
 *      status change recomputes its whole order correctly; an untouched order
 *      is not read at all.
 *   4. Advance the watermark to max(ingested_at) in the snapshot.
 *
 * The first run (watermark NULL) has no affected-key filter and processes
 * everything, so a full rebuild and an incremental refresh share one code path:
 * every query reads `($N::text[] IS NULL OR key = ANY($N))`.
 *
 * INCREMENTAL ON ingested_at, NOT event_time. A watermark on event_time would
 * permanently skip an event that happened days ago but was received now
 * (offline mobile queues). ingested_at is monotonic at insert, so it is the
 * safe watermark; the affected-key recompute is what keeps the result correct.
 *
 * Runs as the OWNER role: it writes, and the tenant role is SELECT-only. It
 * sets the tenant GUC anyway, so FORCE RLS is a live second check that the
 * projection only ever touches the org it thinks it is on.
 */
import type { Client } from 'pg';

export interface ProjectionOrg {
  id: string;
  slug: string;
  default_currency: string;
}

/** null = full run (no filter). Otherwise the entities to recompute. */
export interface AffectedKeys {
  orderIds: string[];
  productIds: string[];
  userIds: string[];
}

export interface ProjectionResult {
  counts: Record<string, number>;
  /** 'full' on a rebuild, otherwise the affected-key sizes for the log. */
  mode: string;
  affected: AffectedKeys | null;
}

/** Canonical concepts this job consumes, resolved per org from the registry. */
async function canonicalNames(
  client: Client,
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

/**
 * Which entities changed since the watermark. Returns null for a full run.
 *
 * order_ids come from BOTH order-complete and status-change events, so a late
 * status transition marks its order for recompute even though the order row
 * already exists. product_ids come from new product-view events (the only
 * source of product attributes). user_ids come from any new event carrying a
 * user_id.
 */
export async function affectedKeys(
  client: Client,
  org: ProjectionOrg,
  watermark: string | null,
  ev: { orderEvents: string[]; statusEvents: string[]; viewEvents: string[] }
): Promise<AffectedKeys | null> {
  if (watermark === null) return null;

  const orderish = [...new Set([...ev.orderEvents, ...ev.statusEvents])];

  const { rows } = await client.query<{
    order_ids: string[] | null;
    product_ids: string[] | null;
    user_ids: string[] | null;
  }>(
    `
    WITH nw AS (
      SELECT * FROM events
      WHERE org_id = $1 AND ingested_at > $2::timestamptz
    )
    SELECT
      (SELECT array_agg(DISTINCT public.jsonb_to_text(properties->'order_id'))
       FROM nw WHERE event_name = ANY($3) AND properties ? 'order_id'
         AND public.jsonb_to_text(properties->'order_id') IS NOT NULL) AS order_ids,
      (SELECT array_agg(DISTINCT public.jsonb_to_text(properties->'product_id'))
       FROM nw WHERE event_name = ANY($4) AND properties ? 'product_id'
         AND public.jsonb_to_text(properties->'product_id') IS NOT NULL) AS product_ids,
      (SELECT array_agg(DISTINCT user_id)
       FROM nw WHERE user_id IS NOT NULL) AS user_ids
    `,
    [org.id, watermark, orderish, ev.viewEvents]
  );

  return {
    orderIds: rows[0]?.order_ids ?? [],
    productIds: rows[0]?.product_ids ?? [],
    userIds: rows[0]?.user_ids ?? [],
  };
}

async function projectOrg(
  client: Client,
  org: ProjectionOrg,
  affected: AffectedKeys | null
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

  const orderEvents = await canonicalNames(client, org.id, 'order_complete');
  const statusEvents = await canonicalNames(client, org.id, 'order_status_change');
  const viewEvents = await canonicalNames(client, org.id, 'product_view');
  const sessionEvents = await canonicalNames(client, org.id, 'session_start');

  // Nullable filter arrays. When affected is null (full run) each is NULL and
  // the `$N IS NULL OR ...` guard passes everything.
  const orderFilter = affected ? affected.orderIds : null;
  const productFilter = affected ? affected.productIds : null;
  const userFilter = affected ? affected.userIds : null;

  // Skip whole projections when an incremental run touched nothing of that
  // kind. This is where "near-zero work on a no-op run" comes from.
  const runProducts = affected === null || affected.productIds.length > 0;
  const runUsers = affected === null || affected.userIds.length > 0;
  const runOrders = affected === null || affected.orderIds.length > 0;

  // ---- products ---------------------------------------------------------
  if (runProducts) {
    const products = await client.query(
      `
      INSERT INTO products (org_id, product_id, title, category, brand)
      SELECT DISTINCT ON (p.product_id)
             $1::uuid, p.product_id, p.title, p.category, p.brand
      FROM (
        SELECT public.jsonb_to_text(e.properties->'product_id') AS product_id,
               public.jsonb_to_text(e.properties->'product_title') AS title,
               public.jsonb_to_text(e.properties->'category') AS category,
               public.jsonb_to_text(e.properties->'brand') AS brand,
               e.event_time
        FROM events e
        WHERE e.org_id = $1 AND e.event_name = ANY($2)
          AND ($3::text[] IS NULL
               OR public.jsonb_to_text(e.properties->'product_id') = ANY($3))
      ) p
      WHERE p.product_id IS NOT NULL
      ORDER BY p.product_id, p.event_time DESC
      ON CONFLICT (org_id, product_id) DO UPDATE
        SET title    = COALESCE(EXCLUDED.title, products.title),
            category = COALESCE(EXCLUDED.category, products.category),
            brand    = COALESCE(EXCLUDED.brand, products.brand)
      `,
      [org.id, viewEvents, productFilter]
    );
    counts.products = products.rowCount ?? 0;
  } else {
    counts.products = 0;
  }

  // ---- user_profiles ----------------------------------------------------
  if (runUsers) {
    const profiles = await client.query(
      `
      INSERT INTO user_profiles (org_id, user_id, first_seen_at, last_seen_at, city, acquisition_source)
      SELECT $1::uuid, e.user_id, min(e.event_time), max(e.event_time),
             (array_agg(public.jsonb_to_text(e.properties->'city')
                        ORDER BY e.event_time DESC)
              FILTER (WHERE e.properties->>'city' IS NOT NULL))[1],
             (array_agg(public.jsonb_to_text(e.properties->'acquisition_source')
                        ORDER BY e.event_time DESC)
              FILTER (WHERE e.properties->>'acquisition_source' IS NOT NULL))[1]
      FROM events e
      WHERE e.org_id = $1 AND e.user_id IS NOT NULL AND NOT e.clock_skew_flag
        AND ($2::text[] IS NULL OR e.user_id = ANY($2))
      GROUP BY e.user_id
      ON CONFLICT (org_id, user_id) DO UPDATE
        SET first_seen_at      = LEAST(user_profiles.first_seen_at, EXCLUDED.first_seen_at),
            last_seen_at       = GREATEST(user_profiles.last_seen_at, EXCLUDED.last_seen_at),
            city               = COALESCE(EXCLUDED.city, user_profiles.city),
            acquisition_source = COALESCE(EXCLUDED.acquisition_source, user_profiles.acquisition_source)
      `,
      [org.id, userFilter]
    );
    counts.user_profiles = profiles.rowCount ?? 0;
  } else {
    counts.user_profiles = 0;
  }

  // ---- identity_links ---------------------------------------------------
  // Insert-only with min()/LEAST, so naturally incremental: only the new
  // window can introduce a link, and ON CONFLICT re-mins against any existing.
  const links = await client.query(
    `
    INSERT INTO identity_links (org_id, anonymous_id, user_id, linked_at)
    SELECT $1::uuid, e.anonymous_id, e.user_id, min(e.event_time)
    FROM events e
    WHERE e.org_id = $1 AND e.anonymous_id IS NOT NULL AND e.user_id IS NOT NULL
      AND ($2::text[] IS NULL OR e.user_id = ANY($2))
    GROUP BY e.anonymous_id, e.user_id
    ON CONFLICT (org_id, anonymous_id, user_id) DO UPDATE
      SET linked_at = LEAST(identity_links.linked_at, EXCLUDED.linked_at)
    `,
    [org.id, userFilter]
  );
  counts.identity_links = links.rowCount ?? 0;

  // ---- orders + order_items ---------------------------------------------
  if (runOrders) {
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
        WHERE e.org_id = $1 AND e.event_name = ANY($2)
          AND e.properties ? 'order_id' AND NOT e.clock_skew_flag
          AND ($5::text[] IS NULL
               OR public.jsonb_to_text(e.properties->'order_id') = ANY($5))
      ),
      latest_status AS (
        SELECT DISTINCT ON (public.jsonb_to_text(e.properties->'order_id'))
               public.jsonb_to_text(e.properties->'order_id') AS order_id,
               public.jsonb_to_text(e.properties->'status')   AS status
        FROM events e
        WHERE e.org_id = $1 AND e.event_name = ANY($4) AND e.properties ? 'order_id'
          AND ($5::text[] IS NULL
               OR public.jsonb_to_text(e.properties->'order_id') = ANY($5))
        ORDER BY public.jsonb_to_text(e.properties->'order_id'), e.event_time DESC
      )
      INSERT INTO orders (org_id, order_id, user_id, status, total_amount_minor,
                          currency, placed_at, channel, coupon_code)
      SELECT $1::uuid, p.order_id, p.user_id, COALESCE(ls.status, 'placed'),
             GREATEST(COALESCE(p.total_minor, 0)::bigint, 0),
             p.currency, p.placed_at, p.channel, p.coupon_code
      FROM placed p
      LEFT JOIN latest_status ls ON ls.order_id = p.order_id
      WHERE p.rn = 1 AND p.order_id IS NOT NULL AND p.currency ~ '^[A-Z]{3}$'
      ON CONFLICT (org_id, order_id) DO UPDATE
        SET status             = EXCLUDED.status,
            total_amount_minor = EXCLUDED.total_amount_minor,
            currency           = EXCLUDED.currency,
            channel            = COALESCE(EXCLUDED.channel, orders.channel),
            coupon_code        = COALESCE(EXCLUDED.coupon_code, orders.coupon_code),
            user_id            = COALESCE(EXCLUDED.user_id, orders.user_id)
      `,
      [org.id, orderEvents, org.default_currency, statusEvents, orderFilter]
    );
    counts.orders = orders.rowCount ?? 0;

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
          AND ($3::text[] IS NULL
               OR public.jsonb_to_text(e.properties->'order_id') = ANY($3))
        ORDER BY public.jsonb_to_text(e.properties->'order_id'), ord, e.event_time ASC
      )
      INSERT INTO order_items (org_id, order_id, line_no, product_id, qty, unit_price_minor)
      SELECT $1::uuid, x.order_id, x.line_no, x.product_id, GREATEST(x.qty, 1), GREATEST(x.unit_price_minor, 0)
      FROM exploded x
      JOIN orders o ON o.org_id = $1 AND o.order_id = x.order_id
      WHERE x.product_id IS NOT NULL
      ON CONFLICT (org_id, order_id, line_no) DO UPDATE
        SET product_id       = EXCLUDED.product_id,
            qty              = EXCLUDED.qty,
            unit_price_minor = EXCLUDED.unit_price_minor
      `,
      [org.id, orderEvents, orderFilter]
    );
    counts.order_items = items.rowCount ?? 0;

    // Products referenced only by an affected order line still deserve a row.
    await client.query(
      `
      INSERT INTO products (org_id, product_id)
      SELECT DISTINCT $1::uuid, oi.product_id
      FROM order_items oi
      WHERE oi.org_id = $1
        AND ($2::text[] IS NULL OR oi.order_id = ANY($2))
      ON CONFLICT (org_id, product_id) DO NOTHING
      `,
      [org.id, orderFilter]
    );
  } else {
    counts.orders = 0;
    counts.order_items = 0;
  }

  counts.sessions_source_events = sessionEvents.length;
  return counts;
}

/**
 * Runs one org's projection in its own REPEATABLE READ transaction.
 *
 * REPEATABLE READ means every read below sees one snapshot and the watermark
 * recorded matches exactly what was processed. Events inserted after the
 * snapshot are invisible and picked up on the next run. The caller supplies a
 * connected owner client; this function owns the transaction boundary.
 */
export async function runProjectionForOrg(
  client: Client,
  org: ProjectionOrg
): Promise<ProjectionResult> {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    // FORCE RLS applies to the owner too, so this is a live assertion that the
    // projection only ever touches its own org.
    await client.query('SELECT public.set_tenant_context($1::uuid)', [org.id]);

    const { rows: stateRows } = await client.query<{ last_ingested_at: string | null }>(
      `SELECT last_ingested_at::text FROM projection_state
       WHERE org_id = $1 AND projection_name = 'ecommerce_entities'`,
      [org.id]
    );
    const watermark = stateRows[0]?.last_ingested_at ?? null;

    const [orderEvents, statusEvents, viewEvents] = await Promise.all([
      canonicalNames(client, org.id, 'order_complete'),
      canonicalNames(client, org.id, 'order_status_change'),
      canonicalNames(client, org.id, 'product_view'),
    ]);

    const affected = await affectedKeys(client, org, watermark, {
      orderEvents,
      statusEvents,
      viewEvents,
    });

    const counts = await projectOrg(client, org, affected);

    // Watermark from the SAME snapshot, so it exactly bounds what we saw.
    const { rows: wmRows } = await client.query<{ max: string | null }>(
      'SELECT max(ingested_at)::text AS max FROM events WHERE org_id = $1',
      [org.id]
    );
    const newWatermark = wmRows[0]?.max ?? watermark;

    await client.query(
      `INSERT INTO projection_state (org_id, projection_name, last_ingested_at, last_run_at, rows_written)
       VALUES ($1, 'ecommerce_entities', COALESCE($2::timestamptz, now()), now(), $3)
       ON CONFLICT (org_id, projection_name) DO UPDATE
         SET last_ingested_at = EXCLUDED.last_ingested_at,
             last_run_at      = now(),
             rows_written     = EXCLUDED.rows_written`,
      [org.id, newWatermark, Object.values(counts).reduce((a, b) => a + b, 0)]
    );

    await client.query('COMMIT');

    const mode =
      affected === null
        ? 'full'
        : `incr(o:${affected.orderIds.length} p:${affected.productIds.length} u:${affected.userIds.length})`;
    return { counts, mode, affected };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}
