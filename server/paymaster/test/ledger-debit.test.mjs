import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { privateKeyToAccount } from 'viem/accounts';
import { Ledger } from '../ledger.mjs';
import { createDebitWorker, unpaidBackoffMs } from '../debit.mjs';
import { DEBIT_KEY, PAYER, PAYMASTER, SENDER, chargedLog, fakeL4, fakeRobinhood, silent } from './fakes.mjs';

const WAD = 10n ** 18n;
const EP = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const XGAS = '0x006D2D9e65f847e8B5f5053C9eb3a7824ec7dFa3';
const debit = privateKeyToAccount(DEBIT_KEY);
const H1 = `0x${'01'.repeat(32)}`; const H2 = `0x${'02'.repeat(32)}`;
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pmledger-')), 'paymaster-ledger.json');
const allowKey = (o) => `${o.toLowerCase()}:${debit.address.toLowerCase()}`;

function setup({ file = tmpFile(), balance = 10n ** 24n, allowance = 10n ** 24n, t0 = Date.UTC(2026, 8, 26, 12) } = {}) {
  let t = t0; const now = () => t;
  const ledger = new Ledger({ file, now });
  const l4 = fakeL4(); const rh = fakeRobinhood({ balances: { [PAYER]: balance }, allowances: { [allowKey(PAYER)]: allowance } });
  const mk = (lg = ledger) => createDebitWorker({ ledger: lg, l4, rh, account: debit, paymaster: PAYMASTER, entryPoint: EP, xgasDev: XGAS, log: silent, now });
  return { file, ledger, l4, rh, worker: mk(), mk, now, advance: (ms) => { t += ms; } };
}

test('ledger: recordEvent is idempotent by userOpHash and survives a reload', () => {
  const file = tmpFile(); const l = new Ledger({ file });
  const ev = { userOpHash: H1, sender: SENDER, robinhoodPayer: PAYER, actualGasCost: 5n, maxXgasDevCharge: 100n, charge: 7n, success: true };
  assert.equal(l.recordEvent(ev).created, true);
  assert.equal(l.recordEvent({ ...ev, charge: 99n }).created, false);
  assert.equal(l.debit(H1.toUpperCase().replace('0X', '0x')).charge, '7');
  l.save();
  const l2 = new Ledger({ file });
  assert.equal(Object.keys(l2.data.debits).length, 1);
  assert.equal(l2.recordEvent(ev).created, false);
  // No temp files left behind by the atomic writer.
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['paymaster-ledger.json']);
});

test('ledger: paid is terminal', () => {
  const l = new Ledger({ file: null });
  l.recordEvent({ userOpHash: H1, sender: SENDER, robinhoodPayer: PAYER, actualGasCost: 5n, maxXgasDevCharge: 100n, charge: 7n });
  l.patchDebit(H1, { state: 'paid', paidTx: '0x1' });
  l.patchDebit(H1, { state: 'unpaid', lastError: 'late' });
  assert.equal(l.debit(H1).state, 'paid');
});

test('ledger: exposure counts outstanding quotes until they land or expire, and unpaid debits', () => {
  let t = Date.UTC(2026, 8, 26, 12); const l = new Ledger({ file: null, now: () => t });
  l.upsertQuote({ userOpHash: H1, payer: PAYER, sender: SENDER, maxCost: 1000n, maxCharge: 50n, rateWad: WAD, validUntil: t / 1000 + 300 });
  assert.equal(l.upsertQuote({ userOpHash: H1, payer: PAYER, sender: SENDER, maxCost: 1000n, maxCharge: 50n, rateWad: WAD, validUntil: t / 1000 + 300 }).created, false);
  l.upsertQuote({ userOpHash: H2, payer: PAYER, sender: SENDER, maxCost: 2000n, maxCharge: 80n, rateWad: WAD, validUntil: t / 1000 + 300 });
  let ex = l.payerExposure(PAYER);
  assert.equal(ex.quotes, 2); assert.equal(ex.owedWei, 3000n); assert.equal(ex.owedXgas, 130n); assert.equal(ex.dailyWei, 3000n);
  // H1 lands: its quote stops counting, its debit counts at the actual numbers.
  l.recordEvent({ userOpHash: H1, sender: SENDER, robinhoodPayer: PAYER, actualGasCost: 400n, maxXgasDevCharge: 50n, charge: 20n });
  ex = l.payerExposure(PAYER);
  assert.equal(ex.quotes, 1); assert.equal(ex.owedWei, 2400n); assert.equal(ex.owedXgas, 100n); assert.equal(ex.dailyWei, 2400n);
  l.patchDebit(H1, { state: 'unpaid' });
  ex = l.payerExposure(PAYER); assert.equal(ex.unpaidCount, 1); assert.equal(ex.unpaidXgas, 20n);
  l.patchDebit(H1, { state: 'paid' });
  ex = l.payerExposure(PAYER); assert.equal(ex.unpaidCount, 0); assert.equal(ex.paidXgas, 20n); assert.equal(ex.owedWei, 2000n);
  // H2 expires unlanded: no longer owed, no longer in today's usage.
  t += 301_000;
  ex = l.payerExposure(PAYER); assert.equal(ex.quotes, 0); assert.equal(ex.owedWei, 0n); assert.equal(ex.dailyWei, 400n);
  // Another payer is unaffected.
  assert.equal(l.payerExposure(SENDER).owedWei, 0n);
  // Prune drops the stale quote after two days, keeps the debit.
  t += 3 * 86_400_000; l.prune();
  assert.equal(Object.keys(l.data.quotes).length, 0); assert.equal(Object.keys(l.data.debits).length, 1);
});

test('worker: charges at the quoted rate on the EntryPoint final cost, once, across re-scans', async () => {
  const s = setup();
  s.ledger.upsertQuote({ userOpHash: H1, payer: PAYER, sender: SENDER, maxCost: 10n ** 15n, maxCharge: 4n * WAD, rateWad: 3575n * WAD, validUntil: 2e9 });
  s.l4.st.logs.push(chargedLog({ userOpHash: H1, actualGasCost: 10n ** 14n, maxXgasDevCharge: 4n * WAD }));
  s.l4.st.uoLogs.push({ address: EP, blockNumber: 10n, removed: false, args: { userOpHash: H1, sender: SENDER, paymaster: PAYMASTER, nonce: 0n, success: true, actualGasCost: 11n * 10n ** 13n, actualGasUsed: 1n } });
  // An identical event from another contract must be ignored.
  s.l4.st.logs.push(chargedLog({ userOpHash: H2, actualGasCost: 10n ** 14n, maxXgasDevCharge: 4n * WAD, address: '0x9999999999999999999999999999999999999999' }));
  const r = await s.worker.tick();
  assert.equal(r.scanned.added, 1);
  const d = s.ledger.debit(H1);
  assert.equal(d.charge, String(3575n * 11n * 10n ** 13n)); // 1.1e14 wei x 3575 = 0.39325 XGAS.DEV
  assert.equal(d.state, 'paid'); assert.equal(s.rh.st.sent.length, 1);
  assert.equal(s.ledger.debit(H2), null);
  // Re-scan the same blocks (cursor reset, restart) and tick again: nothing new is sent.
  s.ledger.setCursor(0);
  await s.worker.tick(); await s.worker.tick();
  assert.equal(s.rh.st.sent.length, 1);
  // And a fresh worker on the reloaded file does not pay again either.
  const w2 = s.mk(new Ledger({ file: s.file, now: s.now }));
  await w2.tick();
  assert.equal(s.rh.st.sent.length, 1);
});

test('worker: charge is capped at the signed maxXgasDevCharge (griefing op burns its whole gas limit)', async () => {
  const s = setup();
  s.ledger.upsertQuote({ userOpHash: H1, payer: PAYER, sender: SENDER, maxCost: 10n ** 15n, maxCharge: 3n * WAD, rateWad: 3575n * WAD, validUntil: 2e9 });
  s.l4.st.logs.push(chargedLog({ userOpHash: H1, actualGasCost: 10n ** 15n, maxXgasDevCharge: 3n * WAD, succeeded: false }));
  await s.worker.tick();
  const d = s.ledger.debit(H1);
  assert.equal(d.charge, String(3n * WAD)); assert.equal(d.success, false); assert.equal(d.state, 'paid');
});

test('worker: a crash after persisting the signed tx never double-pays', async () => {
  const s = setup();
  s.ledger.upsertQuote({ userOpHash: H1, payer: PAYER, sender: SENDER, maxCost: 10n ** 15n, maxCharge: WAD, rateWad: 1000n * WAD, validUntil: 2e9 });
  s.l4.st.logs.push(chargedLog({ userOpHash: H1, actualGasCost: 10n ** 14n, maxXgasDevCharge: WAD }));
  // Broadcast "times out" but the node took it (mined later).
  s.rh.st.autoMine = false;
  s.rh.st.sendError = Object.assign(new Error('request timed out'), {});
  await s.worker.tick();
  let d = s.ledger.debit(H1);
  assert.equal(d.state, 'sending'); assert.equal(d.txs.length, 1);
  // Restart: new worker, reloaded ledger. The tx is now mined.
  s.rh.st.receipts.set(d.txs[0].hash, { status: 'success' }); s.rh.st.nonceLatest = 1; s.rh.st.noncePending = 1;
  const l2 = new Ledger({ file: s.file, now: s.now }); const w2 = s.mk(l2);
  await w2.tick();
  d = l2.debit(H1);
  assert.equal(d.state, 'paid'); assert.equal(d.paidTx, d.txs[0].hash); assert.equal(d.txs.length, 1);
  assert.equal(s.rh.st.sent.length, 0); // never re-signed or re-sent under a new nonce
});

test('worker: a lost tx whose nonce is still free is rebroadcast, one whose nonce was taken is re-signed', async () => {
  const s = setup();
  s.ledger.upsertQuote({ userOpHash: H1, payer: PAYER, sender: SENDER, maxCost: 10n ** 15n, maxCharge: WAD, rateWad: 1000n * WAD, validUntil: 2e9 });
  s.l4.st.logs.push(chargedLog({ userOpHash: H1, actualGasCost: 10n ** 14n, maxXgasDevCharge: WAD }));
  s.rh.st.autoMine = false;
  await s.worker.tick();                      // sent, not mined
  let d = s.ledger.debit(H1);
  assert.equal(d.state, 'sending'); assert.equal(s.rh.st.sent.length, 1);
  s.advance(31_000); await s.worker.tick();   // nonce free -> rebroadcast the same bytes
  assert.equal(s.rh.st.sent.length, 2); assert.equal(s.rh.st.sent[0], s.rh.st.sent[1]);
  // The drip took nonce 0; our tx can never land. Re-sign with nonce 1.
  s.rh.st.nonceLatest = 1; s.rh.st.noncePending = 1; s.rh.st.autoMine = true;
  await s.worker.tick();
  d = s.ledger.debit(H1);
  assert.equal(d.state, 'paid'); assert.equal(d.txs.length, 2); assert.equal(d.txs[0].dropped, true); assert.equal(d.txs[1].nonce, 1);
});

test('worker: missing allowance -> unpaid with backoff, retried and paid once restored', async () => {
  const s = setup({ allowance: 0n });
  s.ledger.upsertQuote({ userOpHash: H1, payer: PAYER, sender: SENDER, maxCost: 10n ** 15n, maxCharge: WAD, rateWad: 1000n * WAD, validUntil: 2e9 });
  s.l4.st.logs.push(chargedLog({ userOpHash: H1, actualGasCost: 10n ** 14n, maxXgasDevCharge: WAD }));
  await s.worker.tick();
  let d = s.ledger.debit(H1);
  assert.equal(d.state, 'unpaid'); assert.match(d.lastError, /allowance/); assert.equal(s.rh.st.sent.length, 0);
  assert.equal(s.ledger.payerExposure(PAYER).unpaidCount, 1);
  s.rh.st.allowances[allowKey(PAYER)] = 10n ** 24n;
  await s.worker.tick();                              // still in backoff
  assert.equal(s.ledger.debit(H1).state, 'unpaid');
  s.advance(unpaidBackoffMs(1) + 1);
  await s.worker.tick();
  d = s.ledger.debit(H1); assert.equal(d.state, 'paid'); assert.equal(s.rh.st.sent.length, 1);
  assert.equal(s.ledger.payerExposure(PAYER).unpaidCount, 0);
});

test('worker: an event with no ledger quote is charged at the live rate, capped', async () => {
  const s = setup();
  const w = createDebitWorker({ ledger: s.ledger, l4: s.l4, rh: s.rh, account: debit, paymaster: PAYMASTER, entryPoint: EP, xgasDev: XGAS, log: silent, now: s.now, rateFallback: async () => 2000n * WAD });
  s.l4.st.logs.push(chargedLog({ userOpHash: H1, actualGasCost: 10n ** 14n, maxXgasDevCharge: WAD }));
  await w.tick();
  const d = s.ledger.debit(H1);
  assert.equal(d.charge, String(2000n * 10n ** 14n)); assert.equal(d.rateSource, 'current');
});

test('backoff doubles and caps at an hour', () => {
  assert.equal(unpaidBackoffMs(1), 60_000); assert.equal(unpaidBackoffMs(2), 120_000); assert.equal(unpaidBackoffMs(20), 3_600_000);
});
