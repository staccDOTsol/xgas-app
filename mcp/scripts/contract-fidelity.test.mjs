// Offline tests: tool validation and wording follow the deployed contracts (nft-range branch xgas-l4-fleet-deployed,
// xgas-app public/source/XMoney.sol). Every chain read is a stand-in; nothing here signs or sends.
//   node --test scripts/contract-fidelity.test.mjs      (part of npm test)
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, getAddress } from 'viem';
import { FLEET, L3, parent, xgas } from '../src/config.mjs';
import { PAWN_ABI, DROP_FACTORY_ABI } from '../src/fleetAbis.mjs';
import { unwrap } from '../src/registry.mjs';
import { tools as clmmTools, pawnTermsProblems } from '../src/tools/fleetClmm.mjs';
import { tools as dropTools } from '../src/tools/fleetDrops.mjs';
import { tools as pegTools } from '../src/tools/fleetPeg.mjs';
import { tools as bridgeTools } from '../src/tools/bridge.mjs';

const tool = (list, name) => list.find((t) => t.name === name);
const COLLECTION = '0x1234567890123456789012345678901234567890';
const VAULT = '0x9999999999999999999999999999999999999999';
const HOLDER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const WXM = getAddress(FLEET.infra.wrappedXMoney);
const PAWN_DESK = getAddress(FLEET.pawn.desk);
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** Swap a client method for a stand-in for the length of one test. */
async function stubbing(client, methods, fn) {
  const saved = Object.fromEntries(Object.keys(methods).map((k) => [k, client[k]]));
  Object.assign(client, methods);
  try { return await fn(); } finally { Object.assign(client, saved); }
}

// ───────────────────────────── pawn ─────────────────────────────

const DEFAULT_TERMS = { ltvBps: 5000, liqBps: 8000, bountyBps: 500, baseRateBps: 500, slope1Bps: 1000, kinkBps: 8000, slope2Bps: 5000 };

test('pawn terms: exactly StaccpadPawn.createPool\'s checks, nothing looser and nothing stricter', () => {
  assert.deepEqual(pawnTermsProblems(DEFAULT_TERMS), []);
  // The old connector refused these; the contract accepts them.
  assert.deepEqual(pawnTermsProblems({ ...DEFAULT_TERMS, ltvBps: 10000, liqBps: 10000 }), []);
  assert.deepEqual(pawnTermsProblems({ ...DEFAULT_TERMS, baseRateBps: 30000, slope1Bps: 10000, slope2Bps: 10000 }), []);
  // The old connector allowed these; the contract reverts BadTerms.
  assert.match(pawnTermsProblems({ ...DEFAULT_TERMS, baseRateBps: 20000, slope1Bps: 20000, slope2Bps: 10001 }).join(), /at most 50000/);
  assert.match(pawnTermsProblems({ ...DEFAULT_TERMS, ltvBps: 0 }).join(), /more than 0/);
  assert.match(pawnTermsProblems({ ...DEFAULT_TERMS, ltvBps: 8001 }).join(), /at most liq_bps/);
  assert.match(pawnTermsProblems({ ...DEFAULT_TERMS, liqBps: 10001 }).join(), /liq_bps \(10001\) must be at most 10000/);
  assert.match(pawnTermsProblems({ ...DEFAULT_TERMS, bountyBps: 1001 }).join(), /bounty_bps/);
  assert.match(pawnTermsProblems({ ...DEFAULT_TERMS, kinkBps: 10001 }).join(), /kink_bps/);
  assert.match(pawnTermsProblems({ ...DEFAULT_TERMS, slope2Bps: 70000 }).join(), /0 to 65535/);
});

/** A CLMM-launchpad collection whose market is quoted in `quote`; `curve` says whether it answers quoteSell/isCompanion. */
function clmmReads({ quote = WXM, curve = false } = {}) {
  const sorted = [quote, VAULT].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const key = { currency0: sorted[0], currency1: sorted[1], fee: 10000, tickSpacing: 200, hooks: FLEET.clmm.hook };
  const state = { name: 'Test', symbol: 'TST', owner: HOLDER, maxSupply: 100n, mintPrice: 10n ** 16n, buyerMinted: 1n, companionMinted: 1n,
    lpProceedsBps: 5000, lpCompanionPerMint: 1, vault: VAULT, marketBound: true, lockedPositionId: 1n, poolKey: key, quoteToken: quote };
  return async ({ address, functionName }) => {
    if (same(address, PAWN_DESK) && functionName === 'weth') return WXM;
    if (same(address, COLLECTION) && (functionName === 'quoteSell' || functionName === 'isCompanion')) {
      if (!curve) throw new Error('execution reverted');
      return functionName === 'quoteSell' ? 10n ** 15n : false;
    }
    if (same(address, COLLECTION) && functionName in state) return state[functionName];
    throw new Error(`unexpected read ${functionName} on ${address}`);
  };
}
const createArgs = (res) => decodeFunctionData({ abi: PAWN_ABI, data: unwrap(res).data.transactions[0].data }).args;

test('create_pawn_pool refuses terms createPool would revert on, and accepts the full contract range', async () => {
  const create = tool(clmmTools, 'create_pawn_pool');
  await stubbing(xgas, { readContract: clmmReads() }, async () => {
    await assert.rejects(create.handler({ collection: COLLECTION, bounty_bps: 1001 }), /BadTerms.*bounty_bps/);
    await assert.rejects(create.handler({ collection: COLLECTION, base_rate_bps: 30000, slope1_bps: 10000, slope2_bps: 10001 }), /BadTerms.*50000/);
    await assert.rejects(create.handler({ collection: COLLECTION, ltv_bps: 9000, liq_bps: 8000 }), /BadTerms.*at most liq_bps/);
    const ok = await create.handler({ collection: COLLECTION, ltv_bps: 10000, liq_bps: 10000, base_rate_bps: 30000, slope1_bps: 10000, slope2_bps: 10000 });
    const [, curve, terms] = createArgs(ok);
    assert.equal(curve, '0x0000000000000000000000000000000000000000');
    assert.equal(terms.ltvBps, 10000);
    assert.equal(terms.baseRateBps + terms.slope1Bps + terms.slope2Bps, 50000);
  });
});

test('create_pawn_pool curve: only the collection itself, only on a WXM market, only if it answers the curve interface', async () => {
  const create = tool(clmmTools, 'create_pawn_pool');
  await stubbing(xgas, { readContract: clmmReads({ curve: true }) }, async () => {
    await assert.rejects(create.handler({ collection: COLLECTION, curve: OTHER }), /BadCurve/);
    const [, curve] = createArgs(await create.handler({ collection: COLLECTION, curve: COLLECTION }));
    assert.equal(curve, getAddress(COLLECTION));
  });
  await stubbing(xgas, { readContract: clmmReads({ curve: true, quote: OTHER }) }, async () => {
    await assert.rejects(create.handler({ collection: COLLECTION, curve: COLLECTION }), /CurveNeedsWeth/);
    // No curve: the quote token does not matter to createPool.
    await assert.doesNotReject(create.handler({ collection: COLLECTION }));
  });
  await stubbing(xgas, { readContract: clmmReads({ curve: false }) }, async () => {
    await assert.rejects(create.handler({ collection: COLLECTION, curve: COLLECTION }), /does not answer the NGU curve interface/);
  });
});

test('prepare_pawn states the real liquidation split: bounty, debt to the pool, surplus to the ticket holder, shortfall to lenders', async () => {
  const pool = { key: { currency0: WXM, currency1: VAULT, fee: 10000, tickSpacing: 200, hooks: FLEET.clmm.hook }, manager: FLEET.infra.poolManager,
    vault: VAULT, collection: COLLECTION, quoteToken: WXM, curve: '0x0000000000000000000000000000000000000000',
    terms: { ltvBps: 5000, liqBps: 8000, bountyBps: 500, baseRateBps: 500, slope1Bps: 1000, kinkBps: 8000, slope2Bps: 5000 },
    free: 10n ** 18n, totalShares: 10n ** 18n, totalScaled: 0n, index: 10n ** 18n, lastAccrue: 1n };
  const reads = async ({ functionName }) => ({ getPool: pool, totalAssets: 10n ** 18n, borrowed: 0n, rate: [0n, 500n], ownerOf: HOLDER, isApprovedForAll: true })[functionName];
  await stubbing(xgas, { readContract: reads, simulateContract: async () => ({ result: [10n ** 17n, false] }) }, async () => {
    const res = await tool(clmmTools, 'prepare_pawn').handler({ pool_id: 0, token_id: '1', borrower: HOLDER });
    const text = res.content[0].text;
    assert.doesNotMatch(text, /keep nothing beyond the advance/);
    assert.match(text, /liquidator takes a 5\.00% bounty/);
    assert.match(text, /pool takes back the debt/);
    assert.match(text, /surplus goes to whoever holds the ticket/);
    assert.match(text, /lenders absorb the shortfall/);
  });
});

test('CLMM launch text says what a mint locks and that the rest goes to the fleet treasury, not straight to the FanoutSink', async () => {
  const res = await tool(clmmTools, 'launch_clmm_collection').handler({ name: 'Test', symbol: 'TST', max_supply: 10, mint_price_xmoney: '0.01' });
  const text = res.content[0].text;
  assert.match(text, /full-range position/);
  assert.match(text, /unplaced \$xMoney goes back to the collection contract/);
  assert.match(text, /XgasFleetTreasury.*flush\(\)/s);
  assert.doesNotMatch(text, /the rest goes to the xGas FanoutSink/);
});

// ───────────────────────────── drops ─────────────────────────────

test('launch_drop caps protocol_bps at 5000, where StaccDrop reverts (BadBps)', async () => {
  const launch = tool(dropTools, 'launch_drop');
  assert.equal(launch.inputSchema.properties.protocol_bps.maximum, 5000);
  await assert.rejects(launch.handler({ name: 'D', symbol: 'D', max_supply: 10, price_xmoney: '0.01', protocol_bps: 5001 }), /0 to 5000.*BadBps/);
  await assert.rejects(launch.handler({ name: 'D', symbol: 'D', max_supply: 10, price_xmoney: '0.01', protocol_bps: 10000 }), /BadBps/);
  const ok = await launch.handler({ name: 'D', symbol: 'D', max_supply: 10, price_xmoney: '0.01', protocol_bps: 5000 });
  const { args } = decodeFunctionData({ abi: DROP_FACTORY_ABI, data: unwrap(ok).data.transactions[0].data });
  assert.equal(args[0].fanoutBps, 5000);
});

/** A PumpDrop whose ids have run past 3000 after sell-backs (curve ids are minted from nextId and never reused). */
function pumpReads({ nextId, balance, owners }) {
  const state = { name: 'Pump', symbol: 'PMP', owner: OTHER, supply: 5000, minted: 4000, basePrice: 10n ** 15n, finalPrice: 10n ** 16n,
    creatorFeeBps: 250, fanoutBps: 100, perWallet: 0, start: 0, reserve: 10n ** 18n, reserveSupply: 2750, graduated: false,
    currentPrice: 10n ** 16n, progressBps: 8000n, nextId: BigInt(nextId) };
  return async ({ address, functionName, args }) => {
    if (same(address, FLEET.drops.factory) && functionName === 'isLaunch') return true;
    if (functionName === 'balanceOf') return BigInt(balance);
    if (functionName === 'ownerOf') {
      const o = owners[String(args[0])];
      if (!o) throw new Error('ERC721NonexistentToken');
      return o;
    }
    if (functionName in state) return state[functionName];
    throw new Error(`unexpected read ${functionName}`);
  };
}

test('get_drop finds a holder\'s PumpDrop ids past 3000 from Transfer logs, re-checked with ownerOf', async () => {
  const owners = { 12: OTHER, 4500: HOLDER, 4999: HOLDER };
  const logs = [12n, 4500n, 4999n].map((tokenId) => ({ args: { from: '0x0000000000000000000000000000000000000000', to: HOLDER, tokenId } }));
  await stubbing(xgas, { readContract: pumpReads({ nextId: 5001, balance: 2, owners }), getLogs: async () => logs }, async () => {
    const res = await tool(dropTools, 'get_drop').handler({ collection: COLLECTION, holder: HOLDER });
    const h = unwrap(res).data.holder;
    assert.deepEqual(h.ids, ['4500', '4999']);
    assert.equal(h.complete, true);
    assert.equal(h.highest_id_minted, 5000);
    assert.equal(h.method, 'transfer_logs');
  });
});

test('get_drop falls back to an ownerOf scan to nextId - 1, and says when a result is incomplete', async () => {
  const owners = { 3050: HOLDER };
  for (let i = 1; i < 3101; i++) if (!owners[i]) owners[i] = OTHER;
  await stubbing(xgas, { readContract: pumpReads({ nextId: 3101, balance: 1, owners }), getLogs: async () => { throw new Error('logs unavailable'); } }, async () => {
    const h = unwrap(await tool(dropTools, 'get_drop').handler({ collection: COLLECTION, holder: HOLDER })).data.holder;
    assert.deepEqual(h.ids, ['3050']);
    assert.equal(h.complete, true);
    assert.equal(h.method, 'owner_of_scan');
  });
  // balanceOf says 2, only 1 is found: the reply says so instead of passing a partial list off as the whole.
  await stubbing(xgas, { readContract: pumpReads({ nextId: 101, balance: 2, owners: { 50: HOLDER } }), getLogs: async () => [{ args: { tokenId: 50n } }] }, async () => {
    const res = await tool(dropTools, 'get_drop').handler({ collection: COLLECTION, holder: HOLDER });
    const h = unwrap(res).data.holder;
    assert.equal(h.complete, false);
    assert.match(h.note, /balanceOf says 2/);
    assert.match(res.content[0].text, /holds 2 \(1 found/);
  });
});

// ───────────────────────────── vault bridge ─────────────────────────────

/** The deployed vault, at r/s = 1: 1000 USDG against 1000 circulating xMoney, gas prepay 100k gas at 1 gwei. */
const vaultReads = async ({ functionName }) => ({
  inbox: L3.inbox, l3GasLimit: 100_000n, l3MaxFeePerGas: 1_000_000_000n,
  getReserveNAV: [10n ** 18n, 1_000_000_000n, 1000n * 10n ** 18n],
})[functionName];

test('quote_enter follows the deployed vault: full net credit, the gas prepay minted unbacked on top, and its effect on r/s', async () => {
  const quote = tool(bridgeTools, 'quote_enter');
  await stubbing(parent, { readContract: vaultReads }, () => stubbing(xgas, { getBlock: async () => ({ baseFeePerGas: 100_000_000n }) }, async () => {
    const small = unwrap(await quote.handler({ usdg_amount: '1' })).data;
    assert.equal(small.route, 'vault');
    assert.equal(small.amounts.guaranteed_credit, small.amounts.minted_xmoney); // l2CallValue is the whole net amount
    assert.equal(small.amounts.unbacked_gas_mint, '0.0001');
    assert.equal(small.r_over_s.direction, 'lowers');
    assert.equal(small.r_over_s.break_even_minted_xmoney, '2');
    assert.match(small.unbacked_gas_mint_note, /no USDG behind it.*lowers r\/s.*no upper bound/s);
    // estimated = net + the refunded part of the prepay (100k gas prepaid, ~21.2k used at 0.1 gwei)
    assert.equal(BigInt(small.raw.estimated_wei), BigInt(small.raw.net_minted_wei) + 10n ** 14n - 21_200n * 100_000_000n);
    const big = unwrap(await quote.handler({ usdg_amount: '10000' })).data;
    assert.equal(big.r_over_s.direction, 'raises');
    const text = (await quote.handler({ usdg_amount: '1' })).content[0].text;
    assert.match(text, /Unbacked gas mint/);
    assert.doesNotMatch(text, /would revert/);
  }));
});

// ───────────────────────────── peg ─────────────────────────────

test('create_peg_market does not claim one market per collection: PegFactory opens a new vault on every call', async () => {
  const reads = async ({ functionName }) => ({ name: 'Coll', symbol: 'COL', vaultsOf: [VAULT] })[functionName];
  await stubbing(xgas, { readContract: reads, getCode: async () => '0x6080' }, async () => {
    const text = (await tool(pegTools, 'create_peg_market').handler({ collection: COLLECTION, price_per_nft_xmoney: '1' })).content[0].text;
    assert.doesNotMatch(text, /One market per/);
    assert.match(text, /Every call opens a new vault and pool/);
    assert.match(text, /already has 1 peg market/);
  });
});
