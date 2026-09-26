import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPublicClient, createWalletClient, http as viemHttp, parseAbi, formatEther, encodeFunctionData, decodeFunctionResult, decodeEventLog } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ALL_TOOLS, TOOLS_BY_NAME, isBrowserSafe, unwrap } from './mcp/src/registry.mjs';
import { createServer as createMcpServer, isHostable, hostableFor, VERSION as MCP_VERSION } from './mcp/src/server.mjs';
import { runAs, OPERATOR } from './mcp/src/actor.mjs';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

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

const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'l4-data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const l3Client = createPublicClient({ transport: viemHttp(L3_RPC) });
const l4Client = createPublicClient({ transport: viemHttp(L4_RPC_INTERNAL, { timeout: 15_000 }) });

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
function safeReturnTo(v) {
  return typeof v === 'string' && /^\/[a-z0-9_-]*$/i.test(v) ? v : '/';
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

function withMeta(html, { title, description, url }) {
  const t = escapeHtml(title), d = escapeHtml(description), u = escapeHtml(url);
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${t}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${d}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${t}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${d}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${u}$2`)
    .replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${u}$2`)
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${t}$2`)
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${d}$2`);
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
