/**
 * End-to-end: drive the AgentKarma MCP server over the real MCP protocol via an
 * in-memory transport pair. Proves tools/list and tools/call actually work on
 * the wire — not just that the pieces construct.
 */
import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgentKarmaMcpServer } from '../src/mcp.js';
import { agentKarmaToolNames } from '../src/tools.js';
import type { AgentKarmaClient } from '../src/client.js';

const SOLANA_WALLET = '4VRzfgGq8VkUH8PFiwzD3dDYkGNijvA1MCkP6Zwn8eYn';

const fakeClient = {
  baseUrl: 'https://agentkarma.io',
  getKarma: (wallet: string) =>
    Promise.resolve({ address: wallet, face: 'both', provider: { score: 73 } }),
} as unknown as AgentKarmaClient;

async function connectedClient(akClient: AgentKarmaClient = fakeClient): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createAgentKarmaMcpServer({ client: akClient });
  await server.connect(serverTransport);
  const client = new Client({ name: 'agentkarma-e2e', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('AgentKarma MCP server (protocol round-trip)', () => {
  it('lists every catalog tool over tools/list', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(agentKarmaToolNames().sort());
    const getKarma = tools.find((t) => t.name === 'get_karma');
    expect(getKarma?.inputSchema.type).toBe('object');
    await client.close();
  });

  it('calls get_karma over tools/call and returns the snapshot', async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: 'get_karma',
      arguments: { wallet: SOLANA_WALLET },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0]!.text) as { address: string; provider: { score: number } };
    expect(payload.address).toBe(SOLANA_WALLET);
    expect(payload.provider.score).toBe(73);
    await client.close();
  });

  it('surfaces an unknown tool as a clean isError result', async () => {
    const client = await connectedClient();
    // The handler guards unknown names, so the server returns a tidy isError
    // result rather than crashing the protocol.
    const result = await client.callTool({ name: 'no_such_tool', arguments: {} });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]!.text).error).toBe('unknown_tool');
    await client.close();
  });

  it('round-trips a handler failure as a clean isError without leaking detail', async () => {
    const original = console.error;
    console.error = () => {}; // catch-all logs server-side; keep output clean
    try {
      const failing = {
        baseUrl: 'https://agentkarma.io',
        getKarma: () => Promise.reject(new Error('ECONNREFUSED 10.0.0.5:5432 internal')),
      } as unknown as AgentKarmaClient;
      const client = await connectedClient(failing);
      const result = await client.callTool({
        name: 'get_karma',
        arguments: { wallet: SOLANA_WALLET },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain('ECONNREFUSED');
      // The channel survives — a second call still works.
      const list = await client.listTools();
      expect(list.tools.length).toBeGreaterThan(0);
      await client.close();
    } finally {
      console.error = original;
    }
  });
});
