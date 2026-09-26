import { isAddress } from 'viem';
import { L3, L4, XGAS_API, parent, xgas } from '../config.mjs';
import { ESCROW_ABI, VAULT_ABI } from '../abis.mjs';
import { expectedCents, fmtUsdg, fmtXMoney, parseUsdg, parseXMoney, usd } from '../money.mjs';
import { reply } from '../approval.mjs';
import { enterMath, exitMath } from './bridge.mjs';
import { order, trade, tradeSplit } from './otc.mjs';
import { createRamp, getRamp, listRamps, updateRamp } from '../ramps-store.mjs';

const addr = { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' };

/** Every path the teller may quote, with the trust it asks for spelled out. */
const TRUST = {
  vault: 'The XMoney vault itself: USDG sits in it, redeemable at NAV. No third party.',
  otc: 'Your counterparty, identified only by an X handle. The $xMoney leg is escrowed on chain; the fiat leg is not, and only the seller can release.',
  rollup: 'The Orbit rollup: withdrawals wait for an assertion to be confirmed on the parent chain by our validator.',
  warp: 'A Hyperlane warp route and its ISM/relayer set. Not deployed — so this connector will not quote it.',
  paxos: 'Paxos, for redeeming USDG to dollars, under their KYC.',
};

async function liveAsks(sizeWei) {
  const next = await xgas.readContract({ address: L4.escrow, abi: ESCROW_ABI, functionName: 'nextOrderId' });
  if (next === 0n) return [];
  const all = await Promise.all(Array.from({ length: Number(next) }, (_, i) => order(i).catch(() => null)));
  // Overlap, not containment: an order that can fill part of what you asked for is a
  // better answer than "no liquidity". The caller clamps the size and says it clamped.
  return all.filter((o) => o && o.active && o.side === 'ask' && sizeWei >= o.min_wei && o.available_wei >= o.min_wei)
    .sort((a, b) => a.price_usd - b.price_usd);
}

async function liveBids(sizeWei) {
  const next = await xgas.readContract({ address: L4.escrow, abi: ESCROW_ABI, functionName: 'nextOrderId' });
  if (next === 0n) return [];
  const all = await Promise.all(Array.from({ length: Number(next) }, (_, i) => order(i).catch(() => null)));
  return all.filter((o) => o && o.active && o.side === 'bid' && sizeWei >= o.min_wei && o.available_wei >= o.min_wei)
    .sort((a, b) => b.price_usd - a.price_usd);
}

async function quoteIn({ source, amount }) {
  const paths = [];

  if (source === 'usdg_robinhood') {
    const m = await enterMath(parseUsdg(amount));
    paths.push({
      path_id: 'in:usdg_enter',
      title: 'USDG on the parent chain → $xMoney on xGas',
      steps: ['approve USDG to the vault (if allowance is short)', 'enterRollup — one transaction does the rake, the burn and the bridge'],
      you_pay: `${fmtUsdg(m.usdgWei)} USDG`,
      net: `${fmtXMoney(m.net)} $xMoney as native gas`,
      fees: [`${fmtUsdg(m.usdgRake)} USDG to the Fanout (0.01%)`, `${fmtXMoney(m.entryBurn)} xMoney entry burn (0.01%)`],
      timing: '~1 minute',
      trust: TRUST.vault,
      tools: ['quote_enter', 'prepare_enter', 'submit_enter', 'get_enter_status'],
      rank_note: 'Fewest steps, least trust. If you already hold USDG this is the answer.',
    });
  }

  if (source === 'fiat_usd') {
    // The user asked in dollars, so solve for the size whose *fiat due* is what they
    // asked for. Sizing in xMoney instead and letting the fiat fall out of the escrow's
    // floored cent arithmetic quotes them a different number than the one they said.
    const wantCents = BigInt(Math.round(Number(String(amount).replace(/[$,]/g, '')) * 100));
    if (wantCents <= 0n) return [{ path_id: 'in:otc', unavailable: `"${amount}" is not a dollar amount.`, title: 'Dollars on X Money → $xMoney' }];
    // Price the book against a NAV-implied size first, only to find asks in range.
    const [, usdgReserve, circulating] = await parent.readContract({ address: L3.xMoney, abi: VAULT_ABI, functionName: 'getReserveNAV' });
    const nav = circulating === 0n ? 1 : Number(usdgReserve) * 1e12 / Number(circulating);
    const approxXMoney = Number(String(amount).replace(/[$,]/g, '')) / (nav || 1);
    const asks = await liveAsks(parseXMoney(approxXMoney.toFixed(18)));
    if (asks.length) {
      const best = asks[0];
      // ceil, so the buyer never ends up owing less than the dollars they asked to spend
      const rate = BigInt(best.fiat_rate_bps);
      const exact = (wantCents * 10n ** 18n * 100n + rate - 1n) / rate;
      const ceiling = best.max_wei < best.available_wei ? best.max_wei : best.available_wei;
      const sizeWei = exact > ceiling ? ceiling : exact < best.min_wei ? best.min_wei : exact;
      const cents = expectedCents(sizeWei, rate);
      const split = tradeSplit(sizeWei);
      const clamped = sizeWei !== exact
        ? `This order fills ${best.min}–${best.max} per trade with ${best.available_xmoney} available, so your $${(Number(wantCents) / 100).toFixed(2)} does not go in one trade. The numbers below are for one trade at the clamped size; repeat it, or take another order, for the rest.`
        : null;
      paths.push({
        path_id: 'in:otc',
        title: 'Dollars on X Money → $xMoney, peer to peer',
        steps: [`take_ask on order #${best.order_id} from @${best.maker_x_handle}`, `send ${usd(cents)} on X Money to @${best.maker_x_handle}`, 'they release; $xMoney lands'],
        you_pay: usd(cents),
        you_asked_to_spend: `$${(Number(wantCents) / 100).toFixed(2)}`,
        clamped_because: clamped,
        net: `${fmtXMoney(split.net)} $xMoney`,
        fees: [`${fmtXMoney(split.burn)} burned`, `${fmtXMoney(split.rake)} to the FanoutSink`, `${fmtXMoney(split.buyback)} to buy and burn XGAS.DEV`],
        timing: 'minutes, if the seller releases promptly',
        trust: TRUST.otc,
        tools: ['quote_trade', 'take_ask', 'submit_otc', 'get_trade'],
        rank_note: 'The only path that starts from actual dollars. Its cost is counterparty risk, not fees.',
        best_order: best,
      });
    } else {
      paths.push({
        path_id: 'in:otc_no_liquidity',
        title: 'Dollars on X Money → $xMoney, peer to peer',
        unavailable: `No live sell asks can fill about ${approxXMoney.toFixed(4)} $xMoney right now.`,
        recourse: 'Post your own bid with post_bid and wait for a seller, or come in through USDG instead.',
        trust: TRUST.otc,
        tools: ['post_bid', 'list_orders'],
      });
    }
  }

  if (typeof source === 'string' && source.startsWith('crypto:')) {
    paths.push({
      path_id: 'in:warp',
      title: `${source} → warp → USDG → enter`,
      unavailable: 'The Hyperlane warp route is not deployed. There is no contract to quote, so this connector will not invent a number for it.',
      would_require: TRUST.warp,
      recourse: 'Bring USDG to the parent chain yourself and use in:usdg_enter, or buy $xMoney peer to peer with dollars.',
    });
  }

  return paths;
}

async function quoteOut({ source, amount }) {
  const paths = [];

  if (source === 'xmoney_xgas') {
    const xWei = parseXMoney(amount);
    const bids = await liveBids(xWei);
    if (bids.length) {
      const best = bids[0];
      const cents = expectedCents(xWei, BigInt(best.fiat_rate_bps));
      paths.push({
        path_id: 'out:otc_take_bid',
        title: '$xMoney → dollars on X Money, by filling a live bid',
        steps: [`take_bid on order #${best.order_id} from @${best.maker_x_handle} (escrows your $xMoney)`, `wait for ${usd(cents)} on X Money`, 'release_trade once you see it'],
        you_send: `${fmtXMoney(xWei)} $xMoney`,
        net: `${usd(cents)} in dollars`,
        fees: ['0.04% of the size, taken from what the buyer receives'],
        timing: 'minutes',
        trust: TRUST.otc,
        tools: ['quote_trade', 'take_bid', 'submit_otc', 'release_trade', 'reclaim_timeout'],
        rank_note: 'Fastest route to actual dollars, and the only one that does not wait on the rollup.',
        best_order: best,
      });
    } else {
      paths.push({
        path_id: 'out:otc_post_ask',
        title: '$xMoney → dollars on X Money, by posting your own ask',
        steps: ['post_ask (escrows your $xMoney)', 'a buyer fills and pays you on X Money', 'release_trade once you see it — or reclaim after 15 minutes'],
        you_send: `${fmtXMoney(xWei)} $xMoney`,
        net: 'whatever price you set, minus 0.04%',
        timing: 'however long it takes someone to take your price',
        trust: TRUST.otc,
        tools: ['post_ask', 'submit_otc', 'get_trade', 'release_trade'],
        rank_note: 'No live bid can fill this size, so taking is not on the table — making is.',
        no_live_bids: true,
      });
    }

    const m = await exitMath(xWei);
    paths.push({
      path_id: 'out:exit_redeem',
      title: '$xMoney → USDG on the parent chain (then dollars off chain)',
      steps: ['prepare_exit — ArbSys burns your $xMoney on xGas', 'wait for an assertion to confirm on the parent', 'claim_exit — the host executes the Outbox for you', 'prepare_redeem — exitRollup pays USDG', 'off chain: redeem USDG with Paxos, or sell it somewhere that buys it'],
      you_send: `${fmtXMoney(xWei)} $xMoney`,
      net: `${fmtUsdg(m.usdgOut)} USDG — not dollars in a bank`,
      fees: [`${fmtXMoney(m.bridgeExitBurn)} xMoney burned leaving the bridge (0.01%)`, `${fmtUsdg(m.usdgRake)} USDG rake (0.01%)`],
      timing: 'dominated by the assertion window on the parent chain, not by us',
      trust: `${TRUST.rollup} Then, for dollars: ${TRUST.paxos}`,
      tools: ['quote_exit', 'prepare_exit', 'submit_exit', 'get_exit_status', 'claim_exit', 'prepare_redeem'],
      rank_note: 'Trustless on the crypto leg, slow, and it ends in USDG. The last mile to dollars is off chain and is not something this connector can do for you.',
    });
  }

  if (source === 'usdg_robinhood') {
    paths.push({
      path_id: 'out:usdg_elsewhere',
      title: 'USDG → dollars or stables elsewhere',
      unavailable: 'This leg is entirely off chain or on venues this connector does not talk to.',
      instructions: ['Redeem USDG 1:1 with Paxos under their KYC (Global Dollar redemption), or', 'sell USDG on a venue that lists it, or bridge it out with a canonical bridge or aggregator.'],
      trust: TRUST.paxos,
      recourse: 'The connector can tell you your USDG balance (get_balance) and nothing more about this leg.',
    });
  }

  return paths;
}

export const tools = [
  {
    name: 'ramp_quote',
    description: 'The teller window. Say which way you are going and what you are holding; get ranked routes with exact numbers, every fee, real timing, and the trust each one asks for. Paths that cannot be priced honestly come back as unavailable, with the recourse. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['in', 'out'], description: 'in = towards $xMoney; out = towards fiat.' },
        source: { type: 'string', description: 'What you are holding: fiat_usd, usdg_robinhood, xmoney_xgas, or crypto:{chain}:{token}.' },
        amount: { type: 'string', description: 'Size, in the unit of `source` (dollars for fiat_usd, USDG, or $xMoney).' },
      },
      required: ['direction', 'source', 'amount'],
      additionalProperties: false,
    },
    async handler({ direction, source, amount }) {
      const paths = direction === 'in' ? await quoteIn({ source, amount }) : await quoteOut({ source, amount });
      if (!paths.length) {
        return reply(
          `No route from "${source}" going ${direction}. Sources this teller knows: fiat_usd, usdg_robinhood, xmoney_xgas, crypto:{chain}:{token}.`,
          { direction, source, amount, paths: [] },
        );
      }
      const live = paths.filter((p) => !p.unavailable);
      const dead = paths.filter((p) => p.unavailable);
      const lines = [];
      live.forEach((p, i) => {
        lines.push(`${i + 1}. ${p.title}  [${p.path_id}]`);
        lines.push(`   You end up with: ${p.net}`);
        if (p.you_pay || p.you_send) lines.push(`   You put in: ${p.you_pay || p.you_send}`);
        if (p.fees?.length) lines.push(`   Fees: ${p.fees.join(', ')}`);
        lines.push(`   Timing: ${p.timing}`);
        lines.push(`   Trust: ${p.trust}`);
        if (p.rank_note) lines.push(`   ${p.rank_note}`);
      });
      for (const p of dead) {
        lines.push(`— ${p.title}  [${p.path_id}]: ${p.unavailable}`);
        if (p.recourse) lines.push(`   Recourse: ${p.recourse}`);
      }
      return reply(lines.join('\n'), { direction, source, amount, paths });
    },
  },

  {
    name: 'ramp_start',
    description: 'Begin a route from ramp_quote. Returns a ramp_id and the first action — an unsigned transaction to sign, or the off-chain instruction for a fiat leg. The connector never marks a fiat leg done on its own say-so.',
    inputSchema: {
      type: 'object',
      properties: {
        path_id: { type: 'string', description: 'A path_id from ramp_quote, e.g. in:usdg_enter, in:otc, out:otc_take_bid, out:exit_redeem.' },
        amount: { type: 'string' },
        address: { ...addr, description: 'The address that will sign.' },
        x_handle: { type: 'string', description: 'Your X handle, for any path with a fiat leg.' },
        order_id: { type: 'integer', description: 'For OTC paths: the order to take, if you already picked one.' },
      },
      required: ['path_id', 'amount', 'address'],
      additionalProperties: false,
    },
    async handler({ path_id, amount, address, x_handle, order_id }) {
      if (!isAddress(address)) throw new Error(`Not an address: ${address}`);
      const PATHS = {
        'in:usdg_enter': {
          steps: [
            { id: 'sign_enter', kind: 'onchain', instruction: 'Call prepare_enter, sign both transactions, then submit_enter.', tools: ['prepare_enter', 'submit_enter'] },
            { id: 'landing', kind: 'onchain', instruction: 'Watch it land with get_enter_status.', tools: ['get_enter_status'] },
          ],
        },
        'in:otc': {
          steps: [
            { id: 'take_ask', kind: 'onchain', instruction: 'Call take_ask for the order you picked, sign, then submit_otc. This starts a 15-minute clock.', tools: ['take_ask', 'submit_otc'] },
            { id: 'fiat_pending', kind: 'fiat', instruction: 'Send the exact dollar amount to the seller\'s X handle on X Money. This is an instruction, not a transaction — nothing on chain records it.' },
            { id: 'awaiting_release', kind: 'onchain', instruction: 'The seller verifies and calls releaseTrade. Watch with get_trade.', tools: ['get_trade'] },
          ],
        },
        'out:otc_take_bid': {
          steps: [
            { id: 'take_bid', kind: 'onchain', instruction: 'Call take_bid, sign, then submit_otc. Your $xMoney escrows immediately.', tools: ['take_bid', 'submit_otc'] },
            { id: 'fiat_pending', kind: 'fiat', instruction: 'Wait for the buyer\'s dollars on X Money. Do not release until you have personally seen them.' },
            { id: 'release', kind: 'onchain', instruction: 'Call release_trade once the money is in your account — or reclaim_timeout after 15 minutes if it never comes.', tools: ['release_trade', 'reclaim_timeout'] },
          ],
        },
        'out:otc_post_ask': {
          steps: [
            { id: 'post_ask', kind: 'onchain', instruction: 'Call post_ask, sign, then submit_otc.', tools: ['post_ask', 'submit_otc'] },
            { id: 'awaiting_fill', kind: 'onchain', instruction: 'Wait for a buyer. list_orders shows your order; get_trade shows any fill.', tools: ['list_orders', 'get_trade'] },
            { id: 'fiat_pending', kind: 'fiat', instruction: 'Wait for the buyer\'s dollars on X Money.' },
            { id: 'release', kind: 'onchain', instruction: 'release_trade once you see the money.', tools: ['release_trade', 'reclaim_timeout'] },
          ],
        },
        'out:exit_redeem': {
          steps: [
            { id: 'burn_on_xgas', kind: 'onchain', instruction: 'prepare_exit, sign, submit_exit.', tools: ['prepare_exit', 'submit_exit'] },
            { id: 'awaiting_assertion', kind: 'onchain', instruction: 'Wait for an assertion covering your withdrawal to confirm on the parent chain. get_exit_status reports pending → claimable.', tools: ['get_exit_status'] },
            { id: 'claim', kind: 'onchain', instruction: 'claim_exit — the host executes the Outbox so you need no parent gas.', tools: ['claim_exit'] },
            { id: 'redeem', kind: 'onchain', instruction: 'prepare_redeem, sign, submit_redeem. USDG lands in the same transaction.', tools: ['prepare_redeem', 'submit_redeem'] },
            { id: 'offchain_usdg', kind: 'fiat', instruction: 'USDG is not dollars. Redeem it with Paxos under their KYC, or sell it on a venue that buys it. This connector does not touch that leg.' },
          ],
        },
      };
      const def = PATHS[path_id];
      if (!def) {
        return reply(
          `"${path_id}" is not a startable path. Startable: ${Object.keys(PATHS).join(', ')}. Paths marked unavailable by ramp_quote stay unavailable — there is nothing to start.`,
          { blocked: 'unknown_path', startable: Object.keys(PATHS) },
        );
      }
      const steps = def.steps.map((s, i) => ({ ...s, state: i === 0 ? 'current' : 'todo' }));
      const r = createRamp(path_id, { amount, address, x_handle: x_handle ? String(x_handle).replace(/^@/, '') : null, order_id: order_id ?? null }, steps);
      const first = steps[0];
      return reply(
        `${r.ramp_id} started on ${path_id}.\nStep 1 of ${steps.length} — ${first.id}: ${first.instruction}\nCheck in any time with ramp_status.`,
        r,
      );
    },
  },

  {
    name: 'ramp_status',
    description: 'Where a ramp stands, re-read from chain state rather than from memory. Fiat legs sit in *_pending with the instruction repeated verbatim; the connector never marks one done itself.',
    inputSchema: {
      type: 'object',
      properties: {
        ramp_id: { type: 'string', description: 'Omit to list every ramp.' },
        trade_id: { type: 'integer', description: 'Attach an OTC trade to this ramp so its status can be read from the escrow.' },
        tx_hash: { type: 'string', description: 'Attach a transaction hash to this ramp.' },
      },
      additionalProperties: false,
    },
    async handler({ ramp_id, trade_id, tx_hash }) {
      if (!ramp_id) {
        const all = listRamps();
        if (!all.length) return reply('No ramps started yet.', { ramps: [] });
        return reply(all.map((r) => `  ${r.ramp_id} — ${r.path_id}, at ${r.state}`).join('\n'), { ramps: all });
      }
      let r = getRamp(ramp_id);
      if (!r) return reply(`No ramp ${ramp_id}.`, { ramp_id, exists: false });
      if (trade_id !== undefined) r = updateRamp(ramp_id, { params: { ...r.params, trade_id } });
      if (tx_hash) r = updateRamp(ramp_id, { params: { ...r.params, tx_hash } });

      const observed = {};
      if (r.params.trade_id !== undefined && r.params.trade_id !== null) {
        const t = await trade(r.params.trade_id).catch(() => null);
        observed.trade = t;
      }
      if (r.path_id === 'out:exit_redeem') {
        try {
          const res = await fetch(`${XGAS_API}/api/withdrawals/${r.params.address}`, { signal: AbortSignal.timeout(15_000) });
          observed.withdrawals = res.ok ? (await res.json()).withdrawals : null;
        } catch { observed.withdrawals = 'tracker unreachable'; }
      }

      const current = r.steps.find((s) => s.state === 'current') || r.steps[r.steps.length - 1];
      const lines = r.steps.map((s) => `  [${s.state === 'current' ? '>' : s.state === 'done' ? 'x' : ' '}] ${s.id}${s.kind === 'fiat' ? ' (off chain)' : ''}: ${s.instruction}`);
      const note = current.kind === 'fiat'
        ? 'This step is off chain. The connector cannot see it and will not mark it done — advance it yourself once the money has actually moved.'
        : 'Advance by doing the step and calling ramp_status again with the trade_id or tx_hash so it can be read from chain.';
      return reply(`${r.ramp_id} — ${r.path_id}\n${lines.join('\n')}\n\n${note}`, { ...r, observed });
    },
  },
];
