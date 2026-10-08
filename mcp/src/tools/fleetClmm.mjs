// CLMM launchpad and pawn on the xGas L4 (staccpad fleet):
//   launchpad — launch an ERC-721 whose mint proceeds and companion NFTs are locked as liquidity in its own
//               CLMM market (StaccpadHook pools on the xGas PoolManager), quoted in wrapped xMoney (WXM).
//   pawn      — borrow WXM against an NFT from a lender pool priced by that CLMM market (or an NFT NGU curve).
import { encodeFunctionData, isAddress, getAddress, parseAbiItem } from 'viem';
import { XGAS_CHAIN_ID, xgas, FLEET } from '../config.mjs';
import { CLMM_LAUNCHPAD_ABI, CLMM_COLLECTION_ABI, PAWN_ABI, WXM_ABI } from '../fleetAbis.mjs';
import { fmtXMoney, parseXMoney } from '../money.mjs';
import { prepared, renderApproval, reply } from '../approval.mjs';
import { untrusted } from '../untrusted.mjs';

const addr = { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' };
const BPS = 10000n;
const NOT_LIVE = `The staccpad fleet is not in this deployment file for xGas ${XGAS_CHAIN_ID}.`;
const C = () => FLEET?.clmm || null;
const PAWN = () => FLEET?.pawn?.desk || null;
const WXM = () => FLEET?.infra?.wrappedXMoney;
const col = (a, fn, args = []) => xgas.readContract({ address: a, abi: CLMM_COLLECTION_ABI, functionName: fn, args });
const pawn = (fn, args = []) => xgas.readContract({ address: PAWN(), abi: PAWN_ABI, functionName: fn, args });
const isqrt = (n) => { if (n < 2n) return n; let x = n, y = (x + 1n) >> 1n; while (y < x) { x = y; y = (x + n / x) >> 1n; } return x; };
const LAUNCHED = parseAbiItem('event CollectionLaunched(address indexed collection, address indexed creator, address vault, bytes32 poolId, uint16 lpProceedsBps, uint16 lpCompanionPerMint)');
const ERC721_APPROVE = [{ type: 'function', name: 'setApprovalForAll', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'bool' }], outputs: [] },
  { type: 'function', name: 'isApprovedForAll', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] }];

async function launches() {
  const from = BigInt(FLEET?.clmm?.fromBlock ?? 0);
  const logs = await xgas.getLogs({ address: C().launchpad, event: LAUNCHED, fromBlock: from, toBlock: 'latest' });
  return logs.map((l) => ({ collection: l.args.collection, creator: l.args.creator, vault: l.args.vault, poolId: l.args.poolId })).reverse();
}

async function collectionState(a) {
  const fns = ['name', 'symbol', 'owner', 'maxSupply', 'mintPrice', 'buyerMinted', 'companionMinted', 'lpProceedsBps', 'lpCompanionPerMint', 'vault', 'marketBound', 'lockedPositionId'];
  const v = await Promise.all(fns.map((f) => col(a, f)));
  const s = Object.fromEntries(fns.map((f, i) => [f, v[i]]));
  return {
    collection: a, name: untrusted(s.name, 64), symbol: untrusted(s.symbol, 24), creator: s.owner,
    mint_price_xmoney: fmtXMoney(s.mintPrice), mint_price_wei: s.mintPrice, minted: Number(s.buyerMinted), max_supply: Number(s.maxSupply),
    remaining: Number(s.maxSupply - s.buyerMinted), sold_out: s.buyerMinted >= s.maxSupply, companions_in_pool: Number(s.companionMinted),
    lp_proceeds_bps: Number(s.lpProceedsBps), companions_per_mint: Number(s.lpCompanionPerMint), vault: s.vault, market_bound: s.marketBound,
    locked_position: s.lockedPositionId.toString(),
    how_it_works: `${(Number(s.lpProceedsBps) / 100).toFixed(0)}% of every mint plus ${s.lpCompanionPerMint} companion NFT(s) per mint are locked forever as liquidity in this collection's own CLMM market (quoted in wrapped xMoney); the rest goes to the xGas FanoutSink.`,
  };
}

async function poolState(id) {
  const p = await pawn('getPool', [BigInt(id)]);
  const [assets, borrowed, [utilBps, rateBps]] = await Promise.all([pawn('totalAssets', [BigInt(id)]), pawn('borrowed', [BigInt(id)]), pawn('rate', [BigInt(id)])]);
  return {
    pool_id: Number(id), collection: p.collection, vault: p.vault, quote_token: p.quoteToken, curve: p.curve === '0x0000000000000000000000000000000000000000' ? null : p.curve,
    lendable_xmoney: fmtXMoney(p.free), total_assets_xmoney: fmtXMoney(assets), borrowed_xmoney: fmtXMoney(borrowed),
    utilisation_pct: (Number(utilBps) / 100).toFixed(2), borrow_apr_pct: (Number(rateBps) / 100).toFixed(2),
    ltv_pct: (p.terms.ltvBps / 100).toFixed(2), liquidation_at_pct: (p.terms.liqBps / 100).toFixed(2), liquidator_bounty_pct: (p.terms.bountyBps / 100).toFixed(2),
    raw: { key: p.key },
  };
}

const wrapSteps = (owner, amount, spender, label) => [
  { label: `Wrap ${fmtXMoney(amount)} xMoney into WXM`, chainId: XGAS_CHAIN_ID, to: WXM(), data: encodeFunctionData({ abi: WXM_ABI, functionName: 'deposit' }), value: amount },
  { label: `Approve ${label} to pull the WXM`, chainId: XGAS_CHAIN_ID, to: WXM(), data: encodeFunctionData({ abi: WXM_ABI, functionName: 'approve', args: [spender, amount] }), value: 0n },
];

export const tools = [
  {
    name: 'list_clmm_collections',
    description: 'Collections launched on xGas through the staccpad CLMM launchpad (mint proceeds and companion NFTs locked as liquidity in the collection\'s own market), newest first. Read-only.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false },
    async handler({ limit = 20 }) {
      if (!C()) return reply(NOT_LIVE, { collections: [] });
      const all = await launches();
      const rows = await Promise.all(all.slice(0, limit).map((l) => collectionState(l.collection).catch((e) => ({ collection: l.collection, error: e.shortMessage || e.message }))));
      if (!rows.length) return reply(`The CLMM launchpad ${C().launchpad} is live; nothing launched yet.`, { collections: [] });
      return reply(`${rows.length} of ${all.length} CLMM collection(s):\n${rows.map((r) => r.error ? `  ${r.collection}: unreadable` : `  ${r.symbol} ${r.collection}: ${r.minted}/${r.max_supply} minted at ${r.mint_price_xmoney} $xMoney`).join('\n')}`, { launchpad: C().launchpad, total: all.length, collections: rows });
    },
  },

  {
    name: 'get_clmm_collection',
    description: 'State of one CLMM-launchpad collection: price, supply, how much of each mint is locked as liquidity. Read-only.',
    inputSchema: { type: 'object', properties: { collection: addr }, required: ['collection'], additionalProperties: false },
    async handler({ collection }) {
      if (!C()) throw new Error(NOT_LIVE);
      if (!isAddress(collection)) throw new Error(`Not an address: ${collection}`);
      if (!(await launches()).some((l) => l.collection.toLowerCase() === collection.toLowerCase())) throw new Error(`${collection} was not launched by the xGas CLMM launchpad.`);
      const s = await collectionState(getAddress(collection));
      return reply(`${s.name} (${s.symbol}): ${s.minted}/${s.max_supply} minted at ${s.mint_price_xmoney} $xMoney.\n${s.how_it_works}`, s);
    },
  },

  {
    name: 'launch_clmm_collection',
    description: 'Prepare an unsigned CLMM-launchpad launch on xGas: a new ERC-721 at a fixed mint price whose proceeds (20-100%) and companion NFTs are locked forever as liquidity in its own wrapped-xMoney market. Signs nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 64 }, symbol: { type: 'string', minLength: 1, maxLength: 16 }, base_uri: { type: 'string', maxLength: 256 },
        max_supply: { type: 'integer', minimum: 1, maximum: 100000 }, mint_price_xmoney: { type: 'string' },
        lp_proceeds_bps: { type: 'integer', minimum: 2000, maximum: 10000, description: 'Share of each mint locked as liquidity. Default 5000.' },
        companions_per_mint: { type: 'integer', minimum: 1, maximum: 100, description: 'Companion NFTs minted into the pool per mint. Default 1.' },
        royalty_bps: { type: 'integer', minimum: 0, maximum: 1000 },
        creator: { ...addr, description: 'Royalty receiver; defaults to the signer only if given. Required for royalties.' },
      },
      required: ['name', 'symbol', 'max_supply', 'mint_price_xmoney'], additionalProperties: false,
    },
    async handler(a) {
      if (!C()) throw new Error(NOT_LIVE);
      const price = parseXMoney(a.mint_price_xmoney);
      if (price <= 0n) throw new Error('mint_price_xmoney must be > 0.');
      const sqrtP = isqrt((price << 192n) / 10n ** 18n); // quote per claim, opened at the mint price
      const market = { collection: '0x0000000000000000000000000000000000000000', quoteToken: WXM(), fee: 10000, tickSpacing: 200, initialSqrtPriceX96: sqrtP, platformFeeBps: 50, snipeFeeBps: 100, claimName: `v${a.symbol}`.slice(0, 16), claimSymbol: `v${a.symbol}`.slice(0, 16), allowedIdsRoot: `0x${'0'.repeat(64)}`, minBalance: 0n };
      const p0 = {
        name: a.name, symbol: a.symbol, baseURI: a.base_uri ?? '', maxSupply: BigInt(a.max_supply), mintPrice: price, mintMerkleRoot: `0x${'0'.repeat(64)}`,
        minBalanceToken: '0x0000000000000000000000000000000000000000', minBalance: 0n, royaltyReceiver: a.creator && isAddress(a.creator) ? a.creator : '0x0000000000000000000000000000000000000000',
        royaltyBps: BigInt(a.creator ? (a.royalty_bps ?? 500) : 0), lpProceedsBps: a.lp_proceeds_bps ?? 5000, lpCompanionPerMint: a.companions_per_mint ?? 1,
        holderCollections: [], holderMinBalances: [], market, quoteTokens: [WXM()], initialSqrtPriceX96: [sqrtP],
        seaDrop: { enabled: false, mintPrice: 0n, startTime: 0, endTime: 0, maxTotalMintableByWallet: 0, feeBps: 0, feeRecipient: '0x0000000000000000000000000000000000000000', dropURI: '' },
      };
      const p = prepared({
        action: `Launch ${a.symbol} on the CLMM launchpad`, chainId: XGAS_CHAIN_ID, to: C().launchpad,
        data: encodeFunctionData({ abi: CLMM_LAUNCHPAD_ABI, functionName: 'launch', args: [p0] }), value: 0n,
        asset: 'none (gas only)', amount: `${a.max_supply} NFTs at ${a.mint_price_xmoney} $xMoney`, counterparty: `staccpad CLMM launchpad ${C().launchpad}`,
        fees: [{ label: 'Launch fee', amount: 'none', note: `${((a.lp_proceeds_bps ?? 5000) / 100).toFixed(0)}% of each mint is locked as liquidity, the rest goes to the xGas FanoutSink` }],
        net: 'A new collection you own, with its market opened at the mint price', timeline: ['One transaction on xGas'],
        irreversible: 'Locked liquidity can never be withdrawn by anyone. Mint price and LP split are fixed at launch.', notes: ['Liquidity adds pay the xGas PoolManager JIT toll; the router sizes for it.'],
      });
      return reply(renderApproval(p), p);
    },
  },

  {
    name: 'prepare_clmm_mint',
    description: 'Prepare an unsigned mint on a CLMM-launchpad collection; optionally deposit some of the minted NFTs straight back as your own withdrawable liquidity. Signs nothing.',
    inputSchema: { type: 'object', properties: { collection: addr, qty: { type: 'integer', minimum: 1, maximum: 20 }, deposit_qty: { type: 'integer', minimum: 0, maximum: 20, description: 'Of the minted, how many to deposit as your own full-range LP (costs mint price each on top). Default 0.' } }, required: ['collection', 'qty'], additionalProperties: false },
    async handler({ collection, qty, deposit_qty = 0 }) {
      if (!C()) throw new Error(NOT_LIVE);
      if (!isAddress(collection)) throw new Error(`Not an address: ${collection}`);
      if (deposit_qty > qty) throw new Error('deposit_qty cannot exceed qty.');
      const s = await collectionState(getAddress(collection));
      if (s.remaining < qty) return reply(`Only ${s.remaining} left.`, { ...s, blocked: 'not_enough_left' });
      const value = s.mint_price_wei * BigInt(qty + deposit_qty);
      const data = deposit_qty
        ? encodeFunctionData({ abi: CLMM_COLLECTION_ABI, functionName: 'mint', args: [BigInt(qty), BigInt(deposit_qty), []] })
        : encodeFunctionData({ abi: CLMM_COLLECTION_ABI, functionName: 'mint', args: [BigInt(qty), []] });
      const p = prepared({
        action: `Mint ${qty} ${s.symbol}${deposit_qty ? ` and LP ${deposit_qty} of them` : ''}`, chainId: XGAS_CHAIN_ID, to: s.collection, data, value,
        asset: `native $xMoney → ${s.symbol} NFTs`, amount: `${qty} at ${s.mint_price_xmoney}${deposit_qty ? ` + ${deposit_qty} × ${s.mint_price_xmoney} quote for your LP` : ''} = ${fmtXMoney(value)} $xMoney`,
        counterparty: `${s.name} at ${s.collection}`, fees: [{ label: 'Included', amount: s.how_it_works }],
        net: `${qty - deposit_qty} NFT(s)${deposit_qty ? ` and an LP position holding ${deposit_qty}` : ''}`, timeline: ['One transaction on xGas'],
        irreversible: 'Primary mints are final; the locked share of your payment stays in the pool forever.', notes: [],
      });
      return reply(renderApproval(p), p);
    },
  },

  {
    name: 'list_pawn_pools',
    description: 'Pawn lending pools on xGas (staccpad pawn): borrow wrapped xMoney against an NFT priced by its CLMM market or NFT NGU curve. Shows lendable liquidity, APR, LTV and liquidation threshold. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      if (!PAWN()) return reply(NOT_LIVE, { pools: [] });
      const n = Number(await pawn('poolsLength'));
      const pools = await Promise.all(Array.from({ length: n }, (_, i) => poolState(i)));
      if (!pools.length) return reply(`The pawn desk ${PAWN()} is live; no lending pools yet. create_pawn_pool opens one for a CLMM market.`, { desk: PAWN(), pools: [] });
      return reply(pools.map((p) => `  pool ${p.pool_id} ${p.collection}: ${p.lendable_xmoney} lendable, APR ${p.borrow_apr_pct}%, LTV ${p.ltv_pct}%, liquidates at ${p.liquidation_at_pct}%`).join('\n'), { desk: PAWN(), pools });
    },
  },

  {
    name: 'create_pawn_pool',
    description: 'Prepare an unsigned creation of a pawn lending pool for a CLMM-launchpad collection\'s market, with its loan terms. Signs nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: addr, ltv_bps: { type: 'integer', minimum: 1, maximum: 9000, description: 'Default 5000.' }, liq_bps: { type: 'integer', minimum: 1, maximum: 10000, description: 'Default 8000.' },
        bounty_bps: { type: 'integer', minimum: 0, maximum: 1000, description: 'Default 500.' }, base_rate_bps: { type: 'integer', minimum: 0, maximum: 20000, description: 'Default 500.' },
        slope1_bps: { type: 'integer', minimum: 0, maximum: 20000, description: 'Default 1000.' }, kink_bps: { type: 'integer', minimum: 0, maximum: 10000, description: 'Default 8000.' }, slope2_bps: { type: 'integer', minimum: 0, maximum: 20000, description: 'Default 5000.' },
      },
      required: ['collection'], additionalProperties: false,
    },
    async handler(a) {
      if (!PAWN()) throw new Error(NOT_LIVE);
      const s = await collectionState(getAddress(a.collection));
      if (!s.market_bound) throw new Error('That collection has no bound CLMM market yet.');
      const key = await col(s.collection, 'poolKey');
      const t = { ltvBps: a.ltv_bps ?? 5000, liqBps: a.liq_bps ?? 8000, bountyBps: a.bounty_bps ?? 500, baseRateBps: a.base_rate_bps ?? 500, slope1Bps: a.slope1_bps ?? 1000, kinkBps: a.kink_bps ?? 8000, slope2Bps: a.slope2_bps ?? 5000 };
      if (t.ltvBps > t.liqBps) throw new Error('ltv_bps must be ≤ liq_bps.');
      const p = prepared({
        action: `Open a pawn pool for ${s.symbol}`, chainId: XGAS_CHAIN_ID, to: PAWN(),
        data: encodeFunctionData({ abi: PAWN_ABI, functionName: 'createPool', args: [key, '0x0000000000000000000000000000000000000000', t] }), value: 0n,
        asset: 'none (gas only)', amount: `LTV ${t.ltvBps / 100}%, liquidation at ${t.liqBps / 100}%`, counterparty: `staccpad pawn desk ${PAWN()}`,
        fees: [{ label: 'Fee', amount: 'none' }], net: 'An empty lending pool; lenders fund it with prepare_pawn_lend', timeline: ['One transaction on xGas'],
        irreversible: 'Terms are fixed for the pool\'s life.', notes: [],
      });
      return reply(renderApproval(p), p);
    },
  },

  {
    name: 'prepare_pawn_lend',
    description: 'Prepare unsigned steps to lend $xMoney into a pawn pool (wrap to WXM, approve, deposit for shares). Signs nothing.',
    inputSchema: { type: 'object', properties: { pool_id: { type: 'integer', minimum: 0 }, amount_xmoney: { type: 'string' }, lender: addr }, required: ['pool_id', 'amount_xmoney', 'lender'], additionalProperties: false },
    async handler({ pool_id, amount_xmoney, lender }) {
      if (!PAWN()) throw new Error(NOT_LIVE);
      const p0 = await poolState(pool_id);
      const amt = parseXMoney(amount_xmoney);
      const p = prepared({
        action: `Lend ${amount_xmoney} $xMoney into pawn pool ${pool_id}`,
        steps: [...wrapSteps(lender, amt, PAWN(), 'the pawn desk'), { label: `Deposit into pool ${pool_id}`, chainId: XGAS_CHAIN_ID, to: PAWN(), data: encodeFunctionData({ abi: PAWN_ABI, functionName: 'deposit', args: [BigInt(pool_id), amt] }), value: 0n }],
        asset: 'native $xMoney → pool shares', amount: `${amount_xmoney} $xMoney`, counterparty: `pawn pool ${pool_id} (${p0.collection})`,
        fees: [{ label: 'Fee', amount: 'none' }], net: `shares earning the borrow APR (now ${p0.borrow_apr_pct}%)`, timeline: ['Wrap', 'Approve', 'Deposit'],
        irreversible: 'Withdrawals are limited to what is not lent out. If a liquidation sells for less than the debt, lenders absorb the gap.', notes: [],
      });
      return reply(renderApproval(p), p);
    },
  },

  {
    name: 'prepare_pawn',
    description: 'Prepare unsigned steps to pawn one NFT: approve the desk, then borrow LTV × its live floor in WXM and receive a transferable ticket. Signs nothing.',
    inputSchema: { type: 'object', properties: { pool_id: { type: 'integer', minimum: 0 }, token_id: { type: 'string', pattern: '^[0-9]+$' }, borrower: addr, slippage_bps: { type: 'integer', minimum: 0, maximum: 2000 } }, required: ['pool_id', 'token_id', 'borrower'], additionalProperties: false },
    async handler({ pool_id, token_id, borrower, slippage_bps = 200 }) {
      if (!PAWN()) throw new Error(NOT_LIVE);
      const p0 = await poolState(pool_id);
      const id = BigInt(token_id);
      const owner = await xgas.readContract({ address: p0.collection, abi: ERC721_APPROVE, functionName: 'ownerOf', args: [id] }).catch(() => null);
      if (!owner || owner.toLowerCase() !== borrower.toLowerCase()) return reply(`${borrower} does not hold #${token_id}. Nothing prepared.`, { blocked: 'not_owner' });
      const { result: [floor] } = await xgas.simulateContract({ address: PAWN(), abi: PAWN_ABI, functionName: 'floorOf', args: [BigInt(pool_id), id], account: borrower });
      const advance = (floor * BigInt(Math.round(Number(p0.ltv_pct) * 100))) / BPS;
      const minAdvance = (advance * (BPS - BigInt(slippage_bps))) / BPS;
      const approved = await xgas.readContract({ address: p0.collection, abi: ERC721_APPROVE, functionName: 'isApprovedForAll', args: [borrower, PAWN()] });
      const steps = [];
      if (!approved) steps.push({ label: 'Approve the pawn desk for this collection', chainId: XGAS_CHAIN_ID, to: p0.collection, data: encodeFunctionData({ abi: ERC721_APPROVE, functionName: 'setApprovalForAll', args: [PAWN(), true] }), value: 0n });
      steps.push({ label: `Pawn #${token_id}`, chainId: XGAS_CHAIN_ID, to: PAWN(), data: encodeFunctionData({ abi: PAWN_ABI, functionName: 'pawn', args: [BigInt(pool_id), id, minAdvance] }), value: 0n });
      const p = prepared({
        action: `Pawn #${token_id} in pool ${pool_id}`, steps, asset: 'NFT → WXM (wrapped xMoney) loan', amount: `about ${fmtXMoney(advance)} WXM against a floor of ${fmtXMoney(floor)}`,
        counterparty: `pawn pool ${pool_id}`, fees: [{ label: 'Interest', amount: `${p0.borrow_apr_pct}% APR, floating with utilisation` }],
        net: `${fmtXMoney(advance)} WXM and a ticket NFT that redeems your NFT`, timeline: steps.map((s) => s.label),
        irreversible: `If the debt reaches ${p0.liquidation_at_pct}% of the floor, anyone can liquidate: your NFT is sold and you keep nothing beyond the advance.`, notes: ['WXM unwraps 1:1 to $xMoney via WrappedXMoney.withdraw.'],
      });
      return reply(renderApproval(p), { ...p, quote: { floor_xmoney: fmtXMoney(floor), advance_xmoney: fmtXMoney(advance) } });
    },
  },

  {
    name: 'prepare_pawn_redeem',
    description: 'Prepare unsigned steps to repay a pawn ticket in full and take the NFT back (wrap, approve with a small interest buffer, redeem). Ticket holder only. Signs nothing.',
    inputSchema: { type: 'object', properties: { ticket_id: { type: 'string', pattern: '^[0-9]+$' }, holder: addr }, required: ['ticket_id', 'holder'], additionalProperties: false },
    async handler({ ticket_id, holder }) {
      if (!PAWN()) throw new Error(NOT_LIVE);
      const id = BigInt(ticket_id);
      const owner = await pawn('ownerOf', [id]).catch(() => null);
      if (!owner || owner.toLowerCase() !== holder.toLowerCase()) return reply(`${holder} does not hold ticket ${ticket_id}.`, { blocked: 'not_ticket_owner' });
      const debt = await pawn('debtOf', [id]);
      const budget = debt + debt / 1000n + 1n; // interest accrues per second until the tx lands
      const p = prepared({
        action: `Redeem pawn ticket ${ticket_id}`,
        steps: [...wrapSteps(holder, budget, PAWN(), 'the pawn desk'), { label: `Redeem ticket ${ticket_id}`, chainId: XGAS_CHAIN_ID, to: PAWN(), data: encodeFunctionData({ abi: PAWN_ABI, functionName: 'redeem', args: [id] }), value: 0n }],
        asset: '$xMoney → your NFT back', amount: `debt ${fmtXMoney(debt)} (wrapping ${fmtXMoney(budget)} to cover interest until it lands)`, counterparty: `pawn desk ${PAWN()}`,
        fees: [{ label: 'Interest', amount: 'included in the debt' }], net: 'Your NFT; unused WXM stays in your wallet (unwrap with WrappedXMoney.withdraw)', timeline: ['Wrap', 'Approve', 'Redeem'],
        irreversible: 'The ticket is burned.', notes: [],
      });
      return reply(renderApproval(p), p);
    },
  },
];
