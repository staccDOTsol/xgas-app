import { encodeFunctionData, isAddress } from 'viem';
import { L4, XGAS_CHAIN_ID, xgas, ZERO, BURN_BPS, FANOUT_RAKE_BPS, BUYBACK_BPS, TRADE_TIMEOUT_S } from '../config.mjs';
import { ESCROW_ABI } from '../abis.mjs';
import { expectedCents, fmtXMoney, parseXMoney, rateToUsd, usd } from '../money.mjs';
import { prepared, renderApproval, reply, submitFields } from '../approval.mjs';
import { submitRaw } from '../idempotency.mjs';

const addr = { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' };
const BPS = 10000n;
const SIDE = ['ask', 'bid'];

const read = (fn, args = []) => xgas.readContract({ address: L4.escrow, abi: ESCROW_ABI, functionName: fn, args });

/** fiatRateBps from either an explicit bps number or a friendlier "$0.99" style price. */
/**
 * The maker fields post_ask and post_bid both take. Shared: these two are the same
 * form on opposite sides, and post_bid shipped every one of them bare while post_ask
 * described them. Each tool still says its own xmoney_amount and from.
 */
export const makerFields = {
  maker_x_handle: { type: 'string', description: 'Your X handle, without the @. On this desk your handle is the commitment.' },
  usd_price: { type: 'string', description: 'USD per $xMoney, e.g. "1.00". Must land on whole basis points (0.0001 USD steps).' },
  fiat_rate_bps: { type: 'integer', description: 'Alternative to usd_price, in basis points: 10000 = $1.00. Give this or usd_price.' },
  min_amount: { type: 'string', description: 'Minimum $xMoney per trade. Must be greater than zero.' },
  max_amount: { type: 'string', description: 'Maximum $xMoney per trade. Must be at least min_amount.' },
};

function rateBps({ fiat_rate_bps, usd_price }) {
  if (fiat_rate_bps !== undefined && fiat_rate_bps !== null) return BigInt(fiat_rate_bps);
  if (usd_price === undefined || usd_price === null) throw new Error('Give fiat_rate_bps or usd_price.');
  const n = Number(String(usd_price).replace(/[$,]/g, ''));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Not a price: ${usd_price}`);
  const bps = Math.round(n * 10000);
  if (Math.abs(n * 10000 - bps) > 1e-6) throw new Error(`${usd_price} is finer than the escrow's bps grid; use a price in whole basis points (0.0001 USD steps).`);
  return BigInt(bps);
}

async function order(id) {
  const [maker, makerXHandle, side, availableXMoney, fiatRateBps, minAmount, maxAmount, active] = await read('orders', [BigInt(id)]);
  if (maker === ZERO) return null;
  return {
    order_id: Number(id), maker, maker_x_handle: makerXHandle, side: SIDE[Number(side)],
    available_xmoney: fmtXMoney(availableXMoney), available_wei: availableXMoney,
    price_usd: rateToUsd(fiatRateBps), fiat_rate_bps: Number(fiatRateBps),
    min: fmtXMoney(minAmount), max: fmtXMoney(maxAmount), min_wei: minAmount, max_wei: maxAmount,
    active,
  };
}

async function trade(id) {
  const [orderId, side, seller, sellerXHandle, buyer, buyerXHandle, xMoneyAmount, cents, deadline, completed, cancelled] =
    await read('trades', [BigInt(id)]);
  if (seller === ZERO) return null;
  const now = Math.floor(Date.now() / 1000);
  return {
    trade_id: Number(id), order_id: Number(orderId), side: SIDE[Number(side)],
    seller, seller_x_handle: sellerXHandle, buyer, buyer_x_handle: buyerXHandle,
    xmoney: fmtXMoney(xMoneyAmount), xmoney_wei: xMoneyAmount,
    fiat_due: usd(cents), expected_cents: cents,
    deadline: Number(deadline), seconds_left: Number(deadline) - now,
    state: completed ? 'released' : cancelled ? 'cancelled' : (now > Number(deadline) ? 'in_escrow_past_deadline' : 'in_escrow'),
  };
}

function tradeSplit(xWei) {
  const burn = (xWei * BURN_BPS) / BPS;
  const rake = (xWei * FANOUT_RAKE_BPS) / BPS;
  const buyback = (xWei * BUYBACK_BPS) / BPS;
  return { burn, rake, buyback, net: xWei - burn - rake - buyback };
}

const FIAT_NOTE = 'The fiat leg is not on chain. It happens between two X handles on X Money; this connector watches the escrow, never the payment.';

export const tools = [
  {
    name: 'list_orders',
    description: 'The OTC order book on xGas: open sell asks and buy bids, with price, size and the maker\'s X handle. An empty book is a real answer, not a failure. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        side: { type: 'string', enum: ['ask', 'bid', 'both'], description: 'ask = someone selling $xMoney for fiat; bid = someone buying. Default both.' },
        active_only: { type: 'boolean', description: 'Default true.' },
      },
      additionalProperties: false,
    },
    async handler({ side = 'both', active_only = true }) {
      const next = await read('nextOrderId');
      if (next === 0n) return reply('The order book is empty — no orders have ever been posted on this escrow. To start one, use post_ask or post_bid.', { orders: [], next_order_id: 0 });
      const ids = Array.from({ length: Number(next) }, (_, i) => i);
      const all = (await Promise.all(ids.map((i) => order(i).catch(() => null)))).filter(Boolean);
      const orders = all
        .filter((o) => (side === 'both' ? true : o.side === side))
        .filter((o) => (active_only ? o.active && o.available_wei > 0n : true))
        .sort((a, b) => (a.side === b.side ? (a.side === 'ask' ? a.price_usd - b.price_usd : b.price_usd - a.price_usd) : a.side.localeCompare(b.side)));
      if (!orders.length) {
        return reply(`No ${side === 'both' ? '' : `${side} `}orders${active_only ? ' are live' : ''} right now (${all.length} order(s) ever posted). Posting your own is the recourse: post_ask or post_bid.`, { orders: [], scanned: all.length });
      }
      const lines = orders.map((o) => `  #${o.order_id} ${o.side.toUpperCase()} @${o.maker_x_handle}: ${o.available_xmoney} $xMoney at $${o.price_usd} (${o.min}–${o.max} per trade)`);
      return reply(`${orders.length} live order(s):\n${lines.join('\n')}`, { orders });
    },
  },

  {
    name: 'get_order',
    description: 'One order in full, straight from the escrow. Read-only.',
    inputSchema: { type: 'object', properties: { order_id: { type: 'integer', minimum: 0 } }, required: ['order_id'], additionalProperties: false },
    async handler({ order_id }) {
      const o = await order(order_id);
      if (!o) return reply(`Order #${order_id} does not exist on escrow ${L4.escrow}.`, { order_id, exists: false });
      return reply(`Order #${o.order_id} — ${o.side.toUpperCase()} by @${o.maker_x_handle}, ${o.available_xmoney} $xMoney at $${o.price_usd}, ${o.min}–${o.max} per trade, ${o.active ? 'active' : 'inactive'}.`, o);
    },
  },

  {
    name: 'get_trade',
    description: 'One trade in full: who owes fiat to whom, how much, and how long is left on the 15-minute timeout. Read-only.',
    inputSchema: { type: 'object', properties: { trade_id: { type: 'integer', minimum: 0 } }, required: ['trade_id'], additionalProperties: false },
    async handler({ trade_id }) {
      const t = await trade(trade_id);
      if (!t) return reply(`Trade #${trade_id} does not exist on escrow ${L4.escrow}.`, { trade_id, exists: false });
      const split = tradeSplit(t.xmoney_wei);
      return reply(
        `Trade #${t.trade_id} (${t.state}) from order #${t.order_id}: @${t.buyer_x_handle} owes ${t.fiat_due} on X Money to @${t.seller_x_handle} for ${t.xmoney} $xMoney.\n` +
        `On release the buyer nets ${fmtXMoney(split.net)} $xMoney. ${t.seconds_left > 0 ? `${t.seconds_left}s left before the seller can reclaim.` : 'The timeout has passed; the seller may reclaim.'}\n${FIAT_NOTE}`,
        { ...t, on_release: { burn: fmtXMoney(split.burn), fanout_rake: fmtXMoney(split.rake), xgas_dev_buyback: fmtXMoney(split.buyback), net_to_buyer: fmtXMoney(split.net) } },
      );
    },
  },

  {
    name: 'quote_trade',
    description: 'What a given size against a given order costs and delivers: fiat due in USD, the burn, rake and XGAS.DEV buyback, and the net $xMoney the buyer receives. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { order_id: { type: 'integer', minimum: 0 }, xmoney_amount: { type: 'string', description: 'Size in $xMoney.' } },
      required: ['order_id', 'xmoney_amount'],
      additionalProperties: false,
    },
    async handler({ order_id, xmoney_amount }) {
      const o = await order(order_id);
      if (!o) return reply(`Order #${order_id} does not exist.`, { order_id, exists: false });
      const xWei = parseXMoney(xmoney_amount);
      const blocked = [];
      if (!o.active) blocked.push('the order is not active');
      if (xWei < o.min_wei) blocked.push(`below the ${o.min} minimum`);
      if (xWei > o.max_wei) blocked.push(`above the ${o.max} maximum per trade`);
      if (xWei > o.available_wei) blocked.push(`only ${o.available_xmoney} is available`);
      const cents = expectedCents(xWei, BigInt(o.fiat_rate_bps));
      const split = tradeSplit(xWei);
      const data = {
        order_id, side: o.side, maker_x_handle: o.maker_x_handle, price_usd: o.price_usd,
        size: fmtXMoney(xWei), fiat_due: usd(cents), expected_cents: cents,
        burn: fmtXMoney(split.burn), fanout_rake: fmtXMoney(split.rake), xgas_dev_buyback: fmtXMoney(split.buyback), net_xmoney_to_buyer: fmtXMoney(split.net),
        fillable: blocked.length === 0, blocked_because: blocked,
        trust: 'The $xMoney leg is escrowed on chain. The fiat leg is an X Money payment between two X handles, released by the seller. A seller who never releases is bounded only by the 15-minute reclaim on their own side, not yours.',
      };
      if (blocked.length) return reply(`Not fillable as asked: ${blocked.join('; ')}.`, data);
      return reply(
        `${fmtXMoney(xWei)} $xMoney against order #${order_id} at $${o.price_usd}: ${usd(cents)} due on X Money to @${o.maker_x_handle}.\n` +
        `Buyer nets ${fmtXMoney(split.net)} $xMoney after ${fmtXMoney(split.burn)} burned, ${fmtXMoney(split.rake)} to the FanoutSink and ${fmtXMoney(split.buyback)} to buy and burn XGAS.DEV.\n${FIAT_NOTE}`,
        data,
      );
    },
  },

  {
    name: 'post_ask',
    description: 'Prepare an unsigned createSellAsk: escrow your $xMoney and sell it for USD on X Money. Signs nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        ...makerFields,
        xmoney_amount: { type: 'string', description: 'Total $xMoney to escrow.' },
        from: { ...addr, description: 'The address that will sign and escrow.' },
      },
      required: ['maker_x_handle', 'xmoney_amount', 'min_amount', 'max_amount', 'from'],
      additionalProperties: false,
    },
    async handler(a) {
      if (!isAddress(a.from)) throw new Error(`from is not an address: ${a.from}`);
      const bps = rateBps(a);
      const total = parseXMoney(a.xmoney_amount);
      const min = parseXMoney(a.min_amount);
      const max = parseXMoney(a.max_amount);
      if (min === 0n || max < min || total < min) throw new Error('Sizes must satisfy: min > 0, max >= min, total >= min.');
      const balance = await xgas.getBalance({ address: a.from });
      if (balance < total) {
        return reply(`${a.from} holds ${fmtXMoney(balance)} $xMoney on xGas, less than the ${fmtXMoney(total)} this ask escrows (and gas on top). Nothing prepared.`,
          { blocked: 'insufficient_xmoney', holds: fmtXMoney(balance), needs: fmtXMoney(total) });
      }
      const handle = String(a.maker_x_handle).replace(/^@/, '');
      const p = prepared({
        action: 'Post a sell ask: escrow $xMoney, sell for USD on X Money',
        chainId: XGAS_CHAIN_ID,
        to: L4.escrow,
        data: encodeFunctionData({ abi: ESCROW_ABI, functionName: 'createSellAsk', args: [handle, total, bps, min, max] }),
        value: total,
        asset: 'native $xMoney on xGas L4',
        amount: `${fmtXMoney(total)} $xMoney escrowed at $${rateToUsd(bps)} each (${fmtXMoney(min)}–${fmtXMoney(max)} per trade)`,
        counterparty: `Escrow ${L4.escrow}; buyers pay @${handle} on X Money`,
        fees: [{ label: 'On each release', amount: '0.04% of that trade', note: '0.01% burned, 0.01% to the FanoutSink, 0.02% buys and burns XGAS.DEV; the buyer receives 99.96%' }],
        net: `Up to ${usd(expectedCents(total, bps))} in USD if the whole ask fills`,
        timeline: [
          'Your $xMoney is escrowed the moment this confirms',
          'A buyer fills, then pays you on X Money',
          'You verify the fiat arrived and call release_trade — or reclaim after 15 minutes if they never pay',
        ],
        irreversible: 'The escrow holds your $xMoney until a trade releases, a trade times out, or you cancel the order. Releasing a trade is final and cannot be reversed if the fiat turns out not to have arrived.',
        notes: [FIAT_NOTE, `Your handle @${handle} goes on chain in the clear.`],
      });
      return reply(renderApproval(p), p);
    },
  },

  {
    name: 'post_bid',
    description: 'Prepare an unsigned createBuyBid: commit to buy $xMoney with USD on X Money. No escrow — your commitment is your handle. Signs nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        ...makerFields,
        xmoney_amount: { type: 'string', description: 'Maximum $xMoney you want to buy.' },
        from: { ...addr, description: 'The address that will sign and settle. Nothing is escrowed on this side.' },
      },
      required: ['maker_x_handle', 'xmoney_amount', 'min_amount', 'max_amount', 'from'],
      additionalProperties: false,
    },
    async handler(a) {
      if (!isAddress(a.from)) throw new Error(`from is not an address: ${a.from}`);
      const bps = rateBps(a);
      const want = parseXMoney(a.xmoney_amount);
      const min = parseXMoney(a.min_amount);
      const max = parseXMoney(a.max_amount);
      if (min === 0n || max < min || want < min) throw new Error('Sizes must satisfy: min > 0, max >= min, wanted >= min.');
      const handle = String(a.maker_x_handle).replace(/^@/, '');
      const p = prepared({
        action: 'Post a buy bid: commit to buy $xMoney with USD on X Money',
        chainId: XGAS_CHAIN_ID,
        to: L4.escrow,
        data: encodeFunctionData({ abi: ESCROW_ABI, functionName: 'createBuyBid', args: [handle, want, bps, min, max] }),
        value: 0n,
        asset: 'USD on X Money → native $xMoney',
        amount: `up to ${fmtXMoney(want)} $xMoney at $${rateToUsd(bps)} each (${fmtXMoney(min)}–${fmtXMoney(max)} per trade)`,
        counterparty: `Escrow ${L4.escrow}; sellers will expect USD from @${handle}`,
        fees: [{ label: 'On each release', amount: '0.04% of that trade', note: 'you receive 99.96% of the size' }],
        net: `Up to ${fmtXMoney((want * (BPS - BURN_BPS - FANOUT_RAKE_BPS - BUYBACK_BPS)) / BPS)} $xMoney for up to ${usd(expectedCents(want, bps))}`,
        timeline: [
          'The bid posts with no escrow from you',
          'A seller fills it, escrowing their $xMoney and starting a 15-minute clock',
          'You pay them on X Money; they release and the $xMoney is yours',
        ],
        irreversible: 'Nothing is locked by posting a bid, but once a seller fills it you are expected to pay. Failing to pay leaves them able to reclaim after 15 minutes, and your X handle is on chain against the bid.',
        notes: [FIAT_NOTE],
      });
      return reply(renderApproval(p), p);
    },
  },

  {
    name: 'take_ask',
    description: 'Prepare an unsigned fillSellAsk: take someone\'s escrowed $xMoney and owe them USD on X Money within 15 minutes. Signs nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: { type: 'integer', minimum: 0 },
        xmoney_amount: { type: 'string' },
        buyer_x_handle: { type: 'string', description: 'Your X handle — the seller pays attention to this when confirming your payment.' },
      },
      required: ['order_id', 'xmoney_amount', 'buyer_x_handle'],
      additionalProperties: false,
    },
    async handler({ order_id, xmoney_amount, buyer_x_handle }) {
      const o = await order(order_id);
      if (!o) return reply(`Order #${order_id} does not exist.`, { order_id, exists: false });
      if (o.side !== 'ask') return reply(`Order #${order_id} is a bid, not an ask. Use take_bid.`, o);
      const xWei = parseXMoney(xmoney_amount);
      if (!o.active || xWei < o.min_wei || xWei > o.max_wei || xWei > o.available_wei) {
        return reply(`Order #${order_id} cannot be filled at ${fmtXMoney(xWei)}: limits are ${o.min}–${o.max} with ${o.available_xmoney} available${o.active ? '' : ', and the order is inactive'}.`, o);
      }
      const handle = String(buyer_x_handle).replace(/^@/, '');
      const cents = expectedCents(xWei, BigInt(o.fiat_rate_bps));
      const split = tradeSplit(xWei);
      const p = prepared({
        action: `Take sell ask #${order_id}: buy $xMoney for USD`,
        chainId: XGAS_CHAIN_ID,
        to: L4.escrow,
        data: encodeFunctionData({ abi: ESCROW_ABI, functionName: 'fillSellAsk', args: [BigInt(order_id), xWei, handle] }),
        value: 0n,
        asset: 'USD on X Money → native $xMoney',
        amount: `${fmtXMoney(xWei)} $xMoney at $${o.price_usd}`,
        counterparty: `@${o.maker_x_handle} (${o.maker})`,
        fees: [
          { label: 'Burn', amount: `${fmtXMoney(split.burn)} xMoney`, note: '0.01%' },
          { label: 'FanoutSink rake', amount: `${fmtXMoney(split.rake)} xMoney`, note: '0.01%' },
          { label: 'XGAS.DEV buy & burn', amount: `${fmtXMoney(split.buyback)} xMoney`, note: '0.02%' },
        ],
        net: `${fmtXMoney(split.net)} $xMoney, once the seller releases`,
        timeline: [
          `This transaction starts a ${TRADE_TIMEOUT_S / 60}-minute clock`,
          `You send ${usd(cents)} to @${o.maker_x_handle} on X Money`,
          'They verify receipt and call releaseTrade; the $xMoney lands',
          `If you do not pay, they reclaim the escrow after ${TRADE_TIMEOUT_S / 60} minutes`,
        ],
        irreversible: `You owe ${usd(cents)} off chain the moment this confirms. If you send the fiat and the seller never releases, this connector cannot claw it back — only they can release.`,
        notes: [FIAT_NOTE, `Pay exactly ${usd(cents)} to @${o.maker_x_handle}.`],
      });
      return reply(renderApproval(p), { ...p, fiat_instruction: { pay: usd(cents), to_x_handle: o.maker_x_handle, within_minutes: TRADE_TIMEOUT_S / 60 } });
    },
  },

  {
    name: 'take_bid',
    description: 'Prepare an unsigned fillBuyBid: escrow your $xMoney against someone\'s bid and wait for their USD. Signs nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: { type: 'integer', minimum: 0 },
        xmoney_amount: { type: 'string' },
        seller_x_handle: { type: 'string' },
        from: addr,
      },
      required: ['order_id', 'xmoney_amount', 'seller_x_handle', 'from'],
      additionalProperties: false,
    },
    async handler({ order_id, xmoney_amount, seller_x_handle, from }) {
      if (!isAddress(from)) throw new Error(`from is not an address: ${from}`);
      const o = await order(order_id);
      if (!o) return reply(`Order #${order_id} does not exist.`, { order_id, exists: false });
      if (o.side !== 'bid') return reply(`Order #${order_id} is an ask, not a bid. Use take_ask.`, o);
      const xWei = parseXMoney(xmoney_amount);
      if (!o.active || xWei < o.min_wei || xWei > o.max_wei || xWei > o.available_wei) {
        return reply(`Bid #${order_id} cannot be filled at ${fmtXMoney(xWei)}: limits are ${o.min}–${o.max} with ${o.available_xmoney} still wanted${o.active ? '' : ', and the order is inactive'}.`, o);
      }
      const balance = await xgas.getBalance({ address: from });
      if (balance < xWei) {
        return reply(`${from} holds ${fmtXMoney(balance)} $xMoney, less than the ${fmtXMoney(xWei)} this fill escrows. Nothing prepared.`, { blocked: 'insufficient_xmoney' });
      }
      const handle = String(seller_x_handle).replace(/^@/, '');
      const cents = expectedCents(xWei, BigInt(o.fiat_rate_bps));
      const p = prepared({
        action: `Fill buy bid #${order_id}: sell $xMoney for USD`,
        chainId: XGAS_CHAIN_ID,
        to: L4.escrow,
        data: encodeFunctionData({ abi: ESCROW_ABI, functionName: 'fillBuyBid', args: [BigInt(order_id), xWei, handle] }),
        value: xWei,
        asset: 'native $xMoney → USD on X Money',
        amount: `${fmtXMoney(xWei)} $xMoney escrowed at $${o.price_usd}`,
        counterparty: `@${o.maker_x_handle} (${o.maker})`,
        fees: [{ label: 'On release', amount: '0.04% of the size', note: 'taken from what the buyer receives, not from your fiat' }],
        net: `${usd(cents)} in USD from @${o.maker_x_handle}`,
        timeline: [
          `Your $xMoney escrows now and a ${TRADE_TIMEOUT_S / 60}-minute clock starts`,
          `@${o.maker_x_handle} sends you ${usd(cents)} on X Money`,
          'You verify it arrived and call release_trade',
          `If they never pay, call reclaim_timeout after ${TRADE_TIMEOUT_S / 60} minutes to get your $xMoney back`,
        ],
        irreversible: 'Your $xMoney is locked in escrow from the moment this confirms. Only releasing or the timeout moves it.',
        notes: [FIAT_NOTE, `Expect exactly ${usd(cents)} from @${o.maker_x_handle}. Do not release until you see it.`],
      });
      return reply(renderApproval(p), { ...p, fiat_expectation: { expect: usd(cents), from_x_handle: o.maker_x_handle } });
    },
  },

  {
    name: 'release_trade',
    description: 'Prepare an unsigned releaseTrade — seller only, and final. Only call this after you have personally seen the fiat land.',
    inputSchema: { type: 'object', properties: { trade_id: { type: 'integer', minimum: 0 } }, required: ['trade_id'], additionalProperties: false },
    async handler({ trade_id }) {
      const t = await trade(trade_id);
      if (!t) return reply(`Trade #${trade_id} does not exist.`, { trade_id, exists: false });
      if (t.state === 'released') return reply(`Trade #${trade_id} is already released. Nothing to sign.`, t);
      if (t.state === 'cancelled') return reply(`Trade #${trade_id} was cancelled. Nothing to sign.`, t);
      const split = tradeSplit(t.xmoney_wei);
      const p = prepared({
        action: `Release trade #${trade_id} — hand over the escrowed $xMoney`,
        chainId: XGAS_CHAIN_ID,
        to: L4.escrow,
        data: encodeFunctionData({ abi: ESCROW_ABI, functionName: 'releaseTrade', args: [BigInt(trade_id)] }),
        value: 0n,
        asset: 'native $xMoney held in escrow',
        amount: `${t.xmoney} $xMoney`,
        counterparty: `buyer @${t.buyer_x_handle} (${t.buyer})`,
        fees: [
          { label: 'Burn', amount: `${fmtXMoney(split.burn)} xMoney`, note: '0.01% to 0x…dEaD' },
          { label: 'FanoutSink rake', amount: `${fmtXMoney(split.rake)} xMoney`, note: '0.01%' },
          { label: 'XGAS.DEV buy & burn', amount: `${fmtXMoney(split.buyback)} xMoney`, note: '0.02%, bridged to Robinhood to buy and burn XGAS.DEV' },
        ],
        net: `${fmtXMoney(split.net)} $xMoney to @${t.buyer_x_handle}`,
        timeline: ['Immediate and final, in one transaction on xGas'],
        irreversible: `This releases the escrow. If the ${t.fiat_due} never actually arrived in your X Money account, you have given away ${t.xmoney} $xMoney for nothing and no one can undo it. Check your account, not the chat, before signing.`,
        notes: [`You were owed ${t.fiat_due} from @${t.buyer_x_handle}.`, 'Only the seller can call this.'],
      });
      return reply(renderApproval(p), p);
    },
  },

  {
    name: 'reclaim_timeout',
    description: 'Prepare an unsigned cancelTradeTimeout: seller reclaims escrow after the 15-minute deadline when the buyer never paid.',
    inputSchema: { type: 'object', properties: { trade_id: { type: 'integer', minimum: 0 } }, required: ['trade_id'], additionalProperties: false },
    async handler({ trade_id }) {
      const t = await trade(trade_id);
      if (!t) return reply(`Trade #${trade_id} does not exist.`, { trade_id, exists: false });
      if (t.state === 'released' || t.state === 'cancelled') return reply(`Trade #${trade_id} is already ${t.state}. Nothing to sign.`, t);
      if (t.seconds_left > 0) {
        return reply(`Trade #${trade_id} still has ${t.seconds_left}s on the clock. The escrow cannot be reclaimed until the deadline passes — the contract will revert. Nothing prepared.`, t);
      }
      const p = prepared({
        action: `Reclaim trade #${trade_id} after timeout`,
        chainId: XGAS_CHAIN_ID,
        to: L4.escrow,
        data: encodeFunctionData({ abi: ESCROW_ABI, functionName: 'cancelTradeTimeout', args: [BigInt(trade_id)] }),
        value: 0n,
        asset: 'native $xMoney held in escrow',
        amount: `${t.xmoney} $xMoney`,
        counterparty: `was owed by @${t.buyer_x_handle}`,
        fees: [],
        net: t.side === 'ask' ? `${t.xmoney} $xMoney returned to order #${t.order_id}` : `${t.xmoney} $xMoney returned to you`,
        timeline: ['Immediate, one transaction on xGas'],
        irreversible: `This cancels the trade. If the buyer did pay you ${t.fiat_due} and you reclaim anyway, you have taken their money.`,
        notes: ['Only the seller can call this, and only after the deadline.'],
      });
      return reply(renderApproval(p), p);
    },
  },

  {
    name: 'cancel_order',
    description: 'Prepare an unsigned cancelOrder: the maker closes an order and takes back any uncommitted $xMoney.',
    inputSchema: { type: 'object', properties: { order_id: { type: 'integer', minimum: 0 } }, required: ['order_id'], additionalProperties: false },
    async handler({ order_id }) {
      const o = await order(order_id);
      if (!o) return reply(`Order #${order_id} does not exist.`, { order_id, exists: false });
      if (!o.active && o.available_wei === 0n) return reply(`Order #${order_id} is already closed and holds nothing. Nothing to sign.`, o);
      const p = prepared({
        action: `Cancel order #${order_id}`,
        chainId: XGAS_CHAIN_ID,
        to: L4.escrow,
        data: encodeFunctionData({ abi: ESCROW_ABI, functionName: 'cancelOrder', args: [BigInt(order_id)] }),
        value: 0n,
        asset: o.side === 'ask' ? 'native $xMoney in escrow' : 'a fiat commitment (nothing escrowed)',
        amount: `${o.available_xmoney} $xMoney uncommitted`,
        counterparty: `Escrow ${L4.escrow}`,
        fees: [],
        net: o.side === 'ask' ? `${o.available_xmoney} $xMoney back to ${o.maker}` : 'nothing to return — a bid escrows nothing',
        timeline: ['Immediate, one transaction on xGas'],
        irreversible: 'The order closes. Trades already opened against it keep running on their own clocks and are unaffected.',
        notes: ['Only the maker can cancel.'],
      });
      return reply(renderApproval(p), p);
    },
  },

  {
    name: 'submit_otc',
    description: 'Broadcast any signed OTC transaction on xGas (post, fill, release, reclaim, cancel).',
    inputSchema: {
      type: 'object',
      properties: { ...submitFields },
      required: ['signed_tx', 'idempotency_key'],
      additionalProperties: false,
    },
    async handler({ signed_tx, idempotency_key }) {
      const res = await submitRaw({ chainId: XGAS_CHAIN_ID, signedTx: signed_tx, idempotencyKey: idempotency_key, kind: 'otc' });
      return reply(res.replayed ? `Already submitted under this key: ${res.hash}.` : `Sent on xGas: ${res.hash}.`, res);
    },
  },
];

export { order, trade, tradeSplit };
