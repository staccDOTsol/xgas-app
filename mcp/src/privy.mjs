// Privy-backed wallet for the connector.
//
// This is a deliberate exception to the rest of the connector, which holds no keys and
// only ever hands back unsigned transactions. An agent has no wallet to sign with, so
// here Privy holds the key material and signs on request. Anything that can call these
// tools can spend this wallet — that is the whole point, and the whole risk.
//
// Privy SIGNS; we BROADCAST. Their sendTransaction would broadcast through Privy's own
// RPC, which has never heard of chain 466301, so we take the signed payload and put it
// through our relay instead.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { clientFor, PARENT_CHAIN_ID, XGAS_CHAIN_ID } from './config.mjs';
import { actorKey, actorLabel, currentActor } from './actor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Node does not read .env on its own and this needs no dependency to do it.
(function loadEnv() {
  const f = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const DATA_DIR = process.env.XGAS_MCP_DATA
  || (fs.existsSync('/data') ? '/data' : path.join(process.env.HOME || '.', '.xgas-mcp'));
fs.mkdirSync(DATA_DIR, { recursive: true });
const WALLET_FILE = path.join(DATA_DIR, 'agent-wallet.json');

export const privyConfigured = () => !!(process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET);

export const NOT_CONFIGURED =
  'Privy is not configured. Set PRIVY_APP_ID and PRIVY_APP_SECRET (mcp/.env, or the environment) '
  + 'and this wallet wakes up. Without it the connector stays read-and-prepare only, which is the safe default.';

let _client = null;
async function client() {
  if (!privyConfigured()) throw new Error(NOT_CONFIGURED);
  if (!_client) {
    const { PrivyClient } = await import('@privy-io/server-auth');
    _client = new PrivyClient(process.env.PRIVY_APP_ID, process.env.PRIVY_APP_SECRET);
  }
  return _client;
}

/**
 * One file, one wallet per caller: `operator` for whoever runs the connector, `x:<id>` for each person
 * signed in with X. The old single-wallet file is read as the operator's, so nothing is orphaned.
 */
function book() {
  try {
    const raw = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
    return raw && raw.wallets ? raw : { wallets: raw && raw.id ? { operator: raw } : {} };
  } catch { return { wallets: {} }; }
}
function put(key, rec) {
  const b = book();
  b.wallets[key] = rec;
  fs.writeFileSync(WALLET_FILE, JSON.stringify(b, null, 2), { mode: 0o600 });
  return rec;
}

/**
 * The wallet the current caller signs as. A signed-in person gets their own; the operator gets the one
 * pinned by PRIVY_WALLET_ID, or the one in the local store.
 */
export async function agentWallet() {
  const a = currentActor();
  const key = actorKey(a);
  const rec = book().wallets[key];
  if (rec) return { ...rec, source: a.kind === 'user' ? 'yours, from your X sign-in' : 'local store', owner: key };
  if (a.kind !== 'user' && process.env.PRIVY_WALLET_ID && process.env.PRIVY_WALLET_ADDRESS) {
    return { id: process.env.PRIVY_WALLET_ID, address: process.env.PRIVY_WALLET_ADDRESS, source: 'environment', owner: 'operator' };
  }
  return null;
}

export async function createAgentWallet() {
  const existing = await agentWallet();
  if (existing) return { ...existing, created: false };
  const a = currentActor();
  const p = await client();
  const w = await p.walletApi.create({ chainType: 'ethereum' });
  const rec = put(actorKey(a), { id: w.id, address: w.address, owner: actorKey(a), label: actorLabel(a), createdAt: new Date().toISOString() });
  return { ...rec, source: a.kind === 'user' ? 'yours, from your X sign-in' : 'local store', created: true };
}

/**
 * Fill in everything the chain needs, have Privy sign it, and return the raw payload.
 * Gas and fees are estimated against the target chain so a doomed transaction fails
 * here rather than after it has been signed and broadcast.
 */
export async function signStep({ chainId, to, data, value }) {
  const wallet = await agentWallet();
  if (!wallet) throw new Error('No wallet yet for this caller. Call wallet_create first.');
  const cid = Number(chainId);
  if (cid !== PARENT_CHAIN_ID && cid !== XGAS_CHAIN_ID) throw new Error(`Refusing to sign for unknown chain ${cid}.`);
  const pub = clientFor(cid);
  const val = BigInt(value ?? 0n);

  const [nonce, fees] = await Promise.all([
    pub.getTransactionCount({ address: wallet.address, blockTag: 'pending' }),
    pub.estimateFeesPerGas(),
  ]);
  let gas;
  try {
    gas = await pub.estimateGas({ account: wallet.address, to, data, value: val });
    gas = (gas * 125n) / 100n;
  } catch (e) {
    throw new Error(`Gas estimation reverted, so this would fail on chain: ${e.shortMessage || e.message}`);
  }

  const maxFeePerGas = ((fees.maxFeePerGas ?? 1_000_000_000n) * 125n) / 100n;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 1n;
  const hex = (v) => `0x${BigInt(v).toString(16)}`;

  const p = await client();
  const { signedTransaction } = await p.walletApi.ethereum.signTransaction({
    walletId: wallet.id,
    transaction: {
      from: wallet.address,
      to,
      data: data || '0x',
      value: hex(val),
      nonce: hex(nonce),
      chainId: hex(cid),
      gasLimit: hex(gas),
      maxFeePerGas: hex(maxFeePerGas),
      maxPriorityFeePerGas: hex(maxPriorityFeePerGas),
      type: 2,
    },
  });
  return { signedTransaction, wallet, gas, maxFeePerGas, nonce };
}
