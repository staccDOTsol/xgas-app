// Concurrency and credit-risk limits of the sponsorship policy. Every "concurrent" case here must grant exactly what
// the same requests granted one at a time: the decision and the ledger reservation run with no await in between.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createPaymasterService, resolveConfig } from '../service.mjs';
import { Ledger } from '../ledger.mjs';
import { DEBIT_KEY, FACTORY, PAYMASTER, SENDER, SIGNER_KEY, fakeL4, fakeRobinhood, silent } from './fakes.mjs';

const WAD = 10n ** 18n;
const EP = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const debit = privateKeyToAccount(DEBIT_KEY);
const allowKey = (o) => `${o.toLowerCase()}:${debit.address.toLowerCase()}`;
const DEPLOY = { chainId: 466302, owner: '0xC3D6cED85829b5FA236515C21B3161B7e2cEB14F', l3: { xgasDev: '0x006D2D9e65f847e8B5f5053C9eb3a7824ec7dFa3' }, l4: {} };
const T0 = Date.UTC(2026, 8, 26, 12);
// The numbers of the original finding: 0.2 xMoney per op, credit 0.5 (so 2 ops serially), 8 outstanding, 2/day/payer.
const OLD = {
  PAYMASTER_SIGNER_KEY: SIGNER_KEY, DESK_RELAYER_KEY: DEBIT_KEY, PAYMASTER_ADDRESS: PAYMASTER, AA_SIMPLE_ACCOUNT_FACTORY: FACTORY,
  PAYMASTER_EMA_WARMUP_S: '0', PAYMASTER_MAX_OP_XMONEY: '0.25', PAYMASTER_CREDIT_XMONEY: '0.5', PAYMASTER_NEW_PAYER_CREDIT_XMONEY: '0.5',
  PAYMASTER_MAX_OUTSTANDING: '8', PAYMASTER_NEW_PAYER_MAX_OUTSTANDING: '8', PAYMASTER_DAILY_XMONEY_PER_PAYER: '2',
  PAYMASTER_DAILY_XMONEY_TOTAL: '50', PAYMASTER_INFLIGHT_XMONEY_TOTAL: '1000', PAYMASTER_DAILY_LOSS_XMONEY: '1000',
};
const FEE = 430107526881n;              // 465k gas x FEE ~ 0.2 xMoney per op
const OP_COST = 465_000n * FEE;
const op = (nonce, over = {}) => ({
  sender: SENDER, nonce: '0x' + nonce.toString(16), callData: '0xb61d27f6', callGasLimit: '0x186a0', verificationGasLimit: '0x30d40',
  preVerificationGas: '0xc350', maxFeePerGas: '0x' + FEE.toString(16), maxPriorityFeePerGas: '0x0',
  paymasterVerificationGasLimit: '0x124f8', paymasterPostOpGasLimit: '0x9c40', signature: '0x', ...over,
});
const addr = (i) => getAddress(`0x${(0xa0000 + i).toString(16).padStart(40, '0')}`);

function mk({ env = OLD, payers = [SENDER], balance = 10n ** 24n, allowance = 10n ** 24n, depositWei = 10n ** 24n, gasPrice = FEE } = {}) {
  let t = T0; const now = () => t;
  const cfg = resolveConfig({ env, deploy: DEPLOY });
  const balances = {}; const allowances = {};
  for (const p of payers) { balances[p] = balance; allowances[allowKey(p)] = allowance; }
  const rh = fakeRobinhood({ balances, allowances });
  const l4 = fakeL4({ code: { [PAYMASTER]: '0x6080' }, depositWei, gasPrice });
  const svc = createPaymasterService({ config: cfg, l4, rh, ethFairPrice: async () => ({ cents: '400000' }), dataDir: null, now, log: silent, ledger: new Ledger({ file: null, now }) });
  return { svc, cfg, rh, l4, advance: (ms) => { t += ms; } };
}
const grant = (svc, o) => svc.call('pm_getPaymasterData', [o, EP, '0x71d7e', {}]);
async function concurrent(svc, ops) {
  const rs = await Promise.allSettled(ops.map((o) => grant(svc, o)));
  for (const r of rs) if (r.status === 'rejected') assert.equal(r.reason.name, 'PolicyError', r.reason.stack);
  return { granted: rs.filter((r) => r.status === 'fulfilled').length, reasons: rs.filter((r) => r.status === 'rejected').map((r) => r.reason.data?.reason) };
}

test('race: 20 concurrent final requests from one payer grant exactly the serial count (2)', async () => {
  const serial = mk(); let ok = 0;
  for (let i = 0; i < 20; i++) { try { await grant(serial.svc, op(i)); ok++; } catch (e) { assert.equal(e.name, 'PolicyError'); } }
  assert.equal(ok, 2);
  const { svc, cfg } = mk();
  const { granted, reasons } = await concurrent(svc, Array.from({ length: 20 }, (_, i) => op(i)));
  assert.equal(granted, ok);
  assert.ok(reasons.every((r) => r === 'warmup'), reasons.join(','));   // new payer: the credit line it hits is the warm-up one
  const ex = svc.ledger.payerExposure(SENDER);
  assert.equal(ex.quotes, 2); assert.ok(ex.owedWei <= cfg.creditWei); assert.ok(ex.dailyWei <= cfg.dailyPerPayerWei);
});

test('race: 300 concurrent requests from 300 payers never pass the global daily total', async () => {
  const payers = Array.from({ length: 300 }, (_, i) => addr(i));
  const { svc, cfg } = mk({ env: { ...OLD, PAYMASTER_DAILY_XMONEY_TOTAL: '5' }, payers });
  const { granted } = await concurrent(svc, payers.map((p) => op(0, { sender: p })));
  assert.equal(BigInt(granted), cfg.dailyTotalWei / OP_COST);   // 25
  assert.ok(svc.ledger.dailyTotalWei() <= cfg.dailyTotalWei);
});

test('race: the global in-flight cap holds under concurrency', async () => {
  const payers = Array.from({ length: 50 }, (_, i) => addr(i));
  const { svc, cfg } = mk({ env: { ...OLD, PAYMASTER_INFLIGHT_XMONEY_TOTAL: '1' }, payers });
  const { granted, reasons } = await concurrent(svc, payers.map((p) => op(0, { sender: p })));
  assert.equal(BigInt(granted), cfg.inFlightTotalWei / OP_COST);  // 5
  assert.ok(reasons.every((r) => r === 'cap-inflight'));
  assert.ok(svc.ledger.inFlightWei() <= cfg.inFlightTotalWei);
});

test('race: a payer holding one op worth of XGAS.DEV gets one op, however many are asked at once', async () => {
  const probe = mk();
  const q = await probe.svc.call('pm_getPaymasterStubData', [op(0), EP, '0x71d7e', {}]);
  const oneOp = BigInt(q.xgas.maxXgasDevCharge) + 10n ** 15n;
  for (const [balance, allowance] of [[oneOp, 10n ** 24n], [10n ** 24n, oneOp]]) {
    const { svc } = mk({ env: { ...OLD, PAYMASTER_CREDIT_XMONEY: '10', PAYMASTER_NEW_PAYER_CREDIT_XMONEY: '10', PAYMASTER_DAILY_XMONEY_PER_PAYER: '10' }, balance, allowance });
    const { granted, reasons } = await concurrent(svc, Array.from({ length: 10 }, (_, i) => op(i)));
    assert.equal(granted, 1);
    assert.ok(reasons.every((r) => r === 'balance' || r === 'allowance'), reasons.join(','));
  }
});

test('race: the EntryPoint deposit bounds everything signed and not landed, not just one op', async () => {
  // deposit 1 xMoney, each op 0.2 and needs 2x its cost free: 0.2 + 0.2 + 0.2 reserved leaves 0.4 >= 0.4 -> 4th fits, 5th not.
  const payers = Array.from({ length: 20 }, (_, i) => addr(i));
  const { svc } = mk({ depositWei: WAD, payers });
  const { granted, reasons } = await concurrent(svc, payers.map((p) => op(0, { sender: p })));
  assert.equal(BigInt(granted), (WAD / OP_COST) - 1n);
  assert.ok(reasons.every((r) => r === 'deposit'));
});

test('HTTP: a batch runs one request at a time and every item counts against the rate limit', async () => {
  const { svc } = mk();
  const app = express(); app.use(express.json()); app.use(svc.router);
  const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const url = `http://127.0.0.1:${srv.address().port}/api/paymaster/466302`;
  const post = (body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, j: await r.json() }));
  try {
    const batch = Array.from({ length: 10 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'pm_getPaymasterData', params: [op(i), EP, '0x71d7e', {}] }));
    const { status, j } = await post(batch);
    assert.equal(status, 200);
    assert.equal(j.filter((x) => x.result).length, 2);
    // 10 used; 11 more batches of 10 reach 120, the next one is over.
    for (let k = 0; k < 11; k++) assert.equal((await post(batch.map((b) => ({ ...b, method: 'eth_chainId', params: [] })))).status, 200);
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' })).status, 429);
  } finally { await new Promise((r) => srv.close(r)); }
});

const NEW = { ...OLD, PAYMASTER_MAX_OP_XMONEY: '0.45', PAYMASTER_NEW_PAYER_CREDIT_XMONEY: '0.3', PAYMASTER_NEW_PAYER_MAX_OUTSTANDING: '1' };
test('warm-up: a new payer gets the small credit line and one op in flight until a charge of theirs is burned', async () => {
  const { svc } = mk({ env: NEW });
  await grant(svc, op(0));
  let e = await grant(svc, op(1)).catch((x) => x);
  assert.equal(e.data.reason, 'outstanding'); assert.equal(e.data.proven, false);
  // over the new-payer credit: 0.2 in use + 0.2 > 0.3
  svc.ledger.data.quotes[Object.keys(svc.ledger.data.quotes)[0]].validUntil = 0;   // let the first expire
  const big = op(2, { callGasLimit: '0x61a80' });                                      // 0.33 xMoney > 0.3
  e = await grant(svc, big).catch((x) => x);
  assert.equal(e.data.reason, 'warmup');
  // A settled (burned) charge makes the payer proven: full credit (0.5) and 8 in flight.
  svc.ledger.recordEvent({ userOpHash: `0x${'77'.repeat(32)}`, sender: SENDER, robinhoodPayer: SENDER, actualGasCost: 1n, maxXgasDevCharge: 5n, charge: 5n });
  svc.ledger.patchDebit(`0x${'77'.repeat(32)}`, { state: 'paid', paidTx: `0x${'aa'.repeat(32)}` });
  const r = await grant(svc, big);
  assert.equal(r.xgas.payerTier, 'proven');
  // A zero charge or a paid state without a Robinhood tx proves nothing.
  const z = mk({ env: NEW });
  z.svc.ledger.recordEvent({ userOpHash: `0x${'78'.repeat(32)}`, sender: SENDER, robinhoodPayer: SENDER, actualGasCost: 1n, maxXgasDevCharge: 0n, charge: 0n });
  assert.equal(z.svc.ledger.payerExposure(SENDER).provenCount, 0);
});

test('loss breaker: once today\'s unpaid charges reach the daily loss limit, nobody is sponsored until 00:00 UTC', async () => {
  const other = addr(1);
  const { svc, advance } = mk({ env: { ...OLD, PAYMASTER_DAILY_LOSS_XMONEY: '0.1' }, payers: [SENDER, other] });
  svc.ledger.recordEvent({ userOpHash: `0x${'66'.repeat(32)}`, sender: other, robinhoodPayer: other, actualGasCost: WAD / 10n, maxXgasDevCharge: 10n, charge: 10n });
  svc.ledger.patchDebit(`0x${'66'.repeat(32)}`, { state: 'unpaid' });
  const e = await grant(svc, op(0)).catch((x) => x);
  assert.equal(e.data.reason, 'cap-loss');
  assert.equal((await svc.status()).paused, true);
  advance(13 * 3_600_000);   // next UTC day
  await grant(svc, op(1));
});

test('fees: maxPriorityFeePerGas above the cap and maxFeePerGas far above the L4 gas price are refused', async () => {
  const { svc } = mk({ env: { ...OLD, PAYMASTER_MAX_PRIORITY_FEE_GWEI: '0.001' } });
  let e = await grant(svc, op(0, { maxPriorityFeePerGas: '0x3b9aca00' })).catch((x) => x);   // 1 gwei
  assert.equal(e.data.reason, 'priority-fee'); assert.equal(e.data.maxPriorityFeePerGas, '1000000');
  e = await svc.call('pm_getPaymasterStubData', [op(0, { maxPriorityFeePerGas: '0x3b9aca00' }), EP, '0x71d7e', {}]).catch((x) => x);
  assert.equal(e.data.reason, 'priority-fee');
  await grant(svc, op(1, { maxPriorityFeePerGas: '0xf4240' }));                                // exactly the cap
  e = await grant(svc, op(2, { maxFeePerGas: '0x' + (FEE * 11n).toString(16) })).catch((x) => x);
  assert.equal(e.data.reason, 'max-fee');
});
