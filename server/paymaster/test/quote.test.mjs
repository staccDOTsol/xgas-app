import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PriceTracker, WAD, decToWad, decodeSlot0, floatToWad, maxChargeFor, navWadFromVault, priceWadFromSqrtX96, rateWad, v4PoolId, wadToDec } from '../quote.mjs';
import { XGAS_DEV_POOL } from '../service.mjs';
import { SLOT0_WORD } from './fakes.mjs';

test('the XGAS.DEV graduation pool id is 0x33c7e7e6...5bc1', () => {
  assert.equal(v4PoolId(XGAS_DEV_POOL), '0x33c7e7e6ba4b65dfce2b32ff3fc453371b4048b44448a9591ad2a6c2a1c95bc1');
});

test('slot0 decode and price', () => {
  const s = decodeSlot0(SLOT0_WORD);
  assert.equal(s.sqrtPriceX96, 288237130324449461123632453233399n);
  assert.equal(s.tick, 163992);
  const p = Number(priceWadFromSqrtX96(s.sqrtPriceX96)) / 1e18;
  assert.ok(Math.abs(p - 13235510.08) < 1, String(p));          // XGAS.DEV per ETH
  assert.ok(Math.abs(Math.log(p) / Math.log(1.0001) - 163992) < 1); // consistent with the tick
  assert.equal(priceWadFromSqrtX96(1n << 96n), WAD);
  assert.throws(() => priceWadFromSqrtX96(0n));
  assert.equal(decodeSlot0(`0x${'f'.repeat(8)}${'0'.repeat(10)}${'ff'.repeat(3)}${'0'.repeat(40)}`).tick, -1);
});

test('rate: $1 xMoney, 13,000,000 XGAS.DEV per ETH, ETH $4,000 -> 3,250 per xMoney, 3,575 with 10%', () => {
  const r = rateWad({ navWad: WAD, xgasPerEthWad: 13_000_000n * WAD, ethUsdWad: 4000n * WAD, bufferBps: 1000 });
  assert.equal(r, 3575n * WAD);
  assert.equal(rateWad({ navWad: WAD, xgasPerEthWad: 13_000_000n * WAD, ethUsdWad: 4000n * WAD, bufferBps: 0 }), 3250n * WAD);
  // NAV above $1 charges proportionally more XGAS.DEV.
  assert.equal(rateWad({ navWad: decToWad('1.02'), xgasPerEthWad: 13_000_000n * WAD, ethUsdWad: 4000n * WAD, bufferBps: 0 }), 3315n * WAD);
  // 1e14 wei of gas (0.0001 xMoney) -> 0.3575 XGAS.DEV; ceil on dust.
  assert.equal(maxChargeFor(10n ** 14n, r), 3575n * 10n ** 14n);
  assert.equal(maxChargeFor(1n, WAD / 3n), 1n);
  assert.throws(() => rateWad({ navWad: 0n, xgasPerEthWad: WAD, ethUsdWad: WAD, bufferBps: 0 }));
});

test('decimal helpers and NAV scaling', () => {
  assert.equal(decToWad('4012.34'), 4012340000000000000000n);
  assert.equal(wadToDec(3575n * WAD + 5n * 10n ** 17n, 2), '3575.50');
  assert.throws(() => decToWad('-1'));
  assert.equal(floatToWad(13235510.080920), 13235510080920000000000000n);
  assert.equal(navWadFromVault(1000255901452423761n).navWad, 1000255901452423761n);
  assert.equal(navWadFromVault(1000255901452423761n * 10n ** 9n).navWad, 1000255901452423761n); // a real ray
  assert.equal(navWadFromVault(5n).navWad, WAD);                                               // broken read
  assert.equal(navWadFromVault(null).navWad, WAD);
});

test('PriceTracker: warm-up, staleness, 5% divergence refusal, conservative = max(spot, ema)', () => {
  let t = 0; const now = () => t;
  const pt = new PriceTracker({ tauS: 600, warmupS: 60, maxDivergenceBps: 500, maxAgeS: 120, now });
  assert.equal(pt.check().ok, false);
  pt.sample(1000);
  assert.match(pt.check().reason, /warming/);
  for (let i = 1; i <= 4; i++) { t += 30_000; pt.sample(1000); }
  let c = pt.check(); assert.equal(c.ok, true); assert.equal(c.conservative, 1000);
  // +4% spike: allowed, charged at the spot (more XGAS.DEV per ETH = more XGAS.DEV charged).
  t += 1_000; pt.sample(1040);
  c = pt.check(); assert.equal(c.ok, true); assert.equal(c.conservative, 1040);
  // -4%: allowed, charged at the EMA, which is still near 1000.
  t += 1_000; pt.sample(960);
  c = pt.check(); assert.equal(c.ok, true); assert.ok(c.conservative > 999 && c.conservative < 1001);
  // +8% in one step: refused.
  t += 1_000; pt.sample(1080);
  c = pt.check(); assert.equal(c.ok, false); assert.match(c.reason, /moved/);
  // The EMA follows over ~10 minutes; after enough time at 1080 the price is accepted again.
  for (let i = 0; i < 60; i++) { t += 30_000; pt.sample(1080); }
  assert.equal(pt.check().ok, true);
  // stale
  t += 121_000; assert.match(pt.check().reason, /stale/);
});

test('EMA time weighting: one tau moves 63.2% of the gap', () => {
  let t = 0; const pt = new PriceTracker({ tauS: 600, warmupS: 0, now: () => t });
  pt.sample(100); t = 600_000; pt.sample(200);
  assert.ok(Math.abs(pt.ema - (100 + 100 * (1 - Math.exp(-1)))) < 1e-9);
});

test('floatToWad handles large and tiny floats', () => {
  assert.equal(floatToWad(1e21), 10n ** 21n * WAD);
  assert.equal(floatToWad(1.5e-7), 150000000000n);
});
