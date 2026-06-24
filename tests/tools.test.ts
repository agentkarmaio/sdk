import { describe, expect, it } from 'bun:test';
import {
  agentKarmaTools,
  agentKarmaToolNames,
  getAgentKarmaTool,
  runAgentKarmaTool,
} from '../src/tools.js';
import { AgentKarmaValidationError } from '../src/errors.js';
import type { AgentKarmaClient } from '../src/client.js';
import type { KarmaSnapshot } from '../src/types.js';

const SOLANA_WALLET = '4VRzfgGq8VkUH8PFiwzD3dDYkGNijvA1MCkP6Zwn8eYn';
const CELO_WALLET = '0xCfc0A11C75519FAf85B7872E27733CFaa4295b96';

const SNAP: KarmaSnapshot = {
  address: SOLANA_WALLET,
  face: 'both',
  identity: { claimed: false },
  txCount: 5,
  lastActive: '2026-06-20T00:00:00.000Z',
  provider: {
    score: 50,
    trustTier: 'Fair',
    confidenceBadge: 'behavior-inferred',
    metrics: null,
    tierAggregates: { tier1: null, tier2: 0.5, tier3: null, tier4: null },
    hasSignal: true,
  },
  consumer: {
    score: 60,
    trustTier: 'Good',
    confidenceBadge: 'behavior-inferred',
    metrics: null,
    tierAggregates: { tier1: null, tier2: 0.6, tier3: null, tier4: null },
    hasSignal: true,
  },
  autonomy: {
    score: 80,
    label: 'agent-like',
    signals: {},
    effectiveWeights: {},
    txCount: 5,
    lastUpdated: null,
  },
};

interface Call {
  method: string;
  args: unknown[];
}

/** Minimal client that records calls and returns canned values. */
function fakeClient(): { client: AgentKarmaClient; calls: Call[] } {
  const calls: Call[] = [];
  const rec =
    (method: string, ret: unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(ret);
    };
  const client = {
    baseUrl: 'https://agentkarma.io',
    getKarma: rec('getKarma', SNAP),
    getProviderKarma: rec('getProviderKarma', SNAP.provider),
    getConsumerKarma: rec('getConsumerKarma', SNAP.consumer),
    getCeloAgent: rec('getCeloAgent', { chain: 'celo', agentId: 9058 }),
    searchAgents: rec('searchAgents', { results: [] }),
    getAgentHistory: rec('getAgentHistory', { transactions: [] }),
    getFeedbackSummary: rec('getFeedbackSummary', { total: 0 }),
    getSuccessionStatus: rec('getSuccessionStatus', { status: 'live' }),
    getBondStatus: rec('getBondStatus', { open: [], resolved: [] }),
    getSuretyKarma: rec('getSuretyKarma', null),
    submitFeedback: rec('submitFeedback', { success: true }),
  } as unknown as AgentKarmaClient;
  return { client, calls };
}

const EXPECTED = [
  'get_karma',
  'get_celo_agent',
  'search_agents',
  'get_agent_history',
  'get_feedback_summary',
  'get_succession',
  'get_bond',
  'get_surety',
  'check_trust',
];

describe('agentKarma tool catalog', () => {
  it('exposes the expected read tools and no write tools', () => {
    const names = agentKarmaToolNames();
    expect(new Set(names)).toEqual(new Set(EXPECTED));
    expect(names).not.toContain('submit_feedback');
    expect(new Set(names).size).toBe(names.length);
  });

  it('every tool is a read-only, idempotent, open-world JSON-Schema tool', () => {
    for (const tool of agentKarmaTools) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(Array.isArray(tool.inputSchema.required)).toBe(true);
      expect(typeof tool.description).toBe('string');
      // snake_case property keys.
      const props = tool.inputSchema.properties as Record<string, unknown>;
      for (const key of Object.keys(props)) {
        expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
  });

  it('get_karma pins the chain/face it was given and defaults face to both', async () => {
    const { client, calls } = fakeClient();
    await runAgentKarmaTool(client, 'get_karma', { wallet: CELO_WALLET, chain: 'celo' });
    expect(calls[0]).toEqual({
      method: 'getKarma',
      args: [CELO_WALLET, { chain: 'celo', face: 'both' }],
    });

    calls.length = 0;
    await runAgentKarmaTool(client, 'get_karma', { wallet: SOLANA_WALLET, face: 'provider' });
    expect(calls[0]).toEqual({
      method: 'getKarma',
      args: [SOLANA_WALLET, { chain: undefined, face: 'provider' }],
    });
  });

  it('get_celo_agent coerces a stringy agent_id to a number', async () => {
    const { client, calls } = fakeClient();
    await runAgentKarmaTool(client, 'get_celo_agent', { agent_id: '9058' });
    expect(calls[0]).toEqual({ method: 'getCeloAgent', args: [9058] });
  });

  it('chain-scoped tools require an explicit chain', async () => {
    const { client, calls } = fakeClient();
    await runAgentKarmaTool(client, 'get_bond', { chain: 'celo', wallet: CELO_WALLET });
    expect(calls[0]).toEqual({ method: 'getBondStatus', args: ['celo', CELO_WALLET] });

    await expect(
      runAgentKarmaTool(client, 'get_succession', { wallet: SOLANA_WALLET }),
    ).rejects.toThrow(AgentKarmaValidationError);
    await expect(
      runAgentKarmaTool(client, 'get_surety', { chain: 'bogus', wallet: SOLANA_WALLET }),
    ).rejects.toThrow(AgentKarmaValidationError);
  });

  it('check_trust fetches both faces and returns an explainable decision', async () => {
    const { client, calls } = fakeClient();
    const result = (await runAgentKarmaTool(client, 'check_trust', {
      wallet: SOLANA_WALLET,
      min_score: 90,
      require_receipt_backed: true,
    })) as {
      wallet: string;
      chain: string;
      decision: { allowed: boolean; reasons: string[] };
      snapshot: KarmaSnapshot;
    };

    // Snapshot is always fetched with both faces.
    expect(calls[0]).toEqual({
      method: 'getKarma',
      args: [SOLANA_WALLET, { chain: undefined, face: 'both' }],
    });
    expect(result.wallet).toBe(SOLANA_WALLET);
    expect(result.chain).toBe('solana');
    expect(result.snapshot.address).toBe(SOLANA_WALLET);
    // provider score 50 < 90, and provider has no Tier-1 receipt signal.
    expect(result.decision.allowed).toBe(false);
    expect(result.decision.reasons.some((r) => r.includes('minScore'))).toBe(true);
    expect(result.decision.reasons.some((r) => r.includes('requireReceiptBacked'))).toBe(true);
  });

  it('get_karma and check_trust reject an out-of-enum chain instead of downgrading', async () => {
    const { client } = fakeClient();
    await expect(
      runAgentKarmaTool(client, 'get_karma', { wallet: CELO_WALLET, chain: 'polygon' }),
    ).rejects.toThrow(AgentKarmaValidationError);
    await expect(
      runAgentKarmaTool(client, 'check_trust', { wallet: SOLANA_WALLET, chain: 'ethereum' }),
    ).rejects.toThrow(AgentKarmaValidationError);
  });

  it('clamps limits to the advertised maximum', async () => {
    const { client, calls } = fakeClient();
    await runAgentKarmaTool(client, 'search_agents', { query: 'abcd', limit: 1000 });
    expect((calls[0]!.args[1] as { limit: number }).limit).toBe(50);

    calls.length = 0;
    await runAgentKarmaTool(client, 'get_agent_history', { wallet: SOLANA_WALLET, limit: 9999 });
    expect((calls[0]!.args[1] as { limit: number }).limit).toBe(200);
  });

  it('dispatches the remaining handlers with coerced, correctly-ordered args', async () => {
    const ARC_WALLET = '0x1111111111111111111111111111111111111111';
    const cases: Array<{ tool: string; input: Record<string, unknown>; expected: { method: string; args: unknown[] } }> = [
      { tool: 'search_agents', input: { query: 'abcd', limit: '5' }, expected: { method: 'searchAgents', args: ['abcd', { limit: 5 }] } },
      { tool: 'get_agent_history', input: { wallet: SOLANA_WALLET, limit: '20', offset: '40' }, expected: { method: 'getAgentHistory', args: [SOLANA_WALLET, { limit: 20, offset: 40 }] } },
      { tool: 'get_feedback_summary', input: { wallet: SOLANA_WALLET }, expected: { method: 'getFeedbackSummary', args: [SOLANA_WALLET] } },
      { tool: 'get_succession', input: { chain: 'celo', wallet: CELO_WALLET }, expected: { method: 'getSuccessionStatus', args: ['celo', CELO_WALLET] } },
      { tool: 'get_surety', input: { chain: 'arc', wallet: ARC_WALLET }, expected: { method: 'getSuretyKarma', args: ['arc', ARC_WALLET] } },
    ];
    for (const c of cases) {
      const { client, calls } = fakeClient();
      await runAgentKarmaTool(client, c.tool, c.input);
      expect(calls[0], c.tool).toEqual(c.expected);
    }
  });

  it('check_trust ALLOWS when the policy passes (no false-deny)', async () => {
    const { client } = fakeClient();
    const result = (await runAgentKarmaTool(client, 'check_trust', { wallet: SOLANA_WALLET })) as {
      decision: { allowed: boolean; reasons: string[] };
    };
    expect(result.decision.allowed).toBe(true);
    expect(result.decision.reasons).toEqual([]);
  });

  it('check_trust maps every snake_case policy arg, coercing strings', async () => {
    const { client } = fakeClient();
    const run = (input: Record<string, unknown>) =>
      runAgentKarmaTool(client, 'check_trust', { wallet: SOLANA_WALLET, ...input }) as Promise<{
        decision: { allowed: boolean; reasons: string[] };
      }>;

    // face selection: SNAP provider=50, consumer=60. min_score 55 denies on
    // provider but ALLOWS on consumer — proves input.face reaches policy.face.
    expect((await run({ face: 'consumer', min_score: 55 })).decision.allowed).toBe(true);
    expect((await run({ face: 'provider', min_score: 55 })).decision.allowed).toBe(false);

    // min_tx_count → policy.minTxCount (SNAP.txCount = 5).
    expect((await run({ min_tx_count: 5 })).decision.allowed).toBe(true);
    expect((await run({ min_tx_count: 6 })).decision.allowed).toBe(false);

    // min_autonomy_score → policy.minAutonomyScore (SNAP.autonomy.score = 80).
    expect((await run({ min_autonomy_score: 90 })).decision.allowed).toBe(false);

    // require_live_succession as the STRING 'true' (asOptionalBoolean coercion);
    // SNAP has no succession block → must deny.
    const stringBool = await run({ require_live_succession: 'true' });
    expect(stringBool.decision.allowed).toBe(false);
    expect(stringBool.decision.reasons.some((r) => r.includes('requireLiveSuccession'))).toBe(true);
  });

  it('runAgentKarmaTool rejects for an unknown tool', async () => {
    const { client } = fakeClient();
    await expect(runAgentKarmaTool(client, 'nope')).rejects.toThrow(AgentKarmaValidationError);
    expect(getAgentKarmaTool('nope')).toBeUndefined();
  });
});
