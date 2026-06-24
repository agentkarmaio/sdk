/**
 * @agentkarma/sdk/mcp — a turnkey AgentKarma MCP server, built from the
 * `@agentkarma/sdk/tools` catalog and backed by the public AgentKarma client.
 *
 * This is the OPTIONAL server layer. It depends on `@modelcontextprotocol/sdk`
 * (declared as an optional peer dependency) — install it only if you use this
 * module. The core client (`@agentkarma/sdk`) and the tool catalog
 * (`@agentkarma/sdk/tools`) stay dependency-free.
 *
 * The server is read-only and non-routing: it exposes the read catalog, never
 * signs, and never proxies a call on the caller's behalf.
 *
 *   import { createAgentKarmaMcpServer } from '@agentkarma/sdk/mcp';
 *   import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
 *   const server = createAgentKarmaMcpServer();
 *   await server.connect(new StdioServerTransport());
 */

// Low-level `Server` (not the high-level `McpServer`) is deliberate: `McpServer`
// requires Zod for every tool's `inputSchema`, whereas this catalog ships plain
// JSON Schema (zero-dep, portable). The SDK documents `Server` as the path for
// exactly this "advanced use case", so the @deprecated hint is acknowledged and
// intentional — we want JSON Schema on the wire without a Zod dependency.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { createAgentKarmaClient, type AgentKarmaClient } from './client.js';
import {
  AgentKarmaError,
  AgentKarmaNotFoundError,
  AgentKarmaValidationError,
} from './errors.js';
import { agentKarmaTools, getAgentKarmaTool } from './tools.js';
import type { ClientConfig } from './types.js';

const MCP_SERVER_NAME = 'agentkarma';
const MCP_SERVER_VERSION = '0.1.0';

const SERVER_INSTRUCTIONS = [
  'AgentKarma is the reputation layer for autonomous on-chain agents.',
  'Use these read-only tools to look up trust signals BEFORE paying or',
  'delegating to a wallet — every response carries two-faced karma (provider +',
  'consumer) and a confidence badge. `check_trust` runs a local allow/deny',
  'policy. AgentKarma does not proxy paid calls (non-routing).',
].join(' ');

/** The tool advertisements (MCP `tools/list` shape), derived from the catalog. */
export function agentKarmaMcpTools(): Tool[] {
  return agentKarmaTools.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema as Tool['inputSchema'],
    annotations: { title: t.title, ...t.annotations },
  }));
}

/**
 * Run a catalog tool and shape the result as an MCP `CallToolResult`. Errors
 * are converted to clean, non-leaky tool errors — raw network/stack detail is
 * NEVER echoed to the caller.
 */
export async function callAgentKarmaTool(
  client: AgentKarmaClient,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  const tool = getAgentKarmaTool(name);
  if (!tool) {
    return toolError('unknown_tool', `Unknown tool: ${name}`);
  }
  try {
    const data = await tool.handler(client, args);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    if (err instanceof AgentKarmaNotFoundError) {
      return toolError('not_found', `No record found for this ${name} lookup.`);
    }
    if (err instanceof AgentKarmaValidationError) {
      // Validation messages describe the caller's own bad argument — safe to echo.
      // INVARIANT: AgentKarmaValidationError messages MUST stay caller-facing —
      // never interpolate a host, URL, response body, or any upstream/network
      // detail into one, because this branch echoes err.message verbatim to a
      // public MCP caller. Upstream/network errors take the non-echoing branches
      // below instead.
      return toolError('invalid_input', err.message);
    }
    if (err instanceof AgentKarmaError && typeof err.status === 'number') {
      return toolError('upstream_error', `AgentKarma returned ${err.status}.`);
    }
    // Unknown/network error: log server-side, return a generic message.
    console.error(`[agentkarma-mcp:${name}]`, err);
    return toolError(
      'tool_error',
      `${name} encountered an unexpected error. Verify the arguments and try again.`,
    );
  }
}

function toolError(error: string, message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error, message }) }],
  };
}

/** Options for {@link createAgentKarmaMcpServer}. */
export interface CreateAgentKarmaMcpServerOptions {
  /** Pre-built client. Takes precedence over `config`. */
  client?: AgentKarmaClient;
  /** Client config (baseUrl, timeout, fetch, …) when no `client` is supplied. */
  config?: ClientConfig;
}

/**
 * Build a low-level MCP `Server` exposing the AgentKarma read catalog. Connect
 * it to any transport (`StdioServerTransport`, an HTTP transport, …).
 */
export function createAgentKarmaMcpServer(
  options: CreateAgentKarmaMcpServerOptions = {},
): Server {
  const client = options.client ?? createAgentKarmaClient(options.config);
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: agentKarmaMcpTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callAgentKarmaTool(
      client,
      request.params.name,
      (request.params.arguments ?? {}) as Record<string, unknown>,
    ),
  );

  return server;
}
