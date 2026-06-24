/**
 * @agentkarma/sdk/tools — framework-agnostic MCP tool catalog.
 *
 * One canonical, dependency-free description of AgentKarma's read surface as
 * MCP-style tools. Each descriptor carries a JSON Schema (draft-07) input
 * contract and a `handler` that runs against an `AgentKarmaClient` — so the
 * SAME catalog can be mounted on any MCP server (`@agentkarma/sdk/mcp`), wired
 * into another agent framework, or called directly.
 *
 * These are READ tools only. They never sign, never execute a transaction,
 * never proxy a call (non-routing, RFC §12). The one write in the SDK —
 * `submitFeedback` — needs a wallet signature and is intentionally NOT exposed
 * here, so an MCP server built from this catalog requires no keys.
 *
 * Zero runtime dependencies: schemas are plain JSON Schema objects, not Zod, so
 * importing this module pulls nothing extra into a client-only consumer.
 */

import type { AgentKarmaClient } from './client.js';
import { AgentKarmaValidationError } from './errors.js';
import { evaluateTrust, type TrustPolicy } from './policy.js';
import type { Chain, KarmaFace } from './types.js';

/** MCP tool annotations (subset of the MCP spec) describing tool behaviour. */
export interface AgentKarmaToolAnnotations {
  /** The tool does not modify state. Always true here. */
  readOnlyHint: true;
  /** Repeated calls with the same args yield the same result. Always true here. */
  idempotentHint: true;
  /** The tool reads from an external service (agentkarma.io). Always true here. */
  openWorldHint: true;
}

/** A JSON Schema (draft-07) object — kept loose to avoid a schema-lib dependency. */
export type JSONSchema = Record<string, unknown>;

/**
 * A single AgentKarma tool: its MCP advertisement (name/title/description/schema)
 * plus a handler that executes it against an `AgentKarmaClient`.
 */
export interface AgentKarmaToolDescriptor {
  /** Stable tool name (snake_case), e.g. `get_karma`. */
  name: string;
  /** Human-readable title for tool pickers. */
  title: string;
  /** What the tool does and when to use it. */
  description: string;
  /** JSON Schema (draft-07) for the tool's arguments. */
  inputSchema: JSONSchema;
  /** MCP behaviour hints. */
  annotations: AgentKarmaToolAnnotations;
  /** Execute the tool against a client. Returns plain JSON-serializable data. */
  handler: (
    client: AgentKarmaClient,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
}

const READ_ONLY: AgentKarmaToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

const SUPPORTED_CHAINS = ['solana', 'celo', 'stellar', 'arc'] as const;

// ─── Reusable schema fragments ──────────────────────────────────────────────

const walletProp: JSONSchema = {
  type: 'string',
  description:
    'On-chain agent wallet address (Solana base58, Stellar G-address, or EVM 0x address).',
};

/** Solana-only endpoints (history, feedback) reject non-base58 addresses. */
const solanaWalletProp: JSONSchema = {
  type: 'string',
  description:
    'Solana agent wallet address (base58, 32–44 chars). This endpoint is Solana-only.',
};

const optionalChainProp: JSONSchema = {
  type: 'string',
  enum: [...SUPPORTED_CHAINS],
  description:
    "Chain for the lookup. Defaults to 'solana'. Pass for celo/arc/stellar wallets.",
};

const requiredChainProp: JSONSchema = {
  type: 'string',
  enum: [...SUPPORTED_CHAINS],
  description: 'Chain the wallet lives on (spans all chains; must be explicit).',
};

const faceProp: JSONSchema = {
  type: 'string',
  enum: ['provider', 'consumer', 'both'],
  description:
    "Karma face: 'provider' (will it deliver?), 'consumer' (will it pay cleanly?), or 'both' (default).",
};

function objectSchema(
  properties: Record<string, JSONSchema>,
  required: string[],
): JSONSchema {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

// ─── Input coercion helpers (handlers receive raw, possibly-stringy args) ────

function asString(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

/** Coerce an MCP arg to a number, tolerating JSON-string numbers. `undefined` passes through. */
function asOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isNaN(n) ? undefined : n;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return Boolean(value);
}

function asChain(value: unknown): Chain | undefined {
  return typeof value === 'string' && (SUPPORTED_CHAINS as readonly string[]).includes(value)
    ? (value as Chain)
    : undefined;
}

function asFace(value: unknown): KarmaFace | 'both' | undefined {
  return value === 'provider' || value === 'consumer' || value === 'both'
    ? value
    : undefined;
}

/**
 * Resolve an OPTIONAL chain argument: `undefined` when absent, the validated
 * chain otherwise. Unlike a bare `asChain`, a present-but-invalid value throws
 * rather than silently downgrading to the client's 'solana' default — so
 * `chain: 'polygon'` fails loudly instead of returning a wrong Solana lookup.
 */
function resolveOptionalChain(value: unknown): Chain | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const chain = asChain(value);
  if (!chain) {
    throw new AgentKarmaValidationError(
      `chain must be one of ${SUPPORTED_CHAINS.join(', ')}`,
    );
  }
  return chain;
}

/** Clamp an optional limit to the tool's advertised [1, max] bound. */
function clampLimit(value: unknown, max: number): number | undefined {
  const n = asOptionalNumber(value);
  if (n === undefined) return undefined;
  return Math.min(Math.max(1, Math.trunc(n)), max);
}

// ─── The catalog ─────────────────────────────────────────────────────────────

export const agentKarmaTools: AgentKarmaToolDescriptor[] = [
  {
    name: 'get_karma',
    title: 'Get Karma (both faces)',
    description:
      'Look up the full two-faced Karma snapshot for an agent wallet — provider score, consumer score, confidence badge, autonomy, identity. Use BEFORE paying an agent or accepting work from one.',
    inputSchema: objectSchema(
      { wallet: walletProp, chain: optionalChainProp, face: faceProp },
      ['wallet'],
    ),
    annotations: READ_ONLY,
    handler: (client, input) =>
      client.getKarma(asString(input.wallet), {
        chain: resolveOptionalChain(input.chain),
        face: asFace(input.face) ?? 'both',
      }),
  },
  {
    name: 'get_celo_agent',
    title: 'Get Celo agent (ERC-8004)',
    description:
      'Resolve a Celo ERC-8004 agent by numeric agentId: IdentityRegistry record (owner, agentURI, declared services) plus aggregate ReputationRegistry feedback.',
    inputSchema: objectSchema(
      {
        agent_id: {
          type: 'integer',
          minimum: 1,
          description: 'ERC-8004 agentId on Celo mainnet (positive integer).',
        },
      },
      ['agent_id'],
    ),
    annotations: READ_ONLY,
    handler: (client, input) => client.getCeloAgent(Number(input.agent_id)),
  },
  {
    name: 'search_agents',
    title: 'Search agents',
    description:
      'Find agents by a substring of their display name or wallet address (case-insensitive), ranked by score. Returns up to `limit` results.',
    inputSchema: objectSchema(
      {
        query: {
          type: 'string',
          minLength: 3,
          description: 'Name or wallet-address substring (≥3 chars).',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Max results (1–50, clamped to 50).',
        },
      },
      ['query'],
    ),
    annotations: READ_ONLY,
    handler: (client, input) =>
      client.searchAgents(asString(input.query), {
        limit: clampLimit(input.limit, 50),
      }),
  },
  {
    name: 'get_agent_history',
    title: 'Get agent payment history',
    description:
      "Paginated x402 payment history for a Solana agent wallet, with each transaction's consumer feedback rating. Solana-only today.",
    inputSchema: objectSchema(
      {
        wallet: solanaWalletProp,
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Page size (1–200, clamped to 200).',
        },
        offset: { type: 'integer', minimum: 0, description: 'Page offset.' },
      },
      ['wallet'],
    ),
    annotations: READ_ONLY,
    handler: (client, input) =>
      client.getAgentHistory(asString(input.wallet), {
        limit: clampLimit(input.limit, 200),
        offset: asOptionalNumber(input.offset),
      }),
  },
  {
    name: 'get_feedback_summary',
    title: 'Get feedback summary',
    description:
      'Aggregate delivered/failed counts and delivery rate for a Solana agent wallet.',
    inputSchema: objectSchema({ wallet: solanaWalletProp }, ['wallet']),
    annotations: READ_ONLY,
    handler: (client, input) => client.getFeedbackSummary(asString(input.wallet)),
  },
  {
    name: 'get_succession',
    title: "Get succession plan (Dead Man's Switch)",
    description:
      "Return the agent's declared succession plan plus AgentKarma's OBSERVED heartbeat liveness (derived status, heir count, deadline). A continuity/trust signal. AgentKarma never holds a key or executes the will (non-custody). Throws not-found when no plan is declared.",
    inputSchema: objectSchema(
      { chain: requiredChainProp, wallet: walletProp },
      ['chain', 'wallet'],
    ),
    annotations: READ_ONLY,
    handler: async (client, input) => {
      const chain = asChain(input.chain);
      if (!chain) {
        throw new AgentKarmaValidationError(
          `chain must be one of ${SUPPORTED_CHAINS.join(', ')}`,
        );
      }
      return client.getSuccessionStatus(chain, asString(input.wallet));
    },
  },
  {
    name: 'get_bond',
    title: 'Get bonding status',
    description:
      'Return surety bonds taken out ON this agent (open vs resolved, total bonded USDC, demo flag). A bond lifts confidence/Tier-1 presence only — never the trust ceiling. Returns an empty block when the agent has no bonds.',
    inputSchema: objectSchema(
      { chain: requiredChainProp, wallet: walletProp },
      ['chain', 'wallet'],
    ),
    annotations: READ_ONLY,
    handler: async (client, input) => {
      const chain = asChain(input.chain);
      if (!chain) {
        throw new AgentKarmaValidationError(
          `chain must be one of ${SUPPORTED_CHAINS.join(', ')}`,
        );
      }
      return client.getBondStatus(chain, asString(input.wallet));
    },
  },
  {
    name: 'get_surety',
    title: 'Get Surety Karma',
    description:
      "Return this wallet's ORTHOGONAL Surety Karma from underwriting OTHER agents' bonds (score, settled/success/in-flight counts). Never folded into Provider/Consumer karma. Returns null when the wallet has never underwritten.",
    inputSchema: objectSchema(
      { chain: requiredChainProp, wallet: walletProp },
      ['chain', 'wallet'],
    ),
    annotations: READ_ONLY,
    handler: async (client, input) => {
      const chain = asChain(input.chain);
      if (!chain) {
        throw new AgentKarmaValidationError(
          `chain must be one of ${SUPPORTED_CHAINS.join(', ')}`,
        );
      }
      return client.getSuretyKarma(chain, asString(input.wallet));
    },
  },
  {
    name: 'check_trust',
    title: 'Check trust before executing',
    description:
      'Fetch an agent\'s Karma and evaluate a local trust policy against it — the "should I trust this agent before paying?" gate. Returns an explainable allow/deny decision plus the snapshot it read. Pure local evaluation: no routing, no signing.',
    inputSchema: objectSchema(
      {
        wallet: walletProp,
        chain: optionalChainProp,
        face: {
          type: 'string',
          enum: ['provider', 'consumer'],
          description: 'Face to score the decision on (default provider).',
        },
        min_score: {
          type: 'integer',
          minimum: 0,
          maximum: 100,
          description: 'Reject when the face score is below this.',
        },
        require_receipt_backed: {
          type: 'boolean',
          description: 'Require at least one Tier-1 receipt-backed signal.',
        },
        min_tx_count: {
          type: 'integer',
          minimum: 0,
          description: 'Require at least this many indexed transactions.',
        },
        min_autonomy_score: {
          type: 'integer',
          minimum: 0,
          maximum: 100,
          description: 'Require autonomy score at or above this.',
        },
        require_live_succession: {
          type: 'boolean',
          description: 'Require a live (declared/live) succession plan.',
        },
      },
      ['wallet'],
    ),
    annotations: READ_ONLY,
    handler: async (client, input) => {
      const wallet = asString(input.wallet);
      const chain = resolveOptionalChain(input.chain);
      const policy: TrustPolicy = {};
      const face = input.face;
      if (face === 'provider' || face === 'consumer') policy.face = face;
      const minScore = asOptionalNumber(input.min_score);
      if (minScore !== undefined) policy.minScore = minScore;
      const requireReceipt = asOptionalBoolean(input.require_receipt_backed);
      if (requireReceipt !== undefined) policy.requireReceiptBacked = requireReceipt;
      const minTx = asOptionalNumber(input.min_tx_count);
      if (minTx !== undefined) policy.minTxCount = minTx;
      const minAutonomy = asOptionalNumber(input.min_autonomy_score);
      if (minAutonomy !== undefined) policy.minAutonomyScore = minAutonomy;
      const requireLive = asOptionalBoolean(input.require_live_succession);
      if (requireLive !== undefined) policy.requireLiveSuccession = requireLive;

      const snapshot = await client.getKarma(wallet, { chain, face: 'both' });
      const decision = evaluateTrust(snapshot, policy);
      return { wallet, chain: chain ?? 'solana', decision, snapshot };
    },
  },
];

/** Look up a tool descriptor by name. */
export function getAgentKarmaTool(
  name: string,
): AgentKarmaToolDescriptor | undefined {
  return agentKarmaTools.find((t) => t.name === name);
}

/** Every tool name in the catalog. */
export function agentKarmaToolNames(): string[] {
  return agentKarmaTools.map((t) => t.name);
}

/**
 * Run a catalog tool by name against a client. Throws
 * `AgentKarmaValidationError` for an unknown tool; the client's own validation
 * governs the arguments.
 */
export async function runAgentKarmaTool(
  client: AgentKarmaClient,
  name: string,
  input: Record<string, unknown> = {},
): Promise<unknown> {
  const tool = getAgentKarmaTool(name);
  if (!tool) {
    throw new AgentKarmaValidationError(`Unknown AgentKarma tool: ${name}`);
  }
  return tool.handler(client, input);
}
