import { describe, expect, it } from 'bun:test';
import {
  agentKarmaMcpTools,
  callAgentKarmaTool,
  createAgentKarmaMcpServer,
} from '../src/mcp.js';
import { agentKarmaToolNames } from '../src/tools.js';
import {
  AgentKarmaNotFoundError,
  AgentKarmaServerError,
  AgentKarmaValidationError,
} from '../src/errors.js';
import type { AgentKarmaClient } from '../src/client.js';

const SOLANA_WALLET = '4VRzfgGq8VkUH8PFiwzD3dDYkGNijvA1MCkP6Zwn8eYn';

function clientWith(overrides: Partial<AgentKarmaClient>): AgentKarmaClient {
  return { baseUrl: 'https://agentkarma.io', ...overrides } as AgentKarmaClient;
}

function parse(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

describe('agentKarmaMcpTools', () => {
  it('advertises every catalog tool as a JSON-Schema MCP tool', () => {
    const tools = agentKarmaMcpTools();
    expect(tools.map((t) => t.name).sort()).toEqual(agentKarmaToolNames().sort());
    for (const t of tools) {
      expect(typeof t.description).toBe('string');
      expect((t.inputSchema as { type?: string }).type).toBe('object');
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
  });
});

describe('callAgentKarmaTool', () => {
  it('returns a text CallToolResult for a successful read', async () => {
    const client = clientWith({
      getKarma: () => Promise.resolve({ address: SOLANA_WALLET, face: 'both' } as never),
    });
    const result = await callAgentKarmaTool(client, 'get_karma', { wallet: SOLANA_WALLET });
    expect(result.isError).toBeFalsy();
    const block = result.content[0] as { type: string; text: string };
    expect(block.type).toBe('text');
    expect(parse(block.text).address).toBe(SOLANA_WALLET);
  });

  it('maps a not-found error to a clean not_found tool error', async () => {
    const client = clientWith({
      getKarma: () => Promise.reject(new AgentKarmaNotFoundError('missing')),
    });
    const result = await callAgentKarmaTool(client, 'get_karma', { wallet: SOLANA_WALLET });
    expect(result.isError).toBe(true);
    expect(parse((result.content[0] as { text: string }).text).error).toBe('not_found');
  });

  it('echoes validation messages (caller-fixable) as invalid_input', async () => {
    const client = clientWith({
      getKarma: () => Promise.reject(new AgentKarmaValidationError('wallet must be a non-empty string')),
    });
    const result = await callAgentKarmaTool(client, 'get_karma', {});
    expect(result.isError).toBe(true);
    const body = parse((result.content[0] as { text: string }).text);
    expect(body.error).toBe('invalid_input');
    expect(body.message).toContain('wallet');
  });

  it('returns unknown_tool for an unregistered tool name', async () => {
    const result = await callAgentKarmaTool(clientWith({}), 'does_not_exist', {});
    expect(result.isError).toBe(true);
    expect(parse((result.content[0] as { text: string }).text).error).toBe('unknown_tool');
  });

  it('maps an upstream server error to a status-only message (no body leak)', async () => {
    const client = clientWith({
      getKarma: () =>
        Promise.reject(
          new AgentKarmaServerError('raw db connection pool exhausted at 10.0.0.5', { status: 503 }),
        ),
    });
    const result = await callAgentKarmaTool(client, 'get_karma', { wallet: SOLANA_WALLET });
    expect(result.isError).toBe(true);
    const body = parse((result.content[0] as { text: string }).text);
    expect(body.error).toBe('upstream_error');
    expect(body.message).toBe('AgentKarma returned 503.');
    // The raw upstream detail must NOT reach the caller.
    expect(JSON.stringify(result)).not.toContain('10.0.0.5');
  });

  it('maps an unknown/network error to a generic tool_error without leaking detail', async () => {
    const original = console.error;
    console.error = () => {}; // the catch-all logs server-side; keep test output clean
    try {
      const client = clientWith({
        getKarma: () => Promise.reject(new Error('ECONNREFUSED 10.0.0.5:5432 internal-host')),
      });
      const result = await callAgentKarmaTool(client, 'get_karma', { wallet: SOLANA_WALLET });
      expect(result.isError).toBe(true);
      const body = parse((result.content[0] as { text: string }).text);
      expect(body.error).toBe('tool_error');
      const wire = JSON.stringify(result);
      expect(wire).not.toContain('ECONNREFUSED');
      expect(wire).not.toContain('10.0.0.5');
    } finally {
      console.error = original;
    }
  });
});

describe('createAgentKarmaMcpServer', () => {
  it('builds a server from an injected client without throwing', () => {
    const server = createAgentKarmaMcpServer({ client: clientWith({}) });
    expect(server).toBeDefined();
    expect(typeof server.connect).toBe('function');
  });

  it('builds a server from default config (no network at construction)', () => {
    const server = createAgentKarmaMcpServer();
    expect(server).toBeDefined();
  });
});
