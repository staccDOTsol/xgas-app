#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, VERSION } from './server.mjs';
import { ALL_TOOLS } from './registry.mjs';

export { ALL_TOOLS };

const { server } = createServer();

if (import.meta.url === `file://${process.argv[1]}`) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`xgas-muse-connector ${VERSION}: ${ALL_TOOLS.length} tools on stdio`);
}

export { server };
