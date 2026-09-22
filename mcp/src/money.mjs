import { formatUnits, parseUnits } from 'viem';
import { USDG_DECIMALS } from './config.mjs';

export const toBig = (v) => (typeof v === 'bigint' ? v : BigInt(v));

/** Decimal string -> wei. Accepts "12", "12.5", 12.5, or a bigint. */
export function parseAmount(value, decimals) {
  if (typeof value === 'bigint') return value;
  const s = String(value).trim().replace(/,/g, '');
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') throw new Error(`Not a number: ${value}`);
  return parseUnits(s, decimals);
}

export const parseXMoney = (v) => parseAmount(v, 18);
export const parseUsdg = (v) => parseAmount(v, USDG_DECIMALS);

const trim = (s) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

export const fmtXMoney = (wei) => trim(formatUnits(toBig(wei), 18));
export const fmtUsdg = (u) => trim(formatUnits(toBig(u), USDG_DECIMALS));

/** navRay is 18-decimal USD per whole xMoney. */
export const fmtNav = (navRay) => trim(formatUnits(toBig(navRay), 18));

export function usd(cents) {
  const c = Number(toBig(cents));
  return `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const bpsPct = (bps) => `${(Number(bps) / 100).toFixed(2)}%`;

/** USD value of an xMoney amount at a given navRay (both 18dp) -> integer cents. */
export function xMoneyToCents(weiXMoney, navRay) {
  return (toBig(weiXMoney) * toBig(navRay) * 100n) / (10n ** 18n * 10n ** 18n);
}

/** Escrow's own pricing: cents = amount * fiatRateBps / (1e18 * 100). Mirrors _expectedCents. */
export function expectedCents(weiXMoney, fiatRateBps) {
  return (toBig(weiXMoney) * toBig(fiatRateBps)) / (10n ** 18n * 100n);
}

export const rateToUsd = (fiatRateBps) => Number(toBig(fiatRateBps)) / 10000;

/** JSON.stringify that survives bigints. */
export const json = (obj, space = 2) =>
  JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), space);
