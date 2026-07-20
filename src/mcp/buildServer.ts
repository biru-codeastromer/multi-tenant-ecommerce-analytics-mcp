/**
 * Builds a per-request MCP server bound to exactly one tenant.
 *
 * A NEW SERVER INSTANCE PER REQUEST, closed over the resolved tenant. This is
 * the structural reason a tool cannot be called for the wrong org: the org id
 * is not a value flowing through the call, it is captured in the closure
 * before any tool is registered. There is no shared mutable "current tenant"
 * that a concurrent request could race against.
 *
 * The alternative. One long-lived server plus a request-scoped context. * works right up until an async boundary interleaves two requests, and then
 * fails silently and catastrophically. Constructing per request costs a few
 * microseconds and removes the entire class of bug.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ResolvedTenant } from '../auth/credentials.js';
import { TOOLS, TOOLS_BY_NAME } from '../tools/index.js';
import { withOrgSession } from '../db/tenantSession.js';
import { getOrgContext } from '../registry/contextCache.js';
import { renderResponse, type ToolResponse } from '../util/render.js';
import { toSafeError } from '../util/errors.js';
import { writeAudit } from '../audit/log.js';

export const CONTEXT_RESOURCE_URI = 'schema://org/context';

export async function buildServerForTenant(
  tenant: ResolvedTenant,
  clientIp: string | null
): Promise<Server> {
  // Generated once per connection and shipped in `initialize`, so the model
  // has the org's taxonomy before it asks its first question rather than
  // burning three turns discovering it. Cached by (org, registry version), so
  // this is usually a map lookup.
  const { context } = await getOrgContext(tenant.orgId, {
    orgName: tenant.orgName,
    orgSlug: tenant.orgSlug,
    timezone: tenant.reportingTimezone,
    currency: tenant.defaultCurrency,
  });

  const server = new Server(
    {
      name: 'zyaro-ecommerce-analytics',
      version: '1.0.0',
    },
    {
      capabilities: { tools: {}, resources: {} },
      // THE POINT OF THE WHOLE EXERCISE: a rich, org-specific data dictionary
      // delivered at initialization instead of rediscovered every session.
      instructions: context.text,
    }
  );

  // ---- tools/list ---------------------------------------------------------
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // ---- resources ----------------------------------------------------------
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: CONTEXT_RESOURCE_URI,
        name: `${tenant.orgName} data dictionary`,
        description:
          'Org-specific analytics context: event taxonomy, canonical mappings, properties, tables, metric definitions and worked examples. Pin this if your client supports resources.',
        mimeType: 'text/markdown',
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    if (req.params.uri !== CONTEXT_RESOURCE_URI) {
      throw new Error(`Unknown resource: ${req.params.uri}`);
    }
    const fresh = await getOrgContext(tenant.orgId, {
      orgName: tenant.orgName,
      orgSlug: tenant.orgSlug,
      timezone: tenant.reportingTimezone,
      currency: tenant.defaultCurrency,
    });
    return {
      contents: [
        {
          uri: CONTEXT_RESOURCE_URI,
          mimeType: 'text/markdown',
          text: fresh.context.text,
        },
      ],
    };
  });

  // ---- tools/call ---------------------------------------------------------
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const started = Date.now();
    const toolName = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS_BY_NAME.get(toolName);

    let generatedSql: string | null = null;
    const recordSql = (sql: string) => {
      generatedSql = sql;
    };

    if (!tool) {
      const response: ToolResponse = {
        status: 'error',
        summary: `Unknown tool "${toolName}".`,
        error: {
          code: 'invalid_argument',
          message: `No tool named "${toolName}".`,
          did_you_mean: TOOLS.map((t) => t.name),
        },
      };
      await writeAudit({
        orgId: tenant.orgId, credentialId: tenant.credentialId, toolName,
        arguments: args, generatedSql: null, rowsReturned: null,
        latencyMs: Date.now() - started, status: 'error',
        errorCode: 'unknown_tool', errorDetail: `Unknown tool ${toolName}`, clientIp,
      });
      return { content: [{ type: 'text', text: renderResponse(response) }], isError: true };
    }

    try {
      // Every tool body runs inside one read-only, org-scoped transaction.
      // A tool cannot open its own transaction or reach the raw client.
      const result = await withOrgSession(tenant.orgId, (session) =>
        tool.handler(args as never, { session, tenant, recordSql })
      );

      const rowsReturned = Array.isArray(result.data)
        ? result.data.length
        : result.data
          ? 1
          : 0;

      await writeAudit({
        orgId: tenant.orgId,
        credentialId: tenant.credentialId,
        toolName,
        arguments: args,
        generatedSql,
        rowsReturned,
        latencyMs: Date.now() - started,
        status: result.status === 'ok' ? 'ok' : result.status === 'error' ? 'error' : 'empty',
        clientIp,
      });

      return {
        content: [{ type: 'text', text: renderResponse(result) }],
        // not_tracked and empty are NOT errors. They are correct answers.
        // Marking them isError would tell the model its query failed, and it
        // would retry a question that was already answered.
        isError: result.status === 'error',
      };
    } catch (err) {
      const safe = toSafeError(err);

      await writeAudit({
        orgId: tenant.orgId,
        credentialId: tenant.credentialId,
        toolName,
        arguments: args,
        generatedSql,
        rowsReturned: null,
        latencyMs: Date.now() - started,
        status: 'error',
        errorCode: safe.code,
        // Full internal detail goes here and ONLY here. Tenants cannot read
        // audit_log; a raw Postgres error can name another tenant's objects.
        errorDetail: safe.internalDetail,
        clientIp,
      });

      const response: ToolResponse = {
        status: 'error',
        summary: safe.message,
        error: {
          code: safe.code,
          message: safe.message,
          ...(safe.hint ? { hint: safe.hint } : {}),
          ...(safe.didYouMean?.length ? { did_you_mean: safe.didYouMean } : {}),
        },
      };

      return { content: [{ type: 'text', text: renderResponse(response) }], isError: true };
    }
  });

  return server;
}
