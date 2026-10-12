import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, encodeFunctionData, serializeTransaction, toFunctionSelector } from 'viem';
import { XSWAP, XSWAP_LEGACY, XSWAP_V2, ZERO, isXswapLegacy, parent } from '../src/config.mjs';
import { ERC20_ABI, XSWAP_INTENTS_ABI, XSWAP_ASKS_ABI, XSWAP_V2_INTENTS_ABI, XSWAP_V2_ASKS_ABI } from '../src/abis.mjs';
import { assertRelayAllowed, tools } from '../src/tools/xswap.mjs';
import {
  assertXSwapV2NewOrdersEnabled, evaluateXSwapV2Gate, resetXSwapV2Gate, xswapV2Gate, xswapV2GrossFor, xswapV2InFloor,
  xswapV2OutFunding, xswapV2TermsHash,
} from '../src/xswapV2.mjs';
import { instructions } from '../src/server.mjs';

const ID = `0x${'11'.repeat(32)}`;
const OWNER = '0x1111111111111111111111111111111111111111';
const EXPOSED = '0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158';
const ROTATED = '0x7777777777777777777777777777777777777777';
// The pause is opt-in: these tests switch it on the way an operator would, with XSWAP_V2_EXPOSED on the host.
process.env.XSWAP_V2_EXPOSED = `${EXPOSED}:2026-10-03`;
const isV2 = (a) => [XSWAP_V2.intents, XSWAP_V2.asks].includes(String(a).toLowerCase());

/** Answer owner() on the V2 escrows with `owner`; everything else goes to the real chain unless `extra` answers it. */
async function withV2Owner(owner, fn, extra = () => undefined) {
  const originalRead = parent.readContract;
  parent.readContract = async (q) => {
    if (q.functionName === 'owner' && isV2(q.address)) return owner;
    const x = await extra(q);
    return x === undefined ? originalRead.call(parent, q) : x;
  };
  resetXSwapV2Gate();
  try { return await fn(); } finally { parent.readContract = originalRead; resetXSwapV2Gate(); }
}
const tool = (name) => tools.find((t) => t.name === name);
/** Run fn with XSWAP_V2_OWNER pinned, as an operator would after a rotation. */
async function withPin(owner, fn) {
  const prev = process.env.XSWAP_V2_OWNER;
  process.env.XSWAP_V2_OWNER = owner;
  resetXSwapV2Gate();
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.XSWAP_V2_OWNER; else process.env.XSWAP_V2_OWNER = prev;
    resetXSwapV2Gate();
  }
}
// server.mjs reads the live gate at import; let that read land before any test stubs owner().
await xswapV2Gate().catch(() => {});
const OUT_ARGS = { from: OWNER, xmoney_amount: '1', chain: 'base', amount: '0.0001', to: OWNER };
const IN_ARGS = { from: OWNER, want_xmoney: '1', chain: 'base', amount: '0.0001' };
const raw = (to, abi, functionName, args) => serializeTransaction({ type: 'legacy', chainId: 4663,
  nonce: 0n, gas: 400000n, gasPrice: 1n, to, value: 0n,
  data: encodeFunctionData({ abi, functionName, args }) });

test('deployed V2 is separate from every legacy escrow and the source-owned new-order gate is open', async () => {
  assert.equal(XSWAP.enabled, false); // deployment.json still says enabled:true for 5D/a999: legacy stays exit-only
  assert.equal(XSWAP_V2.enabled, true);
  assert.doesNotThrow(() => assertXSwapV2NewOrdersEnabled());
  for (const address of [...XSWAP_LEGACY.intents, ...XSWAP_LEGACY.asks]) assert.equal(isXswapLegacy(address), true);
  assert.equal(isXswapLegacy(XSWAP_V2.intents), false);
  assert.equal(isXswapLegacy(XSWAP_V2.asks), false);
  // Legacy prepare paths never reopen, whatever V2 says.
  for (const address of [...XSWAP_LEGACY.intents, ...XSWAP_LEGACY.asks]) assert.notEqual(address.toLowerCase(), XSWAP_V2.intents);
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

test('raw relay denies legacy funding, gates V2 new orders on the owner, and preserves legacy cleanup', async () => {
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
  const approveV2 = raw(XSWAP.xmoney, ERC20_ABI, 'approve', [XSWAP_V2.intents, 1n]);
  // While the escrows' owner is the exposed key, neither the open nor the approval for it is relayed.
  await withV2Owner(EXPOSED, async () => {
    for (const tx of [v2, approveV2]) await assert.rejects(assertRelayAllowed([tx]), /submit_xswap.*refused: XSwap is paused for new swaps.*exposed.*Nothing was sent/s);
  });
  // Ownership moved off the deployed owner and nobody pinned the new one: a takeover looks like a rotation, so stay closed.
  await withV2Owner(ROTATED, async () => {
    await assert.rejects(assertRelayAllowed([v2]), /pins XSWAP_V2_OWNER=.*Nothing was sent/s);
  });
  // Once the operator pins the new owner, the same transactions pass the gate and the live runtime verification.
  await withPin(ROTATED, () => withV2Owner(ROTATED, async () => {
    await assert.doesNotReject(assertRelayAllowed([v2]));
    await assert.doesNotReject(assertRelayAllowed([approveV2]));
  }));
});

test('gate decision: closed for the exposed key, a keyless or split owner, an unreadable read or a pin mismatch', () => {
  const g = (o) => evaluateXSwapV2Gate({ enabled: true, pinned: null, ...o });
  assert.equal(g({ intentsOwner: EXPOSED, asksOwner: EXPOSED }).code, 'owner_exposed');
  assert.equal(g({ intentsOwner: EXPOSED.toLowerCase(), asksOwner: EXPOSED }).open, false);
  assert.match(g({ intentsOwner: EXPOSED, asksOwner: EXPOSED }).reason, /exposed since 2026-10-03.*reopen.*once ownership moves/s);
  assert.equal(g({ intentsOwner: ZERO, asksOwner: ZERO }).code, 'owner_unusable');
  assert.equal(g({ intentsOwner: '0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38', asksOwner: '0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38' }).code, 'owner_unusable');
  assert.equal(g({ intentsOwner: ROTATED, asksOwner: OWNER }).code, 'owners_differ');
  assert.equal(g({ intentsOwner: null, asksOwner: null, readError: 'timeout' }).code, 'owner_unreadable');
  assert.equal(g({ intentsOwner: ROTATED, asksOwner: ROTATED, enabled: false }).code, 'switched_off');
  assert.equal(g({ intentsOwner: ROTATED, asksOwner: ROTATED, pinned: OWNER }).code, 'owner_not_pinned');
  assert.equal(g({ intentsOwner: ROTATED, asksOwner: ROTATED }).code, 'owner_unpinned');
  const open = g({ intentsOwner: ROTATED, asksOwner: ROTATED, pinned: ROTATED });
  assert.equal(open.open, true);
  assert.equal(open.owner, ROTATED);
  assert.equal(g({ intentsOwner: ROTATED, asksOwner: ROTATED, pinned: ROTATED }).open, true);
});

test('gate flips with owner(): every new-swap path refuses while it is the exposed key, and the cache follows the chain', async () => {
  await withV2Owner(EXPOSED, async () => {
    assert.equal((await xswapV2Gate()).code, 'owner_exposed');
    await assert.rejects(tool('prepare_xswap_out').handler(OUT_ARGS), /prepare_xswap_out refused: XSwap is paused for new swaps.*Nothing was prepared/s);
    await assert.rejects(tool('prepare_xswap_in').handler(IN_ARGS), /prepare_xswap_in refused: XSwap is paused for new swaps.*Nothing was prepared/s);
    const line = instructions(await xswapV2Gate()).split('\n').find((l) => l.includes('another chain'));
    assert.match(line, /XSwap is paused for new swaps on this connector/);
    assert.match(line, /exposed since 2026-10-03/);
    assert.match(line, /Do not offer it as a route/);
  });
  await withV2Owner(ROTATED, async () => {
    assert.equal((await xswapV2Gate()).code, 'owner_not_pinned');
  });
  await withPin(ROTATED, () => withV2Owner(ROTATED, async () => {
    const gate = await xswapV2Gate();
    assert.equal(gate.open, true);
    const line = instructions(gate).split('\n').find((l) => l.includes('another chain'));
    assert.match(line, /`prepare_xswap_out`/);
    assert.doesNotMatch(line, /paused/);
  }));
  // Before any read the instructions fail closed.
  resetXSwapV2Gate();
  assert.match(instructions(), /XSwap is paused for new swaps on this connector/);
});

test('while paused, V2 bid/claim/accept/delivered refuse and refund, cancel, settle and withdraw still prepare', async () => {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const intent = (deadline) => ({ user: OWNER, amount: 1_000_000n, escrowed: 1_001_000n, protocolBps: 50, openedBondBps: 10000,
    challengeWindow: 1800n, protocolTreasury: XSWAP_V2.treasury, siteFeeRecipient: XSWAP_V2.collector, siteFeeBps: 10,
    deadline, bidEnds: deadline, claimedAt: 0n, solver: ZERO, ask: 1_000_000n, bond: 0n, state: 0,
    want: ID, policy: { minFilled: 0, maxFailBps: 0, minBondBps: 0, trustedOnly: false } });
  const ask = { seller: OWNER, floorPay: 1_000_000n, minSellerNet: 990_000n, protocolBps: 50, openedBondBps: 2500,
    challengeWindow: 1800n, protocolTreasury: XSWAP_V2.treasury, siteFeeRecipient: XSWAP_V2.collector, siteFeeBps: 10,
    deadline: now - 10n, bidEnds: now - 100n, deliveredAt: 0n, buyer: ZERO, pay: 0n, bond: 0n, state: 0, give: ID };
  const stub = (deadline) => async ({ address, functionName }) => {
    if (functionName === 'get') {
      if (address.toLowerCase() === XSWAP_V2.intents) return intent(deadline);
      if (address.toLowerCase() === XSWAP_V2.asks) return null;
      return null; // legacy escrows: not found
    }
    if (functionName === 'window') return 1800n;
    if (functionName === 'bondBps') return 10000n;
    if (functionName === 'pendingOwner') throw new Error('plain Ownable');
    return undefined;
  };
  const originalCode = parent.getCode;
  parent.getCode = async ({ address }) => (address.toLowerCase() === EXPOSED.toLowerCase() ? '0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b' : originalCode.call(parent, { address }));
  try {
    await withV2Owner(EXPOSED, async () => {
      for (const action of ['bid', 'claim', 'accept']) {
        await assert.rejects(tool('prepare_xswap_action').handler({ id: ID, action, contract: XSWAP_V2.intents, from: OWNER, ask: '0.5', proof: ID }),
          new RegExp(`prepare_xswap_action ${action} refused: XSwap is paused for new swaps`));
      }
      const r = await tool('prepare_xswap_action').handler({ id: ID, action: 'refund', contract: XSWAP_V2.intents });
      const data = JSON.parse(r.content[0].text.match(/```json\n([\s\S]*?)\n```/)[1]);
      assert.equal(data.transactions[0].to.toLowerCase(), XSWAP_V2.intents);
      assert.equal(data.transactions[0].data.slice(0, 10), toFunctionSelector(XSWAP_V2_INTENTS_ABI.find((x) => x.name === 'refund')));
      const st = await tool('prepare_xswap_action').handler({ id: ID, action: 'settle', contract: XSWAP_V2.intents });
      assert.match(st.content[0].text, /Settle: the window has passed/);
      const w = await tool('prepare_xswap_action').handler({ action: 'withdraw', side: 'out', contract: XSWAP_V2.intents });
      assert.match(w.content[0].text, /Pull everything this escrow owes you/);
    }, stub(now - 10n));
    await withV2Owner(EXPOSED, async () => {
      for (const action of ['cancel']) {
        const res = await tool('prepare_xswap_action').handler({ id: ID, action, contract: XSWAP_V2.asks });
        assert.match(res.content[0].text, /Cancel this ask/);
      }
      await assert.rejects(tool('prepare_xswap_action').handler({ id: ID, action: 'delivered', contract: XSWAP_V2.asks, proof: ID }),
        /prepare_xswap_action delivered refused: XSwap is paused for new swaps/);
    }, async ({ address, functionName }) => {
      if (functionName === 'get') return address.toLowerCase() === XSWAP_V2.asks ? ask : null;
      if (functionName === 'window') return 1800n;
      if (functionName === 'bondBps') return 2500n;
      if (functionName === 'pendingOwner') throw new Error('plain Ownable');
      return undefined;
    });
  } finally {
    parent.getCode = originalCode;
  }
});

test('xswap_reputation reports rep.failed as disputes lost by the solver, not as failed jobs', async () => {
  await withV2Owner(EXPOSED, async () => {
    const res = await tool('xswap_reputation').handler({ address: OWNER });
    const data = JSON.parse(res.content[0].text.match(/```json\n([\s\S]*?)\n```/)[1]);
    assert.equal(data.solver_disputes_lost, 1);
    assert.equal(data.payer_disputes_lost, 2);
    assert.equal(data.solver_disputes_lost_bps, 2500);
    assert.equal('failed' in data, false);
    assert.match(res.content[0].text, /1 dispute lost as a solver/);
    assert.match(res.content[0].text, /never delivered are not recorded/);
  }, ({ functionName }) => (functionName === 'rep' ? [3n, 1n, 4n, 2n, 2n, 3_000_000n, 1_700_000_000n] : undefined));
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

test('by default (no pause set on the host) XSwap is open on the deployed owner, and closed if owner() moves elsewhere', async () => {
  const prev = process.env.XSWAP_V2_EXPOSED;
  delete process.env.XSWAP_V2_EXPOSED;
  try {
    await withV2Owner(EXPOSED, async () => {
      const gate = await xswapV2Gate();
      assert.equal(gate.open, true, gate.reason);
      assert.doesNotMatch(instructions(gate).split('\n').find((l) => l.includes('another chain')), /paused/);
    });
    await withV2Owner(ROTATED, async () => { assert.equal((await xswapV2Gate()).code, 'owner_not_pinned'); });
  } finally { process.env.XSWAP_V2_EXPOSED = prev; resetXSwapV2Gate(); }
});
