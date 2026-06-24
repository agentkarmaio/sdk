#!/usr/bin/env node
/**
 * `agentkarma-mcp` — run the AgentKarma MCP server over stdio.
 *
 * Backed by the public AgentKarma API (read-only, non-routing). Point it at a
 * different host with AGENTKARMA_BASE_URL.
 *
 *   npx agentkarma-mcp
 *   AGENTKARMA_BASE_URL=https://staging.agentkarma.io npx agentkarma-mcp
 *
 * Requires the optional peer dependency `@modelcontextprotocol/sdk`.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAgentKarmaMcpServer } from './mcp.js';

const baseUrl = process.env.AGENTKARMA_BASE_URL;
const server = createAgentKarmaMcpServer({
  config: baseUrl ? { baseUrl } : undefined,
});

try {
  await server.connect(new StdioServerTransport());
  // stderr only — stdout is the JSON-RPC channel and must stay clean.
  console.error(
    `agentkarma-mcp ready (${baseUrl ?? 'https://agentkarma.io'}) over stdio`,
  );
} catch (err) {
  console.error(
    'agentkarma-mcp failed to start:',
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
}
