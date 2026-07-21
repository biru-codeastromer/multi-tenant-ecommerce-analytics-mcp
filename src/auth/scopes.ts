/**
 * Credential scopes.
 *
 * A scope is the answer to "what may this key do", separate from "which org is
 * this key" (the tenant, resolved from the credential) and "what may this org
 * see" (RLS). Scopes let one organization hand out keys of different power:
 * a full key for its own analysts, and a restricted key it can embed in a
 * dashboard or share with a vendor without also granting the raw-SQL escape
 * hatch.
 *
 * Two scopes, deliberately few:
 *
 *   read:analytics : the semantic tools. get_schema_context, list_events,
 *                    describe_event, query_metric, funnel, top_n. These only
 *                    ever run curated, parameterised queries, so this is the
 *                    safe default every key holds.
 *
 *   read:raw_sql   : the run_sql escape hatch. Strictly additive power on top
 *                    of read:analytics: arbitrary (guarded, read-only) SELECTs.
 *                    A key without this scope cannot reach run_sql at all, and
 *                    run_sql is not even advertised to it in tools/list.
 *
 * This is a genuine security boundary and not decoration: a dashboard key that
 * holds only read:analytics can compute named metrics but cannot be coaxed,
 * by a prompt injection or otherwise, into running raw SQL. It is enforced in
 * one place (the MCP call handler) and asserted by tests/scopes.test.ts.
 *
 * The model is intentionally small. Per-metric or per-tool granularity is a
 * real product feature but a billing/onboarding concern more than a
 * correctness one, and is called out as future work rather than half-built.
 */

export const SCOPES = {
  ANALYTICS: 'read:analytics',
  RAW_SQL: 'read:raw_sql',
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

/** Every scope this server understands. Anything else on a key is inert. */
export const KNOWN_SCOPES: readonly string[] = Object.values(SCOPES);

/** The default set issued to a standard key. */
export const DEFAULT_SCOPES: readonly Scope[] = [SCOPES.ANALYTICS];

/** The full set issued to an unrestricted key. */
export const FULL_SCOPES: readonly Scope[] = [SCOPES.ANALYTICS, SCOPES.RAW_SQL];

export function hasScope(held: readonly string[], required: string): boolean {
  return held.includes(required);
}
