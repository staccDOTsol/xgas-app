import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ALL_TOOLS, TOOLS_BY_NAME } from './registry.mjs';

export const VERSION = '0.2.0';

/**
 * One MCP server, whatever the transport. stdio (src/index.mjs) gets the whole tool set;
 * the hosted endpoint passes a filter, because a tool that spends the host's own gas has no
 * business on a public URL. Everything else is the same code the CLI serves.
 */
export function createServer({ allow = () => true, name = 'xgas-muse-connector' } = {}) {
  const tools = ALL_TOOLS.filter((t) => allow(t.name));
  const server = new Server({ name, version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name: n, description, inputSchema }) => ({ name: n, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS_BY_NAME.get(req.params.name);
    if (!tool || !allow(req.params.name)) {
      return { content: [{ type: 'text', text: `No such tool: ${req.params.name}` }], isError: true };
    }
    try {
      return await tool.handler(req.params.arguments || {});
    } catch (e) {
      // A revert reason or an RPC failure is information, not a stack trace. Pass the useful part through.
      const msg = e.shortMessage || e.message || String(e);
      return { content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }], isError: true };
    }
  });

  return { server, tools };
}

/** What a public URL may serve: everything except the tool that spends the host's own gas. */
export const isHostable = (name) => name !== 'claim_exit';
