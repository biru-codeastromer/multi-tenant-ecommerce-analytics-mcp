import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { tenantPool } from './pools.js';
import { TenantContextError } from '../util/errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The only handle a tool ever gets on the database. It exposes `query` and
 * nothing else — no access to the raw client, so no tool can issue its own
 * BEGIN/COMMIT or otherwise step outside the tenant transaction.
 */
export interface TenantSession {
  readonly orgId: string;
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<QueryResult<R>>;
}

/**
 * Runs `fn` inside a read-only transaction with the tenant context set.
 *
 * WHY IT IS SHAPED LIKE THIS
 * --------------------------
 * Supabase's transaction-mode pooler multiplexes many clients onto a smaller
 * set of real backends, and it hands a backend back to the pool at COMMIT.
 * Anything set at *session* scope survives that handoff and is inherited by
 * whoever gets the backend next.
 *
 *   SET app.current_org_id = '...'        -- session scope. LEAKS across tenants.
 *   SET LOCAL app.current_org_id = '...'  -- transaction scope. Safe.
 *
 * So the context is set with set_config(key, value, is_local => true), which is
 * the parameterisable form of SET LOCAL, inside an explicit transaction that
 * always ends. `tests/isolation.test.ts` drives this concurrently through a
 * deliberately tiny pool (max: 1) to force backend reuse and assert that Org B
 * never inherits Org A's context.
 *
 * set_config is used rather than string-interpolating into `SET LOCAL` because
 * SET does not accept bind parameters — the interpolated form would be an
 * injection site sitting directly on the tenant-selection path, which is the
 * last place in the system that should have one. The UUID is regex-validated
 * before it gets here as well; both, not either.
 *
 * READ-ONLY is declared on the transaction as well as on the role
 * (default_transaction_read_only) so a write attempt fails at the transaction
 * boundary even if the role grant were ever loosened.
 */
export async function withOrgSession<T>(
  orgId: string,
  fn: (session: TenantSession) => Promise<T>
): Promise<T> {
  if (!UUID_RE.test(orgId)) {
    // Should be unreachable: org_id always comes from a credential lookup that
    // returns a uuid column. Belt-and-braces against a future code path that
    // lets a string in from somewhere less trustworthy.
    throw new TenantContextError('Resolved organization id is not a valid UUID.');
  }

  const client: PoolClient = await tenantPool.connect();
  let opened = false;
  let poisoned = false;

  try {
    await client.query('BEGIN READ ONLY');
    opened = true;

    // Transaction-scoped, discarded automatically at COMMIT/ROLLBACK.
    //
    // Routed through set_tenant_context() rather than calling set_config()
    // directly because mcp_tenant no longer HOLDS execute on set_config — see
    // migration 0010. Before that migration a tenant could call set_config in
    // raw SQL and switch itself to another org mid-transaction, which was an
    // exploitable cross-tenant read. The wrapper also refuses to change a
    // context that is already established, so one transaction is permanently
    // one tenant.
    await client.query('SELECT public.set_tenant_context($1::uuid)', [orgId]);

    // Verify rather than assume. If a pooler quirk, a middleware, or a future
    // refactor meant the GUC did not take, we must fail closed here instead of
    // running the query with someone else's context still in place.
    const check = await client.query<{ org: string | null }>(
      'SELECT public.current_org_id()::text AS org'
    );
    if (check.rows[0]?.org !== orgId) {
      poisoned = true;
      throw new TenantContextError(
        'Tenant context failed to apply; refusing to execute the query.'
      );
    }

    const session: TenantSession = {
      orgId,
      query: (sql, params) => client.query(sql, params ? [...params] : undefined),
    };

    const result = await fn(session);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    if (opened) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection is already unusable; destroying it below is the fix.
        poisoned = true;
      }
    }
    throw err;
  } finally {
    // release(true) destroys the connection instead of returning it to the
    // pool. Used whenever we are not certain the backend is in a clean state:
    // a connection with unknown GUC residue must never serve another tenant.
    client.release(poisoned);
  }
}

/**
 * Opens a transaction with NO tenant context, purely to prove that the
 * deny-by-default path works. Used only by the isolation test suite; there is
 * no production caller and there should never be one.
 */
export async function withoutOrgSession<T>(
  fn: (session: Omit<TenantSession, 'orgId'>) => Promise<T>
): Promise<T> {
  const client = await tenantPool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const result = await fn({
      query: (sql, params) => client.query(sql, params ? [...params] : undefined),
    });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release(true);
  }
}
