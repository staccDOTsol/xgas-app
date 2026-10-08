// NFT NGU on the xGas L4: bonding-curve NFT collections from the staccpad fleet (nft-range NguFactory).
// Price only steps up; every NFT redeems against the curve's vault at min(floor, last price) less a 6% exit fee.
import { encodeFunctionData, decodeEventLog, isAddress, getAddress } from 'viem';
import { XGAS_CHAIN_ID, xgas, FLEET, ZERO } from '../config.mjs';
import { NFT_NGU_FACTORY_ABI, NFT_NGU_COLLECTION_ABI, NFT_NGU_LIMITS as LIM } from '../fleetAbis.mjs';
import { fmtXMoney, parseXMoney } from '../money.mjs';
import { pct } from '../nguRisk.mjs';
import { prepared, renderApproval, reply, submitFields } from '../approval.mjs';
import { submitRaw } from '../idempotency.mjs';
import { untrusted } from '../untrusted.mjs';

const addr = { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' };
const BPS = 10000n;
const NOT_LIVE = `The staccpad fleet is not in this deployment file for xGas ${XGAS_CHAIN_ID} (no live \`fleet\` block), so there is no NFT NGU factory to read.`;

const factory = () => FLEET?.ngu?.factory || null;
const col = (a, fn, args = []) => xgas.readContract({ address: a, abi: NFT_NGU_COLLECTION_ABI, functionName: fn, args });
const fac = (fn, args = []) => xgas.readContract({ address: factory(), abi: NFT_NGU_FACTORY_ABI, functionName: fn, args });

async function assertCollection(a) {
  if (!isAddress(a)) throw new Error(`Not an address: ${a}`);
  if (!factory()) throw new Error(NOT_LIVE);
  // Asked of the factory, never of the collection: anyone can deploy a look-alike.
  const ok = await fac('isNgu', [a]);
  if (!ok) throw new Error(`${a} was not launched by the xGas NFT NGU factory ${factory()}. Nothing prepared.`);
  return getAddress(a);
}

// Live worst case for a buyer who sells straight back: pay nextPrice, then redeem at
// min(vault/supply after the buy, that price) less the 6% exit fee.
function worstCase(s) {
  const p = s.nextPrice;
  if (p === 0n) return null;
  const v = s.vault + p - (p * BigInt(s.buyProtocolBps)) / BPS - (p * BigInt(s.lpBps)) / BPS;
  const sup = s.supply + 1n;
  const nav = v / sup;
  const base = nav > p ? p : nav;
  const payout = (base * (BPS - BigInt(LIM.SELL_FEE_BPS))) / BPS;
  const lossBps = Number(((p - payout) * BPS) / p);
  return { lossBps, payout };
}

async function state(a, holder) {
  const fns = ['name', 'symbol', 'floor', 'nextPrice', 'lastPrice', 'basePrice', 'vault', 'supply', 'minted', 'maxSupply',
    'stepBps', 'betaBps', 'buyProtocolBps', 'sellProtocolBps', 'lpBps', 'companionsPerMint', 'companionsLive', 'seedQty', 'owner'];
  const vals = await Promise.all(fns.map((f) => col(a, f)));
  const s = Object.fromEntries(fns.map((f, i) => [f, vals[i]]));
  const wc = worstCase(s);
  const out = {
    collection: a,
    name: untrusted(s.name, 64),
    symbol: untrusted(s.symbol, 24),
    creator: s.owner,
    worst_case_loss_bps: wc?.lossBps ?? null,
    worst_case_loss_pct: wc ? pct(wc.lossBps) : null,
    worst_case_basis: 'live: buy 1 at the next price, redeem it straight back at min(floor after the buy, that price) less the 6% exit fee',
    next_price_xmoney: fmtXMoney(s.nextPrice),
    floor_xmoney: fmtXMoney(s.floor),
    last_price_xmoney: fmtXMoney(s.lastPrice),
    base_price_xmoney: fmtXMoney(s.basePrice),
    vault_xmoney: fmtXMoney(s.vault),
    redeemable_supply: s.supply.toString(),
    minted: s.minted.toString(),
    max_supply: s.maxSupply.toString(),
    remaining: (s.maxSupply - s.minted).toString(),
    sold_out: s.minted >= s.maxSupply,
    step_bps: Number(s.stepBps),
    beta_bps: Number(s.betaBps),
    buy_protocol_bps: Number(s.buyProtocolBps),
    sell_protocol_bps: Number(s.sellProtocolBps),
    lp_bps: Number(s.lpBps),
    companions_per_mint: Number(s.companionsPerMint),
    companions_live: s.companionsLive.toString(),
    fees: `buy: ${(Number(s.buyProtocolBps) / 100).toFixed(2)}% protocol (to the xGas FanoutSink)${Number(s.lpBps) ? ` + ${(Number(s.lpBps) / 100).toFixed(2)}% locked as LP for the buyer` : ''}; redeem: 6% exit fee, ${(Number(s.sellProtocolBps) / 100).toFixed(2)}% of the price to protocol and the rest stays in the vault for holders`,
    raw: { nextPrice: s.nextPrice, floor: s.floor, minted: s.minted, maxSupply: s.maxSupply, seedQty: s.seedQty, companionsPerMint: s.companionsPerMint },
  };
  if (holder && isAddress(holder)) out.holder = { address: holder, ...(await holdings(a, holder, s)) };
  return out;
}

// No enumeration on-chain: walk the ids minted so far and ask ownerOf. Burned (redeemed) ids revert and are skipped.
async function holdings(a, holder, s) {
  const n = Number(s.minted);
  const cap = Math.min(n, 2000);
  const ids = [];
  for (let i = 0; i < cap; i++) {
    const base = s.seedQty > BigInt(i) ? BigInt(i) : s.seedQty + (BigInt(i) - s.seedQty) * (1n + BigInt(s.companionsPerMint));
    ids.push(base);
    for (let c = 1n; BigInt(i) >= s.seedQty && c <= BigInt(s.companionsPerMint); c++) ids.push(base + c);
  }
  const owned = [];
  for (let i = 0; i < ids.length; i += 60) {
    const chunk = ids.slice(i, i + 60);
    const owners = await Promise.all(chunk.map((id) => col(a, 'ownerOf', [id]).catch(() => null)));
    owners.forEach((o, j) => { if (o && o.toLowerCase() === holder.toLowerCase()) owned.push(chunk[j]); });
  }
  const companions = owned.filter((id) => BigInt(id) >= s.seedQty && (BigInt(id) - s.seedQty) % (1n + BigInt(s.companionsPerMint)) !== 0n);
  const redeemable = owned.filter((id) => !companions.includes(id));
  return { redeemable_ids: redeemable.map(String), companion_ids: companions.map(String), scanned_buyer_mints: cap, truncated: n > cap };
}

function wholeQty(q) {
  const n = Number(q);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${q} is not a positive whole number of NFTs.`);
  if (n > LIM.MAX_PER_TX) throw new Error(`The contract caps ${LIM.MAX_PER_TX} NFTs per transaction; split it.`);
  return BigInt(n);
}

const riskLine = (s) => s.worst_case_loss_pct ? `worst case if you buy one and redeem it straight back: ${s.worst_case_loss_pct}` : 'no price yet';

export const tools = [
  {
    name: 'list_nft_ngus',
    description: 'Every NFT NGU collection (bonding-curve NFTs that only step up in price, each redeemable against its vault) launched on the xGas L4 by the staccpad fleet factory, newest first, with worst-case loss, next price, floor and remaining supply. Read-only.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 20.' } }, additionalProperties: false },
    async handler({ limit = 20 }) {
      if (!factory()) return reply(NOT_LIVE, { factory: null, collections: [] });
      const n = Number(await fac('allCollectionsLength'));
      const idx = Array.from({ length: n }, (_, i) => n - 1 - i).slice(0, limit);
      const addrs = await Promise.all(idx.map((i) => fac('allCollections', [BigInt(i)])));
      const cols = await Promise.all(addrs.map((a) => state(a).catch((e) => ({ collection: a, error: e.shortMessage || e.message }))));
      if (!cols.length) return reply(`The NFT NGU factory ${factory()} is live; nothing has been launched on it yet.`, { factory: factory(), collections: [] });
      const lines = cols.map((c) => c.error ? `  ${c.collection}: unreadable (${c.error})`
        : `  ${c.symbol} ${c.collection}: next ${c.next_price_xmoney}, floor ${c.floor_xmoney}, ${c.remaining}/${c.max_supply} left; ${riskLine(c)}`);
      return reply(`${cols.length} of ${n} NFT NGU collection(s) on xGas:\n${lines.join('\n')}`, { factory: factory(), total: n, collections: cols });
    },
  },

  {
    name: 'get_nft_ngu',
    description: 'Full state of one NFT NGU collection: worst-case loss first, then prices, vault, supply, fees, and (optionally) which token ids a holder owns and can redeem. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { collection: addr, holder: { ...addr, description: 'Optional: list the ids this address holds (redeemable vs LP companions).' } },
      required: ['collection'],
      additionalProperties: false,
    },
    async handler({ collection, holder }) {
      const a = await assertCollection(collection);
      const s = await state(a, holder);
      const h = s.holder ? `\n${holder} holds ${s.holder.redeemable_ids.length} redeemable${s.holder.companion_ids.length ? ` and ${s.holder.companion_ids.length} LP companion` : ''} NFT(s)${s.holder.redeemable_ids.length ? `: ${s.holder.redeemable_ids.slice(0, 20).join(', ')}${s.holder.redeemable_ids.length > 20 ? ', …' : ''}` : ''}.` : '';
      return reply(`${s.name} (${s.symbol}). ${riskLine(s)}.\nNext ${s.next_price_xmoney} $xMoney, floor ${s.floor_xmoney}, vault ${s.vault_xmoney}. ${s.minted}/${s.max_supply} minted${s.sold_out ? ', SOLD OUT' : ''}.\nFees: ${s.fees}.${h}`, s);
    },
  },

  {
    name: 'quote_nft_ngu_buy',
    description: 'Total $xMoney for minting `qty` NFTs from an NFT NGU curve right now, price by price, with the live worst case. Read-only.',
    inputSchema: { type: 'object', properties: { collection: addr, qty: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['collection', 'qty'], additionalProperties: false },
    async handler({ collection, qty }) {
      const a = await assertCollection(collection);
      const q = wholeQty(qty);
      const s = await state(a);
      if (s.sold_out) return reply(`${s.symbol} is sold out.`, { ...s, blocked: 'sold_out' });
      if (BigInt(s.minted) + q > BigInt(s.max_supply)) return reply(`Only ${s.remaining} left; ${qty} would revert.`, { ...s, blocked: 'not_enough_left' });
      const cost = await col(a, 'quoteBuy', [q]);
      return reply(`${qty} ${s.symbol} cost ${fmtXMoney(cost)} $xMoney (${fmtXMoney(cost / q)} average). ${riskLine(s)}.`, { collection: a, qty, cost_xmoney: fmtXMoney(cost), cost_wei: cost, ...s });
    },
  },

  {
    name: 'prepare_nft_ngu_buy',
    description: 'Prepare an unsigned mint of `qty` NFTs on an NFT NGU curve. Overpayment is refunded by the contract, so the value carries a small buffer. Signs nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: addr,
        qty: { type: 'integer', minimum: 1, maximum: 50 },
        to: { ...addr, description: 'Who receives the NFTs. Defaults to the signer.' },
        buffer_bps: { type: 'integer', minimum: 0, maximum: 2000, description: 'Extra value above the quote, refunded if unused. Default 100 (1%).' },
      },
      required: ['collection', 'qty'],
      additionalProperties: false,
    },
    async handler({ collection, qty, to, buffer_bps = 100 }) {
      const a = await assertCollection(collection);
      const q = wholeQty(qty);
      const s = await state(a);
      if (s.sold_out) return reply(`${s.symbol} is sold out. Nothing prepared.`, { ...s, blocked: 'sold_out' });
      const cost = await col(a, 'quoteBuy', [q]);
      const value = cost + (cost * BigInt(buffer_bps)) / BPS;
      const p = prepared({
        action: `Mint ${qty} ${s.symbol} on its NFT NGU curve`,
        chainId: XGAS_CHAIN_ID,
        to: a,
        data: encodeFunctionData({ abi: NFT_NGU_COLLECTION_ABI, functionName: 'buy', args: [q, to && isAddress(to) ? to : ZERO] }),
        value,
        asset: `native $xMoney → ${s.symbol} NFTs (${a})`,
        amount: `${qty} NFT(s) for ${fmtXMoney(cost)} $xMoney`,
        counterparty: `the curve itself: ${s.name} at ${a}`,
        fees: [
          { label: 'Protocol', amount: `${fmtXMoney((cost * BigInt(s.buy_protocol_bps)) / BPS)} xMoney`, note: `${(s.buy_protocol_bps / 100).toFixed(2)}%, to the xGas FanoutSink` },
          ...(s.lp_bps ? [{ label: 'Locked LP (yours)', amount: `${fmtXMoney((cost * BigInt(s.lp_bps)) / BPS)} xMoney`, note: `${(s.lp_bps / 100).toFixed(2)}% plus ${s.companions_per_mint} companion NFT(s) per mint, locked forever as liquidity; you get the fee receipt` }] : []),
        ],
        net: `${qty} ${s.symbol} NFT(s), each redeemable now at about ${s.floor_xmoney} $xMoney before the 6% exit fee`,
        timeline: ['One transaction on xGas'],
        irreversible: `${riskLine(s)}, fees included. The price you pay is above the floor by design; only the floor is protected (the contract reverts rather than let it drop).`,
        notes: [`Value carries a ${buffer_bps}bps buffer (${fmtXMoney(value - cost)} xMoney) in case someone mints ahead of you; the contract refunds the rest.`],
      });
      return reply(renderApproval(p), { ...p, quote: { cost_xmoney: fmtXMoney(cost), value_sent: fmtXMoney(value), worst_case_loss_pct: s.worst_case_loss_pct } });
    },
  },

  {
    name: 'quote_nft_ngu_sell',
    description: 'Payout for redeeming `qty` NFTs back to an NFT NGU curve now (min(floor, last price) less the 6% exit fee). Read-only.',
    inputSchema: { type: 'object', properties: { collection: addr, qty: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['collection', 'qty'], additionalProperties: false },
    async handler({ collection, qty }) {
      const a = await assertCollection(collection);
      const q = wholeQty(qty);
      const s = await state(a);
      const payout = await col(a, 'quoteSell', [q]);
      const minOut = (payout * 9950n) / BPS;
      return reply(`Redeeming ${qty} ${s.symbol} pays ${fmtXMoney(payout)} $xMoney. Suggested minOut at 0.5%: ${fmtXMoney(minOut)}.`,
        { collection: a, qty, payout_xmoney: fmtXMoney(payout), payout_wei: payout, suggested_min_out_wei: minOut, floor_xmoney: s.floor_xmoney, note: 'LP companion NFTs cannot be redeemed; they live in the pool.' });
    },
  },

  {
    name: 'prepare_nft_ngu_sell',
    description: 'Prepare an unsigned redemption of specific NFT NGU token ids back to the curve, with an explicit minOut. Use get_nft_ngu with `holder` to find redeemable ids. Signs nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: addr,
        token_ids: { type: 'array', items: { type: 'string', pattern: '^[0-9]+$' }, minItems: 1, maxItems: 50 },
        seller: { ...addr, description: 'The address that holds the ids; checked against ownerOf.' },
        to: { ...addr, description: 'Who receives the $xMoney. Defaults to the signer.' },
        slippage_bps: { type: 'integer', minimum: 0, maximum: 1000, description: 'Tolerance below the quote for minOut. Default 50.' },
      },
      required: ['collection', 'token_ids', 'seller'],
      additionalProperties: false,
    },
    async handler({ collection, token_ids, seller, to, slippage_bps = 50 }) {
      const a = await assertCollection(collection);
      if (!isAddress(seller)) throw new Error(`Not an address: ${seller}`);
      const ids = [...new Set(token_ids.map((x) => BigInt(x)))];
      const [owners, comp] = await Promise.all([
        Promise.all(ids.map((id) => col(a, 'ownerOf', [id]).catch(() => null))),
        Promise.all(ids.map((id) => col(a, 'isCompanion', [id]))),
      ]);
      const bad = ids.filter((_, i) => !owners[i] || owners[i].toLowerCase() !== seller.toLowerCase());
      if (bad.length) return reply(`${seller} does not hold id(s) ${bad.join(', ')} (or they were already redeemed). Nothing prepared.`, { blocked: 'not_owner', ids: bad.map(String) });
      const companions = ids.filter((_, i) => comp[i]);
      if (companions.length) return reply(`Id(s) ${companions.join(', ')} are LP companions and can never redeem on the curve. Nothing prepared.`, { blocked: 'companion', ids: companions.map(String) });
      const s = await state(a);
      const payout = await col(a, 'quoteSell', [BigInt(ids.length)]);
      const minOut = (payout * (BPS - BigInt(slippage_bps))) / BPS;
      const p = prepared({
        action: `Redeem ${ids.length} ${s.symbol} back to its NFT NGU curve`,
        chainId: XGAS_CHAIN_ID,
        to: a,
        data: encodeFunctionData({ abi: NFT_NGU_COLLECTION_ABI, functionName: 'sell', args: [ids, to && isAddress(to) ? to : ZERO, minOut] }),
        value: 0n,
        asset: `${s.symbol} NFTs → native $xMoney`,
        amount: `ids ${ids.join(', ')} for about ${fmtXMoney(payout)} $xMoney (at least ${fmtXMoney(minOut)})`,
        counterparty: `the curve itself: ${s.name} at ${a}`,
        fees: [{ label: 'Exit fee', amount: '6% of the redemption basis', note: `${(s.sell_protocol_bps / 100).toFixed(2)}% to the xGas FanoutSink, the rest stays in the vault for the remaining holders` }],
        net: `${fmtXMoney(payout)} $xMoney`,
        timeline: ['One transaction on xGas; the NFTs are burned'],
        irreversible: 'Redeemed NFTs are burned. The curve never re-mints an id.',
        notes: [`minOut is ${slippage_bps}bps under the quote; the transaction reverts rather than pay less.`],
      });
      return reply(renderApproval(p), { ...p, quote: { payout_xmoney: fmtXMoney(payout), min_out_xmoney: fmtXMoney(minOut) } });
    },
  },

  {
    name: 'launch_nft_ngu',
    description: 'Prepare an unsigned launch of a new NFT NGU collection on xGas through the staccpad fleet factory. Economics are fixed forever at launch. Signs nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 64 },
        symbol: { type: 'string', minLength: 1, maxLength: 16 },
        base_uri: { type: 'string', maxLength: 256, description: 'Token metadata base URI, e.g. ipfs://…/ (tokenURI = base + id).' },
        max_supply: { type: 'integer', minimum: 1, maximum: 100000 },
        base_price_xmoney: { type: 'string', description: 'Price of NFT #0 in $xMoney, e.g. "0.01".' },
        step_bps: { type: 'integer', minimum: 0, maximum: LIM.MAX_STEP_BPS, description: 'Price step per mint. 100 = +1% each. Default 100.' },
        beta_bps: { type: 'integer', minimum: LIM.MIN_BETA_BPS, maximum: LIM.MAX_BETA_BPS, description: 'Floor protection: price ≥ floor/β. Default 9000.' },
        seed_qty: { type: 'integer', minimum: 0, maximum: 1000, description: 'NFTs minted to you at genesis, backed by seed_xmoney. Default 0.' },
        seed_xmoney: { type: 'string', description: 'xMoney sent with the launch to back the seed NFTs. Default "0".' },
        royalty_bps: { type: 'integer', minimum: 0, maximum: 1000, description: 'ERC-2981 royalty on secondary sales. Default 500.' },
        buy_protocol_bps: { type: 'integer', minimum: 0, maximum: LIM.MAX_BUY_PROTOCOL_BPS, description: 'Protocol slice of each mint. Default 100 (1%).' },
        sell_protocol_bps: { type: 'integer', minimum: 0, maximum: LIM.SELL_FEE_BPS, description: 'Protocol slice of each redemption, out of the 6% exit fee. Default 300.' },
        lp_bps: { type: 'integer', minimum: 0, maximum: LIM.MAX_LP_BPS, description: 'Slice of each mint locked as liquidity for the minter. 0 = no pool. Default 0.' },
        companions_per_mint: { type: 'integer', minimum: 0, maximum: LIM.MAX_COMPANIONS, description: 'Companion NFTs per mint placed in the pool; 1..10 when lp_bps > 0, else 0.' },
      },
      required: ['name', 'symbol', 'max_supply', 'base_price_xmoney'],
      additionalProperties: false,
    },
    async handler(a) {
      if (!factory()) throw new Error(NOT_LIVE);
      const step = a.step_bps ?? 100, beta = a.beta_bps ?? 9000, buyP = a.buy_protocol_bps ?? 100, sellP = a.sell_protocol_bps ?? 300;
      const lp = a.lp_bps ?? 0, comp = a.companions_per_mint ?? (lp > 0 ? 1 : 0);
      if ((lp > 0) !== (comp > 0)) throw new Error('lp_bps and companions_per_mint go together: both 0, or lp_bps > 0 with 1..10 companions.');
      if (beta + buyP + lp > 10000) throw new Error(`beta_bps + buy_protocol_bps + lp_bps must be ≤ 10000; got ${beta + buyP + lp}.`);
      const seedQty = BigInt(a.seed_qty ?? 0);
      if (seedQty > BigInt(a.max_supply)) throw new Error('seed_qty exceeds max_supply.');
      const basePrice = parseXMoney(a.base_price_xmoney);
      if (basePrice <= 0n) throw new Error('base_price_xmoney must be > 0.');
      const seedValue = parseXMoney(a.seed_xmoney ?? '0');
      const params = {
        name: a.name, symbol: a.symbol, baseURI: a.base_uri ?? '', maxSupply: BigInt(a.max_supply), basePrice, stepBps: step, betaBps: beta,
        seedQty, royaltyBps: BigInt(a.royalty_bps ?? 500), buyProtocolBps: buyP, sellProtocolBps: sellP, lpBps: lp, companionsPerMint: comp,
        seaDrop: { enabled: false, startTime: 0, endTime: 0, maxTotalMintableByWallet: 0, feeBps: 0, feeRecipient: ZERO, dropURI: '' },
        extraPools: [],
      };
      // First buyer's worst case at genesis, same basis as get_nft_ngu.
      const wc = worstCase({ nextPrice: seedQty > 0n && seedValue > 0n ? basePrice : basePrice, vault: seedValue, supply: seedQty, buyProtocolBps: buyP, lpBps: lp });
      const p = prepared({
        action: `Launch NFT NGU collection ${a.symbol}`,
        chainId: XGAS_CHAIN_ID,
        to: factory(),
        data: encodeFunctionData({ abi: NFT_NGU_FACTORY_ABI, functionName: 'launch', args: [params] }),
        value: seedValue,
        asset: 'native $xMoney (the seed, if any)',
        amount: seedValue ? `${fmtXMoney(seedValue)} $xMoney backing ${seedQty} genesis NFTs` : 'no value: an empty curve',
        counterparty: `staccpad NFT NGU factory ${factory()}`,
        fees: [{ label: 'Launch fee', amount: 'none', note: `${(buyP / 100).toFixed(2)}% of every mint and ${(sellP / 100).toFixed(2)}% of every redemption go to the xGas FanoutSink` }],
        net: `A new ERC-721 you own, ${a.max_supply} max supply, first mint at ${a.base_price_xmoney} $xMoney`,
        timeline: ['One transaction on xGas; the collection address comes back in the NguLaunched event'],
        irreversible: `Fixed forever: max supply ${a.max_supply}, base price ${a.base_price_xmoney}, step ${step}bps, β ${beta}bps, fees ${buyP}/${sellP}bps, LP ${lp}bps. The first buyer's worst case, buying one and redeeming it straight back: ${wc ? pct(wc.lossBps) : 'n/a'}.`,
        notes: ['No OpenSea SeaDrop stage on xGas (SeaDrop is not deployed on this chain).', ...(lp ? ['With an LP slice, every mint also opens or deepens the collection\'s pool on the xGas PoolManager, which charges its JIT toll on LP adds.'] : [])],
      });
      return reply(renderApproval(p), p);
    },
  },

  {
    name: 'find_nft_ngu_launch',
    description: 'Read the collection address out of a confirmed NFT NGU launch transaction. Read-only.',
    inputSchema: { type: 'object', properties: { tx_hash: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' } }, required: ['tx_hash'], additionalProperties: false },
    async handler({ tx_hash }) {
      const r = await xgas.getTransactionReceipt({ hash: tx_hash });
      for (const l of r.logs) {
        if (l.address.toLowerCase() !== String(factory()).toLowerCase()) continue;
        try { const e = decodeEventLog({ abi: NFT_NGU_FACTORY_ABI, ...l }); if (e.eventName === 'NguLaunched') return reply(`Launched: ${e.args.collection}`, { collection: e.args.collection, creator: e.args.creator, block: Number(r.blockNumber) }); } catch { /* other event */ }
      }
      return reply(`No NguLaunched event from the factory in ${tx_hash}.`, { collection: null, status: r.status });
    },
  },

  {
    name: 'submit_fleet',
    description: 'Broadcast any signed staccpad-fleet transaction on xGas (NFT NGU launch, mint, redeem).',
    inputSchema: { type: 'object', properties: { ...submitFields }, required: ['signed_tx', 'idempotency_key'], additionalProperties: false },
    async handler({ signed_tx, idempotency_key }) {
      const res = await submitRaw({ chainId: XGAS_CHAIN_ID, signedTx: signed_tx, idempotencyKey: idempotency_key, kind: 'fleet' });
      return reply(res.replayed ? `Already submitted under this key: ${res.hash}.` : `Sent on xGas: ${res.hash}.`, res);
    },
  },
];
