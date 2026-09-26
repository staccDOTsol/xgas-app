// Quote math for gas paid in XGAS.DEV. Pure functions plus one small stateful price tracker, so every number is
// unit tested without a chain.
//
//   max xMoney gas cost (wei)  ->  USD at the xMoney NAV  ->  XGAS.DEV at the v4 graduation pool price
//   (ETH/XGAS.DEV spot, sanity-checked against a 10 minute EMA, times the median ETH/USD)  ->  +10% buffer.
//
// All fixed point is WAD (1e18). XGAS.DEV and xMoney are both 18 decimals, so wei ratios are token ratios.
import { encodeAbiParameters, keccak256 } from 'viem';

export const WAD = 10n ** 18n;
const Q192 = 1n << 192n;

/** keccak256(abi.encode(PoolKey)) */
export function v4PoolId({ currency0, currency1, fee, tickSpacing, hooks }) {
  return keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
    [currency0, currency1, fee, tickSpacing, hooks],
  ));
}
/** The PoolManager storage slot of pools[poolId] (StateLibrary: POOLS_SLOT = 6). slot0 is its first word. */
export function v4Slot0StorageSlot(poolId) {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolId, 6n]));
}
/** Decode the packed Slot0 word: sqrtPriceX96 (160) | tick (24) | protocolFee (24) | lpFee (24). */
export function decodeSlot0(word) {
  const v = BigInt(word);
  const sqrtPriceX96 = v & ((1n << 160n) - 1n);
  const tick = Number(BigInt.asIntN(24, (v >> 160n) & 0xffffffn));
  const protocolFee = Number((v >> 184n) & 0xffffffn);
  const lpFee = Number((v >> 208n) & 0xffffffn);
  return { sqrtPriceX96, tick, protocolFee, lpFee };
}
/** token1 per token0 in WAD from sqrtPriceX96 (raw units; equal decimals make it the token price too). */
export function priceWadFromSqrtX96(sqrtPriceX96) {
  const s = BigInt(sqrtPriceX96);
  if (s <= 0n) throw new Error('pool not initialized');
  return (s * s * WAD) / Q192;
}

/** A decimal string or number of dollars/tokens -> WAD bigint. Rejects anything that is not a plain positive decimal. */
export function decToWad(v) {
  const s = typeof v === 'number' ? v.toFixed(18) : String(v).trim();
  const m = /^(\d{1,30})(?:\.(\d{0,36}))?$/.exec(s);
  if (!m) throw new Error(`not a decimal: ${s}`);
  const frac = (m[2] || '').slice(0, 18).padEnd(18, '0');
  return BigInt(m[1]) * WAD + BigInt(frac);
}
export function wadToDec(w, dp = 6) {
  const neg = w < 0n; const a = neg ? -w : w;
  const i = a / WAD; const f = (a % WAD).toString().padStart(18, '0').slice(0, dp);
  return `${neg ? '-' : ''}${i}${dp ? `.${f}` : ''}`;
}

/** xMoney NAV from getReserveNAV()'s first word. The deployed vault returns it WAD scaled despite the name navRay;
 *  a real ray (1e27) is scaled down. Outside [0.5, 2] USD the read is treated as broken and 1.0 is used. */
export function navWadFromVault(navRaw) {
  if (navRaw == null) return { navWad: WAD, source: 'default 1.0' };
  let n = BigInt(navRaw);
  if (n > 10n ** 24n) n = n / 10n ** 9n;
  if (n < WAD / 2n || n > WAD * 2n) return { navWad: WAD, source: 'default 1.0 (vault NAV out of range)' };
  return { navWad: n, source: 'vault getReserveNAV' };
}

/**
 * Tracks the XGAS.DEV-per-ETH pool price and a time-weighted EMA of it.
 * ema <- ema + (1 - exp(-dt / tau)) * (spot - ema), tau = 600 s by default.
 * check() refuses while warming up and when spot and EMA diverge by more than maxDivergenceBps.
 */
export class PriceTracker {
  constructor({ tauS = 600, warmupS = 60, maxDivergenceBps = 500, maxAgeS = 120, now = () => Date.now() } = {}) {
    Object.assign(this, { tauS, warmupS, maxDivergenceBps, maxAgeS, now });
    this.ema = null; this.spot = null; this.firstAt = null; this.lastAt = null; this.samples = 0;
  }
  /** Feed one spot sample (a positive number, XGAS.DEV per ETH). */
  sample(spot) {
    if (!(Number.isFinite(spot) && spot > 0)) throw new Error('bad spot price');
    const t = this.now();
    if (this.ema == null) { this.ema = spot; this.firstAt = t; }
    else {
      const dt = Math.max(0, (t - this.lastAt) / 1000);
      const alpha = 1 - Math.exp(-dt / this.tauS);
      this.ema += alpha * (spot - this.ema);
    }
    this.spot = spot; this.lastAt = t; this.samples++;
    return this.state();
  }
  divergenceBps() {
    if (this.ema == null || this.spot == null) return null;
    return Math.round((Math.abs(this.spot - this.ema) / this.ema) * 10_000);
  }
  state() {
    return { spot: this.spot, ema: this.ema, divergenceBps: this.divergenceBps(), samples: this.samples, firstAt: this.firstAt, lastAt: this.lastAt };
  }
  /** { ok, reason, conservative } where conservative = max(spot, ema): the more XGAS.DEV per ETH, the more the payer
   *  is charged, so the host never under-charges inside the allowed band. */
  check() {
    const t = this.now();
    if (this.spot == null) return { ok: false, reason: 'no pool price yet' };
    if ((t - this.lastAt) / 1000 > this.maxAgeS) return { ok: false, reason: 'pool price is stale' };
    if ((t - this.firstAt) / 1000 < this.warmupS) return { ok: false, reason: 'price average is still warming up' };
    const d = this.divergenceBps();
    if (d > this.maxDivergenceBps) return { ok: false, reason: `pool price moved ${(d / 100).toFixed(2)}% away from its 10 minute average` };
    return { ok: true, conservative: Math.max(this.spot, this.ema), divergenceBps: d };
  }
}

/** A positive float -> WAD bigint, keeping the float's 15 significant digits and nothing it does not have. */
export function floatToWad(x) {
  if (!(Number.isFinite(x) && x > 0)) throw new Error('bad float');
  const s = x.toPrecision(15);
  if (s.includes('e')) {
    const [m, e] = s.split('e'); const exp = Number(e);
    const [i, f = ''] = m.split('.'); const digits = BigInt(i + f); const shift = exp - f.length + 18;
    return shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
  }
  return decToWad(s);
}

/**
 * XGAS.DEV wei charged per xMoney wei, WAD scaled, buffer included.
 *   usd per xMoney      = navWad
 *   usd per XGAS.DEV    = ethUsdWad / xgasPerEthWad
 *   XGAS.DEV per xMoney = navWad * xgasPerEthWad / ethUsdWad
 */
export function rateWad({ navWad, xgasPerEthWad, ethUsdWad, bufferBps }) {
  if (navWad <= 0n || xgasPerEthWad <= 0n || ethUsdWad <= 0n) throw new Error('rate inputs must be positive');
  const base = (navWad * xgasPerEthWad) / ethUsdWad;
  return (base * BigInt(10_000 + Number(bufferBps))) / 10_000n;
}
/** ceil(maxCostWei * rateWad / 1e18) */
export function maxChargeFor(maxCostWei, rate) {
  return (BigInt(maxCostWei) * rate + WAD - 1n) / WAD;
}
