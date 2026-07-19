/**
 * Org-specific data-dictionary generator.
 *
 * This is the payload that makes the server self-describing. It is returned in
 * the MCP `initialize` response as `instructions`, exposed as the resource
 * `schema://org/context`, and returned by the `get_schema_context` tool.
 *
 * THE BUDGET IS THE DESIGN CONSTRAINT.
 * Target is ~2,000 tokens. That is not much for a taxonomy of 11 events with
 * 50 properties, five metrics and worked examples, so this file is mostly a
 * compression exercise:
 *
 *   - Tabular lines, never prose. `app_open ~ session_start [lifecycle] 1.2k/30d`
 *     carries four facts in twelve tokens.
 *   - Properties are ranked by usefulness (enum-valued and required keys first,
 *     high-cardinality free text last) and truncated per event.
 *   - Descriptions are clipped to one clause.
 *   - Inactive events are omitted entirely; the count is reported so the model
 *     knows they exist and can ask.
 *   - Worked question -> SQL examples get a generous share of the budget,
 *     because few-shot examples buy more accuracy per token than prose does.
 *     They are generated from THIS org's real event names, so they double as
 *     taxonomy documentation.
 *
 * If the assembled payload exceeds the budget, sections are dropped in reverse
 * priority order rather than the whole thing being truncated mid-sentence —
 * a payload that ends mid-table is worse than one that is honestly shorter.
 */
import type { TenantSession } from '../db/tenantSession.js';

export interface OrgContextInput {
  orgName: string;
  orgSlug: string;
  timezone: string;
  currency: string;
}

export interface GeneratedContext {
  text: string;
  versionHash: string;
  approxTokens: number;
  generatedAt: string;
}

/** Rough token estimate. ~4 chars/token is close enough for budgeting. */
export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

const TOKEN_BUDGET = 2000;

const clip = (s: string | null | undefined, n: number): string => {
  if (!s) return '';
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
};

const compactNumber = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
};

interface EventRow {
  event_name: string;
  display_name: string | null;
  description: string | null;
  category: string;
  canonical_name: string | null;
  event_count_30d: string;
  auto_registered: boolean;
  quality_note: string | null;
  last_seen_at: string | null;
}

interface PropRow {
  event_name: string;
  property_key: string;
  data_type: string;
  description: string | null;
  is_required: boolean;
  is_pii: boolean;
  has_type_conflict: boolean;
  occurrence_rate: string | null;
  distinct_value_count: string | null;
  enum_values: unknown[] | null;
}

interface MetricRow {
  metric_key: string;
  display_name: string;
  description: string;
  unit: string;
  allowed_dimensions: string[];
  requires_canonical: string[];
  notes: string | null;
  is_override: boolean;
}

/**
 * Property ranking. A model needs enum values and required keys far more than
 * it needs to know that `session_id` has 4,000 distinct values.
 */
function propScore(p: PropRow): number {
  let score = 0;
  if (p.enum_values && p.enum_values.length) score += 100;
  if (p.is_required) score += 40;
  if (p.description) score += 30;
  if (p.has_type_conflict) score += 60;  // the model MUST know about these
  if (p.data_type === 'number') score += 15;
  if (p.is_pii) score -= 20;             // documented, but not a query target
  const distinct = Number(p.distinct_value_count ?? 0);
  if (distinct > 1000) score -= 25;
  const rate = Number(p.occurrence_rate ?? 0);
  score += rate * 20;
  return score;
}

export async function generateOrgContext(
  session: TenantSession,
  org: OrgContextInput
): Promise<GeneratedContext> {
  const [eventsRes, propsRes, metricsRes, versionRes, statsRes] = await Promise.all([
    session.query<EventRow>(
      `SELECT event_name, display_name, description, category, canonical_name,
              event_count_30d::text, auto_registered, quality_note, last_seen_at::text
       FROM event_definitions
       WHERE is_active
       ORDER BY event_count_30d DESC, event_name`
    ),
    session.query<PropRow>(
      `SELECT p.event_name, p.property_key, p.data_type, p.description, p.is_required,
              p.is_pii, p.has_type_conflict, p.occurrence_rate::text,
              p.distinct_value_count::text, p.enum_values
       FROM event_property_definitions p
       JOIN event_definitions e ON e.org_id = p.org_id AND e.event_name = p.event_name
       WHERE e.is_active`
    ),
    session.query<MetricRow>(
      // DISTINCT ON with org_id NULLS LAST: an org override shadows the global
      // default of the same key. This is the semantic layer resolving.
      `SELECT DISTINCT ON (metric_key)
              metric_key, display_name, description, unit, allowed_dimensions,
              requires_canonical, notes, (org_id IS NOT NULL) AS is_override
       FROM metric_definitions
       ORDER BY metric_key, org_id NULLS LAST`
    ),
    session.query<{ version_hash: string }>('SELECT version_hash FROM registry_version'),
    session.query<{ inactive: string; earliest: string | null; latest: string | null }>(
      `SELECT
         (SELECT count(*) FROM event_definitions WHERE NOT is_active)::text AS inactive,
         (SELECT min(event_time) FROM events WHERE NOT clock_skew_flag)::text AS earliest,
         (SELECT max(event_time) FROM events WHERE NOT clock_skew_flag)::text AS latest`
    ),
  ]);

  const events = eventsRes.rows;
  const metrics = metricsRes.rows;
  const stats = statsRes.rows[0];
  const versionHash = versionRes.rows[0]?.version_hash ?? 'unknown';

  const propsByEvent = new Map<string, PropRow[]>();
  for (const p of propsRes.rows) {
    const list = propsByEvent.get(p.event_name) ?? [];
    list.push(p);
    propsByEvent.set(p.event_name, list);
  }

  // Canonical -> this org's real event names.
  const canonical = new Map<string, string[]>();
  for (const e of events) {
    if (!e.canonical_name) continue;
    canonical.set(e.canonical_name, [...(canonical.get(e.canonical_name) ?? []), e.event_name]);
  }

  // ---- section assembly, in priority order --------------------------------
  const sections: { key: string; priority: number; body: string }[] = [];

  // ---------------------------------------------------------------- header
  const dateRange =
    stats?.earliest && stats?.latest
      ? `${stats.earliest.slice(0, 10)}..${stats.latest.slice(0, 10)}`
      : 'no data';

  sections.push({
    key: 'header',
    priority: 1,
    body: [
      `# ${org.orgName} — analytics context`,
      `tz=${org.timezone} | currency=${org.currency} | data=${dateRange} | registry=${versionHash.slice(0, 8)}`,
      '',
      'You are querying ONE organization. Tenant scoping is enforced by the database;',
      'no tool accepts an organization parameter and none is needed.',
      'All dates/buckets are rendered in the timezone above, not UTC.',
      'Money is INTEGER MINOR UNITS (paise/cents). Divide by 100 to display.',
    ].join('\n'),
  });

  // ------------------------------------------------------------ event list
  const eventLines = events.map((e) => {
    const vol = compactNumber(Number(e.event_count_30d));
    const canon = e.canonical_name ? ` ~${e.canonical_name}` : '';
    const flag = e.auto_registered && !e.description ? ' [UNDOCUMENTED]' : '';
    const desc = e.description ? ` — ${clip(e.description, 72)}` : '';
    return `${e.event_name}${canon} [${e.category[0]}] ${vol}/30d${flag}${desc}`;
  });

  sections.push({
    key: 'events',
    priority: 2,
    body: [
      '## EVENTS (name ~canonical [category] 30d-volume)',
      'categories: l=lifecycle d=discovery c=commerce e=engagement u=uncategorised',
      '[UNDOCUMENTED] = auto-discovered, no human description yet; treat the name as a guess.',
      ...eventLines,
      Number(stats?.inactive ?? 0) > 0
        ? `(+${stats!.inactive} inactive events, silent >180d, omitted. Ask if you need historical names.)`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  });

  // ------------------------------------------------------- canonical layer
  const canonLines = [...canonical.entries()]
    .sort()
    .map(([c, names]) => `${c} = ${names.join(' | ')}`);

  const ALL_CANONICAL = [
    'session_start', 'product_view', 'search', 'add_to_cart',
    'checkout_start', 'order_complete',
  ];
  const missing = ALL_CANONICAL.filter((c) => !canonical.has(c));

  sections.push({
    key: 'canonical',
    priority: 3,
    body: [
      '## CANONICAL MAP (cross-org concept -> this org\'s event names)',
      ...canonLines,
      missing.length
        ? `NOT TRACKED by this org: ${missing.join(', ')}. If asked about these, say this organization does not track them — do NOT report zero.`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  });

  // ------------------------------------------------------------- warnings
  const conflicts = propsRes.rows.filter((p) => p.has_type_conflict);
  const notes = events.filter((e) => e.quality_note);
  const undocumented = events.filter((e) => e.auto_registered && !e.description);

  if (conflicts.length || notes.length || undocumented.length) {
    sections.push({
      key: 'warnings',
      priority: 4,
      body: [
        '## DATA QUALITY — read before writing SQL',
        ...conflicts.map(
          (p) =>
            `${p.event_name}.${p.property_key}: MIXED JSON TYPES. Use jsonb_to_numeric(properties->'${p.property_key}'), never a direct ::numeric cast.`
        ),
        ...notes.map((e) => `${e.event_name}: ${clip(e.quality_note, 170)}`),
        ...undocumented.map(
          (e) => `${e.event_name}: undocumented — inferred from traffic only.`
        ),
      ].join('\n'),
    });
  }

  // ------------------------------------------------------------- properties
  // Budget-aware: top events by volume, top-ranked properties within each.
  const propSectionLines: string[] = [];
  for (const e of events.slice(0, 7)) {
    const list = (propsByEvent.get(e.event_name) ?? []).sort((a, b) => propScore(b) - propScore(a));
    if (!list.length) continue;
    const shown = list.slice(0, 5).map((p) => {
      const enums =
        p.enum_values && p.enum_values.length && p.enum_values.length <= 8
          ? `{${p.enum_values.map((v) => String(v)).join(',')}}`
          : '';
      const pii = p.is_pii ? ' PII-masked' : '';
      const req = p.is_required ? '!' : '?';
      const conflict = p.has_type_conflict ? ' MIXED' : '';
      return `${p.property_key}${req}:${p.data_type}${conflict}${enums}${pii}`;
    });
    const more = list.length > 5 ? ` +${list.length - 5} more` : '';
    propSectionLines.push(`${e.event_name}: ${shown.join(' ')}${more}`);
  }

  sections.push({
    key: 'properties',
    priority: 6,
    body: [
      '## EVENT PROPERTIES (key!=always-present key?=sometimes; {..}=full enum)',
      'Access via properties->>\'key\'. describe_event gives the full list for one event.',
      ...propSectionLines,
    ].join('\n'),
  });

  // ---------------------------------------------------------------- tables
  sections.push({
    key: 'tables',
    priority: 5,
    body: [
      '## TABLES (run_sql; all pre-filtered to your org by RLS)',
      'events(event_id,event_name,event_time,ingested_at,user_id,anonymous_id,session_id,platform,properties jsonb,clock_skew_flag)',
      'orders(order_id,user_id,status,total_amount_minor,currency,placed_at,channel,coupon_code)',
      'order_items(order_id,line_no,product_id,qty,unit_price_minor)',
      'products(product_id,title,category,brand)',
      'user_profiles(user_id,first_seen_at,last_seen_at,city,acquisition_source)',
      'identity_links(anonymous_id,user_id,linked_at)  -- many-to-many, both directions',
      'JOINS: order_items.order_id=orders.order_id | order_items.product_id=products.product_id',
      '       orders.user_id=user_profiles.user_id | events.user_id=user_profiles.user_id',
      'orders/order_items/products/user_profiles are PROJECTIONS of events, refreshed hourly.',
      'Prefer them over parsing JSONB for order questions.',
    ].join('\n'),
  });

  // --------------------------------------------------------------- metrics
  sections.push({
    key: 'metrics',
    priority: 7,
    body: [
      '## METRICS (query_metric) — these encode YOUR definitions, prefer them over raw SQL',
      ...metrics.map((m) => {
        const dims = m.allowed_dimensions.length ? ` dims:${m.allowed_dimensions.join(',')}` : ' dims:none';
        const star = m.is_override ? ' *ORG-SPECIFIC*' : '';
        return `${m.metric_key} (${m.unit})${star}${dims} — ${clip(m.description, 76)}`;
      }),
    ].join('\n'),
  });

  // Org-specific metric notes are high value and low volume — the whole point
  // of the semantic layer is that these assumptions travel with the number.
  const overrideNotes = metrics.filter((m) => m.is_override && m.notes);
  if (overrideNotes.length) {
    sections.push({
      key: 'metric_notes',
      priority: 4.5,
      body: [
        '## YOUR METRIC OVERRIDES — state these assumptions when you answer',
        ...overrideNotes.map((m) => `${m.metric_key}: ${clip(m.notes, 220)}`),
      ].join('\n'),
    });
  }

  // -------------------------------------------------------------- examples
  sections.push({
    key: 'examples',
    priority: 8,
    body: buildExamples(org, canonical, metrics),
  });

  // ------------------------------------------------------------ conventions
  sections.push({
    key: 'conventions',
    priority: 9,
    body: [
      '## CONVENTIONS',
      '- Bucket on event_time (when it happened), not ingested_at. Offline mobile lands ~4d late.',
      '- Current day/week/month is PARTIAL and flagged. Never read it as a drop.',
      '- clock_skew_flag=true = implausible client clock, clamped, excluded from metrics.',
      '- status:"empty" is a real zero, not a failure. Errors are status:"error".',
      '- Revenue is per-currency. Never sum across currencies.',
      '- Ambiguous question? Use the documented default and state the assumption.',
    ].join('\n'),
  });

  // ---- budget enforcement --------------------------------------------------
  const ordered = [...sections].sort((a, b) => a.priority - b.priority);
  let assembled = ordered.map((s) => s.body).join('\n\n');

  // Drop whole sections from the least important end until we fit. A short,
  // coherent payload beats a long one truncated mid-table.
  //
  // `examples` is deliberately NOT in this list and can never be dropped.
  // Few-shot pairs are the highest-accuracy-per-token content in the payload
  // and they are the only place this org's real event names appear inside
  // working SQL. `properties` goes first instead: describe_event returns the
  // same information on demand, so dropping it costs one extra round-trip
  // rather than correctness.
  const dropOrder = ['properties', 'conventions', 'metrics', 'tables'];
  for (const key of dropOrder) {
    if (estimateTokens(assembled) <= TOKEN_BUDGET) break;
    const idx = ordered.findIndex((s) => s.key === key);
    if (idx === -1) continue;
    ordered.splice(idx, 1);
    assembled = ordered.map((s) => s.body).join('\n\n');
    assembled += `\n\n(Section "${key}" omitted to stay within the context budget; call get_schema_context or describe_event for detail.)`;
  }

  return {
    text: assembled,
    versionHash,
    approxTokens: estimateTokens(assembled),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Worked question -> SQL pairs, generated from this org's REAL event names.
 *
 * Generated rather than hand-written because a hand-written example would name
 * `app_open`, which is wrong for four of the five orgs. These teach the
 * taxonomy and the query idioms at the same time, which is why they earn their
 * token cost.
 */
function buildExamples(
  org: OrgContextInput,
  canonical: Map<string, string[]>,
  metrics: MetricRow[]
): string {
  const sess = canonical.get('session_start') ?? [];
  const view = canonical.get('product_view') ?? [];
  const search = canonical.get('search') ?? [];
  const cart = canonical.get('add_to_cart') ?? [];

  const arr = (names: string[]) => `ANY(ARRAY[${names.map((n) => `'${n}'`).join(',')}])`;
  const tz = `'${org.timezone}'`;
  const out: string[] = ['## WORKED EXAMPLES (this org\'s real event names)'];

  if (sess.length) {
    out.push(
      `Q: sessions yesterday`,
      `A: prefer query_metric(metric="unique_sessions", from="yesterday", to="yesterday"). Raw:`,
      `SELECT count(DISTINCT session_id) FROM events WHERE event_name = ${arr(sess)}`,
      ` AND event_time >= (date_trunc('day', now() AT TIME ZONE ${tz}) - interval '1 day') AT TIME ZONE ${tz}`,
      ` AND event_time <  date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz};`
    );
  }

  out.push(
    `Q: orders last week from search`,
    `A: SELECT count(*) FROM orders WHERE channel='search'`,
    ` AND status IN ('placed','paid','shipped','delivered')`,
    ` AND placed_at >= (date_trunc('week', now() AT TIME ZONE ${tz}) - interval '1 week') AT TIME ZONE ${tz}`,
    ` AND placed_at <  date_trunc('week', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz};`
  );

  out.push(
    `Q: revenue by day, last 7 days`,
    `A: SELECT date_trunc('day', placed_at AT TIME ZONE ${tz}) d, currency, sum(total_amount_minor) minor`,
    ` FROM orders WHERE status IN ('placed','paid','shipped','delivered')`,
    ` AND placed_at >= now() - interval '7 days' GROUP BY 1,2 ORDER BY 1;`,
    ` -- note: GROUP BY currency. Never sum across currencies.`
  );

  if (view.length) {
    out.push(
      `Q: top 5 products viewed this month`,
      `A: prefer top_n(measure="product_views"). Raw:`,
      `SELECT properties->>'product_id' pid, count(*) n FROM events`,
      ` WHERE event_name = ${arr(view)} AND event_time >= date_trunc('month', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz}`,
      ` GROUP BY 1 ORDER BY n DESC LIMIT 5;`
    );
  }

  if (search.length) {
    out.push(
      `Q: searches that returned nothing`,
      `A: SELECT properties->>'search_query' q, count(*) n FROM events`,
      ` WHERE event_name = ${arr(search)} AND public.jsonb_to_numeric(properties->'results_count') = 0`,
      ` GROUP BY 1 ORDER BY n DESC LIMIT 20;`
    );
  } else {
    out.push(
      `Q: what are people searching for?`,
      `A: This organization does not track a search event. Say so — do not return 0.`
    );
  }

  if (cart.length > 1) {
    out.push(
      `Q: add-to-cart trend`,
      `A: This org has ${cart.length} add-to-cart event names (${cart.join(', ')}) due to a rename.`,
      ` Always match ALL of them: WHERE event_name = ${arr(cart)}  -- else you will see a false cliff.`
    );
  }

  out.push(
    `Q: conversion rate this month`,
    `A: query_metric(metric="conversion_rate", from="month_start", to="today"). Returns NULL`,
    ` for buckets with zero sessions — that means "not computable", not 0%.`
  );

  const override = metrics.find((m) => m.is_override);
  if (override) {
    out.push(
      `Q: how many orders last month?`,
      `A: query_metric(metric="${override.metric_key}"). NOTE: ${clip(override.notes, 130)}`
    );
  }

  return out.join('\n');
}
