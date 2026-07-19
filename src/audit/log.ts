import { authPool } from '../db/pools.js';

export interface AuditEntry {
  orgId: string | null;
  credentialId: string | null;
  toolName: string;
  arguments: unknown;
  generatedSql: string | null;
  rowsReturned: number | null;
  latencyMs: number;
  status: 'ok' | 'empty' | 'error' | 'denied' | 'rate_limited';
  errorCode?: string | null;
  errorDetail?: string | null;
  clientIp?: string | null;
}

/**
 * Keys whose values are stripped before an argument blob is persisted. Tool
 * arguments are model-authored free text and can contain anything a user
 * pasted into the chat, including credentials.
 */
const SENSITIVE_ARG_KEYS = /^(api_?key|token|secret|password|authorization|bearer)$/i;

function redactArgs(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated: too deep]';
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > 2000) {
      return `${value.slice(0, 2000)}…[truncated ${value.length - 2000} chars]`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => redactArgs(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_ARG_KEYS.test(k) ? '[redacted]' : redactArgs(v, depth + 1);
  }
  return out;
}

/**
 * Appends one audit row per tool call: who, what, the SQL we generated, how
 * many rows came back, how long it took, and the full internal error text when
 * something failed.
 *
 * Deliberately never throws. A failure to write an audit row must not turn a
 * successful analytics answer into an error for the tenant — but it must be
 * loud in the server's own logs, because a silent audit gap is how an incident
 * becomes uninvestigable.
 */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    await authPool.query(
      'SELECT public.audit_write($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        entry.orgId,
        entry.credentialId,
        entry.toolName,
        JSON.stringify(redactArgs(entry.arguments) ?? {}),
        entry.generatedSql,
        entry.rowsReturned,
        Math.round(entry.latencyMs),
        entry.status,
        entry.errorCode ?? null,
        entry.errorDetail ?? null,
        entry.clientIp ?? null,
      ]
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'AUDIT WRITE FAILED — tool call executed but was not recorded',
        tool: entry.toolName,
        org: entry.orgId,
        err: err instanceof Error ? err.message : String(err),
      })
    );
  }
}
