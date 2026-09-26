import { encodeAbiParameters, encodeFunctionData, isAddress, keccak256, parseUnits, formatUnits, parseAbi, parseTransaction, toFunctionSelector } from 'viem';
import { XSWAP, PARENT_CHAIN_ID, parent, ZERO, FORGE_DEFAULT_SENDER, isXswapV1, validXswapOwner } from '../config.mjs';
import { ERC20_ABI, XSWAP_INTENTS_ABI, XSWAP_ASKS_ABI } from '../abis.mjs';
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

async function intentOf(id) {
  const i = await readI('get', [id]).catch(() => null);
  if (!i || i.user === ZERO) return null;
  const now = Math.floor(Date.now() / 1000);
  return {
    side: 'out', id, contract: XSWAP.intents, user: i.user,
    escrowed: fmtXMoney(i.amount), escrowed_wei: i.amount,
    state: INTENT_STATE[Number(i.state)] || `state ${i.state}`, state_code: Number(i.state),
    solver: i.solver === ZERO ? null : i.solver,
    solver_ask: i.solver === ZERO ? null : fmtXMoney(i.ask), bond: fmtXMoney(i.bond),
    back_to_you: i.solver === ZERO ? null : fmtXMoney(i.amount - i.ask),
    bidding_ends_in: Number(i.bidEnds) - now, deadline_in: Number(i.deadline) - now,
    claimed_at: Number(i.claimedAt) || null, want: i.want,
  };
}
async function askOf(id) {
  const a = await readA('get', [id]).catch(() => null);
  if (!a || a.seller === ZERO) return null;
  const now = Math.floor(Date.now() / 1000);
  return {
    side: 'in', id, contract: XSWAP.asks, seller: a.seller,
    floor: fmtXMoney(a.floorPay), state: ASK_STATE[Number(a.state)] || `state ${a.state}`, state_code: Number(a.state),
    buyer: a.buyer === ZERO ? null : a.buyer,
    best_bid: a.buyer === ZERO ? null : fmtXMoney(a.pay), buyer_bond: fmtXMoney(a.bond),
    bidding_ends_in: Number(a.bidEnds) - now, deadline_in: Number(a.deadline) - now,
    delivered_at: Number(a.deliveredAt) || null, give: a.give,
  };
}
const either = async (id) => (await intentOf(id)) || (await askOf(id));

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
  if (XSWAP.v1) {
    return `XSwap is paused for new swaps. The escrow contracts this connector points at (intents ${XSWAP.intents}, asks ${XSWAP.asks}, Robinhood Chain 4663) have owner() = ${FORGE_DEFAULT_SENDER}, forge-std's default sender, which no one holds a key for: their deploy script read msg.sender before it started broadcasting. Only the owner can resolve a dispute, so on these contracts a disputed swap would stay frozen forever, escrow and bond both. Replacement contracts with a real owner are prepared but not deployed yet.`;
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
  return null;
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
const GATED_SELECTORS = new Set([
  ...selectorsOf(XSWAP_INTENTS_ABI, ['open', 'openWith', 'bid', 'claim', 'accept']),
  ...selectorsOf(XSWAP_ASKS_ABI, ['ask', 'bid', 'accept', 'delivered']),
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

async function assertXswapOpen(what, nothing = 'Nothing was prepared.') {
  const paused = pausedReason();
  const arb = await arbiter().catch(() => null);
  if (paused) throw new Error(`${what} refused. ${paused} ${stillWorks(arb)} ${nothing}`);
  const problems = ownerProblems(arb || { out: { kind: 'unknown', contract: XSWAP.intents }, in: { kind: 'unknown', contract: XSWAP.asks } });
  if (problems.length) throw new Error(`${what} refused: no verified owner can resolve disputes on these contracts. ${problems.join(' ')} ${stillWorks(arb)} ${nothing}`);
}

/** submit_xswap relays anything signed. It still will not relay a new swap, bid or claim to a contract that is paused. */
async function assertRelayAllowed(raws) {
  const configured = new Set([XSWAP.intents, XSWAP.asks].map((a) => a.toLowerCase()));
  for (const raw of raws) {
    let tx;
    try { tx = parseTransaction(raw); } catch { continue; } // not a transaction: the RPC rejects it
    const to = tx.to ? tx.to.toLowerCase() : null;
    const sel = String(tx.data || tx.input || '0x').slice(0, 10).toLowerCase();
    if (!to || !GATED_SELECTORS.has(sel)) continue;
    if (isXswapV1(to)) {
      throw new Error(`submit_xswap refused: this transaction starts or advances a swap on ${to}, a v1 XSwap contract whose owner() is ${FORGE_DEFAULT_SENDER}, an address no one holds a key for. A dispute there could never be resolved. Nothing was sent.`);
    }
    if (configured.has(to)) await assertXswapOpen('submit_xswap', 'Nothing was sent.');
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
      const [t, arb] = await Promise.all([terms(), arbiter()]);
      const line = (d, t2) => `${d}: bidding ${secs(t2.bidding_s)}, challenge window ${secs(t2.window_s)}, bond ${Number(t2.bond_bps) / 100}% of the escrow, protocol fee ${Number(t2.fee_bps) / 100}% of what the solver charges.`;
      const paused = pausedReason();
      const sameOwner = arb.out.owner && arb.in.owner && arb.out.owner.toLowerCase() === arb.in.owner.toLowerCase();
      const rules = sameOwner
        ? [`Who resolves disputes (both contracts): ${whoRules(arb.out)}`]
        : [`Who resolves disputes, X Money out: ${whoRules(arb.out)}`, `Who resolves disputes, X Money in: ${whoRules(arb.in)}`];
      const nobody = arb.out.kind === 'nobody' || arb.in.kind === 'nobody';
      const problems = paused ? [] : ownerProblems(arb);
      return reply([
        paused ? `PAUSED. ${paused} ${stillWorks(arb)}`
          : problems.length ? `NOT OPEN: no verified owner can resolve disputes. ${problems.join(' ')} ${stillWorks(arb)}`
            : 'New swaps are open on this connector.',
        line('X Money out (you pay X Money, an asset lands elsewhere)', t.out),
        line('X Money in (you hand over an asset, X Money lands here)', t.in),
        ...rules,
        ...(nobody ? [] : [ownerPowers(arb).out, ownerPowers(arb).in, PARAMS_IN_FLIGHT]),
        BURN_NOTE,
        PERMISSIONLESS,
      ].join('\n'), {
        ...t,
        new_swaps_open: !paused && !problems.length,
        paused_reason: paused || (problems.length ? problems.join(' ') : null),
        arbiter: { out: arb.out, in: arb.in },
        forge_default_sender: FORGE_DEFAULT_SENDER,
        expected_owner: XSWAP.expectedOwner,
        dispute_is_a_way_out: !nobody,
        intents: XSWAP.intents, asks: XSWAP.asks, xmoney: XSWAP.xmoney, chain_id: XSWAP.chainId, address_source: XSWAP.source,
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
      const amount = parseXMoney(args.xmoney_amount);
      const t = (await terms()).out;
      const maxFee = (amount * BigInt(t.fee_bps)) / BPS;
      const paused = pausedReason();
      return reply([
        ...(paused ? [`PAUSED: this is a quote only; prepare_xswap_out will refuse. ${paused}`] : []),
        `Deliver ${o._label} on ${o._chain.slug}${o.to === ZERO ? '' : ` to ${o.to}`}.`,
        `You escrow ${fmtXMoney(amount)} X Money. That is the most it can cost you: solvers bid down from it, and every bit the bidding saves comes back to you when the job settles.`,
        `Protocol fee at most ${fmtXMoney(maxFee)} X Money (${t.fee_bps / 100}% of what the winning solver actually charges, not of your escrow).`,
        `Bidding runs ${secs(t.bidding_s)}; the solver posts ${t.bond_bps / 100}% of the escrow as bond; you have ${secs(t.window_s)} after delivery to dispute.`,
        `If nobody delivers by your deadline, you get the escrow back.`,
        BURN_NOTE,
        `Disputes are ruled on by the contract's owner; xswap_terms says who that is.`,
        NOT_A_BRIDGE,
      ].join('\n'), { order: memoOf(o), want_hash: wantHash(o), escrow_wei: amount, max_fee_wei: maxFee, terms: t, paused_reason: paused });
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
      await assertXswapOpen('prepare_xswap_out');
      if (!isAddress(args.from)) throw new Error('`from` must be an address.');
      const o = orderFrom(args);
      const amount = parseXMoney(args.xmoney_amount);
      const mins = Math.max(5, Number(args.deadline_minutes ?? 60));
      const deadline = BigInt(Math.floor(Date.now() / 1000) + mins * 60);
      const id = args.id || freshId(args.from);

      const [bal, allowance, t, arb] = await Promise.all([
        parent.readContract({ address: XSWAP.xmoney, abi: ERC20_ABI, functionName: 'balanceOf', args: [args.from] }),
        parent.readContract({ address: XSWAP.xmoney, abi: ERC20_ABI, functionName: 'allowance', args: [args.from, XSWAP.intents] }),
        terms(),
        arbiter(),
      ]);
      if (bal < amount) throw new Error(`That wallet holds ${fmtXMoney(bal)} X Money and this intent escrows ${fmtXMoney(amount)}. Bridge in first, or escrow less.`);

      const steps = [];
      if (allowance < amount) {
        steps.push({
          label: `Approve the escrow for ${fmtXMoney(amount)} X Money`, chainId: PARENT_CHAIN_ID, to: XSWAP.xmoney, value: 0n,
          data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [XSWAP.intents, amount] }),
        });
      }
      steps.push({
        label: `Open the intent (${fmtXMoney(amount)} X Money into escrow)`, chainId: PARENT_CHAIN_ID, to: XSWAP.intents, value: 0n,
        data: encodeFunctionData({ abi: XSWAP_INTENTS_ABI, functionName: 'open', args: [id, amount, deadline, wantHash(o), memoOf(o)] }),
      });

      const p = prepared({
        action: `Send ${o._label} on ${o._chain.slug} to ${o.to}, paid in X Money`,
        chainId: PARENT_CHAIN_ID, asset: 'X Money (ERC-20 on Robinhood 4663)', amount: `${fmtXMoney(amount)} escrowed`,
        counterparty: 'whichever solver bids lowest: permissionless, bonded',
        fees: [{ label: 'protocol fee', amount: `up to ${fmtXMoney((amount * BigInt(t.out.fee_bps)) / BPS)} X Money`, note: `${t.out.fee_bps / 100}% of the winning ask` }],
        net: `${o._label} on ${o._chain.slug}, plus whatever the bidding saves off your ${fmtXMoney(amount)}`,
        timeline: [
          `bidding open ${secs(t.out.bidding_s)} from the moment it lands; the lowest ask wins`,
          `you can accept early to stop the clock`,
          `after delivery you have ${secs(t.out.window_s)} to dispute; then the solver is paid`,
          `nobody delivers by ${new Date(Number(deadline) * 1000).toISOString()}: refund in full`,
        ],
        irreversible: 'Once you confirm delivery, the escrow pays the solver and cannot be clawed back. Before that, a dispute inside the window returns your escrow and the solver\'s bond.',
        notes: [PERMISSIONLESS, NOT_A_BRIDGE, `Disputes are ruled on by: ${whoRules(arb.out)}`, BURN_NOTE, 'This connector cannot see the destination chain. Check the asset arrived yourself before confirming.'],
        steps,
      });
      return reply(renderApproval(p), { ...p, intent_id: id, order: JSON.parse(memoOf(o)), want_hash: wantHash(o), deadline: Number(deadline), submit_with: 'submit_xswap' });
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
      await assertXswapOpen('prepare_xswap_in');
      if (!isAddress(args.from)) throw new Error('`from` must be an address.');
      const o = orderFrom({ ...args, to: ZERO }, { recipientOptional: true });
      const floor = parseXMoney(args.want_xmoney);
      const mins = Math.max(10, Number(args.deadline_minutes ?? 120));
      const deadline = BigInt(Math.floor(Date.now() / 1000) + mins * 60);
      const id = args.id || freshId(args.from);
      const [{ in: t }, arb] = await Promise.all([terms(), arbiter()]);

      const p = prepared({
        action: `Sell ${o._label} on ${o._chain.slug} for X Money`,
        chainId: PARENT_CHAIN_ID, asset: o._label, amount: `floor ${fmtXMoney(floor)} X Money`,
        counterparty: 'whichever buyer bids highest, and their X Money is escrowed before you send',
        fees: [{ label: 'protocol fee', amount: `${t.fee_bps / 100}% of the winning bid`, note: 'taken on settlement, not now' }],
        net: `at least ${fmtXMoney(floor)} X Money, less the fee`,
        timeline: [
          `bidding open ${secs(t.bidding_s)}; the highest bid wins and you can accept early`,
          `send the asset, then mark it delivered`,
          `the buyer has ${secs(t.window_s)} to dispute; after that you settle and pull the X Money`,
          `nothing agreed by ${new Date(Number(deadline) * 1000).toISOString()}: cancel and everyone is made whole`,
        ],
        irreversible: 'Sending the asset on the other chain is outside this escrow and cannot be undone. Only mark it delivered once it actually is.',
        notes: [
          'The recipient is not part of the hash on this side: the buyer tells you where to send after they win, and disputes if it never lands.',
          'Posting the ask moves nothing. The buyer escrows first.',
          `Disputes are ruled on by: ${whoRules(arb.in)}`,
          PERMISSIONLESS,
        ],
        steps: [{
          label: `Post the ask (floor ${fmtXMoney(floor)} X Money)`, chainId: PARENT_CHAIN_ID, to: XSWAP.asks, value: 0n,
          data: encodeFunctionData({ abi: XSWAP_ASKS_ABI, functionName: 'ask', args: [id, floor, deadline, wantHash(o), memoOf(o)] }),
        }],
      });
      return reply(renderApproval(p), { ...p, ask_id: id, order: JSON.parse(memoOf(o)), give_hash: wantHash(o), deadline: Number(deadline), submit_with: 'submit_xswap' });
    },
  },
  {
    name: 'xswap_status',
    description: 'Where one swap stands, either direction: who took it, what they charge, what comes back to you, and how long the clocks have left. Read-only.',
    inputSchema: { type: 'object', properties: { id: b32 }, required: ['id'], additionalProperties: false },
    async handler({ id }) {
      const s = await either(id);
      if (!s) return reply(`No swap with id ${id} on either contract. An id only exists once its open/ask transaction has landed.`, { found: false });
      const clock = (n, what) => (n > 0 ? `${what} in ${secs(n)}` : `${what} passed ${secs(-n)} ago`);
      const L = s.side === 'out'
        ? [`X Money out · ${s.state}.`, `${s.user} escrowed ${s.escrowed} X Money.`,
           s.solver ? `Solver ${s.solver} asks ${s.solver_ask}, bond ${s.bond}; ${s.back_to_you} comes back to you.` : 'No bid yet.',
           `${clock(s.bidding_ends_in, 'bidding ends')}, ${clock(s.deadline_in, 'refund deadline')}.`]
        : [`X Money in · ${s.state}.`, `${s.seller} wants at least ${s.floor} X Money.`,
           s.buyer ? `Buyer ${s.buyer} has ${s.best_bid} escrowed, bond ${s.buyer_bond}.` : 'No bid yet.',
           `${clock(s.bidding_ends_in, 'bidding ends')}, ${clock(s.deadline_in, 'deadline')}.`];
      if (s.state_code === 4) { // Disputed, on both contracts
        const arb = await arbiter();
        const ruler = s.side === 'out' ? arb.out : arb.in;
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
      const [opened, asked] = await Promise.all([
        parent.getLogs({ address: XSWAP.intents, event: ev(XSWAP_INTENTS_ABI, 'Opened'), args: { user: address }, fromBlock, toBlock: head }).catch(() => []),
        parent.getLogs({ address: XSWAP.asks, event: ev(XSWAP_ASKS_ABI, 'Asked'), args: { seller: address }, fromBlock, toBlock: head }).catch(() => []),
      ]);
      // Change from the bidding, solver payouts and won disputes all sit as credit until they are pulled.
      const [creditOut, creditIn] = await Promise.all([
        readI('credit', [address]).catch(() => 0n), readA('credit', [address]).catch(() => 0n),
      ]);
      const waiting = creditOut + creditIn > 0n
        ? `\n${fmtXMoney(creditOut + creditIn)} X Money is waiting for you in the escrow (change from the bidding, payouts, dispute wins). Pull it with prepare_xswap_action action=withdraw.`
        : '';
      const rows = [...opened.map((l) => ({ l, side: 'out' })), ...asked.map((l) => ({ l, side: 'in' }))]
        .sort((a, b) => Number(b.l.blockNumber - a.l.blockNumber)).slice(0, limit);
      if (!rows.length) return reply(`${address} has no swaps in the last ${lookback_blocks} blocks.${waiting}`, { swaps: [], credit_out: creditOut, credit_in: creditIn });
      const swaps = [];
      for (const r of rows) {
        const s = r.side === 'out' ? await intentOf(r.l.args.id) : await askOf(r.l.args.id);
        if (!s) continue;
        const order = orderFromMemo(r.l.args.memo, s.side === 'out' ? s.want : s.give); // typed fields only, re-hashed
        if (order) s.order = order;
        swaps.push(s);
      }
      const what = (s, h) => (!s.order ? `see ${h} hash` : `${s.order.kind} on chain ${s.order.dstChainId}${s.order.matches_hash ? '' : ' (memo does NOT match the on-chain hash)'}`);
      const line = (s) => (s.side === 'out'
        ? `${s.id.slice(0, 10)}… out · ${s.escrowed} X Money → ${what(s, 'want')} · ${s.state}`
        : `${s.id.slice(0, 10)}… in · ${what(s, 'give')} → ${s.floor}+ X Money · ${s.state}`);
      return reply(`${swaps.length} swap${swaps.length > 1 ? 's' : ''}:\n${swaps.map(line).join('\n')}${waiting}`, { swaps, credit_out: creditOut, credit_in: creditIn });
    },
  },
  {
    name: 'xswap_reputation',
    description: 'What an address has actually done on the escrow: jobs filled and failed, intents opened, disputes raised and lost. Nobody grants this; it is only ever the sum of finished swaps. Read-only.',
    inputSchema: { type: 'object', properties: { address: addr }, required: ['address'], additionalProperties: false },
    async handler({ address }) {
      if (!isAddress(address)) throw new Error(`Not an address: ${address}`);
      const [filled, failed, opened, disputed, disputesLost, volume, since] = await readI('rep', [address]);
      const taken = filled + failed;
      const rep = {
        address, filled: Number(filled), failed: Number(failed), opened: Number(opened),
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
      },
      required: ['action'], additionalProperties: false,
    },
    async handler({ id, action, reason, proof, side, from, ask }) {
      if (GATED_ACTIONS.has(action)) await assertXswapOpen(`prepare_xswap_action ${action}`);
      if (action === 'withdraw') {
        const which = side === 'in' ? XSWAP.asks : XSWAP.intents;
        const abi = side === 'in' ? XSWAP_ASKS_ABI : XSWAP_INTENTS_ABI;
        const p = prepared({
          action: 'Pull everything the escrow owes you', chainId: PARENT_CHAIN_ID, to: which, value: 0n,
          data: encodeFunctionData({ abi, functionName: 'withdraw', args: [] }),
          asset: 'X Money', amount: 'your whole credit balance', irreversible: null,
          notes: ['Credit is what settlements and won disputes have already set aside for you. Pulling it changes nothing else.'],
        });
        return reply(renderApproval(p), { ...p, submit_with: 'submit_xswap' });
      }
      if (!id) throw new Error('Give the swap id.');
      const s = await either(id);
      if (!s) throw new Error(`No swap with id ${id}.`);
      const out = s.side === 'out';
      const to = out ? XSWAP.intents : XSWAP.asks;
      const abi = out ? XSWAP_INTENTS_ABI : XSWAP_ASKS_ABI;
      const [allTerms, arb] = await Promise.all([terms(), arbiter()]);
      const t = allTerms[out ? 'out' : 'in'];
      const ruler = out ? arb.out : arb.in;
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

      const steps = [];
      // A bid is collateral, not a promise: whoever bids has to let the escrow take the bond first.
      if (action === 'bid' || action === 'claim') {
        if (!isAddress(from || '')) throw new Error('Give `from`: the address posting the bond.');
        const bond = out
          ? (await readI('canClaim', [id, from]))[2]
          : (parseXMoney(ask ?? '0') * BigInt((await terms()).in.bond_bps)) / BPS;
        const need = action === 'bid' && !out ? parseXMoney(ask) + bond : bond;
        const allowance = await parent.readContract({ address: XSWAP.xmoney, abi: ERC20_ABI, functionName: 'allowance', args: [from, to] });
        if (allowance < need) {
          steps.push({
            label: `Approve the escrow for ${fmtXMoney(need)} X Money (bond${!out && action === 'bid' ? ' and payment' : ''})`,
            chainId: PARENT_CHAIN_ID, to: XSWAP.xmoney, value: 0n,
            data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [to, need] }),
          });
        }
        spec.note += ` Bond for this one: ${fmtXMoney(bond)} X Money.`;
      }
      steps.push({ label: spec.title, chainId: PARENT_CHAIN_ID, to, value: 0n, data: encodeFunctionData({ abi, functionName: spec.fn, args: spec.args }) });

      const p = prepared({
        action: spec.title, chainId: PARENT_CHAIN_ID,
        asset: 'X Money', amount: out ? `${s.escrowed} escrowed` : `${s.floor} floor`,
        counterparty: out ? s.solver : s.buyer,
        net: null, timeline: [`swap is currently: ${s.state}`], irreversible: spec.irreversible, notes: [spec.note],
        steps,
      });
      return reply(renderApproval(p), { ...p, id, side: s.side, state: s.state, submit_with: 'submit_xswap' });
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
