import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { authPool } from '../db/pools.js';
import { config } from '../config.js';
import { RateLimitError, UnauthorizedError } from '../util/errors.js';

export interface ResolvedTenant {
  credentialId: string;
  orgId: string;
  orgSlug: string;
  orgName: string;
  reportingTimezone: string;
  defaultCurrency: string;
  scopes: string[];
}

const KEY_PREFIX = 'zyk_';

/**
 * sha256(pepper || raw). The pepper lives in the server environment, never in
 * the database, so an attacker holding only a database dump cannot mount an
 * offline dictionary attack against the stored hashes.
 *
 * A plain hash rather than argon2/bcrypt is the right call here, and the
 * reasoning matters: slow KDFs exist to defend low-entropy human passwords.
 * These keys are 32 bytes of CSPRNG output. There is no dictionary to run, and
 * a slow KDF on the hot path of every single MCP request would buy nothing
 * while costing real latency. The security comes from the entropy.
 */
export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(config.apiKeyPepper).update(rawKey).digest('hex');
}

/** Generates a new key. The raw value is returned once and never stored. */
export function generateApiKey(orgSlug: string): { raw: string; hash: string; prefix: string } {
  const secret = randomBytes(32).toString('base64url');
  const raw = `${KEY_PREFIX}${orgSlug}_${secret}`;
  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, 12) };
}

/**
 * Extracts the bearer token. Accepts the Authorization header (the MCP-native
 * path) and falls back to X-API-Key for clients that cannot set Authorization.
 *
 * Note what is NOT accepted: a query-string parameter. Credentials in URLs end
 * up in access logs, proxy logs and browser history.
 */
export function extractApiKey(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = headers['authorization'] ?? headers['Authorization'];
  const authStr = Array.isArray(auth) ? auth[0] : auth;
  if (authStr && /^Bearer\s+/i.test(authStr)) {
    const token = authStr.replace(/^Bearer\s+/i, '').trim();
    if (token) return token;
  }

  const apiKey = headers['x-api-key'] ?? headers['X-API-Key'];
  const keyStr = Array.isArray(apiKey) ? apiKey[0] : apiKey;
  return keyStr?.trim() || null;
}

/**
 * Resolves a raw API key to a tenant.
 *
 * There is no cache. That is a conscious latency-for-correctness trade: the
 * brief requires revocation to take effect immediately rather than at next
 * restart, and any cache. Even a 30-second one: is a window in which a
 * revoked key still works. The lookup is a single indexed equality probe on a
 * partial index over non-revoked keys, so it costs well under a millisecond.
 * If it ever became the bottleneck, the correct fix is a cache with an
 * explicit revocation-event invalidation channel, not a TTL.
 */
export async function resolveCredential(rawKey: string): Promise<ResolvedTenant> {
  if (!rawKey || rawKey.length < 16 || rawKey.length > 200) {
    throw new UnauthorizedError();
  }

  const keyHash = hashApiKey(rawKey);

  const { rows } = await authPool.query<{
    credential_id: string;
    org_id: string;
    org_slug: string;
    org_name: string;
    reporting_timezone: string;
    default_currency: string;
    scopes: string[];
  }>('SELECT * FROM public.auth_resolve_credential($1)', [keyHash]);

  const row = rows[0];
  if (!row) {
    // Identical error for "no such key" and "key was revoked". Distinguishing
    // them would confirm to an attacker that a guessed key once existed.
    throw new UnauthorizedError();
  }

  // The SQL comparison already decided the outcome; this is a second, constant
  // -time confirmation so the code path does not depend on how the driver or
  // the index handled the comparison.
  const expected = Buffer.from(keyHash, 'hex');
  const actual = Buffer.from(hashApiKey(rawKey), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new UnauthorizedError();
  }

  return {
    credentialId: row.credential_id,
    orgId: row.org_id,
    orgSlug: row.org_slug,
    orgName: row.org_name,
    reportingTimezone: row.reporting_timezone,
    defaultCurrency: row.default_currency,
    scopes: row.scopes,
  };
}

/**
 * Fixed-window rate limit, enforced in the database.
 *
 * In the database and not in process memory because the server is meant to run
 * more than one replica: an in-memory counter would give a caller N times the
 * limit simply by having their requests land on different instances.
 */
export async function enforceRateLimit(credentialId: string): Promise<void> {
  const { rows } = await authPool.query<{ rate_limit_hit: number }>(
    'SELECT public.rate_limit_hit($1) AS rate_limit_hit',
    [credentialId]
  );
  const count = rows[0]?.rate_limit_hit ?? 0;
  if (count > config.limits.ratePerMinute) {
    throw new RateLimitError(config.limits.ratePerMinute);
  }
}

/** Fire-and-forget usage timestamp. Must never fail a request. */
export function touchCredential(credentialId: string): void {
  authPool
    .query('SELECT public.auth_touch_credential($1)', [credentialId])
    .catch(() => {
      /* best-effort bookkeeping */
    });
}
