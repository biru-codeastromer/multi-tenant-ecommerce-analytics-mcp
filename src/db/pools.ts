import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Type parsing.
//
// node-postgres hands back bigint (int8) and numeric as strings to avoid
// silent precision loss. That is the right default and we keep it: money is
// stored as bigint minor units and a JS number would start lying at 2^53.
// Conversion to a display value happens once, explicitly, in the formatting
// layer. Never implicitly here.
//
// timestamptz IS parsed to Date. timestamp (no zone) is NOT: the metric
// templates return local wall-clock timestamps that have already been shifted
// into the org's zone, and letting node-postgres reinterpret those in the
// server's local zone is exactly the bug that makes "yesterday" off by a day.
// ---------------------------------------------------------------------------
const TIMESTAMP_WITHOUT_TZ_OID = 1114;
pg.types.setTypeParser(TIMESTAMP_WITHOUT_TZ_OID, (v: string) => v);

function makePool(connectionString: string, opts: { max: number; name: string }): pg.Pool {
  const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);
  const pool = new Pool({
    connectionString,
    max: opts.max,
    // Supabase's free tier has a low direct-connection ceiling. Short idle
    // timeouts return connections to the pooler quickly rather than squatting.
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    // Fail fast rather than hanging a request behind a dead backend.
    statement_timeout: config.limits.statementTimeoutMs,
    query_timeout: config.limits.statementTimeoutMs + 1_000,
    application_name: `zyaro-mcp/${opts.name}`,
    // TLS: local Docker speaks plaintext (no ssl). A remote host (Supabase)
    // requires TLS, but its transaction pooler (Supavisor) presents a
    // certificate that is not in Node's default CA bundle, so verification
    // with rejectUnauthorized:true fails with "self-signed certificate in
    // certificate chain" and every query dies. The connection is still
    // encrypted; what is turned off is CA verification of the server identity.
    // This matches how Supabase's own connection strings behave (sslmode=require).
    // Setting DB_SSL_STRICT=true opts back into full verification for a host
    // whose CA you have pinned into Node (e.g. via NODE_EXTRA_CA_CERTS).
    ssl: isLocal
      ? undefined
      : { rejectUnauthorized: process.env.DB_SSL_STRICT === 'true' },
  });

  pool.on('error', (err) => {
    // An idle client erroring must not take the process down.
    console.error(JSON.stringify({ level: 'error', pool: opts.name, msg: 'idle client error', err: err.message }));
  });

  return pool;
}

/**
 * The pool that serves tenant analytics queries. Connects as `mcp_tenant`:
 * SELECT-only, owns nothing, NOBYPASSRLS. Every query through it runs inside
 * withOrgSession().
 *
 * On Supabase this should point at the TRANSACTION pooler (port 6543).
 */
export const tenantPool = makePool(config.db.tenantUrl, { max: 8, name: 'tenant' });

/**
 * Credential resolution, audit writes, rate limiting. Connects as `mcp_auth`,
 * which holds zero table privileges and can only EXECUTE four SECURITY DEFINER
 * functions. Separate from the tenant pool so the connection that runs
 * model-influenced SQL is structurally unable to reach api_credentials.
 */
export const authPool = makePool(config.db.authUrl, { max: 4, name: 'auth' });

export async function closePools(): Promise<void> {
  await Promise.allSettled([tenantPool.end(), authPool.end()]);
}
