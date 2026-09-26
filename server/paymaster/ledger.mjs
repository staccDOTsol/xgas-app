// The paymaster ledger: every sponsorship the signer handed out (quotes) and every charge owed on Robinhood
// (debits), keyed by userOpHash, in one JSON file on the /data volume. Writes are atomic (temp file, fsync, rename,
// fsync dir), so a crash leaves the old file or the new one. A userOpHash is debited at most once: recordEvent is
// idempotent, and the debit worker persists the signed transaction before it broadcasts.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const DEBIT_STATES = ['pending', 'sending', 'paid', 'unpaid'];
const DAY_MS = 86_400_000;
const QUOTE_KEEP_MS = 2 * DAY_MS;

export function utcDay(ms) { return new Date(ms).toISOString().slice(0, 10); }
const lc = (a) => String(a).toLowerCase();

export function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeSync(fd, JSON.stringify(obj)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  try { const d = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch {}
}

export class Ledger {
  constructor({ file, now = () => Date.now() }) {
    this.file = file; this.now = now;
    this.data = { v: 1, cursor: null, quotes: {}, debits: {} };
    if (file && fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!j || j.v !== 1 || typeof j.quotes !== 'object' || typeof j.debits !== 'object') throw new Error(`${file} is not a v1 paymaster ledger`);
      this.data = j;
    }
  }
  save() { if (this.file) writeJsonAtomic(this.file, this.data); }

  get cursor() { return this.data.cursor; }
  setCursor(block) { this.data.cursor = Number(block); }

  // --- quotes ---------------------------------------------------------------------------------------------
  /** Record a signed sponsorship. Same userOpHash again = same record (a retried pm_getPaymasterData). */
  upsertQuote(q) {
    const key = lc(q.userOpHash);
    const prev = this.data.quotes[key];
    if (prev) return { created: false, quote: prev };
    const t = this.now();
    const rec = {
      userOpHash: key, payer: lc(q.payer), sender: lc(q.sender),
      maxCost: String(q.maxCost), maxCharge: String(q.maxCharge), rateWad: String(q.rateWad ?? ''),
      validUntil: Number(q.validUntil), createdAt: t, day: utcDay(t),
    };
    this.data.quotes[key] = rec;
    return { created: true, quote: rec };
  }
  quote(userOpHash) { return this.data.quotes[lc(userOpHash)] || null; }

  // --- debits ---------------------------------------------------------------------------------------------
  /**
   * One postOp event -> one debit. Idempotent by userOpHash: a second call (log re-scan, restart, reorg replay)
   * returns the existing record untouched, whatever state it is in.
   */
  recordEvent(ev) {
    const key = lc(ev.userOpHash);
    const prev = this.data.debits[key];
    if (prev) return { created: false, debit: prev };
    const t = this.now();
    const rec = {
      userOpHash: key, payer: lc(ev.robinhoodPayer), sender: lc(ev.sender),
      actualGasCost: String(ev.actualGasCost), maxCharge: String(ev.maxXgasDevCharge),
      charge: String(ev.charge), rateSource: ev.rateSource || 'quote', success: !!ev.success,
      l4Tx: ev.transactionHash || null, l4Block: ev.blockNumber != null ? Number(ev.blockNumber) : null,
      state: BigInt(ev.charge) === 0n ? 'paid' : 'pending',
      txs: [], attempts: 0, nextAttemptAt: 0, lastError: null, paidTx: null,
      createdAt: t, day: utcDay(t),
    };
    this.data.debits[key] = rec;
    return { created: true, debit: rec };
  }
  debit(userOpHash) { return this.data.debits[lc(userOpHash)] || null; }
  patchDebit(userOpHash, patch) {
    const d = this.data.debits[lc(userOpHash)];
    if (!d) throw new Error('unknown debit');
    if (patch.state && !DEBIT_STATES.includes(patch.state)) throw new Error(`bad state ${patch.state}`);
    // paid is terminal: nothing moves a paid debit back, so a late failure report can never re-open it.
    if (d.state === 'paid' && patch.state && patch.state !== 'paid') return d;
    Object.assign(d, patch);
    return d;
  }
  /** Debits the worker should act on now: pending, sending (to reconcile) and unpaid whose backoff has passed. */
  due() {
    const t = this.now();
    return Object.values(this.data.debits)
      .filter((d) => d.state === 'pending' || d.state === 'sending' || (d.state === 'unpaid' && d.nextAttemptAt <= t))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  // --- exposure -------------------------------------------------------------------------------------------
  /** A quote is outstanding while it has not landed on the L4 and can still land (validUntil not passed). */
  isOutstanding(q, t = this.now()) {
    return !this.data.debits[q.userOpHash] && q.validUntil * 1000 >= t;
  }
  /**
   * What one payer owes or may soon owe:
   *   outstanding quotes (signed, not landed, not expired) at their maxCost / maxCharge,
   *   debits not paid yet (pending, sending, unpaid) at actualGasCost / charge,
   *   unpaid = debits whose transferFrom failed: any of these blocks new sponsorship,
   *   dailyWei = xMoney gas used or reserved today (UTC).
   */
  payerExposure(payer, t = this.now()) {
    const p = lc(payer); const today = utcDay(t);
    const out = { quotes: 0, owedWei: 0n, owedXgas: 0n, unpaidCount: 0, unpaidXgas: 0n, dailyWei: 0n, paidXgas: 0n, paidCount: 0, provenCount: 0 };
    for (const q of Object.values(this.data.quotes)) {
      if (q.payer !== p) continue;
      if (this.isOutstanding(q, t)) {
        out.quotes++; out.owedWei += BigInt(q.maxCost); out.owedXgas += BigInt(q.maxCharge);
        if (q.day === today) out.dailyWei += BigInt(q.maxCost);
      }
    }
    for (const d of Object.values(this.data.debits)) {
      if (d.payer !== p) continue;
      if (d.day === today) out.dailyWei += BigInt(d.actualGasCost);
      if (d.state === 'paid') {
        out.paidXgas += BigInt(d.charge); out.paidCount++;
        // proven = at least one charge that actually moved XGAS.DEV on Robinhood (a zero charge proves nothing).
        if (BigInt(d.charge) > 0n && d.paidTx) out.provenCount++;
        continue;
      }
      out.owedWei += BigInt(d.actualGasCost); out.owedXgas += BigInt(d.charge);
      if (d.state === 'unpaid') { out.unpaidCount++; out.unpaidXgas += BigInt(d.charge); }
    }
    return out;
  }
  /** xMoney gas used or reserved today by everyone together. */
  dailyTotalWei(t = this.now()) {
    const today = utcDay(t); let s = 0n;
    for (const q of Object.values(this.data.quotes)) if (q.day === today && this.isOutstanding(q, t)) s += BigInt(q.maxCost);
    for (const d of Object.values(this.data.debits)) if (d.day === today) s += BigInt(d.actualGasCost);
    return s;
  }
  /** Signed, not landed, not expired, every payer: what the EntryPoint deposit may still be asked to prefund. */
  outstandingWei(t = this.now()) {
    let s = 0n;
    for (const q of Object.values(this.data.quotes)) if (this.isOutstanding(q, t)) s += BigInt(q.maxCost);
    return s;
  }
  /** xMoney credit not collected yet, every payer: outstanding quotes plus debits still pending or sending. */
  inFlightWei(t = this.now()) {
    let s = this.outstandingWei(t);
    for (const d of Object.values(this.data.debits)) if (d.state === 'pending' || d.state === 'sending') s += BigInt(d.actualGasCost);
    return s;
  }
  /** xMoney gas sponsored today (UTC) whose XGAS.DEV charge failed and is still unpaid, every payer. */
  dailyLossWei(t = this.now()) {
    const today = utcDay(t); let s = 0n;
    for (const d of Object.values(this.data.debits)) if (d.day === today && d.state === 'unpaid') s += BigInt(d.actualGasCost);
    return s;
  }
  /** xMoney gas of the debits recorded at or after ms: ops that landed after a deposit reading was taken. */
  debitsWeiSince(ms) {
    let s = 0n;
    for (const d of Object.values(this.data.debits)) if (d.createdAt >= ms) s += BigInt(d.actualGasCost);
    return s;
  }
  totals() {
    const by = { pending: 0, sending: 0, paid: 0, unpaid: 0 }; let burned = 0n, owed = 0n;
    for (const d of Object.values(this.data.debits)) {
      by[d.state] = (by[d.state] || 0) + 1;
      if (d.state === 'paid') burned += BigInt(d.charge); else owed += BigInt(d.charge);
    }
    return { debits: by, burnedXgasDev: burned, owedXgasDev: owed, quotes: Object.keys(this.data.quotes).length };
  }
  recentForPayer(payer, n = 20) {
    const p = lc(payer);
    return Object.values(this.data.debits).filter((d) => d.payer === p).sort((a, b) => b.createdAt - a.createdAt).slice(0, n);
  }
  /** Drop quotes that expired long ago without landing (debits are kept: they are the audit trail). */
  prune(t = this.now()) {
    let n = 0;
    for (const [k, q] of Object.entries(this.data.quotes)) {
      if (t - q.createdAt > QUOTE_KEEP_MS && !this.isOutstanding(q, t)) { delete this.data.quotes[k]; n++; }
    }
    return n;
  }
}
