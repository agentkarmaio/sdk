# @agentkarma/sdk

TypeScript SDK for [AgentKarma](https://agentkarma.io) — the reputation layer for autonomous on-chain agents.

Add a `check_trust_before_execute` step to any agent flow in under 10 minutes.

- Framework-agnostic (Node 18+, Bun, Deno, browsers, edge runtimes)
- Zero runtime dependencies
- Typed responses for the public REST API
- Local trust-policy evaluator with explainable allow/deny decisions
- MCP-ready: a framework-agnostic tool catalog (`@agentkarma/sdk/tools`) + a turnkey MCP server (`@agentkarma/sdk/mcp`, `npx agentkarma-mcp`)
- Never proxies, signs, or executes transactions on your behalf

## Install

```sh
npm install @agentkarma/sdk
# or
bun add @agentkarma/sdk
```

## Quick start — Solana karma lookup

```ts
import { createAgentKarmaClient } from '@agentkarma/sdk';

const ak = createAgentKarmaClient();
const snap = await ak.getKarma('AgentTradingBotWalletAddress…');

console.log(snap.provider?.score);          // 0–100
console.log(snap.provider?.confidenceBadge); // 'receipt-backed' | 'behavior-inferred' | 'declared'
console.log(snap.autonomy.label);            // 'agent-like' | 'mixed' | 'human-like' | null
```

## Quick start — Celo ERC-8004 lookup

```ts
import { createAgentKarmaClient } from '@agentkarma/sdk';

const ak = createAgentKarmaClient();
const agent = await ak.getCeloAgent(9058);

console.log(agent.owner);                  // 0x…
console.log(agent.registration?.name);     // declared name from the agent registration JSON
console.log(agent.reputation?.average);    // mean of unrevoked feedback values
```

## Trust-gated execution

The `evaluateTrust` helper is a pure function over a snapshot. No network. No side effects. Always returns `{ allowed, reasons, observed }`.

```ts
import { createAgentKarmaClient, evaluateTrust } from '@agentkarma/sdk';

const ak = createAgentKarmaClient();

async function shouldExecute(agentWallet: string) {
  const snap = await ak.getKarma(agentWallet);

  const decision = evaluateTrust(snap, {
    face: 'provider',
    minScore: 60,
    requireReceiptBacked: true,            // require Tier 1 signal present
    acceptedConfidenceBadges: ['receipt-backed', 'behavior-inferred'],
    minTxCount: 5,
    rejectAutonomyLabels: ['agent-like'],  // example: human-operated only
  });

  if (!decision.allowed) {
    console.warn('rejected:', decision.reasons);
    return false;
  }
  return true;
}
```

## Partner integration pattern

AgentKarma is non-routing. The SDK answers questions about reputation; it does not execute service calls or payments on your behalf. A partner (e.g. a service marketplace, x402 facilitator, agent orchestrator) preflights AgentKarma before performing its own action:

```ts
import { createAgentKarmaClient, evaluateTrust, AgentKarmaError } from '@agentkarma/sdk';

const ak = createAgentKarmaClient();

async function payAgentForService(agentWallet: string, amount: number) {
  let snap;
  try {
    snap = await ak.getKarma(agentWallet);
  } catch (err) {
    // Hard fail-open or fail-closed? Your call. Fail-closed example:
    if (err instanceof AgentKarmaError) {
      throw new Error('Trust check failed: ' + err.message);
    }
    throw err;
  }

  const decision = evaluateTrust(snap, {
    minScore: 70,
    requireReceiptBacked: true,
    minTxCount: 10,
  });

  if (!decision.allowed) {
    throw new Error(`Agent ${agentWallet} did not pass trust check: ${decision.reasons.join('; ')}`);
  }

  // Your own payment / service call goes here. AgentKarma never proxies it.
  return await yourServiceCall(agentWallet, amount);
}
```

## Submitting consumer feedback (Solana)

Feedback submission is wallet-agnostic: the SDK builds the message, you sign it externally, the SDK posts the signature.

```ts
import { createAgentKarmaClient, buildFeedbackMessage } from '@agentkarma/sdk';

const ak = createAgentKarmaClient();

// 1. Build the canonical message
const { message, timestamp } = buildFeedbackMessage({
  rating: 'delivered',
  txSignature: 'YourSolanaTxSignature',
});

// 2. Sign with your wallet (any Solana wallet adapter, web3.js, etc.)
const signature = await yourWallet.signMessage(new TextEncoder().encode(message));
const signatureBase58 = base58Encode(signature);

// 3. Submit
await ak.submitFeedback({
  agentWallet: 'AgentWalletAddress…',
  rating: 'delivered',
  txSignature: 'YourSolanaTxSignature',
  signature: signatureBase58,
  message,
});
```

The server enforces a 5-minute freshness window on the embedded timestamp.

## Configuration

```ts
const ak = createAgentKarmaClient({
  baseUrl: 'https://agentkarma.io',  // default
  timeout: 10_000,                   // default ms
  headers: { 'X-Partner': 'YourApp' },
  userAgent: 'YourApp/1.0',
  fetch: customFetch,                // optional override
});
```

Each method accepts per-call options:

```ts
await ak.getKarma(wallet, {
  face: 'provider',                  // 'provider' | 'consumer' | 'both' (default)
  signal: abortController.signal,    // request-level abort
  timeout: 3000,                     // overrides client default for this call
  headers: { 'X-Request-Id': 'abc' },
});
```

## Errors

Every error is an `AgentKarmaError` subclass:

| Class | When |
|---|---|
| `AgentKarmaValidationError` | Local argument check failed |
| `AgentKarmaNotFoundError` | Server returned 404 |
| `AgentKarmaRateLimitError` | Server returned 429 (with `retryAfter` in seconds) |
| `AgentKarmaTimeoutError` | Request deadline exceeded |
| `AgentKarmaNetworkError` | `fetch()` threw before getting a response |
| `AgentKarmaMalformedResponseError` | 2xx response body didn't match expected shape |
| `AgentKarmaServerError` | Other non-2xx response |

```ts
import { AgentKarmaError } from '@agentkarma/sdk';
try {
  await ak.getKarma(wallet);
} catch (err) {
  if (err instanceof AgentKarmaError) {
    console.error(`status=${err.status} response=`, err.response);
  }
}
```

## Public methods

| Method | Endpoint |
|---|---|
| `getKarma(wallet, { face?, … })` | `GET /api/v2/score/{wallet}?face={face}` |
| `getProviderKarma(wallet)` | shortcut for provider face only |
| `getConsumerKarma(wallet)` | shortcut for consumer face only |
| `getCeloAgent(agentId)` | `GET /api/v2/celo/{agentId}` |
| `searchAgents(query, { limit? })` | `GET /api/search?q={query}` |
| `getAgentHistory(wallet, { limit?, offset? })` | `GET /api/agent/{wallet}/history` |
| `getFeedbackSummary(wallet)` | `GET /api/feedback?agent={wallet}` |
| `submitFeedback(input)` | `POST /api/feedback` |

## MCP server & tool catalog

Expose AgentKarma's read surface to any MCP client (Claude Desktop, Cursor, Continue, …).

**Turnkey server** — run over stdio, no code:

```sh
npx agentkarma-mcp
# point at a different host:
AGENTKARMA_BASE_URL=https://staging.agentkarma.io npx agentkarma-mcp
```

**Embed the server** in your own process:

```ts
import { createAgentKarmaMcpServer } from '@agentkarma/sdk/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = createAgentKarmaMcpServer();          // backed by the public API
await server.connect(new StdioServerTransport());
```

`@agentkarma/sdk/mcp` requires the optional peer dependency `@modelcontextprotocol/sdk`
(install it only if you use the server). The core client and the tool catalog stay
dependency-free.

**Framework-agnostic catalog** — the same nine read tools as plain JSON-Schema
descriptors you can mount on any host, or run directly:

```ts
import { createAgentKarmaClient } from '@agentkarma/sdk';
import { agentKarmaTools, runAgentKarmaTool } from '@agentkarma/sdk/tools';

const ak = createAgentKarmaClient();
agentKarmaTools.map((t) => t.name);
// get_karma, get_celo_agent, search_agents, get_agent_history,
// get_feedback_summary, get_succession, get_bond, get_surety, check_trust

const result = await runAgentKarmaTool(ak, 'check_trust', {
  wallet: 'AgentWallet…',
  min_score: 60,
  require_receipt_backed: true,
});
```

Every tool is read-only, idempotent, and requires no keys. The one write
(`submitFeedback`) is intentionally excluded, so an MCP server built from this
catalog needs no signer.

## Non-routing guarantee

AgentKarma is a reputation primitive. This SDK is read-only by design. It never:
- proxies API calls or x402 payments
- signs transactions on your behalf
- holds private keys
- ratelimits or queues your traffic

You always make your own service calls. AgentKarma just answers the trust question.

## License

MIT
