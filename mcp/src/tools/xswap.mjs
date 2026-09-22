import { encodeAbiParameters, encodeFunctionData, isAddress, keccak256, parseUnits, formatUnits } from 'viem';
import { XSWAP, PARENT_CHAIN_ID, parent, ZERO } from '../config.mjs';
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
    description: 'The escrow\'s own numbers on both directions: bidding time, challenge window, solver bond and protocol fee, read from the contracts.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      const t = await terms();
      const line = (d, t2) => `${d}: bidding ${secs(t2.bidding_s)}, challenge window ${secs(t2.window_s)}, bond ${Number(t2.bond_bps) / 100}% of the escrow, protocol fee ${Number(t2.fee_bps) / 100}% of what the solver charges.`;
      return reply([
        line('X Money out (you pay X Money, an asset lands elsewhere)', t.out),
        line('X Money in (you hand over an asset, X Money lands here)', t.in),
        PERMISSIONLESS,
      ].join('\n'), { ...t, intents: XSWAP.intents, asks: XSWAP.asks, xmoney: XSWAP.xmoney, chain_id: XSWAP.chainId });
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
        amount: { type: 'string', description: 'How much of that asset to deliver.' },
        decimals: { type: 'number', description: 'Decimals of that ERC-20 (required with amount for a token).' },
        amount_base_units: { type: 'string', description: 'Amount in base units, instead of amount + decimals.' },
        token_id: { type: 'string', description: 'For an NFT: the token id to deliver.' },
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
      return reply([
        `Deliver ${o._label} on ${o._chain.slug}${o.to === ZERO ? '' : ` to ${o.to}`}.`,
        `You escrow ${fmtXMoney(amount)} X Money. That is the most it can cost you: solvers bid down from it, and every bit the bidding saves comes back to you when the job settles.`,
        `Protocol fee at most ${fmtXMoney(maxFee)} X Money (${t.fee_bps / 100}% of what the winning solver actually charges, not of your escrow).`,
        `Bidding runs ${secs(t.bidding_s)}; the solver posts ${t.bond_bps / 100}% of the escrow as bond; you have ${secs(t.window_s)} after delivery to dispute.`,
        `If nobody delivers by your deadline, you refund in full.`,
        NOT_A_BRIDGE,
      ].join('\n'), { order: memoOf(o), want_hash: wantHash(o), escrow_wei: amount, max_fee_wei: maxFee, terms: t });
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
        amount: { type: 'string' },
        decimals: { type: 'number' },
        amount_base_units: { type: 'string' },
        token_id: { type: 'string' },
        to: { ...addr, description: 'Who receives it over there.' },
        deadline_minutes: { type: 'number', description: 'Refund is yours after this. Default 60.' },
        id: { ...b32, description: 'Reuse an id you were handed, to re-prepare the same intent.' },
      },
      required: ['from', 'xmoney_amount', 'chain', 'to'],
      additionalProperties: false,
    },
    async handler(args) {
      if (!isAddress(args.from)) throw new Error('`from` must be an address.');
      const o = orderFrom(args);
      const amount = parseXMoney(args.xmoney_amount);
      const mins = Math.max(5, Number(args.deadline_minutes ?? 60));
      const deadline = BigInt(Math.floor(Date.now() / 1000) + mins * 60);
      const id = args.id || freshId(args.from);

      const [bal, allowance, t] = await Promise.all([
        parent.readContract({ address: XSWAP.xmoney, abi: ERC20_ABI, functionName: 'balanceOf', args: [args.from] }),
        parent.readContract({ address: XSWAP.xmoney, abi: ERC20_ABI, functionName: 'allowance', args: [args.from, XSWAP.intents] }),
        terms(),
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
        notes: [PERMISSIONLESS, NOT_A_BRIDGE, 'This connector cannot see the destination chain. Check the asset arrived yourself before confirming.'],
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
        amount: { type: 'string' },
        decimals: { type: 'number' },
        amount_base_units: { type: 'string' },
        token_id: { type: 'string' },
        deadline_minutes: { type: 'number', description: 'Everything unwinds after this. Default 120.' },
        id: b32,
      },
      required: ['from', 'want_xmoney', 'chain'],
      additionalProperties: false,
    },
    async handler(args) {
      if (!isAddress(args.from)) throw new Error('`from` must be an address.');
      const o = orderFrom({ ...args, to: ZERO }, { recipientOptional: true });
      const floor = parseXMoney(args.want_xmoney);
      const mins = Math.max(10, Number(args.deadline_minutes ?? 120));
      const deadline = BigInt(Math.floor(Date.now() / 1000) + mins * 60);
      const id = args.id || freshId(args.from);
      const t = (await terms()).in;

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
      const head = await parent.getBlockNumber();
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
        try { s.order = JSON.parse(r.l.args.memo); } catch { /* memo is free text; the hash is the truth */ }
        swaps.push(s);
      }
      const line = (s) => (s.side === 'out'
        ? `${s.id.slice(0, 10)}… out · ${s.escrowed} X Money → ${s.order ? `${s.order.kind} on chain ${s.order.dstChainId}` : 'see want hash'} · ${s.state}`
        : `${s.id.slice(0, 10)}… in · ${s.order ? `${s.order.kind} on chain ${s.order.dstChainId}` : 'see give hash'} → ${s.floor}+ X Money · ${s.state}`);
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
    description: 'The rest of a swap\'s life as unsigned transactions: bid on it as a solver, claim a delivery, accept the best bid, confirm, dispute inside the window, refund a dead intent, cancel an ask, mark an ask delivered, settle, or pull your credit. Anyone can solve; the bond is the permission. Signs nothing.',
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
      const t = (await terms())[out ? 'out' : 'in'];

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
          note: `Must be inside the ${secs(t.window_s)} window. The arbiter can only ever move this one swap's money.`,
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
      const res = Array.isArray(signed_txs) && signed_txs.length
        ? await submitBatch({ chainId, signedTxs: signed_txs, idempotencyKey: idempotency_key, kind })
        : await submitRaw({ chainId, signedTx: signed_tx, idempotencyKey: idempotency_key, kind });
      const hashes = res.hashes || [res.hash];
      return reply(`${res.replayed ? 'Already sent (idempotency key replayed)' : `Sent ${hashes.length} transaction${hashes.length > 1 ? 's' : ''}`}: ${hashes.join(', ')}. Follow it with xswap_status once it lands.`, res);
    },
  },
];
