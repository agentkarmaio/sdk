import { describe, expect, it } from 'bun:test';
import {
  AgentKarmaMalformedResponseError,
  AgentKarmaNotFoundError,
  AgentKarmaValidationError,
  createAgentKarmaClient,
  type BondResponse,
  type SuccessionResponse,
} from '../src/index.js';

const SOLANA_WALLET = '4VRzfgGq8VkUH8PFiwzD3dDYkGNijvA1MCkP6Zwn8eYn';
const EVM_WALLET = '0xCfc0A11C75519FAf85B7872E27733CFaa4295b96';
const STELLAR_WALLET = 'GBSAMPLEADDRESSTHATISNOTBASE58SOLANAKEYAAAAAAAAAAAAA';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function successionResponse(
  overrides: Partial<SuccessionResponse['succession']> = {},
): SuccessionResponse {
  return {
    chain: 'solana',
    address: SOLANA_WALLET,
    succession: {
      status: 'live',
      declaredStatus: 'declared',
      sourceType: 'self_hosted',
      intervalSeconds: 86_400,
      heirCount: 1,
      heirs: [{ address: EVM_WALLET, chain: 'celo' }],
      willHash: null,
      declaredAt: '2026-06-01T00:00:00.000Z',
      lastHeartbeatAt: '2026-06-14T00:00:00.000Z',
      secondsSinceHeartbeat: 3600,
      deadlineAt: '2026-06-15T00:00:00.000Z',
      lapsedAt: null,
      executedAt: null,
      revokedAt: null,
      ...overrides,
    },
  };
}

function bondResponse(overrides: Partial<BondResponse> = {}): BondResponse {
  return {
    chain: 'arc',
    address: EVM_WALLET,
    bonds: {
      open: [
        {
          id: 'b1',
          beneficiary: EVM_WALLET,
          taskRef: 'task-1',
          amount: 500,
          currency: 'USDC',
          status: 'open',
          escrowRef: 'demo-escrow-arc-1',
          resolutionProofTx: null,
          isDemo: false,
          openedAt: '2026-06-10T00:00:00.000Z',
          resolvedAt: null,
        },
      ],
      resolved: [],
      totalBondedUsdc: 500,
      hasDemo: false,
    },
    surety: {
      score: 72,
      label: 'reliable',
      settledCount: 3,
      successCount: 3,
      inFlightCount: 0,
      totalCount: 3,
    },
    ...overrides,
  };
}

describe('getSuccessionStatus', () => {
  it('unwraps the succession block on 200', async () => {
    const ak = createAgentKarmaClient({ fetch: async () => jsonResponse(successionResponse()) });
    const view = await ak.getSuccessionStatus('solana', SOLANA_WALLET);
    expect(view.status).toBe('live');
    expect(view.intervalSeconds).toBe(86_400);
    expect(view.heirs[0]?.chain).toBe('celo');
  });

  it('targets /api/v2/succession/{chain}/{wallet} with the explicit chain', async () => {
    let url: string | undefined;
    const ak = createAgentKarmaClient({
      fetch: async (input) => {
        url = String(input);
        return jsonResponse(successionResponse({ status: 'declared' }));
      },
    });
    await ak.getSuccessionStatus('celo', EVM_WALLET);
    expect(url).toContain('/api/v2/succession/celo/');
    expect(url).toContain(encodeURIComponent(EVM_WALLET));
  });

  it('bypasses Solana validation for EVM / Stellar wallets (does not auto-detect chain)', async () => {
    let called = false;
    const ak = createAgentKarmaClient({
      fetch: async () => {
        called = true;
        return jsonResponse(successionResponse({ status: 'live' }));
      },
    });
    await ak.getSuccessionStatus('arc', EVM_WALLET);
    await ak.getSuccessionStatus('stellar', STELLAR_WALLET);
    expect(called).toBe(true);
  });

  it('still validates Solana wallet shape when chain === solana', async () => {
    const ak = createAgentKarmaClient({ fetch: async () => jsonResponse(successionResponse()) });
    await expect(ak.getSuccessionStatus('solana', '0xnotsolana')).rejects.toBeInstanceOf(
      AgentKarmaValidationError,
    );
  });

  it('rejects an unknown chain locally before requesting', async () => {
    let called = false;
    const ak = createAgentKarmaClient({
      fetch: async () => {
        called = true;
        return jsonResponse(successionResponse());
      },
    });
    await expect(
      ak.getSuccessionStatus('ethereum' as never, EVM_WALLET),
    ).rejects.toBeInstanceOf(AgentKarmaValidationError);
    expect(called).toBe(false);
  });

  it('throws AgentKarmaNotFoundError on 404 (no plan declared)', async () => {
    const ak = createAgentKarmaClient({
      fetch: async () => jsonResponse({ error: 'No succession plan declared' }, { status: 404 }),
    });
    await expect(ak.getSuccessionStatus('solana', SOLANA_WALLET)).rejects.toBeInstanceOf(
      AgentKarmaNotFoundError,
    );
  });

  it('throws AgentKarmaMalformedResponseError when succession block is missing', async () => {
    const ak = createAgentKarmaClient({
      fetch: async () => jsonResponse({ chain: 'solana', address: SOLANA_WALLET }),
    });
    await expect(ak.getSuccessionStatus('solana', SOLANA_WALLET)).rejects.toBeInstanceOf(
      AgentKarmaMalformedResponseError,
    );
  });
});

describe('getBondStatus', () => {
  it('returns the bonds block on 200', async () => {
    const ak = createAgentKarmaClient({ fetch: async () => jsonResponse(bondResponse()) });
    const block = await ak.getBondStatus('arc', EVM_WALLET);
    expect(block.open).toHaveLength(1);
    expect(block.totalBondedUsdc).toBe(500);
    expect(block.hasDemo).toBe(false);
  });

  it('targets /api/v2/bond/{chain}/{wallet} with the explicit chain', async () => {
    let url: string | undefined;
    const ak = createAgentKarmaClient({
      fetch: async (input) => {
        url = String(input);
        return jsonResponse(bondResponse({ chain: 'stellar', address: STELLAR_WALLET }));
      },
    });
    await ak.getBondStatus('stellar', STELLAR_WALLET);
    expect(url).toContain('/api/v2/bond/stellar/');
  });

  it('throws AgentKarmaMalformedResponseError when bonds block is missing', async () => {
    const ak = createAgentKarmaClient({
      fetch: async () => jsonResponse({ chain: 'arc', address: EVM_WALLET, surety: null }),
    });
    await expect(ak.getBondStatus('arc', EVM_WALLET)).rejects.toBeInstanceOf(
      AgentKarmaMalformedResponseError,
    );
  });

  it('rejects an unknown chain locally', async () => {
    const ak = createAgentKarmaClient({ fetch: async () => jsonResponse(bondResponse()) });
    await expect(ak.getBondStatus('base' as never, EVM_WALLET)).rejects.toBeInstanceOf(
      AgentKarmaValidationError,
    );
  });
});

describe('getSuretyKarma', () => {
  it('returns the surety block when present', async () => {
    const ak = createAgentKarmaClient({ fetch: async () => jsonResponse(bondResponse()) });
    const surety = await ak.getSuretyKarma('arc', EVM_WALLET);
    expect(surety?.label).toBe('reliable');
    expect(surety?.successCount).toBe(3);
  });

  it('returns null when the wallet never underwrote', async () => {
    const ak = createAgentKarmaClient({
      fetch: async () => jsonResponse(bondResponse({ surety: null })),
    });
    const surety = await ak.getSuretyKarma('arc', EVM_WALLET);
    expect(surety).toBeNull();
  });

  it('rejects an unknown chain locally', async () => {
    const ak = createAgentKarmaClient({ fetch: async () => jsonResponse(bondResponse()) });
    await expect(ak.getSuretyKarma('xrpl' as never, EVM_WALLET)).rejects.toBeInstanceOf(
      AgentKarmaValidationError,
    );
  });
});
