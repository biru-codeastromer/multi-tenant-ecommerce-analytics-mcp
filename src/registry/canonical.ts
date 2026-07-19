/**
 * Canonical event resolution.
 *
 * The mechanism that makes one question answerable across five incompatible
 * taxonomies. `session_start` resolves to:
 *   Nordvik   -> ['app_open']
 *   FreshCart -> ['website_open']
 *   BazaarHub -> ['app_open', 'website_open', 'kiosk_open']
 *
 * THE IMPORTANT CASE is the org that maps NOTHING to a requested concept.
 * Aurelia has no search event at all. "How many searches yesterday?" must
 * answer "this organization does not track search", never "0". Those are
 * different claims: one is information about the taxonomy, the other is a
 * factual assertion about user behaviour that happens to be false.
 *
 * Returning zero there would be the single most damaging bug in the system,
 * because it is invisible — the number looks like an answer. So resolution
 * returns a discriminated union and every caller must handle `not_tracked`.
 */
import type { TenantSession } from '../db/tenantSession.js';

export type CanonicalResolution =
  | { tracked: true; canonical: string; eventNames: string[] }
  | { tracked: false; canonical: string; reason: string; availableCanonicals: string[] };

export async function resolveCanonical(
  session: TenantSession,
  canonical: string
): Promise<CanonicalResolution> {
  const { rows } = await session.query<{ event_name: string }>(
    `SELECT event_name FROM event_definitions
     WHERE canonical_name = $1 AND is_active
     ORDER BY event_count_30d DESC, event_name`,
    [canonical]
  );

  if (rows.length > 0) {
    return { tracked: true, canonical, eventNames: rows.map((r) => r.event_name) };
  }

  // Include an inactive-event check so we can distinguish "never tracked" from
  // "tracked once, now silent" — a materially different answer for the user.
  const { rows: inactive } = await session.query<{ event_name: string; last_seen_at: string | null }>(
    `SELECT event_name, last_seen_at::text FROM event_definitions
     WHERE canonical_name = $1 AND NOT is_active
     ORDER BY last_seen_at DESC NULLS LAST`,
    [canonical]
  );

  const { rows: available } = await session.query<{ canonical_name: string }>(
    `SELECT DISTINCT canonical_name FROM event_definitions
     WHERE canonical_name IS NOT NULL AND is_active
     ORDER BY canonical_name`
  );

  const reason =
    inactive.length > 0
      ? `This organization used to track "${canonical}" via ${inactive
          .map((i) => i.event_name)
          .join(', ')}, but it last fired on ${inactive[0]?.last_seen_at?.slice(0, 10) ?? 'an unknown date'} and is now inactive.`
      : `This organization does not track "${canonical}". No event in its taxonomy maps to that concept.`;

  return {
    tracked: false,
    canonical,
    reason,
    availableCanonicals: available.map((r) => r.canonical_name),
  };
}

/** Resolves several canonical concepts, reporting which are missing. */
export async function resolveCanonicalSet(
  session: TenantSession,
  canonicals: string[]
): Promise<{
  resolved: Map<string, string[]>;
  missing: { canonical: string; reason: string }[];
  availableCanonicals: string[];
}> {
  const resolved = new Map<string, string[]>();
  const missing: { canonical: string; reason: string }[] = [];
  let available: string[] = [];

  for (const c of canonicals) {
    const r = await resolveCanonical(session, c);
    if (r.tracked) {
      resolved.set(c, r.eventNames);
    } else {
      missing.push({ canonical: c, reason: r.reason });
      available = r.availableCanonicals;
    }
  }

  return { resolved, missing, availableCanonicals: available };
}
