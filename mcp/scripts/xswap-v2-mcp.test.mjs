import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, encodeFunctionData, serializeTransaction, toFunctionSelector } from 'viem';
import { XSWAP, XSWAP_LEGACY, XSWAP_V2, ZERO, isXswapLegacy, parent } from '../src/config.mjs';
import { ERC20_ABI, XSWAP_INTENTS_ABI, XSWAP_ASKS_ABI, XSWAP_V2_INTENTS_ABI, XSWAP_V2_ASKS_ABI } from '../src/abis.mjs';
import { assertRelayAllowed, tools } from '../src/tools/xswap.mjs';
import { xswapV2GrossFor, xswapV2InFloor, xswapV2OutFunding, xswapV2TermsHash } from '../src/xswapV2.mjs';

const ID = `0x${'11'.repeat(32)}`;
const OWNER = '0x1111111111111111111111111111111111111111';
const raw = (to, abi, functionName, args) => serializeTransaction({ type: 'legacy', chainId: 4663,
  nonce: 0n, gas: 400000n, gasPrice: 1n, to, value: 0n,
  data: encodeFunctionData({ abi, functionName, args }) });

test('deployed V2 is separate from every legacy escrow and source-owned new-order gate is off', async () => {
  assert.equal(XSWAP.enabled, false); // deployment.json still says enabled:true for 5D/a999
  assert.equal(XSWAP_V2.enabled, false);
  for (const address of [...XSWAP_LEGACY.intents, ...XSWAP_LEGACY.asks]) assert.equal(isXswapLegacy(address), true);
  assert.equal(isXswapLegacy(XSWAP_V2.intents), false);
  assert.equal(isXswapLegacy(XSWAP_V2.asks), false);
  const out = tools.find((t) => t.name === 'prepare_xswap_out');
  const inn = tools.find((t) => t.name === 'prepare_xswap_in');
  await assert.rejects(out.handler({ from: OWNER, xmoney_amount: '1', chain: 'base', to: OWNER, amount: '0.001' }), /paused until the V2 solver/);
  await assert.rejects(inn.handler({ from: OWNER, want_xmoney: '1', chain: 'base', amount: '0.001' }), /paused until the V2 solver/);
});

test('V2 ABI selectors and tax-aware funding match reviewed contracts', () => {
  assert.equal(toFunctionSelector(XSWAP_V2_INTENTS_ABI.find((x) => x.name === 'openWithSiteFee')), '0xbea6adaf');
  assert.equal(toFunctionSelector(XSWAP_V2_ASKS_ABI.find((x) => x.name === 'askWithSiteFee')), '0xa1d0c683');
  const gross = 1_000_000_000_000_000_000n;
  const out = xswapV2OutFunding(gross);
  assert.equal(out.grossWalletDebit, gross);
  assert.equal(out.expectedEscrowReceived, gross - gross / 10_000n);
  assert.ok(out.escrowCeiling + out.siteFeeMax <= out.expectedEscrowReceived);
  assert.ok(out.escrowCeiling + 1n + (out.escrowCeiling + 1n) / 1_000n > out.expectedEscrowReceived);
  const target = 1_250_000_000_000_000_000n;
  const walletDebit = xswapV2GrossFor(target);
  assert.ok(walletDebit - walletDebit / 10_000n >= target);
  assert.ok(walletDebit - 1n - (walletDebit - 1n) / 10_000n < target);
  assert.ok(walletDebit <= target + target / 5_000n + 2n);
  for (const abi of [XSWAP_V2_INTENTS_ABI, XSWAP_V2_ASKS_ABI]) {
    const encoded = encodeFunctionData({ abi, functionName: 'bid', args: [ID, target, walletDebit] });
    const decoded = decodeFunctionData({ abi, data: encoded });
    assert.equal(decoded.functionName, 'bid');
    assert.deepEqual(decoded.args, [ID, target, walletDebit]);
  }
  const seller = xswapV2InFloor(1_000_000_000_000_000_000n);
  const credit = seller.grossBidFloor - seller.protocolFeeAtFloor - seller.siteFeeAtFloor;
  assert.ok(credit - (credit + 9_999n) / 10_000n >= seller.minSellerNet);
  assert.equal(xswapV2TermsHash(50, 10000, 1800, 120, XSWAP_V2.treasury),
    '0x0b134a84fc6ec58eb83810a6f68f3a3368ff34f1c478ded3b64cb1c6b0860d32');
});

test('raw relay denies legacy funding and V2 new orders but preserves legacy cleanup', async () => {
  const legacyIntent = XSWAP_LEGACY.intents[0];
  const retiredIntent = XSWAP_LEGACY.intents[1];
  const legacyAsk = XSWAP_LEGACY.asks[0];
  const retiredAsk = XSWAP_LEGACY.asks[1];
  const legacyOpen = raw(legacyIntent, XSWAP_INTENTS_ABI, 'open', [ID, 1n, 1000n, ID, 'memo']);
  const legacyClaim = raw(retiredIntent, XSWAP_INTENTS_ABI, 'claim', [ID, ID]);
  const legacyAskTx = raw(legacyAsk, XSWAP_ASKS_ABI, 'ask', [ID, 1n, 1000n, ID, 'memo']);
  const legacyBid = raw(retiredAsk, XSWAP_ASKS_ABI, 'bid', [ID, 1n]);
  for (const tx of [legacyOpen, legacyClaim, legacyAskTx, legacyBid]) {
    await assert.rejects(assertRelayAllowed([tx]), /legacy XSwap escrow/);
  }
  await assert.rejects(assertRelayAllowed([raw(XSWAP.xmoney, ERC20_ABI, 'approve', [legacyIntent, 1n])]),
    /approval to a legacy XSwap escrow/);
  await assert.rejects(assertRelayAllowed([raw(retiredIntent, XSWAP_INTENTS_ABI, 'dispute', [ID, 'missing'])]),
    /keyless-owner legacy escrow/);
  for (const tx of [
    raw(retiredIntent, XSWAP_INTENTS_ABI, 'refund', [ID]),
    raw(legacyAsk, XSWAP_ASKS_ABI, 'cancel', [ID]),
    raw(retiredAsk, XSWAP_ASKS_ABI, 'withdraw', []),
  ]) await assert.doesNotReject(assertRelayAllowed([tx]));
  const v2 = raw(XSWAP_V2.intents, XSWAP_V2_INTENTS_ABI, 'openWithSiteFee',
    [ID, 1_000_000n, 998_000n, 1000n, ID, 'memo', { minFilled: 0, maxFailBps: 0, minBondBps: 0, trustedOnly: false },
      XSWAP_V2.collector, 10, ID]);
  await assert.rejects(assertRelayAllowed([v2]), /paused until the V2 solver/);
});

test('legacy withdrawal preparation targets the exact older escrow without enabling a new order', async () => {
  const action = tools.find((t) => t.name === 'prepare_xswap_action');
  const oldAsk = XSWAP_LEGACY.asks[1];
  const result = await action.handler({ action: 'withdraw', side: 'in', contract: oldAsk });
  const body = result.content[0].text;
  const data = JSON.parse(body.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.equal(data.transactions.length, 1);
  assert.equal(data.transactions[0].to.toLowerCase(), oldAsk.toLowerCase());
  assert.equal(data.transactions[0].data.slice(0, 10), toFunctionSelector(XSWAP_ASKS_ABI.find((x) => x.name === 'withdraw')));
  await assert.rejects(action.handler({ action: 'withdraw', side: 'in', contract: XSWAP_LEGACY.intents[0] }), /matching the requested side/);
});

test('a known retired intent remains refundable and cannot prepare a new claim', async () => {
  const old = XSWAP_LEGACY.intents[1];
  const action = tools.find((t) => t.name === 'prepare_xswap_action');
  const originalRead = parent.readContract;
  const originalCode = parent.getCode;
  parent.readContract = async ({ address, functionName }) => {
    if (functionName === 'get') return address.toLowerCase() === old.toLowerCase()
      ? { user: OWNER, amount: 1_000_000n, deadline: 1n, bidEnds: 1n, claimedAt: 0n,
        solver: ZERO, ask: 1_000_000n, bond: 0n, state: 0n, want: ID } : null;
    if (functionName === 'owner') return OWNER;
    if (functionName === 'pendingOwner') throw new Error('legacy Ownable');
    if (functionName === 'window') return 1800n;
    if (functionName === 'bondBps') return 10000n;
    throw new Error(`unexpected ${functionName}`);
  };
  parent.getCode = async () => '0x';
  try {
    const result = await action.handler({ action: 'refund', id: ID, contract: old });
    const data = JSON.parse(result.content[0].text.match(/```json\n([\s\S]*?)\n```/)[1]);
    assert.equal(data.transactions[0].to.toLowerCase(), old.toLowerCase());
    assert.equal(data.transactions[0].data.slice(0, 10), toFunctionSelector(XSWAP_INTENTS_ABI.find((x) => x.name === 'refund')));
    await assert.rejects(action.handler({ action: 'claim', id: ID, contract: old, from: OWNER, proof: ID }), /paused on legacy escrow/);
  } finally {
    parent.readContract = originalRead;
    parent.getCode = originalCode;
  }
});
