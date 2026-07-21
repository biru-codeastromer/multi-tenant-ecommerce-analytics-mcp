/**
 * query_metric. The primary analytics tool.
 *
 * Resolution order, and why it is this order:
 *   1. metric definition, org override shadowing the global default
 *   2. canonical events the metric needs -> this org's real event names
 *   3. if the org tracks none of them: `not_tracked`, NOT zero
 *   4. build, bind, execute inside the tenant transaction
 *   5. flag the partial trailing bucket, split by currency, state assumptions
 */
import type { ToolDefinition } from './types.js';
import { McpToolError } from '../util/errors.js';
import { capPayload, closestMatches, formatMinor } from '../util/render.js';
import { resolveRange, markPartialBuckets, VALID_BUCKETS } from '../util/time.js';
import { resolveCanonicalSet } from '../registry/canonical.js';
import { buildMetricQuery, type MetricDefinition } from '../metrics/build.js';
import { config } from '../config.js';

interface QueryMetricArgs {
  metric: string;
  from?: string;
  to?: string;
  bucket?: string;
  dimension?: string;
  filters?: Record<string, string>;
}

export const queryMetricTool: ToolDefinition<QueryMetricArgs> = {
  name: 'query_metric',
  requiredScope: 'read:analytics',
  title: 'Query a metric',
  description:
    'Computes a named metric as a time series, optionally broken down by one dimension and filtered. THIS IS THE TOOL TO REACH FOR FIRST for any "how many / how much / what is my rate" question. ' +
    'Metrics encode YOUR organization\'s definitions. For example whether an "order" means placed or delivered, which differs between orgs and is not something to assume. The definition used is returned with every result, so state it when you answer. ' +
    'Dates accept YYYY-MM-DD or the keywords today, yesterday, this_week, last_week, this_month, last_month, last_7_days, last_30_days, last_90_days, and are always interpreted in your org\'s reporting timezone, not UTC. ' +
    'Available metric keys are listed in the schema context; call get_schema_context if you do not have them. ' +
    'Monetary metrics return integer MINOR units (paise/cents) split by currency and must never be summed across currencies. ' +
    'A result of status "not_tracked" means your organization does not collect the underlying event. Report that, do not report zero.',
  inputSchema: {
    type: 'object',
    properties: {
      metric: {
        type: 'string',
        description:
          'Metric key, e.g. orders_count, revenue, aov, unique_sessions, sessions_started, product_views, searches, add_to_cart, conversion_rate, active_users, new_users, cancelled_orders.',
      },
      from: { type: 'string', description: 'Start of range: YYYY-MM-DD or a keyword. Defaults to 30 days ago.' },
      to: { type: 'string', description: 'End of range, inclusive of the named day: YYYY-MM-DD or a keyword. Defaults to today.' },
      bucket: {
        type: 'string',
        enum: VALID_BUCKETS,
        description: 'Time granularity. Default day. Hourly is limited to 14-day ranges.',
      },
      dimension: {
        type: 'string',
        description:
          'Optional single breakdown, e.g. platform, channel, city, acquisition_source, status, currency, coupon_code. Only dimensions listed for that metric are accepted; the error names the valid ones.',
      },
      filters: {
        type: 'object',
        description:
          'Optional equality filters, e.g. {"channel":"search","platform":"ios"}. Values must match exactly; use describe_event or list_events to find real values.',
        additionalProperties: { type: 'string' },
      },
    },
    required: ['metric'],
    additionalProperties: false,
  },

  async handler(args, ctx) {
    if (!args.metric || typeof args.metric !== 'string') {
      throw new McpToolError('invalid_argument', 'metric is required.');
    }

    // -- 1. resolve the definition, org override winning ---------------------
    const { rows: defs } = await ctx.session.query<MetricDefinition>(
      `SELECT DISTINCT ON (metric_key)
              metric_key, display_name, description, unit, sql_template,
              allowed_dimensions, requires_canonical, notes,
              (org_id IS NOT NULL) AS is_override
       FROM metric_definitions
       WHERE metric_key = $1
       ORDER BY metric_key, org_id NULLS LAST`,
      [args.metric]
    );

    const def = defs[0];
    if (!def) {
      const { rows: all } = await ctx.session.query<{ metric_key: string }>(
        'SELECT DISTINCT metric_key FROM metric_definitions ORDER BY metric_key'
      );
      const keys = all.map((r) => r.metric_key);
      throw new McpToolError('unknown_metric', `No metric named "${args.metric}".`, {
        hint: `Available metrics: ${keys.join(', ')}.`,
        didYouMean: closestMatches(args.metric, keys),
      });
    }

    // -- 2/3. canonical resolution, and the honest not-tracked answer --------
    const { resolved, missing, availableCanonicals } = await resolveCanonicalSet(
      ctx.session,
      def.requires_canonical
    );

    if (missing.length > 0) {
      return {
        status: 'not_tracked',
        summary: `${ctx.tenant.orgName} does not track the data "${def.metric_key}" needs.`,
        assumptions: missing.map((m) => m.reason),
        data: null,
        meta: {
          metric: def.metric_key,
          missing_concepts: missing.map((m) => m.canonical),
          concepts_this_org_does_track: availableCanonicals,
          guidance:
            'Report that this organization does not track this. Do NOT report zero. Zero would assert that the behaviour did not happen, which is a different and unsupported claim.',
        },
      };
    }

    const eventNames = [...new Set([...resolved.values()].flat())];

    // -- 4. range + build ----------------------------------------------------
    const range = resolveRange({
      from: args.from,
      to: args.to,
      bucket: args.bucket,
      timezone: ctx.tenant.reportingTimezone,
    });

    const built = buildMetricQuery({
      definition: def,
      range,
      eventNames,
      dimension: args.dimension,
      filters: args.filters,
    });

    ctx.recordSql(built.sql);

    const { rows } = await ctx.session.query<{
      bucket_start: string;
      dim_value: string | null;
      metric_value: string | null;
      currency: string | null;
      is_partial?: boolean;
    }>(built.sql, built.params);

    // -- 5. post-processing ---------------------------------------------------
    const flagged = markPartialBuckets(rows, range);
    const capped = capPayload(flagged, config.limits.maxRows);

    const assumptions: string[] = [
      `Range resolved to ${range.fromLocal}. ${range.toLocal} (${range.description}) in ${range.timezone}.`,
    ];
    if (def.notes) assumptions.push(def.notes);
    if (def.is_override) {
      assumptions.push(
        `This metric uses ${ctx.tenant.orgName}'s own definition, which differs from the platform default. State that when reporting the number.`
      );
    }
    if (range.includesPartialBucket) {
      assumptions.push(
        `The final ${range.bucket} is INCOMPLETE (is_partial: true) and will keep rising. Do not compare it like-for-like with completed ${range.bucket}s or read it as a decline.`
      );
    }
    if (eventNames.length > 1) {
      assumptions.push(
        `Resolved through ${eventNames.length} event names for this org: ${eventNames.join(', ')}.`
      );
    }

    const currencies = [...new Set(rows.map((r) => r.currency).filter(Boolean))] as string[];
    if (currencies.length > 1) {
      assumptions.push(
        `Results span ${currencies.length} currencies (${currencies.join(', ')}). Rows are per-currency and MUST NOT be added together. No conversion rate is available on this server.`
      );
    }

    // Late-arriving events mean recent days are provisional. Only mentioned
    // when the range actually includes the affected window.
    const rangeTouchesRecent = range.toUtc.getTime() > Date.now() - 5 * 86400_000;
    if (rangeTouchesRecent) {
      assumptions.push(
        'Buckets are keyed on event_time (when it happened). Offline mobile clients can flush queued events up to ~4 days late, so the most recent days may still increase.'
      );
    }

    if (rows.length === 0) {
      return {
        status: 'empty',
        summary: `No data for "${def.display_name}" between ${range.fromLocal} and ${range.toLocal}.`,
        assumptions: [
          ...assumptions,
          'This is a genuine zero for the period, not a failed query. The events exist in this org\'s taxonomy; none occurred in this window with these filters.',
        ],
        data: [],
        meta: {
          metric: def.metric_key,
          definition: def.description,
          unit: def.unit,
          resolved_event_names: eventNames,
          filters_applied: built.appliedFilters,
        },
      };
    }

    const total = rows.reduce((s, r) => s + Number(r.metric_value ?? 0), 0);
    const isMoney = def.unit === 'currency_minor';

    return {
      status: 'ok',
      summary:
        `${def.display_name}: ${capped.rows.length} ${range.bucket} bucket${capped.rows.length === 1 ? '' : 's'}` +
        (isMoney
          ? ` across ${currencies.length || 1} currenc${currencies.length === 1 ? 'y' : 'ies'}.`
          : `, total ${total.toLocaleString('en-US', { maximumFractionDigits: 4 })}.`),
      assumptions,
      data: capped.rows,
      ...(capped.truncation ? { truncation: capped.truncation } : {}),
      meta: {
        metric: def.metric_key,
        display_name: def.display_name,
        definition: def.description,
        unit: def.unit,
        is_org_specific_definition: def.is_override,
        dimension: built.dimension,
        filters_applied: built.appliedFilters,
        resolved_event_names: eventNames,
        timezone: range.timezone,
        bucket: range.bucket,
        range: { from: range.fromLocal, to: range.toLocal, description: range.description },
        ...(isMoney
          ? {
              currencies,
              value_note: 'metric_value is INTEGER MINOR UNITS (divide by 100 for display).',
              totals_by_currency: currencies.map((c) => {
                const sum = rows.filter((r) => r.currency === c).reduce((s, r) => s + Number(r.metric_value ?? 0), 0);
                return { currency: c, total_minor: sum, display: formatMinor(sum, c) };
              }),
            }
          : { total: total }),
      },
    };
  },
};
