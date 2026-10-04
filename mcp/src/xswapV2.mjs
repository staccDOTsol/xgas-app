// Reviewed XSwap V2 identity and tax-aware base-unit arithmetic. This module never signs or sends.
import { encodeAbiParameters, keccak256, parseAbi } from 'viem';
import { L3, PARENT_CHAIN_ID, XSWAP_V2, parent } from './config.mjs';
import { XSWAP_V2_INTENTS_ABI, XSWAP_V2_ASKS_ABI } from './abis.mjs';

export const XSWAP_V2_SITE_BPS = 10n;
export const XSWAP_V2_PROTOCOL_BPS = 50n;
export const XSWAP_V2_BURN_BPS = 1n;
export const XSWAP_V2_SINK = '0x5DD9B79f14930A292B1Cb410BA5539126a771910';
const BPS = 10_000n;
const MAX_UINT256 = (1n << 256n) - 1n;
const COLLECTOR_ABI = parseAbi([
  'function owner() view returns (address)', 'function executor() view returns (address)',
  'function intents() view returns (address)', 'function asks() view returns (address)',
  'function XMONEY() view returns (address)', 'function SINK() view returns (address)',
  'function configured() view returns (bool)',
]);
const XMONEY_ABI = parseAbi(['function BURN_BPS() view returns (uint256)']);
const SINK_ABI = parseAbi(['function token() view returns (address)']);
const SITE_TOKEN = '0x891a8b57B6d8BE6F2258A8dA4a0Fb0cf820cD87C';
const same = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const fee = (amount, bps) => amount * bps / BPS;
const read = (address, abi, functionName) => parent.readContract({ address, abi, functionName });
const codeHash = async (address) => {
  const code = await parent.getCode({ address });
  if (!code || code === '0x') throw new Error(`XSwap V2 code is missing at ${address}.`);
  return keccak256(code);
};

export function xswapV2TermsHash(feeBps, bondBps, window, bidding, treasury) {
  return keccak256(encodeAbiParameters(
    [{ type: 'uint16' }, { type: 'uint16' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'address' }],
    [Number(feeBps), Number(bondBps), BigInt(window), BigInt(bidding), treasury],
  ));
}

/** Gross wallet XMoney that funds a target net escrow/bond after XMoney's 1 bp transfer burn. */
export function xswapV2GrossFor(target) {
  const wanted = BigInt(target);
  if (wanted <= 0n || wanted > MAX_UINT256 / BPS) throw new Error('X Money target is outside the safe range.');
  let lo = wanted, hi = wanted + wanted / 5_000n + 2n;
  if (hi - fee(hi, XSWAP_V2_BURN_BPS) < wanted) throw new Error('X Money transfer cannot fund that target.');
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (mid - fee(mid, XSWAP_V2_BURN_BPS) >= wanted) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

/** OUT input is gross wallet debit, not solver ceiling. */
export function xswapV2OutFunding(grossWalletDebit) {
  const gross = BigInt(grossWalletDebit);
  if (gross <= 0n || gross > MAX_UINT256 / BPS) throw new Error('X Money wallet debit is outside the safe range.');
  const received = gross - fee(gross, XSWAP_V2_BURN_BPS);
  let lo = 0n, hi = received;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (mid + fee(mid, XSWAP_V2_SITE_BPS) <= received) lo = mid;
    else hi = mid - 1n;
  }
  if (fee(lo, XSWAP_V2_SITE_BPS) === 0n) throw new Error('X Money debit is too small to fund a 10 bp site fee.');
  const reserve = lo + fee(lo, XSWAP_V2_SITE_BPS);
  if (gross > reserve + reserve / 5_000n + 2n) throw new Error('X Money debit exceeds the reviewed escrow funding bound.');
  return { grossWalletDebit: gross, expectedEscrowReceived: received, escrowCeiling: lo,
    siteFeeMax: fee(lo, XSWAP_V2_SITE_BPS), protocolFeeMax: fee(lo, XSWAP_V2_PROTOCOL_BPS) };
}

/** IN input is the wallet's minimum net XMoney receipt, after fees and outbound transfer burn. */
export function xswapV2InFloor(minSellerNet) {
  const net = BigInt(minSellerNet);
  if (net <= 0n || net > MAX_UINT256 / BPS) throw new Error('X Money minimum is outside the safe range.');
  const left = BPS - XSWAP_V2_PROTOCOL_BPS - XSWAP_V2_SITE_BPS - XSWAP_V2_BURN_BPS;
  const grossBidFloor = (net * BPS + left - 1n) / left;
  if (fee(grossBidFloor, XSWAP_V2_SITE_BPS) === 0n) throw new Error('X Money minimum is too small to fund a 10 bp site fee.');
  const credit = grossBidFloor - fee(grossBidFloor, XSWAP_V2_PROTOCOL_BPS) - fee(grossBidFloor, XSWAP_V2_SITE_BPS);
  const conservativeBurn = (credit + BPS - 1n) / BPS;
  if (credit - conservativeBurn < net) throw new Error('X Money net floor cannot be met.');
  return { minSellerNet: net, grossBidFloor, protocolFeeAtFloor: fee(grossBidFloor, XSWAP_V2_PROTOCOL_BPS),
    siteFeeAtFloor: fee(grossBidFloor, XSWAP_V2_SITE_BPS) };
}

/** Read every immutable/current identity before presenting a V2 preparation. Independent of the send gate. */
export async function verifyXSwapV2() {
  if (PARENT_CHAIN_ID !== 4663) throw new Error('XSwap V2 is pinned to Robinhood 4663.');
  const [collectorCode, intentsCode, asksCode] = await Promise.all([
    codeHash(XSWAP_V2.collector), codeHash(XSWAP_V2.intents), codeHash(XSWAP_V2.asks),
  ]);
  if (!same(collectorCode, XSWAP_V2.collectorRuntimeHash)
    || !same(intentsCode, XSWAP_V2.intentsRuntimeHash) || !same(asksCode, XSWAP_V2.asksRuntimeHash)) {
    throw new Error('XSwap V2 deployed bytecode does not match the reviewed runtime pins.');
  }
  const [collectorOwner, collectorExecutor, linkedIntents, linkedAsks, collectorXm, sink, configured, burnBps, sinkToken,
    outOwner, outXm, outCollector, outTreasury, outFee, outBond, outWindow, outBidding, outHash,
    inOwner, inXm, inCollector, inTreasury, inFee, inBond, inWindow, inBidding, inHash] = await Promise.all([
    ...[['owner', COLLECTOR_ABI], ['executor', COLLECTOR_ABI], ['intents', COLLECTOR_ABI], ['asks', COLLECTOR_ABI],
      ['XMONEY', COLLECTOR_ABI], ['SINK', COLLECTOR_ABI], ['configured', COLLECTOR_ABI]]
      .map(([fn, abi]) => read(XSWAP_V2.collector, abi, fn)),
    read(L3.xMoney, XMONEY_ABI, 'BURN_BPS'), read(XSWAP_V2_SINK, SINK_ABI, 'token'),
    ...[XSWAP_V2.intents, XSWAP_V2.asks].flatMap((address, i) => {
      const abi = i === 0 ? XSWAP_V2_INTENTS_ABI : XSWAP_V2_ASKS_ABI;
      return ['owner', 'xmoney', 'siteCollector', 'treasury', 'feeBps', 'bondBps', 'window', 'bidding', 'termsHash']
        .map((fn) => read(address, abi, fn));
    }),
  ]);
  // The Promise order above is collector, XMoney/sink, then nine OUT getters and nine IN getters.
  if (!same(collectorOwner, '0x3CacEA9579D61e6BE8C4c75C0537564761A6f8ea')
    || !same(collectorExecutor, '0x93CD9A6535326935798da987cdCc6cFf4CA4FB54')
    || !same(linkedIntents, XSWAP_V2.intents) || !same(linkedAsks, XSWAP_V2.asks)
    || !same(collectorXm, L3.xMoney) || !same(sink, XSWAP_V2_SINK) || configured !== true
    || BigInt(burnBps) !== XSWAP_V2_BURN_BPS || !same(sinkToken, SITE_TOKEN)
    || !same(outOwner, XSWAP_V2.expectedOwner) || !same(inOwner, XSWAP_V2.expectedOwner)
    || !same(outXm, L3.xMoney) || !same(inXm, L3.xMoney)
    || !same(outCollector, XSWAP_V2.collector) || !same(inCollector, XSWAP_V2.collector)
    || !same(outTreasury, XSWAP_V2.treasury) || !same(inTreasury, XSWAP_V2.treasury)
    || Number(outFee) !== Number(XSWAP_V2_PROTOCOL_BPS) || Number(inFee) !== Number(XSWAP_V2_PROTOCOL_BPS)
    || !same(outHash, xswapV2TermsHash(outFee, outBond, outWindow, outBidding, outTreasury))
    || !same(inHash, xswapV2TermsHash(inFee, inBond, inWindow, inBidding, inTreasury))) {
    throw new Error('XSwap V2 owner, fee, collector or terms no longer match the reviewed deployment.');
  }
  return { out: { window: Number(outWindow), bidding: Number(outBidding), bondBps: Number(outBond), feeBps: Number(outFee), termsHash: outHash },
    in: { window: Number(inWindow), bidding: Number(inBidding), bondBps: Number(inBond), feeBps: Number(inFee), termsHash: inHash } };
}

export function assertXSwapV2NewOrdersEnabled() {
  if (!XSWAP_V2.enabled) throw new Error('XSwap V2 new funding and claims are paused until the V2 solver and far delivery are reviewed. No transaction was prepared.');
}
