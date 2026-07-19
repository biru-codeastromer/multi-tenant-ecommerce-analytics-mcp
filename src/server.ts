/**
 * HTTP entrypoint — MCP over Streamable HTTP.
 *
 * AUTH MODEL: the API key arrives in the Authorization header and is resolved
 * to an org on EVERY request. There is no session, no cookie, and no server-
 * side "logged in as" state that could drift from the credential. Revoke a key
 * and the next request fails, with nothing to invalidate.
 *
 * STATELESS TRANSPORT: a fresh transport and a fresh tenant-bound MCP server
 * per request, with no session id and no cross-request server registry. That
 * costs a little per-request setup and buys two things worth far more: the
 * server scales horizontally with no sticky routing, and there is no shared
 * mutable state in which one tenant's context could be handed to another.
 */
import express, { type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { extractApiKey, resolveCredential, enforceRateLimit, touchCredential } from './auth/credentials.js';
import { buildServerForTenant } from './mcp/buildServer.js';
import { McpToolError } from './util/errors.js';
import { writeAudit } from './audit/log.js';
import { closePools, tenantPool, authPool } from './db/pools.js';
import { cacheStats } from './registry/contextCache.js';

const app = express();

app.use(express.json({ limit: '1mb' }));
app.disable('x-powered-by');

// Trust one proxy hop (Railway/Render/Fly all terminate TLS in front of us) so
// req.ip is the real client and not the load balancer.
app.set('trust proxy', 1);

function log(level: string, msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));
}

const clientIpOf = (req: Request): string | null => req.ip ?? null;

// ---------------------------------------------------------------------------
// Health check.
//
// Deliberately does NOT touch the tenant pool or return any tenant data. It
// also doubles as the keepalive target that stops Supabase's free tier pausing
// the project after 7 idle days (see docs/deploy.md).
// ---------------------------------------------------------------------------
app.get('/health', async (_req: Request, res: Response) => {
  try {
    await authPool.query('SELECT 1');
    res.json({
      status: 'ok',
      service: 'zyaro-ecommerce-analytics-mcp',
      version: '1.0.0',
      time: new Date().toISOString(),
      pools: {
        tenant: { total: tenantPool.totalCount, idle: tenantPool.idleCount, waiting: tenantPool.waitingCount },
        auth: { total: authPool.totalCount, idle: authPool.idleCount, waiting: authPool.waitingCount },
      },
      context_cache: cacheStats(),
    });
  } catch (err) {
    log('error', 'health check failed', { err: err instanceof Error ? err.message : String(err) });
    res.status(503).json({ status: 'degraded' });
  }
});

app.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'Multi-Tenant E-Commerce Event Store — Analytics MCP Server',
    mcp_endpoint: '/mcp',
    transport: 'streamable-http',
    auth: 'Authorization: Bearer <api-key>',
    docs: 'https://github.com/<your-org>/zyaro-event-store-mcp#readme',
  });
});

// ---------------------------------------------------------------------------
// MCP endpoint
// ---------------------------------------------------------------------------
app.post('/mcp', async (req: Request, res: Response) => {
  const requestId = randomUUID();
  const started = Date.now();
  const clientIp = clientIpOf(req);

  const rawKey = extractApiKey(req.headers as Record<string, string | string[] | undefined>);
  if (!rawKey) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message:
          'Missing credential. Send your API key as "Authorization: Bearer <key>". The organization is derived from the key; there is no organization parameter.',
      },
      id: null,
    });
    return;
  }

  let tenant;
  try {
    tenant = await resolveCredential(rawKey);
    await enforceRateLimit(tenant.credentialId);
  } catch (err) {
    const isRateLimit = err instanceof McpToolError && err.code === 'rate_limited';
    const status = isRateLimit ? 429 : 401;

    await writeAudit({
      orgId: tenant?.orgId ?? null,
      credentialId: tenant?.credentialId ?? null,
      toolName: 'auth',
      arguments: {},
      generatedSql: null,
      rowsReturned: null,
      latencyMs: Date.now() - started,
      status: isRateLimit ? 'rate_limited' : 'denied',
      errorCode: isRateLimit ? 'rate_limited' : 'unauthorized',
      // The raw key is never logged, only that a resolution failed.
      errorDetail: err instanceof Error ? err.message : String(err),
      clientIp,
    });

    log(isRateLimit ? 'warn' : 'warn', isRateLimit ? 'rate limited' : 'auth failed', {
      requestId,
      ip: clientIp,
      org: tenant?.orgSlug,
    });

    res.status(status).json({
      jsonrpc: '2.0',
      error: {
        code: isRateLimit ? -32002 : -32001,
        message: err instanceof McpToolError ? err.message : 'Invalid or revoked API credential.',
      },
      id: null,
    });
    return;
  }

  touchCredential(tenant.credentialId);

  try {
    const server = await buildServerForTenant(tenant, clientIp);

    // Stateless: no session id generator, so the SDK does not retain the
    // transport between requests and nothing is shared across tenants.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    // Both are torn down when the HTTP response ends, so a long-lived client
    // cannot accumulate server instances.
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    log('info', 'mcp request', {
      requestId,
      org: tenant.orgSlug,
      method: (req.body as { method?: string } | undefined)?.method,
      ms: Date.now() - started,
    });
  } catch (err) {
    log('error', 'mcp request failed', {
      requestId,
      org: tenant.orgSlug,
      err: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      // Generic by design. An internal error message can carry schema detail.
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error.' },
        id: null,
      });
    }
  }
});

// GET and DELETE on /mcp are for the stateful SSE flow, which this server does
// not implement. Answered explicitly so a client gets a clear signal.
app.get('/mcp', (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'This server is stateless; use POST for all MCP requests.' },
    id: null,
  });
});

app.delete('/mcp', (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'This server is stateless; there is no session to terminate.' },
    id: null,
  });
});

// ---------------------------------------------------------------------------
const server = app.listen(config.server.port, () => {
  log('info', 'listening', {
    port: config.server.port,
    env: config.server.env,
    endpoint: `http://localhost:${config.server.port}/mcp`,
  });
});

async function shutdown(signal: string): Promise<void> {
  log('info', 'shutting down', { signal });
  server.close(async () => {
    await closePools();
    process.exit(0);
  });
  // Do not hang forever on a stuck connection.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

export { app };
