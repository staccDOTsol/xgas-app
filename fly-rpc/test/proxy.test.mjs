// Behaviour of the proxy against fake upstreams: one that 429s, one that lags, one that says "Unknown block",
// one that works, plus the variations each rule needs. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeUpstream, startProxy, waitFor, sleep, hex } from './helpers.mjs';
import { txHashOf } from '../server.mjs';

const ADDR = '0x2290f4505484f055B710e7Df37e2482c90B8B6fb';
const CALL = { to: '0xCA038a032154d0091b019A9104b369F94FD5c75F', data: '0x7fa3a40e' };
const own = (m) => m.method === 'eth_chainId' || m.method === 'eth_blockNumber';
const unknownBlock = { error: { code: 26, message: 'Unknown block' } };

test('validator backlog eth_getLogs is chunked and merged with no gap or partial result', async (t) => {
  let failAt = null;
  const [p, f] = await setup(t, [['logs', { handler: (m) => {
    if (m.method !== 'eth_getLogs' || m.params?.[0]?.address !== ADDR) return undefined;
    const from = Number.parseInt(m.params[0].fromBlock, 16);
    const to = Number.parseInt(m.params[0].toBlock, 16);
    assert.ok(to - from + 1 <= 100, 'the upstream never receives an oversized range');
    if (from === failAt) return { error: { code: 3, message: 'execution reverted' } };
    return { result: [{ blockNumber: hex(from) }, { blockNumber: hex(to) }] };
  } }]], { logChunkBlocks: 100, logChunkConcurrency: 2 });
  const params = [{ fromBlock: hex(100), toBlock: hex(365), address: ADDR, topics: ['0x1234'] }];
  const ok = await p.rpc('eth_getLogs', params);
  assert.deepEqual(ok.result.map((l) => l.blockNumber), [hex(100), hex(199), hex(200), hex(299), hex(300), hex(365)]);
  assert.equal(f.logs.calls('eth_getLogs'), 3);
  failAt = 200;
  const broken = await p.rpc('eth_getLogs', params);
  assert.equal(broken.result, undefined, 'a failed chunk must never return an incomplete log array');
  assert.equal(broken.error.code, 3);
});

test('validator near-head history and latest ranges use archive plus strict recent RPC', async (t) => {
  const [p, f] = await setup(t, [
    ['archive', { weight: 5, handler: (m, s) => {
      if (m.method !== 'eth_getLogs') return undefined;
      const range = m.params[0];
      if (range.address !== ADDR) return undefined; // boot clamp probe remains inconclusive/clamping
      const to = Number.parseInt(range.toBlock, 16);
      if (to > s.head - 50) return { result: [] }; // an unsafe short answer from this upstream
      return { result: [{ blockNumber: range.toBlock, source: 'archive' }] };
    } }],
    ['recent', { weight: 1, handler: (m, s) => {
      if (m.method !== 'eth_getLogs') return undefined;
      const range = m.params[0];
      const from = Number.parseInt(range.fromBlock, 16);
      const to = Number.parseInt(range.toBlock, 16);
      if (to > s.head) return unknownBlock; // strict clamp probe
      if (from < s.head - 49) return { error: { code: -32000, message: 'Archive requests require a personal token' } };
      return { result: [{ blockNumber: range.fromBlock, source: 'recent' }] };
    } }],
  ], { strategy: 'priority', logChunkBlocks: 100, clampMarginBlocks: 50 });
  f.archive.reset(); f.recent.reset();
  const logs = await p.rpc('eth_getLogs', [{ fromBlock: hex(900), toBlock: 'latest', address: ADDR }]);
  assert.deepEqual(logs.result, [
    { blockNumber: hex(950), source: 'archive' },
    { blockNumber: hex(951), source: 'recent' },
  ]);
  assert.deepEqual(f.archive.state.requests.filter((m) => m?.method === 'eth_getLogs').map((m) => m.params[0].toBlock), [hex(950)]);
  assert.deepEqual(f.recent.state.requests.filter((m) => m?.method === 'eth_getLogs').map((m) => m.params[0].fromBlock), [hex(951)]);
});

test('dRPC serves recent validator logs through its observed head without publicnode', async (t) => {
  const [p, f] = await setup(t, [
    ['drpc', { weight: 5, handler: (m, s) => m.method === 'eth_getLogs'
      ? (Number.parseInt(m.params[0].toBlock, 16) > s.head
        ? { result: [] } : { result: [{ blockNumber: m.params[0].toBlock }] }) : undefined }],
    ['publicnode', { weight: 1, handler: (m, s) => m.method === 'eth_getLogs'
      ? (Number.parseInt(m.params[0].toBlock, 16) > s.head ? unknownBlock
        : { error: { code: -32000, message: 'Archive requests require a personal token' } }) : undefined }],
  ], { strategy: 'priority' });
  f.drpc.reset(); f.publicnode.reset();
  assert.deepEqual((await p.rpc('eth_getLogs', [{ fromBlock: hex(900), toBlock: hex(1000), address: ADDR }])).result,
    [{ blockNumber: hex(950) }, { blockNumber: hex(1000) }]);
  assert.equal(f.drpc.calls('eth_getLogs'), 2, 'historical and tip ranges both reach dRPC');
  assert.equal(f.publicnode.calls('eth_getLogs'), 0);
});

async function setup(t, specs, opts) {
  const fakes = [];
  for (const [name, o = {}] of specs) {
    const f = await fakeUpstream(name, o);
    f.weight = o.weight ?? 1;
    fakes.push(f);
  }
  const p = await startProxy(fakes, opts);
  t.after(async () => { await p.proxy.close(); await Promise.all(fakes.map((f) => f.close())); });
  return [p, Object.fromEntries(fakes.map((f) => [f.name, f]))];
}

test('the incident set: 429, lagging, Unknown block, good', async (t) => {
  const [p, f] = await setup(t, [
    ['ratelimited', { weight: 4, handler: (m) => (own(m) ? undefined : { status: 429, headers: { 'retry-after': '2' } }) }],
    ['lagging', { weight: 3, head: 950 }],
    ['unknownblock', { weight: 2, handler: (m) => (own(m) ? undefined : unknownBlock) }],
    ['good', { weight: 1 }],
  ]);
  const up = Object.fromEntries(p.proxy.state.upstreams.map((u) => [u.name, u]));
  assert.equal(up.lagging.lag, 50);
  assert.equal(up.good.lag, 0);

  // latest: 429 -> Unknown block -> good; the lagging node is never asked
  const a = await p.rpc('eth_call', [CALL, 'latest']);
  assert.equal(a.result, 'good:eth_call');
  assert.equal(f.ratelimited.calls('eth_call'), 1);
  assert.equal(f.unknownblock.calls('eth_call'), 1);
  assert.equal(f.lagging.calls(), 0);

  // the 429 put ratelimited in cooldown (Retry-After 2s): the next request doesn't knock on it first
  const b = await p.rpc('eth_getBalance', [ADDR, 'latest']);
  assert.equal(b.result, 'good:eth_getBalance');
  assert.equal(f.ratelimited.calls(), 1);
  assert.equal(f.lagging.calls(), 0);

  // an old block the lagging node has: it is the best-weighted node that can serve it
  const c = await p.rpc('eth_getBalance', [ADDR, hex(900)]);
  assert.equal(c.result, 'lagging:eth_getBalance');

  // a block past the lagging node's head: not sent there
  const before = f.lagging.calls();
  const d = await p.rpc('eth_getBalance', [ADDR, hex(990)]);
  assert.equal(d.result, 'good:eth_getBalance');
  assert.equal(f.lagging.calls(), before);

  const s = p.proxy.stats();
  const st = Object.fromEntries(s.upstreams.map((u) => [u.name, u]));
  assert.equal(st.ratelimited.totals.r429, 1);
  assert.equal(st.ratelimited.status, 'cooldown');
  assert.equal(st.lagging.status, 'lagging');
  assert.ok(st.unknownblock.totals.failovers >= 2);
  assert.ok(s.totals.failovers >= 3);
  assert.equal(s.totals.errors, 0);
});

test('fails over on HTTP 5xx and timeouts; eth_getLogs gets the longer timeout', async (t) => {
  let mode = 'slow';
  const [p, f] = await setup(t, [
    ['flaky', { weight: 2, handler: (m) => (own(m) ? undefined : mode === 'slow' ? { delay: 600, result: `flaky:${m.method}` } : { status: 502 }) }],
    ['good', { weight: 1 }],
  ], { timeoutMs: 300, logsTimeoutMs: 1_500 });

  const t0 = Date.now();
  const r = await p.rpc('eth_call', [CALL, 'latest']);
  assert.equal(r.result, 'good:eth_call');
  assert.ok(Date.now() - t0 < 600, 'gave up on flaky at the 300ms timeout');

  // (an old range: flaky's boot clamp probe timed out, so it only gets ranges well below its head)
  const logs = await p.rpc('eth_getLogs', [{ fromBlock: hex(100), toBlock: hex(200), address: ADDR }]);
  assert.equal(logs.result, 'flaky:eth_getLogs', 'a 600ms eth_getLogs is inside the 1500ms logs timeout');

  mode = '502';
  const r2 = await p.rpc('eth_getCode', [ADDR, 'latest']);
  assert.equal(r2.result, 'good:eth_getCode');
  const st = p.proxy.stats().upstreams.find((u) => u.name === 'flaky');
  assert.equal(st.totals.timeouts, 1);
  assert.equal(st.totals.fail, 2);
});

test('answers that mean "no" are returned, not failed over', async (t) => {
  const [p, f] = await setup(t, [
    ['first', { weight: 2, handler: (m) => (m.method === 'eth_call' ? { error: { code: 3, message: 'execution reverted: rate limit exceeded', data: '0x08c379a0' } }
      : m.method === 'eth_estimateGas' ? { error: { code: -32000, message: 'insufficient funds for gas * price + value' } } : undefined) }],
    ['second', { weight: 1 }],
  ]);
  const r = await p.rpc('eth_call', [CALL, 'latest']);
  assert.equal(r.error.code, 3);
  assert.equal(r.error.data, '0x08c379a0', 'revert data survives');
  const e = await p.rpc('eth_estimateGas', [CALL]);
  assert.match(e.error.message, /insufficient funds/);
  assert.equal(f.second.calls(), 0);
});

test('every upstream failing gives one JSON-RPC error, not a hang', async (t) => {
  const [p] = await setup(t, [
    ['a', { handler: (m) => (own(m) ? undefined : unknownBlock) }],
    ['b', { handler: (m) => (own(m) ? undefined : { status: 503 }) }],
  ]);
  const r = await p.rpc('eth_call', [CALL, 'latest']);
  assert.equal(r.error.message, 'Unknown block', 'the upstream JSON-RPC error beats a bare HTTP status');
  assert.equal(p.proxy.stats().totals.errors, 1);
});

test('lag: latest-tag reads skip nodes >5 blocks behind; block N needs a node that has N', async (t) => {
  const [p, f] = await setup(t, [
    ['behind', { weight: 5, head: 994 }],  // 6 behind
    ['close', { weight: 3, head: 996 }],   // 4 behind: within MAX_LAG_BLOCKS
    ['tip', { weight: 1, head: 1000 }],
  ], { headPollMs: 60_000, repollMinMs: 100 }); // heads only move when the proxy refreshes them on demand

  for (const tag of ['latest', 'safe', 'finalized', 'pending']) {
    assert.equal((await p.rpc('eth_getBalance', [ADDR, tag])).result, 'close:eth_getBalance', tag);
  }
  assert.equal((await p.rpc('eth_blockNumber')).result, hex(996));
  assert.equal(f.behind.calls(), 0);

  assert.equal((await p.rpc('eth_call', [CALL, hex(990)])).result, 'behind:eth_call', 'an old enough block is fine on a lagging node');
  assert.equal((await p.rpc('eth_call', [CALL, hex(998)])).result, 'tip:eth_call', 'only tip has 998');
  assert.equal((await p.rpc('eth_call', [CALL, { blockNumber: hex(995) }])).result, 'close:eth_call', 'EIP-1898 object');

  // a block nobody was known to have: the proxy re-polls heads once, then routes to whoever has it
  f.close.state.head = 1003;
  await sleep(120); // (it won't re-poll within REPOLL_MIN_MS of the last poll: then the block may not exist anywhere yet)
  assert.equal((await p.rpc('eth_call', [CALL, hex(1003)])).result, 'close:eth_call');
  assert.equal(f.tip.calls('eth_call'), 1);
});

test('circuit breaker: 5 consecutive failures take an upstream out for BREAKER_MS', async (t) => {
  let broken = true;
  const [p, f] = await setup(t, [
    ['bad', { weight: 100, handler: (m) => (own(m) || !broken ? undefined : { status: 500 }) }],
    ['good', { weight: 1 }],
  ], { breakerFails: 5, breakerMs: 400 });

  for (let i = 0; i < 5; i++) assert.equal((await p.rpc('eth_call', [CALL, 'latest'])).result, 'good:eth_call');
  assert.equal(f.bad.calls('eth_call'), 5);
  assert.ok(p.logs.some((l) => /\[breaker\] bad open/.test(l)));
  assert.equal(p.proxy.stats().upstreams.find((u) => u.name === 'bad').status, 'open');

  for (let i = 0; i < 3; i++) assert.equal((await p.rpc('eth_call', [CALL, 'latest'])).result, 'good:eth_call');
  assert.equal(f.bad.calls('eth_call'), 5, 'open: not asked');

  await sleep(450);
  await p.rpc('eth_call', [CALL, 'latest']);
  assert.equal(f.bad.calls('eth_call'), 6, 'half-open: one probe');
  await p.rpc('eth_call', [CALL, 'latest']);
  assert.equal(f.bad.calls('eth_call'), 6, 'the probe failed: open again at once');

  broken = false;
  await sleep(450);
  assert.equal((await p.rpc('eth_call', [CALL, 'latest'])).result, 'bad:eth_call');
  assert.ok(p.logs.some((l) => /\[breaker\] bad closed/.test(l)));
  assert.equal((await p.rpc('eth_call', [CALL, 'latest'])).result, 'bad:eth_call');

  // all upstreams open: still tried as a last resort instead of refusing outright
  const s = p.proxy.state.upstreams;
  for (const u of s) u.openUntil = Date.now() + 10_000;
  assert.equal((await p.rpc('eth_call', [CALL, 'latest'])).result, 'bad:eth_call');
});

test('batches: failed items alone go to the next upstream; ids and order are the caller\'s', async (t) => {
  const [p, f] = await setup(t, [
    ['first', { weight: 2, handler: (m) => (m.method === 'eth_getBalance' ? unknownBlock
      : m.method === 'eth_estimateGas' ? { error: { code: -32000, message: 'execution reverted' } } : undefined) }],
    ['good', { weight: 1 }],
  ]);
  const batch = [
    { jsonrpc: '2.0', id: 'a', method: 'eth_call', params: [CALL, 'latest'] },
    { jsonrpc: '2.0', id: 7, method: 'eth_getBalance', params: [ADDR, 'latest'] },
    { jsonrpc: '2.0', id: 'dup', method: 'eth_getCode', params: [ADDR, 'latest'] },
    { jsonrpc: '2.0', id: 'dup', method: 'eth_getBalance', params: [ADDR, 'latest'] },
    { jsonrpc: '2.0', id: 10, method: 'eth_chainId', params: [] },
    { jsonrpc: '2.0', id: null, method: 'eth_estimateGas', params: [CALL] },
    { jsonrpc: '2.0', method: 'eth_getCode', params: [ADDR, 'latest'] }, // notification: no response
    42,
  ];
  const out = await p.send(batch);
  assert.deepEqual(out, [
    { jsonrpc: '2.0', id: 'a', result: 'first:eth_call' },
    { jsonrpc: '2.0', id: 7, result: 'good:eth_getBalance' },
    { jsonrpc: '2.0', id: 'dup', result: 'first:eth_getCode' },
    { jsonrpc: '2.0', id: 'dup', result: 'good:eth_getBalance' },
    { jsonrpc: '2.0', id: 10, result: '0x1237' },
    { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'execution reverted' } },
    { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } },
  ]);
  const arrays = (fk) => fk.state.requests.filter(Array.isArray);
  assert.equal(arrays(f.first).length, 1);
  assert.deepEqual(arrays(f.first)[0].map((m) => m.method), ['eth_call', 'eth_getBalance', 'eth_getCode', 'eth_getBalance', 'eth_estimateGas', 'eth_getCode']);
  assert.equal(arrays(f.good).length, 1, 'one retry batch');
  assert.deepEqual(arrays(f.good)[0].map((m) => m.method), ['eth_getBalance', 'eth_getBalance'], 'only the failed items');

  assert.deepEqual(await p.send([]), { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'empty batch' } });
});

test('batches: a whole-batch 429 moves the whole batch; an item nobody can answer errors alone', async (t) => {
  const [p, f] = await setup(t, [
    ['ratelimited', { weight: 3, handler: (m) => (own(m) ? undefined : { status: 429 }) }],
    ['good', { weight: 2, handler: (m) => (m.method === 'eth_getProof' ? unknownBlock : undefined) }],
    ['other', { weight: 1, handler: (m) => (m.method === 'eth_getProof' ? { error: { code: -32000, message: 'header not found' } } : undefined) }],
  ]);
  const out = await p.send([
    { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [CALL, 'latest'] },
    { jsonrpc: '2.0', id: 2, method: 'eth_getProof', params: [ADDR, [], 'latest'] },
    { jsonrpc: '2.0', id: 3, method: 'eth_getCode', params: [ADDR, 'latest'] },
  ]);
  assert.deepEqual(out.map((o) => o.id), [1, 2, 3]);
  assert.equal(out[0].result, 'good:eth_call');
  assert.equal(out[1].error.message, 'header not found');
  assert.equal(out[2].result, 'good:eth_getCode');
  assert.equal(f.ratelimited.state.requests.filter(Array.isArray)[0].length, 3);
  assert.equal(f.good.state.requests.filter(Array.isArray)[0].length, 3);
  assert.deepEqual(f.other.state.requests.filter(Array.isArray)[0].map((m) => m.method), ['eth_getProof']);
  assert.equal(p.proxy.stats().totals.errors, 1);
});

test('eth_sendRawTransaction: already known = success, nonce errors are final, anything else tries the next', async (t) => {
  const raw = '0x02f8708212378201238405f5e1008405f5e10082520894' + 'ab'.repeat(20) + '8080c001a0' + '11'.repeat(32) + 'a0' + '22'.repeat(32);
  const hash = txHashOf(raw);
  let mode = 'known', txKnown = false;
  const [p, f] = await setup(t, [
    ['primary', { weight: 3, handler: (m) => {
      if (m.method === 'eth_getTransactionByHash') return { result: txKnown ? { hash: m.params[0] } : null };
      if (m.method !== 'eth_sendRawTransaction') return undefined;
      switch (mode) {
        case 'known': return { error: { code: -32000, message: 'already known' } };
        case 'nonce': return { error: { code: -32000, message: 'nonce too low: next nonce 8, tx nonce 7' } };
        case 'underpriced': return { error: { code: -32000, message: 'replacement transaction underpriced' } };
        case '500': return { status: 500 };
        case 'basefee': return { error: { code: -32000, message: 'max fee per gas less than block base fee' } };
        case 'timeout': return { delay: 700, result: hash };
        default: return { result: hash };
      }
    } }],
    ['backup', { weight: 1, handler: (m) => (m.method !== 'eth_sendRawTransaction' ? undefined
      : mode === 'timeout' ? { error: { code: -32000, message: 'already known' } } : { result: hash }) }],
  ], { strategy: 'weighted', timeoutMs: 300 }); // sends are deterministic even when reads are weighted
  const send = () => p.rpc('eth_sendRawTransaction', [raw]);

  assert.deepEqual((await send()).result, hash, 'already known -> the tx hash');
  assert.equal(f.backup.calls('eth_sendRawTransaction'), 0);

  mode = 'nonce';
  assert.match((await send()).error.message, /nonce too low/, 'nonce too low for a tx nobody has: final');
  assert.equal(f.backup.calls('eth_sendRawTransaction'), 0);
  txKnown = true;
  assert.equal((await send()).result, hash, 'nonce too low but this exact tx is on chain: success');
  txKnown = false;

  mode = 'underpriced';
  assert.match((await send()).error.message, /underpriced/);
  assert.equal(f.backup.calls('eth_sendRawTransaction'), 0);

  mode = '500';
  assert.equal((await send()).result, hash);
  assert.equal(f.backup.calls('eth_sendRawTransaction'), 1);

  mode = 'basefee';
  assert.equal((await send()).result, hash);
  assert.equal(f.backup.calls('eth_sendRawTransaction'), 2);

  mode = 'timeout'; // primary took it but timed out; backup already has it from the network
  assert.equal((await send()).result, hash);
  assert.equal(f.backup.calls('eth_sendRawTransaction'), 3);

  const inBatch = await p.send([{ jsonrpc: '2.0', id: 'tx', method: 'eth_sendRawTransaction', params: [raw] }]);
  assert.deepEqual(inBatch, [{ jsonrpc: '2.0', id: 'tx', result: hash }]);
});

test('eth_getTransactionReceipt null on one node is re-asked elsewhere', async (t) => {
  const h = '0x' + 'cd'.repeat(32);
  const [p, f] = await setup(t, [
    ['stale', { weight: 3 }],
    ['fresh', { weight: 2, handler: (m) => (m.method === 'eth_getTransactionReceipt' && m.params[0] === h ? { result: { transactionHash: h, status: '0x1' } } : undefined) }],
    ['third', { weight: 1 }],
  ]);
  assert.deepEqual((await p.rpc('eth_getTransactionReceipt', [h])).result, { transactionHash: h, status: '0x1' });
  assert.equal(f.stale.calls('eth_getTransactionReceipt'), 1);

  const missing = await p.rpc('eth_getTransactionReceipt', ['0x' + '00'.repeat(32)]);
  assert.equal(missing.result, null, 'nobody has it: null');
  assert.equal(f.stale.calls('eth_getTransactionReceipt') + f.fresh.calls('eth_getTransactionReceipt') + f.third.calls('eth_getTransactionReceipt'), 6, 'each lookup: 1 + NULL_RETRY_MAX(2)');

  const out = await p.send([{ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [h] }]);
  assert.equal(out[0].result.transactionHash, h, 'batch items get the same retry');
});

test('eth_chainId boot check drops a wrong chain; an upstream that was down joins once it answers', async (t) => {
  let down = true;
  const [p, f] = await setup(t, [
    ['wrongchain', { weight: 9, chainId: '0x1' }],
    ['late', { weight: 5, handler: (m) => (down ? { status: 503 } : undefined) }],
    ['good', { weight: 1 }],
  ]);
  const st = () => Object.fromEntries(p.proxy.stats().upstreams.map((u) => [u.name, u.status]));
  assert.equal(st().wrongchain, 'dropped');
  assert.equal(st().late, 'unverified');
  assert.ok(p.logs.some((l) => /DROPPING wrongchain/.test(l)));

  assert.equal((await p.rpc('eth_getBalance', [ADDR, 'latest'])).result, 'good:eth_getBalance');
  assert.equal(f.wrongchain.calls(), 0);
  assert.equal(f.late.calls('eth_getBalance'), 0);

  down = false;
  await waitFor(() => st().late === 'ok');
  assert.equal((await p.rpc('eth_getBalance', [ADDR, 'latest'])).result, 'late:eth_getBalance');
  assert.equal(f.wrongchain.calls(), 0, 'a dropped upstream never gets traffic');
});

test('eth_chainId / net_version are local; /health, /stats, bad requests', async (t) => {
  const [p, f] = await setup(t, [['good', {}]]);
  const bootCalls = f.good.state.requests.filter((m) => m.method === 'eth_chainId').length;
  assert.equal((await p.rpc('eth_chainId')).result, '0x1237');
  assert.equal((await p.rpc('net_version')).result, '4663');
  assert.equal(f.good.state.requests.filter((m) => m.method === 'eth_chainId').length, bootCalls);

  const h = await p.get('/health');
  assert.equal(h.status, 200);
  assert.equal((await h.json()).ok, true);
  const s = await (await p.get('/stats')).json();
  assert.equal(s.chainId, 4663);
  assert.equal(s.upstreams[0].name, 'good');
  assert.equal(s.upstreams[0].host.startsWith('127.0.0.1:'), true);
  assert.equal((await p.get('/')).status, 405);

  const bad = await fetch(p.url, { method: 'POST', body: '{not json' });
  assert.deepEqual(await bad.json(), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  assert.equal((await p.send({ jsonrpc: '2.0', id: 1 })).error.code, -32600);
  assert.equal(await p.send({ jsonrpc: '2.0', method: 'eth_getCode', params: [ADDR, 'latest'] }), undefined, 'notification: 204');

  // the per-minute line
  p.proxy.flushStats();
  assert.ok(p.logs.some((l) => /^\[stats\] .*calls=\d+ .*\| good ok=\d+ fo=0 429=0 to=0 lag=0/.test(l)), p.logs.at(-1));
});

test('/health is 503 when no upstream can be used', async (t) => {
  const [p] = await setup(t, [['wrong', { chainId: '0x2105' }]]);
  const h = await p.get('/health');
  assert.equal(h.status, 503);
  const r = await p.rpc('eth_getBalance', [ADDR, 'latest']);
  assert.match(r.error.message, /no upstream answered/);
});

test('an upstream that lacks history (publicnode 403 "Archive requests") is skipped for that kind of request', async (t) => {
  const archive = { status: 403, body: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode' } } };
  const [p, f] = await setup(t, [
    ['publicnode', { weight: 3, handler: (m, s) => (m.method !== 'eth_getLogs' ? undefined
      : parseInt(m.params[0].toBlock, 16) > s.head ? { error: { code: -32000, message: 'invalid block range params' } } // like the real one
        : parseInt(m.params[0].fromBlock, 16) < 1000 - 64 ? archive : undefined) }],
    ['official', { weight: 1, handler: (m) => (m.method === 'eth_getLogs' ? { result: [{ address: ADDR, blockNumber: m.params[0].fromBlock }] } : undefined) }],
  ]);
  const q = (from, to) => p.rpc('eth_getLogs', [{ fromBlock: hex(from), toBlock: hex(to), address: ADDR }]);
  assert.equal((await q(500, 600)).result.length, 1);
  assert.equal((await q(505, 605)).result.length, 1);
  assert.equal(f.publicnode.calls('eth_getLogs'), 2, 'two strikes (CAP_STRIKES=2)...');
  assert.equal((await q(510, 610)).result.length, 1);
  assert.equal(f.publicnode.calls('eth_getLogs'), 2, '...then it is not asked again for old ranges');
  assert.deepEqual((await q(990, 995)).result, [], 'recent range: publicnode is still first');
  assert.equal(f.publicnode.calls('eth_getLogs'), 3);
  assert.equal((await p.rpc('eth_call', [CALL, 'latest'])).result, 'publicnode:eth_call', 'and its health is untouched');
  const pn = p.proxy.stats().upstreams.find((u) => u.name === 'publicnode');
  assert.deepEqual(pn.skipping, ['eth_getLogs|n1|s0']);
  assert.equal(pn.consecFails, 0);
  assert.equal(pn.status, 'ok');
});

test('an upstream that answers eth_getLogs past its head with [] is not trusted with ranges ending at the head', async (t) => {
  const [p, f] = await setup(t, [
    ['clamper', { weight: 5 }], // fake default: [] for any range, like the official RPC and staccpad
    ['strict', { weight: 1, handler: (m, s) => (m.method === 'eth_getLogs'
      ? (parseInt(m.params[0].toBlock, 16) > s.head ? unknownBlock : { result: [{ address: ADDR }] }) : undefined) }],
  ]);
  const up = Object.fromEntries(p.proxy.state.upstreams.map((u) => [u.name, u]));
  assert.equal(up.clamper.clampsLogs, true);
  assert.equal(up.strict.clampsLogs, false);
  f.clamper.reset(); f.strict.reset();
  assert.equal((await p.rpc('eth_getLogs', [{ fromBlock: hex(990), toBlock: hex(1000), address: ADDR }])).result.length, 1);
  assert.equal(f.clamper.calls('eth_getLogs'), 0);
  assert.deepEqual((await p.rpc('eth_getLogs', [{ fromBlock: hex(900), toBlock: hex(950), address: ADDR }])).result, [], 'well below its head: fine');
  assert.equal(f.clamper.calls('eth_getLogs'), 1);
});

test('weights spread the first pick', async (t) => {
  const [p, f] = await setup(t, [['heavy', { weight: 3 }], ['light', { weight: 1 }]], { strategy: 'weighted' });
  for (let i = 0; i < 20; i++) await Promise.all(Array.from({ length: 20 }, () => p.rpc('eth_getBalance', [ADDR, 'latest'])));
  const h = f.heavy.calls('eth_getBalance'), l = f.light.calls('eth_getBalance');
  assert.equal(h + l, 400);
  assert.ok(h / l > 1.8 && h / l < 5.5, `heavy:light = ${h}:${l}`);
});

test('filters stay on the node that created them', async (t) => {
  const [p, f] = await setup(t, [
    ['a', { weight: 2, handler: (m) => (m.method === 'eth_newFilter' ? { result: '0xF1' } : m.method === 'eth_getFilterChanges' ? { result: ['a-change'] } : undefined) }],
    ['b', { weight: 1, handler: (m) => (m.method === 'eth_getFilterChanges' ? { error: { code: -32000, message: 'filter not found' } } : undefined) }],
  ]);
  const id = (await p.rpc('eth_newFilter', [{ address: ADDR }])).result;
  f.a.state.head = 900; // a now lags: plain reads leave it, the filter does not
  await p.proxy.pollHeads();
  assert.equal((await p.rpc('eth_getBalance', [ADDR, 'latest'])).result, 'b:eth_getBalance');
  assert.deepEqual((await p.rpc('eth_getFilterChanges', [id])).result, ['a-change']);
  assert.equal(f.b.calls('eth_getFilterChanges'), 0);
});

// ------------------------------------------------------------------------------------------------ review fixes
const strictLogs = (log) => (m, s) => (m.method !== 'eth_getLogs' ? undefined
  : parseInt(m.params[0].toBlock, 16) > s.head ? unknownBlock : { result: [log] });

test('a clamping upstream never gets a range near its head, not even as the last resort', async (t) => {
  let strictDown = true;
  const [p, f] = await setup(t, [
    ['clamper', { weight: 5 }], // fake default: [] for any range
    ['strict', { weight: 1, handler: (m, s) => (m.method === 'eth_getLogs' && strictDown && m.params[0].address === ADDR ? { status: 503 } : strictLogs({ address: ADDR })(m, s)) }],
  ]);
  f.clamper.reset();
  const tip = { fromBlock: hex(990), toBlock: hex(1000), address: ADDR };
  const r = await p.rpc('eth_getLogs', [tip]);
  assert.ok(r.error, 'an error, not a short []');
  assert.equal(f.clamper.calls('eth_getLogs'), 0);

  // in a batch, the unsafe item is held back from the clamper; the rest still goes there
  const out = await p.send([
    { jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [tip] },
    { jsonrpc: '2.0', id: 2, method: 'eth_getBalance', params: [ADDR, 'latest'] },
    { jsonrpc: '2.0', id: 3, method: 'eth_getLogs', params: [{ fromBlock: hex(100), toBlock: hex(200), address: ADDR }] },
  ]);
  assert.ok(out[0].error);
  assert.equal(out[1].result, 'clamper:eth_getBalance');
  assert.deepEqual(out[2].result, [], 'an old range is fine on the clamper');
  assert.deepEqual(f.clamper.state.requests.filter(Array.isArray)[0].map((m) => m.method), ['eth_getBalance', 'eth_getLogs']);
  assert.equal(f.clamper.calls('eth_getLogs'), 1);

  strictDown = false;
  assert.deepEqual((await p.rpc('eth_getLogs', [tip])).result, [{ address: ADDR }]);
});

test('clamp probe: one [] from an uneven load balancer marks it; an inconclusive probe routes like clamping', async (t) => {
  let n = 0;
  const [p, f] = await setup(t, [
    ['uneven', { weight: 3, handler: (m) => (m.method === 'eth_getLogs' && m.params[0].address === '0x0000000000000000000000000000000000000000'
      ? (n++ % 3 === 1 ? { result: [] } : unknownBlock) : undefined) }],
    ['slowprobe', { weight: 2, handler: (m) => (m.method === 'eth_getLogs' ? { delay: 700, result: [] } : undefined) }],
    ['strict', { weight: 1, handler: strictLogs({ address: ADDR }) }],
  ]);
  const st = Object.fromEntries(p.proxy.stats().upstreams.map((u) => [u.name, u.clampsLogs]));
  assert.deepEqual(st, { uneven: true, slowprobe: 'unknown', strict: false });
  assert.ok(n >= 3, 'three probes');
  assert.ok(p.logs.some((l) => /slowprobe .*probe inconclusive/.test(l)));
  assert.deepEqual((await p.rpc('eth_getLogs', [{ fromBlock: hex(995), toBlock: hex(1000), address: ADDR }])).result, [{ address: ADDR }]);
  assert.equal(f.uneven.calls('eth_getLogs') + f.slowprobe.calls('eth_getLogs'), 0);
});

test('"Unknown state" for a block at the head is lag (no strike); for an old block it is missing history', async (t) => {
  const unknownState = { error: { code: 27, message: 'Unknown state. First available state is 1' } };
  const [p, f] = await setup(t, [
    ['staccpad', { weight: 3, handler: (m) => (m.method === 'eth_call' ? unknownState : undefined) }],
    ['good', { weight: 1 }],
  ]);
  for (let i = 0; i < 3; i++) assert.equal((await p.rpc('eth_call', [CALL, hex(1000)])).result, 'good:eth_call');
  assert.equal(f.staccpad.calls('eth_call'), 3, 'still asked: lag is not remembered');
  assert.deepEqual(p.proxy.stats().upstreams.find((u) => u.name === 'staccpad').skipping, []);
  for (let i = 0; i < 3; i++) assert.equal((await p.rpc('eth_call', [CALL, hex(100)])).result, 'good:eth_call');
  assert.equal(f.staccpad.calls('eth_call'), 5, 'two strikes for the old block, then skipped');
  assert.deepEqual(p.proxy.stats().upstreams.find((u) => u.name === 'staccpad').skipping, ['eth_call|n1']);
});

test('a caller that hangs up stops the failover chain', async (t) => {
  const [p, f] = await setup(t, [
    ['a', { weight: 3, handler: (m) => (own(m) ? undefined : { delay: 300, status: 503 }) }],
    ['b', { weight: 2, handler: (m) => (own(m) ? undefined : { delay: 300, status: 503 }) }],
    ['c', { weight: 1 }],
  ]);
  const ac = new AbortController();
  const req = fetch(p.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [CALL, 'latest'] }), signal: ac.signal }).catch((e) => e);
  await sleep(100);
  ac.abort();
  await req;
  await sleep(500);
  assert.equal(f.a.calls('eth_call'), 1, 'the attempt in flight finished');
  assert.equal(f.b.calls('eth_call') + f.c.calls('eth_call'), 0, 'nothing after it');
  assert.equal(p.proxy.stats().totals.abandoned, 1);
  assert.equal(p.proxy.stats().upstreams.find((u) => u.name === 'a').totals.fail, 1, 'a is blamed for its own 503 only');
});

test('eth_sendRawTransaction: "nonce too high" tries the next; "nonce too low" checks other nodes for the tx', async (t) => {
  const raw = '0x02f8708212378201238405f5e1008405f5e10082520894' + 'cd'.repeat(20) + '8080c001a0' + '33'.repeat(32) + 'a0' + '44'.repeat(32);
  const hash = txHashOf(raw);
  let mode = 'high';
  const [p, f] = await setup(t, [
    ['primary', { weight: 3, handler: (m) => (m.method === 'eth_sendRawTransaction'
      ? { error: { code: -32000, message: mode === 'high' ? 'nonce too high' : 'nonce too low: next nonce 9, tx nonce 8' } }
      : m.method === 'eth_getTransactionByHash' ? { result: null } : undefined) }],
    ['backup', { weight: 1, handler: (m) => (m.method === 'eth_sendRawTransaction' ? { result: hash }
      : m.method === 'eth_getTransactionByHash' ? { result: { hash } } : undefined) }],
  ]);
  assert.equal((await p.rpc('eth_sendRawTransaction', [raw])).result, hash);
  assert.equal(f.backup.calls('eth_sendRawTransaction'), 1);
  mode = 'low';
  assert.equal((await p.rpc('eth_sendRawTransaction', [raw])).result, hash, 'primary lacks it, backup has it on chain');
  assert.equal(f.backup.calls('eth_sendRawTransaction'), 1, 'nonce too low is not sent on');
});

test('head polls leave a rate-limited upstream alone during its cooldown', async (t) => {
  let limited = false;
  const [p, f] = await setup(t, [
    ['official', { handler: (m) => (limited ? { status: 429, headers: { 'retry-after': '1' } } : undefined) }],
    ['good', {}],
  ]);
  limited = true;
  f.official.reset();
  await sleep(400); // ten poll intervals of 40ms
  assert.ok(f.official.calls('eth_blockNumber') <= 2, `polled ${f.official.calls('eth_blockNumber')} times while cooling down`);
  assert.equal(p.proxy.stats().upstreams.find((u) => u.name === 'official').status, 'cooldown');
});

test('keep-alive outlasts Go\'s 90s idle timeout; the request deadline is under Nitro\'s 60s client timeout', async (t) => {
  const [p] = await setup(t, [['good', {}]]);
  assert.ok(p.proxy.server.keepAliveTimeout > 90_000);
  assert.ok(p.proxy.server.headersTimeout > p.proxy.server.keepAliveTimeout);
  const { DEFAULTS } = await import('../server.mjs');
  assert.ok(DEFAULTS.deadlineMs < 60_000);
});

test('a pending nonce read goes where sends go, not to a random node', async (t) => {
  const [p, f] = await setup(t, [['heavy', { weight: 3 }], ['light', { weight: 1 }]], { strategy: 'weighted' });
  for (let i = 0; i < 40; i++) assert.equal((await p.rpc('eth_getTransactionCount', [ADDR, 'pending'])).result, 'heavy:eth_getTransactionCount');
  assert.equal(f.light.calls('eth_getTransactionCount'), 0);
});

test('CLAMPING_UPSTREAMS pins an upstream as clamping whatever its probe says', async (t) => {
  const [p, f] = await setup(t, [
    ['staccpad', { weight: 5, handler: strictLogs({ address: '0xstaccpad' }) }], // probes like a strict node today
    ['strict', { weight: 1, handler: strictLogs({ address: ADDR }) }],
  ], { clampingUpstreams: ['staccpad'] });
  assert.equal(p.proxy.stats().upstreams.find((u) => u.name === 'staccpad').clampsLogs, true);
  f.staccpad.reset();
  assert.deepEqual((await p.rpc('eth_getLogs', [{ fromBlock: hex(990), toBlock: hex(1000), address: ADDR }])).result, [{ address: ADDR }]);
  assert.equal(f.staccpad.calls('eth_getLogs'), 0);
});
