/**
 * Structured errors thrown by the AgentKarma SDK.
 *
 * All errors derive from `AgentKarmaError`, so partner code can write a single
 * `catch (err: unknown) { if (err instanceof AgentKarmaError) … }` block and
 * narrow on subclass when finer handling is needed.
 */

/** Base class for every error thrown by the SDK. */
export class AgentKarmaError extends Error {
  /** HTTP status code if the error originated from a response. */
  public readonly status?: number;
  /** Raw response body when available — useful for debugging unfamiliar errors. */
  public readonly response?: unknown;
  /** Underlying cause (network error, parse error, etc.). */
  public override readonly cause?: unknown;

  constructor(message: string, opts: { status?: number; response?: unknown; cause?: unknown } = {}) {
    super(message);
    this.name = 'AgentKarmaError';
    this.status = opts.status;
    this.response = opts.response;
    this.cause = opts.cause;
  }
}

/** Caller passed an argument that failed local validation before the request was sent. */
export class AgentKarmaValidationError extends AgentKarmaError {
  constructor(message: string) {
    super(message);
    this.name = 'AgentKarmaValidationError';
  }
}

/** Server returned HTTP 404 — the requested wallet, agent, or resource doesn't exist. */
export class AgentKarmaNotFoundError extends AgentKarmaError {
  constructor(message: string, opts: { response?: unknown } = {}) {
    super(message, { status: 404, response: opts.response });
    this.name = 'AgentKarmaNotFoundError';
  }
}

/** Server returned HTTP 429 — caller is being rate-limited. */
export class AgentKarmaRateLimitError extends AgentKarmaError {
  /** Seconds until the limit resets, when the server provides Retry-After. */
  public readonly retryAfter?: number;

  constructor(message: string, opts: { response?: unknown; retryAfter?: number } = {}) {
    super(message, { status: 429, response: opts.response });
    this.name = 'AgentKarmaRateLimitError';
    this.retryAfter = opts.retryAfter;
  }
}

/** Request did not complete within the configured timeout. */
export class AgentKarmaTimeoutError extends AgentKarmaError {
  public readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = 'AgentKarmaTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** fetch() threw before getting a response — DNS failure, connection refused, offline, etc. */
export class AgentKarmaNetworkError extends AgentKarmaError {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'AgentKarmaNetworkError';
  }
}

/** Server returned HTTP 2xx but the body didn't match the expected shape. */
export class AgentKarmaMalformedResponseError extends AgentKarmaError {
  constructor(message: string, opts: { response?: unknown; cause?: unknown } = {}) {
    super(message, { response: opts.response, cause: opts.cause });
    this.name = 'AgentKarmaMalformedResponseError';
  }
}

/** Server returned a non-2xx status that doesn't fit a more specific category. */
export class AgentKarmaServerError extends AgentKarmaError {
  constructor(message: string, opts: { status: number; response?: unknown }) {
    super(message, { status: opts.status, response: opts.response });
    this.name = 'AgentKarmaServerError';
  }
}
