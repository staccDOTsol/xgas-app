#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, VERSION } from './server.mjs';
import { ALL_TOOLS } from './registry.mjs';

export { ALL_TOOLS };

const { server } = createServer();

/**
 * npm installs the bin as a SYMLINK (node_modules/.bin/xgas-mcp), so argv[1] is the
 * symlink while import.meta.url is the real file. Compare resolved paths, or every
 * host that launches us through the bin gets a server that never connects.
 */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`xgas-mcp ${VERSION}: ${ALL_TOOLS.length} tools on stdio`);
}

export { server };
