/**
 * Public types for the AgentKarma SDK.
 *
 * Response shapes mirror what `agentkarma.io/api/v2/*` returns today. The
 * server promises stability under added keys, so SDK consumers can rely on
 * the documented fields and treat extra keys as forward-compatible additions.
 */

// ─── Primitives ───────────────────────────────────────────────────────────────

/**
 * Chains AgentKarma indexes. Bonds and successions span all of them, so the
 * chain-aware methods take this explicitly rather than inferring it from the
 * address (NEVER auto-detect an EVM chain from an address — see the project
 * multi-chain invariant). Solana keeps its base58 validation; the other chains
 * are passed through to the server, which keys by the composite (chain,address).
 */
export type Chain = 'solana' | 'celo' | 'stellar' | 'arc';

/**
 * Faces of karma. A wallet always carries both, queried independently or together.
 *   provider — "If I pay this agent, will it deliver?"
 *   consumer — "If I take work from this agent, will it pay me cleanly?"
 */
export type KarmaFace = 'provider' | 'consumer';

/**
 * Confidence badge attached to every score. Indicates how the score was derived.
 *   receipt-backed   — Tier 1 receipts dominate (strongest)
 *   behavior-inferred — Tier 2 behavior dominates
 *   declared         — Tier 3 declarations only (weakest)
 */
export type ConfidenceBadge = 'receipt-backed' | 'behavior-inferred' | 'declared';

/**
 * Trust tier ladder. Computed from raw score; useful for coarse-grained
 * display when the numeric score isn't needed.
 */
export type TrustTier = 'Unrated' | 'Poor' | 'Fair' | 'Good' | 'Very Good' | 'Excellent';

/**
 * Autonomy Confidence label (RFC v0.3 §5.5). Orthogonal to karma — describes
 * whether a wallet behaves like a human, an agent, or a mix.
 */
export type AutonomyLabel = 'agent-like' | 'mixed' | 'human-like';

/**
 * Four-tier signal spectrum. Returned per face as `tierAggregates`.
 *   1 — receipt-gated attestation
 *   2 — behavioral evidence
 *   3 — declared identity + third-party attestation
 *   4 — social + derivative signals
 */
export type SignalTier = 1 | 2 | 3 | 4;

// ─── /api/v2/score/{wallet} ───────────────────────────────────────────────────

export interface KarmaIdentity {
  claimed: boolean;
  displayName?: string | null;
  description?: string | null;
  website?: string | null;
  category?: string | null;
}

export interface KarmaFaceData {
  /** 0–100 integer (server rounds before serializing). */
  score: number;
  trustTier: TrustTier | null;
  confidenceBadge: ConfidenceBadge | null;
  /** Per-face metric breakdown (success_rate, diversity, etc.). Shape evolves over time; treat as opaque map. */
  metrics: Record<string, number> | null;
  /** Per-tier aggregate values. `null` keys mean the tier had no signal for this face. */
  tierAggregates: Partial<Record<`tier${SignalTier}`, number | null>> | null;
  /** Whether this face actually has signal worth reading. False = the wallet has no evidence on this face. */
  hasSignal: boolean;
}

export interface AutonomyData {
  /** 0–100. null when no transactions exist to compute from. */
  score: number | null;
  label: AutonomyLabel | null;
  /** Per-signal contribution map. */
  signals: Record<string, number> | null;
  /** Per-signal weight after redistribution. */
  effectiveWeights: Record<string, number> | null;
  txCount: number;
  /** ISO 8601 timestamp. */
  lastUpdated: string | null;
}

/**
 * `GET /api/v2/score/{wallet}` response.
 *
 * `provider` and `consumer` are present according to the `face` query param.
 * `autonomy` ALWAYS appears (RFC invariant) regardless of which face was requested.
 */
export interface KarmaSnapshot {
  /** Wallet address as queried (case-preserved on Solana, lowercased on EVM). */
  address: string;
  /** Face requested. `'both'` means both faces are present in the response. */
  face: KarmaFace | 'both';
  identity: KarmaIdentity;
  /** Number of indexed transactions for this wallet. */
  txCount: number;
  /** ISO 8601 timestamp of most recent activity, or null when never observed. */
  lastActive: string | null;
  /** Present when face === 'provider' or 'both'. */
  provider?: KarmaFaceData;
  /** Present when face === 'consumer' or 'both'. */
  consumer?: KarmaFaceData;
  autonomy: AutonomyData;
  /**
   * Additive Dead Man's Switch block. Present only when the wallet has declared
   * a succession plan; omitted otherwise. OBSERVE-ONLY — does not lift the
   * trust ceiling. The pure `evaluateTrust()` reads it for liveness gates.
   */
  succession?: SuccessionView;
  /**
   * Additive bonding block — bonds taken out ON this agent. Present only when
   * the wallet has bonds; omitted otherwise. A bond lifts confidence + Tier
   * presence ONLY, never the evidence-gated ceiling.
   */
  bond?: BondBlock;
  /**
   * Additive orthogonal Surety Karma — this wallet's own underwriting record.
   * Present only when the wallet underwrites bonds; omitted otherwise. Never
   * folded into Provider/Consumer karma.
   */
  surety?: SuretyView;
  /**
   * Additive enrichment (server ≥ 2026-09): ERC-8004 registry agents this
   * address controls on the resolved chain. Omitted when nothing is owned or
   * the read failed. AK links to declared endpoints, never relays them.
   */
  registry?: RegistryBlock;
  /** AK's live v0.2 declared-metadata rubric for the primary registry agent. */
  declared?: DeclaredBlock;
  /** ERC-8004 feedback aggregate + newest records, from AK's registry mirror. */
  feedback?: FeedbackBlock;
  /** x402 payee discoveries recorded for this address (read-only, never probed here). */
  discovery?: DiscoveryBlock;
  /**
   * Additive revenue-independence read: how much inbound value came from
   * addresses this wallet also pays. Reported ALONGSIDE karma, never folded
   * into it. Omitted when the wallet has no observed payment flows.
   */
  independence?: IndependenceBlock;
  /** `wallets.rank_score` — what orders Explore (declared evidence ×0.7). null without a row. */
  rankScore?: number | null;
  /** Deterministic, factual sentences derived from the data above. No LLM. ≤ 10. */
  explain?: string[];
}

// ─── Enrichment blocks (additive on /api/v2/score/{wallet}, MCP get_karma, A2A) ─

export interface RegistryAgentView {
  agentId: number;
  name: string | null;
  description: string | null;
  /** inline | fetched | empty | unreachable | invalid | pending */
  registrationStatus: string;
  /** Mirror column; may predate the current rubric version. */
  metadataScore: number;
  feedbackCount: number;
  /** Declared services (≤ 10, sanitized strings). Links, not relays. */
  services: Array<{ name: string; endpoint: string }>;
  explorer: { agentkarma: string; eightthousandfourscan: string | null };
}

export interface RegistryBlock {
  /** Uncapped count of agents owned/controlled on this chain. */
  total: number;
  /** ≤ 10, metadata score descending. */
  agents: RegistryAgentView[];
}

export interface DeclaredBlock {
  /** 'agentkarma_metadata' */
  scheme: string;
  /** Rubric version, e.g. 'v0.2'. */
  version: string;
  agentId: number;
  /** 0–100, live recompute (pure function of the registration JSON + agentURI). */
  score: number;
  dimensions: Array<{ key: string; label: string; passed: boolean; points: number; max: number }>;
  notes: string[];
}

export interface FeedbackRecordView {
  agentId: number;
  client: string;
  /** raw / 10^decimals — the registry's own scale, not normalized to stars. */
  value: number;
  tag1: string;
  tag2: string;
  revoked: boolean;
  indexedAt: string;
}

export interface FeedbackBlock {
  source: 'registry-mirror';
  /** Authoritative total from the mirror's per-agent aggregates. */
  count: number;
  /** Count-weighted mean of non-revoked values; null when count is 0. */
  average: number | null;
  /** Distinct rater addresses within the sampled window. */
  distinctClients: number;
  /** Rows in the newest-first window (≤ 1000) the sample was computed over. */
  sampled: number;
  /** ISO timestamp of the newest sampled record. */
  asOf: string | null;
  /** ≤ 10 newest records. */
  records: FeedbackRecordView[];
  /** AK's own disclosed metadata attestations among the window (≤ 5). */
  validators: Array<{
    agentId: number;
    client: string;
    value: number;
    version: string;
    revoked: boolean;
    indexedAt: string;
  }>;
}

export interface DiscoveryBlock {
  /** ≤ 10. `verified: false` = declared as payTo by ANOTHER agent (not attributed to this wallet). */
  endpoints: Array<{
    endpoint: string | null;
    asset: string | null;
    network: string | null;
    verified: boolean;
    sourceAgentId: number | null;
    lastSeenAt: string;
  }>;
}

// ─── /api/v2/celo/{agentId} ───────────────────────────────────────────────────

/**
 * Agent registration JSON parsed from the agent's `agentURI`. Shape mirrors
 * ERC-8004 v1 registration-v1 schema. All fields optional in practice.
 */
export interface CeloAgentRegistration {
  type?: string;
  name?: string;
  description?: string;
  image?: string;
  x402Support?: boolean;
  active?: boolean;
  supportedTrust?: string[];
  services?: Array<{ name: string; endpoint: string; version?: string }>;
  registrations?: Array<{ agentId: number; agentRegistry: string }>;
  [key: string]: unknown;
}

export interface CeloFeedbackRecord {
  client: string;
  value: number;
  tag1: string;
  tag2: string;
  revoked: boolean;
}

export interface CeloAgentReputation {
  count: number;
  /** Mean of unrevoked feedback values, null when count === 0. */
  average: number | null;
  records: CeloFeedbackRecord[];
}

export interface CeloAgentSnapshot {
  chain: 'celo';
  agentId: number;
  /** ERC-721 owner = the registry NFT owner. */
  owner: string;
  /** Operational wallet (may equal `owner` unless `setAgentWallet` was used). */
  agentWallet: string;
  /** Raw `tokenURI` as stored on-chain. May be `https://…`, `data:…`, `ipfs://…`. */
  tokenURI: string;
  registration: CeloAgentRegistration | null;
  /** Set when registration JSON could not be fetched or parsed. */
  registrationError?: string;
  reputation: CeloAgentReputation | null;
  explorer: {
    celoscan: string;
    eightthousandfourscan: string;
  };
}

// ─── Dead Man's Switch (succession) + Agent Bonding + Surety ───────────────────
//
// These mirror the OBSERVE-ONLY projections served by
// `/api/v2/succession/{chain}/{wallet}` and `/api/v2/bond/{chain}/{wallet}`, and
// are also embedded additively on `/api/v2/score/{wallet}`.
//
// AgentKarma never holds funds, never operates an escrow, never executes a will,
// never proxies calls. None of these fields imply custody. A bond or a declared
// will lifts an agent's confidence badge + Tier presence ONLY — it MUST NOT lift
// the evidence-gated trust ceiling. Surety Karma is an ORTHOGONAL axis and is
// never folded into Provider/Consumer karma.

/**
 * Lifecycle of a declared succession plan.
 *   declared — will registered, heartbeat not yet evaluated
 *   live     — heartbeat within interval, agent healthy
 *   lapsing  — approaching the deadline (warning band)
 *   lapsed   — interval exceeded, succession conditions met
 *   executed — inheritance transfer observed on-chain
 *   revoked  — owner cancelled the will
 */
export type SuccessionStatus =
  | 'declared'
  | 'live'
  | 'lapsing'
  | 'lapsed'
  | 'executed'
  | 'revoked';

/** Lifecycle of an agent bond. */
export type BondStatus = 'open' | 'resolved_success' | 'resolved_failure' | 'expired';

/** Surety Karma coarse label (orthogonal axis). */
export type SuretyLabel = 'reliable' | 'mixed' | 'unproven';

/** A single heir in a declared will. */
export interface SuccessionHeir {
  address: string;
  chain: Chain;
  /** Optional split weight. */
  share?: number | null;
  label?: string | null;
}

/**
 * `GET /api/v2/succession/{chain}/{wallet}` → `.succession`, also embedded as
 * `KarmaSnapshot.succession`. AK's OBSERVED heartbeat is `lastHeartbeatAt` (the
 * last meaningful tx) — AK never receives a real heartbeat ping.
 */
export interface SuccessionView {
  /** Live derived status (liveness overrides the stored value). */
  status: SuccessionStatus;
  /** Stored status straight from the row (terminal facts vs derived liveness). */
  declaredStatus: SuccessionStatus;
  sourceType: string;
  intervalSeconds: number;
  heirCount: number;
  heirs: SuccessionHeir[];
  /** Witness anchor for a future on-chain will; null in the no-contract MVP. */
  willHash: string | null;
  declaredAt: string;
  /** AK's OBSERVED heartbeat (last meaningful tx), null when none seen. */
  lastHeartbeatAt: string | null;
  secondsSinceHeartbeat: number | null;
  /** lastHeartbeat + interval — when the agent next reads lapsing. */
  deadlineAt: string | null;
  lapsedAt: string | null;
  executedAt: string | null;
  revokedAt: string | null;
}

/** `GET /api/v2/succession/{chain}/{wallet}` full response. */
export interface SuccessionResponse {
  chain: Chain;
  address: string;
  succession: SuccessionView;
}

/** A single bond taken out ON an agent. `isDemo` rows are seeded — UI MUST label them. */
export interface BondView {
  id: string;
  beneficiary: string;
  taskRef: string | null;
  amount: number;
  currency: string;
  status: BondStatus;
  escrowRef: string;
  resolutionProofTx: string | null;
  /** Seeded/demo row — not a real on-chain bond. */
  isDemo: boolean;
  openedAt: string;
  resolvedAt: string | null;
}

/** Bonds taken out ON an agent, split open vs resolved. */
export interface BondBlock {
  open: BondView[];
  resolved: BondView[];
  /** Sum of `amount` across USDC-denominated bonds only. */
  totalBondedUsdc: number;
  /** True when any bond in this block is a seeded demo. */
  hasDemo: boolean;
}

/** Orthogonal Surety Karma for a wallet that underwrites OTHER agents' bonds. */
export interface SuretyView {
  score: number;
  label: SuretyLabel;
  settledCount: number;
  successCount: number;
  inFlightCount: number;
  totalCount: number;
}

/** `GET /api/v2/bond/{chain}/{wallet}` full response. */
export interface BondResponse {
  chain: Chain;
  address: string;
  /** Bonds taken out on this agent. */
  bonds: BondBlock;
  /** This wallet's underwriting activity + orthogonal Surety Karma (null if none). */
  surety: SuretyView | null;
}

// ─── /api/search ──────────────────────────────────────────────────────────────

export interface SearchResult {
  address: string;
  score: number;
  trustTier: TrustTier;
  txCount: number;
}

export interface SearchResponse {
  results: SearchResult[];
}

// ─── /api/agent/{wallet}/history ──────────────────────────────────────────────

export interface AgentHistoryTransaction {
  id: string;
  facilitator: string;
  amount: number;
  timestamp: string;
  success: boolean;
  txSignature: string;
  /** Consumer-submitted feedback for this tx, or null. */
  feedback: 'delivered' | 'failed' | null;
}

export interface AgentHistoryResponse {
  address: string;
  total: number;
  limit: number;
  offset: number;
  transactions: AgentHistoryTransaction[];
}

// ─── /api/feedback ────────────────────────────────────────────────────────────

export interface FeedbackSummary {
  total: number;
  delivered: number;
  failed: number;
  /** Float in [0, 1]. 0 when total === 0. */
  deliveryRate: number;
}

export type FeedbackRating = 'delivered' | 'failed';

export interface FeedbackSubmission {
  agentWallet: string;
  rating: FeedbackRating;
  txSignature: string;
  /** Base58-encoded Ed25519 signature from the consumer's Solana wallet. */
  signature: string;
  /** The exact message that was signed. Build via `buildFeedbackMessage()`. */
  message: string;
}

export interface FeedbackSubmissionResponse {
  success: true;
  agentWallet: string;
  consumerWallet: string;
  rating: FeedbackRating;
  txSignature: string;
}

// ─── Client config ────────────────────────────────────────────────────────────

export interface RequestOptions {
  /** Per-request abort signal, composed with the client's default timeout. */
  signal?: AbortSignal;
  /** Per-request timeout override (ms). Overrides client-level timeout. */
  timeout?: number;
  /** Extra headers to merge into this single request. */
  headers?: Record<string, string>;
}

/**
 * Minimal `fetch` shape the SDK relies on. Looser than `typeof fetch` so any
 * function returning a `Promise<Response>` can be passed in — useful for
 * tests, proxies, retries, edge runtimes where `preconnect` etc. don't exist.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ClientConfig {
  /** Base URL for the AgentKarma API. Defaults to https://agentkarma.io. */
  baseUrl?: string;
  /** Custom fetch implementation (testing, proxies, retries). Defaults to global `fetch`. */
  fetch?: FetchLike;
  /** Default request timeout in milliseconds. Defaults to 10000. */
  timeout?: number;
  /** Default headers merged into every request. */
  headers?: Record<string, string>;
  /**
   * Custom user-agent. Defaults to `@agentkarma/sdk/{version}`. Set this to
   * identify your application in AgentKarma's request logs.
   */
  userAgent?: string;
}

/**
 * Revenue independence — the "is this revenue real, or is the operator paying
 * itself?" read. Additive; it never changes Provider or Consumer karma.
 *
 * `verdict: 'insufficient-data'` means AK cannot see enough payee data to
 * decide. It does NOT mean independent, and MUST NOT be treated as a pass by an
 * underwriting caller. Check `coverage` when you need to know why.
 */
export interface IndependenceBlock {
  /** Share (0-1) of inbound value from addresses this wallet also pays. Null when undecidable. */
  reciprocalShare: number | null;
  /** `1 - reciprocalShare`. Null when undecidable. */
  independentShare: number | null;
  verdict: 'independent' | 'mixed' | 'circular' | 'insufficient-data';
  /** Distinct addresses observed paying this wallet. */
  payerCount: number;
  /** How many of those the wallet also pays. */
  reciprocalPayerCount: number;
  /** Share (0-1) of this wallet's outbound payments that carry an identified payee. */
  coverage: number;
  /** How many payment records the reading was computed over — the denominator
   *  behind `payerCount`. Weigh a 2-payment verdict differently to a 200-payment one. */
  observedPayments: number;
  /** True when the figures come from a recent window rather than the wallet's whole history. */
  windowed: boolean;
  /**
   * Which Stellar network the figures came from, when AgentKarma read them live
   * from Horizon rather than from indexed rows. Present only for that path.
   *
   * Check it. A `chain: 'stellar'` request does not guarantee mainnet: an
   * account absent from mainnet is resolved on testnet instead, and acting on
   * testnet figures as though they were real money is the failure this whole
   * block exists to prevent.
   */
  network?: 'pubnet' | 'testnet';
}
