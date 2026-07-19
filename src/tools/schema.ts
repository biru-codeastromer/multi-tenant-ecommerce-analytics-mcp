/**
 * Schema/registry tools: get_schema_context, list_events, describe_event.
 *
 * Tool DESCRIPTIONS are prompt surface and are written accordingly — assume
 * the model has never seen this database, because it hasn't. Each one says
 * what the tool returns, when to prefer it over an alternative, and what the
 * common mistake is.
 */
import type { ToolDefinition } from './types.js';
import { getOrgContext, cacheStats } from '../registry/contextCache.js';
import { McpToolError } from '../util/errors.js';
import { capPayload, closestMatches } from '../util/render.js';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
export const getSchemaContextTool: ToolDefinition<{ refresh?: boolean }> = {
  name: 'get_schema_context',
  title: 'Get schema context',
  description:
    'Returns the complete data dictionary for your organization: its actual event names (which differ from every other org), how those names map to cross-org canonical concepts, event properties with types and enum values, the analytics tables and their join keys, available metrics with THIS org\'s definitions, known data-quality problems, and worked question->SQL examples. ' +
    'This is the same content delivered in the MCP initialize instructions, so you normally already have it — call this only if you did not receive it, if you suspect it is stale, or if a section was omitted for size. ' +
    'Read this before writing any SQL: event names are org-specific and guessing them is the most common cause of an empty result.',
  inputSchema: {
    type: 'object',
    properties: {
      refresh: {
        type: 'boolean',
        description:
          'Bypass the server-side cache. Rarely needed — the cache is keyed on a registry version hash and invalidates itself when the schema changes.',
      },
    },
    additionalProperties: false,
  },
  async handler(_args, ctx) {
    const { context, cached } = await getOrgContext(ctx.tenant.orgId, {
      orgName: ctx.tenant.orgName,
      orgSlug: ctx.tenant.orgSlug,
      timezone: ctx.tenant.reportingTimezone,
      currency: ctx.tenant.defaultCurrency,
    });

    return {
      status: 'ok',
      summary: `Data dictionary for ${ctx.tenant.orgName} (~${context.approxTokens} tokens, registry ${context.versionHash.slice(0, 8)}).`,
      data: { context: context.text },
      meta: {
        cached,
        registry_version: context.versionHash,
        approx_tokens: context.approxTokens,
        timezone: ctx.tenant.reportingTimezone,
        default_currency: ctx.tenant.defaultCurrency,
        cache_stats: cacheStats(),
      },
    };
  },
};

// ---------------------------------------------------------------------------
interface ListEventsArgs {
  category?: string;
  include_inactive?: boolean;
  canonical?: string;
}

export const listEventsTool: ToolDefinition<ListEventsArgs> = {
  name: 'list_events',
  title: 'List events',
  description:
    'Lists the event names your organization actually fires, with category, canonical mapping, 30-day volume, and when each was last seen. ' +
    'Use this to discover the correct event name before filtering on one — names are org-specific (one org fires app_open, another website_open, another all of app_open, website_open and kiosk_open). ' +
    'Events silent for more than 180 days are hidden unless include_inactive is set. Events marked undocumented were auto-discovered from traffic and have no human description, so treat their meaning as inferred.',
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['lifecycle', 'discovery', 'commerce', 'engagement', 'uncategorised'],
        description: 'Filter to one category.',
      },
      canonical: {
        type: 'string',
        description:
          'Filter to events mapping to one canonical concept, e.g. session_start, product_view, search, add_to_cart, checkout_start, order_complete.',
      },
      include_inactive: {
        type: 'boolean',
        description: 'Include events that stopped firing more than 180 days ago. Default false.',
      },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (!args.include_inactive) conditions.push('is_active');
    if (args.category) {
      params.push(args.category);
      conditions.push(`category = $${params.length}`);
    }
    if (args.canonical) {
      params.push(args.canonical);
      conditions.push(`canonical_name = $${params.length}`);
    }

    const sql = `
      SELECT event_name, display_name, description, category, canonical_name,
             event_count_30d::int AS volume_30d, is_active,
             first_seen_at::date::text AS first_seen,
             last_seen_at::date::text  AS last_seen,
             auto_registered, quality_note
      FROM event_definitions
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY is_active DESC, event_count_30d DESC, event_name
      LIMIT 200`;
    ctx.recordSql(sql);

    const { rows } = await ctx.session.query(sql, params);

    if (rows.length === 0) {
      // Empty because a filter matched nothing, not because the org has no
      // events. Say which, and offer the valid values.
      const { rows: all } = await ctx.session.query<{ canonical_name: string | null; category: string }>(
        'SELECT DISTINCT canonical_name, category FROM event_definitions WHERE is_active'
      );
      const canonicals = [...new Set(all.map((r) => r.canonical_name).filter(Boolean))] as string[];
      const categories = [...new Set(all.map((r) => r.category))];

      return {
        status: 'empty',
        summary: args.canonical
          ? `No active event maps to the canonical concept "${args.canonical}". This organization does not track it.`
          : 'No events matched those filters.',
        assumptions: [],
        data: [],
        meta: {
          available_canonical_concepts: canonicals,
          available_categories: categories,
          note:
            'This is a real absence, not a query failure. If you asked about a concept in available_canonical_concepts, retry with that exact value.',
        },
      };
    }

    const undocumented = rows.filter((r) => (r as { auto_registered: boolean; description: string | null }).auto_registered && !(r as { description: string | null }).description);

    return {
      status: 'ok',
      summary: `${rows.length} event${rows.length === 1 ? '' : 's'} for ${ctx.tenant.orgName}${undocumented.length ? `, ${undocumented.length} undocumented` : ''}.`,
      data: rows,
      meta: {
        timezone: ctx.tenant.reportingTimezone,
        undocumented_events: undocumented.map((r) => (r as { event_name: string }).event_name),
      },
    };
  },
};

// ---------------------------------------------------------------------------
export const describeEventTool: ToolDefinition<{ event_name: string }> = {
  name: 'describe_event',
  title: 'Describe event',
  description:
    'Returns the full property schema for one event: every property key, its inferred data type, how often it is present, cardinality, sample values, and the complete enum when cardinality is low. ' +
    'Call this before filtering or grouping on a property so you use the right key and a value that actually occurs. ' +
    'Pay attention to properties flagged with a type conflict — the same key arrives as both a number and a string on those, and a direct ::numeric cast will error on some rows. Use jsonb_to_numeric(properties->\'key\') instead. ' +
    'Properties flagged as PII have their sample values withheld and are masked in query results.',
  inputSchema: {
    type: 'object',
    properties: {
      event_name: {
        type: 'string',
        description: "The exact event name as your org fires it. Get it from list_events if unsure.",
      },
    },
    required: ['event_name'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    if (!args.event_name || typeof args.event_name !== 'string') {
      throw new McpToolError('invalid_argument', 'event_name is required.');
    }

    const { rows: eventRows } = await ctx.session.query<{
      event_name: string; display_name: string | null; description: string | null;
      category: string; canonical_name: string | null; is_active: boolean;
      volume_30d: number; first_seen: string | null; last_seen: string | null;
      auto_registered: boolean; quality_note: string | null;
    }>(
      `SELECT event_name, display_name, description, category, canonical_name, is_active,
              event_count_30d::int AS volume_30d,
              first_seen_at::date::text AS first_seen,
              last_seen_at::date::text  AS last_seen,
              auto_registered, quality_note
       FROM event_definitions WHERE event_name = $1`,
      [args.event_name]
    );

    const event = eventRows[0];
    if (!event) {
      // The self-correction path. A bare "unknown event" costs the model four
      // more turns of guessing; naming the closest real options costs one.
      const { rows: candidates } = await ctx.session.query<{ event_name: string }>(
        'SELECT event_name FROM event_definitions WHERE is_active ORDER BY event_count_30d DESC'
      );
      const names = candidates.map((r) => r.event_name);
      throw new McpToolError(
        'unknown_event',
        `"${args.event_name}" is not an event in this organization's taxonomy.`,
        {
          hint: `This org fires: ${names.slice(0, 12).join(', ')}${names.length > 12 ? `, +${names.length - 12} more` : ''}. Event names are org-specific.`,
          didYouMean: closestMatches(args.event_name, names),
        }
      );
    }

    const sql = `
      SELECT property_key, data_type, description, is_required,
             round(occurrence_rate * 100, 1)::text AS present_pct,
             distinct_value_count::int AS distinct_values,
             sample_values, enum_values, is_pii,
             has_type_conflict, observed_types
      FROM event_property_definitions
      WHERE event_name = $1
      ORDER BY is_required DESC, occurrence_rate DESC NULLS LAST, property_key`;
    ctx.recordSql(sql);

    const { rows: props } = await ctx.session.query(sql, [args.event_name]);
    const capped = capPayload(props, config.limits.maxRows);

    const conflicts = props.filter((p) => (p as { has_type_conflict: boolean }).has_type_conflict);
    const assumptions: string[] = [];
    if (conflicts.length) {
      assumptions.push(
        `${conflicts.length} propert${conflicts.length === 1 ? 'y has' : 'ies have'} mixed JSON types across rows. Use public.jsonb_to_numeric(properties->'key') rather than a direct cast.`
      );
    }
    if (event.auto_registered && !event.description) {
      assumptions.push(
        'This event was auto-discovered from traffic and has no human-written description. Its meaning is inferred from its name.'
      );
    }
    if (event.quality_note) assumptions.push(event.quality_note);

    return {
      status: props.length === 0 ? 'empty' : 'ok',
      summary:
        props.length === 0
          ? `Event "${event.event_name}" exists but carries no properties.`
          : `"${event.event_name}" has ${props.length} propert${props.length === 1 ? 'y' : 'ies'}.`,
      assumptions,
      data: { event, properties: capped.rows },
      ...(capped.truncation ? { truncation: capped.truncation } : {}),
      meta: { canonical_name: event.canonical_name, is_active: event.is_active },
    };
  },
};
