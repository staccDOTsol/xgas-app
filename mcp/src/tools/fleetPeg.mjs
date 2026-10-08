// Peg markets on the xGas L4 (staccpad fleet PegFactory): any ERC-721 becomes a vault of fungible claims plus
// Uniswap-v4-style pools on the xGas PoolManager. Buy the floor NFT or a specific id for $xMoney, or sell an NFT
// straight into the pool. Quotes come from V4Quoter against the real (tolled) PoolManager, so they include the toll.
import { encodeFunctionData, isAddress, getAddress, parseAbi } from 'viem';
import { XGAS_CHAIN_ID, xgas, FLEET, ZERO } from '../config.mjs';
import { PEG_FACTORY_ABI, PEG_ROUTER_ABI, PEG_VAULT_ABI, V4_QUOTER_ABI } from '../fleetAbis.mjs';
import { fmtXMoney, parseXMoney } from '../money.mjs';
import { prepared, renderApproval, reply } from '../approval.mjs';
import { untrusted } from '../untrusted.mjs';

const addr = { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' };
const BPS = 10000n;
const isqrt = (n) => { if (n < 2n) return n; let x = n, y = (x + 1n) >> 1n; while (y < x) { x = y; y = (x + n / x) >> 1n; } return x; };
const ERC721 = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)', 'function ownerOf(uint256) view returns (address)',
  'function isApprovedForAll(address,address) view returns (bool)', 'function getApproved(uint256) view returns (address)', 'function setApprovalForAll(address,bool)']);
const NOT_LIVE = `The staccpad fleet is not in this deployment file for xGas ${XGAS_CHAIN_ID}, so there are no peg markets to read.`;
const F = () => FLEET?.peg || null;
const pf = (fn, args = []) => xgas.readContract({ address: F().factory, abi: PEG_FACTORY_ABI, functionName: fn, args });
const pv = (v, fn, args = []) => xgas.readContract({ address: v, abi: PEG_VAULT_ABI, functionName: fn, args });

async function nativePool(vault) {
  const pids = await pf('poolsOf', [vault]);
  if (!pids.length) return null;
  const keys = await Promise.all(pids.map((p) => pf('getPoolKey', [p])));
  const i = keys.findIndex((k) => k.currency0.toLowerCase() === ZERO);
  return i < 0 ? null : { poolId: pids[i], key: keys[i] };
}

async function assertVault(v) {
  if (!F()) throw new Error(NOT_LIVE);
  if (!isAddress(v)) throw new Error(`Not an address: ${v}`);
  const pids = await pf('poolsOf', [v]);
  if (!pids.length) throw new Error(`${v} is not a vault of the xGas PegFactory ${F().factory}. Nothing prepared.`);
  return getAddress(v);
}

// V4Quoter reverts internally and returns via eth_call; simulateContract runs it as a call.
async function quote(key, zeroForOne, exactAmount, exactOut) {
  const { result } = await xgas.simulateContract({
    address: FLEET.infra.v4Quoter, abi: V4_QUOTER_ABI, functionName: exactOut ? 'quoteExactOutputSingle' : 'quoteExactInputSingle',
    args: [{ poolKey: key, zeroForOne, exactAmount, hookData: '0x' }],
  });
  return result[0];
}

// V4Quoter reverts when the pool cannot fill a whole NFT's worth; say so in words.
const why = (e) => {
  const name = e?.walk?.((x) => x?.data?.errorName)?.data?.errorName || '';
  if (/NotEnoughLiquidity/i.test(name) || /reverted/i.test(e?.shortMessage || '')) return 'the pool cannot fill one whole NFT at any price yet (not enough liquidity on that side)';
  return e?.shortMessage || e?.message || 'quote failed';
};

async function marketState(vault) {
  const [collection, name, symbol, inventory, platformBps, premiumBps, taxBps, pool] = await Promise.all([
    pv(vault, 'collection'), pv(vault, 'name'), pv(vault, 'symbol'), pv(vault, 'inventoryCount'),
    pv(vault, 'platformFeeBps'), pv(vault, 'snipePremiumBps'), pv(vault, 'taxBps'), nativePool(vault),
  ]);
  const [cName, cSymbol] = await Promise.all([xgas.readContract({ address: collection, abi: ERC721, functionName: 'name' }).catch(() => '?'), xgas.readContract({ address: collection, abi: ERC721, functionName: 'symbol' }).catch(() => '?')]);
  const out = {
    vault, collection, collection_name: untrusted(cName, 64), collection_symbol: untrusted(cSymbol, 24), claim_name: untrusted(name, 64), claim_symbol: untrusted(symbol, 24),
    nfts_in_vault: Number(inventory), platform_fee_bps: Number(platformBps), snipe_premium_bps: Number(premiumBps), transfer_tax_bps: Number(taxBps),
    native_pool: pool ? { pool_id: pool.poolId, fee_pips: Number(pool.key.fee), tick_spacing: Number(pool.key.tickSpacing) } : null,
  };
  if (pool && inventory > 0n) {
    const [floorId, floorClaims, mintUnit] = await Promise.all([pv(vault, 'peekFloor'), pv(vault, 'floorCost'), pv(vault, 'mintUnit')]);
    // native is always currency0; buying claims is zeroForOne (exact out), selling is oneForZero (exact in)
    const [buyCost, sellGet] = await Promise.all([
      quote(pool.key, true, floorClaims, true).catch((e) => { out.buy_quote_error = why(e); return null; }),
      quote(pool.key, false, mintUnit, false).catch((e) => { out.sell_quote_error = why(e); return null; }),
    ]);
    Object.assign(out, {
      floor_token_id: floorId.toString(),
      buy_floor_xmoney: buyCost == null ? null : fmtXMoney(buyCost), buy_floor_wei: buyCost,
      sell_one_xmoney: sellGet == null ? null : fmtXMoney(sellGet), sell_one_wei: sellGet,
      spread_note: 'Quotes are live from V4Quoter on the tolled PoolManager and include the pool fee and toll. They move with every trade.',
    });
  }
  out.raw = { poolKey: pool?.key ?? null };
  return out;
}

export const tools = [
  {
    name: 'list_peg_markets',
    description: 'Every peg market on xGas (staccpad fleet PegFactory): an NFT collection vaulted into fungible claims with a native $xMoney pool. Shows NFTs in the vault and live buy-floor / sell-one quotes. Read-only.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false },
    async handler({ limit = 20 }) {
      if (!F()) return reply(NOT_LIVE, { markets: [] });
      const n = Number(await pf('allVaultsLength'));
      const idx = Array.from({ length: n }, (_, i) => n - 1 - i).slice(0, limit);
      const vaults = await Promise.all(idx.map((i) => pf('allVaults', [BigInt(i)])));
      const markets = await Promise.all(vaults.map((v) => marketState(v).catch((e) => ({ vault: v, error: e.shortMessage || e.message }))));
      if (!markets.length) return reply(`The PegFactory ${F().factory} is live; no markets yet.`, { markets: [] });
      const lines = markets.map((m) => m.error ? `  ${m.vault}: unreadable (${m.error})`
        : `  ${m.collection_symbol} vault ${m.vault}: ${m.nfts_in_vault} NFT(s) inside; floor buy ${m.buy_floor_xmoney ? `${m.buy_floor_xmoney} $xMoney` : 'n/a'}, sell one ${m.sell_one_xmoney ? `${m.sell_one_xmoney} $xMoney` : 'n/a'}`);
      return reply(`${markets.length} of ${n} peg market(s) on xGas:\n${lines.join('\n')}`, { factory: F().factory, total: n, markets });
    },
  },

  {
    name: 'get_peg_market',
    description: 'One peg market by vault address, or every market for a collection address: vault inventory, fees, and live buy-floor / sell-one quotes. Read-only.',
    inputSchema: { type: 'object', properties: { vault: addr, collection: addr }, additionalProperties: false },
    async handler({ vault, collection }) {
      if (!F()) throw new Error(NOT_LIVE);
      const vaults = vault ? [await assertVault(vault)] : collection && isAddress(collection) ? await pf('vaultsOf', [collection]) : [];
      if (!vaults.length) return reply(collection ? `No peg market for ${collection} on xGas yet. create_peg_market opens one.` : 'Pass a vault or a collection address.', { markets: [] });
      const markets = await Promise.all(vaults.map(marketState));
      return reply(markets.map((m) => `${m.collection_name} (${m.collection_symbol}) vault ${m.vault}: ${m.nfts_in_vault} NFT(s) inside; floor buy ${m.buy_floor_xmoney ?? 'n/a'}, sell one ${m.sell_one_xmoney ?? 'n/a'} $xMoney; platform ${m.platform_fee_bps}bps, snipe premium ${m.snipe_premium_bps}bps.`).join('\n'), { markets });
    },
  },

  {
    name: 'prepare_peg_buy_floor',
    description: 'Prepare an unsigned buy of the floor NFT from a peg market for native $xMoney, with a maxQuote guard. Signs nothing.',
    inputSchema: { type: 'object', properties: { vault: addr, receiver: addr, buffer_bps: { type: 'integer', minimum: 0, maximum: 2000, description: 'Default 200; refunded if unused.' } }, required: ['vault', 'receiver'], additionalProperties: false },
    async handler({ vault, receiver, buffer_bps = 200 }) {
      const v = await assertVault(vault);
      const m = await marketState(v);
      if (!m.nfts_in_vault) return reply('The vault is empty; there is no floor NFT to buy.', { ...m, blocked: 'empty' });
      if (m.buy_floor_wei == null) return reply(`No quote: ${m.buy_quote_error || 'the pool has no liquidity on that side'}. Nothing prepared.`, { ...m, blocked: 'no_quote' });
      const maxQuote = m.buy_floor_wei + (m.buy_floor_wei * BigInt(buffer_bps)) / BPS;
      const p = prepared({
        action: `Buy the floor ${m.collection_symbol} (#${m.floor_token_id}) from its peg market`, chainId: XGAS_CHAIN_ID, to: F().router,
        data: encodeFunctionData({ abi: PEG_ROUTER_ABI, functionName: 'buyFloor', args: [m.raw.poolKey, v, maxQuote, receiver] }), value: maxQuote,
        asset: `native $xMoney → ${m.collection_symbol} NFT`, amount: `#${m.floor_token_id} for about ${m.buy_floor_xmoney} $xMoney (at most ${fmtXMoney(maxQuote)})`,
        counterparty: `PegRouter ${F().router} and the ${m.claim_symbol} pool`,
        fees: [{ label: 'Included in the quote', amount: `pool fee + xGas JIT toll + ${(m.platform_fee_bps / 100).toFixed(2)}% platform fee + collection royalty`, note: 'all inside the quoted price' }],
        net: `${m.collection_symbol} #${m.floor_token_id}`, timeline: ['One transaction on xGas'],
        irreversible: 'If someone buys the floor first, the transaction reverts ("fifo race") and you pay only gas.', notes: [`maxQuote carries a ${buffer_bps}bps buffer; the router refunds the rest.`],
      });
      return reply(renderApproval(p), { ...p, quote: { buy_floor_xmoney: m.buy_floor_xmoney, max_quote_xmoney: fmtXMoney(maxQuote) } });
    },
  },

  {
    name: 'prepare_peg_sell',
    description: 'Prepare an unsigned sale of one NFT into its peg market for native $xMoney (vaults it and swaps the claims), with minQuote. Includes the one-time approval step if the router is not approved yet. Signs nothing.',
    inputSchema: { type: 'object', properties: { vault: addr, token_id: { type: 'string', pattern: '^[0-9]+$' }, seller: addr, slippage_bps: { type: 'integer', minimum: 0, maximum: 2000 } }, required: ['vault', 'token_id', 'seller'], additionalProperties: false },
    async handler({ vault, token_id, seller, slippage_bps = 100 }) {
      const v = await assertVault(vault);
      const m = await marketState(v);
      const id = BigInt(token_id);
      const owner = await xgas.readContract({ address: m.collection, abi: ERC721, functionName: 'ownerOf', args: [id] }).catch(() => null);
      if (!owner || owner.toLowerCase() !== seller.toLowerCase()) return reply(`${seller} does not hold #${token_id}. Nothing prepared.`, { blocked: 'not_owner' });
      const pool = await nativePool(v);
      if (!pool) return reply('This market has no native $xMoney pool.', { blocked: 'no_native_pool' });
      const mintUnit = await pv(v, 'mintUnit');
      const got = await quote(pool.key, false, mintUnit, false).catch(() => null);
      if (!got) return reply('No quote: the pool has no $xMoney on the bid side. Nothing prepared.', { ...m, blocked: 'no_bid' });
      const minQuote = (got * (BPS - BigInt(slippage_bps))) / BPS;
      const approved = await xgas.readContract({ address: m.collection, abi: ERC721, functionName: 'isApprovedForAll', args: [seller, F().router] });
      const steps = [];
      if (!approved) steps.push({ label: `Approve the PegRouter for ${m.collection_symbol}`, chainId: XGAS_CHAIN_ID, to: m.collection, data: encodeFunctionData({ abi: ERC721, functionName: 'setApprovalForAll', args: [F().router, true] }), value: 0n });
      steps.push({ label: `Sell #${token_id} into the pool`, chainId: XGAS_CHAIN_ID, to: F().router, data: encodeFunctionData({ abi: PEG_ROUTER_ABI, functionName: 'sell', args: [pool.key, v, id, [], minQuote, seller] }), value: 0n });
      const p = prepared({
        action: `Sell ${m.collection_symbol} #${token_id} into its peg market`, steps,
        asset: `${m.collection_symbol} NFT → native $xMoney`, amount: `about ${fmtXMoney(got)} $xMoney (at least ${fmtXMoney(minQuote)})`,
        counterparty: `PegRouter ${F().router} and the ${m.claim_symbol} pool`,
        fees: [{ label: 'Included in the quote', amount: 'pool fee + xGas JIT toll' }],
        net: `${fmtXMoney(got)} $xMoney`, timeline: steps.map((s) => s.label),
        irreversible: approved ? 'The NFT goes into the vault; buying it back costs the floor or the snipe premium.' : 'The approval lets the PegRouter move any of your NFTs in this collection when you call it. The NFT goes into the vault.',
        notes: [],
      });
      return reply(renderApproval(p), { ...p, quote: { sell_xmoney: fmtXMoney(got), min_quote_xmoney: fmtXMoney(minQuote) } });
    },
  },

  {
    name: 'create_peg_market',
    description: 'Prepare an unsigned creation of a peg market for an existing ERC-721 on xGas: a claim-token vault plus a native $xMoney pool opened at a starting price per NFT. Liquidity is added separately. Signs nothing.',
    inputSchema: {
      type: 'object',
      properties: { collection: addr, price_per_nft_xmoney: { type: 'string', description: 'Starting pool price for one NFT (one 1e18 claim).' }, fee_pips: { type: 'integer', enum: [500, 3000, 10000], description: 'Pool fee: 500 = 0.05%, 3000 = 0.3%, 10000 = 1%. Default 10000.' } },
      required: ['collection', 'price_per_nft_xmoney'], additionalProperties: false,
    },
    async handler({ collection, price_per_nft_xmoney, fee_pips = 10000 }) {
      if (!F()) throw new Error(NOT_LIVE);
      if (!isAddress(collection)) throw new Error(`Not an address: ${collection}`);
      const code = await xgas.getCode({ address: collection });
      if (!code || code === '0x') throw new Error(`Nothing is deployed at ${collection} on xGas.`);
      const [name, symbol] = await Promise.all([xgas.readContract({ address: collection, abi: ERC721, functionName: 'name' }).catch(() => 'NFT'), xgas.readContract({ address: collection, abi: ERC721, functionName: 'symbol' }).catch(() => 'NFT')]);
      const priceWei = parseXMoney(price_per_nft_xmoney);
      if (priceWei <= 0n) throw new Error('price_per_nft_xmoney must be > 0.');
      // PegFactory takes sqrt(quote per claim) * 2^96 and inverts it itself when the quote sorts first (native does).
      const sqrtX96 = isqrt((priceWei << 192n) / 10n ** 18n);
      const spacing = { 500: 10, 3000: 60, 10000: 200 }[fee_pips];
      const keep = 0xffff;
      const p = prepared({
        action: `Open a peg market for ${symbol}`, chainId: XGAS_CHAIN_ID, to: F().factory,
        data: encodeFunctionData({ abi: PEG_FACTORY_ABI, functionName: 'createMarket', args: [
          { collection: getAddress(collection), platformFeeBps: keep, snipePremiumBps: keep, taxBps: keep, claimName: `v${name}`.slice(0, 64), claimSymbol: `v${symbol}`.slice(0, 16), allowedIdsRoot: `0x${'0'.repeat(64)}`, minBalance: 0n },
          [{ quoteToken: ZERO, fee: fee_pips, tickSpacing: spacing, initialSqrtPriceX96: sqrtX96 }],
        ] }), value: 0n,
        asset: 'none (gas only)', amount: `a vault of v${symbol} claims and a native pool at ${price_per_nft_xmoney} $xMoney per NFT, ${fee_pips / 10000}% fee`,
        counterparty: `staccpad PegFactory ${F().factory}`, fees: [{ label: 'Launch fee', amount: 'none', note: 'factory-default platform fee, snipe premium and transfer tax apply to the vault' }],
        net: 'A market anyone can deposit into, buy from and sell into once it has liquidity', timeline: ['One transaction on xGas'],
        irreversible: 'One market per (collection, quote, fee). The starting price is set once; trades move it after that.', notes: ['Empty until someone adds liquidity or deposits NFTs.'],
      });
      return reply(renderApproval(p), p);
    },
  },
];
