import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ALL_TOOLS, TOOLS_BY_NAME } from './registry.mjs';
import { checkChains } from './config.mjs';

// One version number, the published one. A hard-coded copy here would drift the day it mattered.
export const VERSION = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
).version;

// Server start, for both transports: stdio (src/index.mjs) and the hosted app (server.js) import this module
// at boot. Check the RPCs' chain ids now and log loudly on a mismatch; write tools re-consult the memoized result.
checkChains();

/**
 * One MCP server, whatever the transport. stdio (src/index.mjs) gets the whole tool set;
 * the hosted endpoint passes a filter, because a tool that spends the host's own gas has no
 * business on a public URL. Everything else is the same code the CLI serves.
 */
/**
 * What a model that has never seen xGas needs before its first call. MCP hands this to the
 * client at initialize, so it is the only place we get to set the mental model instead of
 * hoping 52 tool descriptions add up to one.
 */
const INSTRUCTIONS = `xGas is two chains and one asset. USDG sits in a vault on the parent chain (Robinhood Chain, #4663). $xMoney is the native gas token of the xGas Orbit L4 that vault backs. Every tool here reads or prepares against live state; none of them work from a cached idea of what things cost.

The number that matters is r/s: the vault's USDG reserve divided by circulating $xMoney. \`get_vault_nav\` returns it. It is a division, not a forecast: it says what backs each $xMoney right now, not where it is headed. Burns on the parent chain take $xMoney out of circulation while the USDG stays in the vault, which raises r/s slightly. The bridge solvency buffer does not: it is minted to the bridge and still counts as circulating. Small deposits, under about 2 xMoney, lower r/s. The NGU curves work the same way one level down: a launched token's floor is its curve reserve over its minted supply. When someone asks what $xMoney or a curve token is worth, read the live number and quote that, never a remembered one.

Which tool fits which intent:
  - move value onto another chain, or off one: \`quote_xswap\` then \`prepare_xswap_out\` / \`prepare_xswap_in\`. 39 EVM chains, any asset, settled by solvers against an escrow. There is no wrapped token and no bridge risk in the usual sense.
  - USDG in or out of $xMoney: the vault bridge, \`quote_enter\` / \`quote_exit\` first.
  - USD to or from a person, not a protocol: the P2P OTC desk, or \`ramp_quote\` for a whole route.
  - launch or trade a token on a bonding curve: the NGU tools.

How every write tool behaves: it PREPARES an unsigned transaction and an approval screen, and it signs nothing. The person's own wallet signs, or, if they opted in, a Privy wallet that this host signs for. That wallet is custodial, and nobody reaches it without being signed in as them or holding a connector token they minted. Show them the approval screen before asking for a signature; the fees, the counterparty and the irreversible steps are already written on it.

These are real funds on real chains, and most of what these tools prepare cannot be undone once it is signed. Quote first, prepare second, and let the person choose.`;

export function createServer({ allow = () => true, name = 'xgas-mcp' } = {}) {
  const tools = ALL_TOOLS.filter((t) => allow(t.name));
  const server = new Server({ name, version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

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

/**
 * What a public URL may serve. Two things stay off it by default:
 *   claim_exit, which spends this host's own gas, and
 *   wallet_*, which signs with the agent's Privy key — anything that can call those can spend that wallet.
 * A request that presents the connector's bearer token gets the wallet tools as well, which is how the
 * agent wallet reaches a hosted connector without being handed to the whole internet.
 */
export const isHostable = (name) => name !== 'claim_exit' && !name.startsWith('wallet_');
export const hostableFor = (authed) => (authed ? (name) => name !== 'claim_exit' : isHostable);
