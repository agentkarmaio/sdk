import { describe, expect, it } from 'bun:test';
import {
  AgentKarmaValidationError,
  evaluateTrust,
  type BondBlock,
  type BondView,
  type KarmaSnapshot,
  type SuccessionView,
} from '../src/index.js';

function liveSuccession(overrides: Partial<SuccessionView> = {}): SuccessionView {
  return {
    status: 'live',
    declaredStatus: 'declared',
    sourceType: 'self_hosted',
    intervalSeconds: 86_400,
    heirCount: 1,
    heirs: [{ address: 'HeirWallet', chain: 'solana' }],
    willHash: null,
    declaredAt: '2026-06-01T00:00:00Z',
    lastHeartbeatAt: '2026-06-14T00:00:00Z',
    secondsSinceHeartbeat: 3600,
    deadlineAt: '2026-06-15T00:00:00Z',
    lapsedAt: null,
    executedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function bondView(overrides: Partial<BondView> = {}): BondView {
  return {
    id: 'bond-1',
    beneficiary: 'Beneficiary',
    taskRef: null,
    amount: 500,
    currency: 'USDC',
    status: 'open',
    escrowRef: 'escrow-1',
    resolutionProofTx: null,
    isDemo: false,
    openedAt: '2026-06-10T00:00:00Z',
    resolvedAt: null,
    ...overrides,
  };
}

function bondBlock(overrides: Partial<BondBlock> = {}): BondBlock {
  return {
    open: [bondView()],
    resolved: [],
    totalBondedUsdc: 500,
    hasDemo: false,
    ...overrides,
  };
}

function snap(overrides: Partial<KarmaSnapshot> = {}): KarmaSnapshot {
  return {
    address: 'Agent1',
    face: 'both',
    identity: { claimed: false },
    txCount: 25,
    lastActive: '2026-06-01T00:00:00Z',
    provider: {
      score: 78,
      trustTier: 'Good',
      confidenceBadge: 'receipt-backed',
      metrics: null,
      tierAggregates: { tier1: 0.8, tier2: 0.6, tier3: null, tier4: null },
      hasSignal: true,
    },
    consumer: {
      score: 50,
      trustTier: 'Fair',
      confidenceBadge: 'behavior-inferred',
      metrics: null,
      tierAggregates: { tier1: null, tier2: 0.5, tier3: null, tier4: null },
      hasSignal: true,
    },
    autonomy: {
      score: 80,
      label: 'agent-like',
      signals: null,
      effectiveWeights: null,
      txCount: 25,
      lastUpdated: '2026-06-01T00:00:00Z',
    },
    ...overrides,
  };
}

describe('evaluateTrust', () => {
  it('allows on default policy when no gates configured', () => {
    const d = evaluateTrust(snap());
    expect(d.allowed).toBe(true);
    expect(d.reasons).toEqual([]);
    expect(d.observed.face).toBe('provider');
    expect(d.observed.tiers.tier1).toBe(true);
  });

  it('rejects when provider score is below minScore', () => {
    const d = evaluateTrust(snap(), { minScore: 90 });
    expect(d.allowed).toBe(false);
    expect(d.reasons.some((r) => r.includes('minScore=90'))).toBe(true);
  });

  it('uses consumer face when policy.face === consumer', () => {
    const d = evaluateTrust(snap(), { face: 'consumer', minScore: 70 });
    expect(d.allowed).toBe(false);
    expect(d.observed.face).toBe('consumer');
    expect(d.reasons.some((r) => r.includes('consumer score 50'))).toBe(true);
  });

  it('rejects on confidence badge not in allowlist', () => {
    const d = evaluateTrust(snap(), {
      acceptedConfidenceBadges: ['receipt-backed'],
      face: 'consumer',
    });
    expect(d.allowed).toBe(false);
    expect(d.reasons.some((r) => r.includes('acceptedConfidenceBadges'))).toBe(true);
  });

  it('accepts when confidence badge is in allowlist', () => {
    const d = evaluateTrust(snap(), { acceptedConfidenceBadges: ['receipt-backed'] });
    expect(d.allowed).toBe(true);
  });

  it('rejects on insufficient txCount', () => {
    const d = evaluateTrust(snap({ txCount: 2 }), { minTxCount: 10 });
    expect(d.allowed).toBe(false);
    expect(d.reasons.some((r) => r.includes('minTxCount=10'))).toBe(true);
  });

  it('rejects when required tier is missing', () => {
    const d = evaluateTrust(snap(), { requireTiers: [3] });
    expect(d.allowed).toBe(false);
    expect(d.reasons.some((r) => r.includes('Tier 3'))).toBe(true);
  });

  it('accepts when all required tiers are present', () => {
    const d = evaluateTrust(snap(), { requireTiers: [1, 2] });
    expect(d.allowed).toBe(true);
  });

  it('rejects with requireReceiptBacked when no tier1 signal', () => {
    const noT1 = snap({
      provider: {
        score: 30,
        trustTier: 'Poor',
        confidenceBadge: 'declared',
        metrics: null,
        tierAggregates: { tier1: null, tier2: null, tier3: 0.2, tier4: null },
        hasSignal: false,
      },
    });
    const d = evaluateTrust(noT1, { requireReceiptBacked: true });
    expect(d.allowed).toBe(false);
    expect(d.reasons.some((r) => r.includes('requireReceiptBacked'))).toBe(true);
  });

  it('rejects on autonomy label match', () => {
    const d = evaluateTrust(snap(), { rejectAutonomyLabels: ['agent-like'] });
    expect(d.allowed).toBe(false);
    expect(d.reasons.some((r) => r.includes('rejectAutonomyLabels'))).toBe(true);
  });

  it('rejects on low autonomy score', () => {
    const d = evaluateTrust(snap(), { minAutonomyScore: 90 });
    expect(d.allowed).toBe(false);
    expect(d.reasons.some((r) => r.includes('minAutonomyScore'))).toBe(true);
  });

  it('rejects with requireSeen when lastActive is null', () => {
    const d = evaluateTrust(snap({ lastActive: null }), { requireSeen: true });
    expect(d.allowed).toBe(false);
    expect(d.reasons.some((r) => r.includes('requireSeen'))).toBe(true);
  });

  it('aggregates multiple reasons', () => {
    const d = evaluateTrust(snap(), {
      minScore: 95,
      requireTiers: [3, 4],
      rejectAutonomyLabels: ['agent-like'],
    });
    expect(d.allowed).toBe(false);
    expect(d.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it('observed reflects what was actually read', () => {
    const d = evaluateTrust(snap());
    expect(d.observed.providerScore).toBe(78);
    expect(d.observed.consumerScore).toBe(50);
    expect(d.observed.autonomyLabel).toBe('agent-like');
    expect(d.observed.tiers.tier1).toBe(true);
    expect(d.observed.tiers.tier3).toBe(false);
  });

  it('throws on missing snapshot', () => {
    expect(() => evaluateTrust(null as unknown as KarmaSnapshot)).toThrow(AgentKarmaValidationError);
  });

  it('throws on invalid face in policy', () => {
    expect(() =>
      evaluateTrust(snap(), { face: 'invalid' as never }),
    ).toThrow(AgentKarmaValidationError);
  });
});

describe('evaluateTrust — succession (Dead Man\'s Switch) gates', () => {
  it('requireLiveSuccession passes for a live plan', () => {
    const d = evaluateTrust(snap({ succession: liveSuccession() }), { requireLiveSuccession: true });
    expect(d.allowed).toBe(true);
    expect(d.observed.successionStatus).toBe('live');
  });

  it('requireLiveSuccession passes for a declared plan (no lapse seen yet)', () => {
    const d = evaluateTrust(snap({ succession: liveSuccession({ status: 'declared' }) }), {
      requireLiveSuccession: true,
    });
    expect(d.allowed).toBe(true);
  });

  it('requireLiveSuccession fails when no plan is declared', () => {
    const d = evaluateTrust(snap(), { requireLiveSuccession: true });
    expect(d.allowed).toBe(false);
    expect(d.observed.successionStatus).toBeNull();
    expect(d.reasons.some((r) => r.includes('no succession plan'))).toBe(true);
  });

  it('requireLiveSuccession fails for a lapsed plan', () => {
    const d = evaluateTrust(snap({ succession: liveSuccession({ status: 'lapsed' }) }), {
      requireLiveSuccession: true,
    });
    expect(d.allowed).toBe(false);
    expect(d.reasons.some((r) => r.includes('not declared/live'))).toBe(true);
  });

  it('rejectLapsed rejects a lapsed plan', () => {
    const d = evaluateTrust(snap({ succession: liveSuccession({ status: 'lapsed' }) }), {
      rejectLapsed: true,
    });
    expect(d.allowed).toBe(false);
    expect(d.reasons.some((r) => r.includes('rejectLapsed'))).toBe(true);
  });

  it('rejectLapsed rejects a lapsing plan', () => {
    const d = evaluateTrust(snap({ succession: liveSuccession({ status: 'lapsing' }) }), {
      rejectLapsed: true,
    });
    expect(d.allowed).toBe(false);
  });

  it('rejectLapsed does NOT trip when no plan exists (no plan != lapsed)', () => {
    const d = evaluateTrust(snap(), { rejectLapsed: true });
    expect(d.allowed).toBe(true);
  });
});

describe('evaluateTrust — bonding gates', () => {
  it('requireBonded passes when an open bond exists', () => {
    const d = evaluateTrust(snap({ bond: bondBlock() }), { requireBonded: true });
    expect(d.allowed).toBe(true);
    expect(d.observed.bonded).toBe(true);
  });

  it('requireBonded fails with no bonds', () => {
    const d = evaluateTrust(snap(), { requireBonded: true });
    expect(d.allowed).toBe(false);
    expect(d.observed.bonded).toBe(false);
    expect(d.reasons.some((r) => r.includes('requireBonded'))).toBe(true);
  });

  it('minBondedUSDC passes when active non-demo USDC meets the floor', () => {
    const d = evaluateTrust(snap({ bond: bondBlock() }), { minBondedUSDC: 500 });
    expect(d.allowed).toBe(true);
    expect(d.observed.activeBondedUsdc).toBe(500);
  });

  it('minBondedUSDC EXCLUDES demo bonds from the real-money total', () => {
    const block = bondBlock({
      open: [
        bondView({ id: 'real', amount: 100, isDemo: false }),
        bondView({ id: 'demo', amount: 10_000, isDemo: true, escrowRef: 'demo-escrow-arc-1' }),
      ],
    });
    const d = evaluateTrust(snap({ bond: block }), { minBondedUSDC: 500 });
    expect(d.observed.activeBondedUsdc).toBe(100);
    expect(d.allowed).toBe(false);
    expect(d.reasons.some((r) => r.includes('minBondedUSDC=500'))).toBe(true);
  });

  it('minBondedUSDC excludes non-USDC currency from the USDC total', () => {
    const block = bondBlock({ open: [bondView({ amount: 999, currency: 'USDT' })] });
    const d = evaluateTrust(snap({ bond: block }), { minBondedUSDC: 1 });
    expect(d.observed.activeBondedUsdc).toBe(0);
    expect(d.allowed).toBe(false);
  });

  it('rejectRecentBondFailure rejects a resolved-failure bond', () => {
    const block = bondBlock({
      open: [],
      resolved: [bondView({ status: 'resolved_failure', isDemo: false })],
    });
    const d = evaluateTrust(snap({ bond: block }), { rejectRecentBondFailure: true });
    expect(d.allowed).toBe(false);
    expect(d.observed.hasRecentBondFailure).toBe(true);
    expect(d.reasons.some((r) => r.includes('rejectRecentBondFailure'))).toBe(true);
  });

  it('rejectRecentBondFailure ignores a DEMO failure', () => {
    const block = bondBlock({
      open: [],
      resolved: [bondView({ status: 'resolved_failure', isDemo: true })],
    });
    const d = evaluateTrust(snap({ bond: block }), { rejectRecentBondFailure: true });
    expect(d.observed.hasRecentBondFailure).toBe(false);
    expect(d.allowed).toBe(true);
  });

  it('ceiling discipline: a flashy bond does NOT alter the score gate', () => {
    // A thin-file agent (score 30) with a huge bond still fails minScore: a bond
    // lifts confidence/presence, never the evidence-gated trust ceiling.
    const thin = snap({
      provider: {
        score: 30,
        trustTier: 'Poor',
        confidenceBadge: 'declared',
        metrics: null,
        tierAggregates: { tier1: null, tier2: null, tier3: 0.2, tier4: null },
        hasSignal: false,
      },
      bond: bondBlock({ open: [bondView({ amount: 1_000_000, isDemo: false })] }),
    });
    const d = evaluateTrust(thin, { minScore: 70, requireBonded: true });
    expect(d.allowed).toBe(false);
    expect(d.reasons.some((r) => r.includes('minScore=70'))).toBe(true);
  });
});
