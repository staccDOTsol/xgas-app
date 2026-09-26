// End-to-end check over real MCP stdio: the server the host will actually speak to.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(here, '..', 'src', 'index.mjs')], env: process.env });
const client = new Client({ name: 'smoke', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`tools/list: ${tools.length}`);
const missingDesc = tools.filter((t) => !t.description || !t.inputSchema);
if (missingDesc.length) throw new Error(`tools without description/schema: ${missingDesc.map((t) => t.name)}`);

const cases = [
  ['get_chain_info', {}],
  ['get_vault_nav', {}],
  ['get_fee_schedule', {}],
  ['quote_enter', { usdg_amount: '100' }],
  ['quote_exit', { xmoney_amount: '10' }],
  ['list_orders', {}],
  ['list_ngu_tokens', {}],
  ['ramp_quote', { direction: 'out', source: 'xmoney_xgas', amount: '50' }],
  ['xswap_chains', {}],
  ['xswap_terms', {}],
  ['quote_xswap', { xmoney_amount: '25', chain: 'base', asset: 'native', amount: '0.001', to: '0x000000000000000000000000000000000000dEaD' }],
  ['xswap_reputation', { address: '0x000000000000000000000000000000000000dEaD' }],
  ['xswap_status', { id: '0x'.padEnd(66, '0') }],
];
let failed = 0;
for (const [name, args] of cases) {
  const res = await client.callTool({ name, arguments: args });
  const head = res.content[0].text.split('\n')[0].slice(0, 96);
  console.log(`${res.isError ? 'FAIL' : ' ok '} ${name.padEnd(18)} ${head}`);
  if (res.isError) failed++;
}

// Errors must arrive as readable text, not as a crash.
const bad = await client.callTool({ name: 'get_balance', arguments: { address: 'not-an-address' } });
console.log(`${bad.isError ? ' ok ' : 'FAIL'} bad input rejected: ${bad.content[0].text.slice(0, 80)}`);
if (!bad.isError) failed++;

// While XSwap is paused (the v1 escrows have no usable owner), new swaps must be refused with the reason.
const terms = await client.callTool({ name: 'xswap_terms', arguments: {} });
if (/^PAUSED\./.test(terms.content[0].text)) {
  const open = await client.callTool({ name: 'prepare_xswap_out', arguments: { from: '0x000000000000000000000000000000000000dEaD', xmoney_amount: '1', chain: 'base', amount: '0.001', to: '0x000000000000000000000000000000000000dEaD' } });
  const refused = open.isError && /refused/.test(open.content[0].text) && /Nothing was prepared/.test(open.content[0].text);
  console.log(`${refused ? ' ok ' : 'FAIL'} paused XSwap refuses prepare_xswap_out: ${open.content[0].text.slice(0, 80)}`);
  if (!refused) failed++;
}

const unknown = await client.callTool({ name: 'does_not_exist', arguments: {} });
console.log(`${unknown.isError ? ' ok ' : 'FAIL'} unknown tool rejected`);
if (!unknown.isError) failed++;

await client.close();
console.log(failed ? `\n${failed} failure(s)` : '\nall good');
process.exit(failed ? 1 : 0);
