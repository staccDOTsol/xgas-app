import fs from 'fs';
import path from 'path';
import { clientFor, rpcFor } from './config.mjs';

const DATA_DIR = process.env.XGAS_MCP_DATA
  || (fs.existsSync('/data') ? '/data' : path.join(process.env.HOME || '.', '.xgas-mcp'));
fs.mkdirSync(DATA_DIR, { recursive: true });
const FILE = path.join(DATA_DIR, 'submits.json');

let store = {};
try { if (fs.existsSync(FILE)) store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { store = {}; }
const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(store)); } catch { /* best effort */ } };

export function recorded(key) {
  return key ? store[key] || null : null;
}

/**
 * Broadcast an already-signed raw transaction. The connector holds no keys; this is
 * a relay. The idempotency key makes a retry return the first hash instead of
 * sending a second transaction.
 */
export async function submitRaw({ chainId, signedTx, idempotencyKey, kind }) {
  if (!/^0x[0-9a-fA-F]+$/.test(String(signedTx || ''))) {
    throw new Error('signed_tx must be a 0x-prefixed raw signed transaction (the output of your wallet, not a tx hash)');
  }
  const prior = recorded(idempotencyKey);
  if (prior) return { ...prior, replayed: true };

  const client = clientFor(chainId);
  const hash = await client.sendRawTransaction({ serializedTransaction: signedTx });
  const rec = { hash, chainId: Number(chainId), kind, rpc: rpcFor(chainId), at: new Date().toISOString() };
  if (idempotencyKey) { store[idempotencyKey] = rec; save(); }
  return { ...rec, replayed: false };
}

/** Submit several signed transactions in order (approve then call), stopping on the first failure. */
export async function submitBatch({ chainId, signedTxs, idempotencyKey, kind, waitBetween = true }) {
  const prior = recorded(idempotencyKey);
  if (prior) return { ...prior, replayed: true };

  const client = clientFor(chainId);
  const hashes = [];
  for (const raw of signedTxs) {
    const one = await submitRaw({ chainId, signedTx: raw, kind });
    hashes.push(one.hash);
    if (waitBetween) {
      const rc = await client.waitForTransactionReceipt({ hash: one.hash, timeout: 120_000 });
      if (rc.status !== 'success') throw new Error(`Transaction ${one.hash} reverted; later steps not sent.`);
    }
  }
  const rec = { hashes, hash: hashes[hashes.length - 1], chainId: Number(chainId), kind, at: new Date().toISOString() };
  if (idempotencyKey) { store[idempotencyKey] = rec; save(); }
  return { ...rec, replayed: false };
}
