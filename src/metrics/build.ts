/**
 * Metric SQL builder. Turns a stored sql_template into a bound, executable
 * query.
 *
 * THE SECURITY MODEL, stated plainly because this is the one place where
 * model-supplied strings meet SQL:
 *
 *   - sql_template comes from metric_definitions, which is operator-authored
 *     and seeded from this repo. No MCP tool can write it. It is trusted
 *     config, on the same footing as application source.
 *
 *   - Everything the MODEL supplies is either bound as a parameter (dates,
 *     bucket, timezone, filter values) or used as a LOOKUP KEY into a
 *     hardcoded table and never itself emitted (dimensions, filter columns).
 *
 *   - The distinction matters: `DIMENSION_SQL[dim]` returns a constant string
 *     we wrote. If `dim` is not an exact key, the lookup fails and the request
 *     is rejected with the valid options. There is no code path where a
 *     model-authored string is concatenated into SQL.
 *
 *   - No template contains an org_id predicate, and none needs one. RLS
 *     supplies it. That is deliberate: a template that had to remember to
 *     filter by tenant is a template that will eventually forget.
 */
import { McpToolError } from '../util/errors.js';
import { closestMatches } from '../util/render.js';
import type { ResolvedRange } from '../util/time.js';

/**
 * The complete set of dimensions any metric may be sliced by, mapped to fixed
 * SQL expressions. A dimension not in this table cannot be requested, no
 * matter what a metric's allowed_dimensions column claims.
 *
 * `requiresJoin` declares the join a dimension needs; the builder adds it once
 * and only when that dimension is actually used, so the common undimensioned
 * query stays a single-table scan.
 */
interface DimensionSpec {
  sql: string;
  requiresJoin?: 'user_profiles_via_events' | 'user_profiles_via_orders';
  description: string;
}

const DIMENSION_SQL: Record<string, DimensionSpec> = {
  platform: { sql: 'e.platform', description: 'ios / android / web / kiosk / pos' },
  event_name: { sql: 'e.event_name', description: "the org's raw event name" },
  channel: { sql: 'o.channel', description: 'search / browse / direct / recommendation / push' },
  status: { sql: 'o.status', description: 'order fulfilment status' },
  coupon_code: { sql: "COALESCE(o.coupon_code, '(none)')", description: 'coupon applied, or (none)' },
  currency: { sql: 'o.currency::text', description: 'ISO currency code' },
  city: {
    sql: "COALESCE(up.city, '(unknown)')",
    requiresJoin: 'user_profiles_via_events',
    description: 'city from the user profile',
  },
  acquisition_source: {
    sql: "COALESCE(up.acquisition_source, '(unknown)')",
    requiresJoin: 'user_profiles_via_events',
    description: 'organic / paid_search / social / referral / email / direct',
  },
};

/** Filters the model may apply, and how each is compared. */
const FILTER_SQL: Record<string, { sql: string; requiresJoin?: DimensionSpec['requiresJoin'] }> = {
  platform: { sql: 'e.platform' },
  event_name: { sql: 'e.event_name' },
  channel: { sql: 'o.channel' },
  status: { sql: 'o.status' },
  currency: { sql: 'o.currency::text' },
  coupon_code: { sql: 'o.coupon_code' },
  city: { sql: 'up.city', requiresJoin: 'user_profiles_via_events' },
  acquisition_source: { sql: 'up.acquisition_source', requiresJoin: 'user_profiles_via_events' },
};

export interface MetricDefinition {
  metric_key: string;
  display_name: string;
  description: string;
  unit: string;
  sql_template: string;
  allowed_dimensions: string[];
  requires_canonical: string[];
  notes: string | null;
  is_override: boolean;
}

export interface BuiltMetricQuery {
  sql: string;
  params: unknown[];
  dimension: string | null;
  appliedFilters: { column: string; value: string }[];
}

export interface BuildOptions {
  definition: MetricDefinition;
  range: ResolvedRange;
  /** Raw event names for this org, resolved from requires_canonical. */
  eventNames: string[];
  dimension?: string;
  filters?: Record<string, string>;
}

export function buildMetricQuery(opts: BuildOptions): BuiltMetricQuery {
  const { definition, range, eventNames } = opts;
  const params: unknown[] = [];
  const push = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };

  // ---- dimension ---------------------------------------------------------
  let dimensionExpr = 'NULL::text';
  let dimension: string | null = null;
  const joins = new Set<DimensionSpec['requiresJoin']>();

  if (opts.dimension) {
    if (!definition.allowed_dimensions.includes(opts.dimension)) {
      throw new McpToolError(
        'unknown_dimension',
        `Metric "${definition.metric_key}" cannot be broken down by "${opts.dimension}".`,
        {
          hint: definition.allowed_dimensions.length
            ? `Supported dimensions for this metric: ${definition.allowed_dimensions.join(', ')}.`
            : `This metric does not support any dimension. ${definition.notes ?? ''}`.trim(),
          didYouMean: closestMatches(opts.dimension, definition.allowed_dimensions),
        }
      );
    }
    const spec = DIMENSION_SQL[opts.dimension];
    if (!spec) {
      // allowed_dimensions listed something the builder has no expression for.
      // A configuration bug, not a caller error. Fail loudly rather than
      // silently ignoring the requested breakdown.
      throw new McpToolError(
        'internal',
        `Dimension "${opts.dimension}" is not implemented.`,
        { hint: `Supported: ${Object.keys(DIMENSION_SQL).join(', ')}.` }
      );
    }
    dimensionExpr = spec.sql;
    dimension = opts.dimension;
    if (spec.requiresJoin) joins.add(spec.requiresJoin);
  }

  // ---- filters -----------------------------------------------------------
  const filterClauses: string[] = [];
  const appliedFilters: { column: string; value: string }[] = [];

  for (const [key, value] of Object.entries(opts.filters ?? {})) {
    const spec = FILTER_SQL[key];
    if (!spec) {
      throw new McpToolError('unknown_dimension', `Unknown filter column "${key}".`, {
        hint: `Filterable columns: ${Object.keys(FILTER_SQL).join(', ')}.`,
        didYouMean: closestMatches(key, Object.keys(FILTER_SQL)),
      });
    }
    if (typeof value !== 'string' || value.length > 200) {
      throw new McpToolError('invalid_argument', `Filter value for "${key}" must be a string under 200 characters.`);
    }
    // spec.sql is a constant we wrote; `value` is bound. Neither the column
    // name nor the value the model supplied is concatenated as SQL text.
    filterClauses.push(`AND ${spec.sql} = ${push(value)}`);
    appliedFilters.push({ column: key, value });
    if (spec.requiresJoin) joins.add(spec.requiresJoin);
  }

  // ---- substitute --------------------------------------------------------
  let sql = definition.sql_template;

  const bucketParam = push(range.bucket);
  const tzParam = push(range.timezone);
  const fromParam = push(range.fromUtc.toISOString());
  const toParam = push(range.toUtc.toISOString());

  sql = sql
    .split('{{BUCKET}}').join(bucketParam)
    .split('{{TZ}}').join(tzParam)
    .split('{{FROM}}').join(`${fromParam}::timestamptz`)
    .split('{{TO}}').join(`${toParam}::timestamptz`)
    .split('{{DIM}}').join(dimensionExpr)
    .split('{{FILTERS}}').join(filterClauses.join('\n     '));

  if (sql.includes('{{EVENT_NAMES}}')) {
    if (eventNames.length === 0) {
      // Should be unreachable: callers check `not_tracked` before building.
      throw new McpToolError(
        'not_tracked',
        `Metric "${definition.metric_key}" needs an event this organization does not track.`
      );
    }
    sql = sql.split('{{EVENT_NAMES}}').join(`${push(eventNames)}::text[]`);
  }

  // ---- joins --------------------------------------------------------------
  // Injected against the alias the template actually uses. LEFT JOIN, so a
  // user with no profile row still contributes to the total under '(unknown)'
  // rather than vanishing from the count.
  if (joins.has('user_profiles_via_events')) {
    if (/\bFROM\s+events\s+e\b/i.test(sql)) {
      sql = sql.replace(
        /\bFROM\s+events\s+e\b/i,
        'FROM events e LEFT JOIN user_profiles up ON up.user_id = e.user_id'
      );
    } else if (/\bFROM\s+orders\s+o\b/i.test(sql)) {
      sql = sql.replace(
        /\bFROM\s+orders\s+o\b/i,
        'FROM orders o LEFT JOIN user_profiles up ON up.user_id = o.user_id'
      );
    } else if (/\bFROM\s+user_profiles\s+u\b/i.test(sql)) {
      sql = sql.replace(/\bup\./g, 'u.');
    }
  }

  // Guard against a template that still has an unfilled placeholder. That
  // would be a silent correctness bug, so it must be loud.
  const leftover = /\{\{[A-Z_]+\}\}/.exec(sql);
  if (leftover) {
    throw new McpToolError('internal', `Metric template has an unresolved placeholder ${leftover[0]}.`);
  }

  // Ordering and the row cap are appended here rather than stored in each
  // template, so every metric gets them and none can forget.
  sql = `${sql.trim()}\nORDER BY 1, 2\nLIMIT 5000`;

  return { sql, params, dimension, appliedFilters };
}

export function describeDimensions(): { name: string; description: string }[] {
  return Object.entries(DIMENSION_SQL).map(([name, spec]) => ({
    name,
    description: spec.description,
  }));
}

export const FILTERABLE_COLUMNS = Object.keys(FILTER_SQL);
