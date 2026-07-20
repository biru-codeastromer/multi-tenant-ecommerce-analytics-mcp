/**
 * funnel. Ordered event list -> step-wise conversion.
 *
 * DESIGN DECISIONS worth knowing about, all surfaced in the response so a
 * model never has to guess which semantics it got:
 *
 * ORDERED, NOT JUST PRESENT. Step N only counts if it happened at or after
 * step N-1 for the same actor. Counting mere presence would report a user who
 * ordered on Monday and browsed on Tuesday as having converted on Tuesday.
 *
 * IDENTITY. Default actor is the stitched identity: user_id when known, and
 * otherwise the user_id linked to that anonymous_id if we have ever seen them
 * log in on that device. This answers the brief's question. Yes, a pre-login
 * session counts toward that user's funnel, because the alternative reports a
 * conversion whose first three steps are missing. `by: "session"` gives the
 * stricter within-one-session reading, and `by: "device"` ignores stitching.
 *
 * WINDOW. A step must follow the previous one within `window_hours` (default
 * 24h). Without a window, a visit in April and a purchase in July look like a
 * conversion.
 *
 * CANONICAL. Steps accept canonical concepts OR raw event names. Canonical is
 * preferred: it survives an org renaming an event mid-stream, which one of the
 * seeded orgs has actually done.
 */
import type { ToolDefinition } from './types.js';
import { McpToolError } from '../util/errors.js';
import { closestMatches } from '../util/render.js';
import { resolveRange } from '../util/time.js';

interface FunnelArgs {
  steps: string[];
  from?: string;
  to?: string;
  by?: 'user' | 'session' | 'device';
  window_hours?: number;
}

export const funnelTool: ToolDefinition<FunnelArgs> = {
  name: 'funnel',
  title: 'Funnel analysis',
  description:
    'Computes step-wise conversion through an ordered sequence of events. Each step must occur AFTER the previous one for the same actor and within a time window, so this measures real progression rather than co-occurrence. ' +
    'Steps accept canonical concepts (session_start, product_view, search, add_to_cart, checkout_start, order_complete) or your org\'s raw event names. Prefer canonical: it keeps working across event renames and is portable. ' +
    'by="user" (default) stitches anonymous activity to the user who later logged in on that device, so pre-login steps count. by="session" restricts the whole sequence to one session. by="device" uses the raw device id with no stitching. ' +
    'Returns per-step counts, step-to-step conversion, and overall conversion. If your org does not track one of the requested steps you get status "not_tracked" naming the step. Report that rather than a zero for that stage.',
  inputSchema: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        items: { type: 'string' },
        minItems: 2,
        maxItems: 6,
        description: 'Ordered steps, 2 to 6. Canonical concepts or raw event names.',
      },
      from: { type: 'string', description: 'Range start. Default 30 days ago.' },
      to: { type: 'string', description: 'Range end. Default today.' },
      by: {
        type: 'string',
        enum: ['user', 'session', 'device'],
        description: 'Actor to follow through the funnel. Default "user" (identity-stitched).',
      },
      window_hours: {
        type: 'number',
        description: 'Maximum hours between consecutive steps. Default 24, max 720.',
      },
    },
    required: ['steps'],
    additionalProperties: false,
  },

  async handler(args, ctx) {
    if (!Array.isArray(args.steps) || args.steps.length < 2) {
      throw new McpToolError('invalid_argument', 'At least 2 steps are required.', {
        hint: 'Example: steps: ["session_start", "product_view", "add_to_cart", "order_complete"]',
      });
    }
    if (args.steps.length > 6) {
      throw new McpToolError('invalid_argument', 'At most 6 steps are supported.');
    }

    const windowHours = Math.min(Math.max(args.window_hours ?? 24, 1), 720);
    const by = args.by ?? 'user';
    const range = resolveRange({
      from: args.from,
      to: args.to,
      timezone: ctx.tenant.reportingTimezone,
    });

    // ---- resolve each step to concrete event names ------------------------
    const { rows: registry } = await ctx.session.query<{
      event_name: string;
      canonical_name: string | null;
    }>('SELECT event_name, canonical_name FROM event_definitions WHERE is_active');

    const byCanonical = new Map<string, string[]>();
    const rawNames = new Set<string>();
    for (const r of registry) {
      rawNames.add(r.event_name);
      if (r.canonical_name) {
        byCanonical.set(r.canonical_name, [...(byCanonical.get(r.canonical_name) ?? []), r.event_name]);
      }
    }

    const resolvedSteps: { label: string; names: string[] }[] = [];
    const untracked: string[] = [];

    for (const step of args.steps) {
      if (byCanonical.has(step)) {
        resolvedSteps.push({ label: step, names: byCanonical.get(step)! });
      } else if (rawNames.has(step)) {
        resolvedSteps.push({ label: step, names: [step] });
      } else {
        untracked.push(step);
      }
    }

    if (untracked.length > 0) {
      return {
        status: 'not_tracked',
        summary: `${ctx.tenant.orgName} does not track: ${untracked.join(', ')}.`,
        assumptions: [
          `The funnel cannot be computed because ${untracked.length === 1 ? 'a step is' : 'steps are'} missing from this organization's taxonomy.`,
        ],
        data: null,
        meta: {
          untracked_steps: untracked,
          available_canonical_concepts: [...byCanonical.keys()].sort(),
          available_event_names: [...rawNames].sort(),
          did_you_mean: Object.fromEntries(
            untracked.map((u) => [u, closestMatches(u, [...byCanonical.keys(), ...rawNames])])
          ),
          guidance:
            'Report that this organization does not track the named step. Do NOT report zero conversion for it. That would assert users failed to convert, when in fact the event is simply not collected.',
        },
      };
    }

    // ---- actor expression --------------------------------------------------
    // For by="user", the stitched actor: the known user_id, else the user_id
    // that anonymous_id was later linked to, else the anonymous_id itself.
    // The LEFT JOIN pulls that link from identity_links.
    const actorExpr =
      by === 'session'
        ? 'e.session_id'
        : by === 'device'
          ? 'e.anonymous_id'
          : 'COALESCE(e.user_id, il.user_id, e.anonymous_id)';

    const actorJoin =
      by === 'user'
        ? `LEFT JOIN LATERAL (
             SELECT l.user_id FROM identity_links l
             WHERE l.anonymous_id = e.anonymous_id
             ORDER BY l.linked_at ASC LIMIT 1
           ) il ON e.user_id IS NULL`
        : '';

    // ---- ordered funnel ----------------------------------------------------
    // A single `base` CTE resolves the actor once, then one CTE per step reads
    // from it. Resolving the actor per step instead would mean repeating the
    // identity-stitching lateral join in every step: and, more immediately,
    // an alias defined in a JOIN cannot be referenced from that same JOIN's ON
    // clause, which is what the earlier per-step shape got wrong.
    //
    // Each step joins back to the previous step's actor and requires a
    // strictly later timestamp within the window. min(event_time) per actor
    // keeps it to one path rather than a combinatorial explosion.
    const params: unknown[] = [range.fromUtc.toISOString(), range.toUtc.toISOString()];
    const stepCtes: string[] = [
      `base AS (
         SELECT ${actorExpr} AS actor, e.event_name, e.event_time
         FROM events e
         ${actorJoin}
         WHERE e.event_time >= $1::timestamptz AND e.event_time < $2::timestamptz
           AND NOT e.clock_skew_flag
           AND ${actorExpr} IS NOT NULL
       )`,
    ];

    resolvedSteps.forEach((step, i) => {
      params.push(step.names);
      const p = `$${params.length}`;
      if (i === 0) {
        stepCtes.push(`
          s0 AS (
            SELECT b.actor, min(b.event_time) AS t
            FROM base b
            WHERE b.event_name = ANY(${p}::text[])
            GROUP BY 1
          )`);
      } else {
        stepCtes.push(`
          s${i} AS (
            SELECT prev.actor, min(b.event_time) AS t
            FROM s${i - 1} prev
            JOIN base b ON b.actor = prev.actor
            WHERE b.event_name = ANY(${p}::text[])
              AND b.event_time > prev.t
              AND b.event_time <= prev.t + make_interval(hours => ${windowHours})
            GROUP BY 1
          )`);
      }
    });

    const counts = resolvedSteps
      .map((_, i) => `(SELECT count(*) FROM s${i}) AS step_${i}`)
      .join(',\n             ');

    const sql = `
      WITH ${stepCtes.join(',')}
      SELECT ${counts}`;
    ctx.recordSql(sql);

    const { rows } = await ctx.session.query<Record<string, string>>(sql, params);
    const row = rows[0] ?? {};

    const stepResults = resolvedSteps.map((step, i) => {
      const count = Number(row[`step_${i}`] ?? 0);
      const prev = i === 0 ? count : Number(row[`step_${i - 1}`] ?? 0);
      return {
        step: i + 1,
        label: step.label,
        resolved_event_names: step.names,
        actors: count,
        // NULLIF on the denominator: a zero previous step yields null
        // ("cannot be computed"), never a division error and never a
        // misleading 0%.
        conversion_from_previous_pct:
          i === 0 ? null : prev === 0 ? null : Number(((count / prev) * 100).toFixed(2)),
        conversion_from_first_pct:
          Number(row.step_0 ?? 0) === 0
            ? null
            : Number(((count / Number(row.step_0)) * 100).toFixed(2)),
      };
    });

    const first = Number(row.step_0 ?? 0);
    const last = Number(row[`step_${resolvedSteps.length - 1}`] ?? 0);

    if (first === 0) {
      return {
        status: 'empty',
        summary: `No actors entered the funnel at step 1 ("${resolvedSteps[0]!.label}") between ${range.fromLocal} and ${range.toLocal}.`,
        assumptions: [
          `Range ${range.fromLocal}. ${range.toLocal} in ${range.timezone}.`,
          'A genuine zero for the period, not a query failure. Downstream steps are necessarily zero and their conversion rates are null (not computable), not 0%.',
        ],
        data: stepResults,
        meta: { by, window_hours: windowHours },
      };
    }

    const assumptions = [
      `Range ${range.fromLocal}. ${range.toLocal} (${range.description}) in ${range.timezone}.`,
      `Steps must occur in order, each within ${windowHours}h of the previous one.`,
      by === 'user'
        ? 'Actors are identity-stitched: anonymous activity is attributed to the user who later logged in on that device, so pre-login steps DO count toward that user\'s funnel.'
        : by === 'session'
          ? 'The entire sequence must occur within a single session. A user who returns the next day to buy is counted as dropped.'
          : 'Actors are raw device ids with no identity stitching. One user on two devices counts twice; a shared tablet counts many users as one.',
      'Clock-skewed events are excluded.',
    ];
    if (range.includesPartialBucket) {
      assumptions.push(
        'The range includes today, which is incomplete. Actors who entered the funnel today may still convert, so late-stage conversion is understated.'
      );
    }

    return {
      status: 'ok',
      summary: `${first.toLocaleString()} entered, ${last.toLocaleString()} completed. ${((last / first) * 100).toFixed(2)}% overall conversion across ${resolvedSteps.length} steps.`,
      assumptions,
      data: stepResults,
      meta: {
        by,
        window_hours: windowHours,
        overall_conversion_pct: Number(((last / first) * 100).toFixed(2)),
        biggest_dropoff_step:
          stepResults
            .filter((s) => s.conversion_from_previous_pct !== null)
            .sort((a, b) => (a.conversion_from_previous_pct ?? 100) - (b.conversion_from_previous_pct ?? 100))[0]
            ?.label ?? null,
        timezone: range.timezone,
      },
    };
  },
};
