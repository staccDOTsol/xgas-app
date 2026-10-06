// Every address in this connector comes from the deployment file the Orbit deploy script writes.
// Nothing is hard-coded here that isn't also on chain.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPublicClient, defineChain, http } from 'viem';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In the repo the live file is the app's; published to npm, the package carries its own copy,
// refreshed on every release. Either way the addresses come from a deployment, never from here.
const CANDIDATES = [
  process.env.XGAS_DEPLOYMENT,
  path.join(__dirname, '..', '..', 'src', 'contracts', 'l4-deployment.json'),
  path.join(__dirname, '..', 'deployment.json'),
].filter(Boolean);

const DEPLOY_FILE = CANDIDATES.find((f) => fs.existsSync(f));
if (!DEPLOY_FILE) throw new Error(`No deployment file found. Looked at: ${CANDIDATES.join(', ')}. Set XGAS_DEPLOYMENT.`);

export const DEPLOY = JSON.parse(fs.readFileSync(DEPLOY_FILE, 'utf8'));

export const PARENT_CHAIN_ID = DEPLOY.parentChainId;   // 4663  Robinhood Chain
export const XGAS_CHAIN_ID = DEPLOY.chainId;           // 466302 xGas Orbit L4 (rollup mode)

const PARENT_RPC = process.env.XGAS_PARENT_RPC || DEPLOY.parentRpcUrl;
const XGAS_RPC = process.env.XGAS_RPC || DEPLOY.publicRpcUrl || DEPLOY.rpcUrl || DEPLOY.sequencerRpcUrl;

// The host that runs the Outbox executor ("claim for me") and serves /api/l4-info.
export const XGAS_API = (process.env.XGAS_API || 'https://xgas.dev').replace(/\/+$/, '');

export const parentChain = defineChain({
  id: PARENT_CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [PARENT_RPC] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
});

export const xgasChain = defineChain({
  id: XGAS_CHAIN_ID,
  name: 'xGas Orbit L4',
  nativeCurrency: { name: 'X Money Gas', symbol: 'xMoney', decimals: 18 },
  rpcUrls: { default: { http: [XGAS_RPC] } },
});

export const parent = createPublicClient({ chain: parentChain, transport: http(PARENT_RPC, { timeout: 20_000 }) });
export const xgas = createPublicClient({ chain: xgasChain, transport: http(XGAS_RPC, { timeout: 20_000 }) });

export const clientFor = (chainId) => (Number(chainId) === XGAS_CHAIN_ID ? xgas : parent);
export const rpcFor = (chainId) => (Number(chainId) === XGAS_CHAIN_ID ? XGAS_RPC : PARENT_RPC);

export const L3 = DEPLOY.l3;
export const L4 = DEPLOY.l4 || {};

// Rollup roles. 466302 lists every validator key and a Safe as the fast confirmer; the 466301 file had a
// single `validator`. Read either shape so an older deployment file still loads.
export const VALIDATORS = Array.isArray(DEPLOY.validators) ? DEPLOY.validators
  : DEPLOY.validator ? [DEPLOY.validator] : [];
export const FAST_CONFIRM_SAFE = DEPLOY.fastConfirmSafe || L3.fastConfirmSafe || null;
export const FEE_TOKEN_PRICER = DEPLOY.feeTokenPricer || L3.feeTokenPricer || null;
// The retired chain, kept so old withdrawals can still be tracked and claimed. Null when the file has none.
export const LEGACY = DEPLOY.legacy466301 || null;
// L4 app contracts not (re)deployed on this chain yet. Tools that need one say so instead of calling address null.
export const L4_MISSING = Object.entries(L4)
  .filter(([, v]) => v === null || v === '' || v === '0x0000000000000000000000000000000000000000')
  .map(([k]) => k);
export function l4Address(name) {
  const a = L4[name];
  if (!a || a === '0x0000000000000000000000000000000000000000') {
    throw new Error(`${name} is not deployed on xGas ${XGAS_CHAIN_ID} yet (l4.${name} is empty in the deployment file), so this tool has nothing to call.`);
  }
  return a;
}

export const DEAD = '0x000000000000000000000000000000000000dEaD';
export const ZERO = '0x0000000000000000000000000000000000000000';

// Fee constants, mirrored from XMoney.sol / XMoneyEscrow.sol / NguToken.sol. Burn and rake are 1 bp;
// the L4 fee paths (escrow, FOMO, router, NGU curves from the current launcher) add a 2 bp XGAS.DEV buyback.
export const BURN_BPS = 1n;
export const FANOUT_RAKE_BPS = 1n;
export const BUYBACK_BPS = 2n;
// XGAS.DEV on Robinhood: XgasDevBuyback buys it with the buyback leg and burns it.
export const XGAS_DEV = '0x006D2D9e65f847e8B5f5053C9eb3a7824ec7dFa3';
export const USDG_DECIMALS = 6;            // SCALE_FACTOR 1e12 in XMoney.sol fixes this at 6
export const SCALE_FACTOR = 10n ** 12n;    // USDG 6dp -> xMoney 18dp
export const TRADE_TIMEOUT_S = 15 * 60;

// NguLauncher isn't in the committed deployment yet; the host publishes it at /api/l4-info
// the moment it is. Resolve lazily, cache briefly, and never pretend it exists.
let launcherCache = { address: process.env.XGAS_NGU_LAUNCHER || L4.nguLauncher || null, at: 0 };
export async function nguLauncher() {
  if (launcherCache.address) return launcherCache.address;
  if (Date.now() - launcherCache.at < 60_000) return null;
  launcherCache.at = Date.now();
  try {
    const res = await fetch(`${XGAS_API}/api/l4-info`, { signal: AbortSignal.timeout(8000) });
    const info = await res.json();
    // The host may still describe another chain (say, mid-migration). Only take an address it gives for
    // this chain, and only once there is code at it here: value sent to an empty address is gone.
    const infoChain = info?.chainId ?? info?.chain?.chainId;
    if (infoChain != null && Number(infoChain) !== XGAS_CHAIN_ID) return null;
    const addr = info?.contracts?.nguLauncher || null;
    if (addr && addr !== ZERO) {
      const code = await xgas.getCode({ address: addr });
      if (code && code !== '0x') launcherCache.address = addr;
    }
  } catch { /* offline host is not an answer about the chain; callers get null */ }
  return launcherCache.address;
}

// XSwap lives on the parent chain, not the L4: the escrow holds the L3 xMoney ERC-20 that the vault mints,
// so an intent opened through the connector is the same X Money a bridge exit hands you.
//
// The v1 contracts cannot settle a dispute. Their deploy script (nft-range script/DeployXSwap.s.sol) read
// `vm.envOr("PROTOCOL_OWNER", msg.sender)` BEFORE `vm.startBroadcast(key)`, with PROTOCOL_OWNER unset and no --sender,
// so msg.sender was forge-std's DEFAULT_SENDER and that became owner(). Nobody holds a key for it: resolve(),
// setParams() and transferOwnership() can never be called there. Those addresses stay readable (status, reputation,
// refunds, cancels, withdrawals) and are never switched on for new swaps, whatever XSWAP_ENABLED says.
// The redeploy (contracts/script/DeployXSwap.s.sol) prints an "xswap" block for src/contracts/l4-deployment.json:
//   { "intents": "0x…", "asks": "0x…", "owner": "0x…", "enabled": false }
// Addresses come from env first, then that block, then the v1 defaults. New swaps need XSWAP_ENABLED=1 (env, per host)
// or "enabled": true in the block (everyone on that deployment file), and never run against the v1 addresses.
export const FORGE_DEFAULT_SENDER = '0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38';
export const XSWAP_V1 = {
  intents: '0xf8B4F14eF9A08e334CA9fc026C6e5E9a79B39a35',
  asks: '0x0a33001A28A82d50ECC5c166dd5DCb8f5efaCd13',
  firstIntents: '0x3d4428cB247792e9183332c95A6A3C37b89E8301', // an earlier run of the same script, same owner
};
const XSWAP_V1_SET = new Set(Object.values(XSWAP_V1).map((a) => a.toLowerCase()));
export const isXswapV1 = (a) => XSWAP_V1_SET.has(String(a || '').toLowerCase());
const XSWAP_FILE = DEPLOY.xswap || {};
// Both the current fee-free escrows and the earlier keyless-owner escrows remain readable for exits only.
export const XSWAP_LEGACY = {
  intents: ['0x5D78651C728c15b715d5f6727bE40C1c3a02B53d', XSWAP_V1.intents, XSWAP_V1.firstIntents],
  asks: ['0xa999BC26e184b83CECb3cF5b9640C438C5aDc8a3', XSWAP_V1.asks],
};
const XSWAP_LEGACY_SET = new Set([...XSWAP_LEGACY.intents, ...XSWAP_LEGACY.asks].map((a) => a.toLowerCase()));
export const isXswapLegacy = (a) => XSWAP_LEGACY_SET.has(String(a || '').toLowerCase());
// New V2 contracts are independent of legacy deployment.json and XSWAP_* environment overrides.
// New funding and claims opened 2026-10-06: runtime pins verified, the V2 solver (staccpad xswap-solver-v2.mjs)
// reviewed and funded, and the fork lifecycle (mcp/scripts/xswap-v2-e2e.mjs) run against the deployed bytecode.
export const XSWAP_V2 = {
  collector: '0x5a5e18e5003d75f9705252b2c3436c1b61e6d33e',
  collectorRuntimeHash: '0xb0eb9674d60fbfe03eb1f26c2453ee2446433812ff9e0690fd7db8c89032633b',
  intents: '0xdf6398ff5a694a03d85a614812490143c4e5d238',
  intentsRuntimeHash: '0xd5f3ec158647ae483ed942998d9f164aa0e26b98a1a2e29a4a0b6b3bd9a354eb',
  asks: '0x2f507a18043002d8f5d6d3022efd6265be7a87fc',
  asksRuntimeHash: '0x998aca274594b99b203562e5c0b9a46aa6f5794b3bfbbee762afdb125bf1f557',
  expectedOwner: '0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158',
  treasury: '0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8',
  enabled: true,
};
const xswapIntents = process.env.XSWAP_INTENTS || XSWAP_FILE.intents || XSWAP_V1.intents;
const xswapAsks = process.env.XSWAP_ASKS || XSWAP_FILE.asks || XSWAP_V1.asks;
const xswapEnv = String(process.env.XSWAP_ENABLED ?? '').trim();
const xswapFlag = xswapEnv ? /^(1|true|yes|on)$/i.test(xswapEnv) : XSWAP_FILE.enabled === true;
const xswapIsV1 = isXswapV1(xswapIntents) || isXswapV1(xswapAsks);
const xswapAddrsOk = [xswapIntents, xswapAsks].every((a) => /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/.test(a));
/** An owner a deployment can name: a real address, not zero, not forge-std's keyless default sender. */
export const validXswapOwner = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/.test(a)
  && a.toLowerCase() !== FORGE_DEFAULT_SENDER.toLowerCase();
const xswapExpectedOwner = process.env.XSWAP_OWNER || XSWAP_FILE.owner || null;
export const XSWAP = {
  intents: xswapIntents,
  asks: xswapAsks,
  xmoney: process.env.XSWAP_XMONEY || L3.xMoney,
  chainId: PARENT_CHAIN_ID,
  // The owner the deployment says it set. tools/xswap.mjs checks owner() on chain against it before any new swap.
  expectedOwner: xswapExpectedOwner,
  source: process.env.XSWAP_INTENTS || process.env.XSWAP_ASKS ? 'env' : XSWAP_FILE.intents ? 'deployment file' : 'built-in v1 defaults',
  v1: xswapIsV1,
  flag: xswapFlag,
  addressesOk: xswapAddrsOk,
  // New swaps (open, ask, bid, claim, accept, delivered) only when switched on, on real addresses, never on v1, and
  // only with an expected owner to check owner() against. The live owner() check in tools/xswap.mjs runs on top of this.
  enabled: xswapFlag && !xswapIsV1 && !isXswapLegacy(xswapIntents) && !isXswapLegacy(xswapAsks)
    && xswapAddrsOk && validXswapOwner(xswapExpectedOwner),
};

// Until the XMoney vault's timelocked setBridgeSystem points it at this chain's inbox, deposits reach xGas through
// EarlyDepositor (USDG -> vault.enterRollupToL2 -> this chain's inbox, one retryable to the named recipient).
// The deployment file names it; the constant is the live helper on Robinhood, in case an older file lacks the key.
export const EARLY_DEPOSITOR = L3.earlyDepositor || '0x36e52831ba473e9374bad7cc22ed942a99b4d431';

/**
 * Are the configured RPCs the chains this deployment describes? A stale XGAS_RPC (say, the retired 466301
 * sequencer) would have every write tool prepare against the wrong chain. Checked once at start, logged loudly,
 * and consulted by every write tool. A mismatch is final for the process; an unreachable RPC is re-checked
 * after a short pause so a transient outage does not lock writes forever.
 */
let chainCheck = { at: 0, promise: null, result: null };
const RECHECK_MS = 15_000;
export function checkChains() {
  const r = chainCheck.result;
  if (r && (r.ok || r.mismatch)) return Promise.resolve(r);
  if (chainCheck.promise && Date.now() - chainCheck.at < RECHECK_MS) return chainCheck.promise;
  chainCheck.at = Date.now();
  chainCheck.promise = (async () => {
    const read = (client) => client.getChainId().then((id) => ({ id }), (e) => ({ error: e.shortMessage || e.message }));
    const [l4, par] = await Promise.all([read(xgas), read(parent)]);
    const problems = [];
    if (l4.error) problems.push(`could not read eth_chainId from the xGas RPC ${XGAS_RPC} (${l4.error})`);
    else if (l4.id !== XGAS_CHAIN_ID) problems.push(`the xGas RPC ${XGAS_RPC} is chain ${l4.id}, but the deployment is chain ${XGAS_CHAIN_ID}`);
    if (par.error) problems.push(`could not read eth_chainId from the parent RPC ${PARENT_RPC} (${par.error})`);
    else if (par.id !== PARENT_CHAIN_ID) problems.push(`the parent RPC ${PARENT_RPC} is chain ${par.id}, but the deployment's parent is chain ${PARENT_CHAIN_ID}`);
    const mismatch = (!l4.error && l4.id !== XGAS_CHAIN_ID) || (!par.error && par.id !== PARENT_CHAIN_ID);
    const result = { ok: problems.length === 0, mismatch, l4ChainId: l4.id ?? null, parentChainId: par.id ?? null, problems };
    chainCheck.result = result;
    if (result.ok) console.error(`[xgas-mcp] RPC check: xGas ${XGAS_RPC} is chain ${l4.id}, parent ${PARENT_RPC} is chain ${par.id}.`);
    else console.error(`[xgas-mcp] !!! RPC CHECK FAILED: ${problems.join('; ')}. Write tools will refuse until this is fixed (set XGAS_RPC / XGAS_PARENT_RPC or XGAS_DEPLOYMENT). !!!`);
    return result;
  })();
  return chainCheck.promise;
}

/** Throws a clear error unless both RPCs are confirmed to be the deployment's chains. */
export async function assertChains(toolName) {
  const r = await checkChains();
  if (r.ok) return;
  throw new Error(`${toolName} refused: ${r.problems.join('; ')}. Nothing was prepared or sent. Fix XGAS_RPC / XGAS_PARENT_RPC (or XGAS_DEPLOYMENT) and restart.`);
}
