import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPublicClient, createWalletClient, http as viemHttp, parseAbi, formatEther, encodeFunctionData, decodeFunctionResult, decodeEventLog, defineChain, getAddress, isAddress, keccak256, RpcError, TransactionNotFoundError } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ALL_TOOLS, TOOLS_BY_NAME, isBrowserSafe, unwrap } from './mcp/src/registry.mjs';
import { createServer as createMcpServer, isHostable, hostableFor, VERSION as MCP_VERSION } from './mcp/src/server.mjs';
import { runAs, OPERATOR } from './mcp/src/actor.mjs';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createRobinhoodOg } from './server/og/robinhood.mjs';
import { createPlaid } from './server/plaid.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The single source of truth for every address: written by the Orbit deployment, committed to the repo.
const DEPLOY = JSON.parse(fs.readFileSync(path.join(__dirname, 'src', 'contracts', 'l4-deployment.json'), 'utf8'));

const app = express();
const PORT = process.env.PORT || 3000;
const ORBIT_L4_CHAIN_ID = DEPLOY.chainId;
const L3_CHAIN_ID = DEPLOY.parentChainId;
const L3_RPC = process.env.VITE_ROBINHOOD_RPC_URL || DEPLOY.parentRpcUrl;
// Nitro sequencer: reach it over Fly's private network when we're on Fly, else the public URL. The web app (xgas)
// and the node (xgas-l4) share a Fly org, so the .internal name resolves.
const L4_RPC_INTERNAL = process.env.L4_RPC_INTERNAL || (process.env.FLY_APP_NAME ? 'http://xgas-l4.internal:8449' : DEPLOY.sequencerRpcUrl);
// A stale L4_RPC_INTERNAL secret would quietly serve the retired chain under this chain's frontend. Say so loudly.
fetch(L4_RPC_INTERNAL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) })
  .then((r) => r.json()).then((j) => {
    const got = parseInt(j.result, 16), want = Number(DEPLOY.chainId || 466302);
    if (got !== want) console.error(`[boot] L4 RPC ${L4_RPC_INTERNAL} is chain ${got}, expected ${want}: fix the L4_RPC_INTERNAL secret`);
    else console.log(`[boot] L4 RPC ${L4_RPC_INTERNAL} is chain ${got}`);
  }).catch((e) => console.error('[boot] L4 RPC chainId check failed:', e.message));
const L4_RPC_PUBLIC = DEPLOY.publicRpcUrl; // https://xgas.dev/rpc — the only RPC URL users ever see
// The host's one hot key. It executes Outbox withdrawals on Robinhood on users' behalf (a permissionless call; we
// just pay gas) and runs the XGAS.DEV buyback keeper. Neither needs any role, so this should be a no-role claimer
// key with a little ETH, never the chain owner key (0xC3D6), which holds EXECUTOR_ROLE on both UpgradeExecutors.
// The Fly secret is still named L2_EXECUTOR_KEY from before the L2->L3->L4 rename.
// Accept either, so renaming the code does not silently switch the Outbox executor off.
const L3_EXECUTOR_KEY = process.env.L3_EXECUTOR_KEY || process.env.L2_EXECUTOR_KEY || '';

// Off Fly only, XGAS_DATA_DIR_DEV points local test runs at a scratch directory so they never touch l4-data.
const DATA_DIR = (!process.env.FLY_APP_NAME && process.env.XGAS_DATA_DIR_DEV)
  ? path.resolve(process.env.XGAS_DATA_DIR_DEV)
  : fs.existsSync('/data') ? '/data' : path.join(__dirname, 'l4-data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const l3Client = createPublicClient({ transport: viemHttp(L3_RPC) });
const l4Client = createPublicClient({ transport: viemHttp(L4_RPC_INTERNAL, { timeout: 15_000 }) });

// The Robinhood OTC routes parse their own bodies, each with its own limit, before the general 1mb JSON parser
// below (which then skips them). A malformed or oversized body gets a JSON error, not an HTML page.
const EVIDENCE_MAX_IMAGE_BYTES = 2 * 1024 * 1024; // one png / jpeg / webp
const EVIDENCE_MAX_TEXT_BYTES = 20 * 1024;        // or plain text
app.use('/api/robinhood/gas', express.json({ limit: '2kb' }));
app.post('/api/robinhood/evidence',
  express.json({ limit: '3mb' }), // { tradeId, text } or { tradeId, image: base64 }
  express.raw({ type: ['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'], limit: EVIDENCE_MAX_IMAGE_BYTES }),
  express.raw({ type: 'multipart/form-data', limit: EVIDENCE_MAX_IMAGE_BYTES + 64 * 1024 }),
  express.raw({ type: 'text/plain', limit: EVIDENCE_MAX_TEXT_BYTES }),
  (_req, _res, next) => next('route'));
app.use('/api/robinhood', (err, req, res, next) => {
  if (!err) return next();
  const evidence = req.path.startsWith('/evidence');
  if (err.status === 413 || err.type === 'entity.too.large') {
    return res.status(413).json({ error: evidence ? 'Too large: images are limited to 2 MB and text to 20 KB.' : 'Request body too large.' });
  }
  res.status(400).json({ error: evidence ? 'Could not read the upload.' : 'Request body must be JSON like {"address":"0x..."}.' });
});
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ---------------------------------------------------------------------------
// /rpc -> the Nitro sequencer. Kept so wallets configured with https://xgas.dev/rpc keep working.
// ---------------------------------------------------------------------------
app.post(['/rpc', '/api/rpc'], (req, res) => {
  const body = JSON.stringify(req.body);
  const target = new URL(L4_RPC_INTERNAL);
  const mod = target.protocol === 'https:' ? https : http;
  const proxyReq = mod.request({
    hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80), path: target.pathname || '/', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: 20_000,
  }, (proxyRes) => { res.writeHead(proxyRes.statusCode || 200, { 'content-type': 'application/json' }); proxyRes.pipe(res, { end: true }); });
  proxyReq.on('timeout', () => proxyReq.destroy(new Error('timeout')));
  proxyReq.on('error', (err) => {
    console.error('L4 RPC proxy error:', err.message);
    res.status(502).json({ jsonrpc: '2.0', id: req.body?.id ?? null, error: { code: -32603, message: 'xgas Orbit L4 sequencer unreachable' } });
  });
  proxyReq.write(body); proxyReq.end();
});

// ---------------------------------------------------------------------------
// Chain info
// ---------------------------------------------------------------------------
let l4Head = { block: 0, at: 0 };
async function refreshHead() {
  try { const n = await l4Client.getBlockNumber(); l4Head = { block: Number(n), at: Date.now() }; } catch (e) { /* keep last */ }
}
setInterval(refreshHead, 5000); refreshHead();

// ok is the web app itself. The assertion age is reported beside it, not folded into it, so a monitor watching
// ok does not restart a healthy app over a validator on another machine. In rollup mode every batch is calldata on
// Robinhood, so there is no data availability server to report on.
function assertionSummary(c) {
  const confirmedAt = c.confirmedAt || null;
  return c.hash ? {
    l4Block: c.l4Block ?? null,
    confirmedAt: confirmedAt ? new Date(confirmedAt).toISOString() : null,
    ageS: confirmedAt ? Math.round((Date.now() - confirmedAt) / 1000) : null,
  } : null;
}
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true, l4Ready: Date.now() - l4Head.at < 60_000, l4Head: l4Head.block, chainId: ORBIT_L4_CHAIN_ID, executor: !!L3_EXECUTOR_KEY,
    latestConfirmedAssertion: assertionSummary(CURRENT.confirmed),
    legacy: LEGACY_CHAIN ? { chainId: LEGACY_CHAIN.chainId, latestConfirmedAssertion: assertionSummary(LEGACY_CHAIN.confirmed), lastError: LEGACY_CHAIN.lastError } : null,
  });
});

app.get('/api/l4-info', (_req, res) => {
  res.json({
    chainId: ORBIT_L4_CHAIN_ID, rpcPath: '/rpc', rpcUrl: L4_RPC_PUBLIC, wsUrl: DEPLOY.wsUrl,
    l3ChainId: L3_CHAIN_ID, vault: DEPLOY.l3.xMoney, ready: Date.now() - l4Head.at < 60_000, head: l4Head.block,
    contracts: DEPLOY.l4, l3: DEPLOY.l3,
    deployment: {
      createRollupTx: DEPLOY.createRollupTx, createdAt: DEPLOY.createdAt, deployedAtBlock: DEPLOY.deployedAtBlock, owner: DEPLOY.owner,
      batchPoster: DEPLOY.batchPoster, validator: DEPLOY.validator, validators: DEPLOY.validators || [DEPLOY.validator],
      validatorWhitelistDisabled: !!DEPLOY.validatorWhitelistDisabled, fastConfirmSafe: DEPLOY.fastConfirmSafe || null,
      fastConfirmThreshold: DEPLOY.fastConfirmThreshold || null, feeTokenPricer: DEPLOY.feeTokenPricer || null,
      dataAvailability: DEPLOY.dataAvailability || 'rollup',
    },
    legacy: DEPLOY.legacy466301 ? { chainId: DEPLOY.legacy466301.chainId, status: DEPLOY.legacy466301.status, l3: DEPLOY.legacy466301.l3 } : null,
  });
});

app.get('/api/l4-balance/:address', async (req, res) => {
  try {
    const address = req.params.address;
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return res.status(400).json({ error: 'Invalid address' });
    const wei = await l4Client.getBalance({ address });
    res.json({ address, chainId: ORBIT_L4_CHAIN_ID, balanceWei: wei.toString(), balance: formatEther(wei) });
  } catch (e) { res.status(500).json({ error: e.message || 'Failed to read L4 balance' }); }
});

// ---------------------------------------------------------------------------
// Withdrawals (L4 -> L3): ArbSys.withdrawEth on the L4 emits L2ToL1Tx; once the assertion covering it is
// confirmed on Robinhood, anyone can execute it on the Outbox. We track them and execute for users.
//
// Tracked per chain. The current chain (466302) comes first. The retired chain (466301, `legacy466301` in the
// deployment file) stays for as long as its node answers, so a withdrawal started there can still be claimed on
// its own Outbox: exits out of the old bridge were never affected by the vault switch. Positions restart at 0 on
// every chain, so each chain keeps its own file and its own confirmed send count.
// ---------------------------------------------------------------------------
const ARBSYS_ABI = parseAbi([
  'event L2ToL1Tx(address caller, address indexed destination, uint256 indexed hash, uint256 indexed position, uint256 arbBlockNum, uint256 ethBlockNum, uint256 timestamp, uint256 callvalue, bytes data)'
]);
const OUTBOX_ABI = parseAbi([
  'function isSpent(uint256 index) view returns (bool)',
  'function roots(bytes32) view returns (bytes32)',
  'function executeTransaction(bytes32[] proof, uint256 index, address l2Sender, address to, uint256 l2Block, uint256 l1Block, uint256 l2Timestamp, uint256 value, bytes data)'
]);
const ROLLUP_ABI = parseAbi([
  'function latestConfirmed() view returns (bytes32)',
  'event AssertionConfirmed(bytes32 indexed assertionHash, bytes32 blockHash, bytes32 sendRoot)'
]);
const NODE_INTERFACE_ABI = parseAbi([
  'function constructOutboxProof(uint64 size, uint64 leaf) view returns (bytes32 send, bytes32 root, bytes32[] proof)'
]);

function makeChain({ chainId, legacy, rpc, client, rollup, outbox, deployedAtBlock, file }) {
  const f = path.join(DATA_DIR, file);
  let withdrawals = {}; // `${txHash}:${position}` -> { ...event, status }
  try { if (fs.existsSync(f)) withdrawals = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  return {
    chainId, legacy, rpc, rollup, outbox, deployedAtBlock: BigInt(deployedAtBlock), file: f, withdrawals,
    client: client || createPublicClient({ transport: viemHttp(rpc, { timeout: 15_000 }) }),
    scannedTo: 0n, confirmed: { count: 0n, at: 0 }, lastError: null,
  };
}

const CURRENT = makeChain({
  chainId: ORBIT_L4_CHAIN_ID, legacy: false, rpc: L4_RPC_INTERNAL, client: l4Client,
  rollup: DEPLOY.l3.rollup, outbox: DEPLOY.l3.outbox, deployedAtBlock: DEPLOY.deployedAtBlock,
  file: `withdrawals-${ORBIT_L4_CHAIN_ID}.json`,
});
// LEGACY_L4_RPC overrides the old node's URL; set it to "off" once that node is gone for good.
const LEGACY = DEPLOY.legacy466301 || null;
const LEGACY_L4_RPC = process.env.LEGACY_L4_RPC || LEGACY?.sequencerRpcUrl || '';
const LEGACY_CHAIN = LEGACY && LEGACY_L4_RPC && LEGACY_L4_RPC !== 'off' ? makeChain({
  chainId: LEGACY.chainId, legacy: true, rpc: LEGACY_L4_RPC,
  rollup: LEGACY.l3.rollup, outbox: LEGACY.l3.outbox, deployedAtBlock: LEGACY.deployedAtBlock,
  // The file every withdrawal on 466301 was saved to before the relaunch. Reused as is, so nothing is migrated.
  file: 'withdrawals.json',
}) : null;
const CHAINS = [CURRENT, LEGACY_CHAIN].filter(Boolean);
const chainById = (id) => CHAINS.find((c) => c.chainId === Number(id));

const saveWithdrawals = (c) => { try { fs.writeFileSync(c.file, JSON.stringify(c.withdrawals)); } catch {} };
// A retired node that has gone away should say so once, not every ten seconds.
function chainError(c, what, e) {
  const msg = `${what}: ${e?.shortMessage || e?.message || e}`;
  if (c.lastError !== msg) console.warn(`[withdrawals ${c.chainId}] ${msg}`);
  c.lastError = msg;
}

async function scanWithdrawals(c) {
  try {
    const head = await c.client.getBlockNumber();
    if (head <= c.scannedTo) return;
    const from = c.scannedTo === 0n ? 0n : c.scannedTo + 1n;
    const logs = await c.client.getLogs({ address: DEPLOY.l4.arbSys, event: ARBSYS_ABI[0], fromBlock: from, toBlock: head });
    for (const log of logs) {
      const a = log.args;
      const key = `${log.transactionHash}:${a.position}`;
      if (c.withdrawals[key]) continue;
      c.withdrawals[key] = {
        txHash: log.transactionHash, caller: a.caller, destination: a.destination, position: a.position.toString(),
        arbBlockNum: a.arbBlockNum.toString(), ethBlockNum: a.ethBlockNum.toString(), timestamp: a.timestamp.toString(),
        callvalue: a.callvalue.toString(), data: a.data, status: 'pending', createdAt: Date.now(),
      };
    }
    c.scannedTo = head;
    c.lastError = null;
    if (logs.length) saveWithdrawals(c);
  } catch (e) { chainError(c, 'scan error', e); }
}
const scanAllWithdrawals = () => Promise.all(CHAINS.map(scanWithdrawals));

/** sendCount of the latest confirmed assertion on Robinhood = how many L4->L3 sends are executable. */
async function refreshConfirmedSendCount(c) {
  try {
    const hash = await l3Client.readContract({ address: c.rollup, abi: ROLLUP_ABI, functionName: 'latestConfirmed' });
    if (c.confirmed.hash === hash) { c.confirmed.at = Date.now(); return; }
    const logs = await l3Client.getLogs({ address: c.rollup, event: ROLLUP_ABI[1], args: { assertionHash: hash }, fromBlock: c.deployedAtBlock, toBlock: 'latest' });
    if (logs.length === 0) { c.confirmed = { count: 0n, at: Date.now(), hash, l4Block: 0 }; return; } // still at genesis
    const blockHash = logs[logs.length - 1].args.blockHash;
    const block = await c.client.request({ method: 'eth_getBlockByHash', params: [blockHash, false] });
    // When the parent chain confirmed it, for /api/health. One extra read, and only when the assertion changes.
    const confirmedAt = await l3Client.getBlock({ blockNumber: logs[logs.length - 1].blockNumber }).then((b) => Number(b.timestamp) * 1000).catch(() => null);
    c.confirmed = { count: BigInt(block?.sendCount ?? '0x0'), at: Date.now(), hash, blockHash, l4Block: block ? parseInt(block.number, 16) : null, confirmedAt };
    console.log(`[withdrawals ${c.chainId}] latest confirmed assertion ${hash.slice(0, 10)} -> L4 block ${c.confirmed.l4Block}, sendCount ${c.confirmed.count}`);
  } catch (e) { chainError(c, 'confirmed send count error', e); }
}

async function withdrawalStatus(c, w) {
  if (w.status === 'executed') return w;
  try {
    const spent = await l3Client.readContract({ address: c.outbox, abi: OUTBOX_ABI, functionName: 'isSpent', args: [BigInt(w.position)] });
    if (spent) { w.status = 'executed'; return w; }
  } catch {}
  w.status = BigInt(w.position) < c.confirmed.count ? 'claimable' : 'pending';
  return w;
}

app.get('/api/withdrawals/:address', async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(addr)) return res.status(400).json({ error: 'Invalid address' });
    await scanAllWithdrawals();
    const out = [];
    for (const c of CHAINS) {
      const mine = Object.values(c.withdrawals).filter(w => w.caller.toLowerCase() === addr || w.destination.toLowerCase() === addr);
      for (const w of mine) await withdrawalStatus(c, w);
      if (mine.length) saveWithdrawals(c);
      out.push(...mine.sort((a, b) => Number(b.position) - Number(a.position))
        .map(w => ({ ...w, amount: formatEther(BigInt(w.callvalue)), chainId: c.chainId, legacy: c.legacy })));
    }
    // The top-level counts describe the current chain, as before; legacy entries carry chainId and legacy: true.
    res.json({ chainId: CURRENT.chainId, confirmedSendCount: CURRENT.confirmed.count.toString(), confirmedL4Block: CURRENT.confirmed.l4Block ?? null, executorEnabled: !!L3_EXECUTOR_KEY,
      withdrawals: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** Find a tracked withdrawal. chainId narrows the search; txHash and position together are exact. */
function findWithdrawal({ txHash, position, chainId }) {
  const chains = chainId != null && chainId !== '' ? [chainById(chainId)].filter(Boolean) : CHAINS;
  const tx = txHash ? String(txHash).toLowerCase() : null;
  const pos = position != null && position !== '' ? String(position) : null;
  for (const c of chains) {
    const key = Object.keys(c.withdrawals).find((k) => {
      const [kTx, kPos] = k.split(':');
      if (tx && pos) return kTx.toLowerCase() === tx && kPos === pos;
      if (tx) return kTx.toLowerCase() === tx;
      return pos != null && kPos === pos;
    });
    if (key) return { c, w: c.withdrawals[key] };
  }
  return null;
}

app.post('/api/withdrawals/execute', async (req, res) => {
  try {
    if (!L3_EXECUTOR_KEY) return res.status(503).json({ error: 'Executor not configured on host; execute the Outbox claim from your own wallet.' });
    const found = findWithdrawal(req.body || {});
    if (!found) return res.status(404).json({ error: 'Unknown withdrawal' });
    const { c, w } = found;
    await refreshConfirmedSendCount(c);
    await withdrawalStatus(c, w);
    if (w.status === 'executed') return res.json({ ok: true, alreadyExecuted: true, chainId: c.chainId });
    if (w.status !== 'claimable') return res.status(409).json({ error: 'Not yet confirmed on Robinhood Chain', status: w.status, chainId: c.chainId });

    const { hash, ok } = await executeOutbox(c, w);
    if (!ok) return res.status(500).json({ error: 'Outbox execution reverted', txHash: hash, chainId: c.chainId });
    res.json({ ok: true, txHash: hash, chainId: c.chainId });
  } catch (e) { console.error('[withdrawals/execute]', e); res.status(500).json({ error: e.shortMessage || e.message }); }
});

/** Execute a claimable L4 -> Robinhood send on that chain's Outbox with the host's executor key. */
async function executeOutbox(c, w) {
  const size = c.confirmed.count;
  const proofRes = await c.client.readContract({ address: DEPLOY.l4.nodeInterface, abi: NODE_INTERFACE_ABI, functionName: 'constructOutboxProof', args: [size, BigInt(w.position)] });
  const [, , proof] = proofRes;
  const account = privateKeyToAccount(L3_EXECUTOR_KEY);
  const wallet = createWalletClient({ account, transport: viemHttp(L3_RPC) });
  const hash = await wallet.writeContract({
    address: c.outbox, abi: OUTBOX_ABI, functionName: 'executeTransaction', chain: null,
    args: [proof, BigInt(w.position), w.caller, w.destination, BigInt(w.arbBlockNum), BigInt(w.ethBlockNum), BigInt(w.timestamp), BigInt(w.callvalue), w.data],
  });
  const rc = await l3Client.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') return { hash, ok: false };
  w.status = 'executed'; w.executedTx = hash; saveWithdrawals(c);
  return { hash, ok: true };
}

const refreshAllConfirmed = () => Promise.all(CHAINS.map(refreshConfirmedSendCount));
setInterval(refreshAllConfirmed, 15_000); refreshAllConfirmed();
setInterval(scanAllWithdrawals, 10_000);

// ---------------------------------------------------------------------------
// XGAS.DEV flywheel. Every L4 fee path sends 0.02% to the buyback FanoutSink. The keeper flushes that sink to
// Robinhood, executes the withdrawal on the Outbox (it lands on XgasDevBuyback as xMoney), then has XgasDevBuyback
// redeem the xMoney for USDG and buy + burn XGAS.DEV. The contract only lets the keeper trigger the buy, with a
// minimum out taken from a simulation a moment earlier, so nobody can pump the pool into our buy.
// The sink it flushes is the current chain's (empty until the L4 apps are deployed there). Sink withdrawals already
// in flight on the retired chain are still executed on its Outbox, so nothing that was headed for the buyback strands.
// ---------------------------------------------------------------------------
const BUYBACK_SINK = DEPLOY.l4.buybackSink || '';
const XGAS_BUYBACK = DEPLOY.l3.xgasDevBuyback || '';
const XGAS_DEV = '0x006D2D9e65f847e8B5f5053C9eb3a7824ec7dFa3';
const BUYBACK_FLUSH_MIN = BigInt(process.env.BUYBACK_FLUSH_MIN_WEI || '10000000000000000'); // 0.01 xMoney = FanoutSink.MIN_FLUSH
const BUYBACK_SLIPPAGE_BPS = BigInt(process.env.BUYBACK_SLIPPAGE_BPS || '300');
const SINK_ABI = parseAbi(['function flush() returns (uint256 amount, uint256 withdrawalId)', 'function totalFlushed() view returns (uint256)']);
const BUYBACK_ABI = parseAbi([
  'function execute(uint256 minXgasOut) returns (uint256 burned)',
  'function totalXgasBurned() view returns (uint256)',
  'function totalUsdgSpent() view returns (uint256)',
  'function totalEthSpent() view returns (uint256)',
  'function totalXMoneyRedeemed() view returns (uint256)',
]);
const ERC20_BALANCE_ABI = parseAbi(['function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)']);
let buybackKeeper = { running: false, lastRun: 0, lastFlushTx: null, lastBurnTx: null, lastError: null };

async function buybackBalances() {
  const [xMoney, usdg, eth] = await Promise.all([
    l3Client.readContract({ address: DEPLOY.l3.xMoney, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [XGAS_BUYBACK] }),
    l3Client.readContract({ address: DEPLOY.l3.usdg, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [XGAS_BUYBACK] }),
    l3Client.getBalance({ address: XGAS_BUYBACK }),
  ]);
  return { xMoney, usdg, eth };
}

async function runBuybackKeeper() {
  if (!L3_EXECUTOR_KEY || !XGAS_BUYBACK || buybackKeeper.running) return;
  buybackKeeper.running = true;
  try {
    const account = privateKeyToAccount(L3_EXECUTOR_KEY);

    // 1. L4: push the sink's xMoney toward Robinhood.
    const pending = BUYBACK_SINK ? await l4Client.getBalance({ address: BUYBACK_SINK }) : 0n;
    if (BUYBACK_SINK && pending >= BUYBACK_FLUSH_MIN) {
      const l4Wallet = createWalletClient({ account, transport: viemHttp(L4_RPC_INTERNAL) });
      const hash = await l4Wallet.writeContract({ address: BUYBACK_SINK, abi: SINK_ABI, functionName: 'flush', chain: null });
      await l4Client.waitForTransactionReceipt({ hash });
      buybackKeeper.lastFlushTx = hash;
      console.log(`[buyback] flushed ${formatEther(pending)} xMoney from the L4 sink: ${hash}`);
    }

    // 2. Robinhood: execute confirmed sink withdrawals (on every tracked chain) so the xMoney lands on XgasDevBuyback.
    await scanAllWithdrawals();
    for (const c of CHAINS) {
      for (const w of Object.values(c.withdrawals)) {
        if (w.destination.toLowerCase() !== XGAS_BUYBACK.toLowerCase() || w.status === 'executed') continue;
        await withdrawalStatus(c, w);
        if (w.status !== 'claimable') continue;
        const { hash, ok } = await executeOutbox(c, w);
        console.log(`[buyback] outbox ${ok ? 'executed' : 'REVERTED'} on ${c.chainId} for ${formatEther(BigInt(w.callvalue))} xMoney: ${hash}`);
      }
    }

    // 3. Robinhood: redeem, buy, burn.
    const { xMoney, usdg, eth } = await buybackBalances();
    if (xMoney >= 10n ** 16n || usdg >= 10_000n || eth >= 10n ** 13n) {
      const { result } = await l3Client.simulateContract({ account, address: XGAS_BUYBACK, abi: BUYBACK_ABI, functionName: 'execute', args: [0n] });
      const minOut = (result * (10_000n - BUYBACK_SLIPPAGE_BPS)) / 10_000n;
      const wallet = createWalletClient({ account, transport: viemHttp(L3_RPC) });
      const hash = await wallet.writeContract({ address: XGAS_BUYBACK, abi: BUYBACK_ABI, functionName: 'execute', args: [minOut], chain: null });
      const rc = await l3Client.waitForTransactionReceipt({ hash });
      buybackKeeper.lastBurnTx = hash;
      console.log(`[buyback] ${rc.status === 'success' ? 'burned' : 'REVERTED, simulated'} ~${formatEther(result)} XGAS.DEV: ${hash}`);
    }
    buybackKeeper.lastError = null;
  } catch (e) {
    buybackKeeper.lastError = e.shortMessage || e.message;
    console.warn('[buyback] keeper error:', buybackKeeper.lastError);
  } finally {
    buybackKeeper.running = false;
    buybackKeeper.lastRun = Date.now();
  }
}
setInterval(runBuybackKeeper, Number(process.env.BUYBACK_INTERVAL_MS || 5 * 60_000));
setTimeout(runBuybackKeeper, 30_000);

app.get('/api/buyback', async (_req, res) => {
  if (!XGAS_BUYBACK) return res.json({ live: false });
  try {
    const read = (functionName) => l3Client.readContract({ address: XGAS_BUYBACK, abi: BUYBACK_ABI, functionName });
    const [burned, usdgSpent, ethSpent, xMoneyRedeemed, xgasSupply, onL4, onRobinhood] = await Promise.all([
      read('totalXgasBurned'), read('totalUsdgSpent'), read('totalEthSpent'), read('totalXMoneyRedeemed'),
      l3Client.readContract({ address: XGAS_DEV, abi: ERC20_BALANCE_ABI, functionName: 'totalSupply' }),
      BUYBACK_SINK ? l4Client.getBalance({ address: BUYBACK_SINK }) : 0n,
      buybackBalances(),
    ]);
    const inFlight = CHAINS.flatMap((c) => Object.values(c.withdrawals))
      .filter(w => w.destination.toLowerCase() === XGAS_BUYBACK.toLowerCase() && w.status !== 'executed')
      .reduce((a, w) => a + BigInt(w.callvalue), 0n);
    res.json({
      live: true, token: XGAS_DEV, buyback: XGAS_BUYBACK, sink: BUYBACK_SINK, feeBps: 2,
      xgasBurned: formatEther(burned), xgasSupply: formatEther(xgasSupply),
      usdgSpent: (Number(usdgSpent) / 1e6).toString(), ethSpent: formatEther(ethSpent), xMoneyRedeemed: formatEther(xMoneyRedeemed),
      pending: { l4Sink: formatEther(onL4), inOutbox: formatEther(inFlight), xMoney: formatEther(onRobinhood.xMoney), usdg: (Number(onRobinhood.usdg) / 1e6).toString(), eth: formatEther(onRobinhood.eth) },
      keeper: { enabled: !!L3_EXECUTOR_KEY, address: L3_EXECUTOR_KEY ? privateKeyToAccount(L3_EXECUTOR_KEY).address : null, lastRun: buybackKeeper.lastRun, lastFlushTx: buybackKeeper.lastFlushTx, lastBurnTx: buybackKeeper.lastBurnTx, lastError: buybackKeeper.lastError },
    });
  } catch (e) { res.status(500).json({ error: e.shortMessage || e.message }); }
});

// ---------------------------------------------------------------------------
// Sign in with X (OAuth 2.0 + PKCE). Configure with Fly secrets:
//   X_CLIENT_ID (required), X_CLIENT_SECRET (confidential clients), X_CALLBACK_URL (default https://xgas.dev/auth/x/callback)
// Sessions are HMAC-signed cookies; the signing key persists in DATA_DIR so logins survive restarts.
// ---------------------------------------------------------------------------
const X_CLIENT_ID = process.env.X_CLIENT_ID || '';
const X_CLIENT_SECRET = process.env.X_CLIENT_SECRET || '';
const X_CALLBACK_URL = process.env.X_CALLBACK_URL || 'https://xgas.dev/auth/x/callback';
const X_AUTH_URL = 'https://x.com/i/oauth2/authorize';
const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const X_ME_URL = 'https://api.x.com/2/users/me?user.fields=profile_image_url,name,username';
const SESSION_COOKIE = 'xgas_sess';
const OAUTH_COOKIE = 'xgas_oauth';
const SESSION_TTL_S = 30 * 24 * 3600;

function loadSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(DATA_DIR, 'session-secret');
  try {
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, secret, { mode: 0o600 });
    return secret;
  } catch {
    return crypto.randomBytes(32).toString('hex');
  }
}
const SESSION_SECRET = loadSessionSecret();

const b64url = (buf) => Buffer.from(buf).toString('base64url');
function sign(payloadObj) {
  const payload = b64url(JSON.stringify(payloadObj));
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}
function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (obj.exp && Date.now() > obj.exp) return null;
    return obj;
  } catch {
    return null;
  }
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isSecure(req) {
  return (req.headers['x-forwarded-proto'] || req.protocol) === 'https';
}
function setCookie(req, res, name, value, maxAgeS) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeS}`];
  if (isSecure(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
function clearCookie(req, res, name) {
  setCookie(req, res, name, '', 0);
}
// A same-site path to land on after Sign in with X: one segment, or a Robinhood desk deep link.
function safeReturnTo(v) {
  if (typeof v !== 'string') return '/';
  if (/^\/[a-z0-9_-]*$/i.test(v)) return v;
  if (/^\/robinhood\/(?:post|trades|arbiters|(?:order|trade)\/\d{1,20})$/i.test(v)) return v;
  return '/';
}
function currentUser(req) {
  const sess = verify(parseCookies(req)[SESSION_COOKIE]);
  // Only real sessions: a connector token is signed with the same secret, so without this check it would
  // work as a cookie too and survive its own revocation. Sessions minted before `k` existed carry none.
  if (!sess || !sess.handle || (sess.k !== undefined && sess.k !== 'session')) return null;
  return { id: sess.id, handle: sess.handle, name: sess.name, avatar: sess.avatar };
}

app.get('/api/me', (req, res) => {
  res.json({ configured: !!X_CLIENT_ID, user: currentUser(req) });
});

app.get('/auth/x/login', (req, res) => {
  if (!X_CLIENT_ID) return res.status(503).send('Sign in with X is not configured (X_CLIENT_ID missing).');
  const state = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const returnTo = safeReturnTo(req.query.returnTo);
  setCookie(req, res, OAUTH_COOKIE, sign({ state, verifier, returnTo, exp: Date.now() + 10 * 60 * 1000 }), 600);
  const url = new URL(X_AUTH_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', X_CLIENT_ID);
  url.searchParams.set('redirect_uri', X_CALLBACK_URL);
  url.searchParams.set('scope', 'users.read tweet.read');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  res.redirect(url.toString());
});

app.get('/auth/x/callback', async (req, res) => {
  try {
    const pending = verify(parseCookies(req)[OAUTH_COOKIE]);
    clearCookie(req, res, OAUTH_COOKIE);
    const { code, state, error, error_description } = req.query;
    if (error) return res.redirect(`/?xauth=denied&reason=${encodeURIComponent(String(error_description || error))}`);
    if (!pending || !code || state !== pending.state) return res.status(400).send('Invalid OAuth state. Start again from the site.');

    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: X_CALLBACK_URL,
      code_verifier: pending.verifier,
      client_id: X_CLIENT_ID,
    });
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (X_CLIENT_SECRET) headers.Authorization = 'Basic ' + Buffer.from(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch(X_TOKEN_URL, { method: 'POST', headers, body: form });
    const token = await tokenRes.json();
    if (!tokenRes.ok || !token.access_token) {
      console.error('[X AUTH] token exchange failed:', token);
      return res.status(502).send(`X token exchange failed: ${token.error_description || token.error || tokenRes.status}`);
    }
    const meRes = await fetch(X_ME_URL, { headers: { Authorization: `Bearer ${token.access_token}` } });
    const me = await meRes.json();
    if (!meRes.ok || !me.data?.username) {
      console.error('[X AUTH] users/me failed:', me);
      return res.status(502).send('Could not read your X profile.');
    }
    const sess = { k: 'session', id: me.data.id, handle: me.data.username, name: me.data.name, avatar: me.data.profile_image_url, exp: Date.now() + SESSION_TTL_S * 1000 };
    setCookie(req, res, SESSION_COOKIE, sign(sess), SESSION_TTL_S);
    console.log(`[X AUTH] @${me.data.username} signed in`);
    // Land somewhere that says so. A redirect that looks identical to the page you left is how people
    // end up asking whether it worked.
    const back = pending.returnTo || '/';
    res.redirect(`${back}${back.includes('?') ? '&' : '?'}xauth=ok`);
  } catch (e) {
    console.error('[X AUTH] callback error:', e);
    res.status(500).send('Sign in with X failed.');
  }
});

app.post('/auth/x/logout', (req, res) => {
  clearCookie(req, res, SESSION_COOKIE);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Connector API: the same quote/prepare tools the MCP serves, over HTTP for the site.
// Reads and prepares only — a prepared transaction is inert until the user's wallet
// signs it, and the browser sends through the wallet, so the submit relays stay off.
// ---------------------------------------------------------------------------
// The token a person hands their own model. Signed with the session secret, so it needs no storage;
// tied to their X id, so it can only ever reach their wallet.
const CONNECTOR_TTL_S = 180 * 24 * 3600;
// Revocation without a token table: each X id has an epoch, every token carries the epoch it was minted at,
// and revoking bumps the epoch, so every token minted before that stops verifying at once. Tokens from before
// epochs existed carry none and count as epoch 0, so they keep working until their owner revokes.
const CONNECTOR_EPOCHS_FILE = path.join(DATA_DIR, 'connector-epochs.json');
let connectorEpochs = {};
// A revocation list that silently resets would bring revoked tokens back, so a file that exists but won't
// parse disables connector tokens entirely until someone fixes it.
let connectorEpochsBroken = false;
try { if (fs.existsSync(CONNECTOR_EPOCHS_FILE)) connectorEpochs = JSON.parse(fs.readFileSync(CONNECTOR_EPOCHS_FILE, 'utf8')); }
catch (e) { connectorEpochsBroken = true; console.error(`[connector] ${CONNECTOR_EPOCHS_FILE} is unreadable; rejecting every connector token until it is fixed:`, e.message); }
const connectorEpoch = (id) => Number(connectorEpochs[String(id)] || 0);
function bumpConnectorEpoch(id) {
  const next = { ...connectorEpochs, [String(id)]: connectorEpoch(id) + 1 };
  const tmp = `${CONNECTOR_EPOCHS_FILE}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, CONNECTOR_EPOCHS_FILE);
  connectorEpochs = next;
  return next[String(id)];
}
const connectorClaimLive = (claim) => !connectorEpochsBroken && Number(claim.e || 0) === connectorEpoch(claim.id);

app.post('/api/connector/token', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in with X first: this mints a token for your own wallet.' });
  const token = sign({ k: 'connector', id: String(user.id), handle: user.handle, e: connectorEpoch(user.id), exp: Date.now() + CONNECTOR_TTL_S * 1000 });
  res.json({
    token,
    handle: user.handle,
    expires: new Date(Date.now() + CONNECTOR_TTL_S * 1000).toISOString(),
    usage: `Authorization: Bearer <token> against ${PUBLIC_ORIGIN}/mcp`,
    revoke: `POST ${PUBLIC_ORIGIN}/api/connector/revoke while signed in with X kills every connector token you have minted`,
  });
});

// Same gate as minting: the X session cookie, never a connector token, so a leaked token cannot lock its owner out.
app.post('/api/connector/revoke', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in with X first: this revokes the connector tokens for your own wallet.' });
  try {
    bumpConnectorEpoch(user.id);
  } catch (e) {
    console.error('[connector/revoke]', e);
    return res.status(500).json({ error: 'Could not save the revocation, so nothing was revoked. Try again.' });
  }
  console.log(`[connector] @${user.handle} revoked their connector tokens`);
  res.json({ ok: true, handle: user.handle, revoked: 'every connector token minted before now' });
});

app.get('/api/connector', (req, res) => {
  // Anonymous callers (the site in someone's browser) get reads and prepares. A caller holding the
  // connector's token is the operator, not a visitor, and gets the same surface as the hosted MCP:
  // the submit relays and the agent wallet included.
  const operator = authed(req);
  const allow = operator ? hostableFor(true) : isBrowserSafe;
  res.json({
    authenticated: operator,
    tools: ALL_TOOLS.filter((t) => allow(t.name)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  });
});

app.post('/api/connector/:tool', async (req, res) => {
  const name = req.params.tool;
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) return res.status(404).json({ error: `No such tool: ${name}` });
  const operator = authed(req);
  const allow = operator ? hostableFor(true) : isBrowserSafe;
  if (!allow(name)) {
    return res.status(403).json({
      error: name.startsWith('wallet_') || name.startsWith('submit_')
        ? `${name} needs you signed in: sign in with X at /auth/x/login and call it again, and it acts on your own wallet. Signed out, this endpoint only reads and prepares.`
        : `${name} is not exposed over HTTP at all; it spends this host's own gas.`,
    });
  }
  try {
    const out = unwrap(await runAs(actorFor(req), () => tool.handler(req.body || {})));
    if (out.isError) return res.status(400).json({ error: out.summary });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.shortMessage || e.message || 'connector call failed' });
  }
});

// ---------------------------------------------------------------------------
// The connector itself, hosted: POST /mcp speaks MCP over Streamable HTTP, so a host can
// add https://xgas.dev/mcp as a remote server instead of running node locally. Stateless —
// one server per request, no session to lose — and claim_exit stays off it, because that one
// spends this host's gas. Everything else here is reads, prepares, and relaying transactions
// the user has already signed.
// ---------------------------------------------------------------------------
const MCP_TOOL_COUNT = ALL_TOOLS.filter((t) => isHostable(t.name)).length;
// The agent's Privy wallet reaches the hosted connector only behind this token. No token set on the host
// means no wallet tools over HTTP at all, which is the safe default for a public URL.
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';
const hasOperatorToken = (req) => {
  if (!MCP_AUTH_TOKEN) return false;
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.headers['x-mcp-token'] || '');
  const a = Buffer.from(given), b = Buffer.from(MCP_AUTH_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/**
 * Who is calling, in the only two ways anyone can be:
 *   - a person signed in with X, who gets their own wallet and nobody else's;
 *   - the operator, holding the connector's token, which is for our own tooling, not for users.
 * Everyone else is anonymous and stays on reads and prepares.
 */
function actorFor(req) {
  const user = currentUser(req);
  if (user) return { kind: 'user', id: String(user.id), handle: user.handle, label: `@${user.handle}` };
  // A model is not a browser: it has no cookie. A connector token, minted by the person it belongs to
  // and carrying their X id, lets their agent act as them from anywhere without a shared secret.
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (bearer) {
    const claim = verify(bearer);
    if (claim && claim.k === 'connector' && claim.id && connectorClaimLive(claim)) {
      return { kind: 'user', id: String(claim.id), handle: claim.handle, label: `@${claim.handle}` };
    }
  }
  if (hasOperatorToken(req)) return OPERATOR;
  return null;
}

// A caller with a wallet of their own may use the wallet tools on it. claim_exit spends this host's gas,
// so it stays off every HTTP surface no matter who is asking.
const authed = (req) => !!actorFor(req);

app.all('/mcp', async (req, res) => {
  if (req.method === 'GET' || req.method === 'DELETE') {
    // No server-initiated stream and no session to end: say so in MCP's own shape.
    return res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'This endpoint is stateless: POST JSON-RPC to it.' }, id: null });
  }
  if (req.method !== 'POST') return res.status(405).end();
  const actor = actorFor(req);
  const { server } = createMcpServer({ allow: hostableFor(!!actor) });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  try {
    await server.connect(transport);
    await runAs(actor, () => transport.handleRequest(req, res, req.body));
  } catch (e) {
    console.error('[MCP]', e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: e.message || 'internal error' }, id: null });
  }
});

// What a person (or a host's "add server" screen) needs to wire it up, and what it can do.
app.get('/api/mcp', (_req, res) => {
  res.json({
    name: 'xgas-mcp',
    version: MCP_VERSION,
    transport: { http: `${PUBLIC_ORIGIN}/mcp`, stdio: 'npx -y xgas-mcp' },
    npm: 'https://www.npmjs.com/package/xgas-mcp',
    tool_count: MCP_TOOL_COUNT,
    // Counted from the registry at boot, so no page or README has to keep its own copy.
    tool_counts: {
      total: ALL_TOOLS.length,
      hosted_anonymous: MCP_TOOL_COUNT,
      hosted_signed_in: ALL_TOOLS.filter((t) => hostableFor(true)(t.name)).length,
      browser_anonymous: ALL_TOOLS.filter((t) => isBrowserSafe(t.name)).length,
    },
    // Not a plain boolean, because the true answer is not one.
    custodial: 'opt-in',
    custody: 'Non-custodial by default: every write tool returns an unsigned transaction for your own wallet to sign, '
      + 'and submit_* only relays what you already signed. The exception is opt-in: sign in with X and wallet_create makes '
      + 'you a Privy wallet that this server signs for with its PRIVY_APP_SECRET. That wallet is custodial. Keep in it only '
      + 'what you are willing to have an agent spend.',
    connector_tokens: { ttl_days: CONNECTOR_TTL_S / 86400, revoke: `POST ${PUBLIC_ORIGIN}/api/connector/revoke, signed in with X` },
    // The wallet tools exist, and the hosted endpoint serves them only to a caller with the token.
    wallet_tools: ALL_TOOLS.filter((t) => t.name.startsWith('wallet_')).map((t) => t.name),
    wallet_tools_over_http: 'sign in with X at /auth/x/login; each signed-in person gets their own Privy wallet',
    tools: ALL_TOOLS.filter((t) => isHostable(t.name)).map(({ name, description }) => ({
      name,
      description,
      kind: name.startsWith('prepare_') || ['post_ask', 'post_bid', 'take_ask', 'take_bid', 'release_trade', 'reclaim_timeout', 'cancel_order', 'launch_ngu_token', 'ramp_start'].includes(name)
        ? 'prepare'
        : name.startsWith('submit_') ? 'submit' : 'read',
    })),
  });
});

// ---------------------------------------------------------------------------
// Robinhood OTC desk (xgas.dev/robinhood): dollars on X Money (paid inside the X app, X account to X account,
// off-chain) <-> native ETH on Robinhood Chain #4663, both directions. The ETH leg is escrowed in RobinhoodEthOtc;
// a dispute goes to OtcArbitration (staked arbiters, commit-reveal). Neither contract has an admin. This host only
// reads them, pays a one-time gas drip and stores evidence files. It holds no role in either contract.
//   GET  /api/robinhood/otc             addresses, live parameters, the relayer, the drip.
//   POST /api/robinhood/gas/drip        { address }, signed in with X: a one-time drip of Robinhood ETH so a buyer
//                                       with no gas can take an order, mark it paid and claim. Sent by
//                                       DESK_RELAYER_KEY, a dedicated wallet that holds no role anywhere and only
//                                       ever pays for these drips. Never the owner or executor key.
//   POST /api/robinhood/evidence        signed in with X as one side of a trade that is in dispute: one png/jpeg/webp
//                                       (2 MB max) or plain text (20 KB max) for a tradeId. Returns the uri to pass
//                                       to OtcArbitration.submitEvidence. Capped per account, per trade, per day for
//                                       everyone together, and by a free-space floor on the volume.
//   GET  /api/robinhood/evidence/:file  a stored evidence file, read-only.
// Addresses come from l3.robinhoodOtc and l3.otcArbitration in l4-deployment.json; '' (or missing) = not deployed.
// ---------------------------------------------------------------------------
const ROBINHOOD_CHAIN_ID = 4663;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [L3_RPC] } },
});
// Off Fly only, ROBINHOOD_OTC_DEV / OTC_ARBITRATION_DEV may point at a local test deployment (anvil). On Fly the
// committed deployment file is the only source, so a stray env var can never aim the site at another contract.
function robinhoodAddress(key, devEnv) {
  const dev = process.env.FLY_APP_NAME ? '' : String(process.env[devEnv] || '').trim();
  const v = dev || DEPLOY.l3?.[key];
  return typeof v === 'string' && ADDRESS_RE.test(v) && isAddress(v) ? getAddress(v) : '';
}
const ROBINHOOD_OTC = robinhoodAddress('robinhoodOtc', 'ROBINHOOD_OTC_DEV');
const OTC_ARBITRATION = robinhoodAddress('otcArbitration', 'OTC_ARBITRATION_DEV');
const OTC_DEPLOYED = !!(ROBINHOOD_OTC && OTC_ARBITRATION);
const ROBINHOOD_WETH = getAddress(DEPLOY.l3?.weth || '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73');
const ROBINHOOD_FEE_FANOUT = getAddress(DEPLOY.l3?.fanout || '0x04C9229Fba6AFDC6ac9eD4312acb4BC74f1a436e');
const ROBINHOOD_PUBLIC_RPC = DEPLOY.parentRpcUrl || 'https://rpc.mainnet.chain.robinhood.com';
if (!OTC_DEPLOYED) console.log('[robinhood] OTC desk not deployed yet (l3.robinhoodOtc / l3.otcArbitration are empty)');

// The published interface, used until the contracts are deployed and whenever a read fails. Once deployed, the
// chain's own values win.
const OTC_SPEC = {
  payWindowS: 30 * 60,
  releaseWindowS: 12 * 3600,
  feeBps: 10,                                 // 0.10% of the ETH paid to a buyer, all of it to the Fee Fanout
  bondMinWei: 2_000_000_000_000_000n,         // 0.002 ETH
  bondBps: 500,                               // 5% of the trade; the bond is exactly max(0.002 ETH, 5%)
  minStakeWei: 10_000_000_000_000_000n,       // 0.01 ETH
  stakeAgeS: 3 * 24 * 3600,                   // a stake counts on a dispute only if it was this old when it opened
  commitS: 24 * 3600,
  revealS: 24 * 3600,
  longStopS: 14 * 24 * 3600,                  // no quorum by then: the ETH and the bond go back to the seller
  slashBps: 1000,
  unstakeDelayS: 7 * 24 * 3600,
};
// Server copies of the few views this host reads (the browser has the full ABIs in src/contracts/abis.ts).
// Every number is decoded as uint256, which reads any narrower uint the contract may return.
const OTC_VIEW_ABI = parseAbi([
  'struct Trade { uint256 orderId; address seller; address buyer; string sellerXHandle; string buyerXHandle; uint256 ethAmount; uint256 expectedCents; uint64 openedAt; uint64 paidAt; uint8 status; string paymentNote; }',
  'function PAY_WINDOW() view returns (uint256)',
  'function RELEASE_WINDOW() view returns (uint256)',
  'function FEE_BPS() view returns (uint256)',
  'function bondFor(uint256 ethAmount) view returns (uint256)',
  'function arbitration() view returns (address)',
  'function ordersLength() view returns (uint256)',
  'function tradesLength() view returns (uint256)',
  'function getTrade(uint256 tradeId) view returns (Trade)',
]);
const ARBITRATION_VIEW_ABI = parseAbi([
  'function MIN_STAKE() view returns (uint256)',
  'function STAKE_AGE() view returns (uint256)',
  'function COMMIT() view returns (uint256)',
  'function REVEAL() view returns (uint256)',
  'function LONG_STOP() view returns (uint256)',
  'function SLASH_BPS() view returns (uint256)',
  'function UNSTAKE_DELAY() view returns (uint256)',
  'function escrow() view returns (address)',
  'function openDisputeIds() view returns (uint256[])',
]);
const TRADE_STATUS = ['Open', 'Paid', 'Released', 'Claimed', 'CancelledUnpaid', 'Disputed', 'Resolved'];

// --- the relayer ------------------------------------------------------------
// The key is checked for shape before it goes anywhere near viem, and no error from loading it is printed, so a
// malformed key cannot end up in the logs.
function loadDeskRelayer() {
  const raw = String(process.env.DESK_RELAYER_KEY || '').trim();
  if (!raw) return null;
  const key = raw.startsWith('0x') || raw.startsWith('0X') ? `0x${raw.slice(2)}` : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    console.error('[robinhood] DESK_RELAYER_KEY is set but is not a 32-byte hex key; the gas drip stays off.');
    return null;
  }
  let account;
  try { account = privateKeyToAccount(key); } catch {
    console.error('[robinhood] DESK_RELAYER_KEY could not be loaded; the gas drip stays off.');
    return null;
  }
  // The drip wallet pays strangers. It must never be a key that holds a role.
  const privileged = [DEPLOY.owner, ...(DEPLOY.l3?.timelockProposers || [])].filter(Boolean).map((a) => String(a).toLowerCase());
  if (privileged.includes(account.address.toLowerCase())) {
    console.error(`[robinhood] DESK_RELAYER_KEY is ${account.address}, a privileged key; refusing to use it for the gas drip.`);
    return null;
  }
  // Sharing the Outbox executor's wallet would make drips and executor sends race for nonces.
  try {
    if (L3_EXECUTOR_KEY && privateKeyToAccount(L3_EXECUTOR_KEY).address === account.address) {
      console.warn('[robinhood] DESK_RELAYER_KEY is the same wallet as the Outbox executor; give the drip its own wallet.');
    }
  } catch {}
  return account;
}
const DESK_RELAYER = loadDeskRelayer();
const deskRelayerWallet = DESK_RELAYER
  ? createWalletClient({ account: DESK_RELAYER, chain: robinhoodChain, transport: viemHttp(L3_RPC, { timeout: 20_000 }) })
  : null;
if (DESK_RELAYER) {
  console.log(`[robinhood] gas drip relayer ${DESK_RELAYER.address}`);
  // Writes sign for chain 4663 (viem also asserts it per send). Say so at boot if the RPC is something else.
  l3Client.getChainId().then((id) => {
    if (id !== ROBINHOOD_CHAIN_ID) console.error(`[robinhood] ${L3_RPC} is chain ${id}, expected ${ROBINHOOD_CHAIN_ID}: every drip will be refused`);
  }).catch((e) => console.warn('[robinhood] chainId check failed:', e.shortMessage || e.message));
}

// --- drip sizing -------------------------------------------------------------
function envWei(name) {
  const v = String(process.env[name] || '').trim();
  if (!v) return null;
  if (!/^\d{1,30}$/.test(v)) { console.warn(`[robinhood] ${name} must be a whole number of wei; ignoring it.`); return null; }
  return BigInt(v);
}
const DRIP_FLOOR_WEI = 20_000_000_000_000n;                  // 0.00002 ETH
const DRIP_WEI_FIXED = envWei('DRIP_WEI');                   // set = exactly this, every time
const DRIP_MAX_WEI = (() => { const m = envWei('DRIP_MAX_WEI') ?? 200_000_000_000_000n; return m < DRIP_FLOOR_WEI ? DRIP_FLOOR_WEI : m; })(); // ceiling on the computed default (0.0002 ETH)
const DRIP_DAILY_CAP = (() => { const n = Number(process.env.DRIP_DAILY_CAP ?? 50); return Number.isInteger(n) && n >= 0 ? n : 50; })();
const DRIP_PER_IP_DAILY = 3;
const DRIP_OWNER_MAX_WEI = 10_000_000_000_000n;              // a wallet below 0.00001 ETH cannot really transact
const OTC_TX_GAS = 300_000n;                                 // generous for takeSell / markPaid / claim / submitEvidence
const DRIP_SEND_GAS_RESERVE = 300_000n;                      // what the relayer keeps back to pay for the send itself

let rhGasPrice = { wei: 0n, at: 0 };
async function robinhoodGasPrice() {
  if (rhGasPrice.wei > 0n && Date.now() - rhGasPrice.at < 60_000) return rhGasPrice.wei;
  const wei = await l3Client.getGasPrice();
  rhGasPrice = { wei, at: Date.now() };
  return wei;
}
/** DRIP_WEI if set; else 4 desk transactions at the current gas price, times 3, never below 0.00002 ETH. */
async function dripAmountWei() {
  if (DRIP_WEI_FIXED != null) return DRIP_WEI_FIXED;
  let gp = 0n;
  try { gp = await robinhoodGasPrice(); } catch {}
  let amt = gp * OTC_TX_GAS * 4n * 3n;
  if (amt < DRIP_FLOOR_WEI) amt = DRIP_FLOOR_WEI;
  if (amt > DRIP_MAX_WEI) amt = DRIP_MAX_WEI;
  return amt;
}

// --- atomic JSON files -------------------------------------------------------
// Temp file with a unique name, fsync, rename over the target, fsync the directory: a crash leaves either the old
// file or the new one, never half of either.
function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeSync(fd, JSON.stringify(obj)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  try { const d = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch {}
}
/** A promise queue: fn runs only after every earlier fn on the same queue has settled. */
function makeLock() {
  let q = Promise.resolve();
  return (fn) => { const run = q.then(fn, fn); q = run.then(() => {}, () => {}); return run; };
}

// --- the drip ledger (/data/robinhood-drips.json) -----------------------------
// drips: one entry per address ever dripped. accounts: X account id -> the address it was dripped to. Written only
// from inside withDripLock, and the slot is on disk before any ETH moves, so two requests can never both pass the
// checks and a crash after the send can never allow a second drip. A ledger that exists but will not parse turns
// the drip off instead of starting over, because starting over would hand everyone a second drip.
const DRIP_LEDGER_FILE = path.join(DATA_DIR, 'robinhood-drips.json');
let dripLedger = { version: 2, drips: {}, accounts: {} };
let dripLedgerBroken = false;
try {
  if (fs.existsSync(DRIP_LEDGER_FILE)) {
    const j = JSON.parse(fs.readFileSync(DRIP_LEDGER_FILE, 'utf8'));
    if (!j || typeof j !== 'object' || !j.drips || typeof j.drips !== 'object') throw new Error('missing drips map');
    const accounts = j.accounts && typeof j.accounts === 'object' ? j.accounts : {};
    for (const [addr, d] of Object.entries(j.drips)) if (d && d.xId && !accounts[d.xId]) accounts[d.xId] = addr;
    dripLedger = { version: 2, drips: j.drips, accounts };
  }
} catch (e) {
  dripLedgerBroken = true;
  console.error(`[robinhood] ${DRIP_LEDGER_FILE} is unreadable; the gas drip stays off until it is fixed:`, e.message);
}
function saveDripLedger(next) {
  writeJsonAtomic(DRIP_LEDGER_FILE, next);
  dripLedger = next;
}
/** Run fn with nobody else touching the ledger or the relayer's nonce. */
const withDripLock = makeLock();
const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
function dripCounts(ipKey) {
  const today = utcDay();
  let total = 0, ip = 0;
  for (const d of Object.values(dripLedger.drips)) {
    if (d.day !== today) continue;
    total++;
    if (ipKey && d.ip === ipKey) ip++;
  }
  return { total, ip };
}
function dripFor({ address, xId }) {
  if (address && dripLedger.drips[address.toLowerCase()]) return { by: 'address', entry: dripLedger.drips[address.toLowerCase()] };
  if (xId && dripLedger.accounts[String(xId)]) {
    const addr = dripLedger.accounts[String(xId)];
    return { by: 'account', address: addr, entry: dripLedger.drips[addr] || null };
  }
  return null;
}
// --- settling a drip ----------------------------------------------------------
// Every drip is signed before it is sent, and its hash, nonce and signed bytes go into the ledger first. A slot is
// freed only when the transaction provably cannot land: the node rejected it and does not have it, it reverted, or
// its nonce was used by another transaction. Anything unclear keeps the slot and is settled here.
/** true: the node has the transaction (pending or mined). false: it says it does not. null: could not tell. */
async function nodeHasTx(hash) {
  try { await l3Client.getTransaction({ hash }); return true; } catch (e) {
    if (e instanceof TransactionNotFoundError || e?.name === 'TransactionNotFoundError') return false;
    return null;
  }
}
/** A JSON-RPC answer that refused the transaction, as opposed to a timeout or a lost connection. */
function isRpcRejection(e) {
  if (!e || typeof e.walk !== 'function') return false;
  const rpc = e.walk((x) => x instanceof RpcError);
  if (!rpc || rpc.code === -32603) return false; // "internal error" from a proxy says nothing about the node
  return !/already known|known transaction|already imported/i.test(`${e.shortMessage || ''} ${e.details || ''} ${e.message || ''}`);
}
/** Call inside withDripLock. */
function setDripStatus(key, txHash, status) {
  const cur = dripLedger.drips[key];
  if (!cur || cur.txHash !== txHash) return;
  const next = { ...cur, status };
  if (status === 'confirmed') delete next.raw; // the signed bytes are only kept while a rebroadcast may be needed
  saveDripLedger({ ...dripLedger, drips: { ...dripLedger.drips, [key]: next } });
}
/** Give back both slots (the address and the X account). Call inside withDripLock. */
function freeDripSlot(key, txHash, why) {
  const cur = dripLedger.drips[key];
  if (!cur || cur.txHash !== txHash) return;
  const { [key]: _gone, ...drips } = dripLedger.drips;
  const accounts = { ...dripLedger.accounts };
  if (cur.xId && accounts[cur.xId] === key) delete accounts[cur.xId];
  saveDripLedger({ ...dripLedger, drips, accounts });
  console.warn(`[robinhood] drip slot for ${key} (@${cur.handle}) freed: ${why}`);
}
const DRIP_FOLLOW_TRIES = 12; // every 10 minutes after the first 3-minute wait: about 2 hours in all
async function followDrip(key, txHash, nonce, attempt = 0) {
  if (!DESK_RELAYER || !deskRelayerWallet || !txHash) return;
  let rc = null;
  try {
    rc = await l3Client.waitForTransactionReceipt({ hash: txHash, timeout: attempt === 0 ? 180_000 : 20_000 });
  } catch {
    rc = await l3Client.getTransactionReceipt({ hash: txHash }).catch(() => null);
  }
  if (rc) {
    return withDripLock(() => {
      try {
        if (rc.status === 'success') setDripStatus(key, txHash, 'confirmed');
        else freeDripSlot(key, txHash, `${txHash} reverted`);
      } catch (e) { console.error('[robinhood] could not update the drip ledger:', e.message); }
    });
  }
  const done = await withDripLock(async () => {
    const cur = dripLedger.drips[key];
    if (!cur || cur.txHash !== txHash) return true;
    const [latest, seen] = await Promise.all([
      l3Client.getTransactionCount({ address: DESK_RELAYER.address, blockTag: 'latest' }).catch(() => null),
      nodeHasTx(txHash),
    ]);
    if (Number.isInteger(nonce) && latest != null && latest > nonce && seen === false) {
      try { freeDripSlot(key, txHash, `${txHash} can never land: nonce ${nonce} was used by another transaction`); } catch (e) { console.error('[robinhood] could not free a drip slot:', e.message); }
      return true;
    }
    if (seen === false && cur.raw) {
      // The node does not have it and its nonce is still free: send the same signed bytes again (same hash).
      try {
        await deskRelayerWallet.sendRawTransaction({ serializedTransaction: cur.raw });
        console.log(`[robinhood] rebroadcast drip ${txHash}`);
        return 'rebroadcast';
      } catch (e) {
        console.warn(`[robinhood] rebroadcast of drip ${txHash} failed:`, e.shortMessage || e.message);
      }
    }
    return false;
  });
  if (done === true) return;
  // Right after a rebroadcast, look again soon; otherwise every 10 minutes.
  if (attempt + 1 < DRIP_FOLLOW_TRIES) setTimeout(() => { followDrip(key, txHash, nonce, attempt + 1); }, done === 'rebroadcast' ? 15_000 : 10 * 60_000).unref?.();
  else console.warn(`[robinhood] drip ${txHash} still unsettled after ${DRIP_FOLLOW_TRIES} checks; its slot stays taken`);
}
// Anything left unsettled by a restart or a crash is picked up again at boot.
if (DESK_RELAYER && !dripLedgerBroken) {
  for (const [key, d] of Object.entries(dripLedger.drips)) {
    if (d && d.txHash && d.status !== 'confirmed') followDrip(key, d.txHash, d.nonce).catch((e) => console.warn('[robinhood] followDrip:', e.message));
  }
}

// Fly's edge sets Fly-Client-IP and overwrites anything a client sends under that name. X-Forwarded-For is
// appendable by the client, so it is never read here. Off Fly the header means nothing, so the socket decides.
function clientIp(req) {
  if (process.env.FLY_APP_NAME) {
    const fly = String(req.get('fly-client-ip') || '').trim();
    if (fly) return fly;
  }
  return req.socket?.remoteAddress || 'unknown';
}
/**
 * The unit a per-IP limit counts. IPv4: the address. IPv6: its /64, because one line or VPS usually gets a whole
 * /64 and can use a fresh address for every request. An IPv4-mapped IPv6 address (::ffff:1.2.3.4) counts as IPv4.
 */
function ipLimitKey(ip) {
  let s = String(ip || '').trim().replace(/^\[|\]$/g, '');
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  if (mapped) s = mapped[1];
  if (net.isIPv4(s)) return s;
  if (!net.isIPv6(s)) return s || 'unknown';
  const toGroups = (part) => (part ? part.split(':') : []).flatMap((g) => {
    if (!g.includes('.')) return [g];
    const b = g.split('.').map(Number); // an embedded IPv4 tail is two groups
    return [((b[0] << 8) | b[1]).toString(16), ((b[2] << 8) | b[3]).toString(16)];
  });
  const dbl = s.indexOf('::');
  const head = toGroups(dbl >= 0 ? s.slice(0, dbl) : s);
  const tail = dbl >= 0 ? toGroups(s.slice(dbl + 2)) : [];
  const groups = dbl >= 0 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  return `${groups.slice(0, 4).map((g) => parseInt(g || '0', 16).toString(16)).join(':')}::/64`;
}
// The ledger keeps a keyed hash of the IP (or the IPv6 /64), not the IP.
const dripIpKey = (ip) => crypto.createHmac('sha256', SESSION_SECRET).update(`robinhood-drip:${ipLimitKey(ip)}`).digest('hex').slice(0, 32);
const SIGN_IN_HINT = 'Sign in with X first (/auth/x/login?returnTo=/robinhood).';

// --- GET /api/robinhood/otc ----------------------------------------------------
let otcImmutables = null; // constants read once from the deployed contracts
async function readOtcImmutables() {
  if (!OTC_DEPLOYED) return null;
  if (otcImmutables) return otcImmutables;
  const o = (functionName, args) => l3Client.readContract({ address: ROBINHOOD_OTC, abi: OTC_VIEW_ABI, functionName, args }).catch(() => null);
  const a = (functionName) => l3Client.readContract({ address: OTC_ARBITRATION, abi: ARBITRATION_VIEW_ABI, functionName }).catch(() => null);
  const BIG = 1_000_000_000_000_000_000_000n; // 1000 ETH: the percentage decides; bondFor(1 wei) is the floor
  const [payWindow, releaseWindow, feeBps, bondMin, bondBig, otcArb, minStake, stakeAge, commit, reveal, longStop, slashBps, unstakeDelay, arbEscrow] = await Promise.all([
    o('PAY_WINDOW'), o('RELEASE_WINDOW'), o('FEE_BPS'), o('bondFor', [1n]), o('bondFor', [BIG]), o('arbitration'),
    a('MIN_STAKE'), a('STAKE_AGE'), a('COMMIT'), a('REVEAL'), a('LONG_STOP'), a('SLASH_BPS'), a('UNSTAKE_DELAY'), a('escrow'),
  ]);
  const got = { payWindow, releaseWindow, feeBps, bondMin, bondBig, otcArb, minStake, stakeAge, commit, reveal, longStop, slashBps, unstakeDelay, arbEscrow };
  const values = {
    payWindowS: payWindow != null ? Number(payWindow) : OTC_SPEC.payWindowS,
    releaseWindowS: releaseWindow != null ? Number(releaseWindow) : OTC_SPEC.releaseWindowS,
    feeBps: feeBps != null ? Number(feeBps) : OTC_SPEC.feeBps,
    bondMinWei: bondMin != null ? bondMin : OTC_SPEC.bondMinWei,
    bondBps: bondBig != null ? Number((bondBig * 10_000n) / BIG) : OTC_SPEC.bondBps,
    minStakeWei: minStake != null ? minStake : OTC_SPEC.minStakeWei,
    stakeAgeS: stakeAge != null ? Number(stakeAge) : OTC_SPEC.stakeAgeS,
    commitS: commit != null ? Number(commit) : OTC_SPEC.commitS,
    revealS: reveal != null ? Number(reveal) : OTC_SPEC.revealS,
    longStopS: longStop != null ? Number(longStop) : OTC_SPEC.longStopS,
    slashBps: slashBps != null ? Number(slashBps) : OTC_SPEC.slashBps,
    unstakeDelayS: unstakeDelay != null ? Number(unstakeDelay) : OTC_SPEC.unstakeDelayS,
  };
  const complete = Object.values(got).every((v) => v != null);
  const wired = otcArb != null && arbEscrow != null
    ? getAddress(otcArb) === OTC_ARBITRATION && getAddress(arbEscrow) === ROBINHOOD_OTC
    : null;
  if (wired === false) console.error(`[robinhood] OTC wiring mismatch: escrow.arbitration()=${otcArb}, arbitration.escrow()=${arbEscrow}; disputes will fail until bind(escrow) is called`);
  const out = { values, source: complete ? 'chain' : 'partial', wired };
  if (complete && wired === true) otcImmutables = out; // cache only what the chain fully confirmed (bind is one-time)
  return out;
}
function otcParams(values, source) {
  const v = values || OTC_SPEC;
  return {
    source: source || 'spec',
    payWindowS: v.payWindowS,
    releaseWindowS: v.releaseWindowS,
    feeBps: v.feeBps,
    fee: `${(v.feeBps / 100).toFixed(2)}% of the ETH paid to the buyer, all of it as WETH to the Fee Fanout. The seller pays no fee.`,
    bond: {
      minWei: v.bondMinWei.toString(),
      bps: v.bondBps,
      rule: `A seller who disputes posts a bond of exactly ${formatEther(v.bondMinWei)} ETH or ${v.bondBps / 100}% of the trade, whichever is larger (no more, no less). It is the only thing arbiters are paid from (with the slashed stakes of losing or silent voters): all of it goes to the majority if they find the buyer paid; half goes to the majority and half back to the seller if they find the buyer did not pay. After the long-stop (no decision) all of it goes back to the seller.`,
    },
    arbitration: {
      minStakeWei: v.minStakeWei.toString(),
      stakeAgeS: v.stakeAgeS,
      weight: 'The whole stake, no cap. It counts on a dispute only if it was last increased at least stakeAgeS before the dispute opened.',
      commitS: v.commitS,
      revealS: v.revealS,
      extensions: 'Repeated: a tie or no quorum adds another commit and reveal round, until quorum or the long-stop.',
      longStopS: v.longStopS,
      longStop: 'No decision by longStopS after the dispute opened: the ETH goes back to the seller, the bond goes back to the seller, and the buyer is not flagged.',
      quorumRevealers: 3,
      slashBps: v.slashBps,
      unstakeDelayS: v.unstakeDelayS,
    },
    limits: {
      openTradesPerBuyer: 1,
      flaggedBuyersCanTake: false,
      unpaidTake: 'After the pay window anyone can cancel an unpaid trade. On a sell order the ETH goes back onto the order, which stays open unless the maker cancelled it.',
    },
  };
}

let otcInfoCache = { at: 0, body: null };
async function otcInfoBody() {
  if (otcInfoCache.body && Date.now() - otcInfoCache.at < 10_000) return otcInfoCache.body;
  const o = (functionName) => l3Client.readContract({ address: ROBINHOOD_OTC, abi: OTC_VIEW_ABI, functionName }).catch(() => null);
  const a = (functionName) => l3Client.readContract({ address: OTC_ARBITRATION, abi: ARBITRATION_VIEW_ABI, functionName }).catch(() => null);
  const [imm, relayerBal, amountWei, gasPrice, ordersLength, tradesLength, openDisputeIds] = await Promise.all([
    readOtcImmutables().catch(() => null),
    DESK_RELAYER ? l3Client.getBalance({ address: DESK_RELAYER.address }).catch(() => null) : null,
    dripAmountWei(),
    robinhoodGasPrice().catch(() => 0n),
    OTC_DEPLOYED ? o('ordersLength') : null,
    OTC_DEPLOYED ? o('tradesLength') : null,
    OTC_DEPLOYED ? a('openDisputeIds') : null,
  ]);
  const remainingToday = Math.max(0, DRIP_DAILY_CAP - dripCounts(null).total);
  const funded = relayerBal != null && relayerBal >= amountWei + gasPrice * DRIP_SEND_GAS_RESERVE;
  const reason = !OTC_DEPLOYED ? 'The desk is not deployed yet.'
    : !DESK_RELAYER ? 'The gas drip is not set up on this host.'
    : dripLedgerBroken ? 'The gas drip is paused while its ledger is repaired.'
    : remainingToday === 0 ? `Today's ${DRIP_DAILY_CAP} drips are used up. It resets at 00:00 UTC.`
    : relayerBal == null ? 'Could not read the relayer balance on Robinhood Chain.'
    : !funded ? 'The relayer is out of ETH for now.'
    : null;
  const body = {
    chainId: ROBINHOOD_CHAIN_ID,
    otc: ROBINHOOD_OTC,
    arbitration: OTC_ARBITRATION,
    deployed: OTC_DEPLOYED,
    status: OTC_DEPLOYED ? 'live' : 'not deployed yet',
    rpcUrl: ROBINHOOD_PUBLIC_RPC,
    weth: ROBINHOOD_WETH,
    feeFanout: ROBINHOOD_FEE_FANOUT,
    params: otcParams(imm?.values, imm?.source),
    state: OTC_DEPLOYED ? {
      wired: imm ? imm.wired : null,
      ordersLength: ordersLength != null ? Number(ordersLength) : null,
      tradesLength: tradesLength != null ? Number(tradesLength) : null,
      openDisputes: Array.isArray(openDisputeIds) ? openDisputeIds.map((x) => x.toString()) : null,
    } : null,
    relayer: {
      configured: !!DESK_RELAYER,
      address: DESK_RELAYER ? DESK_RELAYER.address : null,
      ethBalance: relayerBal != null ? formatEther(relayerBal) : null,
    },
    drip: {
      available: reason === null,
      amountWei: amountWei.toString(),
      amountEth: formatEther(amountWei),
      remainingToday,
      dailyCap: DRIP_DAILY_CAP,
      perIpPerDay: DRIP_PER_IP_DAILY,
      requiresSignIn: true,
      eligibility: 'Once per X account and once per address, ever, for a wallet with under 0.00001 ETH on Robinhood Chain. Free: it covers gas for about 4 desk transactions.',
      reason,
    },
    evidence: {
      upload: 'POST /api/robinhood/evidence',
      types: ['image/png', 'image/jpeg', 'image/webp', 'text/plain'],
      maxImageBytes: EVIDENCE_MAX_IMAGE_BYTES,
      maxTextBytes: EVIDENCE_MAX_TEXT_BYTES,
      onlyForDisputedTrades: true,
      perTradePerAccount: EVIDENCE_PER_TRADE_PER_ACCOUNT,
      perAccountPerDay: EVIDENCE_PER_ACCOUNT_DAILY,
      allAccountsBytesPerDay: EVIDENCE_DAILY_BYTES,
      note: 'Only for a trade in dispute, and only by its buyer or seller (the X account whose handle is on the trade). Files are public to anyone with the link, so arbiters can read them. Do not upload anything you would not show a stranger.',
    },
  };
  otcInfoCache = { at: Date.now(), body };
  return body;
}

// Fair ETH/USD for prefilling desk prices: the median of three public spot tickers, cached 20 s.
// It is a reference only; the desk trades at whatever price the maker posts.
let ethPriceCache = { at: 0, body: null };
async function fetchJson(url, ms = 4000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'xgas.dev' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}
const ETH_PRICE_SOURCES = [
  ['Coinbase', 'https://api.coinbase.com/v2/prices/ETH-USD/spot', j => Number(j?.data?.amount)],
  ['Kraken', 'https://api.kraken.com/0/public/Ticker?pair=ETHUSD', j => Number(Object.values(j?.result || {})[0]?.c?.[0])],
  ['Bitstamp', 'https://www.bitstamp.net/api/v2/ticker/ethusd/', j => Number(j?.last)],
];
// The fair price itself, shared by the endpoint and the link-preview cards (server/og). null when no source answered.
let ethPriceInflight = null;
async function ethFairPrice() {
  if (ethPriceCache.body && Date.now() - ethPriceCache.at < 20_000) return ethPriceCache.body;
  if (ethPriceInflight) return ethPriceInflight;
  ethPriceInflight = (async () => {
    const got = await Promise.all(ETH_PRICE_SOURCES.map(async ([name, url, pick]) => {
      try { const v = pick(await fetchJson(url)); return Number.isFinite(v) && v > 0 ? { name, usd: v } : null; } catch { return null; }
    }));
    const ok = got.filter(Boolean).sort((a, b) => a.usd - b.usd);
    if (!ok.length) return null;
    const mid = ok.length % 2 ? ok[(ok.length - 1) / 2].usd : (ok[ok.length / 2 - 1].usd + ok[ok.length / 2].usd) / 2;
    const cents = Math.round(mid * 100);
    const body = { usd: (cents / 100).toFixed(2), cents: String(cents), sources: ok.map(o => ({ name: o.name, usd: o.usd.toFixed(2) })), method: `median of ${ok.map(o => o.name).join(', ')}`, at: new Date().toISOString() };
    ethPriceCache = { at: Date.now(), body };
    return body;
  })().finally(() => { ethPriceInflight = null; });
  return ethPriceInflight;
}
app.get('/api/robinhood/eth-price', async (_req, res) => {
  res.set('Cache-Control', 'public, max-age=15');
  const body = await ethFairPrice().catch(() => null);
  if (!body) return res.status(503).json({ error: 'No price source answered. Enter your own price.' });
  res.json(body);
});

// Live desk updates: one chain watcher on the server, fanned out to browsers over Server-Sent Events, so pages
// refresh within a couple of seconds of any escrow or arbitration event instead of polling the RPC themselves.
const otcSubscribers = new Set();
const OTC_MAX_SUBSCRIBERS = 1000;
let otcLastBlock = null;
function otcBroadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of otcSubscribers) { try { res.write(msg); } catch { otcSubscribers.delete(res); } }
}
let otcWatchBusy = false;
async function otcWatchTick() {
  if (!OTC_DEPLOYED || otcWatchBusy) return;
  if (!otcSubscribers.size) { otcLastBlock = null; return; }
  otcWatchBusy = true;
  try {
    const head = await l3Client.getBlockNumber();
    if (otcLastBlock == null || head < otcLastBlock) { otcLastBlock = head; return; }
    if (head === otcLastBlock) return;
    const from = otcLastBlock + 1n;
    const to = head - from > 2000n ? from + 2000n : head;
    const logs = await l3Client.getLogs({ address: [ROBINHOOD_OTC, OTC_ARBITRATION], fromBlock: from, toBlock: to });
    otcLastBlock = to;
    if (logs.length) otcBroadcast('change', { block: Number(to), events: logs.length, txs: [...new Set(logs.map(l => l.transactionHash))].slice(0, 20) });
  } catch { /* transient RPC error: retry next tick from the same block */ } finally { otcWatchBusy = false; }
}
setInterval(() => { otcWatchTick(); }, 1500);
app.get('/api/robinhood/stream', (req, res) => {
  if (!OTC_DEPLOYED) return res.status(503).json({ error: 'The OTC desk is not deployed yet.' });
  if (otcSubscribers.size >= OTC_MAX_SUBSCRIBERS) return res.status(503).json({ error: 'Too many live connections; the page falls back to polling.' });
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ otc: ROBINHOOD_OTC, arbitration: OTC_ARBITRATION })}\n\n`);
  otcSubscribers.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 20_000);
  req.on('close', () => { clearInterval(ping); otcSubscribers.delete(res); });
});

app.get('/api/robinhood/otc', async (req, res) => {
  try {
    const body = await otcInfoBody();
    // Per-viewer, so never cached with the rest.
    const user = currentUser(req);
    const mine = user ? dripFor({ xId: user.id }) : null;
    res.set('Cache-Control', 'no-store');
    res.json({
      ...body,
      you: {
        signedIn: !!user,
        handle: user ? user.handle : null,
        drip: mine ? { address: mine.address || null, txHash: mine.entry?.txHash || null, status: mine.entry?.status || null } : null,
      },
    });
  } catch (e) {
    res.status(502).json({ error: `Could not read Robinhood Chain: ${e.shortMessage || e.message}` });
  }
});

// --- POST /api/robinhood/gas/drip ----------------------------------------------
app.post('/api/robinhood/gas/drip', async (req, res) => {
  const user = currentUser(req);
  if (!user || !user.id) return res.status(401).json({ error: `The gas drip needs your X account. ${SIGN_IN_HINT}` });
  const xId = String(user.id);
  const raw = req.body && typeof req.body.address === 'string' ? req.body.address.trim() : '';
  if (!ADDRESS_RE.test(raw) || !isAddress(raw)) {
    return res.status(400).json({ error: 'Send {"address":"0x..."} with a valid address (40 hex characters; a mixed-case address must have a correct checksum).' });
  }
  const address = getAddress(raw);
  const key = address.toLowerCase();
  if (!OTC_DEPLOYED) return res.status(503).json({ error: 'The Robinhood OTC desk is not deployed yet, so there is nothing to drip gas for.' });
  if (!DESK_RELAYER || !deskRelayerWallet) {
    return res.status(503).json({ error: 'The gas drip is not set up on this host (no relayer key configured). You need a little ETH on Robinhood Chain from somewhere else to trade.' });
  }
  if (dripLedgerBroken) return res.status(503).json({ error: 'The gas drip is paused while its ledger is repaired. Try again later.' });
  const already = () => {
    const d = dripFor({ address: key, xId });
    if (!d) return null;
    return {
      status: 409,
      body: d.by === 'address'
        ? { error: 'This address already got its one drip.', txHash: d.entry?.txHash || null }
        : { error: `@${user.handle} already got its one drip (to ${d.address ? getAddress(d.address) : 'another address'}).`, txHash: d.entry?.txHash || null },
    };
  };
  const first = already();
  if (first) return res.status(first.status).json(first.body);

  const ipKey = dripIpKey(clientIp(req));
  try {
    // Reads first (no lock needed), then every ledger check again under the lock right before sending.
    const [ethBal, code] = await Promise.all([l3Client.getBalance({ address }), l3Client.getCode({ address })]);
    // A contract cannot use a drip to sign anything. EIP-7702 wallets (code 0xef0100...) can.
    if (code && code !== '0x' && !code.toLowerCase().startsWith('0xef0100')) {
      return res.status(400).json({ error: 'That address is a contract. The drip is for wallets.' });
    }
    if (ethBal >= DRIP_OWNER_MAX_WEI) {
      return res.status(409).json({ error: `This wallet already has ${formatEther(ethBal)} ETH on Robinhood Chain, enough for gas. The drip is for wallets under 0.00001 ETH.` });
    }

    const out = await withDripLock(async () => {
      const again = already();
      if (again) return again;
      const counts = dripCounts(ipKey);
      if (counts.total >= DRIP_DAILY_CAP) return { status: 429, body: { error: `Today's ${DRIP_DAILY_CAP} drips are used up. It resets at 00:00 UTC.` } };
      if (counts.ip >= DRIP_PER_IP_DAILY) return { status: 429, body: { error: `This connection already used its ${DRIP_PER_IP_DAILY} drips today. It resets at 00:00 UTC.` } };

      const [amountWei, gasPrice, relayerBal] = await Promise.all([
        dripAmountWei(),
        robinhoodGasPrice(),
        l3Client.getBalance({ address: DESK_RELAYER.address }),
      ]);
      if (relayerBal < amountWei + gasPrice * DRIP_SEND_GAS_RESERVE) {
        return { status: 503, body: { error: 'The relayer is out of ETH for now. Try again later.' } };
      }

      // Sign first, so the hash is known before anything leaves this host. The slot goes on disk with that hash
      // before the send: a crash after the send can never allow a second drip, and a send that fails in an unclear
      // way (a timeout, a lost response) keeps the slot under a hash that followDrip can settle later.
      let serialized, txHash, nonce;
      try {
        const request = await deskRelayerWallet.prepareTransactionRequest({ account: DESK_RELAYER, chain: robinhoodChain, to: address, value: amountWei });
        nonce = Number(request.nonce);
        serialized = await deskRelayerWallet.signTransaction(request);
        txHash = keccak256(serialized);
      } catch (e) {
        console.warn(`[robinhood] drip to ${address} could not be prepared:`, e.shortMessage || e.message);
        return { status: 502, body: { error: `The drip could not be prepared: ${e.shortMessage || 'Robinhood Chain RPC error'}. Nothing was sent; try again.` } };
      }
      const now = Date.now();
      const entry = { xId, handle: user.handle, amountWei: amountWei.toString(), ip: ipKey, at: now, day: utcDay(now), status: 'sending', txHash, nonce, raw: serialized };
      const before = dripLedger;
      try {
        saveDripLedger({ ...dripLedger, drips: { ...dripLedger.drips, [key]: entry }, accounts: { ...dripLedger.accounts, [xId]: key } });
      } catch (e) {
        console.error('[robinhood] could not write the drip ledger:', e.message);
        return { status: 500, body: { error: 'Could not record the drip, so nothing was sent. Try again.' } };
      }

      let sendErr = null;
      try {
        await deskRelayerWallet.sendRawTransaction({ serializedTransaction: serialized });
      } catch (e) {
        sendErr = e;
      }
      if (sendErr) {
        const seen = await nodeHasTx(txHash);
        if (seen === false && isRpcRejection(sendErr)) {
          // The node answered with a rejection and does not have the transaction: nothing can land. Free both slots.
          try { saveDripLedger(before); } catch (w) { console.error('[robinhood] could not release a failed drip slot:', w.message); }
          const why = String(sendErr.details || sendErr.shortMessage || 'RPC error').split('\n')[0].slice(0, 200);
          console.warn(`[robinhood] drip to ${address} was rejected:`, why);
          return { status: 502, body: { error: `Robinhood Chain rejected the drip (${why}). Nothing was spent; try again later.` } };
        }
        if (seen !== true) {
          // Unclear: the node may have taken it. Keep the slot; followDrip rebroadcasts or settles it.
          try { setDripStatus(key, txHash, 'unknown'); } catch (w) { console.error('[robinhood] could not mark a drip unknown:', w.message); }
          console.warn(`[robinhood] drip ${txHash} to ${address}: send outcome unclear:`, sendErr.shortMessage || sendErr.message);
          return {
            status: 202,
            body: {
              txHash, amountWei: amountWei.toString(), amountEth: formatEther(amountWei), to: address, uncertain: true,
              message: 'The drip was signed and handed to Robinhood Chain, but the node did not confirm it took it. Do not ask again: this host keeps retrying the same transaction, and it lands at this hash or not at all.',
            },
            txHash, nonce,
          };
        }
      }
      try {
        setDripStatus(key, txHash, 'sent');
      } catch (e) {
        // The reservation (with the hash) is already on disk, so neither the address nor the X account can be dripped twice.
        console.error('[robinhood] could not save a drip status:', e.message);
      }
      return { status: 200, body: { txHash, amountWei: amountWei.toString(), amountEth: formatEther(amountWei), to: address }, txHash, nonce };
    });

    otcInfoCache = { at: 0, body: null };
    if (out.status !== 200 && out.status !== 202) return res.status(out.status).json(out.body);
    console.log(`[robinhood] drip of ${formatEther(BigInt(out.body.amountWei))} ETH to ${address} for @${user.handle}: ${out.txHash}${out.status === 202 ? ' (outcome unclear)' : ''}`);
    res.status(out.status).json(out.body);

    // Settle in the background: confirmed, reverted (slot freed), or never able to land (slot freed).
    followDrip(key, out.txHash, out.nonce).catch((e) => console.warn('[robinhood] followDrip:', e.message));
  } catch (e) {
    console.error('[robinhood/gas/drip]', e.shortMessage || e.message);
    if (!res.headersSent) res.status(502).json({ error: `Could not read Robinhood Chain: ${e.shortMessage || e.message}` });
  }
});

// --- evidence: POST /api/robinhood/evidence, GET /api/robinhood/evidence/:file -----
// Accepted shapes (the bodies are parsed near the top of this file, before the general JSON parser):
//   multipart/form-data   fields tradeId and file (one png/jpeg/webp) or text
//   application/json      { tradeId, text } or { tradeId, image: "<base64 or data:image/...;base64,...>" }
//   raw body              Content-Type image/png | image/jpeg | image/webp | application/octet-stream | text/plain,
//                         with ?tradeId=N (or an X-Trade-Id header)
// The file type is decided by its magic bytes, never by what the client claims. Names are random, so a stored file
// can only be found through the uri this returns (which the uploader then puts on chain).
const EVIDENCE_DIR = path.join(DATA_DIR, 'robinhood-evidence');
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
const EVIDENCE_INDEX_FILE = path.join(EVIDENCE_DIR, 'index.json');
const EVIDENCE_PER_TRADE_PER_ACCOUNT = 10;
const EVIDENCE_PER_ACCOUNT_DAILY = 30;
// Everyone together, per UTC day, and a floor of free space that uploads never eat into, so evidence can never
// fill /data (the drip ledger, the session key and the withdrawal records live there too).
const EVIDENCE_DAILY_BYTES = (() => { const n = Number(process.env.EVIDENCE_DAILY_BYTES ?? 100 * 1024 * 1024); return Number.isSafeInteger(n) && n >= 0 ? n : 100 * 1024 * 1024; })();
const EVIDENCE_MIN_FREE_BYTES = 256 * 1024 * 1024; // or 10% of the volume, whichever is larger
const TRADE_STATUS_DISPUTED = 5;
/** Bytes still free for evidence on the volume, after the floor; null when the filesystem will not say. */
function evidenceRoomBytes() {
  try {
    const st = fs.statfsSync(EVIDENCE_DIR);
    const total = Number(st.blocks) * Number(st.bsize);
    const free = Number(st.bavail) * Number(st.bsize);
    return free - Math.max(EVIDENCE_MIN_FREE_BYTES, Math.floor(total * 0.1));
  } catch {
    return null;
  }
}
const EVIDENCE_FILE_RE = /^[0-9a-f]{32}\.(png|jpg|webp|txt)$/;
const EVIDENCE_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', txt: 'text/plain; charset=utf-8' };
let evidenceIndex = { version: 1, files: {} };
let evidenceIndexBroken = false;
try {
  if (fs.existsSync(EVIDENCE_INDEX_FILE)) {
    const j = JSON.parse(fs.readFileSync(EVIDENCE_INDEX_FILE, 'utf8'));
    if (!j || typeof j !== 'object' || !j.files || typeof j.files !== 'object') throw new Error('missing files map');
    evidenceIndex = j;
  }
} catch (e) {
  evidenceIndexBroken = true;
  console.error(`[robinhood] ${EVIDENCE_INDEX_FILE} is unreadable; evidence uploads are off until it is fixed:`, e.message);
}
const withEvidenceLock = makeLock();

function sniffImage(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG' && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 16 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}
/** Strict UTF-8 with no control characters other than tab, newline and carriage return; null if it is not. */
function plainText(buf) {
  let s;
  try { s = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return null; }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) return null;
  s = s.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  return s ? s : null;
}
/** A minimal multipart/form-data reader: enough for one file and a couple of short fields. */
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]{1,70})"|([^;\s]{1,70}))/i.exec(contentType || '');
  if (!m) return null;
  const delim = Buffer.from(`--${m[1] || m[2]}`);
  const parts = [];
  let pos = buf.indexOf(delim);
  if (pos < 0) return null;
  while (pos >= 0) {
    pos += delim.length;
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break; // closing --boundary--
    if (buf[pos] === 0x0d && buf[pos + 1] === 0x0a) pos += 2;
    const headEnd = buf.indexOf('\r\n\r\n', pos);
    if (headEnd < 0) return null;
    const head = buf.toString('utf8', pos, headEnd);
    const next = buf.indexOf(Buffer.concat([Buffer.from('\r\n'), delim]), headEnd + 4);
    if (next < 0) return null;
    const cd = /content-disposition:[^\r\n]*/i.exec(head)?.[0] || '';
    const name = /\bname="([^"]*)"/i.exec(cd)?.[1];
    const isFile = /\bfilename="/i.test(cd);
    const image = /content-type:\s*image\//i.test(head);
    if (name) parts.push({ name, isFile, image, data: buf.subarray(headEnd + 4, next) });
    if (parts.length > 8) return null;
    pos = next + 2;
  }
  return parts;
}
/** { tradeId, bytes? , text? } from any accepted shape, or { error }. */
function readEvidenceUpload(req) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  let tradeId = req.query.tradeId ?? req.get('x-trade-id');
  let bytes = null, text = null, claimedImage = false;
  if (ct.startsWith('multipart/form-data')) {
    if (!Buffer.isBuffer(req.body)) return { error: 'Could not read the upload.' };
    const parts = parseMultipart(req.body, req.headers['content-type']);
    if (!parts) return { error: 'Could not read the multipart upload.' };
    for (const p of parts) {
      if (p.name === 'tradeId' && !p.isFile) tradeId = p.data.toString('utf8').trim();
      else if (p.isFile || p.name === 'file' || p.name === 'image') {
        if (bytes) return { error: 'Send one file per upload.' };
        bytes = p.data; claimedImage = p.image;
      }
      else if (p.name === 'text') text = p.data;
    }
  } else if (ct.startsWith('application/json')) {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    if (b.tradeId != null) tradeId = b.tradeId;
    if (typeof b.image === 'string' && b.image) {
      const m = /^(?:data:image\/[a-z0-9.+-]+;base64,)?([A-Za-z0-9+/=\s]+)$/i.exec(b.image);
      if (!m) return { error: 'image must be base64 or a data:image/...;base64 URL.' };
      bytes = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
      claimedImage = true;
    } else if (typeof b.text === 'string') {
      text = Buffer.from(b.text, 'utf8');
    }
  } else if (Buffer.isBuffer(req.body)) {
    if (ct.startsWith('text/plain')) text = req.body;
    else { bytes = req.body; claimedImage = ct.startsWith('image/'); }
  } else {
    return { error: 'Send one png, jpeg or webp image, or plain text: multipart/form-data (tradeId + file or text), JSON {"tradeId":N,"text":"..."}, or the raw bytes with ?tradeId=N.' };
  }
  tradeId = typeof tradeId === 'number' && Number.isSafeInteger(tradeId) ? String(tradeId) : String(tradeId ?? '').trim();
  if (!/^\d{1,19}$/.test(tradeId)) return { error: 'Send tradeId, the trade number (a whole number).' };
  if (bytes && bytes.length && text && text.length) return { error: 'Send one file or some text per upload, not both.' };
  if (bytes && bytes.length) {
    const ext = sniffImage(bytes);
    if (ext) {
      if (bytes.length > EVIDENCE_MAX_IMAGE_BYTES) return { status: 413, error: 'Images are limited to 2 MB.' };
      return { tradeId: BigInt(tradeId), ext, data: bytes };
    }
    // A file that is really plain text (a .txt, or text sent as octet-stream) is fine; anything else is not.
    const t = claimedImage ? null : plainText(bytes);
    if (t == null) return { error: 'That file is not a png, jpeg or webp image, or plain text.' };
    text = Buffer.from(t, 'utf8');
  }
  if (text) {
    const t = plainText(text);
    if (t == null) return { error: 'Text evidence must be plain UTF-8 text.' };
    const data = Buffer.from(t, 'utf8');
    if (data.length > EVIDENCE_MAX_TEXT_BYTES) return { status: 413, error: 'Text evidence is limited to 20 KB.' };
    return { tradeId: BigInt(tradeId), ext: 'txt', data };
  }
  return { error: 'Nothing to store: send one png, jpeg or webp image, or some text.' };
}
const normHandle = (h) => String(h || '').trim().replace(/^@/, '').toLowerCase();

app.post('/api/robinhood/evidence', async (req, res) => {
  const user = currentUser(req);
  if (!user || !user.id) return res.status(401).json({ error: `Evidence uploads need your X account. ${SIGN_IN_HINT}` });
  const up = readEvidenceUpload(req);
  if (up.error) return res.status(up.status || 400).json({ error: up.error });
  if (!ROBINHOOD_OTC) return res.status(503).json({ error: 'The Robinhood OTC desk is not deployed yet, so there are no trades to add evidence to.' });
  if (evidenceIndexBroken) return res.status(503).json({ error: 'Evidence uploads are paused while their index is repaired. Try again later.' });

  let trade;
  try {
    trade = await l3Client.readContract({ address: ROBINHOOD_OTC, abi: OTC_VIEW_ABI, functionName: 'getTrade', args: [up.tradeId] });
  } catch (e) {
    const reverted = /revert|execution reverted|returned no data/i.test(`${e.shortMessage || ''} ${e.message || ''}`);
    if (reverted) return res.status(404).json({ error: `There is no trade #${up.tradeId} on the desk.` });
    return res.status(502).json({ error: `Could not read Robinhood Chain: ${e.shortMessage || e.message}` });
  }
  if (!trade || trade.seller === ZERO_ADDRESS) return res.status(404).json({ error: `There is no trade #${up.tradeId} on the desk.` });
  // OtcArbitration.submitEvidence only takes evidence for an open dispute, so nothing else is worth storing.
  if (Number(trade.status) !== TRADE_STATUS_DISPUTED) {
    return res.status(409).json({ error: `Evidence is only taken for a trade in dispute. Trade #${up.tradeId} is ${TRADE_STATUS[Number(trade.status)] || `in status ${trade.status}`}.` });
  }
  const me = normHandle(user.handle);
  const side = me && me === normHandle(trade.sellerXHandle) ? 'seller' : me && me === normHandle(trade.buyerXHandle) ? 'buyer' : null;
  if (!side) {
    return res.status(403).json({ error: `Only the two X accounts on trade #${up.tradeId} (@${normHandle(trade.sellerXHandle)} and @${normHandle(trade.buyerXHandle)}) can add evidence. You are signed in as @${user.handle}.` });
  }

  const xId = String(user.id);
  const tradeKey = up.tradeId.toString();
  const sha256 = crypto.createHash('sha256').update(up.data).digest('hex');
  try {
    const out = await withEvidenceLock(async () => {
      const today = utcDay();
      let mineToday = 0, mineThisTrade = 0, bytesToday = 0;
      for (const [file, f] of Object.entries(evidenceIndex.files)) {
        if (f.day === today) bytesToday += Number(f.bytes) || 0;
        if (f.xId !== xId) continue;
        if (f.day === today) mineToday++;
        if (f.tradeId === tradeKey) {
          mineThisTrade++;
          if (f.sha256 === sha256) return { status: 200, body: { file, deduped: true, contentType: EVIDENCE_TYPES[file.split('.')[1]], bytes: f.bytes, sha256 } };
        }
      }
      if (mineThisTrade >= EVIDENCE_PER_TRADE_PER_ACCOUNT) return { status: 429, body: { error: `You already added ${EVIDENCE_PER_TRADE_PER_ACCOUNT} files to trade #${tradeKey}, the most one account can.` } };
      if (mineToday >= EVIDENCE_PER_ACCOUNT_DAILY) return { status: 429, body: { error: `You already uploaded ${EVIDENCE_PER_ACCOUNT_DAILY} files today. It resets at 00:00 UTC.` } };
      if (bytesToday + up.data.length > EVIDENCE_DAILY_BYTES) {
        return { status: 429, body: { error: 'The desk has taken all the evidence uploads it stores in one day. It resets at 00:00 UTC. You can still paste a link as evidence.' } };
      }
      const room = evidenceRoomBytes();
      if (room == null || room < up.data.length) {
        if (room != null) console.error(`[robinhood] evidence refused: the volume is at its free-space floor (${room} bytes of room)`);
        return { status: 507, body: { error: 'The host is short of disk space, so it is not storing evidence files right now. You can still paste a link as evidence.' } };
      }

      const file = `${crypto.randomBytes(16).toString('hex')}.${up.ext}`;
      const full = path.join(EVIDENCE_DIR, file);
      const fd = fs.openSync(full, 'wx', 0o644);
      try { fs.writeSync(fd, up.data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const now = Date.now();
      const next = { ...evidenceIndex, files: { ...evidenceIndex.files, [file]: { tradeId: tradeKey, xId, handle: user.handle, side, at: now, day: utcDay(now), bytes: up.data.length, sha256 } } };
      try { writeJsonAtomic(EVIDENCE_INDEX_FILE, next); } catch (e) {
        try { fs.unlinkSync(full); } catch {}
        throw e;
      }
      evidenceIndex = next;
      return { status: 200, body: { file, deduped: false, contentType: EVIDENCE_TYPES[up.ext], bytes: up.data.length, sha256 } };
    });
    if (out.status !== 200) return res.status(out.status).json(out.body);
    const p = `/api/robinhood/evidence/${out.body.file}`;
    if (!out.body.deduped) console.log(`[robinhood] evidence for trade #${tradeKey} from @${user.handle} (${side}): ${out.body.file}, ${out.body.bytes} bytes`);
    res.json({ ok: true, tradeId: tradeKey, side, path: p, uri: `${PUBLIC_ORIGIN}${p}`, ...out.body });
  } catch (e) {
    console.error('[robinhood/evidence] could not store an upload:', e.message);
    res.status(500).json({ error: 'Could not store the file. Nothing was saved; try again.' });
  }
});

app.get('/api/robinhood/evidence/:file', (req, res) => {
  const file = String(req.params.file || '');
  // The name must be one this host generated: 32 hex characters and a known extension, nothing else. That rules
  // out every path trick (slashes, dots, encoded separators) before the filesystem is touched.
  if (!EVIDENCE_FILE_RE.test(file) || !evidenceIndex.files[file]) return res.status(404).json({ error: 'No such evidence file.' });
  const full = path.join(EVIDENCE_DIR, file);
  if (path.dirname(full) !== EVIDENCE_DIR) return res.status(404).json({ error: 'No such evidence file.' });
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) return res.status(404).json({ error: 'No such evidence file.' });
    res.set({
      'Content-Type': EVIDENCE_TYPES[file.split('.')[1]],
      'Content-Length': String(st.size),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      'Content-Disposition': `inline; filename="evidence-${file}"`,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Referrer-Policy': 'no-referrer',
    });
    if (req.method === 'HEAD') return res.end();
    const s = fs.createReadStream(full);
    s.on('error', () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); });
    s.pipe(res);
  });
});
app.all('/api/robinhood/evidence/:file', (_req, res) => res.status(405).set('Allow', 'GET, HEAD').json({ error: 'Evidence files are read-only.' }));

// ---------------------------------------------------------------------------
// Frontend + per-order / per-trade link previews.
// /order/:id and /trade/:id are client routes; for crawlers (X, Discord, iMessage) we
// rewrite the OG/Twitter tags from live escrow state so the card describes that offer.
// ---------------------------------------------------------------------------
const ESCROW_VIEW_ABI = parseAbi([
  'function orders(uint256) view returns (address maker, string makerXHandle, uint8 side, uint256 availableXMoney, uint256 fiatRateBps, uint256 minAmount, uint256 maxAmount, bool active)',
  'function trades(uint256) view returns (uint256 orderId, uint8 side, address seller, string sellerXHandle, address buyer, string buyerXHandle, uint256 xMoneyAmount, uint256 expectedCents, uint256 deadline, bool completed, bool cancelled)'
]);
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || 'https://xgas.dev';

async function l4Call(to, data) {
  return l4Client.call({ to, data }).then(r => r.data);
}

function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let indexHtmlCache = null;
function indexHtml() {
  if (!indexHtmlCache || process.env.NODE_ENV !== 'production') {
    indexHtmlCache = fs.readFileSync(path.join(__dirname, 'dist', 'index.html'), 'utf8');
  }
  return indexHtmlCache;
}

// Replaces the content of <meta {attr}="{key}" content="..."> or, when the tag is missing, adds it before </head>.
// Replacements go through functions, never replacement strings, so a "$2,690.00" in a title stays literal.
function setMetaTag(html, attr, key, value) {
  const v = escapeHtml(value);
  const re = new RegExp(`(<meta ${attr}="${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" content=")[^"]*(")`);
  if (re.test(html)) return html.replace(re, (_m, a, b) => a + v + b);
  return html.replace('</head>', () => `  <meta ${attr}="${key}" content="${v}" />\n  </head>`);
}

// image (absolute URL of a 1200x630 PNG) and imageAlt are optional; without them the page keeps its default card.
function withMeta(html, { title, description, url, image, imageAlt }) {
  const t = escapeHtml(title), u = escapeHtml(url);
  let out = html.replace(/<title>[^<]*<\/title>/, () => `<title>${t}</title>`);
  out = setMetaTag(out, 'name', 'description', description);
  out = setMetaTag(out, 'property', 'og:title', title);
  out = setMetaTag(out, 'property', 'og:description', description);
  out = setMetaTag(out, 'property', 'og:url', url);
  out = /<link rel="canonical" href="/.test(out)
    ? out.replace(/(<link rel="canonical" href=")[^"]*(")/, (_m, a, b) => a + u + b)
    : out.replace('</head>', () => `  <link rel="canonical" href="${u}" />\n  </head>`);
  out = setMetaTag(out, 'name', 'twitter:title', title);
  out = setMetaTag(out, 'name', 'twitter:description', description);
  if (image) {
    const alt = imageAlt || title;
    out = setMetaTag(out, 'property', 'og:image', image);
    out = setMetaTag(out, 'property', 'og:image:secure_url', image);
    out = setMetaTag(out, 'property', 'og:image:type', 'image/png');
    out = setMetaTag(out, 'property', 'og:image:width', '1200');
    out = setMetaTag(out, 'property', 'og:image:height', '630');
    out = setMetaTag(out, 'property', 'og:image:alt', alt);
    out = setMetaTag(out, 'name', 'twitter:card', 'summary_large_image');
    out = setMetaTag(out, 'name', 'twitter:image', image);
    out = setMetaTag(out, 'name', 'twitter:image:alt', alt);
  }
  return out;
}

const fmtX = (wei) => Number(formatEther(wei)).toLocaleString('en-US', { maximumFractionDigits: 4 });

app.get(['/order/:id', '/offer/:id', '/bid/:id', '/ask/:id'], async (req, res) => {
  let html = indexHtml();
  try {
    const id = BigInt(req.params.id);
    if (DEPLOY.l4.escrow) {
      const data = encodeFunctionData({ abi: ESCROW_VIEW_ABI, functionName: 'orders', args: [id] });
      const raw = await l4Call(DEPLOY.l4.escrow, data);
      const o = decodeFunctionResult({ abi: ESCROW_VIEW_ABI, functionName: 'orders', data: raw });
      const [maker, handle, side, available, rateBps, minAmt, maxAmt, active] = o;
      if (maker !== '0x0000000000000000000000000000000000000000') {
        const kind = Number(side) === 0 ? 'Sell Ask' : 'Buy Bid';
        const verb = Number(side) === 0 ? 'Buy' : 'Sell';
        const price = (Number(rateBps) / 10000).toFixed(3);
        const title = `${kind} #${id}: ${verb} ${fmtX(available)} $xMoney @ $${price} · @${handle} · xgas Orbit L4`;
        const description = active
          ? `${verb} ${fmtX(minAmt)} to ${fmtX(maxAmt)} $xMoney per trade at $${price} USD on X Money, escrowed on xgas Orbit L4 #${ORBIT_L4_CHAIN_ID}. 0.01% burn · 0.01% Stacc Wizards Fee Fanout · 0.02% XGAS.DEV buy & burn.`
          : `This ${kind.toLowerCase()} by @${handle} is closed. Browse live offers and bids on the xgas Orbit L4 desk.`;
        html = withMeta(html, { title, description, url: `${PUBLIC_ORIGIN}/order/${id}` });
      }
    }
  } catch (e) {
    console.warn('[OG] order preview failed:', e?.message || e);
  }
  res.type('html').send(html);
});

app.get(['/trade/:id', '/settlement/:id'], async (req, res) => {
  let html = indexHtml();
  try {
    const id = BigInt(req.params.id);
    if (DEPLOY.l4.escrow) {
      const data = encodeFunctionData({ abi: ESCROW_VIEW_ABI, functionName: 'trades', args: [id] });
      const raw = await l4Call(DEPLOY.l4.escrow, data);
      const t = decodeFunctionResult({ abi: ESCROW_VIEW_ABI, functionName: 'trades', data: raw });
      const [orderId, , seller, sellerHandle, , buyerHandle, amount, cents, , completed, cancelled] = t;
      if (seller !== '0x0000000000000000000000000000000000000000') {
        const state = completed ? 'Released' : cancelled ? 'Cancelled' : 'In escrow';
        const title = `Trade #${id} (${state}): @${buyerHandle} ← ${fmtX(amount)} $xMoney ← @${sellerHandle} · xgas Orbit L4`;
        const description = `${fmtX(amount)} $xMoney against $${(Number(cents) / 100).toFixed(2)} USD on X Money, from order #${orderId}. Escrowed on xgas Orbit L4 #${ORBIT_L4_CHAIN_ID}.`;
        html = withMeta(html, { title, description, url: `${PUBLIC_ORIGIN}/trade/${id}` });
      }
    }
  } catch (e) {
    console.warn('[OG] trade preview failed:', e?.message || e);
  }
  res.type('html').send(html);
});

// ---------------------------------------------------------------------------
// Robinhood desk deep links and link previews (server/og/robinhood.mjs):
//   /robinhood, /robinhood/post, /robinhood/arbiters, /robinhood/order/:id, /robinhood/trade/:id  the SPA, with
//   title, description, canonical and og/twitter image tags describing that page from live chain state.
//   /og/robinhood.png, /og/robinhood/order/:id.png, /og/robinhood/trade/:id.png  the 1200x630 cards.
// Any failure falls back to the desk's card and text; these pages never answer with an error.
// ---------------------------------------------------------------------------
const robinhoodOg = createRobinhoodOg({
  client: l3Client,
  otc: ROBINHOOD_OTC,
  fairPrice: ethFairPrice,
  origin: PUBLIC_ORIGIN.replace(/\/+$/, ''),
  ipKey: (req) => ipLimitKey(clientIp(req)),
  fallbackPng: path.join(__dirname, 'dist', 'og.png'),
});
robinhoodOg.mountImages(app);

// Plaid, read-only: a desk party links the account their X Money dollars move through and the host looks for the
// trade's payment there (server/plaid.mjs). Off unless PLAID_CLIENT_ID and PLAID_SECRET are set.
const plaid = createPlaid({
  dataDir: DATA_DIR,
  sessionSecret: SESSION_SECRET,
  currentUser,
  origin: PUBLIC_ORIGIN,
  readTrade: async (tradeId) => {
    if (!ROBINHOOD_OTC) return { status: 503, error: 'The Robinhood OTC desk is not deployed yet.' };
    try {
      const trade = await l3Client.readContract({ address: ROBINHOOD_OTC, abi: OTC_VIEW_ABI, functionName: 'getTrade', args: [tradeId] });
      if (!trade || trade.seller === ZERO_ADDRESS) return { status: 404, error: `There is no trade #${tradeId} on the desk.` };
      return { trade };
    } catch (e) {
      const reverted = /revert|execution reverted|returned no data/i.test(`${e.shortMessage || ''} ${e.message || ''}`);
      return reverted ? { status: 404, error: `There is no trade #${tradeId} on the desk.` } : { status: 502, error: `Could not read Robinhood Chain: ${e.shortMessage || e.message}` };
    }
  },
});
plaid.mount(app);
const ROBINHOOD_PAGES = { '/robinhood': 'desk', '/robinhood/post': 'post', '/robinhood/trades': 'trades', '/robinhood/arbiters': 'arbiters' };
app.get(['/robinhood', '/robinhood/post', '/robinhood/trades', '/robinhood/arbiters', '/robinhood/order/:id', '/robinhood/offer/:id', '/robinhood/trade/:id'], async (req, res, next) => {
  let html;
  try { html = indexHtml(); } catch { return next(); } // no build yet: let the static handler answer
  try {
    const p = req.path.toLowerCase().replace(/\/+$/, '') || '/';
    // /robinhood/offer/:id is an alias the page rewrites to /robinhood/order/:id; its preview is the order's.
    const page = ROBINHOOD_PAGES[p] || (/^\/robinhood\/(order|offer)\//.test(p) ? 'order' : p.startsWith('/robinhood/trade/') ? 'trade' : 'desk');
    html = withMeta(html, await robinhoodOg.meta(page, req.params.id));
  } catch (e) {
    console.warn('[og] robinhood page meta failed:', e?.message || e);
  }
  res.type('html').send(html);
});

// Legal pages (static HTML in dist from public/); clean URLs for app-store / Meta forms
app.get(['/privacy', '/privacy.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'privacy.html'));
});
app.get(['/terms', '/terms.html', '/tos', '/tos.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'terms.html'));
});

// Serve frontend build
app.use(express.static(path.join(__dirname, 'dist')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`xgas Orbit app listening on port ${PORT}; L4 sequencer at ${L4_RPC_INTERNAL} (public ${L4_RPC_PUBLIC})`);
});
