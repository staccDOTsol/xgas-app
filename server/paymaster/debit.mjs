// The debit worker. Watches XgasDevPaymaster's postOp events on the L4 and, for each userOpHash exactly once,
// burns the payer's XGAS.DEV on Robinhood: XGAS.DEV.transferFrom(payer, 0x...dEaD, charge) from the debit wallet.
//
// Exactly once:
//   - ledger.recordEvent is idempotent by userOpHash, so re-scanning a block range never adds a second debit;
//   - the transaction is signed locally and persisted (state 'sending', raw + hash + nonce) BEFORE it is broadcast;
//   - a 'sending' debit is only ever re-signed after every hash it already has is known not mined AND the nonce it
//     used has been consumed on chain (so the old transaction can never land); otherwise the same raw is rebroadcast.
import { encodeFunctionData, getAddress, keccak256, parseAbi, parseAbiItem } from 'viem';
import { chargeFor } from './sign.mjs';

export const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD';
export const CHARGED_EVENT = parseAbiItem('event XgasDevGasCharged(bytes32 indexed userOpHash, address indexed sender, address indexed robinhoodPayer, uint256 actualGasCost, uint256 actualUserOpFeePerGas, uint256 maxXgasDevCharge, bool succeeded)');
export const USER_OP_EVENT = parseAbiItem('event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)');
export const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
]);
const LOG_CHUNK = 5_000n;
const MAX_CHUNKS_PER_TICK = 40;
const MAX_SENDS_PER_TICK = 10;
const REBROADCAST_AFTER_MS = 30_000;

function errText(e) { return String(e?.shortMessage || e?.details || e?.message || e).slice(0, 300); }
const isNonceTooLow = (e) => /nonce too low|nonce has already been used|already known|known transaction|replacement transaction underpriced/i.test(errText(e));
const isNotFound = (e) => e?.name === 'TransactionReceiptNotFoundError' || /could not be found|not found/i.test(errText(e));

export function unpaidBackoffMs(attempts) {
  return Math.min(3_600_000, 60_000 * 2 ** Math.max(0, Math.min(attempts, 10) - 1));
}

/**
 * @param entryPoint    EntryPoint v0.7 on the L4: its UserOperationEvent carries the final gas cost.
 * @param rateFallback  async () => rateWad, used only for an event whose quote is missing from the ledger.
 */
export function createDebitWorker({ ledger, l4, rh, account, chainId = 4663, paymaster, entryPoint, xgasDev, startBlock = 0n, rateFallback = null, log = console, now = () => Date.now() }) {
  const pm = getAddress(paymaster);
  const ep = entryPoint ? getAddress(entryPoint) : null;
  const token = getAddress(xgasDev);
  const status = { lastScanAt: null, lastScanError: null, lastSettleAt: null, lastSettleError: null, head: null };
  let running = false;

  async function scan() {
    const head = await l4.getBlockNumber();
    status.head = Number(head);
    let from = ledger.cursor == null ? BigInt(startBlock) : BigInt(ledger.cursor) + 1n;
    let chunks = 0; let added = 0;
    while (from <= head && chunks < MAX_CHUNKS_PER_TICK) {
      const to = from + LOG_CHUNK - 1n < head ? from + LOG_CHUNK - 1n : head;
      const logs = await l4.getLogs({ address: pm, event: CHARGED_EVENT, fromBlock: from, toBlock: to, strict: true });
      // The EntryPoint's own event for the same ops: its actualGasCost includes postOp gas and the unused-gas penalty.
      const finalCost = new Map();
      if (logs.length && ep) {
        const uo = await l4.getLogs({ address: ep, event: USER_OP_EVENT, args: { paymaster: pm }, fromBlock: from, toBlock: to, strict: true });
        for (const u of uo) if (getAddress(u.address) === ep && !u.removed) finalCost.set(u.args.userOpHash.toLowerCase(), u.args.actualGasCost);
      }
      for (const lg of logs) {
        // getLogs filters by address already; check again so a misbehaving RPC cannot inject someone else's event.
        if (getAddress(lg.address) !== pm || lg.removed) continue;
        const a = lg.args;
        const key = a.userOpHash.toLowerCase();
        if (ledger.debit(key)) continue;
        const actualGasCost = finalCost.get(key) ?? a.actualGasCost;
        let rate = ledger.quote(key)?.rateWad; let rateSource = 'quote';
        if (!rate) {
          rateSource = 'current';
          rate = rateFallback ? await rateFallback().catch(() => null) : null;
          // No quote and no live rate: fall back to the ceiling the payer signed over, never more.
          if (!rate) { rateSource = 'max'; }
          log.warn?.(`[paymaster] no ledger quote for ${key}; charging at the ${rateSource} rate`);
        }
        const charge = rateSource === 'max' ? BigInt(a.maxXgasDevCharge) : chargeFor({ actualGasCost, rateWad: rate, maxXgasDevCharge: a.maxXgasDevCharge });
        const r = ledger.recordEvent({ ...a, actualGasCost, success: a.succeeded, charge, rateSource, transactionHash: lg.transactionHash, blockNumber: lg.blockNumber });
        if (r.created) added++;
      }
      ledger.setCursor(to);
      ledger.save();
      from = to + 1n; chunks++;
    }
    status.lastScanAt = new Date(now()).toISOString(); status.lastScanError = null;
    return { added, cursor: ledger.cursor, head: Number(head) };
  }

  async function receiptOf(hash) {
    try { return await rh.getTransactionReceipt({ hash }); } catch (e) { if (isNotFound(e)) return null; throw e; }
  }

  /** Settle one debit. Returns what happened, for tests and logs. */
  async function settle(d) {
    const charge = BigInt(d.charge);
    if (d.state === 'paid') return 'already-paid';
    if (charge === 0n) { ledger.patchDebit(d.userOpHash, { state: 'paid' }); ledger.save(); return 'zero'; }

    // 1. anything we already signed for this debit: did one land?
    for (const tx of d.txs) {
      const rc = await receiptOf(tx.hash);
      if (!rc) continue;
      if (rc.status === 'success') {
        ledger.patchDebit(d.userOpHash, { state: 'paid', paidTx: tx.hash, lastError: null });
        ledger.save();
        return 'paid';
      }
      tx.reverted = true;
    }
    if (d.state === 'sending') {
      const last = d.txs[d.txs.length - 1];
      if (last && !last.reverted) {
        const confirmedNonce = await rh.getTransactionCount({ address: account.address, blockTag: 'latest' });
        if (confirmedNonce <= last.nonce) {
          // Not mined and its nonce is still free: it may be in a mempool or lost. Rebroadcasting the same bytes
          // is always safe.
          if (now() - last.at >= REBROADCAST_AFTER_MS) {
            try { await rh.sendRawTransaction({ serializedTransaction: last.raw }); } catch {}
            last.at = now(); ledger.save();
          }
          return 'waiting';
        }
        // The nonce was consumed. Re-check our hashes once more (it may have just landed) before giving up on it.
        const rc = await receiptOf(last.hash);
        if (rc?.status === 'success') {
          ledger.patchDebit(d.userOpHash, { state: 'paid', paidTx: last.hash, lastError: null });
          ledger.save();
          return 'paid';
        }
        last.dropped = true;
      }
      ledger.patchDebit(d.userOpHash, { state: 'pending' });
      ledger.save();
    }

    // 2. can the payer still pay?
    const payer = getAddress(d.payer);
    const [bal, allowance] = await Promise.all([
      rh.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [payer] }),
      rh.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [payer, account.address] }),
    ]);
    if (bal < charge || allowance < charge) {
      const attempts = (d.attempts || 0) + 1;
      ledger.patchDebit(d.userOpHash, {
        state: 'unpaid', attempts, nextAttemptAt: now() + unpaidBackoffMs(attempts),
        lastError: bal < charge ? 'XGAS.DEV balance too low' : 'XGAS.DEV allowance too low',
      });
      ledger.save();
      return 'unpaid';
    }

    // 3. sign, persist, broadcast.
    const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'transferFrom', args: [payer, BURN_ADDRESS, charge] });
    let gas, fees, nonce;
    try {
      gas = await rh.estimateGas({ account: account.address, to: token, data });
    } catch (e) {
      const attempts = (d.attempts || 0) + 1;
      ledger.patchDebit(d.userOpHash, { state: 'unpaid', attempts, nextAttemptAt: now() + unpaidBackoffMs(attempts), lastError: `transferFrom would revert: ${errText(e)}` });
      ledger.save();
      return 'unpaid';
    }
    fees = await rh.estimateFeesPerGas();
    nonce = await rh.getTransactionCount({ address: account.address, blockTag: 'pending' });
    const raw = await account.signTransaction({
      chainId, type: 'eip1559', to: token, data, value: 0n, nonce,
      gas: (gas * 13n) / 10n, maxFeePerGas: fees.maxFeePerGas * 2n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n,
    });
    const hash = keccak256(raw);
    d.txs.push({ hash, raw, nonce, at: now() });
    ledger.patchDebit(d.userOpHash, { state: 'sending', attempts: (d.attempts || 0) + 1 });
    ledger.save();
    try {
      await rh.sendRawTransaction({ serializedTransaction: raw });
    } catch (e) {
      if (!isNonceTooLow(e)) {
        // Could be a timeout after the node accepted it: stay 'sending'; the next tick reconciles by hash and nonce.
        ledger.patchDebit(d.userOpHash, { lastError: `broadcast: ${errText(e)}` });
        ledger.save();
      }
      return 'sent-uncertain';
    }
    const rc = await rh.waitForTransactionReceipt({ hash, timeout: 45_000 }).catch(() => null);
    if (rc?.status === 'success') {
      ledger.patchDebit(d.userOpHash, { state: 'paid', paidTx: hash, lastError: null });
      ledger.save();
      return 'paid';
    }
    if (rc && rc.status !== 'success') {
      d.txs[d.txs.length - 1].reverted = true;
      const attempts = d.attempts || 1;
      ledger.patchDebit(d.userOpHash, { state: 'unpaid', nextAttemptAt: now() + unpaidBackoffMs(attempts), lastError: 'transferFrom reverted' });
      ledger.save();
      return 'unpaid';
    }
    return 'sent';
  }

  async function settleDue() {
    let n = 0;
    for (const d of ledger.due()) {
      if (n >= MAX_SENDS_PER_TICK) break;
      try { const r = await settle(d); if (r !== 'waiting') n++; } catch (e) {
        status.lastSettleError = errText(e);
        log.warn?.(`[paymaster] debit ${d.userOpHash} failed this round: ${errText(e)}`);
      }
    }
    status.lastSettleAt = new Date(now()).toISOString();
    return n;
  }

  async function tick() {
    if (running) return { skipped: true };
    running = true;
    try {
      let scanned = null;
      try { scanned = await scan(); } catch (e) { status.lastScanError = errText(e); log.warn?.(`[paymaster] L4 log scan failed: ${errText(e)}`); }
      const settled = await settleDue();
      ledger.prune(); ledger.save();
      return { scanned, settled };
    } finally { running = false; }
  }

  // Short tick: between an op landing and its transferFrom is the window in which a payer can revoke the allowance.
  // The sponsorship caps bound what that window can cost; a short tick keeps honest settlement quick.
  let timer = null;
  function start(intervalMs = 2_000) {
    if (timer) return;
    const loop = async () => { try { await tick(); } catch (e) { log.warn?.(`[paymaster] worker: ${errText(e)}`); } timer = setTimeout(loop, intervalMs); timer.unref?.(); };
    timer = setTimeout(loop, 1_000); timer.unref?.();
  }
  function stop() { if (timer) clearTimeout(timer); timer = null; }

  return { scan, settle, settleDue, tick, start, stop, status };
}
