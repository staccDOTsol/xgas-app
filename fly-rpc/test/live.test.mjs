// Read-only smoke test against the real Robinhood Chain upstreams: npm run smoke
// Uses publicnode, the official RPC and staccpad, plus dRPC when DRPC_URL is set in the environment.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProxy, parseUpstreams, txHashOf } from '../server.mjs';

const BRIDGE = '0x2290f4505484f055B710e7Df37e2482c90B8B6fb';
const SEQUENCER_INBOX = '0xCA038a032154d0091b019A9104b369F94FD5c75F';
const TOTAL_DELAYED_MESSAGES_READ = '0x7fa3a40e'; // totalDelayedMessagesRead()
const OFFICIAL = 'https://rpc.mainnet.chain.robinhood.com';
const hex = (n) => '0x' + n.toString(16);

const spec = [
  process.env.DRPC_URL ? 'drpc=${DRPC_URL}|4' : null,
  'publicnode=https://robinhood-rpc.publicnode.com|3',
  'staccpad=https://staccpad.fun/rpc|2',
  `official=${OFFICIAL}|1`,
].filter(Boolean).join(',');

let proxy, url, id = 1;
const logs = [];
const rpcAt = async (target, method, params = []) => {
  const r = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }), signal: AbortSignal.timeout(60_000) });
  return r.json();
};
const rpc = (method, params) => rpcAt(url, method, params);

before(async () => {
  const { upstreams, warnings } = parseUpstreams(spec, process.env);
  proxy = createProxy({ upstreams, warnings, port: 0, host: '127.0.0.1', statsIntervalMs: 0, log: (l) => logs.push(l) });
  await proxy.start();
  url = `http://127.0.0.1:${proxy.address().port}/`;
});

after(async () => {
  const s = proxy.stats();
  console.log('\n--- proxy log ---\n' + logs.join('\n'));
  console.log('--- /stats ---');
  console.log(`head ${s.head}  totals ${JSON.stringify(s.totals)}`);
  for (const u of s.upstreams) {
    console.log(`${u.name.padEnd(11)} ${u.status.padEnd(10)} head=${u.head} lag=${u.lag} clampsLogs=${u.clampsLogs} ok=${u.totals.ok} soft=${u.totals.soft} fail=${u.totals.fail} failovers=${u.totals.failovers} 429=${u.totals.r429} avg=${u.totals.avgMs}ms skipping=${JSON.stringify(u.skipping)}`);
  }
  await proxy.close();
});

test('boot: every reachable upstream is chain 4663', () => {
  const ups = proxy.stats().upstreams;
  for (const u of ups) assert.notEqual(u.status, 'dropped', `${u.name} is not chain 4663`);
  assert.ok(ups.filter((u) => u.status !== 'unverified').length >= 2, JSON.stringify(ups.map((u) => [u.name, u.status])));
});

test('eth_chainId', async () => {
  assert.equal((await rpc('eth_chainId')).result, '0x1237');
});

test('eth_blockNumber tracks the chain', async () => {
  const mine = parseInt((await rpc('eth_blockNumber')).result, 16);
  const official = parseInt((await rpcAt(OFFICIAL, 'eth_blockNumber')).result, 16);
  assert.ok(Number.isFinite(mine) && mine > 70_000_000, `head ${mine}`);
  assert.ok(Math.abs(mine - official) < 300, `proxy ${mine} vs official ${official}`);
});

test('eth_getLogs over the last 500 blocks for the xgas bridge (publicnode 403s this: the proxy must fail over)', async () => {
  const head = parseInt((await rpc('eth_blockNumber')).result, 16);
  // Ending 100 blocks back: official and staccpad answer [] past their head, so without dRPC the proxy only gives them
  // ranges ending CLAMP_MARGIN_BLOCKS (50) below their head, and publicnode 403s anything older than ~64-100 blocks.
  const full = await rpc('eth_getLogs', [{ fromBlock: hex(head - 500), toBlock: hex(head - 100), address: BRIDGE }]);
  assert.ok(Array.isArray(full.result), JSON.stringify(full.error));
  // ...and a range ending at the head is either served by a node that errors past its head, or refused: never a short []
  const tip = await rpc('eth_getLogs', [{ fromBlock: hex(head - 500), toBlock: hex(head), address: BRIDGE }]);
  console.log(`# range ending at the head: ${tip.result ? `${tip.result.length} logs` : `refused (${tip.error.message.slice(0, 90)})`}`);

  // same answer as the official RPC over a settled range (the last 100 blocks are left out: it clamps at its head)
  const range = { fromBlock: hex(head - 500), toBlock: hex(head - 100), address: [BRIDGE, SEQUENCER_INBOX] };
  const [mine, official] = await Promise.all([rpc('eth_getLogs', [range]), rpcAt(OFFICIAL, 'eth_getLogs', [range])]);
  assert.ok(Array.isArray(mine.result), JSON.stringify(mine.error));
  assert.deepEqual(mine.result.map((l) => `${l.transactionHash}:${l.logIndex}`), official.result.map((l) => `${l.transactionHash}:${l.logIndex}`));
  const wide = await rpc('eth_getLogs', [{ fromBlock: hex(head - 49_000), toBlock: hex(head - 100), address: [BRIDGE, SEQUENCER_INBOX] }]);
  assert.ok(Array.isArray(wide.result), `49k-block range: ${JSON.stringify(wide.error)}`);
  console.log(`# bridge logs, last 500 blocks: ${full.result.length}; bridge+inbox logs, last 49k blocks: ${wide.result.length}`);
});

test('eth_call totalDelayedMessagesRead on the sequencer inbox', async () => {
  const call = { to: SEQUENCER_INBOX, data: TOTAL_DELAYED_MESSAGES_READ };
  const [mine, official] = await Promise.all([rpc('eth_call', [call, 'latest']), rpcAt(OFFICIAL, 'eth_call', [call, 'latest'])]);
  assert.match(mine.result ?? '', /^0x[0-9a-f]{64}$/, JSON.stringify(mine.error));
  const a = BigInt(mine.result), b = BigInt(official.result);
  assert.ok(a - b <= 1n && b - a <= 1n, `proxy ${a} vs official ${b}`);
  console.log(`# totalDelayedMessagesRead = ${a}`);

  // what the validators (inbox reader read-mode "safe") ask for. Neither publicnode nor the official RPC keeps that
  // state; informational because staccpad's backends are uneven.
  const safe = await rpc('eth_call', [call, 'safe']);
  console.log(`# eth_call at "safe": ${safe.result ? BigInt(safe.result) : 'ERROR ' + safe.error?.message}`);
});

test('a batch of the same calls: ids and order preserved', async () => {
  const head = parseInt((await rpc('eth_blockNumber')).result, 16);
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify([
      { jsonrpc: '2.0', id: 'chain', method: 'eth_chainId', params: [] },
      { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] },
      { jsonrpc: '2.0', id: 'logs', method: 'eth_getLogs', params: [{ fromBlock: hex(head - 500), toBlock: hex(head - 100), address: BRIDGE }] },
      { jsonrpc: '2.0', id: 4, method: 'eth_call', params: [{ to: SEQUENCER_INBOX, data: TOTAL_DELAYED_MESSAGES_READ }, 'latest'] },
      { jsonrpc: '2.0', id: 5, method: 'eth_getBlockByNumber', params: [hex(head - 10), false] },
    ]),
  }).then((x) => x.json());
  assert.deepEqual(r.map((x) => x.id), ['chain', 2, 'logs', 4, 5]);
  assert.equal(r[0].result, '0x1237');
  assert.match(r[1].result, /^0x[0-9a-f]+$/);
  assert.ok(Array.isArray(r[2].result), JSON.stringify(r[2].error));
  assert.match(r[3].result, /^0x[0-9a-f]{64}$/);
  assert.equal(parseInt(r[4].result.number, 16), head - 10);
});

test('keccak256 tx hash matches a real Robinhood transaction', async (t) => {
  const block = (await rpc('eth_getBlockByNumber', ['latest', true])).result;
  const tx = block.transactions.find((x) => x.type !== '0x6a') ?? block.transactions[0]; // skip the ArbOS internal tx when possible
  const raw = await rpc('eth_getRawTransactionByHash', [tx.hash]);
  if (!raw.result) return t.skip(`eth_getRawTransactionByHash unavailable: ${raw.error?.message}`);
  assert.equal(txHashOf(raw.result), tx.hash);
});
