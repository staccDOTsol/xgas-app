// The true worst case for buying one token now and selling it straight back, from live state.
// maxLossBps() on the deployed curves assumes the floor sits at β of the price. It only does while
// floor/β is the binding term; once the step carries the price above that, the floor lags far behind
// and maxLossBps() understates the loss. The curves are immutable, so the honest number is computed here.
//
// Mirrors NguToken exactly: fees per leg, each rounded down on its own (1 bp burn, 1 bp FanoutSink,
// plus 2 bp XGAS.DEV buyback on curves that have BUYBACK_BPS). After the buy, lastPrice = p, so the
// sell basis is min(floorAfter, p).
const BPS = 10000n;

const feesOn = (x, buybackBps) => (x * 1n) / BPS + (x * 1n) / BPS + (x * BigInt(buybackBps)) / BPS;

export function trueMaxLoss({ nextPrice, reserve, supply, buybackBps = 0 }) {
  const p = BigInt(nextPrice);
  if (p <= 0n) return null;
  const floorAfter = (BigInt(reserve) + p - feesOn(p, buybackBps)) / (BigInt(supply) + 1n);
  const basis = floorAfter < p ? floorAfter : p;
  const proceeds = basis - feesOn(basis, buybackBps);
  // proceeds rounds down, so the loss rounds up: never flatter than the contract would pay.
  const lossBps = Number(BPS - (proceeds * BPS) / p);
  return { lossBps, proceeds, floorAfter };
}

export const pct = (bps) => `${(bps / 100).toFixed(2)}%`;

// The contract's own figure is shown only when it disagrees with the live one by more than 1 bp,
// labelled by direction: 'understated' when the live loss is larger, 'overstated' when it is smaller.
export const contractSkew = (trueBps, contractBps) => {
  const c = Number(contractBps);
  if (trueBps > c + 1) return 'understated';
  if (trueBps < c - 1) return 'overstated';
  return null;
};
