import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, txHashOf, parseUpstreams, classifyError, configFromEnv, DEFAULT_UPSTREAMS, splitLogFilter } from '../server.mjs';

const kh = (s) => Buffer.from(keccak256(Buffer.from(s))).toString('hex');

test('large eth_getLogs ranges are bounded, disjoint and retain filters', () => {
  const filter = { address: '0xabc', topics: ['0xdef'], fromBlock: '0x64', toBlock: '0x16d' };
  const split = splitLogFilter(filter, 100, 4);
  assert.deepEqual(split.chunks.map((x) => [x.fromBlock, x.toBlock]), [
    ['0x64', '0xc7'], ['0xc8', '0x12b'], ['0x12c', '0x16d'],
  ]);
  assert.ok(split.chunks.every((x) => x.address === filter.address && x.topics === filter.topics));
  assert.equal(splitLogFilter({ ...filter, blockHash: '0x1234' }, 100, 4), null);
  assert.equal(splitLogFilter({ ...filter, toBlock: 'latest' }, 100, 4), null);
  assert.equal(splitLogFilter(filter, 100, 2).error.code, -32000);
  assert.deepEqual(splitLogFilter({ ...filter, fromBlock: '0x384', toBlock: '0x3e8' }, 100, 4, 1000, 50)
    .chunks.map((x) => [x.fromBlock, x.toBlock]), [['0x384', '0x3b6'], ['0x3b7', '0x3e8']],
  'a short historical scan is divided before the strict-only trailing 50 blocks');
});

test('keccak256 matches the standard vectors', () => {
  assert.equal(kh(''), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(kh('abc'), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(kh('totalDelayedMessagesRead()').slice(0, 8), '7fa3a40e');
  // rate boundary (136 bytes) and multi-block input
  assert.equal(kh('a'.repeat(135)), '34367dc248bbd832f4e3e69dfaac2f92638bd0bbd18f2912ba4ef454919cf446');
  assert.equal(kh('a'.repeat(136)), 'a6c4d403279fe3e0af03729caada8374b5ca54d8065329a3ebcaeb4b60aa386e');
  assert.equal(txHashOf('0x616263'), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(txHashOf('0x'), null, 'no bytes, no transaction');
  assert.equal(txHashOf('0xabc'), null, 'odd-length hex is not a transaction');
  assert.equal(txHashOf(42), null);
});

test('RPC_UPSTREAMS: names, weights, ${DRPC_URL} expansion, skips', () => {
  const env = { DRPC_URL: 'https://lb.drpc.org/ogrpc?network=robinhood&dkey=SECRET' };
  const { upstreams, warnings } = parseUpstreams(DEFAULT_UPSTREAMS, env);
  assert.deepEqual(upstreams.map((u) => [u.name, u.weight]), [['drpc', 4], ['publicnode', 3], ['staccpad', 2], ['official', 1]]);
  assert.equal(upstreams[0].url, env.DRPC_URL);
  assert.deepEqual(warnings, []);

  const noDrpc = parseUpstreams(DEFAULT_UPSTREAMS, {});
  assert.deepEqual(noDrpc.upstreams.map((u) => u.name), ['publicnode', 'staccpad', 'official']);
  assert.equal(noDrpc.warnings.length, 1);
  assert.match(noDrpc.warnings[0], /drpc: \$DRPC_URL is not set/);
  assert.doesNotMatch(JSON.stringify(parseUpstreams('x=$DRPC_URL|zz', env)), /SECRET/, 'warnings never carry the secret');

  const mixed = parseUpstreams(' https://a.example/rpc , $DRPC_URL|2, DRPC_URL , b=https://b.example|0 ,, ftp://c.example ', env);
  assert.deepEqual(mixed.upstreams.map((u) => [u.name, u.url, u.weight]), [
    ['a.example', 'https://a.example/rpc', 1],
    ['lb.drpc.org', env.DRPC_URL, 2],
    ['b', 'https://b.example', 0],
  ]);
  assert.equal(mixed.warnings.length, 2, 'duplicate DRPC_URL and ftp:// are skipped');
});

test('configFromEnv reads numbers and falls back on junk', () => {
  const c = configFromEnv({ TIMEOUT_MS: '100', LOGS_TIMEOUT_MS: 'nope', MAX_LAG_BLOCKS: '50', STRATEGY: 'priority', RPC_UPSTREAMS: 'x=https://x.example' });
  assert.equal(c.timeoutMs, 100);
  assert.equal(c.logsTimeoutMs, 20_000);
  assert.equal(c.maxLagBlocks, 50);
  assert.equal(c.strategy, 'priority');
  assert.equal(c.host, '::');
  assert.equal(c.port, 8545);
  assert.equal(c.chainId, 4663);
  assert.deepEqual(c.upstreams.map((u) => u.name), ['x']);
  assert.deepEqual(configFromEnv({ CLAMPING_UPSTREAMS: ' staccpad, official ,' }).clampingUpstreams, ['staccpad', 'official']);
  assert.ok(c.deadlineMs < 60_000, 'answers before Nitro\'s 60s parent-chain client gives up');
});

test('error classes, including the exact messages the live upstreams return', () => {
  const cases = [
    [{ code: -32000, message: 'execution reverted' }, 'final'],
    [{ code: 3, message: 'execution reverted: rate limit exceeded', data: '0x08c379a0' }, 'final'],
    [{ code: -32000, message: 'nonce too low: next nonce 5, tx nonce 4' }, 'final'],
    [{ code: -32000, message: 'insufficient funds for gas * price + value' }, 'final'],
    [{ code: -32602, message: 'invalid argument 0: hex string without 0x prefix' }, 'final'],
    [{ code: 26, message: 'Unknown block' }, 'lag'],                                   // staccpad, dRPC
    [{ code: -32000, message: 'unknown block' }, 'lag'],
    [{ code: -32000, message: 'header not found' }, 'lag'],                             // publicnode
    [{ code: -32000, message: 'unsupported block number 73212607' }, 'lag'],            // official
    [{ code: -32000, message: 'invalid block range params' }, 'lag'],                   // publicnode
    [{ code: 27, message: 'Unknown state. First available state is 1' }, 'capability'], // staccpad
    [{ code: -32000, message: 'missing trie node 1234 (path )' }, 'capability'],
    [{ code: -32000, message: 'historical state 6b2d96b0 is not available' }, 'capability'], // official
    [{ code: -32602, message: 'Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode' }, 'capability'],
    [{ code: -32000, message: 'exceed maximum block range: 50000' }, 'capability'],
    [{ code: -32005, message: 'query returned more than 10000 results' }, 'capability'],
    [{ code: -32601, message: 'the method eth_foo does not exist/is not available' }, 'capability'],
    [{ code: -32005, message: 'Rate limit exceeded. To obtain higher limits, please request a personal token or a dedicated node: https://www.allnodes.com/publicnode' }, 'ratelimit'],
    [{ code: -32005, message: 'limit exceeded' }, 'ratelimit'],
    [{ code: 429, message: 'Too Many Requests' }, 'ratelimit'],
    [{ code: -32603, message: 'internal error' }, 'transient'],
    [{ code: -32000, message: 'request timed out' }, 'transient'],
    // found in review: node-side timeouts must fail over, not be handed to Nitro as the answer
    [{ code: -32000, message: 'context deadline exceeded' }, 'transient'],
    [{ code: -32000, message: 'unexpected EOF' }, 'transient'],
    [{ code: -32000, message: 'header for hash not found' }, 'lag'],
    [{ code: -32000, message: 'block 0x45d3a1f not found' }, 'lag'],
    [{ code: -32000, message: 'transaction indexing is in progress' }, 'lag'],
    [{ code: -32000, message: 'distance to target block (100000) exceeds max-recreate-state-depth (1024)' }, 'capability'],
    [{ code: -32602, message: 'eth_getLogs and eth_newFilter are limited to a 10,000 blocks range' }, 'capability'],
    [{ code: -32000, message: 'Your app has exceeded its compute units per second capacity' }, 'ratelimit'],
    [{ code: -32000, message: 'gas limit reached' }, 'final'],
    [{ code: -32000, message: 'tx gas limit exceeded' }, 'final'],
    [{ code: -32000, message: 'max fee per gas less than block base fee' }, 'final'],
  ];
  for (const [err, want] of cases) assert.equal(classifyError(err), want, `${err.code} ${err.message}`);
});
