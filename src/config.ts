import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`
    );
  }
  return v;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got "${raw}"`);
  }
  return n;
}

/**
 * A note on what is deliberately absent.
 *
 * There is no SUPABASE_SERVICE_ROLE_KEY, no SUPABASE_URL and no supabase-js
 * client anywhere in this project. The service role bypasses RLS entirely, so
 * a server holding it has no tenant isolation regardless of how many policies
 * exist. Every connection here is a plain Postgres connection as a role that
 * RLS actually applies to. `tests/isolation.test.ts` asserts this at runtime by
 * checking rolsuper/rolbypassrls on the connected role.
 */
export const config = {
  db: {
    /** Owner. Migrations, seed, discovery job, projections. Never the server. */
    ownerUrl: process.env.DATABASE_URL_OWNER ?? '',
    /** SELECT-only tenant role. Serves every analytics query. */
    tenantUrl: required('DATABASE_URL_TENANT'),
    /** Credential resolution + audit. Holds no table privileges. */
    authUrl: required('DATABASE_URL_AUTH'),
  },
  /** Mixed into the API key hash so a DB dump alone cannot verify guesses. */
  apiKeyPepper: required('API_KEY_PEPPER'),
  server: {
    port: intEnv('PORT', 8787),
    env: process.env.NODE_ENV ?? 'development',
    logLevel: process.env.LOG_LEVEL ?? 'info',
  },
  limits: {
    statementTimeoutMs: intEnv('STATEMENT_TIMEOUT_MS', 8000),
    /** Hard cap on rows returned to the model on every path, no exceptions. */
    maxRows: intEnv('MAX_ROWS_RETURNED', 500),
    ratePerMinute: intEnv('RATE_LIMIT_PER_MINUTE', 60),
    /** Guard against a wide result set blowing the model's context window. */
    maxResponseChars: intEnv('MAX_RESPONSE_CHARS', 60_000),
  },
  isProduction: (process.env.NODE_ENV ?? 'development') === 'production',
} as const;

export function ownerUrlOrThrow(): string {
  if (!config.db.ownerUrl) {
    throw new Error('DATABASE_URL_OWNER is required for this operation (migrate/seed/discover).');
  }
  return config.db.ownerUrl;
}
