/**
 * AgentKarma typed HTTP client.
 *
 * Framework-agnostic. Works in Node 18+, Bun, Deno, browsers, edge runtimes —
 * anywhere global `fetch` is available (or you provide one).
 */

import {
  AgentKarmaError,
  AgentKarmaMalformedResponseError,
  AgentKarmaNetworkError,
  AgentKarmaNotFoundError,
  AgentKarmaRateLimitError,
  AgentKarmaServerError,
  AgentKarmaTimeoutError,
  AgentKarmaValidationError,
} from './errors.js';
import type {
  AgentHistoryResponse,
  BondBlock,
  BondResponse,
  CeloAgentSnapshot,
  Chain,
  ClientConfig,
  FeedbackSubmission,
  FeedbackSubmissionResponse,
  FeedbackSummary,
  FetchLike,
  KarmaFace,
  KarmaFaceData,
  KarmaSnapshot,
  RequestOptions,
  SearchResponse,
  SuccessionResponse,
  SuccessionView,
  SuretyView,
} from './types.js';

const SDK_VERSION = '0.1.0';
const DEFAULT_BASE_URL = 'https://agentkarma.io';
const DEFAULT_TIMEOUT_MS = 10_000;

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SUPPORTED_CHAINS: readonly Chain[] = ['solana', 'celo', 'stellar', 'arc'];

interface InternalConfig {
  baseUrl: string;
  fetchImpl: FetchLike;
  timeout: number;
  headers: Record<string, string>;
}

function normalizeConfig(input?: ClientConfig): InternalConfig {
  const baseUrl = (input?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const userAgent = input?.userAgent ?? `@agentkarma/sdk/${SDK_VERSION}`;
  return {
    baseUrl,
    fetchImpl: input?.fetch ?? globalThis.fetch,
    timeout: input?.timeout ?? DEFAULT_TIMEOUT_MS,
    headers: {
      'User-Agent': userAgent,
      Accept: 'application/json',
      ...(input?.headers ?? {}),
    },
  };
}

function buildSignal(
  configTimeout: number,
  opts: RequestOptions | undefined,
): {
  signal: AbortSignal;
  timeoutSignal: AbortSignal;
  timeoutMs: number;
  cleanup: () => void;
} {
  const timeoutMs = opts?.timeout ?? configTimeout;
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);

  // Compose caller's signal + timeout signal. AbortSignal.any() is available
  // in modern Node/Bun/browsers; fall back to a manual relay otherwise.
  let composed: AbortSignal;
  if (opts?.signal) {
    if (typeof AbortSignal !== 'undefined' && typeof (AbortSignal as unknown as { any?: unknown }).any === 'function') {
      composed = (AbortSignal as unknown as { any: (signals: AbortSignal[]) => AbortSignal }).any([
        opts.signal,
        timeoutController.signal,
      ]);
    } else {
      const relayController = new AbortController();
      const relay = () => relayController.abort();
      opts.signal.addEventListener('abort', relay, { once: true });
      timeoutController.signal.addEventListener('abort', relay, { once: true });
      composed = relayController.signal;
    }
  } else {
    composed = timeoutController.signal;
  }

  return {
    signal: composed,
    timeoutSignal: timeoutController.signal,
    timeoutMs,
    cleanup: () => clearTimeout(timeoutId),
  };
}

async function readBodySafe(res: Response): Promise<unknown> {
  const ct = res.headers.get('content-type') ?? '';
  try {
    if (ct.includes('application/json')) return await res.json();
    return await res.text();
  } catch {
    return undefined;
  }
}

function assertSolanaWallet(wallet: string): void {
  if (!wallet || typeof wallet !== 'string') {
    throw new AgentKarmaValidationError('wallet must be a non-empty string');
  }
  if (!SOLANA_ADDRESS_RE.test(wallet)) {
    throw new AgentKarmaValidationError(
      'wallet does not look like a Solana address (expected base58, 32-44 chars)',
    );
  }
}

function assertAgentId(agentId: number): void {
  if (!Number.isInteger(agentId) || agentId <= 0) {
    throw new AgentKarmaValidationError('agentId must be a positive integer');
  }
}

function assertChain(chain: unknown): asserts chain is Chain {
  if (typeof chain !== 'string' || !SUPPORTED_CHAINS.includes(chain as Chain)) {
    throw new AgentKarmaValidationError(
      `chain must be one of ${SUPPORTED_CHAINS.join(', ')}`,
    );
  }
}

/**
 * Validate a wallet for a chain-aware lookup. DELIBERATELY does NOT apply the
 * Solana base58 shape to EVM/Stellar chains — bonds and successions span chains
 * whose addresses are not base58 Solana keys. We never auto-detect the chain
 * from the address (the chain is always passed explicitly). Solana keeps its
 * strict shape; other chains only require a non-empty string and let the server
 * be the authority (it keys by the composite (chain,address)).
 */
function assertWalletForChain(wallet: string, chain: Chain): void {
  if (!wallet || typeof wallet !== 'string') {
    throw new AgentKarmaValidationError('wallet must be a non-empty string');
  }
  if (chain === 'solana') {
    assertSolanaWallet(wallet);
  }
}

async function request<T>(
  cfg: InternalConfig,
  path: string,
  init: RequestInit,
  opts: RequestOptions | undefined,
): Promise<T> {
  const url = `${cfg.baseUrl}${path}`;
  const { signal, timeoutSignal, timeoutMs, cleanup } = buildSignal(cfg.timeout, opts);

  let res: Response;
  try {
    res = await cfg.fetchImpl(url, {
      ...init,
      signal,
      headers: { ...cfg.headers, ...(init.headers ?? {}), ...(opts?.headers ?? {}) },
    });
  } catch (err) {
    cleanup();
    // The timeout's own controller having fired is the most reliable signal
    // that we exceeded the deadline — works regardless of which runtime's
    // AbortError shape was thrown by fetch (Bun vs Node vs browser).
    if (timeoutSignal.aborted) {
      throw new AgentKarmaTimeoutError(timeoutMs);
    }
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new AgentKarmaTimeoutError(timeoutMs);
    }
    throw new AgentKarmaNetworkError(
      err instanceof Error ? err.message : String(err),
      err,
    );
  }
  cleanup();

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') ?? '0');
    const body = await readBodySafe(res);
    throw new AgentKarmaRateLimitError(
      'AgentKarma rate limit exceeded',
      { response: body, retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined },
    );
  }

  if (res.status === 404) {
    const body = await readBodySafe(res);
    const msg = typeof body === 'object' && body && 'error' in body
      ? String((body as { error: unknown }).error)
      : `Not found at ${path}`;
    throw new AgentKarmaNotFoundError(msg, { response: body });
  }

  if (!res.ok) {
    const body = await readBodySafe(res);
    const msg = typeof body === 'object' && body && 'error' in body
      ? String((body as { error: unknown }).error)
      : `AgentKarma server returned ${res.status}`;
    throw new AgentKarmaServerError(msg, { status: res.status, response: body });
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    throw new AgentKarmaMalformedResponseError(
      'Response body is not valid JSON',
      { cause: err },
    );
  }
  return parsed as T;
}

// ─── Public client ────────────────────────────────────────────────────────────

export interface AgentKarmaClient {
  readonly baseUrl: string;

  /**
   * GET /api/v2/score/{wallet}?face={face} — full karma snapshot.
   *
   * `chain` is OPTIONAL and defaults to `'solana'` for back-compat. Pass it for
   * celo/arc/stellar wallets so the SDK applies the right address validation
   * (Solana base58 only applies to Solana). The server resolves the wallet's
   * real chain from the address; we NEVER auto-detect an EVM chain client-side.
   */
  getKarma(
    wallet: string,
    opts?: { face?: KarmaFace | 'both'; chain?: Chain } & RequestOptions,
  ): Promise<KarmaSnapshot>;

  /** Shorthand for `getKarma(wallet, { face: 'provider' })`. Returns just the provider face. */
  getProviderKarma(wallet: string, opts?: RequestOptions): Promise<KarmaFaceData>;

  /** Shorthand for `getKarma(wallet, { face: 'consumer' })`. Returns just the consumer face. */
  getConsumerKarma(wallet: string, opts?: RequestOptions): Promise<KarmaFaceData | null>;

  /** GET /api/v2/celo/{agentId} — ERC-8004 IdentityRegistry + ReputationRegistry snapshot. */
  getCeloAgent(agentId: number, opts?: RequestOptions): Promise<CeloAgentSnapshot>;

  /** GET /api/search?q={query} — substring search over indexed wallets. */
  searchAgents(query: string, opts?: { limit?: number } & RequestOptions): Promise<SearchResponse>;

  /** GET /api/agent/{wallet}/history — paginated x402 history with feedback ratings. */
  getAgentHistory(
    wallet: string,
    opts?: { limit?: number; offset?: number } & RequestOptions,
  ): Promise<AgentHistoryResponse>;

  /** GET /api/feedback?agent={wallet} — aggregate delivered/failed counts. */
  getFeedbackSummary(wallet: string, opts?: RequestOptions): Promise<FeedbackSummary>;

  /**
   * GET /api/v2/succession/{chain}/{wallet} — declared Dead Man's Switch plan
   * + AK's OBSERVED heartbeat liveness. `chain` is explicit (spans all chains);
   * Solana wallets are shape-checked, others passed through. Throws
   * AgentKarmaNotFoundError (404) when the agent declared no succession plan.
   */
  getSuccessionStatus(
    chain: Chain,
    wallet: string,
    opts?: RequestOptions,
  ): Promise<SuccessionView>;

  /**
   * GET /api/v2/bond/{chain}/{wallet} → `.bonds` — bonds taken out ON this
   * agent (open vs resolved, totalBondedUsdc, hasDemo). `chain` is explicit.
   * Returns an empty block (no throw) when the agent has no bonds.
   */
  getBondStatus(chain: Chain, wallet: string, opts?: RequestOptions): Promise<BondBlock>;

  /**
   * GET /api/v2/bond/{chain}/{wallet} → `.surety` — this wallet's ORTHOGONAL
   * Surety Karma from underwriting OTHER agents' bonds. `chain` is explicit.
   * Returns null when the wallet has never underwritten.
   */
  getSuretyKarma(
    chain: Chain,
    wallet: string,
    opts?: RequestOptions,
  ): Promise<SuretyView | null>;

  /** POST /api/feedback — submit a wallet-signed consumer rating (Solana-only today). */
  submitFeedback(input: FeedbackSubmission, opts?: RequestOptions): Promise<FeedbackSubmissionResponse>;
}

export function createAgentKarmaClient(config?: ClientConfig): AgentKarmaClient {
  const cfg = normalizeConfig(config);

  return {
    baseUrl: cfg.baseUrl,

    async getKarma(wallet, opts = {}) {
      // Chain-aware: default 'solana' (back-compat). assertWalletForChain applies
      // the strict base58 shape only for Solana; other chains pass through to the
      // server. We do NOT auto-detect an EVM chain from the address.
      const chain = opts.chain ?? 'solana';
      assertChain(chain);
      assertWalletForChain(wallet, chain);
      const face = opts.face ?? 'both';
      if (face !== 'both' && face !== 'provider' && face !== 'consumer') {
        throw new AgentKarmaValidationError(`face must be 'provider' | 'consumer' | 'both'`);
      }
      const path = `/api/v2/score/${encodeURIComponent(wallet)}?face=${face}`;
      const snap = await request<KarmaSnapshot>(cfg, path, { method: 'GET' }, opts);
      validateKarmaSnapshot(snap);
      return snap;
    },

    async getProviderKarma(wallet, opts) {
      const snap = await this.getKarma(wallet, { ...opts, face: 'provider' });
      if (!snap.provider) {
        throw new AgentKarmaMalformedResponseError(
          'Server omitted provider face from response',
          { response: snap },
        );
      }
      return snap.provider;
    },

    async getConsumerKarma(wallet, opts) {
      const snap = await this.getKarma(wallet, { ...opts, face: 'consumer' });
      // Consumer face is allowed to be absent (the wallet may have no consumer
      // signal). Surface null rather than throw — caller decides.
      return snap.consumer ?? null;
    },

    async getCeloAgent(agentId, opts) {
      assertAgentId(agentId);
      const path = `/api/v2/celo/${agentId}`;
      const snap = await request<CeloAgentSnapshot>(cfg, path, { method: 'GET' }, opts);
      if (snap.chain !== 'celo' || typeof snap.owner !== 'string') {
        throw new AgentKarmaMalformedResponseError(
          'Celo agent response missing required fields',
          { response: snap },
        );
      }
      return snap;
    },

    async searchAgents(query, opts = {}) {
      if (typeof query !== 'string' || query.trim().length < 3) {
        throw new AgentKarmaValidationError('query must be a string of at least 3 characters');
      }
      const params = new URLSearchParams({ q: query.trim() });
      if (opts.limit != null) params.set('limit', String(opts.limit));
      const path = `/api/search?${params.toString()}`;
      const res = await request<SearchResponse>(cfg, path, { method: 'GET' }, opts);
      if (!res || !Array.isArray(res.results)) {
        throw new AgentKarmaMalformedResponseError(
          'Search response missing results array',
          { response: res },
        );
      }
      return res;
    },

    async getAgentHistory(wallet, opts = {}) {
      assertSolanaWallet(wallet);
      const params = new URLSearchParams();
      if (opts.limit != null) params.set('limit', String(opts.limit));
      if (opts.offset != null) params.set('offset', String(opts.offset));
      const qs = params.toString();
      const path = `/api/agent/${encodeURIComponent(wallet)}/history${qs ? `?${qs}` : ''}`;
      const res = await request<AgentHistoryResponse>(cfg, path, { method: 'GET' }, opts);
      if (!res || !Array.isArray(res.transactions)) {
        throw new AgentKarmaMalformedResponseError(
          'History response missing transactions array',
          { response: res },
        );
      }
      return res;
    },

    async getFeedbackSummary(wallet, opts) {
      assertSolanaWallet(wallet);
      const path = `/api/feedback?agent=${encodeURIComponent(wallet)}`;
      const res = await request<FeedbackSummary>(cfg, path, { method: 'GET' }, opts);
      if (
        typeof res !== 'object' ||
        res === null ||
        typeof (res as FeedbackSummary).total !== 'number'
      ) {
        throw new AgentKarmaMalformedResponseError(
          'Feedback summary response shape unexpected',
          { response: res },
        );
      }
      return res;
    },

    async getSuccessionStatus(chain, wallet, opts) {
      assertChain(chain);
      assertWalletForChain(wallet, chain);
      const path = `/api/v2/succession/${chain}/${encodeURIComponent(wallet)}`;
      const raw = await request<unknown>(cfg, path, { method: 'GET' }, opts);
      const res = raw as Partial<SuccessionResponse> | null;
      const s = res?.succession as Record<string, unknown> | undefined;
      if (!s || typeof s !== 'object') {
        throw new AgentKarmaMalformedResponseError(
          'Succession response missing succession block',
          { response: raw },
        );
      }
      if (typeof s.status !== 'string' || typeof s.intervalSeconds !== 'number') {
        throw new AgentKarmaMalformedResponseError(
          'Succession view missing required fields (status, intervalSeconds)',
          { response: raw },
        );
      }
      return s as unknown as SuccessionView;
    },

    async getBondStatus(chain, wallet, opts) {
      assertChain(chain);
      assertWalletForChain(wallet, chain);
      const path = `/api/v2/bond/${chain}/${encodeURIComponent(wallet)}`;
      const raw = await request<unknown>(cfg, path, { method: 'GET' }, opts);
      const res = raw as Partial<BondResponse> | null;
      const block = res?.bonds as Record<string, unknown> | undefined;
      if (
        !block ||
        typeof block !== 'object' ||
        !Array.isArray(block.open) ||
        !Array.isArray(block.resolved) ||
        typeof block.totalBondedUsdc !== 'number'
      ) {
        throw new AgentKarmaMalformedResponseError(
          'Bond response missing bonds block',
          { response: raw },
        );
      }
      return block as unknown as BondBlock;
    },

    async getSuretyKarma(chain, wallet, opts) {
      assertChain(chain);
      assertWalletForChain(wallet, chain);
      const path = `/api/v2/bond/${chain}/${encodeURIComponent(wallet)}`;
      const res = await request<BondResponse>(cfg, path, { method: 'GET' }, opts);
      // Surety is allowed to be absent (the wallet may never have underwritten).
      // Surface null rather than throw — caller decides.
      return res?.surety ?? null;
    },

    async submitFeedback(input, opts) {
      if (!input || typeof input !== 'object') {
        throw new AgentKarmaValidationError('feedback submission must be an object');
      }
      if (!input.agentWallet || !input.txSignature || !input.signature || !input.message) {
        throw new AgentKarmaValidationError(
          'feedback submission requires agentWallet, txSignature, signature, message',
        );
      }
      if (input.rating !== 'delivered' && input.rating !== 'failed') {
        throw new AgentKarmaValidationError(`rating must be 'delivered' or 'failed'`);
      }
      const res = await request<FeedbackSubmissionResponse>(
        cfg,
        '/api/feedback',
        {
          method: 'POST',
          body: JSON.stringify(input),
          headers: { 'Content-Type': 'application/json' },
        },
        opts,
      );
      if (res?.success !== true) {
        throw new AgentKarmaMalformedResponseError(
          'Feedback submission response missing success flag',
          { response: res },
        );
      }
      return res;
    },
  };
}

/**
 * Lightweight runtime validation. We only assert presence of the load-bearing
 * fields — the rest stays opaque so the server can evolve safely.
 */
function validateKarmaSnapshot(snap: unknown): asserts snap is KarmaSnapshot {
  if (!snap || typeof snap !== 'object') {
    throw new AgentKarmaMalformedResponseError('Karma snapshot is not an object', { response: snap });
  }
  const s = snap as Record<string, unknown>;
  if (typeof s.address !== 'string') {
    throw new AgentKarmaMalformedResponseError('Karma snapshot missing address', { response: snap });
  }
  if (typeof s.face !== 'string') {
    throw new AgentKarmaMalformedResponseError('Karma snapshot missing face', { response: snap });
  }
  if (typeof s.autonomy !== 'object' || s.autonomy === null) {
    throw new AgentKarmaMalformedResponseError('Karma snapshot missing autonomy block', { response: snap });
  }
}

// Re-export the top-level error class so consumers can write a single
// instanceof check without importing the errors module separately.
export { AgentKarmaError };
