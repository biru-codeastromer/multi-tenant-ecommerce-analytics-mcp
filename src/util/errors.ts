/**
 * Error taxonomy.
 *
 * Two rules govern everything in this file:
 *
 * 1. A caller must be able to tell "you had zero orders" from "your query
 *    failed". Empty results are NOT errors; they come back as a normal
 *    response with status "empty" and an explanation. Only genuine failures
 *    raise.
 *
 * 2. Nothing internal reaches the caller. A raw Postgres error can name
 *    another tenant's constraint, expose column lists, or leak row counts
 *    through a uniqueness violation. Every error surfaced to a tool response
 *    is a fixed code plus a hint we wrote. The original text goes to the audit
 *    log, which tenants cannot read.
 */

export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'invalid_argument'
  | 'unknown_metric'
  | 'unknown_event'
  | 'unknown_dimension'
  | 'not_tracked'
  | 'sql_rejected'
  | 'query_timeout'
  | 'tenant_context'
  | 'internal';

export class McpToolError extends Error {
  readonly code: ErrorCode;
  /** Concrete next step for the model, e.g. valid alternatives. */
  readonly hint?: string;
  /** Valid options, so the model self-corrects in one turn instead of five. */
  readonly didYouMean?: string[];

  constructor(code: ErrorCode, message: string, opts?: { hint?: string; didYouMean?: string[] }) {
    super(message);
    this.name = 'McpToolError';
    this.code = code;
    this.hint = opts?.hint;
    this.didYouMean = opts?.didYouMean;
  }
}

export class TenantContextError extends McpToolError {
  constructor(message: string) {
    super('tenant_context', message);
    this.name = 'TenantContextError';
  }
}

export class UnauthorizedError extends McpToolError {
  constructor(message = 'Invalid or revoked API credential.') {
    super('unauthorized', message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * The credential is valid but lacks the scope a tool requires. Distinct from
 * `unauthorized` on purpose: the difference between "who are you" and "you are
 * known, but not allowed this" is exactly what a caller needs in order to stop
 * retrying and ask a human for a broader key instead.
 */
export class ScopeError extends McpToolError {
  constructor(toolName: string, required: string, held: string[]) {
    super(
      'forbidden',
      `This credential is not permitted to call "${toolName}".`,
      {
        hint:
          `"${toolName}" requires the "${required}" scope; this credential holds [${held.join(', ') || 'none'}]. ` +
          `Ask the organization for a credential that includes "${required}", or use a tool your scopes already allow.`,
      }
    );
    this.name = 'ScopeError';
  }
}

export class RateLimitError extends McpToolError {
  constructor(limit: number) {
    super('rate_limited', `Rate limit exceeded: more than ${limit} requests in one minute.`, {
      hint: 'Wait for the current minute to elapse, then retry. Consider batching questions into a single tool call.',
    });
    this.name = 'RateLimitError';
  }
}

/**
 * Maps a caught throwable to something safe to return.
 *
 * The default branch is the important one: any error we did not explicitly
 * anticipate collapses to a generic "internal" with no detail at all. That is
 * a deliberate choice to fail closed on information disclosure: a stack trace
 * or a Postgres detail string is exactly the channel through which one tenant
 * learns about another's schema.
 */
export function toSafeError(err: unknown): {
  code: ErrorCode;
  message: string;
  hint?: string;
  didYouMean?: string[];
  internalDetail: string;
} {
  const internalDetail =
    err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err);

  if (err instanceof McpToolError) {
    return {
      code: err.code,
      message: err.message,
      ...(err.hint ? { hint: err.hint } : {}),
      ...(err.didYouMean ? { didYouMean: err.didYouMean } : {}),
      internalDetail,
    };
  }

  // Postgres error codes we can safely translate into actionable guidance
  // without echoing any of the server's own text back to the caller.
  const pgCode = (err as { code?: string } | null)?.code;
  if (pgCode === '57014' || pgCode === '25P03') {
    return {
      code: 'query_timeout',
      message: 'The query exceeded the time limit and was cancelled.',
      hint: 'Narrow the date range, add a filter, or request a coarser bucket (week or month instead of day).',
      internalDetail,
    };
  }
  if (pgCode === '42501') {
    return {
      code: 'sql_rejected',
      message: 'The query touched an object this connection is not permitted to read.',
      hint: 'Only your organization\'s analytics tables are readable. Use get_schema_context to see what is available.',
      internalDetail,
    };
  }
  if (pgCode === '42601' || pgCode === '42P01' || pgCode === '42703') {
    return {
      code: 'sql_rejected',
      message: 'The SQL was not valid against this schema.',
      hint: 'Call get_schema_context for the exact table and column names available to you.',
      internalDetail,
    };
  }

  return {
    code: 'internal',
    message: 'The request could not be completed.',
    internalDetail,
  };
}
