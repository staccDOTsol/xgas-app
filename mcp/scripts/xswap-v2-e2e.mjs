/**
 * XSwap V2 fork lifecycle, against the *deployed* reviewed Robinhood contracts, with the exact deployed ABI.
 *
 *   npm run e2e:v2            (from mcp/; starts and stops its own anvil processes)
 *
 * Two anvils are started: a Robinhood (4663) fork at a fresh block, and a bare chain-id 8453 node standing in for
 * Base. On the fork, the deployed V2 collector/intents/asks runtime hashes are checked first; nothing is deployed.
 * X Money is moved from an impersonated existing holder (never minted, never storage-written), so every amount
 * passes through the token's real 1 bp transfer burn.
 *
 * OUT (Intents): tax-aware openWithSiteFee → canClaim bond → tax-aware 3-argument bid priced with the solver's own
 * pricedAsk → exact native delivery on "Base" to the signed recipient and amount (12 blocks) → claim with that tx
 * hash as proof → settle refused inside the frozen 30-minute window → settle → credits → withdrawals.
 * IN (Asks): askWithSiteFee → bid (pay + 100% bond in one taxed debit) → accept → delivered → settle → withdrawals.
 * The staccpad solver's pure guards (verifiedOrder, bondGrossDebit, pricedAsk, exactBaseTransfer,
 * mayBroadcastDelivery, settlementReady) are run against the live on-chain structs.
 *
 * Refuses to run against anything that is not anvil. No private key here controls real funds.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  createPublicClient, createWalletClient, defineChain, encodeAbiParameters, encodeFunctionData, formatUnits, http,
  keccak256, parseAbi, parseEventLogs, toHex, zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { XSWAP_V2_INTENTS_ABI, XSWAP_V2_ASKS_ABI } from '../src/abis.mjs';
import { xswapV2OutFunding, xswapV2GrossFor, xswapV2InFloor, xswapV2TermsHash } from '../src/xswapV2.mjs';
import {
  bondGrossDebit, pricedAsk, verifiedOrder, exactBaseTransfer, settlementReady, mayBroadcastDelivery, solverNetAtAsk,
} from '/Users/stacc/staccpad-ai/xswap-solver-v2.mjs';

// ── pins (the reviewed production deployment) ─────────────────────────────────────────────────────────────────
const RH_RPC = process.env.XSWAP_V2_FORK_UPSTREAM || 'https://rpc.mainnet.chain.robinhood.com';
const ANVIL = process.env.ANVIL || path.join(os.homedir(), '.foundry', 'bin', 'anvil');
const RH_PORT = Number(process.env.XSWAP_V2_RH_PORT || 8560);
const BASE_PORT = Number(process.env.XSWAP_V2_BASE_PORT || 8561);
const PINS = {
  collector: '0x5a5e18e5003d75f9705252b2c3436c1b61e6d33e',
  collectorRuntime: '0xb0eb9674d60fbfe03eb1f26c2453ee2446433812ff9e0690fd7db8c89032633b',
  intents: '0xdf6398ff5a694a03d85a614812490143c4e5d238',
  intentsRuntime: '0xd5f3ec158647ae483ed942998d9f164aa0e26b98a1a2e29a4a0b6b3bd9a354eb',
  asks: '0x2f507a18043002d8f5d6d3022efd6265be7a87fc',
  asksRuntime: '0x998aca274594b99b203562e5c0b9a46aa6f5794b3bfbbee762afdb125bf1f557',
  xmoney: '0xa924C725B64cC346f275269EFA4Bd0538cfBa97E',
  owner: '0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158',
  treasury: '0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8',
};
const KNOWN_HOLDERS = ['0x8796985D094Ae11eFAa258170Bc71f748ab2D2f6', PINS.owner];
const BPS = 10_000n;
const XM = 10n ** 18n;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const fmt = (v) => formatUnits(BigInt(v), 18);
const burn = (v) => BigInt(v) / BPS; // XMoney burns floor(amount / 10_000) on every transfer

const ERRORS = parseAbi(['error BadState()', 'error NotYet()', 'error TooLate()', 'error NotUser()', 'error Exists()',
  'error Zero()', 'error NotTrusted()', 'error TooGreen()', 'error NotBest()', 'error Outbid()', 'error BadFee()',
  'error ShortTransfer()', 'error ExcessDebit()', 'error WrongChain()', 'error TermsChanged()', 'error Low()',
  'error NotSeller()', 'error NotBuyer()',
  'error ERC20InsufficientAllowance(address spender,uint256 allowance,uint256 needed)',
  'error ERC20InsufficientBalance(address sender,uint256 balance,uint256 needed)']);
const INTENTS_EVENTS = parseAbi([
  'event Bid(bytes32 indexed id,address indexed solver,uint256 ask,uint256 bond)',
  'event Claimed(bytes32 indexed id,address indexed solver,uint256 bond,bytes32 proof)',
  'event Settled(bytes32 indexed id,address indexed solver,uint256 paid,uint256 fee,uint256 backToUser)',
  'event SiteFeePaid(bytes32 indexed id,address indexed recipient,uint256 amount)',
]);
const ASKS_EVENTS = parseAbi([
  'event Bid(bytes32 indexed id,address indexed buyer,uint256 pay,uint256 bond)',
  'event Delivered(bytes32 indexed id,address indexed seller,bytes32 proof)',
  'event Settled(bytes32 indexed id,address indexed seller,uint256 sellerPaid,uint256 fee)',
  'event SiteFeePaid(bytes32 indexed id,address indexed recipient,uint256 amount)',
]);
const INTENTS_ABI = [...XSWAP_V2_INTENTS_ABI, ...INTENTS_EVENTS, ...ERRORS];
const ASKS_ABI = [...XSWAP_V2_ASKS_ABI, ...ASKS_EVENTS, ...ERRORS];
const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)', 'function BURN_BPS() view returns (uint256)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const COLLECTOR = parseAbi(['function intents() view returns (address)', 'function asks() view returns (address)',
  'function configured() view returns (bool)']);

// anvil's two well-known development keys. They hold nothing anywhere real.
const USER = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const SOLVER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

// ── reporting ─────────────────────────────────────────────────────────────────────────────────────────────────
const results = [];
function check(ok, text, detail) {
  results.push({ ok, text });
  console.log(`${ok ? ' ok ' : 'FAIL'} ${text}${detail !== undefined ? `  [${detail}]` : ''}`);
  return ok;
}
const note = (text) => console.log(`      ${text}`);
function finish(code) {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length ? 'FAIL' : 'PASS'}: ${results.length - failed.length}/${results.length} checks passed`);
  for (const f of failed) console.log(`  - ${f.text}`);
  stopAll();
  process.exit(code ?? (failed.length ? 1 : 0));
}

// ── anvil management ──────────────────────────────────────────────────────────────────────────────────────────
const procs = [];
function stopAll() { for (const p of procs.splice(0)) { try { p.kill('SIGKILL'); } catch { /* gone */ } } }
process.on('SIGINT', () => { stopAll(); process.exit(130); });
process.on('SIGTERM', () => { stopAll(); process.exit(143); });
process.on('uncaughtException', (e) => { console.error('\nuncaught:', e); stopAll(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('\nunhandled:', e); stopAll(); process.exit(1); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(url, method, params = []) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
async function startAnvil(args, url, readyProbe, timeoutMs) {
  const p = spawn(ANVIL, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d.toString(); });
  p.stdout.on('data', () => {});
  procs.push(p);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (p.exitCode !== null) throw new Error(`anvil exited (${p.exitCode}): ${err.trim().slice(-400)}`);
    try { if (await readyProbe(url)) return p; } catch { /* not yet */ }
    await sleep(500);
  }
  p.kill('SIGKILL');
  throw new Error(`anvil did not become ready in ${timeoutMs} ms: ${err.trim().slice(-400)}`);
}
async function startRobinhoodFork() {
  const url = `http://127.0.0.1:${RH_PORT}`;
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const head = BigInt(await rpc(RH_RPC, 'eth_blockNumber'));
    const forkBlock = head - (attempt === 1 ? 50n : 20n);
    note(`forking ${RH_RPC} at block ${forkBlock} (head ${head}), attempt ${attempt}`);
    try {
      const p = await startAnvil([
        '--fork-url', RH_RPC, '--fork-block-number', forkBlock.toString(), '--port', String(RH_PORT),
        '--silent', '--no-rate-limit', '--retries', '5', '--timeout', '45000',
      ], url, async (u) => {
        const code = await rpc(u, 'eth_getCode', [PINS.intents, 'latest']);
        return typeof code === 'string' && code.length > 2;
      }, 120_000);
      return { url, proc: p, forkBlock };
    } catch (e) {
      lastErr = e;
      note(`fork attempt ${attempt} failed: ${e.message}`);
      stopAll();
    }
  }
  throw lastErr;
}
async function startBase() {
  const url = `http://127.0.0.1:${BASE_PORT}`;
  const p = await startAnvil(['--chain-id', '8453', '--port', String(BASE_PORT), '--silent'], url,
    async (u) => BigInt(await rpc(u, 'eth_chainId')) === 8453n, 30_000);
  return { url, proc: p };
}

// ── clients ───────────────────────────────────────────────────────────────────────────────────────────────────
function clientsFor(url, id) {
  const chain = defineChain({ id, name: `anvil-${id}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [url] } } });
  const pub = createPublicClient({ chain, transport: http(url) });
  const wallet = (account) => createWalletClient({ account, chain, transport: http(url) });
  const raw = (method, params = []) => pub.request({ method, params });
  return { chain, pub, wallet, raw };
}
/** Decode a viem revert into the custom error name (or the message). */
function revertName(e) {
  let c = e;
  while (c) {
    if (c.data?.errorName) return c.data.errorName;
    if (c.name === 'ContractFunctionRevertedError' && c.reason) return c.reason;
    c = c.cause;
  }
  return e.shortMessage || e.message;
}
async function expectRevert(promise, name) {
  try { await promise; return { reverted: false, got: 'no revert' }; } catch (e) { const got = revertName(e); return { reverted: true, got, matched: got === name }; }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('XSwap V2 fork lifecycle (deployed Robinhood contracts, exact deployed ABI)\n');
const rh = await startRobinhoodFork();
const base = await startBase();
const RH = clientsFor(rh.url, Number(await rpc(rh.url, 'eth_chainId')));
const BASE = clientsFor(base.url, 8453);
check(RH.chain.id === 4663, `Robinhood fork is chain 4663 at block ${rh.forkBlock}`, `chainId ${RH.chain.id}`);
check(BASE.chain.id === 8453, 'Base stand-in anvil is chain 8453');
const isAnvil = await RH.raw('anvil_nodeInfo').then(() => true).catch(() => false);
if (!check(isAnvil, 'Robinhood RPC is anvil (this script rewrites balances; it never runs against a real chain)')) finish(2);

const readI = (fn, args = []) => RH.pub.readContract({ address: PINS.intents, abi: INTENTS_ABI, functionName: fn, args });
const readA = (fn, args = []) => RH.pub.readContract({ address: PINS.asks, abi: ASKS_ABI, functionName: fn, args });
const xmBal = (who) => RH.pub.readContract({ address: PINS.xmoney, abi: ERC20, functionName: 'balanceOf', args: [who] });
const chainNow = async () => BigInt((await RH.pub.getBlock()).timestamp);
async function send(account, request) {
  const hash = await RH.wallet(account).writeContract({ ...request, account, gas: 1_500_000n });
  const receipt = await RH.pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`tx ${hash} reverted on chain`);
  const block = await RH.pub.getBlock({ blockNumber: receipt.blockNumber });
  return { hash, receipt, timestamp: BigInt(block.timestamp) };
}
async function warp(seconds) {
  await RH.raw('evm_increaseTime', [toHex(BigInt(seconds))]);
  await RH.raw('evm_mine');
  return chainNow();
}

// ── 1. the deployment is the reviewed one ─────────────────────────────────────────────────────────────────────
console.log('\n[1] deployed bytecode and frozen terms');
for (const [label, address, expected] of [['collector', PINS.collector, PINS.collectorRuntime],
  ['intents', PINS.intents, PINS.intentsRuntime], ['asks', PINS.asks, PINS.asksRuntime]]) {
  const code = await RH.pub.getCode({ address });
  const hash = code && code !== '0x' ? keccak256(code) : null;
  if (!check(same(hash, expected), `${label} ${address} runtime keccak matches the reviewed pin`, hash)) finish(2);
}
const [iOwner, iXm, iCollector, iTreasury, iFee, iBond, iWindow, iBidding, iTerms] = await Promise.all(
  ['owner', 'xmoney', 'siteCollector', 'treasury', 'feeBps', 'bondBps', 'window', 'bidding', 'termsHash'].map((f) => readI(f)));
const [aOwner, aXm, aCollector, aTreasury, aFee, aBond, aWindow, aBidding, aTerms] = await Promise.all(
  ['owner', 'xmoney', 'siteCollector', 'treasury', 'feeBps', 'bondBps', 'window', 'bidding', 'termsHash'].map((f) => readA(f)));
const [cIntents, cAsks, cConfigured, burnBps] = await Promise.all([
  RH.pub.readContract({ address: PINS.collector, abi: COLLECTOR, functionName: 'intents' }),
  RH.pub.readContract({ address: PINS.collector, abi: COLLECTOR, functionName: 'asks' }),
  RH.pub.readContract({ address: PINS.collector, abi: COLLECTOR, functionName: 'configured' }),
  RH.pub.readContract({ address: PINS.xmoney, abi: ERC20, functionName: 'BURN_BPS' }),
]);
check(same(iOwner, PINS.owner) && same(aOwner, PINS.owner), 'intents/asks owner (arbiter) is 0x26E8…5158', iOwner);
check(same(iTreasury, PINS.treasury) && same(aTreasury, PINS.treasury), 'protocol treasury is 0x1b88…15c8', iTreasury);
check(same(iCollector, PINS.collector) && same(aCollector, PINS.collector), 'siteCollector on both escrows is the pinned collector');
check(same(cIntents, PINS.intents) && same(cAsks, PINS.asks) && cConfigured === true, 'collector links back to both escrows and is configured');
check(same(iXm, PINS.xmoney) && same(aXm, PINS.xmoney) && burnBps === 1n, 'X Money is pinned and burns 1 bp per transfer', `BURN_BPS ${burnBps}`);
check(Number(iFee) === 50 && Number(iBond) === 10_000 && Number(iWindow) === 1800 && Number(iBidding) === 120,
  'intents terms: 50 bp protocol fee, 100% bond, 30 min window, 2 min bidding', `fee ${iFee} bond ${iBond} window ${iWindow} bidding ${iBidding}`);
// XSwapAsksV2.sol defaults `bondBps = 2_500`: the buyer's bond on the IN side is 25% of pay, not the OUT side's 100%.
check(Number(aFee) === 50 && Number(aBond) === 2_500 && Number(aWindow) === 1800 && Number(aBidding) === 120,
  'asks terms: 50 bp protocol fee, 25% buyer bond (source default), 30 min window, 2 min bidding', `fee ${aFee} bond ${aBond} window ${aWindow} bidding ${aBidding}`);
check(same(iTerms, xswapV2TermsHash(iFee, iBond, iWindow, iBidding, iTreasury)), 'intents termsHash() == keccak(abi.encode(fee,bond,window,bidding,treasury))', iTerms);
check(same(aTerms, xswapV2TermsHash(aFee, aBond, aWindow, aBidding, aTreasury)), 'asks termsHash() matches the same derivation', aTerms);

// ── 2. the scene: ETH for gas, X Money moved from a real holder through the taxed token ───────────────────────
console.log('\n[2] funding on the fork');
for (const a of [USER.address, SOLVER.address]) await RH.raw('anvil_setBalance', [a, toHex(10n * XM)]);
await BASE.raw('anvil_setBalance', [SOLVER.address, toHex(10n * XM)]);

const OUT_GROSS = XM; // 1 X Money gross wallet debit for the OUT order
const IN_MIN_NET = 5n * 10n ** 17n; // 0.5 X Money minimum seller receipt for the IN ask
const inFloor = xswapV2InFloor(IN_MIN_NET);
const inTarget = inFloor.grossBidFloor + inFloor.grossBidFloor * BigInt(aBond) / BPS;
const USER_NEED = OUT_GROSS;
const SOLVER_NEED = xswapV2GrossFor(xswapV2OutFunding(OUT_GROSS).escrowCeiling) + xswapV2GrossFor(inTarget);
const holderNeed = xswapV2GrossFor(USER_NEED + SOLVER_NEED) + 2n * XM / 100n;

async function pickHolder() {
  const balances = await Promise.all(KNOWN_HOLDERS.map(async (h) => [h, await xmBal(h)]));
  balances.sort((a, b) => (a[1] > b[1] ? -1 : 1));
  if (balances[0][1] >= holderNeed) return balances[0];
  note(`known holders are too small (best ${fmt(balances[0][1])}); scanning recent Transfer logs for a larger one`);
  const head = await RH.pub.getBlockNumber();
  const seen = new Map();
  for (let to = head; to > head - 200_000n; to -= 5_000n) {
    const from = to - 4_999n;
    const logs = await RH.pub.getLogs({ address: PINS.xmoney, event: ERC20[4], fromBlock: from, toBlock: to });
    for (const l of logs) for (const who of [l.args.from, l.args.to]) if (who && who !== zeroAddress) seen.set(who, true);
    if (seen.size >= 200) break;
  }
  const scanned = await Promise.all([...seen.keys()].map(async (h) => [h, await xmBal(h)]));
  scanned.sort((a, b) => (a[1] > b[1] ? -1 : 1));
  return scanned[0];
}
const [holder, holderBal] = await pickHolder();
if (!check(holderBal >= holderNeed, `X Money holder ${holder} can fund the run`, `${fmt(holderBal)} held, ${fmt(holderNeed)} needed`)) finish(2);
const holderCode = await RH.pub.getCode({ address: holder });
note(`holder is ${holderCode && holderCode !== '0x' ? 'a contract' : 'an EOA'}; impersonated for plain ERC-20 transfers only`);
await RH.raw('anvil_setBalance', [holder, toHex(XM)]);
await RH.raw('anvil_impersonateAccount', [holder]);
async function dealFromHolder(to, netWanted) {
  const gross = xswapV2GrossFor(netWanted);
  const before = await xmBal(to);
  const hash = await RH.raw('eth_sendTransaction', [{ from: holder, to: PINS.xmoney, gas: toHex(200_000n),
    data: encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [to, gross] }) }]);
  const r = await RH.pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error('holder transfer reverted');
  const got = (await xmBal(to)) - before;
  check(got === gross - burn(gross) && got >= netWanted, `holder → ${to === USER.address ? 'user' : 'solver'}: sent ${fmt(gross)}, ${fmt(got)} arrived (1 bp burned)`);
  return got;
}
await dealFromHolder(USER.address, USER_NEED);
await dealFromHolder(SOLVER.address, SOLVER_NEED);
await RH.raw('anvil_stopImpersonatingAccount', [holder]);
note(`user ${USER.address} holds ${fmt(await xmBal(USER.address))} X Money; solver ${SOLVER.address} holds ${fmt(await xmBal(SOLVER.address))}`);

// ── 3. OUT: open with the site fee (gross wallet debit, taxed escrow, 10 bp reserve) ──────────────────────────
console.log('\n[3] OUT: openWithSiteFee');
const funding = xswapV2OutFunding(OUT_GROSS);
const order = { amount: (10n ** 15n).toString(), dstChainId: 8453, kind: 'native', to: USER.address }; // 0.001 ETH on Base to the user
const memo = JSON.stringify(Object.fromEntries(Object.keys(order).sort().map((k) => [k, order[k]])));
const want = keccak256(encodeAbiParameters(
  [{ type: 'uint256' }, { type: 'uint8' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }],
  [8453n, 0, zeroAddress, BigInt(order.amount), order.to]));
check(verifiedOrder(memo, want, USER.address) !== null, 'solver verifiedOrder(memo, want, user) accepts the memo/want pair', memo);
check(verifiedOrder(memo, want, SOLVER.address) === null, 'verifiedOrder rejects a memo whose recipient is not the escrow user');
const id = keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'uint256' }], ['xswap-v2-e2e-out', await chainNow()]));
const policy = { minFilled: 0, maxFailBps: 0, minBondBps: 0, trustedOnly: false };
const deadline = (await chainNow()) + 4n * 3600n;

const userBefore = await xmBal(USER.address);
const escrowBefore = await xmBal(PINS.intents);
await send(USER, { address: PINS.xmoney, abi: ERC20, functionName: 'approve', args: [PINS.intents, OUT_GROSS] });
const opened = await send(USER, { address: PINS.intents, abi: INTENTS_ABI, functionName: 'openWithSiteFee',
  args: [id, OUT_GROSS, funding.escrowCeiling, deadline, want, memo, policy, PINS.collector, 10, iTerms] });
const userAfterOpen = await xmBal(USER.address);
const escrowAfterOpen = await xmBal(PINS.intents);
let intent = await readI('get', [id]);
const received = escrowAfterOpen - escrowBefore;
check(userBefore - userAfterOpen === OUT_GROSS, `user wallet debited exactly the gross cap ${fmt(OUT_GROSS)}`, fmt(userBefore - userAfterOpen));
check(received === OUT_GROSS - burn(OUT_GROSS) && received === funding.expectedEscrowReceived,
  `escrow received gross minus 1 bp = ${fmt(received)}`, `helper expected ${fmt(funding.expectedEscrowReceived)}`);
check(intent.escrowed === received, 'get(id).escrowed books what actually arrived', fmt(intent.escrowed));
check(intent.amount === funding.escrowCeiling, `get(id).amount is the solver ceiling ${fmt(funding.escrowCeiling)}`, fmt(intent.amount));
check(intent.amount + intent.amount * 10n / BPS <= intent.escrowed, 'ceiling + 10 bp site reserve ≤ escrowed');
check(Number(intent.state) === 0 && same(intent.user, USER.address) && intent.want === want, 'intent is Open for the user with the signed want hash');
check(Number(intent.siteFeeBps) === 10 && same(intent.siteFeeRecipient, PINS.collector), 'site fee frozen: 10 bp to the collector');
check(Number(intent.protocolBps) === 50 && Number(intent.openedBondBps) === 10_000 && Number(intent.challengeWindow) === 1800 && same(intent.protocolTreasury, PINS.treasury),
  'protocol terms frozen into the order: 50 bp, 100% bond, 1800 s window, treasury');
check(intent.bidEnds === opened.timestamp + 120n && intent.deadline === deadline, 'bidEnds = open time + 120 s; deadline as signed', `bidEnds ${intent.bidEnds}`);
const openLogs = parseEventLogs({ abi: INTENTS_ABI, logs: opened.receipt.logs });
const openedEv = openLogs.find((l) => l.eventName === 'Opened');
const boundEv = openLogs.find((l) => l.eventName === 'SiteFeeBound');
check(openedEv?.args.amount === funding.escrowCeiling && openedEv?.args.memo === memo && openedEv?.args.want === want, 'Opened event carries ceiling, want and memo');
check(boundEv?.args.escrowed === received && boundEv?.args.ceiling === funding.escrowCeiling && Number(boundEv?.args.bps) === 10, 'SiteFeeBound event carries escrowed and ceiling');
const excess = await expectRevert(RH.pub.simulateContract({ account: USER.address, address: PINS.intents, abi: INTENTS_ABI, functionName: 'openWithSiteFee',
  args: [keccak256('0x01'), OUT_GROSS, funding.escrowCeiling, deadline, want, memo, policy, PINS.collector, 10, keccak256('0x00')] }), 'TermsChanged');
check(excess.matched, 'openWithSiteFee with a stale expectedTermsHash reverts TermsChanged', excess.got);

// ── 4. OUT: the solver prices and posts a tax-aware bond bid ──────────────────────────────────────────────────
console.log('\n[4] OUT: bid(id, ask, maxBondGrossDebit)');
const [canOk, canWhy, requiredBond] = await readI('canClaim', [id, SOLVER.address]);
check(canOk === true && requiredBond === intent.amount * BigInt(intent.openedBondBps) / BPS, `canClaim: ok, required bond ${fmt(requiredBond)} (100% of ceiling)`, canWhy || 'no reason');
const grossBond = bondGrossDebit(requiredBond);
check(grossBond - burn(grossBond) >= requiredBond && grossBond <= requiredBond + requiredBond / 5_000n + 2n,
  `solver bondGrossDebit ${fmt(grossBond)} covers the bond after burn and sits inside the contract's ExcessDebit bound`);
const COST = 3n * 10n ** 17n; // a plausible all-in Base delivery cost, in X Money
const ask = pricedAsk(COST, iFee, requiredBond);
check(ask > 0n && ask <= intent.amount, `pricedAsk(cost 0.3, 50 bp, bond) = ${fmt(ask)} ≤ ceiling`, `solver net at ask ${fmt(solverNetAtAsk(ask, iFee, requiredBond))}`);
check(mayBroadcastDelivery(intent, SOLVER.address, await chainNow(), 900) === false, 'mayBroadcastDelivery is false while the intent is only Open');

const solverBefore = await xmBal(SOLVER.address);
await send(SOLVER, { address: PINS.xmoney, abi: ERC20, functionName: 'approve', args: [PINS.intents, grossBond] });
const under = await expectRevert(RH.pub.simulateContract({ account: SOLVER.address, address: PINS.intents, abi: INTENTS_ABI, functionName: 'bid', args: [id, ask, requiredBond - 1n] }), 'ExcessDebit');
check(under.matched, 'bid with maxBondGrossDebit below the required bond reverts ExcessDebit', under.got);
// Exactly the required bond passes the bound, but the 1 bp burn leaves the escrow short: the contract books what arrived.
const untaxed = await expectRevert(RH.pub.simulateContract({ account: SOLVER.address, address: PINS.intents, abi: INTENTS_ABI, functionName: 'bid', args: [id, ask, requiredBond] }), 'ShortTransfer');
check(untaxed.matched, 'bid with an untaxed maxBondGrossDebit (= required bond) reverts ShortTransfer after the burn', untaxed.got);
const over = await expectRevert(RH.pub.simulateContract({ account: SOLVER.address, address: PINS.intents, abi: INTENTS_ABI, functionName: 'bid', args: [id, ask, requiredBond + requiredBond / 5_000n + 3n] }), 'ExcessDebit');
check(over.matched, 'bid with maxBondGrossDebit above the burn bound reverts ExcessDebit', over.got);
const bidTx = await send(SOLVER, { address: PINS.intents, abi: INTENTS_ABI, functionName: 'bid', args: [id, ask, grossBond] });
const solverAfterBid = await xmBal(SOLVER.address);
const escrowAfterBid = await xmBal(PINS.intents);
intent = await readI('get', [id]);
check(solverBefore - solverAfterBid === grossBond, `solver wallet debited exactly maxBondGrossDebit ${fmt(grossBond)}`);
check(intent.bond === grossBond - burn(grossBond) && intent.bond >= requiredBond, `bond booked = gross minus burn = ${fmt(intent.bond)} ≥ required`, fmt(intent.bond));
check(escrowAfterBid - escrowAfterOpen === intent.bond, 'escrow balance rose by exactly the booked bond');
check(Number(intent.state) === 1 && same(intent.solver, SOLVER.address) && intent.ask === ask, 'intent is Bid by the solver at the priced ask');
const bidEv = parseEventLogs({ abi: INTENTS_ABI, logs: bidTx.receipt.logs }).find((l) => l.eventName === 'Bid');
check(bidEv?.args.ask === ask && bidEv?.args.bond === intent.bond, 'Bid event carries ask and actual bond');
const higher = await expectRevert(RH.pub.simulateContract({ account: USER.address, address: PINS.intents, abi: INTENTS_ABI, functionName: 'bid', args: [id, ask, grossBond] }), 'Outbid');
check(higher.matched, 'an equal (not lower) ask is refused with Outbid', higher.got);
check(mayBroadcastDelivery(intent, SOLVER.address, await chainNow(), 900) === true, 'mayBroadcastDelivery is true: Bid, by this solver, >15 min before the deadline');
check(mayBroadcastDelivery(intent, USER.address, await chainNow(), 900) === false, 'mayBroadcastDelivery is false for an address that is not the winning solver');
check(mayBroadcastDelivery(intent, SOLVER.address, intent.deadline - 600n, 900) === false, 'mayBroadcastDelivery is false inside the 15-minute deadline safety margin');
check(settlementReady(intent, await chainNow()) === false, 'settlementReady is false before any claim');

// ── 5. Base leg: deliver exactly the signed amount to the signed recipient ────────────────────────────────────
console.log('\n[5] Base: native delivery to the signed user');
const toBefore = await BASE.pub.getBalance({ address: order.to });
const baseHash = await BASE.wallet(SOLVER).sendTransaction({ account: SOLVER, to: order.to, value: BigInt(order.amount), data: '0x' });
const baseReceipt = await BASE.pub.waitForTransactionReceipt({ hash: baseHash });
const baseTx = await BASE.pub.getTransaction({ hash: baseHash });
check(exactBaseTransfer(baseReceipt, baseTx, order, SOLVER.address) === true, `exactBaseTransfer: success, from solver, to ${order.to}, value ${order.amount} wei, empty input`, baseHash);
check(exactBaseTransfer(baseReceipt, { ...baseTx, value: baseTx.value - 1n }, order, SOLVER.address) === false, 'exactBaseTransfer rejects a 1 wei short delivery');
check(exactBaseTransfer(baseReceipt, baseTx, order, USER.address) === false, 'exactBaseTransfer rejects a delivery not sent by the solver');
check((await BASE.pub.getBalance({ address: order.to })) - toBefore === BigInt(order.amount), 'recipient balance on Base rose by exactly the order amount');
await BASE.raw('anvil_mine', [toHex(12n)]);
// viem caches getBlockNumber for a few seconds; read the head directly so the freshly mined blocks count.
const confirmations = BigInt(await BASE.raw('eth_blockNumber')) - baseReceipt.blockNumber;
check(confirmations >= 12n, `delivery has ${confirmations} Base confirmations (solver requires 12)`);

// ── 6. OUT: claim with the Base tx hash once bidding closes ───────────────────────────────────────────────────
console.log('\n[6] OUT: claim(id, proof)');
const early = await expectRevert(RH.pub.simulateContract({ account: SOLVER.address, address: PINS.intents, abi: INTENTS_ABI, functionName: 'claim', args: [id, baseHash] }), 'NotYet');
check(early.matched, 'claim before bidEnds reverts NotYet', early.got);
const nowBeforeWarp = await chainNow();
await warp(intent.bidEnds - nowBeforeWarp + 1n);
const notSolver = await expectRevert(RH.pub.simulateContract({ account: USER.address, address: PINS.intents, abi: INTENTS_ABI, functionName: 'claim', args: [id, baseHash] }), 'NotBest');
check(notSolver.matched, 'claim by anyone but the winning solver reverts NotBest', notSolver.got);
const claimed = await send(SOLVER, { address: PINS.intents, abi: INTENTS_ABI, functionName: 'claim', args: [id, baseHash] });
intent = await readI('get', [id]);
check(Number(intent.state) === 2 && intent.claimedAt === claimed.timestamp, `intent is Claimed at ${intent.claimedAt}`);
const claimEv = parseEventLogs({ abi: INTENTS_ABI, logs: claimed.receipt.logs }).find((l) => l.eventName === 'Claimed');
check(claimEv?.args.proof === baseHash && claimEv?.args.bond === intent.bond, 'Claimed event carries the Base tx hash as proof');
check(mayBroadcastDelivery(intent, SOLVER.address, await chainNow(), 900) === false, 'mayBroadcastDelivery is false once Claimed (no double delivery)');

// ── 7. OUT: the frozen 30-minute challenge window, then settle ────────────────────────────────────────────────
console.log('\n[7] OUT: challenge window and settle');
const windowEnd = intent.claimedAt + intent.challengeWindow;
let tooSoon = await expectRevert(RH.pub.simulateContract({ account: SOLVER.address, address: PINS.intents, abi: INTENTS_ABI, functionName: 'settle', args: [id] }), 'NotYet');
check(tooSoon.matched, 'settle right after the claim reverts NotYet', tooSoon.got);
check(settlementReady(intent, await chainNow()) === false, 'settlementReady is false right after the claim');
// Pin the next block to exactly claimedAt + window and send a real settle: the contract's `<=` keeps it inside.
await RH.raw('evm_setNextBlockTimestamp', [toHex(windowEnd)]);
const boundaryHash = await RH.wallet(SOLVER).writeContract({ account: SOLVER, address: PINS.intents, abi: INTENTS_ABI, functionName: 'settle', args: [id], gas: 300_000n });
const boundaryReceipt = await RH.pub.waitForTransactionReceipt({ hash: boundaryHash });
const boundaryBlock = await RH.pub.getBlock({ blockNumber: boundaryReceipt.blockNumber });
check(BigInt(boundaryBlock.timestamp) === windowEnd && boundaryReceipt.status === 'reverted' && Number((await readI('get', [id])).state) === 2,
  'settle mined at exactly claimedAt + 1800 s reverts (window is inclusive); intent still Claimed', `block ts ${boundaryBlock.timestamp}, status ${boundaryReceipt.status}`);
check(settlementReady(intent, windowEnd) === false, 'settlementReady agrees: false at the boundary');
await warp(1n);
const afterWindow = await chainNow();
check(settlementReady(intent, afterWindow) === true, `settlementReady is true at ${afterWindow} (> claimedAt + window)`);

const credits = async () => ({
  solver: await readI('credit', [SOLVER.address]), user: await readI('credit', [USER.address]),
  treasury: await readI('credit', [PINS.treasury]), collector: await readI('credit', [PINS.collector]),
});
const cBefore = await credits();
const settled = await send(SOLVER, { address: PINS.intents, abi: INTENTS_ABI, functionName: 'settle', args: [id] });
intent = await readI('get', [id]);
const cAfter = await credits();
const d = Object.fromEntries(Object.keys(cAfter).map((k) => [k, cAfter[k] - cBefore[k]]));
const protocolFee = ask * BigInt(intent.protocolBps) / BPS;
const siteFee = ask * BigInt(intent.siteFeeBps) / BPS;
note(`credit deltas: solver ${fmt(d.solver)}, user ${fmt(d.user)}, treasury ${fmt(d.treasury)}, collector ${fmt(d.collector)}`);
check(Number(intent.state) === 3, 'intent is Settled');
check(d.solver === ask - protocolFee + intent.bond, `solver credit = ask − 50 bp protocol fee + actual bond = ${fmt(ask - protocolFee + intent.bond)}`, fmt(d.solver));
check(d.user === intent.escrowed - ask - siteFee, `user credit = escrowed − ask − 10 bp site fee = ${fmt(intent.escrowed - ask - siteFee)}`, fmt(d.user));
check(d.treasury === protocolFee && protocolFee > 0n, `treasury credit = protocol fee ${fmt(protocolFee)}`, fmt(d.treasury));
check(d.collector === siteFee && siteFee > 0n, `collector credit = site fee ${fmt(siteFee)}`, fmt(d.collector));
check(d.solver + d.user + d.treasury + d.collector === intent.escrowed + intent.bond, 'credits sum to escrowed + bond (nothing created or lost)');
const settleLogs = parseEventLogs({ abi: INTENTS_ABI, logs: settled.receipt.logs });
const settledEv = settleLogs.find((l) => l.eventName === 'Settled');
const siteEv = settleLogs.find((l) => l.eventName === 'SiteFeePaid');
check(settledEv?.args.paid === d.solver && settledEv?.args.fee === protocolFee && settledEv?.args.backToUser === d.user, 'Settled event matches the credit deltas');
check(siteEv?.args.amount === siteFee && same(siteEv?.args.recipient, PINS.collector), 'SiteFeePaid event credits the collector');
const twice = await expectRevert(RH.pub.simulateContract({ account: SOLVER.address, address: PINS.intents, abi: INTENTS_ABI, functionName: 'settle', args: [id] }), 'BadState');
check(twice.matched, 'settling again reverts BadState', twice.got);
const solverRep = await readI('rep', [SOLVER.address]);
check(Number(solverRep[0]) >= 1 && BigInt(solverRep[5]) >= ask, `solver rep: filled ${solverRep[0]}, volume ${fmt(solverRep[5])}`);

// ── 8. OUT: withdrawals arrive minus the 1 bp burn ────────────────────────────────────────────────────────────
console.log('\n[8] OUT: withdraw()');
for (const [label, account] of [['solver', SOLVER], ['user', USER]]) {
  const credit = await readI('credit', [account.address]);
  const before = await xmBal(account.address);
  await send(account, { address: PINS.intents, abi: INTENTS_ABI, functionName: 'withdraw', args: [] });
  const got = (await xmBal(account.address)) - before;
  check(got === credit - burn(credit) && (await readI('credit', [account.address])) === 0n,
    `${label} withdraw: credit ${fmt(credit)} → wallet +${fmt(got)} (1 bp burned), credit cleared`);
}
const nothing = await expectRevert(RH.pub.simulateContract({ account: USER.address, address: PINS.intents, abi: INTENTS_ABI, functionName: 'withdraw', args: [] }), 'Zero');
check(nothing.matched, 'withdraw with no credit reverts Zero', nothing.got);
const escrowEnd = await xmBal(PINS.intents);
check(escrowEnd - escrowBefore === protocolFee + siteFee, 'escrow now holds only the treasury and collector credits from this order', fmt(escrowEnd - escrowBefore));
const solverRoundTrip = (await xmBal(SOLVER.address)) - solverBefore;
check(solverRoundTrip === solverNetAtAsk(ask, iFee, requiredBond) || solverRoundTrip === solverNetAtAsk(ask, iFee, requiredBond) + 1n,
  `solver X Money round trip +${fmt(solverRoundTrip)} vs solverNetAtAsk ${fmt(solverNetAtAsk(ask, iFee, requiredBond))} (ceil-burn conservative by ≤1 wei)`);

// ── 9. IN (Asks): askWithSiteFee → taxed bid → accept → delivered → window → settle → withdraw ───────────────
console.log('\n[9] IN: XSwapAsksV2 lifecycle');
const askId = keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'uint256' }], ['xswap-v2-e2e-in', await chainNow()]));
const give = keccak256(encodeAbiParameters(
  [{ type: 'uint256' }, { type: 'uint8' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }],
  [8453n, 0, zeroAddress, BigInt(order.amount), SOLVER.address])); // seller delivers 0.001 Base ETH to the buyer
const askMemo = JSON.stringify({ amount: order.amount, dstChainId: 8453, kind: 'native', to: SOLVER.address });
const askDeadline = (await chainNow()) + 4n * 3600n;
const askTx = await send(USER, { address: PINS.asks, abi: ASKS_ABI, functionName: 'askWithSiteFee',
  args: [askId, IN_MIN_NET, askDeadline, give, askMemo, PINS.collector, 10, aTerms] });
let a = await readA('get', [askId]);
check(Number(a.state) === 0 && same(a.seller, USER.address) && a.minSellerNet === IN_MIN_NET, `ask is Open for the seller with minSellerNet ${fmt(IN_MIN_NET)}`);
check(a.floorPay === inFloor.grossBidFloor, `floorPay = ceil(net × 10000 / (10000 − 50 − 10 − 1)) = ${fmt(inFloor.grossBidFloor)}`, fmt(a.floorPay));
check(Number(a.siteFeeBps) === 10 && same(a.siteFeeRecipient, PINS.collector) && Number(a.protocolBps) === 50 && Number(a.challengeWindow) === 1800, 'ask freezes 10 bp site fee, 50 bp protocol, 1800 s window');
check(a.bidEnds === askTx.timestamp + BigInt(aBidding), `ask bidEnds = ask time + ${aBidding} s`);
const pay = a.floorPay;
const bondTarget = pay + pay * BigInt(a.openedBondBps) / BPS;
const maxWalletDebit = xswapV2GrossFor(bondTarget);
check(maxWalletDebit >= bondTarget && maxWalletDebit <= bondTarget + bondTarget / 5_000n + 2n, `buyer maxWalletDebit ${fmt(maxWalletDebit)} funds pay + ${Number(a.openedBondBps) / 100}% bond after burn, inside the bound`);
const lowBid = await expectRevert(RH.pub.simulateContract({ account: SOLVER.address, address: PINS.asks, abi: ASKS_ABI, functionName: 'bid', args: [askId, pay - 1n, maxWalletDebit] }), 'Low');
check(lowBid.matched, 'a bid under floorPay reverts Low', lowBid.got);
const buyerBefore = await xmBal(SOLVER.address);
const asksEscrowBefore = await xmBal(PINS.asks);
await send(SOLVER, { address: PINS.xmoney, abi: ERC20, functionName: 'approve', args: [PINS.asks, maxWalletDebit] });
const aBidTx = await send(SOLVER, { address: PINS.asks, abi: ASKS_ABI, functionName: 'bid', args: [askId, pay, maxWalletDebit] });
a = await readA('get', [askId]);
const asksReceived = (await xmBal(PINS.asks)) - asksEscrowBefore;
check(buyerBefore - (await xmBal(SOLVER.address)) === maxWalletDebit, `buyer wallet debited exactly maxWalletDebit ${fmt(maxWalletDebit)}`);
check(asksReceived === maxWalletDebit - burn(maxWalletDebit) && a.pay === pay && a.bond === asksReceived - pay,
  `asks escrow received ${fmt(asksReceived)}; pay ${fmt(a.pay)}, bond = received − pay = ${fmt(a.bond)}`);
check(Number(a.state) === 1 && same(a.buyer, SOLVER.address), 'ask is Bid by the buyer');
const aBidEv = parseEventLogs({ abi: ASKS_ABI, logs: aBidTx.receipt.logs }).find((l) => l.eventName === 'Bid');
check(aBidEv?.args.pay === pay && aBidEv?.args.bond === a.bond, 'Asks Bid event carries pay and actual bond');
const earlyDeliver = await expectRevert(RH.pub.simulateContract({ account: USER.address, address: PINS.asks, abi: ASKS_ABI, functionName: 'delivered', args: [askId, baseHash] }), 'NotYet');
check(earlyDeliver.matched, 'delivered before bidding closes reverts NotYet', earlyDeliver.got);
await send(USER, { address: PINS.asks, abi: ASKS_ABI, functionName: 'accept', args: [askId] });
a = await readA('get', [askId]);
check(a.bidEnds <= await chainNow(), 'seller accept() closes bidding early');
const deliveredTx = await send(USER, { address: PINS.asks, abi: ASKS_ABI, functionName: 'delivered', args: [askId, baseHash] });
a = await readA('get', [askId]);
check(Number(a.state) === 2 && a.deliveredAt === deliveredTx.timestamp, `ask is Delivered at ${a.deliveredAt}`);
const aTooSoon = await expectRevert(RH.pub.simulateContract({ account: USER.address, address: PINS.asks, abi: ASKS_ABI, functionName: 'settle', args: [askId] }), 'NotYet');
check(aTooSoon.matched, 'asks settle inside the window reverts NotYet', aTooSoon.got);
await warp(a.deliveredAt + a.challengeWindow + 1n - (await chainNow()));
const aCred = async () => ({ seller: await readA('credit', [USER.address]), buyer: await readA('credit', [SOLVER.address]),
  treasury: await readA('credit', [PINS.treasury]), collector: await readA('credit', [PINS.collector]) });
const acBefore = await aCred();
const aSettled = await send(SOLVER, { address: PINS.asks, abi: ASKS_ABI, functionName: 'settle', args: [askId] });
a = await readA('get', [askId]);
const acAfter = await aCred();
const ad = Object.fromEntries(Object.keys(acAfter).map((k) => [k, acAfter[k] - acBefore[k]]));
const aFeeAmt = pay * BigInt(a.protocolBps) / BPS;
const aSite = pay * BigInt(a.siteFeeBps) / BPS;
note(`asks credit deltas: seller ${fmt(ad.seller)}, buyer ${fmt(ad.buyer)}, treasury ${fmt(ad.treasury)}, collector ${fmt(ad.collector)}`);
check(Number(a.state) === 3, 'ask is Settled');
check(ad.seller === pay - aFeeAmt - aSite, `seller credit = pay − 50 bp − 10 bp = ${fmt(pay - aFeeAmt - aSite)}`, fmt(ad.seller));
check(ad.buyer === a.bond, `buyer credit = bond back ${fmt(a.bond)}`, fmt(ad.buyer));
check(ad.treasury === aFeeAmt && ad.collector === aSite, `treasury ${fmt(aFeeAmt)} and collector ${fmt(aSite)} credited`);
check(ad.seller + ad.buyer + ad.treasury + ad.collector === asksReceived, 'asks credits sum to what the escrow received');
const aSettledEv = parseEventLogs({ abi: ASKS_ABI, logs: aSettled.receipt.logs }).find((l) => l.eventName === 'Settled');
check(aSettledEv?.args.sellerPaid === ad.seller && aSettledEv?.args.fee === aFeeAmt, 'Asks Settled event matches the credit deltas');
for (const [label, account] of [['seller', USER], ['buyer', SOLVER]]) {
  const credit = await readA('credit', [account.address]);
  const before = await xmBal(account.address);
  await send(account, { address: PINS.asks, abi: ASKS_ABI, functionName: 'withdraw', args: [] });
  const got = (await xmBal(account.address)) - before;
  check(got === credit - burn(credit), `${label} asks withdraw: credit ${fmt(credit)} → wallet +${fmt(got)} (1 bp burned)`);
  if (label === 'seller') check(got >= IN_MIN_NET, `seller's net wallet receipt ${fmt(got)} ≥ signed minimum ${fmt(IN_MIN_NET)}`);
}

finish();
