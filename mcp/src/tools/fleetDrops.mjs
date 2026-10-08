// Drops on the xGas L4 from the staccpad fleet (nft-range DropFactory):
//   PumpDrop  — a linear mint curve you can sell back into until it sells out, then it graduates: the reserve
//               and a reserve batch of NFTs are locked forever as a full-range pool on the peg market.
//   StaccDrop — a classic staged mint (fixed, Dutch or rising price), proceeds to the creator.
import { encodeFunctionData, decodeEventLog, isAddress, getAddress } from 'viem';
import { XGAS_CHAIN_ID, xgas, FLEET, ZERO } from '../config.mjs';
import { DROP_FACTORY_ABI, PUMP_DROP_ABI, STACC_DROP_ABI } from '../fleetAbis.mjs';
import { fmtXMoney, parseXMoney } from '../money.mjs';
import { prepared, renderApproval, reply } from '../approval.mjs';
import { untrusted } from '../untrusted.mjs';

const addr = { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' };
const BPS = 10000n;
const KIND = ['drop', 'pump'];
const NOT_LIVE = `The staccpad fleet is not in this deployment file for xGas ${XGAS_CHAIN_ID}, so there is no DropFactory to read.`;
const factory = () => FLEET?.drops?.factory || null;
const fac = (fn, args = []) => xgas.readContract({ address: factory(), abi: DROP_FACTORY_ABI, functionName: fn, args });
const pump = (a, fn, args = []) => xgas.readContract({ address: a, abi: PUMP_DROP_ABI, functionName: fn, args });
const drop = (a, fn, args = []) => xgas.readContract({ address: a, abi: STACC_DROP_ABI, functionName: fn, args });

async function launchOf(a) {
  if (!isAddress(a)) throw new Error(`Not an address: ${a}`);
  if (!factory()) throw new Error(NOT_LIVE);
  if (!(await fac('isLaunch', [a]))) throw new Error(`${a} was not launched by the xGas DropFactory ${factory()}. Nothing prepared.`);
  // The kind is not stored per address; PumpDrop has graduated(), StaccDrop does not.
  const isPump = await pump(a, 'graduated').then(() => true, () => false);
  return { address: getAddress(a), kind: isPump ? 'pump' : 'drop' };
}

async function pumpState(a) {
  const fns = ['name', 'symbol', 'owner', 'supply', 'minted', 'basePrice', 'finalPrice', 'creatorFeeBps', 'fanoutBps', 'perWallet', 'start', 'reserve', 'reserveSupply', 'graduated', 'currentPrice', 'progressBps'];
  const v = await Promise.all(fns.map((f) => pump(a, f)));
  const s = Object.fromEntries(fns.map((f, i) => [f, v[i]]));
  const [vault, poolId] = s.graduated ? await Promise.all([pump(a, 'vault'), pump(a, 'poolId')]) : [null, null];
  return {
    kind: 'pump', collection: a, name: untrusted(s.name, 64), symbol: untrusted(s.symbol, 24), creator: s.owner,
    graduated: s.graduated, minted: Number(s.minted), supply: Number(s.supply), remaining: Number(s.supply) - Number(s.minted),
    progress_pct: (Number(s.progressBps) / 100).toFixed(2), next_price_xmoney: fmtXMoney(s.currentPrice),
    base_price_xmoney: fmtXMoney(s.basePrice), final_price_xmoney: fmtXMoney(s.finalPrice), reserve_xmoney: fmtXMoney(s.reserve),
    reserve_supply_at_graduation: Number(s.reserveSupply), creator_fee_bps: Number(s.creatorFeeBps), fanout_fee_bps: Number(s.fanoutBps),
    per_wallet: Number(s.perWallet), starts_at: Number(s.start) ? new Date(Number(s.start) * 1000).toISOString() : 'now',
    vault, pool_id: poolId,
    how_it_works: s.graduated
      ? 'Graduated: the curve is closed and the collection trades on its peg market (see get_peg_market with the vault).'
      : `Mint along a straight line from ${fmtXMoney(s.basePrice)} to ${fmtXMoney(s.finalPrice)}; selling back pays the curve price of the latest mints (no fee on sells). The mint that sells it out graduates it into a locked full-range pool.`,
  };
}

async function dropState(a) {
  const [name, symbol, owner, maxSupply, total, n] = await Promise.all(['name', 'symbol', 'owner', 'maxSupply', 'totalSupply', 'stageCount'].map((f) => drop(a, f)));
  const stages = await Promise.all(Array.from({ length: Number(n) }, (_, i) => Promise.all([drop(a, 'priceOf', [BigInt(i)]), drop(a, 'status', [BigInt(i)]), drop(a, 'remaining', [BigInt(i)])])
    .then(([price, status, remaining]) => ({ stage: i, price_xmoney: fmtXMoney(price), status: ['live', 'paused', 'not started', 'ended', 'sold out'][Number(status)] ?? String(status), remaining: Number(remaining) }))));
  return { kind: 'drop', collection: a, name: untrusted(name, 64), symbol: untrusted(symbol, 24), creator: owner, max_supply: Number(maxSupply), minted: Number(total), stages };
}

const stateOf = (l) => (l.kind === 'pump' ? pumpState(l.address) : dropState(l.address));

async function ownedIds(a, holder, maxId) {
  const ids = Array.from({ length: Math.min(maxId, 3000) }, (_, i) => BigInt(i + 1));
  const out = [];
  for (let i = 0; i < ids.length; i += 60) {
    const chunk = ids.slice(i, i + 60);
    const owners = await Promise.all(chunk.map((id) => pump(a, 'ownerOf', [id]).catch(() => null)));
    owners.forEach((o, j) => { if (o && o.toLowerCase() === holder.toLowerCase()) out.push(chunk[j].toString()); });
  }
  return out;
}

export const tools = [
  {
    name: 'list_drops',
    description: 'Every NFT drop launched on xGas through the staccpad fleet DropFactory, newest first: PumpDrop curves (mint, sell back, graduate into a locked pool) and staged StaccDrops. Read-only.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false },
    async handler({ limit = 20 }) {
      if (!factory()) return reply(NOT_LIVE, { factory: null, drops: [] });
      const n = Number(await fac('count'));
      const idx = Array.from({ length: n }, (_, i) => n - 1 - i).slice(0, limit);
      const rows = await Promise.all(idx.map((i) => fac('launches', [BigInt(i)])));
      const drops = await Promise.all(rows.map(([collection, creator, kind]) => stateOf({ address: collection, kind: KIND[Number(kind)] }).catch((e) => ({ collection, creator, error: e.shortMessage || e.message }))));
      if (!drops.length) return reply(`The DropFactory ${factory()} is live; nothing has been launched yet.`, { factory: factory(), drops: [] });
      const lines = drops.map((d) => d.error ? `  ${d.collection}: unreadable (${d.error})`
        : d.kind === 'pump' ? `  [pump] ${d.symbol} ${d.collection}: ${d.graduated ? 'graduated' : `${d.minted}/${d.supply} minted, next ${d.next_price_xmoney}`}`
        : `  [drop] ${d.symbol} ${d.collection}: ${d.minted}/${d.max_supply} minted, ${d.stages.filter((s) => s.status === 'live').length} live stage(s)`);
      return reply(`${drops.length} of ${n} drop(s) on xGas:\n${lines.join('\n')}`, { factory: factory(), total: n, drops });
    },
  },

  {
    name: 'get_drop',
    description: 'Full state of one fleet drop (PumpDrop or StaccDrop), optionally with the ids a holder owns on a PumpDrop. Read-only.',
    inputSchema: { type: 'object', properties: { collection: addr, holder: addr }, required: ['collection'], additionalProperties: false },
    async handler({ collection, holder }) {
      const l = await launchOf(collection);
      const s = await stateOf(l);
      if (l.kind === 'pump' && holder && isAddress(holder)) s.holder = { address: holder, ids: await ownedIds(l.address, holder, s.minted + s.reserve_supply_at_graduation + 50) };
      const head = l.kind === 'pump'
        ? `${s.name} (${s.symbol}), PumpDrop. ${s.graduated ? 'Graduated.' : `${s.minted}/${s.supply} minted (${s.progress_pct}%), next ${s.next_price_xmoney} $xMoney, reserve ${s.reserve_xmoney}.`}\n${s.how_it_works}`
        : `${s.name} (${s.symbol}), StaccDrop. ${s.minted}/${s.max_supply} minted.\n${s.stages.map((x) => `  stage ${x.stage}: ${x.status}, ${x.price_xmoney} $xMoney, ${x.remaining} left`).join('\n')}`;
      return reply(head + (s.holder ? `\n${holder} holds ${s.holder.ids.length}: ${s.holder.ids.slice(0, 30).join(', ')}` : ''), s);
    },
  },

  {
    name: 'prepare_pump_buy',
    description: 'Prepare an unsigned mint on a PumpDrop curve, with a maxTotal slippage guard. The mint that sells the curve out also graduates it. Signs nothing.',
    inputSchema: {
      type: 'object',
      properties: { collection: addr, qty: { type: 'integer', minimum: 1, maximum: 100 }, to: addr, buffer_bps: { type: 'integer', minimum: 0, maximum: 2000, description: 'Default 100 (1%); refunded if unused.' } },
      required: ['collection', 'qty'], additionalProperties: false,
    },
    async handler({ collection, qty, to, buffer_bps = 100 }) {
      const l = await launchOf(collection);
      if (l.kind !== 'pump') throw new Error(`${l.address} is a StaccDrop; use prepare_drop_mint.`);
      const s = await pumpState(l.address);
      if (s.graduated) return reply(`${s.symbol} has graduated; the curve is closed. Trade it on its peg market.`, { ...s, blocked: 'graduated' });
      if (qty > s.remaining) return reply(`Only ${s.remaining} left on the curve.`, { ...s, blocked: 'not_enough_left' });
      const [cost, fees, total] = await pump(l.address, 'quoteBuy', [qty]);
      const maxTotal = total + (total * BigInt(buffer_bps)) / BPS;
      const graduates = qty === s.remaining;
      const p = prepared({
        action: `Mint ${qty} ${s.symbol} on its PumpDrop curve${graduates ? ' (this sells it out and graduates it)' : ''}`,
        chainId: XGAS_CHAIN_ID, to: l.address,
        data: encodeFunctionData({ abi: PUMP_DROP_ABI, functionName: 'buy', args: [qty, maxTotal, to && isAddress(to) ? to : ZERO] }),
        value: maxTotal,
        asset: `native $xMoney → ${s.symbol} NFTs`, amount: `${qty} NFT(s): curve ${fmtXMoney(cost)} + fees ${fmtXMoney(fees)} = ${fmtXMoney(total)} $xMoney`,
        counterparty: `the curve itself: ${s.name} at ${l.address}`,
        fees: [
          { label: 'Creator', amount: `${fmtXMoney((cost * BigInt(s.creator_fee_bps)) / BPS)} xMoney`, note: `${(s.creator_fee_bps / 100).toFixed(2)}%` },
          { label: 'Protocol', amount: `${fmtXMoney((cost * BigInt(s.fanout_fee_bps)) / BPS)} xMoney`, note: `${(s.fanout_fee_bps / 100).toFixed(2)}%, to the xGas FanoutSink` },
        ],
        net: `${qty} ${s.symbol}; until graduation each can be sold back at the curve price of the latest mint, no fee`,
        timeline: ['One transaction on xGas'],
        irreversible: graduates ? 'This mint closes the curve for good: the reserve and a reserve batch of NFTs become a locked full-range pool, and nobody can sell back to the curve after it.' : 'Fees are not refunded on a sell-back; the curve price is.',
        notes: [`maxTotal carries a ${buffer_bps}bps buffer; the contract refunds anything unused.`],
      });
      return reply(renderApproval(p), { ...p, quote: { cost_xmoney: fmtXMoney(cost), fees_xmoney: fmtXMoney(fees), total_xmoney: fmtXMoney(total), graduates } });
    },
  },

  {
    name: 'prepare_pump_sell',
    description: 'Prepare an unsigned sell-back of PumpDrop NFTs to the curve (before graduation only), with minPayout. Signs nothing.',
    inputSchema: {
      type: 'object',
      properties: { collection: addr, token_ids: { type: 'array', items: { type: 'string', pattern: '^[0-9]+$' }, minItems: 1, maxItems: 100 }, seller: addr, slippage_bps: { type: 'integer', minimum: 0, maximum: 1000 } },
      required: ['collection', 'token_ids', 'seller'], additionalProperties: false,
    },
    async handler({ collection, token_ids, seller, slippage_bps = 50 }) {
      const l = await launchOf(collection);
      if (l.kind !== 'pump') throw new Error(`${l.address} is a StaccDrop; it has no curve to sell into.`);
      const s = await pumpState(l.address);
      if (s.graduated) return reply(`${s.symbol} has graduated; sell it on its peg market instead.`, { ...s, blocked: 'graduated' });
      const ids = [...new Set(token_ids.map((x) => BigInt(x)))];
      const owners = await Promise.all(ids.map((id) => pump(l.address, 'ownerOf', [id]).catch(() => null)));
      const bad = ids.filter((_, i) => !owners[i] || owners[i].toLowerCase() !== String(seller).toLowerCase());
      if (bad.length) return reply(`${seller} does not hold id(s) ${bad.join(', ')}. Nothing prepared.`, { blocked: 'not_owner', ids: bad.map(String) });
      const payout = await pump(l.address, 'quoteSell', [ids.length]);
      const minPayout = (payout * (BPS - BigInt(slippage_bps))) / BPS;
      const p = prepared({
        action: `Sell ${ids.length} ${s.symbol} back to the PumpDrop curve`,
        chainId: XGAS_CHAIN_ID, to: l.address,
        data: encodeFunctionData({ abi: PUMP_DROP_ABI, functionName: 'sell', args: [ids, minPayout] }),
        value: 0n, asset: `${s.symbol} NFTs → native $xMoney`, amount: `ids ${ids.join(', ')} for ${fmtXMoney(payout)} $xMoney (at least ${fmtXMoney(minPayout)})`,
        counterparty: `the curve itself: ${s.name} at ${l.address}`, fees: [{ label: 'Sell fee', amount: 'none' }],
        net: `${fmtXMoney(payout)} $xMoney`, timeline: ['One transaction on xGas; the NFTs are burned'],
        irreversible: 'Sold NFTs are burned; the curve steps back down by that many mints.', notes: [],
      });
      return reply(renderApproval(p), { ...p, quote: { payout_xmoney: fmtXMoney(payout) } });
    },
  },

  {
    name: 'launch_pump_drop',
    description: 'Prepare an unsigned PumpDrop launch on xGas: a linear mint curve that graduates into a locked full-range pool when it sells out. Signs nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 64 }, symbol: { type: 'string', minLength: 1, maxLength: 16 },
        base_uri: { type: 'string', maxLength: 256 }, contract_uri: { type: 'string', maxLength: 256 },
        supply: { type: 'integer', minimum: 2, maximum: 100000 },
        base_price_xmoney: { type: 'string' }, final_price_xmoney: { type: 'string' },
        creator_fee_bps: { type: 'integer', minimum: 0, maximum: 500, description: 'Default 250.' },
        protocol_fee_bps: { type: 'integer', minimum: 0, maximum: 500, description: 'To the xGas FanoutSink. Default 100.' },
        per_wallet: { type: 'integer', minimum: 0, maximum: 65535, description: '0 = unlimited.' },
        start_unix: { type: 'integer', minimum: 0, description: '0 = now.' },
        royalty_bps: { type: 'integer', minimum: 0, maximum: 1000, description: 'Default 500.' },
      },
      required: ['name', 'symbol', 'supply', 'base_price_xmoney', 'final_price_xmoney'], additionalProperties: false,
    },
    async handler(a) {
      if (!factory()) throw new Error(NOT_LIVE);
      const base = parseXMoney(a.base_price_xmoney), fin = parseXMoney(a.final_price_xmoney);
      if (base <= 0n || fin < base) throw new Error('Prices must satisfy 0 < base ≤ final.');
      const init = {
        name: a.name, symbol: a.symbol, baseURI: a.base_uri ?? '', contractURI: a.contract_uri ?? '', supply: a.supply,
        basePrice: base, finalPrice: fin, creatorFeeBps: a.creator_fee_bps ?? 250, fanoutBps: a.protocol_fee_bps ?? 100,
        perWallet: a.per_wallet ?? 0, start: a.start_unix ?? 0, royaltyBps: BigInt(a.royalty_bps ?? 500),
      };
      const raised = (BigInt(a.supply) * (base + fin)) / 2n;
      const p = prepared({
        action: `Launch PumpDrop ${a.symbol}`, chainId: XGAS_CHAIN_ID, to: factory(),
        data: encodeFunctionData({ abi: DROP_FACTORY_ABI, functionName: 'launchPump', args: [init] }), value: 0n,
        asset: 'none (gas only)', amount: `${a.supply} NFTs from ${a.base_price_xmoney} to ${a.final_price_xmoney} $xMoney`,
        counterparty: `staccpad DropFactory ${factory()}`,
        fees: [{ label: 'Launch fee', amount: 'none', note: `buyers pay ${(init.creatorFeeBps / 100).toFixed(2)}% to you and ${(init.fanoutBps / 100).toFixed(2)}% to the xGas FanoutSink on every mint` }],
        net: `A new collection you own; a sell-out reserve of about ${fmtXMoney(raised)} $xMoney that becomes the pool's liquidity`,
        timeline: ['One transaction on xGas; the address comes back in the Launched event (find_drop_launch)'],
        irreversible: 'Curve and fees are fixed at launch. At sell-out the reserve is locked forever in a full-range pool; you keep the LP fee receipt, not the principal.',
        notes: ['Graduation adds liquidity on the xGas PoolManager, which charges its JIT toll on LP adds.'],
      });
      return reply(renderApproval(p), p);
    },
  },

  {
    name: 'launch_drop',
    description: 'Prepare an unsigned StaccDrop launch on xGas with one public, fixed-price stage (more stages can be added by the creator later). Signs nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 64 }, symbol: { type: 'string', minLength: 1, maxLength: 16 },
        base_uri: { type: 'string', maxLength: 256 }, contract_uri: { type: 'string', maxLength: 256 },
        max_supply: { type: 'integer', minimum: 1, maximum: 1000000 }, price_xmoney: { type: 'string' },
        per_wallet: { type: 'integer', minimum: 0, maximum: 65535 }, start_unix: { type: 'integer', minimum: 0 }, end_unix: { type: 'integer', minimum: 0 },
        protocol_bps: { type: 'integer', minimum: 0, maximum: 10000, description: 'Share of proceeds to the xGas FanoutSink. Default 1000 (10%).' },
        royalty_bps: { type: 'integer', minimum: 0, maximum: 1000 },
      },
      required: ['name', 'symbol', 'max_supply', 'price_xmoney'], additionalProperties: false,
    },
    async handler(a) {
      if (!factory()) throw new Error(NOT_LIVE);
      const price = parseXMoney(a.price_xmoney);
      const now = Math.floor(Date.now() / 1000);
      const init = { name: a.name, symbol: a.symbol, baseURI: a.base_uri ?? '', contractURI: a.contract_uri ?? '', maxSupply: a.max_supply, payout: ZERO, fanoutBps: a.protocol_bps ?? 1000, royaltyBps: BigInt(a.royalty_bps ?? 500), royaltyReceiver: ZERO };
      const stage = { startPrice: price, endPrice: price, decay: 0, start: a.start_unix || now, end: a.end_unix ?? 0, supply: 0, perWallet: a.per_wallet ?? 0, allowlistRoot: `0x${'0'.repeat(64)}`, minted: 0, live: true };
      const p = prepared({
        action: `Launch StaccDrop ${a.symbol}`, chainId: XGAS_CHAIN_ID, to: factory(),
        data: encodeFunctionData({ abi: DROP_FACTORY_ABI, functionName: 'launchDrop', args: [init, [stage]] }), value: 0n,
        asset: 'none (gas only)', amount: `${a.max_supply} NFTs at ${a.price_xmoney} $xMoney`,
        counterparty: `staccpad DropFactory ${factory()}`,
        fees: [{ label: 'Launch fee', amount: 'none', note: `${((a.protocol_bps ?? 1000) / 100).toFixed(2)}% of mint proceeds to the xGas FanoutSink, the rest to you` }],
        net: 'A new collection you own, minting immediately', timeline: ['One transaction on xGas'],
        irreversible: 'The collection is yours to manage (stages, metadata, supply cuts); minted NFTs are final.', notes: [],
      });
      return reply(renderApproval(p), p);
    },
  },

  {
    name: 'prepare_drop_mint',
    description: 'Prepare an unsigned public mint on a StaccDrop stage. Signs nothing.',
    inputSchema: { type: 'object', properties: { collection: addr, stage: { type: 'integer', minimum: 0 }, qty: { type: 'integer', minimum: 1, maximum: 100 }, to: addr }, required: ['collection', 'qty'], additionalProperties: false },
    async handler({ collection, stage = 0, qty, to }) {
      const l = await launchOf(collection);
      if (l.kind !== 'drop') throw new Error(`${l.address} is a PumpDrop; use prepare_pump_buy.`);
      const s = await dropState(l.address);
      const st = s.stages[stage];
      if (!st) throw new Error(`No stage ${stage}; this drop has ${s.stages.length}.`);
      if (st.status !== 'live') return reply(`Stage ${stage} is ${st.status}. Nothing prepared.`, { ...s, blocked: st.status });
      const cost = await drop(l.address, 'quote', [BigInt(stage), qty]);
      const p = prepared({
        action: `Mint ${qty} ${s.symbol} (stage ${stage})`, chainId: XGAS_CHAIN_ID, to: l.address,
        data: encodeFunctionData({ abi: STACC_DROP_ABI, functionName: 'mint', args: [BigInt(stage), qty, to && isAddress(to) ? to : ZERO, []] }), value: cost,
        asset: `native $xMoney → ${s.symbol} NFTs`, amount: `${qty} for ${fmtXMoney(cost)} $xMoney`, counterparty: `${s.name} at ${l.address}`,
        fees: [{ label: 'Included', amount: 'part of the price goes to the xGas FanoutSink, the rest to the creator' }],
        net: `${qty} ${s.symbol}`, timeline: ['One transaction on xGas'], irreversible: 'Primary mints are final; there is no curve to sell back into.', notes: [],
      });
      return reply(renderApproval(p), p);
    },
  },

  {
    name: 'find_drop_launch',
    description: 'Read the collection address out of a confirmed DropFactory launch transaction. Read-only.',
    inputSchema: { type: 'object', properties: { tx_hash: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' } }, required: ['tx_hash'], additionalProperties: false },
    async handler({ tx_hash }) {
      const r = await xgas.getTransactionReceipt({ hash: tx_hash });
      for (const l of r.logs) {
        if (l.address.toLowerCase() !== String(factory()).toLowerCase()) continue;
        try { const e = decodeEventLog({ abi: DROP_FACTORY_ABI, ...l }); if (e.eventName === 'Launched') return reply(`Launched ${KIND[Number(e.args.kind)]}: ${e.args.collection}`, { collection: e.args.collection, kind: KIND[Number(e.args.kind)], block: Number(r.blockNumber) }); } catch { /* other */ }
      }
      return reply(`No Launched event from the DropFactory in ${tx_hash}.`, { collection: null, status: r.status });
    },
  },
];
