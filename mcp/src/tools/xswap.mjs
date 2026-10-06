import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, isAddress, keccak256, parseUnits, formatUnits, parseAbi, parseTransaction, toFunctionSelector } from 'viem';
import { L3, XSWAP, XSWAP_LEGACY, XSWAP_V2, PARENT_CHAIN_ID, parent, ZERO, FORGE_DEFAULT_SENDER, isXswapV1, isXswapLegacy, validXswapOwner } from '../config.mjs';
import { ERC20_ABI, XSWAP_INTENTS_ABI, XSWAP_ASKS_ABI, XSWAP_V2_INTENTS_ABI, XSWAP_V2_ASKS_ABI } from '../abis.mjs';
import { assertXSwapV2NewOrdersEnabled, verifyXSwapV2, xswapV2GrossFor, xswapV2OutFunding, xswapV2InFloor } from '../xswapV2.mjs';
import { fmtXMoney, parseXMoney } from '../money.mjs';
import { prepared, renderApproval, reply } from '../approval.mjs';
import { submitBatch, submitRaw } from '../idempotency.mjs';

/**
 * X Money in, anything on any EVM chain out — and the other direction. The connector holds no keys and cannot see the far
 * chain, so this module only ever does three honest things: read the escrow, hash the order the way every solver
 * hashes it, and hand back unsigned transactions. The bond is the permission; the challenge window is the recourse.
 */
const addr = { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' };
const b32 = { type: 'string', pattern: '^0x[a-fA-F0-9]{64}$' };

/**
 * How-much-of-what, shared by every xswap tool. One copy, because these four fields
 * drifted apart once already: quote_xswap described them and the two prepare_* tools,
 * the ones that actually build the transaction, shipped them bare.
 */
const assetFields = {
  amount: { type: 'string', description: 'How much to deliver, in whole units (e.g. "1.5"). For an ERC-20 this needs decimals alongside it; for an NFT use token_id instead.' },
  decimals: { type: 'number', description: "Decimals of that ERC-20, required alongside amount. The connector never guesses a far chain's decimals." },
  amount_base_units: { type: 'string', description: 'The amount as a base-units integer, instead of amount + decimals. Use this when you already know the exact integer.' },
  token_id: { type: 'string', description: 'For an NFT: the token id to deliver. Use instead of amount.' },
};
const BPS = 10_000n;

// The destinations the solver network already reaches, one dRPC key wide. Kept in lockstep with
// staccpad's xswap-solver.mjs DRPC_CHAINS — a chain missing here is a chain no solver can quote.
export const XSWAP_CHAINS = [
  { id: 1, slug: 'ethereum', symbol: 'ETH' }, { id: 8453, slug: 'base', symbol: 'ETH' }, { id: 42161, slug: 'arbitrum', symbol: 'ETH' },
  { id: 10, slug: 'optimism', symbol: 'ETH' }, { id: 137, slug: 'polygon', symbol: 'POL' }, { id: 56, slug: 'bsc', symbol: 'BNB' },
  { id: 43114, slug: 'avalanche', symbol: 'AVAX' }, { id: 324, slug: 'zksync', symbol: 'ETH' }, { id: 59144, slug: 'linea', symbol: 'ETH' },
  { id: 534352, slug: 'scroll', symbol: 'ETH' }, { id: 5000, slug: 'mantle', symbol: 'MNT' }, { id: 81457, slug: 'blast', symbol: 'ETH' },
  { id: 100, slug: 'gnosis', symbol: 'XDAI' }, { id: 42170, slug: 'arbitrum-nova', symbol: 'ETH' }, { id: 1101, slug: 'polygon-zkevm', symbol: 'ETH' },
  { id: 250, slug: 'fantom', symbol: 'FTM' }, { id: 130, slug: 'unichain', symbol: 'ETH' }, { id: 7777777, slug: 'zora', symbol: 'ETH' },
  { id: 34443, slug: 'mode', symbol: 'ETH' }, { id: 1135, slug: 'lisk', symbol: 'ETH' }, { id: 57073, slug: 'ink', symbol: 'ETH' },
  { id: 1868, slug: 'soneium', symbol: 'ETH' }, { id: 146, slug: 'sonic', symbol: 'S' }, { id: 80094, slug: 'berachain', symbol: 'BERA' },
  { id: 2741, slug: 'abstract', symbol: 'ETH' }, { id: 33139, slug: 'apechain', symbol: 'APE' }, { id: 480, slug: 'worldchain', symbol: 'ETH' },
  { id: 167000, slug: 'taiko', symbol: 'ETH' }, { id: 1284, slug: 'moonbeam', symbol: 'GLMR' }, { id: 42220, slug: 'celo', symbol: 'CELO' },
  { id: 252, slug: 'fraxtal', symbol: 'frxETH' }, { id: 1750, slug: 'metall2', symbol: 'ETH' }, { id: 1088, slug: 'metis', symbol: 'METIS' },
  { id: 13371, slug: 'immutable-zkevm', symbol: 'IMX' }, { id: 2020, slug: 'ronin', symbol: 'RON' }, { id: 999, slug: 'hyperliquid', symbol: 'HYPE' },
  { id: 747474, slug: 'katana', symbol: 'ETH' }, { id: 1923, slug: 'swell', symbol: 'ETH' }, { id: 4663, slug: 'robinhood', symbol: 'ETH' },
];
const chainByKey = (v) => {
  const s = String(v ?? '').trim().toLowerCase();
  return XSWAP_CHAINS.find((c) => String(c.id) === s || c.slug === s) || null;
};

const KIND = { native: 0, erc20: 1, nft: 2, nftAny: 3 };
const INTENT_STATE = ['taking bids', 'bid in, delivering', 'delivered, checking', 'settled', 'disputed', 'refunded'];
const ASK_STATE = ['taking bids', 'sold, send it', 'sent, buyer checking', 'settled', 'disputed', 'cancelled'];
const VENUES = [
  { side: 'out', contract: XSWAP_V2.intents, version: 2, abi: XSWAP_V2_INTENTS_ABI },
  { side: 'in', contract: XSWAP_V2.asks, version: 2, abi: XSWAP_V2_ASKS_ABI },
  ...XSWAP_LEGACY.intents.map((contract) => ({ side: 'out', contract, version: 1, abi: XSWAP_INTENTS_ABI })),
  ...XSWAP_LEGACY.asks.map((contract) => ({ side: 'in', contract, version: 1, abi: XSWAP_ASKS_ABI })),
];
const venueOf = (contract) => VENUES.find((v) => v.contract.toLowerCase() === String(contract).toLowerCase()) || null;

const readI = (fn, args = []) => parent.readContract({ address: XSWAP.intents, abi: XSWAP_INTENTS_ABI, functionName: fn, args });
const readA = (fn, args = []) => parent.readContract({ address: XSWAP.asks, abi: XSWAP_ASKS_ABI, functionName: fn, args });

/** The hash every solver recomputes: chain, kind, token, amount, recipient. Lockstep with the site and the solver. */
function wantHash(o) {
  return keccak256(encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint8' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }],
    [BigInt(o.dstChainId), KIND[o.kind], o.token || ZERO, BigInt(o.amount), o.to],
  ));
}

/**
 * Turn friendly arguments into the exact order both sides hash. The connector cannot reach the far chain, so it
 * never guesses an ERC-20's decimals: say them, or give the amount in base units.
 */
function orderFrom({ chain, asset = 'native', amount, amount_base_units, decimals, token_id, to }, { recipientOptional = false } = {}) {
  const c = chainByKey(chain);
  if (!c) throw new Error(`Unknown destination chain: ${chain}. Call xswap_chains for the list solvers can reach.`);
  const recipient = to ? String(to) : recipientOptional ? ZERO : null;
  if (!recipient || (recipient !== ZERO && !isAddress(recipient))) throw new Error('`to` must be the address that receives it on the destination chain.');

  const a = String(asset).trim();
  if (a.toLowerCase() === 'native') {
    if (amount_base_units === undefined && amount === undefined) throw new Error(`Say how much ${c.symbol} to deliver on ${c.slug}.`);
    const wei = amount_base_units !== undefined ? BigInt(amount_base_units) : parseUnits(String(amount), 18);
    if (wei <= 0n) throw new Error('Amount must be more than zero.');
    return { dstChainId: c.id, kind: 'native', amount: wei.toString(), to: recipient, _chain: c, _label: `${formatUnits(wei, 18)} ${c.symbol}` };
  }
  if (!isAddress(a)) throw new Error(`asset must be "native" or a contract address on ${c.slug}.`);
  if (token_id !== undefined && token_id !== null) {
    return { dstChainId: c.id, kind: 'nft', token: a, amount: BigInt(token_id).toString(), to: recipient, _chain: c, _label: `NFT #${token_id} of ${a}` };
  }
  if (amount_base_units === undefined && (amount === undefined || decimals === undefined)) {
    throw new Error('For an ERC-20 give amount_base_units, or give amount together with decimals. The connector will not guess a far chain\'s decimals.');
  }
  const units = amount_base_units !== undefined ? BigInt(amount_base_units) : parseUnits(String(amount), Number(decimals));
  if (units <= 0n) throw new Error('Amount must be more than zero.');
  const shown = decimals !== undefined ? `${formatUnits(units, Number(decimals))} of ${a}` : `${units} base units of ${a}`;
  return { dstChainId: c.id, kind: 'erc20', token: a, amount: units.toString(), to: recipient, _chain: c, _label: shown };
}
/** The memo is the order in the clear, so the solver, the payer and an arbiter all read the same thing. */
const memoOf = (o) => JSON.stringify({ dstChainId: o.dstChainId, kind: o.kind, token: o.token, amount: o.amount, to: o.to });
const freshId = (seed) => keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'uint256' }, { type: 'uint256' }],
  [String(seed || ''), BigInt(Date.now()), BigInt(Math.floor(Math.random() * 2 ** 48))]));

const secs = (n) => (n < 120 ? `${n}s` : n < 7200 ? `${Math.round(n / 60)} min` : `${(n / 3600).toFixed(1)} h`);

async function intentOf(id, venue) {
  const i = await parent.readContract({ address: venue.contract, abi: venue.abi, functionName: 'get', args: [id] }).catch(() => null);
  if (!i || i.user === ZERO) return null;
  const now = Math.floor(Date.now() / 1000);
  return {
    side: 'out', id, contract: venue.contract, version: venue.version, user: i.user,
    escrowed: fmtXMoney(i.amount), escrowed_wei: i.amount,
    ...(venue.version === 2 ? { actual_escrowed: fmtXMoney(i.escrowed), actual_escrowed_wei: i.escrowed,
      protocol_bps: Number(i.protocolBps), opened_bond_bps: Number(i.openedBondBps),
      site_fee_bps: Number(i.siteFeeBps), site_fee_recipient: i.siteFeeRecipient,
      challenge_window_s: Number(i.challengeWindow), protocol_treasury: i.protocolTreasury } : {}),
    state: INTENT_STATE[Number(i.state)] || `state ${i.state}`, state_code: Number(i.state),
    solver: i.solver === ZERO ? null : i.solver,
    solver_ask: i.solver === ZERO ? null : fmtXMoney(i.ask), bond: fmtXMoney(i.bond),
    back_to_you: i.solver === ZERO ? null : fmtXMoney(i.amount - i.ask),
    bidding_ends_in: Number(i.bidEnds) - now, deadline_in: Number(i.deadline) - now,
    claimed_at: Number(i.claimedAt) || null, want: i.want,
  };
}
async function askOf(id, venue) {
  const a = await parent.readContract({ address: venue.contract, abi: venue.abi, functionName: 'get', args: [id] }).catch(() => null);
  if (!a || a.seller === ZERO) return null;
  const now = Math.floor(Date.now() / 1000);
  return {
    side: 'in', id, contract: venue.contract, version: venue.version, seller: a.seller,
    floor: fmtXMoney(a.floorPay), state: ASK_STATE[Number(a.state)] || `state ${a.state}`, state_code: Number(a.state),
    ...(venue.version === 2 ? { min_seller_net: fmtXMoney(a.minSellerNet), min_seller_net_wei: a.minSellerNet,
      protocol_bps: Number(a.protocolBps), opened_bond_bps: Number(a.openedBondBps),
      site_fee_bps: Number(a.siteFeeBps), site_fee_recipient: a.siteFeeRecipient,
      challenge_window_s: Number(a.challengeWindow), protocol_treasury: a.protocolTreasury } : {}),
    buyer: a.buyer === ZERO ? null : a.buyer,
    best_bid: a.buyer === ZERO ? null : fmtXMoney(a.pay), buyer_bond: fmtXMoney(a.bond),
    bidding_ends_in: Number(a.bidEnds) - now, deadline_in: Number(a.deadline) - now,
    delivered_at: Number(a.deliveredAt) || null, give: a.give,
  };
}
async function either(id, contract = null) {
  const venues = contract ? [venueOf(contract)].filter(Boolean) : VENUES;
  if (contract && !venues.length) throw new Error('That XSwap contract is not a reviewed V2 or known legacy escrow.');
  const found = (await Promise.all(venues.map((v) => v.side === 'out' ? intentOf(id, v) : askOf(id, v)))).filter(Boolean);
  if (found.length > 1) throw new Error(`Swap id ${id} exists on multiple escrows. Give its exact contract address.`);
  return found[0] || null;
}

/**
 * A memo is whatever the person who opened the swap wrote on chain. Only the five order fields survive, each checked
 * for type (chain id, kind, token address, integer amount, recipient address), and the result is re-hashed against
 * the on-chain want/give hash. Free text in a memo never reaches the reply.
 */
function orderFromMemo(memo, hash) {
  let o;
  try { o = JSON.parse(String(memo)); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const dst = Number(o.dstChainId);
  const kind = Object.prototype.hasOwnProperty.call(KIND, o.kind) ? o.kind : null;
  const token = o.token === undefined || o.token === null ? undefined : isAddress(String(o.token)) ? String(o.token) : null;
  const amount = /^\d{1,78}$/.test(String(o.amount)) ? String(o.amount) : null;
  const to = isAddress(String(o.to)) ? String(o.to) : null;
  if (!Number.isSafeInteger(dst) || dst <= 0 || !kind || token === null || !amount || !to) return null;
  const clean = { dstChainId: dst, kind, token, amount, to };
  let matches = false;
  try { matches = wantHash(clean) === hash; } catch { /* malformed: stays false */ }
  return { ...clean, matches_hash: matches };
}

// ───────────────────────────── who can rule on a dispute ─────────────────────────────

const OWNER_ABI = parseAbi([
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[])',
]);

/** owner() of one escrow, and what kind of thing it is: nobody, a Safe, one key, or some other contract. */
async function ownerOf(contract) {
  const [owner, pending] = await Promise.all([
    parent.readContract({ address: contract, abi: OWNER_ABI, functionName: 'owner' }).catch(() => null),
    // Ownable2Step (the redeploy) answers pendingOwner(); v1's single-step Ownable does not.
    parent.readContract({ address: contract, abi: OWNER_ABI, functionName: 'pendingOwner' }).catch(() => undefined),
  ]);
  if (!owner) return { contract, owner: null, kind: 'unknown' };
  const two = pending === undefined ? { two_step: false } : { two_step: true, pending_owner: pending === ZERO ? null : pending };
  if (owner.toLowerCase() === FORGE_DEFAULT_SENDER.toLowerCase()) return { contract, owner, kind: 'nobody', why: 'forge_default_sender', ...two };
  if (owner === ZERO) return { contract, owner, kind: 'nobody', why: 'renounced', ...two };
  return { ...(await ownerKind(contract, owner)), ...two };
}

/** What kind of thing an owner address is: a Safe, one key (EIP-7702 delegated or not), or some other contract. */
async function ownerKind(contract, owner) {
  const code = await parent.getCode({ address: owner }).catch(() => null);
  // EIP-7702: a delegated EOA carries 0xef0100 ++ delegate as code, and its key still signs. That is one key, not a Safe.
  if (code && /^0xef0100[0-9a-f]{40}$/i.test(code)) return { contract, owner, kind: 'eoa', delegated: true };
  if (code && code !== '0x') {
    const [threshold, signers] = await Promise.all([
      parent.readContract({ address: owner, abi: OWNER_ABI, functionName: 'getThreshold' }).catch(() => null),
      parent.readContract({ address: owner, abi: OWNER_ABI, functionName: 'getOwners' }).catch(() => null),
    ]);
    // A working Safe, as the deploy script requires: at least one signer, and no more required than it has.
    if (threshold !== null && Array.isArray(signers) && threshold > 0n && BigInt(signers.length) >= threshold) {
      return { contract, owner, kind: 'safe', threshold: Number(threshold), signers: [...signers] };
    }
    return { contract, owner, kind: 'contract' };
  }
  return { contract, owner, kind: 'eoa' };
}

let arbiterCache = { at: 0, value: null };
async function arbiter() {
  if (arbiterCache.value && Date.now() - arbiterCache.at < 60_000) return arbiterCache.value;
  const [out, inn] = await Promise.all([ownerOf(XSWAP.intents), ownerOf(XSWAP.asks)]);
  const value = { out, in: inn };
  if (out.kind !== 'unknown' && inn.kind !== 'unknown') arbiterCache = { at: Date.now(), value };
  return value;
}

const pendingNote = (o) => (o.pending_owner ? ` A handover to ${o.pending_owner} is pending; it takes effect only when that address calls acceptOwnership().` : '');
const expected = (o) => (XSWAP.expectedOwner && o.owner
  ? (o.owner.toLowerCase() === XSWAP.expectedOwner.toLowerCase() ? ' It matches the owner this connector is configured to expect.' : ` This connector is configured to expect ${XSWAP.expectedOwner} instead, so treat this as unverified.`)
  : '');

/** Who resolves disputes on one escrow, in words. */
function whoRules(o) {
  switch (o.kind) {
    case 'nobody':
      return o.why === 'forge_default_sender'
        ? `Nobody. owner() is ${o.owner}, forge-std's default sender (derived from the string "foundry default caller", not from a key), so no one can sign as it. That is what a forge script produces when it reads msg.sender before it starts broadcasting, which is what the v1 deploy script did. resolve(), setParams() and transferOwnership() can never be called here: a disputed swap on this contract stays frozen forever, escrow and bond both.`
        : 'Nobody. owner() is the zero address (ownership was renounced), so resolve() can never be called and a disputed swap stays frozen forever.';
    case 'safe':
      return `The Safe ${o.owner}: ${o.threshold} of its ${o.signers.length} signers (${o.signers.join(', ')}) must sign each ruling.${expected(o)}${pendingNote(o)}`;
    case 'eoa':
      return `The single key ${o.owner}. Whoever holds it decides every dispute on this contract alone.${expected(o)}${pendingNote(o)}`;
    case 'contract':
      return `The contract ${o.owner}, which does not answer like a Safe, so nobody can say who, if anyone, can make it rule. The deploy script refuses an owner like this, and so does this connector for new swaps.${expected(o)}${pendingNote(o)}`;
    default:
      return `Unknown: owner() could not be read from ${o.contract} just now.`;
  }
}

const HANDOVER = {
  two: 'transferOwnership, which only names a pending owner: it takes over when it calls acceptOwnership(), so a handover to an address nobody signs for never happens. renounceOwnership() is disabled and always reverts.',
  one: 'transferOwnership, which takes effect at once, and renounceOwnership (renouncing, or handing over to an address nobody signs for, would leave disputes unresolvable for good).',
};
const ownerPowers = (arb) => ({
  out: `On the intents contract (X Money out) the owner can: resolve(id, forUser) on a disputed intent, and only a disputed one (for the user, the escrow and the solver's bond go to the user; for the solver, it settles as if never disputed); setParams: challenge window 10 min to 7 days, solver bond 25% to 200% of the escrow, protocol fee up to 2%, and the treasury the fee goes to; ${HANDOVER[arb.out.two_step ? 'two' : 'one']} It cannot move any other swap's money, withdraw anyone's credit, pause or upgrade the contract.`,
  in: `On the asks contract (X Money in) the owner can: resolve(id, forBuyer) on a disputed ask, and only a disputed one (for the buyer, their payment and bond go back; for the seller, it settles and the buyer's bond goes to the seller); setParams: challenge window 10 min to 7 days, bidding 30 s to 1 day, buyer bond 10% to 200%, protocol fee up to 2%, and the treasury; ${HANDOVER[arb.in.two_step ? 'two' : 'one']} It cannot move any other swap's money, withdraw anyone's credit, pause or upgrade the contract.`,
});
const PARAMS_IN_FLIGHT = 'Parameter changes reach swaps already in flight: the fee is computed at settlement from the rate at that moment, and the challenge window is read whenever a dispute or a settle is checked. A bond is fixed when its bid lands.';
const BURN_NOTE = XSWAP.v1
  ? 'xMoney burns 0.01% of every transfer. These v1 contracts book the amount sent, not the amount that arrives, so they can owe slightly more than they hold and the last withdrawal can come up short.'
  : 'xMoney burns 0.01% of every transfer, on the way into the escrow and again on the way out. The escrow books what actually arrives.';

// ───────────────────────────── the pause ─────────────────────────────

/** Why new swaps are off, or null when the configuration allows them (the live owner check still follows). */
function pausedReason() {
  if (XSWAP_V2.enabled) return null; // new orders go to the reviewed V2 escrows; the legacy pair is exit-only
  if (XSWAP.v1) {
    return `XSwap is paused for new swaps. The escrow contracts this connector points at (intents ${XSWAP.intents}, asks ${XSWAP.asks}, Robinhood Chain 4663) have owner() = ${FORGE_DEFAULT_SENDER}, forge-std's default sender, which no one holds a key for: their deploy script read msg.sender before it started broadcasting. Only the owner can resolve a dispute, so on these contracts a disputed swap would stay frozen forever, escrow and bond both. `;
  }
  if (isXswapLegacy(XSWAP.intents) || isXswapLegacy(XSWAP.asks)) {
    return `New XSwap funding and claims are paused on the fee-free legacy escrows ${XSWAP.intents} and ${XSWAP.asks}. Existing orders remain readable and may be refunded, cancelled, settled or withdrawn through their original contract.`;
  }
  if (!XSWAP.addressesOk) return `XSwap is paused: the configured escrow addresses (intents ${XSWAP.intents}, asks ${XSWAP.asks}) are not both valid addresses.`;
  if (!XSWAP.flag) {
    return `XSwap is switched off on this host: XSWAP_ENABLED is not set, and the deployment file's xswap block does not say "enabled": true. Contracts: intents ${XSWAP.intents}, asks ${XSWAP.asks} (from the ${XSWAP.source}).`;
  }
  if (!validXswapOwner(XSWAP.expectedOwner)) {
    const why = XSWAP.expectedOwner
      ? `the configured expected owner ${XSWAP.expectedOwner} (XSWAP_OWNER or xswap.owner) is not an address anyone can sign for`
      : 'no expected owner is configured (XSWAP_OWNER, or "owner" in the deployment file\'s xswap block)';
    return `XSwap is switched off on this host: ${why}. New swaps only open once owner() on both escrows can be checked against the owner the deployment says it set.`;
  }
  return 'New XSwap orders must use the reviewed V2 site-fee path. This legacy ABI cannot prepare one.';
}
/**
 * What still works while new swaps are off. Dispute is only a way out when someone can rule on it: on a contract whose
 * owner is nobody (v1), it freezes the escrow and the bond forever, so it is not listed as an exit there.
 */
export function stillWorks(arb) {
  const nobody = XSWAP.v1 || arb?.out?.kind === 'nobody' || arb?.in?.kind === 'nobody';
  return nobody
    ? 'Still available: xswap_terms, xswap_status, list_my_xswaps, xswap_reputation, quote_xswap, and the ways out of a swap that already exists (refund after its deadline, cancel, settle, confirm, withdraw). Dispute is NOT a way out on these contracts: nobody can rule on it, so it freezes the escrow and the bond forever, and the disputing side never gets its X Money back. Its only effect is that the other side is never paid either.'
    : 'Still available: xswap_terms, xswap_status, list_my_xswaps, xswap_reputation, quote_xswap, and the ways out of a swap that already exists (refund after its deadline, cancel, settle, confirm, dispute inside the window, withdraw).';
}

/** Steps that start a swap or move one closer to a dispute: they need a switched-on XSwap with a real owner. */
const GATED_ACTIONS = new Set(['bid', 'claim', 'accept', 'delivered']);
const selectorsOf = (abi, names) => abi.filter((x) => x.type === 'function' && names.includes(x.name)).map((f) => toFunctionSelector(f));
const LEGACY_FUNDING_SELECTORS = new Set([
  ...selectorsOf(XSWAP_INTENTS_ABI, ['open', 'openWith', 'bid', 'claim', 'accept']),
  ...selectorsOf(XSWAP_ASKS_ABI, ['ask', 'bid', 'accept', 'delivered']),
]);
const V2_FUNDING_SELECTORS = new Set([
  ...selectorsOf(XSWAP_V2_INTENTS_ABI, ['openWithSiteFee', 'bid', 'claim', 'accept']),
  ...selectorsOf(XSWAP_V2_ASKS_ABI, ['askWithSiteFee', 'bid', 'accept', 'delivered']),
]);
const KEYLESS_DISPUTE_SELECTORS = new Set([
  ...selectorsOf(XSWAP_INTENTS_ABI, ['dispute']), ...selectorsOf(XSWAP_ASKS_ABI, ['dispute']),
]);

/**
 * What is wrong with the live owners, if anything: nobody can sign, unreadable, a contract that is not a Safe, no
 * expected owner configured, or not the owner configured. Only a Safe or a key that matches the configured owner passes.
 */
export function ownerProblems(arb) {
  const problems = [];
  if (!validXswapOwner(XSWAP.expectedOwner)) {
    problems.push('No expected owner is configured (XSWAP_OWNER, or "owner" in the deployment file\'s xswap block), so owner() cannot be verified.');
  }
  for (const [label, o] of [['intents', arb.out], ['asks', arb.in]]) {
    if (o.kind === 'nobody' || o.kind === 'unknown' || o.kind === 'contract') problems.push(`${label}: ${whoRules(o)}`);
    else if (validXswapOwner(XSWAP.expectedOwner) && o.owner.toLowerCase() !== XSWAP.expectedOwner.toLowerCase()) {
      problems.push(`${label}: owner() is ${o.owner}, but this connector is configured to expect ${XSWAP.expectedOwner} (XSWAP_OWNER or xswap.owner in the deployment file).`);
    }
  }
  return problems;
}

/** submit_xswap relays anything signed. It still will not relay a new swap, bid or claim to a contract that is paused. */
export async function assertRelayAllowed(raws) {
  const configured = new Set([XSWAP.intents, XSWAP.asks].map((a) => a.toLowerCase()));
  const legacy = new Set([...XSWAP_LEGACY.intents, ...XSWAP_LEGACY.asks].map((a) => a.toLowerCase()));
  const v2 = new Set([XSWAP_V2.intents, XSWAP_V2.asks].map((a) => a.toLowerCase()));
  for (const raw of raws) {
    let tx;
    try { tx = parseTransaction(raw); } catch { continue; } // not a transaction: the RPC rejects it
    const to = tx.to ? tx.to.toLowerCase() : null;
    const sel = String(tx.data || tx.input || '0x').slice(0, 10).toLowerCase();
    if (!to) continue;
    if ((to === L3.xMoney.toLowerCase() || to === XSWAP.xmoney.toLowerCase())
      && sel === toFunctionSelector(ERC20_ABI.find((f) => f.type === 'function' && f.name === 'approve'))) {
      let spender = null;
      try {
        const decoded = decodeFunctionData({ abi: ERC20_ABI, data: tx.data || tx.input });
        if (decoded.functionName === 'approve') spender = String(decoded.args[0]).toLowerCase();
      } catch { /* malformed calldata is left for RPC to reject */ }
      if (legacy.has(spender)) throw new Error('submit_xswap refused: approval to a legacy XSwap escrow would enable fee-free funding. Nothing was sent.');
      if (v2.has(spender)) {
        assertXSwapV2NewOrdersEnabled();
        await verifyXSwapV2();
      }
    }
    if (legacy.has(to) && LEGACY_FUNDING_SELECTORS.has(sel)) {
      throw new Error(`submit_xswap refused: ${to} is a legacy XSwap escrow. New funding, bids and claims there are disabled. Nothing was sent.`);
    }
    if (isXswapV1(to) && KEYLESS_DISPUTE_SELECTORS.has(sel)) {
      throw new Error(`submit_xswap refused: a dispute on keyless-owner legacy escrow ${to} cannot be resolved. Nothing was sent.`);
    }
    if (v2.has(to) && V2_FUNDING_SELECTORS.has(sel)) {
      assertXSwapV2NewOrdersEnabled();
      await verifyXSwapV2();
    }
    if (configured.has(to) && !legacy.has(to) && !v2.has(to) && LEGACY_FUNDING_SELECTORS.has(sel)) {
      throw new Error('submit_xswap refused: new funding on an unreviewed XSwap escrow is disabled. Nothing was sent.');
    }
  }
}

async function terms() {
  const [iw, ib, ibond, ifee, aw, ab, abond, afee] = await Promise.all([
    readI('window'), readI('bidding'), readI('bondBps'), readI('feeBps'),
    readA('window'), readA('bidding'), readA('bondBps'), readA('feeBps'),
  ]);
  return {
    out: { window_s: Number(iw), bidding_s: Number(ib), bond_bps: Number(ibond), fee_bps: Number(ifee) },
    in: { window_s: Number(aw), bidding_s: Number(ab), bond_bps: Number(abond), fee_bps: Number(afee) },
  };
}

async function prepareV2Out(args) {
  assertXSwapV2NewOrdersEnabled();
  const verified = await verifyXSwapV2();
  if (!isAddress(args.from)) throw new Error('`from` must be an address.');
  const order = orderFrom(args);
  const gross = parseXMoney(args.xmoney_amount);
  const funding = xswapV2OutFunding(gross);
  const minutes = Math.max(5, Number(args.deadline_minutes ?? 60));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + minutes * 60);
  const id = args.id || freshId(args.from);
  const [balance, allowance] = await Promise.all([
    parent.readContract({ address: L3.xMoney, abi: ERC20_ABI, functionName: 'balanceOf', args: [args.from] }),
    parent.readContract({ address: L3.xMoney, abi: ERC20_ABI, functionName: 'allowance', args: [args.from, XSWAP_V2.intents] }),
  ]);
  if (balance < gross) throw new Error(`That wallet holds ${fmtXMoney(balance)} X Money; this order may debit ${fmtXMoney(gross)}.`);
  const steps = [];
  if (allowance < gross) steps.push({ label: `Approve exactly ${fmtXMoney(gross)} X Money for the V2 escrow`,
    chainId: PARENT_CHAIN_ID, to: L3.xMoney, value: 0n,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [XSWAP_V2.intents, gross] }) });
  steps.push({ label: `Open the V2 intent with ${fmtXMoney(gross)} X Money gross wallet cap`,
    chainId: PARENT_CHAIN_ID, to: XSWAP_V2.intents, value: 0n,
    data: encodeFunctionData({ abi: XSWAP_V2_INTENTS_ABI, functionName: 'openWithSiteFee', args: [id, gross,
      funding.escrowCeiling, deadline, wantHash(order), memoOf(order),
      { minFilled: 0, maxFailBps: 0, minBondBps: 0, trustedOnly: false }, XSWAP_V2.collector, 10, verified.out.termsHash] }) });
  const p = prepared({
    action: `Send ${order._label} on ${order._chain.slug} to ${order.to}, paid in X Money`,
    chainId: PARENT_CHAIN_ID, asset: 'X Money (Robinhood 4663)', amount: `${fmtXMoney(gross)} gross wallet debit cap`,
    counterparty: 'a bonded V2 solver',
    fees: [
      { label: 'X Money inbound burn', amount: `${fmtXMoney(gross - funding.expectedEscrowReceived)} X Money` },
      { label: 'site convenience fee', amount: `up to ${fmtXMoney(funding.siteFeeMax)} X Money`, note: '10 bp of the winning solver ask, sent to the site collector at settlement' },
      { label: 'protocol fee', amount: `up to ${fmtXMoney(funding.protocolFeeMax)} X Money`, note: '50 bp of the winning solver ask' },
    ],
    net: `${order._label} on ${order._chain.slug}; unused escrow becomes withdrawal credit`,
    timeline: [`bidding ${secs(verified.out.bidding)}`, `challenge window ${secs(verified.out.window)}`, `deadline ${new Date(Number(deadline) * 1000).toISOString()}`],
    irreversible: 'Only confirm delivery after the far-chain asset actually arrives.',
    notes: [PERMISSIONLESS, NOT_A_BRIDGE, 'This connector does not verify far-chain delivery.'], steps,
  });
  return reply(renderApproval(p), { ...p, version: 2, contract: XSWAP_V2.intents, intent_id: id,
    order: JSON.parse(memoOf(order)), want_hash: wantHash(order), deadline: Number(deadline),
    gross_wallet_debit_wei: gross, escrow_ceiling_wei: funding.escrowCeiling,
    expected_escrow_received_wei: funding.expectedEscrowReceived, terms_hash: verified.out.termsHash,
    submit_with: 'submit_xswap' });
}

async function prepareV2In(args) {
  assertXSwapV2NewOrdersEnabled();
  const verified = await verifyXSwapV2();
  if (!isAddress(args.from)) throw new Error('`from` must be an address.');
  const order = orderFrom({ ...args, to: ZERO }, { recipientOptional: true });
  const net = parseXMoney(args.want_xmoney);
  const floor = xswapV2InFloor(net);
  const minutes = Math.max(10, Number(args.deadline_minutes ?? 120));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + minutes * 60);
  const id = args.id || freshId(args.from);
  const p = prepared({
    action: `Sell ${order._label} on ${order._chain.slug} for X Money`,
    chainId: PARENT_CHAIN_ID, asset: order._label, amount: `at least ${fmtXMoney(net)} X Money to your wallet`,
    counterparty: 'a bonded V2 buyer',
    fees: [
      { label: 'site convenience fee', amount: `at least ${fmtXMoney(floor.siteFeeAtFloor)} X Money at the bid floor`, note: '10 bp of the winning payment' },
      { label: 'protocol fee', amount: `at least ${fmtXMoney(floor.protocolFeeAtFloor)} X Money at the bid floor`, note: '50 bp of the winning payment' },
    ],
    net: `at least ${fmtXMoney(net)} X Money after both fees and the outbound X Money burn`,
    timeline: [`bidding ${secs(verified.in.bidding)}`, `challenge window ${secs(verified.in.window)}`, `deadline ${new Date(Number(deadline) * 1000).toISOString()}`],
    irreversible: 'Sending the far-chain asset is outside this escrow and cannot be undone from here.',
    notes: [PERMISSIONLESS, NOT_A_BRIDGE, 'Posting the ask moves no X Money. The buyer funds escrow before delivery.'],
    steps: [{ label: `Post the V2 ask with ${fmtXMoney(net)} X Money net wallet floor`, chainId: PARENT_CHAIN_ID,
      to: XSWAP_V2.asks, value: 0n,
      data: encodeFunctionData({ abi: XSWAP_V2_ASKS_ABI, functionName: 'askWithSiteFee', args: [id, net,
        deadline, wantHash(order), memoOf(order), XSWAP_V2.collector, 10, verified.in.termsHash] }) }],
  });
  return reply(renderApproval(p), { ...p, version: 2, contract: XSWAP_V2.asks, ask_id: id,
    order: JSON.parse(memoOf(order)), give_hash: wantHash(order), deadline: Number(deadline),
    min_seller_net_wei: net, gross_bid_floor_wei: floor.grossBidFloor, terms_hash: verified.in.termsHash,
    submit_with: 'submit_xswap' });
}

const PERMISSIONLESS = 'Anyone can solve this: there is no allow-list. Posting the bond is the permission, and losing a dispute is the cost.';
const NOT_A_BRIDGE = 'Nothing here is a bridge. The solver is the bridge, its bond is the collateral, and the challenge window is your recourse if it never arrives.';

export const tools = [
  {
    name: 'xswap_chains',
    description: 'Where X Money can go and come from: the EVM chains solvers already reach. Read-only, no network call.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Filter by name or chain id.' } }, additionalProperties: false },
    async handler({ query }) {
      const q = String(query || '').trim().toLowerCase();
      const list = q ? XSWAP_CHAINS.filter((c) => c.slug.includes(q) || String(c.id) === q || c.symbol.toLowerCase() === q) : XSWAP_CHAINS;
      if (!list.length) return reply(`No destination matches "${query}". There are ${XSWAP_CHAINS.length} chains; call this again with no query to see them.`, { chains: [] });
      return reply(`${list.length} destination${list.length > 1 ? 's' : ''}: ${list.map((c) => `${c.slug} (${c.id}, ${c.symbol})`).join(', ')}.`, { chains: list });
    },
  },
  {
    name: 'xswap_terms',
    description: 'The escrow\'s own terms on both directions, read from the contracts: bidding time, challenge window, bond and protocol fee, who can resolve a dispute (owner() read live) and what that owner can and cannot do, and whether new swaps are open on this connector.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      const [t, arb, v2] = await Promise.all([terms(), arbiter(), verifyXSwapV2().catch(() => null)]);
      const line = (d, t2) => `${d}: bidding ${secs(t2.bidding_s)}, challenge window ${secs(t2.window_s)}, bond ${Number(t2.bond_bps) / 100}% of the escrow, protocol fee ${Number(t2.fee_bps) / 100}% of what the solver charges.`;
      const paused = pausedReason();
      const sameOwner = arb.out.owner && arb.in.owner && arb.out.owner.toLowerCase() === arb.in.owner.toLowerCase();
      const rules = sameOwner
        ? [`Who resolves disputes (both contracts): ${whoRules(arb.out)}`]
        : [`Who resolves disputes, X Money out: ${whoRules(arb.out)}`, `Who resolves disputes, X Money in: ${whoRules(arb.in)}`];
      const nobody = arb.out.kind === 'nobody' || arb.in.kind === 'nobody';
      const problems = paused || XSWAP_V2.enabled ? [] : ownerProblems(arb);
      const v2Open = XSWAP_V2.enabled && Boolean(v2);
      return reply([
        paused ? `PAUSED. ${paused} ${stillWorks(arb)}`
          : problems.length ? `NOT OPEN: no verified owner can resolve disputes. ${problems.join(' ')} ${stillWorks(arb)}`
            : v2Open ? `New swaps are open on this connector, on the reviewed V2 escrows (intents ${XSWAP_V2.intents}, asks ${XSWAP_V2.asks}). The legacy escrows below stay exit-only.`
              : XSWAP_V2.enabled ? `NOT OPEN on this read: the V2 escrows could not be runtime-verified right now, so no new order is prepared. ${stillWorks(arb)}`
                : 'New swaps are open on this connector.',
        line('X Money out (you pay X Money, an asset lands elsewhere)', t.out),
        line('X Money in (you hand over an asset, X Money lands here)', t.in),
        ...rules,
        ...(nobody ? [] : [ownerPowers(arb).out, ownerPowers(arb).in, PARAMS_IN_FLIGHT]),
        BURN_NOTE,
        v2 ? `Reviewed V2 escrows runtime verified (${XSWAP_V2.intents}, ${XSWAP_V2.asks}); site fee 10 bp of the winning solver ask, charged only at settlement. ${XSWAP_V2.enabled ? 'New V2 orders are open: prepare_xswap_out (X Money out, Base native ETH is the route the solver fills today) and prepare_xswap_in.' : 'New V2 funding remains paused.'}`
          : 'V2 deployment could not be verified on this read; no new V2 order is prepared.',
        PERMISSIONLESS,
      ].join('\n'), {
        ...t,
        new_swaps_open: XSWAP_V2.enabled ? v2Open : !paused && !problems.length,
        paused_reason: paused || (problems.length ? problems.join(' ') : null),
        arbiter: { out: arb.out, in: arb.in },
        forge_default_sender: FORGE_DEFAULT_SENDER,
        expected_owner: XSWAP.expectedOwner,
        dispute_is_a_way_out: !nobody,
        intents: XSWAP.intents, asks: XSWAP.asks, xmoney: XSWAP.xmoney, chain_id: XSWAP.chainId, address_source: XSWAP.source,
        v2: { intents: XSWAP_V2.intents, asks: XSWAP_V2.asks, collector: XSWAP_V2.collector,
          runtime_verified: Boolean(v2), new_orders_open: v2Open, site_fee_bps: 10, terms: v2 },
      });
    },
  },
  {
    name: 'quote_xswap',
    description: 'What an X Money swap costs before anything is signed: the escrow, the fee ceiling, what the bidding can hand back, and the timeline. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        xmoney_amount: { type: 'string', description: 'X Money you are willing to spend (the escrow, and your worst case).' },
        chain: { type: 'string', description: 'Destination chain: slug or id, e.g. "base" or 8453.' },
        asset: { type: 'string', description: '"native" or a token address on that chain. Default native.' },
        ...assetFields,
        to: addr,
      },
      required: ['xmoney_amount', 'chain'],
      additionalProperties: false,
    },
    async handler(args) {
      const o = orderFrom(args, { recipientOptional: true });
      const gross = parseXMoney(args.xmoney_amount);
      const funding = xswapV2OutFunding(gross);
      const live = await verifyXSwapV2().catch(() => null);
      const paused = XSWAP_V2.enabled ? null : 'V2 new orders are paused until the V2 solver and far delivery are reviewed.';
      return reply([
        paused ? `PAUSED: this is a read-only V2 calculation; prepare_xswap_out will refuse. ${paused}`
          : 'V2 quote. prepare_xswap_out prepares this order against the reviewed V2 escrow; the solver network fills Base native ETH today, other routes wait for a solver to bid.',
        `Deliver ${o._label} on ${o._chain.slug}${o.to === ZERO ? '' : ` to ${o.to}`}.`,
        `Gross wallet debit cap ${fmtXMoney(gross)} X Money; estimated escrow receipt ${fmtXMoney(funding.expectedEscrowReceived)} after 1 bp transfer burn.`,
        `Maximum solver ceiling ${fmtXMoney(funding.escrowCeiling)} X Money. The escrow also reserves up to ${fmtXMoney(funding.siteFeeMax)} X Money for the 10 bp site fee.`,
        `Protocol fee at most ${fmtXMoney(funding.protocolFeeMax)} X Money (50 bp of the winning solver ask).`,
        live ? `V2 bidding ${secs(live.out.bidding)}, bond ${live.out.bondBps / 100}%, challenge window ${secs(live.out.window)}.`
          : 'The live V2 terms could not be verified in this quote; no order is offered.',
        NOT_A_BRIDGE,
      ].join('\n'), { version: 2, order: memoOf(o), want_hash: wantHash(o), gross_wallet_debit_wei: gross,
        expected_escrow_received_wei: funding.expectedEscrowReceived, escrow_ceiling_wei: funding.escrowCeiling,
        site_fee_max_wei: funding.siteFeeMax, protocol_fee_max_wei: funding.protocolFeeMax,
        terms: live?.out ?? null, paused_reason: paused });
    },
  },
  {
    name: 'prepare_xswap_out',
    description: 'X Money in, an asset out on any EVM chain. Returns unsigned transactions (approve, if needed, then open) plus the approval screen. Signs nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { ...addr, description: 'The wallet that pays and that gets the refund.' },
        xmoney_amount: { type: 'string', description: 'X Money to escrow: your ceiling, not your price.' },
        chain: { type: 'string', description: 'Destination chain: slug or id.' },
        asset: { type: 'string', description: '"native" or a token address on that chain. Default native.' },
        ...assetFields,
        to: { ...addr, description: 'Who receives it over there.' },
        deadline_minutes: { type: 'number', description: 'Refund is yours after this. Default 60.' },
        id: { ...b32, description: 'Reuse an id you were handed, to re-prepare the same intent.' },
      },
      required: ['from', 'xmoney_amount', 'chain', 'to'],
      additionalProperties: false,
    },
    async handler(args) {
      return prepareV2Out(args);
    },
  },
  {
    name: 'prepare_xswap_in',
    description: 'The other direction: you hand over an asset on any EVM chain, X Money lands here. Posts an ask: a price, not an escrow. Buyers bid and their X Money is held before you send anything. Signs nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { ...addr, description: 'The seller, and the address the X Money lands on.' },
        want_xmoney: { type: 'string', description: 'The least X Money you will take. Bidding goes up from here.' },
        chain: { type: 'string', description: 'The chain your asset is on.' },
        asset: { type: 'string', description: '"native" or a token address. Default native.' },
        ...assetFields,
        deadline_minutes: { type: 'number', description: 'Everything unwinds after this. Default 120.' },
        id: b32,
      },
      required: ['from', 'want_xmoney', 'chain'],
      additionalProperties: false,
    },
    async handler(args) {
      return prepareV2In(args);
    },
  },
  {
    name: 'xswap_status',
    description: 'Where one swap stands, either direction: who took it, what they charge, what comes back to you, and how long the clocks have left. Read-only.',
    inputSchema: { type: 'object', properties: { id: b32, contract: { ...addr, description: 'Exact V2 or legacy escrow address if this id exists on more than one contract.' } }, required: ['id'], additionalProperties: false },
    async handler({ id, contract }) {
      const s = await either(id, contract);
      if (!s) return reply(`No swap with id ${id} on the known V2 or legacy escrows. An id only exists once its open/ask transaction has landed.`, { found: false });
      const clock = (n, what) => (n > 0 ? `${what} in ${secs(n)}` : `${what} passed ${secs(-n)} ago`);
      const L = s.side === 'out'
        ? [`X Money out · ${s.state}.`, `${s.user} escrowed ${s.escrowed} X Money.`,
           s.solver ? `Solver ${s.solver} asks ${s.solver_ask}, bond ${s.bond}; ${s.back_to_you} comes back to you.` : 'No bid yet.',
           `${clock(s.bidding_ends_in, 'bidding ends')}, ${clock(s.deadline_in, 'refund deadline')}.`]
        : [`X Money in · ${s.state}.`, `${s.seller} wants at least ${s.floor} X Money.`,
           s.buyer ? `Buyer ${s.buyer} has ${s.best_bid} escrowed, bond ${s.buyer_bond}.` : 'No bid yet.',
           `${clock(s.bidding_ends_in, 'bidding ends')}, ${clock(s.deadline_in, 'deadline')}.`];
      if (s.state_code === 4) { // Disputed, on both contracts
        const ruler = await ownerOf(s.contract);
        L.push(`Disputed. Who can rule on it: ${whoRules(ruler)}`);
        s.arbiter = ruler;
      }
      return reply(L.join('\n'), s);
    },
  },
  {
    name: 'list_my_xswaps',
    description: 'Every swap a wallet has opened or offered, newest first, with the state each one is in. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { address: addr, lookback_blocks: { type: 'number', description: 'Default 400000.' }, limit: { type: 'number', description: 'Default 20.' } },
      required: ['address'], additionalProperties: false,
    },
    async handler({ address, lookback_blocks = 400_000, limit = 20 }) {
      if (!isAddress(address)) throw new Error(`Not an address: ${address}`);
      const head = await parent.getBlockNumber({ cacheTime: 0 }); // a cached head can miss the swap that just landed
      const fromBlock = head > BigInt(lookback_blocks) ? head - BigInt(lookback_blocks) : 0n;
      const ev = (abi, name) => abi.find((a) => a.type === 'event' && a.name === name);
      const logs = await Promise.all(VENUES.map(async (venue) => ({ venue, logs: await parent.getLogs({
        address: venue.contract, event: ev(venue.abi, venue.side === 'out' ? 'Opened' : 'Asked'),
        args: venue.side === 'out' ? { user: address } : { seller: address }, fromBlock, toBlock: head,
      }).catch(() => []) })));
      // Change from the bidding, solver payouts and won disputes all sit as credit until they are pulled.
      const credits = await Promise.all(VENUES.map(async (venue) => ({ contract: venue.contract, side: venue.side,
        amount: await parent.readContract({ address: venue.contract, abi: venue.abi, functionName: 'credit', args: [address] }).catch(() => 0n) })));
      const creditOut = credits.filter((c) => c.side === 'out').reduce((sum, c) => sum + c.amount, 0n);
      const creditIn = credits.filter((c) => c.side === 'in').reduce((sum, c) => sum + c.amount, 0n);
      const waiting = creditOut + creditIn > 0n
        ? `\n${fmtXMoney(creditOut + creditIn)} X Money is waiting across the escrows. Pull each credit with prepare_xswap_action action=withdraw and that row's contract address.`
        : '';
      const rows = logs.flatMap(({ venue, logs: venueLogs }) => venueLogs.map((l) => ({ l, venue })))
        .sort((a, b) => Number(b.l.blockNumber - a.l.blockNumber)).slice(0, limit);
      if (!rows.length) return reply(`${address} has no swaps in the last ${lookback_blocks} blocks.${waiting}`, { swaps: [], credit_out: creditOut, credit_in: creditIn, credits });
      const swaps = [];
      for (const r of rows) {
        const s = r.venue.side === 'out' ? await intentOf(r.l.args.id, r.venue) : await askOf(r.l.args.id, r.venue);
        if (!s) continue;
        const order = orderFromMemo(r.l.args.memo, s.side === 'out' ? s.want : s.give); // typed fields only, re-hashed
        if (order) s.order = order;
        swaps.push(s);
      }
      const what = (s, h) => (!s.order ? `see ${h} hash` : `${s.order.kind} on chain ${s.order.dstChainId}${s.order.matches_hash ? '' : ' (memo does NOT match the on-chain hash)'}`);
      const line = (s) => (s.side === 'out'
        ? `${s.id.slice(0, 10)}… out · ${s.escrowed} X Money → ${what(s, 'want')} · ${s.state}`
        : `${s.id.slice(0, 10)}… in · ${what(s, 'give')} → ${s.floor}+ X Money · ${s.state}`);
      return reply(`${swaps.length} swap${swaps.length > 1 ? 's' : ''}:\n${swaps.map(line).join('\n')}${waiting}`, { swaps, credit_out: creditOut, credit_in: creditIn, credits });
    },
  },
  {
    name: 'xswap_reputation',
    description: 'What an address has actually done on the escrow: jobs filled and failed, intents opened, disputes raised and lost. Nobody grants this; it is only ever the sum of finished swaps. Read-only.',
    inputSchema: { type: 'object', properties: { address: addr, contract: { ...addr, description: 'Optional known intents escrow; defaults to the deployed V2 intents.' } }, required: ['address'], additionalProperties: false },
    async handler({ address, contract }) {
      if (!isAddress(address)) throw new Error(`Not an address: ${address}`);
      const venue = venueOf(contract || XSWAP_V2.intents);
      if (!venue || venue.side !== 'out') throw new Error('Reputation is read from a known XSwap intents escrow.');
      const [filled, failed, opened, disputed, disputesLost, volume, since] = await parent.readContract({
        address: venue.contract, abi: venue.abi, functionName: 'rep', args: [address],
      });
      const taken = filled + failed;
      const rep = {
        address, contract: venue.contract, version: venue.version, filled: Number(filled), failed: Number(failed), opened: Number(opened),
        disputed: Number(disputed), disputes_lost: Number(disputesLost),
        volume_xmoney: fmtXMoney(volume), first_seen: since === 0n ? null : new Date(Number(since) * 1000).toISOString(),
        fail_bps: taken === 0n ? null : Number((failed * BPS) / taken),
      };
      const text = taken === 0n
        ? `${address} is new here: no jobs taken as a solver${opened > 0n ? `, ${opened} intent${opened > 1n ? 's' : ''} paid for` : ''}. New is not the same as bad, and the bond covers you either way.`
        : `${address}: ${rep.filled} filled, ${rep.failed} failed (${(rep.fail_bps / 100).toFixed(1)}%), ${rep.volume_xmoney} X Money settled, first seen ${rep.first_seen}.`;
      return reply(text, rep);
    },
  },
  {
    name: 'prepare_xswap_action',
    description: 'The rest of a swap\'s life as unsigned transactions: bid on it as a solver, claim a delivery, accept the best bid, confirm, dispute inside the window, refund a dead intent, cancel an ask, mark an ask delivered, settle, or pull your credit. Anyone can solve; the bond is the permission. While XSwap is paused, bid, claim, accept and delivered refuse and the ways out keep working. On a contract nobody can rule on (xswap_terms says), dispute is not a way out: it freezes the swap\'s escrow and bond forever. Signs nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        id: b32,
        action: { type: 'string', enum: ['accept', 'confirm', 'dispute', 'refund', 'cancel', 'delivered', 'settle', 'withdraw', 'bid', 'claim'] },
        from: { ...addr, description: 'For bid and claim: the solver. Its bond and its record are what back the job.' },
        ask: { type: 'string', description: 'For bid: the X Money you want out of the escrow. Lowest ask wins.' },
        reason: { type: 'string', description: 'Required for dispute: what did not arrive.' },
        proof: { ...b32, description: 'For delivered: the transaction hash on the other chain.' },
        side: { type: 'string', enum: ['out', 'in'], description: 'Only needed for withdraw, which has no id.' },
        contract: { ...addr, description: 'Exact V2 or legacy escrow. Required for an older withdrawal; optional with a unique swap id.' },
      },
      required: ['action'], additionalProperties: false,
    },
    async handler({ id, action, reason, proof, side, from, ask, contract }) {
      if (action === 'withdraw') {
        const venue = contract ? venueOf(contract) : venueOf(side === 'in' ? XSWAP.asks : XSWAP.intents);
        if (!venue || (side && venue.side !== side)) throw new Error('Choose a known XSwap escrow matching the requested side.');
        const p = prepared({
          action: 'Pull everything this escrow owes you', chainId: PARENT_CHAIN_ID, to: venue.contract, value: 0n,
          data: encodeFunctionData({ abi: venue.abi, functionName: 'withdraw', args: [] }),
          asset: 'X Money', amount: 'your whole credit balance', irreversible: null,
          notes: ['Credit is what settlements and won disputes have already set aside for you. Pulling it changes nothing else.'],
        });
        return reply(renderApproval(p), { ...p, submit_with: 'submit_xswap' });
      }
      if (!id) throw new Error('Give the swap id.');
      const s = await either(id, contract);
      if (!s) throw new Error(`No swap with id ${id}.`);
      if (GATED_ACTIONS.has(action)) {
        if (s.version !== 2) throw new Error(`New bids, claims and delivery advances are paused on legacy escrow ${s.contract}. Existing refunds, cancellations, settlements and withdrawals remain available.`);
        assertXSwapV2NewOrdersEnabled();
        await verifyXSwapV2();
      }
      const out = s.side === 'out';
      const to = s.contract;
      const abi = venueOf(to).abi;
      const [window, bondBps, ruler] = await Promise.all([
        parent.readContract({ address: to, abi, functionName: 'window' }),
        parent.readContract({ address: to, abi, functionName: 'bondBps' }),
        ownerOf(to),
      ]);
      const t = { window_s: s.challenge_window_s ?? Number(window), bond_bps: s.opened_bond_bps ?? Number(bondBps) };
      const unresolvable = ruler.kind === 'nobody';

      const spec = {
        accept: {
          fn: 'accept', args: [id],
          title: out ? `Accept ${s.solver_ask ?? 'the best'} X Money as the price and stop the bidding`
                     : `Accept ${s.best_bid ?? 'the best'} X Money and sell`,
          note: out ? 'Bidding ends now; the solver can deliver immediately. You keep the difference between your escrow and their ask.'
                    : 'The buyer\'s X Money is already escrowed. Send the asset next, then mark it delivered.',
          irreversible: null,
        },
        confirm: {
          fn: 'confirm', args: [id],
          title: out ? 'Confirm it arrived and pay the solver now' : 'Confirm the asset arrived and release the X Money',
          note: 'This skips the rest of the challenge window.',
          irreversible: 'The escrow pays out immediately and cannot be clawed back. Only confirm what you have actually received.',
        },
        dispute: {
          fn: 'dispute', args: [id, String(reason || '')],
          title: 'Dispute this delivery',
          note: unresolvable
            ? `Must be inside the ${secs(t.window_s)} window. On this contract NOBODY can rule on a dispute (${whoRules(ruler)}). Disputing freezes this swap's escrow and bond permanently: you do not get your X Money back, and the other side is never paid either.`
            : `Must be inside the ${secs(t.window_s)} window. The owner rules on it: ${whoRules(ruler)} It can only ever move this one swap's money.`,
          irreversible: null,
          require: () => { if (!reason) throw new Error('Say what went wrong: the reason is on chain and it is what the arbiter reads.'); },
        },
        refund: {
          fn: 'refund', args: [id],
          title: `Refund the ${out ? s.escrowed : ''} X Money nobody delivered on`,
          note: out ? 'Only after your deadline, and only while no delivery is claimed.' : 'Refund is the intents side; use cancel on an ask.',
          irreversible: null,
          require: () => { if (!out) throw new Error('This id is an ask. Use action "cancel".'); if (s.deadline_in > 0) throw new Error(`The deadline has not passed: ${secs(s.deadline_in)} left. Nobody can refund before it.`); },
        },
        cancel: {
          fn: 'cancel', args: [id],
          title: 'Cancel this ask and make everyone whole',
          note: 'The buyer\'s escrow and bond go back to them.',
          irreversible: null,
          require: () => { if (out) throw new Error('This id is an intent. Use action "refund".'); },
        },
        delivered: {
          fn: 'delivered', args: [id, proof || '0x'.padEnd(66, '0')],
          title: 'Mark the asset as sent',
          note: `Starts the buyer's ${secs(t.window_s)} window. Put the far-chain transaction hash in \`proof\` so it is on the record.`,
          irreversible: 'You have already sent the asset on the other chain by this point, and that cannot be undone from here.',
          require: () => { if (out) throw new Error('Only the ask side has a delivery to mark; on an intent the solver claims.'); },
        },
        settle: {
          fn: 'settle', args: [id],
          title: 'Settle: the window has passed, take the X Money',
          note: 'Anyone can call this; the money goes to the party the contract already owes.',
          irreversible: null,
        },
        bid: {
          fn: 'bid', args: [id, ask === undefined ? 0n : parseXMoney(ask)],
          title: out ? `Bid ${ask} X Money to solve this intent` : `Bid ${ask} X Money to buy this`,
          note: out ? 'The lowest ask wins and the bond comes with it. Being outbid returns your bond.'
                    : 'The highest bid wins. Your X Money and bond sit in the escrow until the seller delivers or the deadline passes.',
          irreversible: null,
          require: () => { if (ask === undefined) throw new Error('Say what you are bidding.'); },
        },
        claim: {
          fn: 'claim', args: [id, proof || '0x'.padEnd(66, '0')],
          title: 'Claim this intent as delivered',
          note: `Posts your bond and starts the payer's ${secs(t.window_s)} window. Put the far-chain transaction hash in \`proof\`.`,
          irreversible: 'You have already sent the asset on the other chain by this point. A dispute you lose costs you the bond.',
          require: () => { if (!out) throw new Error('Only the intents side is claimed; on an ask the seller marks it delivered.'); },
        },
      }[action];
      if (!spec) throw new Error(`Unknown action: ${action}`);
      spec.require?.();
      if (action === 'dispute' && unresolvable) throw new Error('A dispute on this keyless-owner legacy escrow cannot be resolved; no transaction was prepared.');

      const steps = [];
      let bidGrossWalletCap = null;
      // A bid is collateral, not a promise: whoever bids has to let the escrow take the bond first.
      if (action === 'bid' || (action === 'claim' && s.version !== 2)) {
        if (!isAddress(from || '')) throw new Error('Give `from`: the address posting the bond.');
        const bond = out
          ? (await parent.readContract({ address: to, abi, functionName: 'canClaim', args: [id, from] }))[2]
          : (parseXMoney(ask ?? '0') * BigInt(t.bond_bps)) / BPS;
        const target = action === 'bid' && !out ? parseXMoney(ask) + bond : bond;
        const need = s.version === 2 ? xswapV2GrossFor(target) : target;
        if (s.version === 2 && action === 'bid') {
          bidGrossWalletCap = need;
          spec.args.push(need);
        }
        const payToken = s.version === 2 ? L3.xMoney : XSWAP.xmoney;
        const allowance = await parent.readContract({ address: payToken, abi: ERC20_ABI, functionName: 'allowance', args: [from, to] });
        if (allowance < need) {
          steps.push({
            label: `Approve the escrow for ${fmtXMoney(need)} X Money (bond${!out && action === 'bid' ? ' and payment' : ''})`,
            chainId: PARENT_CHAIN_ID, to: payToken, value: 0n,
            data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [to, need] }),
          });
        }
        spec.note += ` Bond for this one: ${fmtXMoney(bond)} X Money. ${s.version === 2 ? `Gross wallet debit cap ${fmtXMoney(need)} X Money includes the transfer burn.` : ''}`;
      }
      steps.push({ label: spec.title, chainId: PARENT_CHAIN_ID, to, value: 0n, data: encodeFunctionData({ abi, functionName: spec.fn, args: spec.args }) });

      const p = prepared({
        action: spec.title, chainId: PARENT_CHAIN_ID,
        asset: 'X Money', amount: out ? `${s.escrowed} escrowed` : `${s.floor} floor`,
        counterparty: out ? s.solver : s.buyer,
        net: null, timeline: [`swap is currently: ${s.state}`], irreversible: spec.irreversible, notes: [spec.note],
        steps,
      });
      return reply(renderApproval(p), { ...p, id, side: s.side, contract: to, version: s.version,
        bid_gross_wallet_debit_cap_wei: bidGrossWalletCap, state: s.state, submit_with: 'submit_xswap' });
    },
  },
  {
    name: 'submit_xswap',
    description: 'Broadcast the signed transaction(s) from a prepare_xswap_* tool. The connector holds no keys; this is a relay. An idempotency key makes a retry return the first hash instead of sending twice.',
    inputSchema: {
      type: 'object',
      properties: {
        signed_tx: { type: 'string', description: 'One raw signed transaction.' },
        signed_txs: { type: 'array', items: { type: 'string' }, description: 'Several, sent in order, stopping on the first revert (approve then open).' },
        idempotency_key: { type: 'string', description: 'Your own key for this submission. Strongly recommended.' },
      },
      additionalProperties: false,
    },
    async handler({ signed_tx, signed_txs, idempotency_key }) {
      const kind = 'xswap';
      const chainId = PARENT_CHAIN_ID;
      await assertRelayAllowed(Array.isArray(signed_txs) && signed_txs.length ? signed_txs : [signed_tx].filter(Boolean));
      const res = Array.isArray(signed_txs) && signed_txs.length
        ? await submitBatch({ chainId, signedTxs: signed_txs, idempotencyKey: idempotency_key, kind })
        : await submitRaw({ chainId, signedTx: signed_tx, idempotencyKey: idempotency_key, kind });
      const hashes = res.hashes || [res.hash];
      return reply(`${res.replayed ? 'Already sent (idempotency key replayed)' : `Sent ${hashes.length} transaction${hashes.length > 1 ? 's' : ''}`}: ${hashes.join(', ')}. Follow it with xswap_status once it lands.`, res);
    },
  },
];
