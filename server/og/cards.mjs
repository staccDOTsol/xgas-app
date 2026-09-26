// The three Robinhood desk cards (1200x630): the desk, one order, one trade. Pure functions of a plain view model
// (built in robinhood.mjs from on-chain reads), so the same model also keys the image cache.
import { h } from './render.mjs';
import { fmtEth, fmtUsd, fmtVsFair, centsFor, who, tradeRange, TRADE_NOTE } from './format.mjs';

const C = {
  bg: '#0b0e17',
  panel: 'rgba(14,19,32,0.82)',
  line: 'rgba(52,211,153,0.24)',
  tile: 'rgba(255,255,255,0.035)',
  tileLine: 'rgba(148,163,184,0.20)',
  text: '#f8fafc',
  soft: '#cbd5e1',
  muted: '#94a3b8',
  dim: '#64748b',
  emerald: '#34d399',
  mint: '#6ee7b7',
  rose: '#fda4af',
  cyan: '#67e8f9',
  amber: '#fcd34d',
  violet: '#c4b5fd',
};
const SANS = 'Space Grotesk';
const MONO = 'JetBrains Mono';
const INNER_W = 1040; // usable width inside the panel

const LOGO = 'data:image/svg+xml;base64,' + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 512 512">'
  + '<defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6ee7b7"/><stop offset="1" stop-color="#34d399"/></linearGradient>'
  + '<linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#34d399"/><stop offset="1" stop-color="#10b981"/></linearGradient>'
  + '<linearGradient id="c" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#10b981"/><stop offset="1" stop-color="#059669"/></linearGradient></defs>'
  + '<rect width="512" height="512" rx="112" fill="#10141f"/>'
  + '<rect x="18" y="18" width="476" height="476" rx="96" fill="none" stroke="#34d399" stroke-width="18"/>'
  + '<path fill="url(#a)" d="M128 168 L256 104 L384 168 L256 232 Z"/>'
  + '<path fill="url(#b)" d="M128 248 L256 184 L384 248 L256 312 Z"/>'
  + '<path fill="url(#c)" d="M128 328 L256 264 L384 328 L256 392 Z"/>'
  + '</svg>',
).toString('base64');

/** Font size that keeps `text` within `width` px, given its average advance in em. */
function fit(text, width, max, em = 0.6, min = 18) {
  const n = Math.max(1, String(text).length);
  return Math.max(min, Math.min(max, Math.floor(width / (n * em))));
}

function pill(text, color, { size = 22, bg, border } = {}) {
  return h('div', {
    style: {
      alignItems: 'center', padding: '8px 16px', borderRadius: 12,
      background: bg || 'rgba(255,255,255,0.04)', border: `1.5px solid ${border || color}`,
      color, fontFamily: MONO, fontWeight: 700, fontSize: size, letterSpacing: 1.5,
    },
  }, text);
}

function tile(label, value, sub, { color = C.text, flex = 1, valueSize = 40, valueFont = MONO, subSize = 20 } = {}) {
  return h('div', {
    style: {
      flex, flexDirection: 'column', padding: '20px 24px', borderRadius: 18,
      background: C.tile, border: `1.5px solid ${C.tileLine}`, minWidth: 0,
    },
  },
  h('div', { style: { fontFamily: MONO, fontSize: 19, fontWeight: 700, letterSpacing: 2.5, color: C.muted } }, label),
  h('div', { style: { marginTop: 8, whiteSpace: 'nowrap', fontFamily: valueFont, fontWeight: 700, fontSize: valueSize, color, lineHeight: 1.1 } }, value),
  sub ? h('div', { style: { marginTop: 6, whiteSpace: 'nowrap', fontFamily: MONO, fontSize: subSize, color: C.muted } }, sub) : null);
}

/**
 * Font size for the status + id pills in the header, so both fit in the ~396 px right of the site name
 * (each pill adds 35 px of padding and border, plus a 12 px gap; mono advance 0.6 em + 1.5 px letter spacing).
 */
function headerPillSize(...labels) {
  const n = Math.max(1, labels.join('').length);
  return Math.max(14, Math.min(22, Math.floor(((396 - 35 * labels.length - 12) / n - 1.5) / 0.6)));
}

function header(right) {
  return h('div', { style: { alignItems: 'center', justifyContent: 'space-between', width: '100%' } },
    h('div', { style: { alignItems: 'center' } },
      h('img', { src: LOGO, width: 52, height: 52, style: { width: 52, height: 52 } }),
      h('div', { style: { marginLeft: 16, fontFamily: SANS, fontWeight: 700, fontSize: 32, color: C.text, letterSpacing: 1 } }, 'XMONEY'),
      h('div', { style: { marginLeft: 10, fontFamily: SANS, fontWeight: 700, fontSize: 32, color: C.emerald, letterSpacing: 1 } }, 'ORBIT'),
      h('div', { style: { marginLeft: 16, fontFamily: MONO, fontSize: 26, color: C.dim } }, '/'),
      h('div', { style: { marginLeft: 16, fontFamily: MONO, fontWeight: 700, fontSize: 24, color: C.mint } }, 'xgas.dev/robinhood')),
    h('div', { style: { alignItems: 'center', gap: 12 } }, right));
}

function footer(url) {
  return h('div', { style: { alignItems: 'center', justifyContent: 'space-between', width: '100%' } },
    h('div', { style: { flexShrink: 0, whiteSpace: 'nowrap', fontFamily: MONO, fontWeight: 700, fontSize: fit(url, 400, 27), color: C.emerald } }, url),
    h('div', { style: { alignItems: 'center', gap: 14, flexShrink: 0 } },
      h('div', { style: { fontFamily: MONO, fontSize: 18, color: C.muted } }, 'no admin escrow · staked arbiters'),
      h('div', { style: { fontFamily: MONO, fontWeight: 700, fontSize: 17, color: C.amber, padding: '4px 10px', borderRadius: 8, border: '1.5px solid rgba(252,211,77,0.55)', background: 'rgba(252,211,77,0.08)', letterSpacing: 1 } }, 'ALPHA, UNAUDITED')));
}

// The glow is a native SVG radial gradient in an image: satori's CSS radial-gradient becomes masks and patterns
// that cost resvg ~0.4 s a card, this costs almost nothing.
const GLOW = 'data:image/svg+xml;base64,' + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">'
  + '<defs><radialGradient id="g" cx="1056" cy="0" r="700" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#10b981" stop-opacity="0.30"/><stop offset="1" stop-color="#10b981" stop-opacity="0"/></radialGradient>'
  + '<radialGradient id="c" cx="0" cy="630" r="560" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#67e8f9" stop-opacity="0.10"/><stop offset="1" stop-color="#67e8f9" stop-opacity="0"/></radialGradient></defs>'
  + '<rect width="1200" height="630" fill="#0b0e17"/><rect width="1200" height="630" fill="url(#g)"/><rect width="1200" height="630" fill="url(#c)"/>'
  + '</svg>',
).toString('base64');

function frame(right, body, url) {
  return h('div', { style: { width: '100%', height: '100%', padding: 28, background: C.bg } },
  h('img', { src: GLOW, width: 1200, height: 630, style: { position: 'absolute', left: 0, top: 0, width: 1200, height: 630 } }),
  h('div', {
    style: {
      flex: 1, flexDirection: 'column', justifyContent: 'space-between', padding: '36px 50px 34px',
      borderRadius: 28, border: `1.5px solid ${C.line}`, background: C.panel,
    },
  }, header(right), body, footer(url)));
}

const SIDE_COLOR = { sell: C.rose, buy: C.mint };
const ORDER_STATUS_COLOR = { OPEN: C.emerald, FILLED: C.cyan, CANCELLED: C.muted };
const TRADE_STATUS_COLOR = { Open: C.amber, Paid: C.cyan, Released: C.emerald, Claimed: C.emerald, Cancelled: C.muted, Disputed: C.rose, Resolved: C.violet };

// ---------------------------------------------------------------------------------------------------------------
/** m: { bestAskCents, bestBidCents, openOrders, asks, bids, fairCents, fairSources } (any may be null). */
export function deskCard(m) {
  // openOrders null means the book could not be read: say n/a, never "none yet".
  const none = h('div', { style: { color: C.dim } }, m.openOrders == null ? 'n/a' : 'none yet');
  const ask = m.bestAskCents != null ? fmtUsd(m.bestAskCents) : null;
  const bid = m.bestBidCents != null ? fmtUsd(m.bestBidCents) : null;
  const fair = m.fairCents != null ? fmtUsd(m.fairCents) : null;
  const size = (s) => fit(s || '', 200, 40);
  const body = h('div', { style: { flexDirection: 'column', width: '100%' } },
    h('div', { style: { alignItems: 'center', fontFamily: SANS, fontWeight: 700, fontSize: 62, color: C.text, lineHeight: 1.05 } },
      h('div', null, 'X Money dollars'),
      h('div', { style: { marginLeft: 20, marginRight: 20, color: C.emerald } }, '↔'),
      h('div', null, 'Robinhood ETH')),
    h('div', { style: { marginTop: 14, fontFamily: SANS, fontWeight: 500, fontSize: 30, color: C.soft } },
      'Peer to peer: pay on X Money, get native ETH, or the other way.'),
    h('div', { style: { marginTop: 34, gap: 16, width: '100%' } },
      tile('BEST ASK', ask || none, ask ? 'buy ETH here' : null, { color: C.rose, valueSize: size(ask) }),
      tile('BEST BID', bid || none, bid ? 'sell ETH here' : null, { color: C.mint, valueSize: size(bid) }),
      tile('OPEN ORDERS', m.openOrders != null ? String(m.openOrders) : none,
        m.openOrders != null ? `${m.asks ?? 0} sell · ${m.bids ?? 0} buy` : null,
        { valueSize: 40, subSize: fit(`${m.asks ?? 0} sell · ${m.bids ?? 0} buy`, 200, 20, 0.6, 12) }),
      tile('FAIR ETH', fair || h('div', { style: { color: C.dim } }, 'n/a'), fair ? (m.fairSources > 1 ? `median of ${m.fairSources}` : 'spot') : null, { color: C.cyan, valueSize: size(fair) })));
  return frame(pill('ROBINHOOD CHAIN 4663', C.muted, { size: 19, border: C.tileLine }), body, 'xgas.dev/robinhood');
}

// ---------------------------------------------------------------------------------------------------------------
/** m: { id, side: 'sell'|'buy', handle, maker, priceCents, remainingWei, minWei, maxWei, status, fairCents } */
export function orderCard(m) {
  const sell = m.side === 'sell';
  const color = SIDE_COLOR[m.side] || C.text;
  const price = fmtUsd(m.priceCents);
  const vs = fmtVsFair(m.priceCents, m.fairCents);
  const open = m.status === 'OPEN';
  const handle = who(m.handle, m.maker);
  const left = BigInt(m.remainingWei);
  const leftUsd = left > 0n ? `≈ ${fmtUsd(centsFor(left, m.priceCents))}` : null;
  const range = tradeRange(m);

  const body = h('div', { style: { flexDirection: 'column', width: '100%' } },
    h('div', { style: { justifyContent: 'space-between', alignItems: 'flex-end', width: '100%' } },
      h('div', { style: { flexDirection: 'column', flex: 1, minWidth: 0, marginRight: 24 } },
        h('div', { style: { whiteSpace: 'nowrap', fontFamily: SANS, fontWeight: 700, fontSize: 104, lineHeight: 1, color, letterSpacing: 1, opacity: open ? 1 : 0.6 } }, sell ? 'SELL ETH' : 'BUY ETH'),
        h('div', { style: { marginTop: 14, fontFamily: SANS, fontWeight: 500, fontSize: 32, color: open ? C.soft : C.muted } },
          open ? (sell ? 'Buy ETH with X Money dollars' : 'Sell ETH for X Money dollars') : `This order is ${m.status.toLowerCase()}`)),
      h('div', { style: { flexDirection: 'column', alignItems: 'flex-end', flexShrink: 0 } },
        h('div', { style: { whiteSpace: 'nowrap', fontFamily: MONO, fontWeight: 700, fontSize: fit(price, 470, 84), color: C.text, lineHeight: 1 } }, price),
        h('div', { style: { marginTop: 14, alignItems: 'center', gap: 12 } },
          h('div', { style: { fontFamily: MONO, fontSize: 24, color: C.muted } }, 'per ETH'),
          vs ? pill(`${vs} vs fair`, C.cyan, { size: 20, border: 'rgba(103,232,249,0.45)', bg: 'rgba(103,232,249,0.08)' }) : null))),
    h('div', { style: { marginTop: 34, gap: 16, width: '100%' } },
      tile('AMOUNT LEFT', `${fmtEth(left)} ETH`, leftUsd, { flex: 1, valueSize: fit(`${fmtEth(left)} ETH`, 225, 36) }),
      tile('PER TRADE', range, 'ETH, min to max', { flex: 1.35, valueSize: fit(range, 320, 36) }),
      tile('MAKER', handle, sell ? 'gets paid on X Money' : 'pays on X Money', { flex: 1.25, color: C.mint, valueSize: fit(handle, 295, 36) })));

  const pillSize = headerPillSize(m.status, `ORDER #${m.id}`);
  const right = [
    pill(m.status, ORDER_STATUS_COLOR[m.status] || C.muted, { size: pillSize }),
    pill(`ORDER #${m.id}`, C.soft, { size: pillSize, border: C.tileLine }),
  ];
  return frame(right, body, `xgas.dev/robinhood/order/${m.id}`);
}

// ---------------------------------------------------------------------------------------------------------------
/** m: { id, orderId, seller, buyer, sellerHandle, buyerHandle, ethWei, cents, priceCents (the order's, or null), status } */
export function tradeCard(m) {
  const eth = `${fmtEth(m.ethWei)} ETH`;
  const usd = fmtUsd(m.cents);
  const perEth = m.priceCents ? fmtUsd(m.priceCents) : null;
  const seller = who(m.sellerHandle, m.seller);
  const buyer = who(m.buyerHandle, m.buyer);
  const color = TRADE_STATUS_COLOR[m.status] || C.muted;

  const body = h('div', { style: { flexDirection: 'column', width: '100%' } },
    h('div', { style: { justifyContent: 'space-between', alignItems: 'flex-end', width: '100%' } },
      h('div', { style: { flexDirection: 'column', flex: 1, minWidth: 0, marginRight: 32 } },
        h('div', { style: { whiteSpace: 'nowrap', fontFamily: MONO, fontWeight: 700, fontSize: fit(eth, 560, 92), lineHeight: 1, color: C.text } }, eth),
        h('div', { style: { marginTop: 14, fontFamily: SANS, fontWeight: 500, fontSize: 30, lineHeight: 1.2, color: C.soft } }, TRADE_NOTE[m.status] || '')),
      h('div', { style: { flexDirection: 'column', alignItems: 'flex-end', flexShrink: 0 } },
        h('div', { style: { whiteSpace: 'nowrap', fontFamily: MONO, fontWeight: 700, fontSize: fit(usd, 420, 72), lineHeight: 1, color: C.mint } }, usd),
        h('div', { style: { marginTop: 14, whiteSpace: 'nowrap', fontFamily: MONO, fontSize: 22, color: C.muted } }, perEth ? `on X Money · ${perEth}/ETH` : 'on X Money'))),
    h('div', { style: { marginTop: 34, gap: 16, width: '100%', alignItems: 'stretch' } },
      tile('SELLER', seller, 'sends the ETH', { flex: 1.3, color: C.rose, valueSize: fit(seller, 300, 36) }),
      h('div', { style: { alignItems: 'center', fontFamily: SANS, fontWeight: 700, fontSize: 44, color: C.emerald } }, '→'),
      tile('BUYER', buyer, 'pays on X Money', { flex: 1.3, color: C.mint, valueSize: fit(buyer, 300, 36) }),
      tile('ORDER', `#${m.orderId}`, 'on the desk', { flex: 0.8, valueSize: fit(`#${m.orderId}`, 160, 36) })));

  const pillSize = headerPillSize(m.status.toUpperCase(), `TRADE #${m.id}`);
  const right = [
    pill(m.status.toUpperCase(), color, { size: pillSize }),
    pill(`TRADE #${m.id}`, C.soft, { size: pillSize, border: C.tileLine }),
  ];
  return frame(right, body, `xgas.dev/robinhood/trade/${m.id}`);
}
