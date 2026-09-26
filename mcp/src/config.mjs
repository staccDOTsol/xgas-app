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
export const XGAS_CHAIN_ID = DEPLOY.chainId;           // 466301 xGas Orbit L4

const PARENT_RPC = process.env.XGAS_PARENT_RPC || DEPLOY.parentRpcUrl;
const XGAS_RPC = process.env.XGAS_RPC || DEPLOY.publicRpcUrl;

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
export const L4 = DEPLOY.l4;

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
    const addr = info?.contracts?.nguLauncher || null;
    if (addr && addr !== ZERO) launcherCache.address = addr;
  } catch { /* offline host is not an answer about the chain; callers get null */ }
  return launcherCache.address;
}

// XSwap lives on the parent chain, not the L4: the escrow holds the L3 xMoney ERC-20 that the vault mints,
// so an intent opened through the connector is the same X Money a bridge exit hands you. Addresses are staccpad's, not
// the Orbit deploy's, so they come from env with the live defaults baked in.
export const XSWAP = {
  intents: process.env.XSWAP_INTENTS || DEPLOY.xswap?.intents || '0xf8B4F14eF9A08e334CA9fc026C6e5E9a79B39a35',
  asks: process.env.XSWAP_ASKS || DEPLOY.xswap?.asks || '0x0a33001A28A82d50ECC5c166dd5DCb8f5efaCd13',
  xmoney: process.env.XSWAP_XMONEY || L3.xMoney,
  chainId: PARENT_CHAIN_ID,
};
