import { withOrgSession } from '../db/tenantSession.js';
import { generateOrgContext, type GeneratedContext, type OrgContextInput } from './context.js';

/**
 * Server-side cache for generated context payloads, keyed by
 * (org_id, registry_version_hash) exactly as the brief specifies.
 *
 * The version hash is the cache key rather than a TTL, which means:
 *   - a hit costs one cheap indexed read (the version lookup), not the six
 *     queries and the assembly pass that generating the payload costs;
 *   - a registry change invalidates immediately on the next request, because
 *     the key itself changed — there is no staleness window to reason about;
 *   - an org that never changes its taxonomy never regenerates.
 *
 * Answering README Q2 ("what happens when an org adds a new event tomorrow"):
 * the hourly discovery job observes the new name, auto-registers it, and
 * recomputes the org's version hash. The next request computes a different
 * cache key, misses, and regenerates — so the event appears in context within
 * one discovery cycle, labelled [UNDOCUMENTED] until a human writes a
 * description. No deploy, no restart, no manual invalidation.
 *
 * Bounded to avoid unbounded growth at 50+ orgs: entries are evicted
 * least-recently-used past MAX_ENTRIES. Per-process, which is correct here —
 * two replicas each generating once on a registry change is cheaper and far
 * simpler than a shared cache, and the payload is deterministic so replicas
 * cannot disagree.
 */
const MAX_ENTRIES = 200;

interface CacheEntry {
  context: GeneratedContext;
  lastAccess: number;
}

const cache = new Map<string, CacheEntry>();

let hits = 0;
let misses = 0;

function evictIfNeeded(): void {
  if (cache.size <= MAX_ENTRIES) return;
  const entries = [...cache.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  const toRemove = cache.size - MAX_ENTRIES;
  for (let i = 0; i < toRemove; i++) cache.delete(entries[i]![0]);
}

/**
 * Reads the org's current registry version, then returns the cached payload if
 * one exists for that exact version. Both the version read and any
 * regeneration happen inside the SAME tenant transaction, so the version and
 * the data it describes cannot skew apart mid-generation.
 */
export async function getOrgContext(
  orgId: string,
  org: OrgContextInput
): Promise<{ context: GeneratedContext; cached: boolean }> {
  return withOrgSession(orgId, async (session) => {
    const { rows } = await session.query<{ version_hash: string }>(
      'SELECT version_hash FROM registry_version'
    );
    const version = rows[0]?.version_hash ?? 'unversioned';
    const key = `${orgId}:${version}`;

    const existing = cache.get(key);
    if (existing) {
      existing.lastAccess = Date.now();
      hits++;
      return { context: existing.context, cached: true };
    }

    misses++;
    const context = await generateOrgContext(session, org);
    cache.set(key, { context, lastAccess: Date.now() });
    evictIfNeeded();
    return { context, cached: false };
  });
}

export function cacheStats(): { size: number; hits: number; misses: number; hitRate: number } {
  const total = hits + misses;
  return { size: cache.size, hits, misses, hitRate: total ? hits / total : 0 };
}

/** Test hook only. */
export function clearContextCache(): void {
  cache.clear();
  hits = 0;
  misses = 0;
}
