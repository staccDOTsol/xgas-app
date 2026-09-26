import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { encodeFunctionData, getAddress, parseAbi, size, recoverMessageAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createPaymasterService, resolveConfig } from '../service.mjs';
import { Ledger } from '../ledger.mjs';
import { STUB_SIGNATURE, decodePaymasterData, paymasterHash, parseUserOp } from '../sign.mjs';
import { DEBIT_KEY, FACTORY, PAYER, PAYMASTER, SENDER, SIGNER_KEY, fakeL4, fakeRobinhood, silent } from './fakes.mjs';

const WAD = 10n ** 18n;
const EP = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const debit = privateKeyToAccount(DEBIT_KEY);
const signer = privateKeyToAccount(SIGNER_KEY);
const allowKey = (o) => `${o.toLowerCase()}:${debit.address.toLowerCase()}`;
const DEPLOY = { chainId: 466302, owner: '0xC3D6cED85829b5FA236515C21B3161B7e2cEB14F', l3: { xgasDev: '0x006D2D9e65f847e8B5f5053C9eb3a7824ec7dFa3' }, l4: {} };
const ENV = { PAYMASTER_SIGNER_KEY: SIGNER_KEY, DESK_RELAYER_KEY: DEBIT_KEY, PAYMASTER_ADDRESS: PAYMASTER, AA_SIMPLE_ACCOUNT_FACTORY: FACTORY, PAYMASTER_EMA_WARMUP_S: '0' };
const T0 = Date.UTC(2026, 8, 26, 12);

const op = (over = {}) => ({
  sender: SENDER, nonce: '0x0', callData: '0xb61d27f6', callGasLimit: '0x186a0', verificationGasLimit: '0x30d40',
  preVerificationGas: '0xc350', maxFeePerGas: '0x5f5e100', maxPriorityFeePerGas: '0x0',
  paymasterVerificationGasLimit: '0x124f8', paymasterPostOpGasLimit: '0x9c40', signature: '0x', ...over,
});

function mk({ env = ENV, balance = 10n ** 24n, allowance = 10n ** 24n, l4opts = {}, eth = { cents: '400000' }, ledger } = {}) {
  let t = T0; const now = () => t;
  const cfg = resolveConfig({ env, deploy: DEPLOY });
  const rh = fakeRobinhood({ balances: { [PAYER]: balance, [SENDER]: balance }, allowances: { [allowKey(PAYER)]: allowance, [allowKey(SENDER)]: allowance } });
  const l4 = fakeL4({ code: { [PAYMASTER]: '0x6080' }, ...l4opts });
  const svc = createPaymasterService({ config: cfg, l4, rh, ethFairPrice: async () => eth, dataDir: null, now, log: silent, ledger: ledger ?? (cfg.enabled ? new Ledger({ file: null, now }) : null) });
  return { svc, cfg, rh, l4, advance: (ms) => { t += ms; } };
}
async function rpc(svc, method, params, id = 1) {
  const r = await svc.call(method, params).then((result) => ({ result }), (e) => ({ e }));
  return r;
}
async function httpServer(svc) {
  const app = express(); app.use(express.json()); app.use(svc.router);
  const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

test('config: env unset -> disabled with the missing list; privileged keys refused', () => {
  const c = resolveConfig({ env: {}, deploy: DEPLOY });
  assert.equal(c.enabled, false);
  assert.ok(c.missing.some((m) => m.startsWith('PAYMASTER_ADDRESS')));
  assert.ok(c.missing.includes('PAYMASTER_SIGNER_KEY'));
  assert.equal(c.entryPoint, EP);
  const bad = resolveConfig({ env: { ...ENV, PAYMASTER_SIGNER_KEY: 'nothex' }, deploy: DEPLOY });
  assert.equal(bad.enabled, false);
  const ok = resolveConfig({ env: ENV, deploy: DEPLOY });
  assert.equal(ok.enabled, true); assert.equal(ok.signer.address, signer.address); assert.equal(ok.debit.address, debit.address);
  assert.equal(ok.maxOpWei, 2n * 10n ** 16n);
  assert.equal(ok.newPayerCreditWei, 10n ** 16n); assert.equal(ok.inFlightTotalWei, WAD); assert.equal(ok.maxPriorityFeeWei, 1_000_000n);
});

test('HTTP: disabled host answers the ERC-7677 endpoint with 503 and a JSON-RPC error; status is 200 enabled:false', async () => {
  const { svc } = mk({ env: {} });
  const s = await httpServer(svc);
  try {
    const r = await fetch(`${s.url}/api/paymaster/466302`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'pm_getPaymasterStubData', params: [] }) });
    assert.equal(r.status, 503);
    const j = await r.json();
    assert.equal(j.id, 7); assert.equal(j.error.code, -32003); assert.ok(Array.isArray(j.error.data.missing));
    const st = await fetch(`${s.url}/api/paymaster/466302/status`);
    assert.equal(st.status, 200);
    const sj = await st.json();
    assert.equal(sj.enabled, false); assert.equal(sj.entryPoint, EP);
    const b = await fetch(`${s.url}/api/bundler/466302`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }) });
    assert.equal(b.status, 503);
  } finally { await s.close(); }
});

test('pm_getPaymasterStubData: ERC-7677 v0.7 shape, stub signature, gas limits, XGAS.DEV estimate', async () => {
  const { svc } = mk();
  const { result: r } = await rpc(svc, 'pm_getPaymasterStubData', [op(), EP, '0x71d7e', {}]);
  assert.equal(r.paymaster, getAddress(PAYMASTER));
  assert.equal(size(r.paymasterData), 129);
  const d = decodePaymasterData(r.paymasterData);
  assert.equal(d.signature, STUB_SIGNATURE); assert.equal(d.robinhoodPayer, getAddress(SENDER));
  assert.equal(r.paymasterVerificationGasLimit, '0x124f8'); assert.equal(r.paymasterPostOpGasLimit, '0x9c40');
  assert.equal(r.isFinal, false); assert.ok(r.sponsor.name.includes('XGAS.DEV'));
  assert.equal(r.xgas.spender, debit.address);
  assert.ok(BigInt(r.xgas.maxXgasDevCharge) > 0n);
  // Stub never records anything.
  assert.equal(Object.keys(svc.ledger.data.quotes).length, 0);
});

test('pm_getPaymasterStubData before gas estimation quotes a default ceiling and fills default pm gas limits', async () => {
  const { svc } = mk();
  const { result: r } = await rpc(svc, 'pm_getPaymasterStubData', [op({ callGasLimit: '0x0', verificationGasLimit: '0x0', preVerificationGas: '0x0', paymasterVerificationGasLimit: undefined, paymasterPostOpGasLimit: undefined }), EP, 466302, null]);
  assert.equal(r.xgas.estimated, true);
  assert.equal(r.paymasterVerificationGasLimit, '0x124f8'); assert.equal(r.paymasterPostOpGasLimit, '0x9c40');
});

test('pm_getPaymasterData: signature recovers to the signer over the contract hash; max charge = maxCost x rate; recorded once', async () => {
  const { svc } = mk();
  const params = [op(), EP, '0x71d7e', {}];
  const { result: r } = await rpc(svc, 'pm_getPaymasterData', params);
  assert.equal(r.paymaster, getAddress(PAYMASTER));
  assert.equal(r.paymasterVerificationGasLimit, undefined);
  const d = decodePaymasterData(r.paymasterData);
  const o = parseUserOp(op());
  const h = paymasterHash({ op: o, chainId: 466302, paymaster: PAYMASTER, pmVerificationGasLimit: 75_000n, pmPostOpGasLimit: 40_000n, ...d });
  assert.equal(await recoverMessageAddress({ message: { raw: h }, signature: d.signature }), signer.address);
  // maxCost = (200k + 100k + 75k + 40k + 50k) gas x 0.1 gwei = 4.65e13 wei.
  const maxCost = 465_000n * 100_000_000n;
  assert.equal(r.xgas.maxCostWei, String(maxCost));
  const rate = BigInt(svc.ledger.quote(r.xgas.userOpHash).rateWad);
  assert.equal(d.maxXgasDevCharge, (maxCost * rate + WAD - 1n) / WAD);
  // Rate sanity: pool ~13.2355M XGAS.DEV/ETH, ETH $4000, NAV ~1.000256, +10%: ~3640 XGAS.DEV per xMoney.
  const perX = Number(rate / 10n ** 15n) / 1000;
  assert.ok(perX > 3635 && perX < 3645, String(perX));
  assert.equal(d.validAfter, 0);
  assert.equal(d.validUntil % 60, 0); assert.ok(d.validUntil * 1000 > T0 + 300_000 - 1);
  // Same request again in the same minute: identical bytes, still one quote.
  const { result: r2 } = await rpc(svc, 'pm_getPaymasterData', params);
  assert.equal(r2.paymasterData, r.paymasterData);
  assert.equal(Object.keys(svc.ledger.data.quotes).length, 1);
  assert.equal(svc.ledger.payerExposure(SENDER).quotes, 1);
});

test('pm_getPaymasterData refuses unfilled gas, wrong chain, wrong EntryPoint, too little postOp gas', async () => {
  const { svc } = mk();
  let r = await rpc(svc, 'pm_getPaymasterData', [op({ verificationGasLimit: '0x0' }), EP, '0x71d7e', {}]);
  assert.equal(r.e.name, 'PaymasterInputError');
  r = await rpc(svc, 'pm_getPaymasterData', [op(), EP, '0x1237', {}]); assert.match(r.e.message, /chainId/);
  r = await rpc(svc, 'pm_getPaymasterData', [op(), '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789', '0x71d7e', {}]); assert.match(r.e.message, /EntryPoint/);
  r = await rpc(svc, 'pm_getPaymasterData', [op({ paymasterPostOpGasLimit: '0x4e20' }), EP, '0x71d7e', {}]); assert.match(r.e.message, /PostOpGasLimit/);
});

test('payer: a claimed robinhoodPayer that is not the sender or its SimpleAccount owner is refused', async () => {
  const { svc } = mk();
  const r = await rpc(svc, 'pm_getPaymasterData', [op(), EP, '0x71d7e', { robinhoodPayer: PAYER }]);
  assert.equal(r.e.name, 'PolicyError'); assert.equal(r.e.data.reason, 'payer');
});

test('payer: SimpleAccountFactory initCode -> the owner pays; an unknown factory is refused', async () => {
  const { svc } = mk();
  const factoryData = encodeFunctionData({ abi: parseAbi(['function createAccount(address,uint256)']), functionName: 'createAccount', args: [PAYER, 0n] });
  const { result } = await rpc(svc, 'pm_getPaymasterData', [op({ factory: FACTORY, factoryData }), EP, '0x71d7e', {}]);
  assert.equal(decodePaymasterData(result.paymasterData).robinhoodPayer, getAddress(PAYER));
  assert.equal(result.xgas.payerCheck, 'factory-initcode');
  const r = await rpc(svc, 'pm_getPaymasterData', [op({ factory: '0x5555555555555555555555555555555555555555', factoryData }), EP, '0x71d7e', {}]);
  assert.equal(r.e.data.reason, 'payer');
});

test('payer: a deployed account is attributed to its owner only if factory.getAddress(owner, salt) == sender', async () => {
  const good = mk({ l4opts: { owners: { [SENDER.toLowerCase()]: PAYER }, factoryAddresses: { [`${PAYER.toLowerCase()}:0`]: SENDER } } });
  const { result } = await rpc(good.svc, 'pm_getPaymasterData', [op(), EP, '0x71d7e', {}]);
  assert.equal(decodePaymasterData(result.paymasterData).robinhoodPayer, getAddress(PAYER));
  assert.equal(result.xgas.payerCheck, 'factory-address');
  // A contract whose owner() names someone else, not created by our factory, cannot bill them.
  const spoof = mk({ l4opts: { owners: { [SENDER.toLowerCase()]: PAYER } } });
  const r = await rpc(spoof.svc, 'pm_getPaymasterData', [op(), EP, '0x71d7e', { robinhoodPayer: PAYER }]);
  assert.equal(r.e.data.reason, 'payer');
  // Without a claim it falls back to the sender paying for itself.
  const { result: r2 } = await rpc(spoof.svc, 'pm_getPaymasterData', [op(), EP, '0x71d7e', {}]);
  assert.equal(decodePaymasterData(r2.paymasterData).robinhoodPayer, getAddress(SENDER));
});

test('policy: allowance and balance on Robinhood', async () => {
  let { svc } = mk({ allowance: 0n });
  let r = await rpc(svc, 'pm_getPaymasterStubData', [op(), EP, '0x71d7e', {}]);
  assert.equal(r.e.data.reason, 'allowance'); assert.equal(r.e.data.spender, debit.address);
  ({ svc } = mk({ balance: 1n }));
  r = await rpc(svc, 'pm_getPaymasterData', [op(), EP, '0x71d7e', {}]);
  assert.equal(r.e.data.reason, 'balance');
});

test('policy: an unpaid debit blocks the payer; credit limit; per-op cap; daily caps; outstanding cap', async () => {
  const { svc, advance } = mk({ env: { ...ENV, PAYMASTER_CREDIT_XMONEY: '0.0001', PAYMASTER_MAX_OUTSTANDING: '2' } });
  // unpaid
  svc.ledger.recordEvent({ userOpHash: `0x${'09'.repeat(32)}`, sender: SENDER, robinhoodPayer: SENDER, actualGasCost: 1n, maxXgasDevCharge: 5n, charge: 5n });
  svc.ledger.patchDebit(`0x${'09'.repeat(32)}`, { state: 'unpaid' });
  let r = await rpc(svc, 'pm_getPaymasterData', [op(), EP, '0x71d7e', {}]);
  assert.equal(r.e.data.reason, 'unpaid');
  svc.ledger.patchDebit(`0x${'09'.repeat(32)}`, { state: 'paid', paidTx: `0x${'aa'.repeat(32)}` });   // settled on Robinhood: a proven payer
  // credit: 0.0001 xMoney = 1e14 wei; each op reserves 4.65e13 -> two fit, the third does not... but outstanding cap is 2.
  await rpc(svc, 'pm_getPaymasterData', [op({ nonce: '0x1' }), EP, '0x71d7e', {}]);
  await rpc(svc, 'pm_getPaymasterData', [op({ nonce: '0x2' }), EP, '0x71d7e', {}]);
  r = await rpc(svc, 'pm_getPaymasterData', [op({ nonce: '0x3' }), EP, '0x71d7e', {}]);
  assert.equal(r.e.data.reason, 'outstanding');
  // After they expire, exposure clears.
  advance(10 * 60_000);
  r = await rpc(svc, 'pm_getPaymasterData', [op({ nonce: '0x4', callGasLimit: '0xf4240' }), EP, '0x71d7e', {}]); // 1.4M gas = 1.4e14 wei > credit
  assert.equal(r.e.data.reason, 'credit');
  // per-op cap: 0.02 xMoney (2e8 gas at 0.1 gwei)
  r = await rpc(svc, 'pm_getPaymasterData', [op({ callGasLimit: '0xbebc200' }), EP, '0x71d7e', {}]);
  assert.equal(r.e.data.reason, 'cap-op');

  const d = mk({ env: { ...ENV, PAYMASTER_DAILY_XMONEY_PER_PAYER: '0.00005' } });
  await rpc(d.svc, 'pm_getPaymasterData', [op({ nonce: '0x1' }), EP, '0x71d7e', {}]);
  r = await rpc(d.svc, 'pm_getPaymasterData', [op({ nonce: '0x2' }), EP, '0x71d7e', {}]);
  assert.equal(r.e.data.reason, 'cap-payer-day');
  const g = mk({ env: { ...ENV, PAYMASTER_DAILY_XMONEY_TOTAL: '0.00004' } });
  r = await rpc(g.svc, 'pm_getPaymasterData', [op(), EP, '0x71d7e', {}]);
  assert.equal(r.e.data.reason, 'cap-day');
});

test('policy: price divergence, missing ETH price, undeployed paymaster, low deposit', async () => {
  const a = mk();
  await a.svc.samplePool();
  a.rh.st.slot0 = '0x0000000000000000000280980000000000000f36106605b5c75d0d9d08cdaaf7'; // sqrtP +~7% -> price +~14%
  a.advance(16_000);
  let r = await rpc(a.svc, 'pm_getPaymasterData', [op(), EP, '0x71d7e', {}]);
  assert.equal(r.e.data.reason, 'price'); assert.match(r.e.message, /average/);
  const b = mk({ eth: null });
  r = await rpc(b.svc, 'pm_getPaymasterData', [op(), EP, '0x71d7e', {}]);
  assert.equal(r.e.data.reason, 'price');
  const c = mk({ l4opts: { code: {} } });
  r = await rpc(c.svc, 'pm_getPaymasterData', [op(), EP, '0x71d7e', {}]);
  assert.equal(r.e.data.reason, 'paymaster');
  const d = mk({ l4opts: { depositWei: 1n } });
  r = await rpc(d.svc, 'pm_getPaymasterData', [op(), EP, '0x71d7e', {}]);
  assert.equal(r.e.data.reason, 'deposit');
});

test('HTTP: JSON-RPC envelope, batch, errors, status with payer', async () => {
  const { svc } = mk();
  const s = await httpServer(svc);
  const post = (body) => fetch(`${s.url}/api/paymaster/466302`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, j: await r.json() }));
  try {
    let { status, j } = await post({ jsonrpc: '2.0', id: 'a', method: 'pm_getPaymasterData', params: [op(), EP, '0x71d7e', {}] });
    assert.equal(status, 200); assert.equal(j.id, 'a'); assert.equal(size(j.result.paymasterData), 129);
    ({ j } = await post({ jsonrpc: '2.0', id: 2, method: 'eth_sendTransaction', params: [] }));
    assert.equal(j.error.code, -32601);
    ({ j } = await post({ jsonrpc: '2.0', id: 3, method: 'pm_getPaymasterData', params: [op(), EP, '0x1', {}] }));
    assert.equal(j.error.code, -32602);
    ({ j } = await post({ jsonrpc: '2.0', id: 4, method: 'pm_getPaymasterData', params: [op(), EP, '0x71d7e', { robinhoodPayer: PAYER }] }));
    assert.equal(j.error.code, -32001); assert.equal(j.error.data.reason, 'payer');
    ({ j } = await post([{ jsonrpc: '2.0', id: 5, method: 'eth_chainId' }, { jsonrpc: '2.0', id: 6, method: 'pm_supportedEntryPoints' }]));
    assert.deepEqual(j.map((x) => x.result), ['0x71d7e', [EP]]);
    ({ j } = await post({ id: 1, method: 'x' }));
    assert.equal(j.error.code, -32600);
    const st = await fetch(`${s.url}/api/paymaster/466302/status?payer=${SENDER}`).then((r) => r.json());
    assert.equal(st.enabled, true); assert.equal(st.spender, debit.address); assert.equal(st.signer, signer.address);
    assert.ok(Number(st.price.rate.xgasDevPerXmoney) > 3000);
    assert.equal(st.payer.address, getAddress(SENDER)); assert.equal(st.payer.outstandingQuotes, 1); assert.equal(st.payer.blocked, false);
    const bad = await fetch(`${s.url}/api/paymaster/466302/status?payer=nope`);
    assert.equal(bad.status, 400);
  } finally { await s.close(); }
});

test('bundler proxy: allowlisted methods only, forwarded verbatim', async () => {
  const cfg = resolveConfig({ env: { ...ENV, BUNDLER_URL: 'http://bundler.internal:3000' }, deploy: DEPLOY });
  assert.equal(cfg.bundlerUrl, 'https://xgas.dev/api/bundler/466302');
  const seen = [];
  const svc = createPaymasterService({ config: cfg, l4: fakeL4(), rh: fakeRobinhood(), ethFairPrice: async () => null, log: silent, ledger: new Ledger({ file: null }), fetchImpl: async (url, init) => { seen.push([url, init.body]); return new Response('{"jsonrpc":"2.0","id":1,"result":"0x71d7e"}', { status: 200 }); } });
  const s = await httpServer(svc);
  try {
    const ok = await fetch(`${s.url}/api/bundler/466302`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }) });
    assert.equal(ok.status, 200); assert.equal((await ok.json()).result, '0x71d7e');
    assert.equal(seen[0][0], 'http://bundler.internal:3000');
    const no = await fetch(`${s.url}/api/bundler/466302`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'debug_bundler_clearState' }) });
    assert.equal(no.status, 400); assert.equal(seen.length, 1);
  } finally { await s.close(); }
});

test('HTTP: malformed JSON gets a JSON-RPC parse error', async () => {
  const { svc } = mk();
  const app = express(); app.use(express.json()); app.use(svc.router); app.use(svc.errorPaths, svc.errorHandler);
  const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/paymaster/466302`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    assert.equal(r.status, 400); assert.equal((await r.json()).error.code, -32700);
  } finally { await new Promise((r) => srv.close(r)); }
});
