import { describe, expect, it } from 'bun:test';
import {
  AgentKarmaError,
  AgentKarmaMalformedResponseError,
  AgentKarmaNetworkError,
  AgentKarmaNotFoundError,
  AgentKarmaRateLimitError,
  AgentKarmaServerError,
  AgentKarmaTimeoutError,
  AgentKarmaValidationError,
  createAgentKarmaClient,
  type KarmaSnapshot,
} from '../src/index.js';

// Valid Solana-style base58 address: 44 chars, excludes 0/O/I/l per BASE58 alphabet.
const VALID_WALLET = '4VRzfgGq8VkUH8PFiwzD3dDYkGNijvA1MCkP6Zwn8eYn';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function fullSnapshot(overrides: Partial<KarmaSnapshot> = {}): KarmaSnapshot {
  return {
    address: VALID_WALLET,
    face: 'both',
    identity: { claimed: false },
    txCount: 12,
    lastActive: '2026-06-01T00:00:00.000Z',
    provider: {
      score: 78,
      trustTier: 'Good',
      confidenceBadge: 'receipt-backed',
      metrics: { success_rate: 0.95, diversity: 0.4 },
      tierAggregates: { tier1: 0.8, tier2: 0.6, tier3: null, tier4: null },
      hasSignal: true,
    },
    consumer: {
      score: 55,
      trustTier: 'Fair',
      confidenceBadge: 'behavior-inferred',
      metrics: { success_rate: 0.7 },
      tierAggregates: { tier1: null, tier2: 0.7, tier3: null, tier4: null },
      hasSignal: true,
    },
    autonomy: {
      score: 82,
      label: 'agent-like',
      signals: { cadence: 0.9 },
      effectiveWeights: { cadence: 1 },
      txCount: 12,
      lastUpdated: '2026-06-01T00:00:00.000Z',
    },
    ...overrides,
  };
}

describe('createAgentKarmaClient', () => {
  it('returns a client with the configured baseUrl', () => {
    const ak = createAgentKarmaClient({ baseUrl: 'https://example.test' });
    expect(ak.baseUrl).toBe('https://example.test');
  });

  it('trims trailing slashes from baseUrl', () => {
    const ak = createAgentKarmaClient({ baseUrl: 'https://example.test///' });
    expect(ak.baseUrl).toBe('https://example.test');
  });

  it('defaults baseUrl to https://agentkarma.io', () => {
    const ak = createAgentKarmaClient();
    expect(ak.baseUrl).toBe('https://agentkarma.io');
  });
});

describe('getKarma', () => {
  it('returns a parsed snapshot on 200', async () => {
    const snap = fullSnapshot();
    const ak = createAgentKarmaClient({
      fetch: async () => jsonResponse(snap),
    });
    const result = await ak.getKarma(VALID_WALLET);
    expect(result.address).toBe(VALID_WALLET);
    expect(result.provider?.score).toBe(78);
    expect(result.autonomy.label).toBe('agent-like');
  });

  it('passes face=provider in the URL when face is specified', async () => {
    let capturedUrl: string | undefined;
    const ak = createAgentKarmaClient({
      fetch: async (input) => {
        capturedUrl = String(input);
        return jsonResponse(fullSnapshot({ face: 'provider', consumer: undefined }));
      },
    });
    await ak.getKarma(VALID_WALLET, { face: 'provider' });
    expect(capturedUrl).toContain('/api/v2/score/');
    expect(capturedUrl).toContain('face=provider');
  });

  it('rejects invalid wallets locally before requesting', async () => {
    let called = false;
    const ak = createAgentKarmaClient({
      fetch: async () => {
        called = true;
        return jsonResponse({});
      },
    });
    await expect(ak.getKarma('not-a-wallet')).rejects.toBeInstanceOf(AgentKarmaValidationError);
    expect(called).toBe(false);
  });

  it('throws AgentKarmaNotFoundError on 404', async () => {
    const ak = createAgentKarmaClient({
      fetch: async () => jsonResponse({ error: 'Wallet not found' }, { status: 404 }),
    });
    await expect(ak.getKarma(VALID_WALLET)).rejects.toBeInstanceOf(AgentKarmaNotFoundError);
  });

  it('throws AgentKarmaRateLimitError with retryAfter on 429', async () => {
    const ak = createAgentKarmaClient({
      fetch: async () =>
        jsonResponse({ error: 'too many' }, { status: 429, headers: { 'retry-after': '30' } }),
    });
    try {
      await ak.getKarma(VALID_WALLET);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentKarmaRateLimitError);
      expect((err as AgentKarmaRateLimitError).retryAfter).toBe(30);
    }
  });

  it('throws AgentKarmaServerError on 500', async () => {
    const ak = createAgentKarmaClient({
      fetch: async () => jsonResponse({ error: 'database down' }, { status: 500 }),
    });
    await expect(ak.getKarma(VALID_WALLET)).rejects.toBeInstanceOf(AgentKarmaServerError);
  });

  it('throws AgentKarmaMalformedResponseError when JSON does not match shape', async () => {
    const ak = createAgentKarmaClient({
      fetch: async () => jsonResponse({ totally: 'wrong' }),
    });
    await expect(ak.getKarma(VALID_WALLET)).rejects.toBeInstanceOf(AgentKarmaMalformedResponseError);
  });

  it('throws AgentKarmaMalformedResponseError when body is not JSON', async () => {
    const ak = createAgentKarmaClient({
      fetch: async () =>
        new Response('plain text', { status: 200, headers: { 'content-type': 'text/plain' } }),
    });
    await expect(ak.getKarma(VALID_WALLET)).rejects.toBeInstanceOf(AgentKarmaMalformedResponseError);
  });

  it('throws AgentKarmaNetworkError when fetch rejects', async () => {
    const ak = createAgentKarmaClient({
      fetch: async () => {
        throw new Error('connection refused');
      },
    });
    await expect(ak.getKarma(VALID_WALLET)).rejects.toBeInstanceOf(AgentKarmaNetworkError);
  });

  it('all errors are AgentKarmaError instances', async () => {
    const ak = createAgentKarmaClient({
      fetch: async () => jsonResponse({ error: 'x' }, { status: 500 }),
    });
    try {
      await ak.getKarma(VALID_WALLET);
    } catch (err) {
      expect(err).toBeInstanceOf(AgentKarmaError);
    }
  });

  it('honors a per-request timeout', async () => {
    const ak = createAgentKarmaClient({
      timeout: 50,
      fetch: (_url, init) =>
        new Promise<Response>((resolve, reject) => {
          const sig = init?.signal as AbortSignal | undefined;
          if (sig) sig.addEventListener('abort', () => reject(new Error('aborted')));
          setTimeout(() => resolve(jsonResponse({})), 5000);
        }),
    });
    await expect(ak.getKarma(VALID_WALLET)).rejects.toBeInstanceOf(AgentKarmaTimeoutError);
  });
});

describe('getProviderKarma / getConsumerKarma', () => {
  it('returns just the provider face', async () => {
    const ak = createAgentKarmaClient({
      fetch: async () =>
        jsonResponse(fullSnapshot({ face: 'provider', consumer: undefined })),
    });
    const p = await ak.getProviderKarma(VALID_WALLET);
    expect(p.score).toBe(78);
    expect(p.confidenceBadge).toBe('receipt-backed');
  });

  it('returns null when consumer face is absent', async () => {
    const ak = createAgentKarmaClient({
      fetch: async () =>
        jsonResponse(fullSnapshot({ face: 'consumer', consumer: undefined })),
    });
    const c = await ak.getConsumerKarma(VALID_WALLET);
    expect(c).toBeNull();
  });
});

describe('getCeloAgent', () => {
  it('parses a valid Celo agent response', async () => {
    const body = {
      chain: 'celo',
      agentId: 9058,
      owner: '0xCfc0A11C75519FAf85B7872E27733CFaa4295b96',
      agentWallet: '0xCfc0A11C75519FAf85B7872E27733CFaa4295b96',
      tokenURI: 'https://agentkarma.io/.well-known/agent.json',
      registration: { name: 'AgentKarma' },
      reputation: { count: 0, average: null, records: [] },
      explorer: { celoscan: 'https://celoscan.io/x', eightthousandfourscan: 'https://8004scan.io/x' },
    };
    const ak = createAgentKarmaClient({ fetch: async () => jsonResponse(body) });
    const result = await ak.getCeloAgent(9058);
    expect(result.agentId).toBe(9058);
    expect(result.registration?.name).toBe('AgentKarma');
  });

  it('rejects non-integer agentIds locally', async () => {
    const ak = createAgentKarmaClient({ fetch: async () => jsonResponse({}) });
    await expect(ak.getCeloAgent(1.5)).rejects.toBeInstanceOf(AgentKarmaValidationError);
    await expect(ak.getCeloAgent(0)).rejects.toBeInstanceOf(AgentKarmaValidationError);
    await expect(ak.getCeloAgent(-1)).rejects.toBeInstanceOf(AgentKarmaValidationError);
  });
});

describe('searchAgents', () => {
  it('returns results on success', async () => {
    const ak = createAgentKarmaClient({
      fetch: async () =>
        jsonResponse({
          results: [{ address: VALID_WALLET, score: 70, trustTier: 'Good', txCount: 5 }],
        }),
    });
    const r = await ak.searchAgents('Agent');
    expect(r.results).toHaveLength(1);
    expect(r.results[0]?.address).toBe(VALID_WALLET);
  });

  it('rejects short queries locally', async () => {
    const ak = createAgentKarmaClient({ fetch: async () => jsonResponse({}) });
    await expect(ak.searchAgents('ab')).rejects.toBeInstanceOf(AgentKarmaValidationError);
  });
});

describe('getFeedbackSummary', () => {
  it('returns the summary object', async () => {
    const ak = createAgentKarmaClient({
      fetch: async () =>
        jsonResponse({ total: 10, delivered: 9, failed: 1, deliveryRate: 0.9 }),
    });
    const s = await ak.getFeedbackSummary(VALID_WALLET);
    expect(s.total).toBe(10);
    expect(s.deliveryRate).toBeCloseTo(0.9);
  });

  it('throws AgentKarmaMalformedResponseError when shape is wrong', async () => {
    const ak = createAgentKarmaClient({
      fetch: async () => jsonResponse({ summary: 'no total' }),
    });
    await expect(ak.getFeedbackSummary(VALID_WALLET)).rejects.toBeInstanceOf(
      AgentKarmaMalformedResponseError,
    );
  });
});

describe('submitFeedback', () => {
  it('validates required fields locally', async () => {
    const ak = createAgentKarmaClient({ fetch: async () => jsonResponse({}) });
    await expect(
      ak.submitFeedback({
        agentWallet: '',
        rating: 'delivered',
        txSignature: '',
        signature: '',
        message: '',
      }),
    ).rejects.toBeInstanceOf(AgentKarmaValidationError);
  });

  it('rejects invalid ratings locally', async () => {
    const ak = createAgentKarmaClient({ fetch: async () => jsonResponse({}) });
    await expect(
      ak.submitFeedback({
        agentWallet: 'a',
        rating: 'pending' as never,
        txSignature: 'b',
        signature: 'c',
        message: 'd',
      }),
    ).rejects.toBeInstanceOf(AgentKarmaValidationError);
  });

  it('POSTs JSON and returns the success body', async () => {
    let capturedInit: RequestInit | undefined;
    const ak = createAgentKarmaClient({
      fetch: async (_url, init) => {
        capturedInit = init;
        return jsonResponse({
          success: true,
          agentWallet: 'agent',
          consumerWallet: 'consumer',
          rating: 'delivered',
          txSignature: 'sig',
        });
      },
    });
    const r = await ak.submitFeedback({
      agentWallet: 'agent',
      rating: 'delivered',
      txSignature: 'sig',
      signature: 'b58sig',
      message: 'AgentKarma: Feedback delivered for sig at 1',
    });
    expect(r.success).toBe(true);
    expect(capturedInit?.method).toBe('POST');
    expect(capturedInit?.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });
});
