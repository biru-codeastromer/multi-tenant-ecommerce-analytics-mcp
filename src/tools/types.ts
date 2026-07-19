import type { TenantSession } from '../db/tenantSession.js';
import type { ResolvedTenant } from '../auth/credentials.js';
import type { ToolResponse } from '../util/render.js';

/**
 * Context handed to every tool.
 *
 * Note what is NOT here and cannot be: a way to change the org. The tenant is
 * fixed by the credential at the start of the request and the session is
 * already scoped when a tool receives it.
 */
export interface ToolContext {
  session: TenantSession;
  tenant: ResolvedTenant;
  /** Populated by the tool so the audit log records what actually ran. */
  recordSql: (sql: string) => void;
}

export interface ToolDefinition<A = Record<string, unknown>> {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: A, ctx: ToolContext) => Promise<ToolResponse>;
}
