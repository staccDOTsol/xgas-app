// Formatting shared by the OG cards and the link-preview text, so the image and the title always agree.

const WEI = 10n ** 18n;

/** Wei (bigint or decimal string) to a JS number of ETH, for display only. */
export function weiToEth(wei) {
  const w = BigInt(wei);
  return Number(w / WEI) + Number(w % WEI) / 1e18;
}

/** ETH for display: four significant digits under 1000, two decimals (grouped) at or above. No trailing zeros. */
export function fmtEth(wei) {
  const v = weiToEth(wei);
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  let s = v.toPrecision(4);
  if (s.includes('e')) s = v.toFixed(8);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

/** Cents (number, bigint or string) to "$2,690.00". */
export function fmtUsd(cents) {
  const c = BigInt(cents);
  const neg = c < 0n;
  const a = neg ? -c : c;
  const dollars = (a / 100n).toLocaleString('en-US');
  const rest = String(a % 100n).padStart(2, '0');
  return `${neg ? '-' : ''}$${dollars}.${rest}`;
}

/** "+0.12%" / "-1.30%" (plain hyphen-minus) for a price against the fair price, or null without one. */
export function fmtVsFair(priceCents, fairCents) {
  if (fairCents == null || !(Number(fairCents) > 0)) return null;
  const pct = ((Number(priceCents) - Number(fairCents)) / Number(fairCents)) * 100;
  if (!Number.isFinite(pct)) return null;
  const r = Math.round(pct * 100) / 100;
  return `${r >= 0 ? '+' : '-'}${Math.abs(r).toFixed(2)}%`;
}

/** Dollars for an ETH amount at a price, in cents (floored like the contract's _cents). */
export function centsFor(wei, priceCentsPerEth) {
  return (BigInt(wei) * BigInt(priceCentsPerEth)) / WEI;
}

/**
 * "min to max" ETH per trade as a taker sees it now: an open order can never fill more than what is left on it.
 * m: { minWei, maxWei, remainingWei, status }
 */
export function tradeRange(m) {
  const max = BigInt(m.maxWei), left = BigInt(m.remainingWei);
  const cap = m.status === 'OPEN' && left < max ? left : max;
  return `${fmtEth(m.minWei)} to ${fmtEth(cap)}`;
}

/**
 * An X handle from the chain, for display. The contract only checks its length, so anything outside X's own
 * alphabet ([A-Za-z0-9_], at most 15) is dropped rather than rendered. Returns '' when nothing usable is left.
 */
export function cleanHandle(raw) {
  return String(raw || '').replace(/^@+/, '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 15);
}

export function shortAddr(a) {
  const s = String(a || '');
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? `${s.slice(0, 6)}...${s.slice(-4)}` : '';
}

/** "@handle", or the short address when the handle is unusable. */
export function who(handle, address) {
  const h = cleanHandle(handle);
  return h ? `@${h}` : (shortAddr(address) || 'unknown');
}

/** One line on what a trade's status means, for the trade card and its preview text. */
export const TRADE_NOTE = {
  Open: 'Waiting for the buyer to pay on X Money.',
  Paid: 'Marked paid; waiting for the seller to release.',
  Released: 'The seller released the ETH to the buyer.',
  Claimed: 'The buyer claimed the ETH after the release window.',
  Cancelled: 'Cancelled unpaid; the ETH went back.',
  Disputed: 'In dispute: staked arbiters decide.',
  Resolved: 'Settled by the staked arbiters.',
};
