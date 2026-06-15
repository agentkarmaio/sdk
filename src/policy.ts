/**
 * Local, explainable trust policy evaluation.
 *
 * `evaluateTrust(snapshot, policy)` is the canonical `check_trust_before_execute`
 * helper. Given a karma snapshot from `client.getKarma(wallet)` and a policy
 * config, return whether the trust check passes, the human-readable reasons
 * for the decision, and exactly what was observed on the snapshot.
 *
 * This function NEVER routes, executes, signs, or persists anything. It is a
 * pure function over data. Calling it is free — no network, no side effects.
 */

import { AgentKarmaValidationError } from './errors.js';
import type {
  AutonomyLabel,
  ConfidenceBadge,
  KarmaFace,
  KarmaSnapshot,
  SignalTier,
  SuccessionStatus,
} from './types.js';

/**
 * Succession statuses that mean "the agent is still answering". `declared`
 * counts as live: the will exists but no lapse has been observed yet.
 */
const LIVE_SUCCESSION_STATUSES: ReadonlySet<SuccessionStatus> = new Set<SuccessionStatus>([
  'declared',
  'live',
]);

export interface TrustPolicy {
  /** Which face to evaluate. Defaults to 'provider'. */
  face?: KarmaFace;
  /** Reject when the chosen face's score is below this value (0-100). */
  minScore?: number;
  /** Accept only these confidence badges on the chosen face. Empty/omitted = accept all. */
  acceptedConfidenceBadges?: ConfidenceBadge[];
  /** Require at least this many on-chain transactions observed. */
  minTxCount?: number;
  /** Require non-null signal in each of these tiers (per the chosen face's tierAggregates). */
  requireTiers?: SignalTier[];
  /** Require at least one Tier-1 receipt-backed signal somewhere on the chosen face. */
  requireReceiptBacked?: boolean;
  /** Reject when the autonomy label matches one of these. (e.g. reject 'agent-like' for human-only flows.) */
  rejectAutonomyLabels?: AutonomyLabel[];
  /** Reject when the autonomy score is below this value. null autonomy is treated as failing this check. */
  minAutonomyScore?: number;
  /**
   * Reject when the wallet has never been observed active. Defaults to false —
   * a wallet with no recorded activity isn't automatically untrustworthy; the
   * face's score and confidence badge already encode that. Flip on when you
   * specifically want a "must have shown up before" gate.
   */
  requireSeen?: boolean;

  // ── Dead Man's Switch (succession) gates ──────────────────────────────────
  /**
   * Require a live succession plan. Passes only when the snapshot carries a
   * succession block whose derived status is `declared` or `live`. A missing
   * succession block fails this gate (no plan = not live). OBSERVE-ONLY: this
   * reads AK's recorded liveness; AK never receives a real heartbeat.
   */
  requireLiveSuccession?: boolean;
  /**
   * Reject when the succession plan has lapsed or is lapsing — a strong signal
   * the agent may be abandoned. A missing succession block does NOT trip this
   * (no plan ≠ lapsed); use `requireLiveSuccession` to demand a plan.
   */
  rejectLapsed?: boolean;

  // ── Agent Bonding gates ───────────────────────────────────────────────────
  /**
   * Require at least one currently-active (open) bond on the agent. Borrowed
   * capital lifts confidence, NOT the trust ceiling — this gate is about
   * presence of skin-in-the-game, evaluated independently of score.
   */
  requireBonded?: boolean;
  /**
   * Require the total USDC currently bonded (open bonds) to be at least this.
   * Demo bonds are EXCLUDED from this total — borrowed-on-paper capital must
   * not satisfy a real-money gate.
   */
  minBondedUSDC?: number;
  /**
   * Reject when the agent has a recent bond failure (`resolved_failure`). A
   * blown bond is a real negative delivery signal. Demo bonds are ignored.
   */
  rejectRecentBondFailure?: boolean;
}

export interface TrustObserved {
  face: KarmaFace;
  providerScore: number | null;
  consumerScore: number | null;
  confidenceBadge: ConfidenceBadge | null;
  txCount: number;
  /** Per-tier presence (`true` = signal present for the chosen face). */
  tiers: Record<`tier${SignalTier}`, boolean>;
  autonomyScore: number | null;
  autonomyLabel: AutonomyLabel | null;
  lastActive: string | null;
  /** Derived succession status, or null when no plan was declared. */
  successionStatus: SuccessionStatus | null;
  /** Whether the agent has at least one currently-active (open) bond. */
  bonded: boolean;
  /** Total USDC across open bonds, EXCLUDING demo bonds. */
  activeBondedUsdc: number;
  /** Whether the agent has a resolved-failure bond (demo bonds excluded). */
  hasRecentBondFailure: boolean;
}

export interface TrustDecision {
  /** Final allow/deny. False ⇒ at least one reason is populated. */
  allowed: boolean;
  /**
   * Human-readable rejection reasons. Empty array when `allowed === true`.
   * Each reason references the policy field it tripped, so callers can
   * surface them to operators or log them.
   */
  reasons: string[];
  /** Snapshot of what was observed, for logging / audit. */
  observed: TrustObserved;
}

/**
 * Evaluate a karma snapshot against a trust policy. Never throws on policy
 * mismatch — only throws on malformed inputs.
 */
export function evaluateTrust(snapshot: KarmaSnapshot, policy: TrustPolicy = {}): TrustDecision {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new AgentKarmaValidationError('snapshot is required');
  }

  const face: KarmaFace = policy.face ?? 'provider';
  if (face !== 'provider' && face !== 'consumer') {
    throw new AgentKarmaValidationError(`policy.face must be 'provider' or 'consumer'`);
  }

  const faceData = face === 'provider' ? snapshot.provider : snapshot.consumer;
  const reasons: string[] = [];

  const providerScore = snapshot.provider?.score ?? null;
  const consumerScore = snapshot.consumer?.score ?? null;
  const confidenceBadge = faceData?.confidenceBadge ?? null;
  const txCount = typeof snapshot.txCount === 'number' ? snapshot.txCount : 0;

  const tiers: TrustObserved['tiers'] = {
    tier1: hasTier(faceData?.tierAggregates, 1),
    tier2: hasTier(faceData?.tierAggregates, 2),
    tier3: hasTier(faceData?.tierAggregates, 3),
    tier4: hasTier(faceData?.tierAggregates, 4),
  };

  // Score gate. When the face has no data at all (hasSignal === false AND
  // score is 0/null), treat it as a rejection if a minimum was demanded.
  if (policy.minScore != null) {
    const observedScore = face === 'provider' ? providerScore : consumerScore;
    if (observedScore == null || observedScore < policy.minScore) {
      reasons.push(
        `policy.minScore=${policy.minScore} not met (${face} score ${observedScore ?? 'null'})`,
      );
    }
  }

  // Confidence badge allowlist.
  if (policy.acceptedConfidenceBadges && policy.acceptedConfidenceBadges.length > 0) {
    if (!confidenceBadge || !policy.acceptedConfidenceBadges.includes(confidenceBadge)) {
      reasons.push(
        `policy.acceptedConfidenceBadges does not include observed badge ${confidenceBadge ?? 'null'}`,
      );
    }
  }

  // Minimum transaction count — useful "must have shown up enough times" gate.
  if (policy.minTxCount != null && txCount < policy.minTxCount) {
    reasons.push(`policy.minTxCount=${policy.minTxCount} not met (observed txCount ${txCount})`);
  }

  // Per-tier presence requirement.
  if (policy.requireTiers && policy.requireTiers.length > 0) {
    for (const tier of policy.requireTiers) {
      if (!tiers[`tier${tier}`]) {
        reasons.push(`policy.requireTiers includes Tier ${tier}, which has no signal on ${face} face`);
      }
    }
  }

  // Receipt-backed shorthand.
  if (policy.requireReceiptBacked && !tiers.tier1) {
    reasons.push(`policy.requireReceiptBacked: ${face} face has no Tier 1 signal`);
  }

  // Autonomy gates.
  const autonomyScore = snapshot.autonomy?.score ?? null;
  const autonomyLabel = snapshot.autonomy?.label ?? null;
  if (policy.rejectAutonomyLabels && policy.rejectAutonomyLabels.length > 0) {
    if (autonomyLabel && policy.rejectAutonomyLabels.includes(autonomyLabel)) {
      reasons.push(`policy.rejectAutonomyLabels includes observed label ${autonomyLabel}`);
    }
  }
  if (policy.minAutonomyScore != null) {
    if (autonomyScore == null || autonomyScore < policy.minAutonomyScore) {
      reasons.push(
        `policy.minAutonomyScore=${policy.minAutonomyScore} not met (observed ${autonomyScore ?? 'null'})`,
      );
    }
  }

  // Liveness.
  if (policy.requireSeen && !snapshot.lastActive) {
    reasons.push('policy.requireSeen: wallet has no recorded activity');
  }

  // ── Dead Man's Switch (succession) observations + gates ───────────────────
  const successionStatus = snapshot.succession?.status ?? null;
  if (policy.requireLiveSuccession) {
    if (!successionStatus) {
      reasons.push('policy.requireLiveSuccession: no succession plan declared');
    } else if (!LIVE_SUCCESSION_STATUSES.has(successionStatus)) {
      reasons.push(
        `policy.requireLiveSuccession: succession status is ${successionStatus} (not declared/live)`,
      );
    }
  }
  if (policy.rejectLapsed && (successionStatus === 'lapsed' || successionStatus === 'lapsing')) {
    reasons.push(`policy.rejectLapsed: succession status is ${successionStatus}`);
  }

  // ── Agent Bonding observations + gates ────────────────────────────────────
  // Borrowed capital lifts confidence, NEVER the trust ceiling — these gates are
  // about presence/magnitude of skin-in-the-game, kept orthogonal to score.
  const openBonds = snapshot.bond?.open ?? [];
  const resolvedBonds = snapshot.bond?.resolved ?? [];
  const bonded = openBonds.length > 0;
  // Demo bonds are excluded from the real-money total — paper capital must not
  // satisfy a minBondedUSDC gate.
  const activeBondedUsdc = openBonds.reduce(
    (sum, b) => sum + (!b.isDemo && b.currency === 'USDC' ? b.amount : 0),
    0,
  );
  const hasRecentBondFailure = resolvedBonds.some(
    (b) => !b.isDemo && b.status === 'resolved_failure',
  );

  if (policy.requireBonded && !bonded) {
    reasons.push('policy.requireBonded: agent has no active bond');
  }
  if (policy.minBondedUSDC != null && activeBondedUsdc < policy.minBondedUSDC) {
    reasons.push(
      `policy.minBondedUSDC=${policy.minBondedUSDC} not met (active non-demo USDC bonded ${activeBondedUsdc})`,
    );
  }
  if (policy.rejectRecentBondFailure && hasRecentBondFailure) {
    reasons.push('policy.rejectRecentBondFailure: agent has a resolved-failure bond');
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    observed: {
      face,
      providerScore,
      consumerScore,
      confidenceBadge,
      txCount,
      tiers,
      autonomyScore,
      autonomyLabel,
      lastActive: snapshot.lastActive ?? null,
      successionStatus,
      bonded,
      activeBondedUsdc,
      hasRecentBondFailure,
    },
  };
}

function hasTier(
  tierAggregates: Partial<Record<`tier${SignalTier}`, number | null>> | null | undefined,
  tier: SignalTier,
): boolean {
  if (!tierAggregates) return false;
  const v = tierAggregates[`tier${tier}`];
  return v != null;
}
