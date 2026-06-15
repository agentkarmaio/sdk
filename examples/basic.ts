/**
 * Runnable basic example.
 *
 *   bun run examples/basic.ts <solana-wallet-or-celo-agent-id>
 *
 * Defaults to AgentKarma's own Celo agentId (9058) when no argument given,
 * which always resolves on production.
 */

import {
  createAgentKarmaClient,
  evaluateTrust,
  AgentKarmaError,
} from '../src/index.js';

async function main() {
  const ak = createAgentKarmaClient();
  const arg = process.argv[2];

  // Heuristic: if the arg parses as a small positive integer, treat it as a
  // Celo agentId. Otherwise treat as a Solana wallet.
  const asNumber = Number(arg);
  if (arg && Number.isInteger(asNumber) && asNumber > 0) {
    console.log(`→ Looking up Celo agent ${asNumber}…`);
    try {
      const agent = await ak.getCeloAgent(asNumber);
      console.log(`  name:       ${agent.registration?.name ?? '(unnamed)'}`);
      console.log(`  owner:      ${agent.owner}`);
      console.log(`  tokenURI:   ${agent.tokenURI.slice(0, 60)}…`);
      console.log(`  reputation: ${agent.reputation?.count ?? 0} records, avg=${agent.reputation?.average ?? '—'}`);
      console.log(`  explorer:   ${agent.explorer.eightthousandfourscan}`);
    } catch (err) {
      if (err instanceof AgentKarmaError) {
        console.error(`✖ ${err.name}: ${err.message}`);
      } else throw err;
    }
    return;
  }

  const wallet = arg ?? '4VRzfgGq8VkUH8PFiwzD3dDYkGNijvA1MCkP6Zwn8eYn';
  console.log(`→ Looking up Solana karma for ${wallet}…`);
  try {
    const snap = await ak.getKarma(wallet);
    console.log(`  provider score:    ${snap.provider?.score ?? '—'} (${snap.provider?.trustTier ?? '—'})`);
    console.log(`  consumer score:    ${snap.consumer?.score ?? '—'} (${snap.consumer?.trustTier ?? '—'})`);
    console.log(`  confidence badge:  ${snap.provider?.confidenceBadge ?? '—'}`);
    console.log(`  autonomy label:    ${snap.autonomy.label ?? '—'} (score ${snap.autonomy.score ?? '—'})`);
    console.log(`  tx count:          ${snap.txCount}`);

    const decision = evaluateTrust(snap, {
      minScore: 60,
      requireReceiptBacked: true,
      minTxCount: 5,
    });
    console.log('');
    console.log(`Trust decision: ${decision.allowed ? '✓ allowed' : '✖ rejected'}`);
    if (!decision.allowed) {
      for (const r of decision.reasons) console.log(`  - ${r}`);
    }
  } catch (err) {
    if (err instanceof AgentKarmaError) {
      console.error(`✖ ${err.name}: ${err.message}`);
    } else throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
