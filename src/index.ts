/**
 * @agentkarma/sdk — public entry point.
 *
 * AgentKarma is the reputation layer for autonomous on-chain agents.
 * This SDK lets you query Provider Karma and Consumer Karma, look up
 * ERC-8004 agents on Celo, and gate execution on a local trust policy.
 *
 * Non-routing: this SDK never proxies, signs, or executes transactions on
 * your behalf. It reads from agentkarma.io and answers trust-check questions
 * locally.
 *
 * Quick start:
 *
 *   import { createAgentKarmaClient, evaluateTrust } from '@agentkarma/sdk';
 *   const ak = createAgentKarmaClient();
 *   const snap = await ak.getKarma('Agent5VR…wallet…');
 *   const decision = evaluateTrust(snap, { minScore: 60, requireReceiptBacked: true });
 *   if (!decision.allowed) console.warn('reject:', decision.reasons);
 */

export { createAgentKarmaClient } from './client.js';
export type { AgentKarmaClient } from './client.js';

export {
  AgentKarmaError,
  AgentKarmaValidationError,
  AgentKarmaNotFoundError,
  AgentKarmaRateLimitError,
  AgentKarmaTimeoutError,
  AgentKarmaNetworkError,
  AgentKarmaMalformedResponseError,
  AgentKarmaServerError,
} from './errors.js';

export { evaluateTrust } from './policy.js';
export type { TrustPolicy, TrustDecision, TrustObserved } from './policy.js';

export { buildFeedbackMessage } from './feedback.js';
export type { BuildFeedbackMessageInput, BuiltFeedbackMessage } from './feedback.js';

export type {
  // Primitives
  Chain,
  KarmaFace,
  ConfidenceBadge,
  TrustTier,
  AutonomyLabel,
  SignalTier,
  // Karma snapshot
  KarmaSnapshot,
  KarmaIdentity,
  KarmaFaceData,
  AutonomyData,
  // Dead Man's Switch + Bonding + Surety
  SuccessionStatus,
  SuccessionHeir,
  SuccessionView,
  SuccessionResponse,
  BondStatus,
  BondView,
  BondBlock,
  BondResponse,
  SuretyLabel,
  SuretyView,
  // Celo
  CeloAgentSnapshot,
  CeloAgentRegistration,
  CeloAgentReputation,
  CeloFeedbackRecord,
  // Search
  SearchResult,
  SearchResponse,
  // History
  AgentHistoryResponse,
  AgentHistoryTransaction,
  // Feedback
  FeedbackSummary,
  FeedbackRating,
  FeedbackSubmission,
  FeedbackSubmissionResponse,
  // Client config
  ClientConfig,
  RequestOptions,
} from './types.js';
