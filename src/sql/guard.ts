/**
 * SQL guard for the run_sql escape hatch.
 *
 * READ THIS FIRST: this guard is CONVENIENCE, NOT SECURITY.
 *
 * The security boundary is the database:
 *   - mcp_tenant holds SELECT and nothing else, on eleven tables and nothing else
 *   - FORCE ROW LEVEL SECURITY rewrites every scan with org_id = current_org_id()
 *   - the transaction is READ ONLY, and so is the role's default
 *   - statement_timeout is set on the role
 *
 * If this entire file were deleted and every string passed straight through,
 * a tenant still could not read another tenant's rows, write anything, or read
 * api_credentials. That is the property that matters, and it is enforced one
 * layer down where a regex cannot be talked out of it.
 *
 * What the guard actually buys is: better error messages than a permission
 * denied, protection against a model wasting a turn on a query that was never
 * going to run, and defence in depth against a future misconfiguration of the
 * layer that IS load-bearing. It is written to fail closed — anything it does
 * not positively recognise as a safe single SELECT is rejected.
 *
 * Deliberately NOT a full SQL parser. A hand-rolled parser would be a large
 * new attack surface protecting something already protected; a real one
 * (pgsql-parser) is a heavy native dependency. Pattern matching plus a
 * database that does not trust us is the right shape here.
 */
import { McpToolError } from '../util/errors.js';

export interface GuardResult {
  sql: string;
  /** True when the guard appended its own LIMIT. */
  limitApplied: boolean;
  appliedLimit: number;
}

/**
 * Strips comments and string literals so keyword matching cannot be fooled by
 * a keyword hidden inside a literal ('; DROP TABLE') or commented out.
 * Replaced with a placeholder rather than removed so token boundaries survive.
 */
function stripLiteralsAndComments(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    // line comment
    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    // block comment (nesting is legal in Postgres)
    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; continue; }
        if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; continue; }
        i++;
      }
      out += ' ';
      continue;
    }
    // single-quoted literal, '' escape
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      out += " 'L' ";
      continue;
    }
    // double-quoted identifier — preserved, it can legitimately be a column
    if (ch === '"') {
      out += ch;
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') { out += '""'; i += 2; continue; }
        if (sql[i] === '"') { out += '"'; i++; break; }
        out += sql[i];
        i++;
      }
      continue;
    }
    // dollar-quoted string: $tag$ ... $tag$
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        out += " 'L' ";
        continue;
      }
    }
    // E'' escape strings
    if ((ch === 'e' || ch === 'E') && next === "'") {
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Keyword denylist, applied to the literal-stripped text.
 *
 * Every entry here is ALSO impossible for mcp_tenant at the database level.
 * They are listed so the model gets a specific, self-correcting error instead
 * of a bare permission-denied, and so the intent is legible to a reviewer.
 */
const FORBIDDEN: { pattern: RegExp; reason: string }[] = [
  { pattern: /\b(insert|update|delete|truncate|merge)\b/i, reason: 'writes are not permitted; this connection is read-only' },
  { pattern: /\b(create|alter|drop|grant|revoke|comment\s+on|reindex|vacuum|analyze|cluster)\b/i, reason: 'DDL is not permitted' },
  { pattern: /\bset\s+role\b/i, reason: 'SET ROLE would attempt to change tenant identity' },
  { pattern: /\bset\s+session\s+authorization\b/i, reason: 'SET SESSION AUTHORIZATION would attempt to change tenant identity' },
  { pattern: /\bset\s+local\b/i, reason: 'session settings are managed by the server, not by queries' },
  // A bare SET could overwrite app.current_org_id. RLS would still hold (the
  // GUC is transaction-local and re-verified), but this must never be reachable.
  { pattern: /(^|[\s;(])set\s+[a-z_.]+\s*(=|to)\s/i, reason: 'session settings are managed by the server, not by queries' },
  { pattern: /\breset\b/i, reason: 'RESET would clear the tenant context' },
  { pattern: /\b(copy|\\copy)\b/i, reason: 'COPY can read or write the server filesystem' },
  { pattern: /\bpg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_logdir_ls\b/i, reason: 'filesystem access is not permitted' },
  { pattern: /\blo_import|lo_export\b/i, reason: 'large-object import/export touches the filesystem' },
  { pattern: /\bdblink|postgres_fdw|file_fdw|dblink_connect\b/i, reason: 'outbound connections are not permitted' },
  { pattern: /\bpg_sleep|pg_sleep_for|pg_sleep_until\b/i, reason: 'sleeping ties up a pooled connection' },
  { pattern: /\bpg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile\b/i, reason: 'administrative functions are not permitted' },
  { pattern: /\bpg_authid|pg_shadow|pg_user_mappings\b/i, reason: 'credential catalogs are not readable' },
  { pattern: /\b(api_credentials|audit_log|rate_limit_buckets|schema_migrations)\b/i, reason: 'this table is not part of the analytics surface' },
  // Both of these are matched on the FUNCTION NAME alone, deliberately.
  // An earlier version matched on the argument ('app.current_org_id') and was
  // defeated by this file's own literal-stripping, which is exactly how the
  // set_config tenant-switch leak got through. Never pattern-match on an
  // argument that stripLiteralsAndComments() has already erased.
  //
  // set_config is ALSO revoked from mcp_tenant at the database level
  // (migration 0010) — that revocation is the real control; this is the
  // friendlier error.
  { pattern: /\bset_config\s*\(/i, reason: 'session settings cannot be changed from a query; the tenant context is set by the server' },
  { pattern: /\bcurrent_setting\s*\(/i, reason: 'session settings are not readable from a query' },
  { pattern: /\bpg_settings\b/i, reason: 'session settings are not readable from a query' },
  { pattern: /\bexplain\b/i, reason: 'EXPLAIN output can disclose cross-tenant statistics such as row estimates' },
  { pattern: /\bdo\s+\$|\bexecute\b|\bperform\b/i, reason: 'dynamic execution is not permitted' },
  { pattern: /\blisten\b|\bnotify\b|\bunlisten\b/i, reason: 'notification channels are shared across tenants' },
  { pattern: /\b(begin|commit|rollback|savepoint|start\s+transaction|abort)\b/i, reason: 'transaction control is managed by the server' },
  { pattern: /\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i, reason: 'row locking is a write operation' },
  { pattern: /\binto\s+(temp|temporary|unlogged)?\s*\w*\s*$/i, reason: 'SELECT INTO creates a table' },
];

const MAX_SQL_LENGTH = 8000;

export function guardSql(rawSql: string, maxRows: number): GuardResult {
  const input = (rawSql ?? '').trim();

  if (!input) {
    throw new McpToolError('sql_rejected', 'No SQL was provided.', {
      hint: 'Pass a single read-only SELECT statement.',
    });
  }
  if (input.length > MAX_SQL_LENGTH) {
    throw new McpToolError('sql_rejected', `Query exceeds ${MAX_SQL_LENGTH} characters.`, {
      hint: 'Simplify the query, or use query_metric / funnel / top_n which express most questions in far less SQL.',
    });
  }

  const stripped = stripLiteralsAndComments(input);

  // ---- single statement only ---------------------------------------------
  // Any semicolon that is not a single trailing one means statement chaining.
  const withoutTrailing = stripped.replace(/;\s*$/, '');
  if (withoutTrailing.includes(';')) {
    throw new McpToolError('sql_rejected', 'Only a single SQL statement is permitted.', {
      hint: 'Remove the semicolon-separated statements and send one SELECT. Run additional queries as separate tool calls.',
    });
  }

  // ---- must start as a read ----------------------------------------------
  const leading = withoutTrailing.replace(/^[\s(]+/, '');
  if (!/^(select|with|table|values)\b/i.test(leading)) {
    throw new McpToolError('sql_rejected', 'Only SELECT queries are permitted.', {
      hint: 'Start the statement with SELECT or WITH. This connection cannot write.',
    });
  }

  // ---- writable CTEs ------------------------------------------------------
  // A data-modifying CTE hides a write inside something that opens with WITH.
  if (/^with\b/i.test(leading) && /\bwith\b[\s\S]*\b(insert|update|delete|merge)\b/i.test(withoutTrailing)) {
    throw new McpToolError('sql_rejected', 'Data-modifying CTEs are not permitted.', {
      hint: 'A WITH clause containing INSERT/UPDATE/DELETE is a write. Use a read-only CTE.',
    });
  }

  // ---- keyword denylist ---------------------------------------------------
  for (const { pattern, reason } of FORBIDDEN) {
    if (pattern.test(withoutTrailing)) {
      throw new McpToolError('sql_rejected', `Query rejected: ${reason}.`, {
        hint: 'run_sql accepts a single read-only SELECT over your analytics tables. Call get_schema_context for the available tables and columns.',
      });
    }
  }

  // ---- forced LIMIT -------------------------------------------------------
  // Both a cost control and a context-window control: an unbounded result set
  // is how a tool call blows up the model's context.
  const limitMatch = /\blimit\s+(\d+)\s*(offset\s+\d+\s*)?$/i.exec(withoutTrailing.trim());
  let sql = input.replace(/;\s*$/, '');
  let limitApplied = false;
  let appliedLimit = maxRows;

  if (limitMatch) {
    const requested = Number(limitMatch[1]);
    appliedLimit = Math.min(requested, maxRows);
    if (requested > maxRows) {
      // Rewrite rather than reject: the model asked a reasonable question with
      // an unreasonable bound, and rejecting would cost a turn to learn a cap
      // we can just apply.
      sql = sql.replace(/\blimit\s+\d+(\s*offset\s+\d+)?\s*$/i, `LIMIT ${maxRows}$1`);
      limitApplied = true;
    }
  } else {
    sql = `${sql}\nLIMIT ${maxRows}`;
    limitApplied = true;
    appliedLimit = maxRows;
  }

  return { sql, limitApplied, appliedLimit };
}
