// The true worst case for buying one token now and selling it straight back, from live state.
// maxLossBps() on the deployed curves assumes the floor sits at β of the price. It only does while
// floor/β is the binding term; once the step carries the price above that, the floor lags far behind
// and maxLossBps() understates the loss. The curves are immutable, so the honest number is computed here.
// Same math as mcp/src/nguRisk.mjs; keep the two in step.
//
// Mirrors NguToken exactly: fees per leg, each rounded down on its own (1 bp burn, 1 bp FanoutSink,
// plus 2 bp XGAS.DEV buyback on curves that have BUYBACK_BPS). After the buy, lastPrice = p, so the
// sell basis is min(floorAfter, p).
const BPS = 10000n;

const feesOn = (x: bigint, buybackBps: number) =>
  (x * 1n) / BPS + (x * 1n) / BPS + (x * BigInt(buybackBps)) / BPS;

export interface TrueMaxLoss {
  lossBps: number;
  proceeds: bigint;
  floorAfter: bigint;
}

export function trueMaxLoss(s: { nextPrice: bigint; reserve: bigint; supply: bigint; buybackBps: number }): TrueMaxLoss | null {
  const p = s.nextPrice;
  if (p <= 0n) return null;
  const floorAfter = (s.reserve + p - feesOn(p, s.buybackBps)) / (s.supply + 1n);
  const basis = floorAfter < p ? floorAfter : p;
  const proceeds = basis - feesOn(basis, s.buybackBps);
  // proceeds rounds down, so the loss rounds up: never flatter than the contract would pay.
  const lossBps = Number(BPS - (proceeds * BPS) / p);
  return { lossBps, proceeds, floorAfter };
}

/**
 * The contract's own figure is shown only when it disagrees with the live one by more than 1 bp,
 * labelled by direction: 'understated' when the live loss is larger, 'overstated' when it is smaller.
 */
export const contractSkew = (trueBps: number, contractBps: bigint): 'understated' | 'overstated' | null => {
  const c = Number(contractBps);
  if (trueBps > c + 1) return 'understated';
  if (trueBps < c - 1) return 'overstated';
  return null;
};
