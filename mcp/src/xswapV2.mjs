// Reviewed XSwap V2 identity and tax-aware base-unit arithmetic. This module never signs or sends.
import { encodeAbiParameters, keccak256, parseAbi } from 'viem';
import { L3, PARENT_CHAIN_ID, XSWAP_V2, parent, validXswapOwner } from './config.mjs';
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
  // The escrow owner is not pinned here: it is the arbiter, and it is meant to move off the exposed deploy key.
  // Both escrows must name the same usable owner; whether that owner may arbitrate new swaps is acceptNewSwaps()'s call.
  if (!same(collectorOwner, '0x3CacEA9579D61e6BE8C4c75C0537564761A6f8ea')
    || !same(collectorExecutor, '0x93CD9A6535326935798da987cdCc6cFf4CA4FB54')
    || !same(linkedIntents, XSWAP_V2.intents) || !same(linkedAsks, XSWAP_V2.asks)
    || !same(collectorXm, L3.xMoney) || !same(sink, XSWAP_V2_SINK) || configured !== true
    || BigInt(burnBps) !== XSWAP_V2_BURN_BPS || !same(sinkToken, SITE_TOKEN)
    || !validXswapOwner(outOwner) || !same(outOwner, inOwner)
    || !same(outXm, L3.xMoney) || !same(inXm, L3.xMoney)
    || !same(outCollector, XSWAP_V2.collector) || !same(inCollector, XSWAP_V2.collector)
    || !same(outTreasury, XSWAP_V2.treasury) || !same(inTreasury, XSWAP_V2.treasury)
    || Number(outFee) !== Number(XSWAP_V2_PROTOCOL_BPS) || Number(inFee) !== Number(XSWAP_V2_PROTOCOL_BPS)
    || !same(outHash, xswapV2TermsHash(outFee, outBond, outWindow, outBidding, outTreasury))
    || !same(inHash, xswapV2TermsHash(inFee, inBond, inWindow, inBidding, inTreasury))) {
    throw new Error('XSwap V2 owner, fee, collector or terms no longer match the reviewed deployment.');
  }
  return { owner: outOwner,
    out: { window: Number(outWindow), bidding: Number(outBidding), bondBps: Number(outBond), feeBps: Number(outFee), termsHash: outHash },
    in: { window: Number(inWindow), bidding: Number(inBidding), bondBps: Number(inBond), feeBps: Number(inFee), termsHash: inHash } };
}

export function assertXSwapV2NewOrdersEnabled() {
  if (!XSWAP_V2.enabled) throw new Error('XSwap V2 new funding and claims are paused on this build (XSWAP_V2.enabled is false in mcp/src/config.mjs). No transaction was prepared.');
}

// ───────────────────────────── the new-swap gate (one source of truth) ─────────────────────────────
//
// owner() of the V2 escrows alone runs resolve(): it decides every dispute, and a ruling for the solver releases the
// payer's escrow. While that owner is a key treated as exposed, new swaps stay closed on this connector: no open,
// ask, bid, claim, accept or delivered is prepared or relayed. Refund, cancel, settle, confirm, dispute and withdraw
// of swaps that already exist keep working. INSTRUCTIONS, xswap_terms, quote_xswap, every prepare path and
// submit_xswap all read this gate.

const OWNER_ONLY_ABI = parseAbi(['function owner() view returns (address)']);
const GATE_TTL_MS = 30_000; // a successful read; owner() moves rarely, and the gate fails closed in between
const GATE_RETRY_MS = 5_000; // a failed read is retried soon, and the gate stays closed until then
// Opt-in pause list: XSWAP_V2.exposedOwners in source (empty) plus XSWAP_V2_EXPOSED on the host, a comma list of
// "0xaddr" or "0xaddr:YYYY-MM-DD". Read on every decision so an operator can pause or unpause with a secret change.
const exposedList = () => [
  ...XSWAP_V2.exposedOwners,
  ...String(process.env.XSWAP_V2_EXPOSED ?? '').split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [address, since = 'host setting'] = x.split(':'); return { address, since }; }),
];

/** XSWAP_V2_OWNER on the host: when set, new swaps only reopen once owner() is exactly this address. */
export function xswapV2PinnedOwner() {
  // Unset on the host: the escrows' deployed owner is the expected one (same as before the gate existed).
  const v = String(process.env.XSWAP_V2_OWNER ?? '').trim() || XSWAP_V2.deployedOwner;
  return v && validXswapOwner(v) ? v : null;
}

/** Is this owner on the exposed list? Returns its entry ({ address, since }) or null. */
export const exposedOwner = (a) => (a ? exposedList().find((e) => e.address.toLowerCase() === String(a).toLowerCase()) || null : null);

/**
 * Pure decision from the two live owner() reads. Open only when the source switch is on, both escrows answered,
 * they name the same owner, that owner can sign (not zero, not forge's keyless default sender), it is not an
 * exposed key, and, if the host pins one with XSWAP_V2_OWNER, it is that address.
 */
export function evaluateXSwapV2Gate({ intentsOwner, asksOwner, enabled = XSWAP_V2.enabled, pinned = xswapV2PinnedOwner(), readError = null }) {
  const base = { intents_owner: intentsOwner ?? null, asks_owner: asksOwner ?? null, pinned_owner: pinned, exposed: null };
  const closed = (code, reason, extra = {}) => ({ open: false, code, reason, ...base, ...extra });
  if (!enabled) {
    return closed('switched_off', 'XSwap V2 new swaps are switched off on this build (XSWAP_V2.enabled is false in mcp/src/config.mjs).');
  }
  if (readError || !intentsOwner || !asksOwner) {
    return closed('owner_unreadable', `owner() of the V2 escrows could not be read just now${readError ? ` (${readError})` : ''}, so this connector cannot say who would rule on a dispute. New swaps stay closed until it can.`);
  }
  if (!same(intentsOwner, asksOwner)) {
    return closed('owners_differ', `The V2 escrows name different owners (intents ${intentsOwner}, asks ${asksOwner}). This connector only opens new swaps when one owner arbitrates both directions.`);
  }
  const owner = intentsOwner;
  if (!validXswapOwner(owner)) {
    return closed('owner_unusable', `owner() of the V2 escrows is ${owner}, which nobody can sign for (zero, or forge's keyless default sender), so a dispute could never be resolved.`, { owner });
  }
  const hit = exposedOwner(owner);
  if (hit) {
    return closed('owner_exposed',
      `owner() of the V2 escrows (intents ${XSWAP_V2.intents}, asks ${XSWAP_V2.asks}) is ${owner}, a key treated as exposed since ${hit.since}. `
      + 'The owner alone resolves disputes: whoever holds that key could rule for a solver that never delivered, which pays that solver out of the payer\'s escrow, '
      + 'or for a seller that never sent the asset, which pays that seller the buyer\'s payment and bond. New swaps reopen on this connector once ownership moves to the key this host pins in XSWAP_V2_OWNER.',
      { owner, exposed: { address: hit.address, since: hit.since } });
  }
  // Fail closed: the exposed key can move ownership anywhere in one call, so a
  // changed owner proves nothing until the operator pins the new one.
  if (!pinned) {
    return closed('owner_unpinned', `owner() of the V2 escrows is ${owner}, but this host has not pinned XSWAP_V2_OWNER, so it cannot tell a rotation from a takeover. New swaps stay closed until the operator pins the expected owner.`, { owner });
  }
  if (!same(owner, pinned)) {
    return closed('owner_not_pinned', `owner() of the V2 escrows is ${owner}, but this host pins XSWAP_V2_OWNER=${pinned}. New swaps stay closed until they match.`, { owner });
  }
  return { open: true, code: 'open', reason: null, ...base, owner };
}

let gateCache = { at: 0, ok: false, value: null, promise: null };

/** Read owner() on both V2 escrows and decide. Cached briefly; `fresh` skips the cache (write paths use it). */
export async function xswapV2Gate({ fresh = false } = {}) {
  const age = Date.now() - gateCache.at;
  if (!fresh && gateCache.value && age < (gateCache.ok ? GATE_TTL_MS : GATE_RETRY_MS)) return gateCache.value;
  if (!fresh && gateCache.promise) return gateCache.promise;
  const run = (async () => {
    let intentsOwner = null, asksOwner = null, readError = null;
    try {
      [intentsOwner, asksOwner] = await Promise.all([XSWAP_V2.intents, XSWAP_V2.asks]
        .map((address) => parent.readContract({ address, abi: OWNER_ONLY_ABI, functionName: 'owner' })));
    } catch (e) {
      readError = e.shortMessage || e.message || String(e);
    }
    const value = { ...evaluateXSwapV2Gate({ intentsOwner, asksOwner, readError }), checked_at: new Date().toISOString() };
    gateCache = { at: Date.now(), ok: !readError, value, promise: null };
    return value;
  })();
  if (!fresh) gateCache.promise = run;
  return run;
}

/** The last decision, without a network call. Before the first read it is closed: nothing has been checked yet. */
export function xswapV2GateSnapshot() {
  return gateCache.value || { open: false, code: 'not_checked', reason: 'This connector has not read owner() of the V2 escrows yet; xswap_terms reads it live.' };
}

/** Test hook: forget the cached decision. */
export function resetXSwapV2Gate() { gateCache = { at: 0, ok: false, value: null, promise: null }; }

/** May a new swap (open, ask, bid, claim, accept, delivered) be prepared or relayed right now? */
export async function acceptNewSwaps({ fresh = false } = {}) {
  return xswapV2Gate({ fresh });
}

/** Throws a refusal with the reason unless acceptNewSwaps() is open. Reads owner() fresh. */
export async function assertAcceptNewSwaps(what, { nothing = 'Nothing was prepared.' } = {}) {
  const g = await acceptNewSwaps({ fresh: true });
  if (!g.open) {
    throw new Error(`${what} refused: XSwap is paused for new swaps on this connector. ${g.reason} `
      + `Refund, cancel, settle and withdraw of swaps that already exist still work (prepare_xswap_action). ${nothing}`);
  }
  return g;
}
