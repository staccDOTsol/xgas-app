// Link previews for the Robinhood desk (xgas.dev/robinhood): dynamic Open Graph PNGs and the page metadata that
// points at them.
//   GET /og/robinhood.png                 the desk: best ask, best bid, open orders, fair ETH price
//   GET /og/robinhood/order/:id.png       one order (an unknown or malformed id gets the desk card, never an error)
//   GET /og/robinhood/trade/:id.png       one trade (public on-chain fields only; the payment note is never shown)
// Everything is read from RobinhoodEthOtc on Robinhood Chain. Reads are cached for seconds, images for 60 s keyed
// by the exact fields they show. Rendering is capped per IP and globally, and any failure falls back to the desk
// card (or, if the renderer itself is down, the static /og.png), so a preview can never take the server down.
import crypto from 'crypto';
import fs from 'fs';
import { parseAbi } from 'viem';
import { fmtEth, fmtUsd, fmtVsFair, cleanHandle, who, tradeRange, TRADE_NOTE } from './format.mjs';

const OTC_ABI = parseAbi([
  'struct Order { address maker; uint8 side; string makerXHandle; uint256 priceCentsPerEth; uint256 remainingEth; uint256 minEth; uint256 maxEth; bool active; bool cancelled; }',
  'struct Trade { uint256 orderId; address seller; address buyer; string sellerXHandle; string buyerXHandle; uint256 ethAmount; uint256 expectedCents; uint64 openedAt; uint64 paidAt; uint8 status; string paymentNote; }',
  'function ordersLength() view returns (uint256)',
  'function tradesLength() view returns (uint256)',
  'function getOrder(uint256 orderId) view returns (Order)',
  'function getOrders(uint256 offset, uint256 limit) view returns (Order[])',
  'function getTrade(uint256 tradeId) view returns (Trade)',
]);
const TRADE_STATUS = ['Open', 'Paid', 'Released', 'Claimed', 'Cancelled', 'Disputed', 'Resolved'];

const IMAGE_TTL_MS = 60_000;
const ITEM_TTL_MS = 10_000;
const BOOK_TTL_MS = 15_000;
const COUNT_TTL_MS = 5_000;
const MAX_PNG_BYTES = 1024 * 1024;
const BOOK_SCAN_MAX = 2000; // the desk card scans at most the newest 2000 orders
const RENDER_CONCURRENCY = 2;
const RENDER_QUEUE_MAX = 24;
const IP_BURST = 30;          // renders (cache misses) an IP may cause at once (crawlers share IPs, so loose)...
const IP_REFILL_MS = 1_500;   // ...then one more every 1.5 s; the global queue above is what protects the CPU
const ID_RE = /^\d{1,20}$/;

const sha = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');

/** A Map with a size cap that drops the oldest entry first. */
function boundedSet(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

class Limited extends Error {}

/**
 * @param {object} o
 * @param {import('viem').PublicClient} o.client  Robinhood Chain reader
 * @param {string} o.otc                           RobinhoodEthOtc address ('' = not deployed)
 * @param {() => Promise<{cents:string, sources?:any[]}|null>} o.fairPrice  the /api/robinhood/eth-price median
 * @param {string} o.origin                        absolute origin for og:image / og:url (https://xgas.dev)
 * @param {(req) => string} o.ipKey                the per-IP limit key
 * @param {string} [o.fallbackPng]                 static card served if the renderer cannot run
 */
export function createRobinhoodOg({ client, otc, fairPrice, origin, ipKey, fallbackPng }) {
  // --- the renderer, loaded lazily so a broken install degrades to the static card instead of failing boot ---
  let rendererP = null;
  function renderer() {
    if (!rendererP) {
      rendererP = (async () => {
        const [render, cards] = await Promise.all([import('./render.mjs'), import('./cards.mjs')]);
        if (!(await render.initRenderer())) throw new Error('renderer unavailable');
        return { renderPng: render.renderPng, ...cards };
      })();
      rendererP.catch((e) => console.error('[og] link-preview renderer failed to load:', e?.message || e));
    }
    return rendererP;
  }

  // --- chain reads ------------------------------------------------------------------------------------------
  const read = (functionName, args) => {
    if (!otc) return Promise.reject(new Error('the Robinhood desk is not deployed'));
    return client.readContract({ address: otc, abi: OTC_ABI, functionName, args });
  };
  const counts = { orders: { at: 0, n: null }, trades: { at: 0, n: null } };
  async function count(kind, fresh = false) {
    const c = counts[kind];
    if (!fresh && c.n != null && Date.now() - c.at < COUNT_TTL_MS) return c.n;
    const n = await read(kind === 'orders' ? 'ordersLength' : 'tradesLength');
    counts[kind] = { at: Date.now(), n };
    return n;
  }
  /** Whether id exists, re-reading the length once so a brand-new order or trade is never reported missing. */
  async function exists(kind, id) {
    if ((await count(kind)) > id) return true;
    return (await count(kind, true)) > id;
  }

  const items = new Map(); // 'order:1' / 'trade:1' -> { at, v } (v null = no such id)
  async function item(kind, id) {
    const key = `${kind}:${id}`;
    const hit = items.get(key);
    if (hit && Date.now() - hit.at < ITEM_TTL_MS) return hit.v;
    const plural = kind === 'order' ? 'orders' : 'trades';
    const v = (await exists(plural, id)) ? await read(kind === 'order' ? 'getOrder' : 'getTrade', [id]) : null;
    boundedSet(items, key, { at: Date.now(), v }, 1000);
    return v;
  }

  // The book is served stale-while-revalidate: a page view never waits on a refresh while the last book is under
  // 5 minutes old.
  let book = { at: 0, v: null, p: null };
  function refreshBook() {
    if (book.p) return book.p;
    book.p = (async () => {
      const n = Number(await count('orders'));
      const start = Math.max(0, n - BOOK_SCAN_MAX);
      const pages = [];
      for (let off = start; off < n; off += 250) pages.push(read('getOrders', [BigInt(off), 250n]));
      const orders = (await Promise.all(pages)).flat();
      let bestAsk = null, bestBid = null, asks = 0, bids = 0;
      for (const o of orders) {
        if (!o.active) continue;
        const p = o.priceCentsPerEth;
        if (Number(o.side) === 0) { asks++; if (bestAsk == null || p < bestAsk) bestAsk = p; }
        else { bids++; if (bestBid == null || p > bestBid) bestBid = p; }
      }
      const v = { bestAskCents: bestAsk?.toString() ?? null, bestBidCents: bestBid?.toString() ?? null, openOrders: asks + bids, asks, bids };
      book = { at: Date.now(), v, p: null };
      return v;
    })().finally(() => { book.p = null; });
    return book.p;
  }
  async function readBook() {
    const age = Date.now() - book.at;
    if (book.v && age < BOOK_TTL_MS) return book.v;
    const p = refreshBook();
    if (book.v && age < 5 * 60_000) { p.catch(() => {}); return book.v; }
    return p;
  }

  /** The fair price, waiting at most ms for it (it is cached upstream for 20 s, so a warm read is instant). */
  async function fair(ms) {
    try {
      const b = await withTimeout(Promise.resolve().then(fairPrice), ms, 'fair price');
      const cents = Number(b?.cents);
      return cents > 0 ? { cents: String(Math.round(cents)), sources: Array.isArray(b.sources) ? b.sources.length : null } : null;
    } catch { return null; }
  }
  // Images wait for the fair price; page metadata (which people's browsers wait on too) barely does.
  const FAIR_WAIT_IMAGE_MS = 2500;
  const FAIR_WAIT_META_MS = 400;
  const META_READ_MS = 2000;

  // --- view models: plain JSON, the single input of both the card and the preview text -------------------------
  async function deskModel(fairMs = FAIR_WAIT_IMAGE_MS) {
    const [b, f] = await Promise.all([readBook().catch(() => null), fair(fairMs)]);
    return {
      kind: 'desk',
      bestAskCents: b?.bestAskCents ?? null,
      bestBidCents: b?.bestBidCents ?? null,
      openOrders: b ? b.openOrders : null,
      asks: b ? b.asks : null,
      bids: b ? b.bids : null,
      fairCents: f?.cents ?? null,
      fairSources: f?.sources ?? null,
    };
  }
  /** null = no such order; throws when the chain cannot be read. */
  async function orderModel(id, fairMs = FAIR_WAIT_IMAGE_MS) {
    const [o, f] = await Promise.all([item('order', id), fair(fairMs)]);
    if (!o) return null;
    return {
      kind: 'order',
      id: id.toString(),
      side: Number(o.side) === 0 ? 'sell' : 'buy',
      handle: cleanHandle(o.makerXHandle),
      maker: o.maker,
      priceCents: o.priceCentsPerEth.toString(),
      remainingWei: o.remainingEth.toString(),
      minWei: o.minEth.toString(),
      maxWei: o.maxEth.toString(),
      status: o.active ? 'OPEN' : o.cancelled ? 'CANCELLED' : 'FILLED',
      fairCents: f?.cents ?? null,
    };
  }
  async function tradeModel(id) {
    const t = await item('trade', id);
    if (!t) return null;
    // A trade is at its order's price; expectedCents is floored to the cent, so dividing it back is off on small trades.
    const o = await item('order', t.orderId).catch(() => null);
    return {
      kind: 'trade',
      id: id.toString(),
      orderId: t.orderId.toString(),
      seller: t.seller,
      buyer: t.buyer,
      sellerHandle: cleanHandle(t.sellerXHandle),
      buyerHandle: cleanHandle(t.buyerXHandle),
      ethWei: t.ethAmount.toString(),
      cents: t.expectedCents.toString(),
      priceCents: o ? o.priceCentsPerEth.toString() : null,
      status: TRADE_STATUS[Number(t.status)] || 'Open',
    };
  }
  const version = (m) => sha(m).slice(0, 12);
  const parseId = (raw) => (ID_RE.test(String(raw ?? '')) ? BigInt(raw) : null);

  // --- image cache, render queue, per-IP buckets ------------------------------------------------------------------
  const images = new Map(); // `${kind}:${id}:${version}` -> { at, png }
  const lastGood = new Map(); // `${kind}:${id}` -> png, served when the chain or the limiter says no
  const inflight = new Map();
  const buckets = new Map();
  let running = 0;
  const queue = [];

  function takeToken(key) {
    const now = Date.now();
    const b = buckets.get(key) || { tokens: IP_BURST, at: now };
    b.tokens = Math.min(IP_BURST, b.tokens + (now - b.at) / IP_REFILL_MS);
    b.at = now;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    boundedSet(buckets, key, b, 10_000);
    return ok;
  }
  function slot() {
    if (running < RENDER_CONCURRENCY) { running++; return Promise.resolve(); }
    if (queue.length >= RENDER_QUEUE_MAX) return Promise.reject(new Limited('render queue full'));
    return new Promise((resolve) => queue.push(resolve));
  }
  function release() {
    const next = queue.shift();
    if (next) next(); else running--;
  }

  async function pngFor(m, limitKey) {
    const target = `${m.kind}:${m.id ?? ''}`;
    const key = `${target}:${version(m)}`;
    const hit = images.get(key);
    if (hit && Date.now() - hit.at < IMAGE_TTL_MS) return hit.png;
    if (inflight.has(key)) return inflight.get(key);
    if (!takeToken(limitKey)) throw new Limited('rate limited');
    const p = (async () => {
      const r = await renderer();
      await slot();
      try {
        const tree = m.kind === 'order' ? r.orderCard(m) : m.kind === 'trade' ? r.tradeCard(m) : r.deskCard(m);
        const png = await r.renderPng(tree);
        if (png.length > MAX_PNG_BYTES) throw new Error(`${target} rendered to ${png.length} bytes, over the 1 MB cap`);
        boundedSet(images, key, { at: Date.now(), png }, 120);
        boundedSet(lastGood, target, png, 200);
        return png;
      } finally { release(); }
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }
  // Expired entries are dropped once a minute so the caches hold only what is still servable.
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of images) if (now - v.at >= IMAGE_TTL_MS) images.delete(k);
    for (const [k, v] of items) if (now - v.at >= ITEM_TTL_MS) items.delete(k);
    for (const [k, b] of buckets) if (now - b.at > IP_BURST * IP_REFILL_MS) buckets.delete(k);
  }, 60_000).unref();

  function sendPng(res, png, maxAge = 60) {
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': `public, max-age=${maxAge}`, 'X-Content-Type-Options': 'nosniff' });
    res.send(png);
  }
  function sendStatic(res) {
    if (fallbackPng && fs.existsSync(fallbackPng)) {
      res.set({ 'Cache-Control': 'public, max-age=60' });
      return res.type('png').sendFile(fallbackPng);
    }
    res.status(503).set('Retry-After', '30').type('text').send('Preview image unavailable.');
  }

  /** Serves the card for (kind, rawId); every path ends in a PNG or, at worst, a 429/503. Never throws. */
  async function serve(req, res, kind, rawId) {
    const limitKey = (() => { try { return ipKey(req); } catch { return 'unknown'; } })();
    const id = kind === 'desk' ? null : parseId(rawId);
    let m = null;
    try {
      if (id != null) m = kind === 'order' ? await withTimeout(orderModel(id), 8000, 'order read') : await withTimeout(tradeModel(id), 8000, 'trade read');
    } catch (e) {
      const prev = lastGood.get(`${kind}:${id}`);
      if (prev) return sendPng(res, prev, 10);
      console.warn(`[og] ${kind} ${id} read failed, serving the desk card:`, e?.shortMessage || e?.message || e);
    }
    try {
      if (!m) m = await deskModel();
      return sendPng(res, await pngFor(m, limitKey));
    } catch (e) {
      const prev = (m && lastGood.get(`${m.kind}:${m.id ?? ''}`)) || lastGood.get('desk:');
      if (prev) return sendPng(res, prev, 10);
      if (e instanceof Limited) {
        return res.status(429).set({ 'Retry-After': '10', 'Cache-Control': 'no-store' }).type('text').send('Too many preview renders; try again shortly.');
      }
      console.error(`[og] ${kind} card failed:`, e?.message || e);
      return sendStatic(res);
    }
  }

  function mountImages(app) {
    const wrap = (kind) => (req, res) => {
      serve(req, res, kind, req.params[0]).catch((e) => {
        console.error('[og] unexpected:', e?.message || e);
        if (!res.headersSent) sendStatic(res);
      });
    };
    app.get(/^\/og\/robinhood\.png$/, wrap('desk'));
    app.get(/^\/og\/robinhood\/order\/([^/]+)\.png$/, wrap('order'));
    app.get(/^\/og\/robinhood\/trade\/([^/]+)\.png$/, wrap('trade'));
    renderer().catch(() => {}); // warm up the fonts and the wasm at boot
  }

  // --- page metadata ------------------------------------------------------------------------------------------------
  const SITE = 'xgas.dev/robinhood';
  const TRUST = 'No admin escrow, staked arbiters settle disputes. Alpha, unaudited.';
  const deskImage = (m) => `${origin}/og/robinhood.png?v=${version(m)}`;

  function deskStats(m) {
    if (m.openOrders == null) return m.fairCents ? `Fair ETH ${fmtUsd(m.fairCents)}.` : '';
    const parts = [
      `best ask ${m.bestAskCents ? fmtUsd(m.bestAskCents) : 'none yet'}`,
      `best bid ${m.bestBidCents ? fmtUsd(m.bestBidCents) : 'none yet'}`,
      `${m.openOrders} open order${m.openOrders === 1 ? '' : 's'}`,
    ];
    if (m.fairCents) parts.push(`fair ETH ${fmtUsd(m.fairCents)}`);
    const s = parts.join(', ');
    return `${s[0].toUpperCase()}${s.slice(1)}.`;
  }
  function deskAlt(m) {
    return `X Money dollars to Robinhood ETH desk on ${SITE}. ${deskStats(m)}`.trim();
  }

  function deskMeta(page, m, url) {
    const stats = deskStats(m);
    const base = { url: url || `${origin}/robinhood${page === 'desk' ? '' : `/${page}`}`, image: deskImage(m), imageAlt: deskAlt(m) };
    if (page === 'post') {
      return { ...base, title: `Post an order: sell or buy Robinhood ETH for X Money dollars | ${SITE}`,
        description: `Set your price per ETH and a size range. Selling: your ETH waits in escrow on Robinhood Chain until you confirm the X Money payment. Buying: sellers escrow their ETH against your dollars. ${TRUST}` };
    }
    if (page === 'trades') {
      return { ...base, title: `My trades: X Money dollars ↔ Robinhood ETH | ${SITE}`,
        description: `Your trades on the desk: mark paid, release, dispute or claim. Trade native ETH on Robinhood Chain for dollars on X Money, person to person. ${stats} ${TRUST}`.replace(/\s+/g, ' ') };
    }
    if (page === 'arbiters') {
      return { ...base, title: `Arbiters: stake ETH and settle disputes | ${SITE}`,
        description: 'Stake ETH on Robinhood Chain and vote on disputed trades with commit and reveal. The majority is paid from the dispute bond and the slashed stakes of losing or silent voters. No admin: the contracts decide. Alpha, unaudited.' };
    }
    return { ...base, title: `X Money dollars ↔ Robinhood ETH, peer to peer | ${SITE}`,
      description: `Trade native ETH on Robinhood Chain for dollars on X Money, person to person. ${stats} The ETH sits in an on-chain escrow. ${TRUST}`.replace(/\s+/g, ' ') };
  }

  function orderMeta(m) {
    const SIDE = m.side === 'sell' ? 'SELL' : 'BUY';
    const price = fmtUsd(m.priceCents);
    const maker = who(m.handle, m.maker);
    const url = `${origin}/robinhood/order/${m.id}`;
    const image = `${origin}/og/robinhood/order/${m.id}.png?v=${version(m)}`;
    const vs = fmtVsFair(m.priceCents, m.fairCents);
    const vsText = vs ? ` (${vs} vs fair ${fmtUsd(m.fairCents)})` : '';
    const range = `${tradeRange(m)} ETH`;
    if (m.status !== 'OPEN') {
      return {
        url, image,
        title: `${SIDE} ETH at ${price} by ${maker} (${m.status}) on ${SITE}`,
        description: `This ${m.side} order by ${maker} is ${m.status.toLowerCase()}. Browse the open orders for Robinhood ETH against X Money dollars on ${SITE}. ${TRUST}`,
        imageAlt: `${SIDE} ETH at ${price} per ETH by ${maker}, order #${m.id}, ${m.status.toLowerCase()}, on ${SITE}`,
      };
    }
    const left = `${fmtEth(m.remainingWei)} ETH`;
    const description = m.side === 'sell'
      ? `Buy ${range} per trade from ${maker} at ${price} per ETH${vsText}. You pay in dollars on X Money; the ETH waits in escrow on Robinhood Chain until the seller releases it. ${TRUST}`
      : `Sell ${range} per trade to ${maker} at ${price} per ETH${vsText}. ${maker} pays you in dollars on X Money while your ETH waits in escrow on Robinhood Chain. ${TRUST}`;
    return {
      url, image, description,
      title: `${SIDE} ${left} at ${price} by ${maker} on ${SITE}`,
      imageAlt: `${SIDE} ETH at ${price} per ETH by ${maker}: ${left} left, ${range} per trade, order #${m.id} on ${SITE}`,
    };
  }

  function tradeMeta(m) {
    const eth = `${fmtEth(m.ethWei)} ETH`;
    const usd = fmtUsd(m.cents);
    const perEth = m.priceCents ? ` (${fmtUsd(m.priceCents)} per ETH)` : '';
    const seller = who(m.sellerHandle, m.seller);
    const buyer = who(m.buyerHandle, m.buyer);
    return {
      url: `${origin}/robinhood/trade/${m.id}`,
      image: `${origin}/og/robinhood/trade/${m.id}.png?v=${version(m)}`,
      title: `Trade #${m.id}: ${eth} for ${usd} (${m.status}) on ${SITE}`,
      description: `${seller} sells ${eth} to ${buyer} for ${usd} in dollars on X Money${perEth}, from order #${m.orderId}. ${TRADE_NOTE[m.status] || `Status: ${m.status}.`} The ETH is escrowed on Robinhood Chain. ${TRUST}`,
      imageAlt: `Trade #${m.id}: ${seller} sells ${eth} to ${buyer} for ${usd} on X Money, ${m.status.toLowerCase()}, on ${SITE}`,
    };
  }

  const EMPTY_DESK = { kind: 'desk', bestAskCents: null, bestBidCents: null, openOrders: null, asks: null, bids: null, fairCents: null, fairSources: null };
  async function desk() {
    try { return await withTimeout(deskModel(FAIR_WAIT_META_MS), META_READ_MS, 'desk read'); } catch { return EMPTY_DESK; }
  }

  /**
   * Metadata for a desk page: page is 'desk' | 'post' | 'trades' | 'arbiters' | 'order' | 'trade'. Never throws: anything that
   * goes wrong (bad id, unknown id, a slow or failing RPC) yields the desk's own card and text.
   */
  async function meta(page, rawId) {
    try {
      if (page === 'order' || page === 'trade') {
        const id = parseId(rawId);
        if (id == null) return deskMeta('desk', await desk()); // malformed: the desk, under the desk's own URL
        const url = `${origin}/robinhood/${page}/${id}`;
        let m = null, failed = false;
        try {
          m = await withTimeout(page === 'order' ? orderModel(id, FAIR_WAIT_META_MS) : tradeModel(id), META_READ_MS, `${page} read`);
        } catch (e) {
          failed = true;
          console.warn(`[og] ${page} ${id} meta read failed:`, e?.shortMessage || e?.message || e);
        }
        if (m) return page === 'order' ? orderMeta(m) : tradeMeta(m);
        const d = deskMeta('desk', await desk(), url);
        // The chain did not answer: point at the item's own image, which renders it if the chain is back by the
        // time the crawler fetches it and is the desk card otherwise.
        if (failed) d.image = `${origin}/og/robinhood/${page}/${id}.png?v=r${Math.floor(Date.now() / 60_000)}`;
        return d;
      }
      return deskMeta(['post', 'trades', 'arbiters'].includes(page) ? page : 'desk', await desk());
    } catch (e) {
      console.warn('[og] meta failed:', e?.message || e);
      return deskMeta('desk', EMPTY_DESK);
    }
  }

  return { mountImages, meta };
}
