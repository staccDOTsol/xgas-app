import { encodeFunctionData, isAddress } from 'viem';
import { L4, XGAS_CHAIN_ID, xgas, nguLauncher, ZERO, BUYBACK_BPS } from '../config.mjs';
import { NGU_TOKEN_ABI, NGU_LAUNCHER_ABI, NGU_LIMITS } from '../abis.mjs';
import { fmtXMoney, parseXMoney } from '../money.mjs';
import { trueMaxLoss, pct, contractSkew } from '../nguRisk.mjs';
import { prepared, renderApproval, reply, submitFields } from '../approval.mjs';
import { submitRaw } from '../idempotency.mjs';
import { untrusted } from '../untrusted.mjs';

const addr = { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' };
const BPS = 10000n;

const NO_LAUNCHER = [
  `NguLauncher is not deployed on xGas ${XGAS_CHAIN_ID} yet, and \`l4.nguLauncher\` in src/contracts/l4-deployment.json is null.`,
  'Nothing here is broken; there is simply no factory to read. Deploy it and set the address (the host serves it at /api/l4-info) and this tool lights up on its own.',
].join(' ');

const read = (token, fn, args = []) => xgas.readContract({ address: token, abi: NGU_TOKEN_ABI, functionName: fn, args });

// Curves launched before the XGAS.DEV buyback have no BUYBACK_BPS(), and the first launcher has no buybackSink():
// the call reverts, and the buyback is 0. Any other failure (RPC down) is a real error and propagates.
const zeroIfReverted = (e) => {
  if (e?.walk?.((x) => x.name === 'ContractFunctionRevertedError' || x.name === 'ContractFunctionZeroDataError')) return 0;
  throw e;
};
const buybackBpsOf = (token) => read(token, 'BUYBACK_BPS').then(Number, zeroIfReverted);
// The live worst case, plus the contract's own figure when it disagrees (either direction).
const riskText = (s) => `${s.max_loss_pct}${s.contract_note ? `, ${s.contract_note}` : ''}`;
const feeText = (buybackBps) => `0.01% burn + 0.01% FanoutSink${buybackBps ? ` + ${(buybackBps / 100).toFixed(2)}% XGAS.DEV buy & burn` : ''}`;

async function tokenState(token, who) {
  const fns = ['name', 'symbol', 'floor', 'nextPrice', 'lastPrice', 'basePrice', 'reserve', 'supply', 'minted', 'maxSupply', 'maxLossBps', 'betaBps', 'stepBps', 'seedQty'];
  const [vals, buybackBps] = await Promise.all([Promise.all(fns.map((f) => read(token, f))), buybackBpsOf(token)]);
  const s = Object.fromEntries(fns.map((f, i) => [f, vals[i]]));
  const balance = who && isAddress(who) ? await read(token, 'balanceOf', [who]) : null;
  // The headline risk is computed from live state; the contract's maxLossBps() understates it on deployed curves.
  const risk = trueMaxLoss({ nextPrice: s.nextPrice, reserve: s.reserve, supply: s.supply, buybackBps });
  const lossBps = risk ? risk.lossBps : Number(s.maxLossBps);
  const skew = contractSkew(lossBps, s.maxLossBps);
  return {
    token,
    // Whoever launched the curve chose these. They reach a model, so they arrive wrapped as third-party text.
    name: untrusted(s.name, 64),
    symbol: untrusted(s.symbol, 24),
    max_loss_bps: lossBps,
    max_loss_pct: pct(lossBps),
    max_loss_basis: 'live: buy 1 at nextPrice, sell it straight back at min(floor after the buy, that price), fees on both legs',
    contract_max_loss_bps: Number(s.maxLossBps),
    contract_max_loss_pct: pct(Number(s.maxLossBps)),
    contract_skew: skew,
    contract_note: skew ? `contract reports ${pct(Number(s.maxLossBps))} (${skew})` : null,
    sell_back_proceeds_xmoney: risk ? fmtXMoney(risk.proceeds) : null,
    floor_xmoney: fmtXMoney(s.floor),
    next_price_xmoney: fmtXMoney(s.nextPrice),
    last_price_xmoney: fmtXMoney(s.lastPrice),
    base_price_xmoney: fmtXMoney(s.basePrice),
    reserve_xmoney: fmtXMoney(s.reserve),
    supply: s.supply.toString(),
    minted: s.minted.toString(),
    max_supply: s.maxSupply.toString(),
    remaining: (s.maxSupply - s.minted).toString(),
    sold_out: s.minted >= s.maxSupply,
    beta_bps: Number(s.betaBps),
    step_bps: Number(s.stepBps),
    seed_qty: s.seedQty.toString(),
    buyback_bps: buybackBps,
    fees_per_trade: `${feeText(buybackBps)} on every buy and sell`,
    your_balance_tokens: balance === null ? null : (balance / 10n ** 18n).toString(),
    raw: { floor: s.floor, nextPrice: s.nextPrice, maxSupply: s.maxSupply, minted: s.minted, supply: s.supply },
  };
}

function wholeTokens(qty) {
  const n = Number(qty);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`The curve mints whole tokens only; ${qty} is not a positive whole number. Fractions trade on secondary markets, not here.`);
  if (n > NGU_LIMITS.MAX_PER_TX) throw new Error(`The contract caps ${NGU_LIMITS.MAX_PER_TX} tokens per transaction; ${n} would revert. Split it across transactions.`);
  return BigInt(n);
}

export const tools = [
  {
    name: 'list_ngu_tokens',
    description: 'Every NGU curve launched on xGas (the current launcher\'s newest first, then the legacy launcher\'s), each with its worst-case loss, fees, floor, next price and remaining supply. Read-only.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 20.' } }, additionalProperties: false },
    async handler({ limit = 20 }) {
      const launcher = await nguLauncher();
      if (!launcher) return reply(NO_LAUNCHER, { launcher: null, tokens: [] });
      // The first launcher's curves (0.01% + 0.01%, no XGAS.DEV buyback) still trade; list them after the current one's.
      // Launching only ever goes through the current launcher.
      const legacy = L4.legacy2bp?.nguLauncher && L4.legacy2bp.nguLauncher !== ZERO ? L4.legacy2bp.nguLauncher : null;
      const addrs = [];
      for (const la of [launcher, legacy]) {
        if (!la || addrs.length >= limit) continue;
        const n = await xgas.readContract({ address: la, abi: NGU_LAUNCHER_ABI, functionName: 'allTokensLength' });
        const idx = Array.from({ length: Number(n) }, (_, i) => Number(n) - 1 - i).slice(0, limit - addrs.length);
        const found = await Promise.all(idx.map((i) => xgas.readContract({ address: la, abi: NGU_LAUNCHER_ABI, functionName: 'allTokens', args: [BigInt(i)] })));
        for (const a of found) if (!addrs.some((x) => x.toLowerCase() === a.toLowerCase())) addrs.push(a);
      }
      if (!addrs.length) return reply('The launcher is live but nothing has been launched on it yet.', { launcher, legacy_launcher: legacy, tokens: [] });
      const tokens = await Promise.all(addrs.map((a) => tokenState(a).catch((e) => ({ token: a, error: e.shortMessage || e.message }))));
      const lines = tokens.map((t) => t.error
        ? `  ${t.token}: unreadable (${t.error})`
        : `  ${t.symbol} ${t.token}: worst case if you buy and sell straight back ${riskText(t)}; next ${t.next_price_xmoney}, floor ${t.floor_xmoney}, ${t.remaining}/${t.max_supply} left; fees ${t.buyback_bps ? `${((2 + t.buyback_bps) / 100).toFixed(2)}%` : '0.02% (pre-buyback curve)'}`);
      return reply(`${tokens.length} curve(s) on the launcher${legacy ? 's' : ''}:\n${lines.join('\n')}`, { launcher, legacy_launcher: legacy, tokens });
    },
  },

  {
    name: 'get_ngu_token',
    description: 'Full state of one NGU curve: worst-case loss first, then floor, prices, reserve, supply and your balance. Works on any NguToken address. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { token_address: addr, holder: { ...addr, description: 'Optional: report this address\'s balance too.' } },
      required: ['token_address'],
      additionalProperties: false,
    },
    async handler({ token_address, holder }) {
      if (!isAddress(token_address)) throw new Error(`Not an address: ${token_address}`);
      const code = await xgas.getCode({ address: token_address });
      if (!code || code === '0x') return reply(`Nothing is deployed at ${token_address} on xGas ${XGAS_CHAIN_ID}.`, { token: token_address, exists: false });
      const s = await tokenState(token_address, holder);
      return reply(
        `${s.name} (${s.symbol}). Worst case if you buy then sell straight back: ${riskText(s)}.\n` +
        `Next price ${s.next_price_xmoney} $xMoney, redemption floor ${s.floor_xmoney}, reserve ${s.reserve_xmoney}.\n` +
        `${s.minted}/${s.max_supply} minted${s.sold_out ? ', SOLD OUT' : `, ${s.remaining} left`}. β=${s.beta_bps}bps, step=${s.step_bps}bps. Fees: ${s.fees_per_trade}.`,
        s,
      );
    },
  },

  {
    name: 'quote_ngu_buy',
    description: 'Cost to mint whole tokens on an NGU curve. Leads with the worst case for buying and selling straight back, computed from live state (the contract\'s own maxLossBps understates it). Read-only.',
    inputSchema: {
      type: 'object',
      properties: { token_address: addr, qty: { type: 'integer', minimum: 1, maximum: 50, description: 'Whole tokens. The contract caps 50 per transaction.' } },
      required: ['token_address', 'qty'],
      additionalProperties: false,
    },
    async handler({ token_address, qty }) {
      if (!isAddress(token_address)) throw new Error(`Not an address: ${token_address}`);
      const q = wholeTokens(qty);
      const s = await tokenState(token_address);
      if (s.sold_out) return reply(`${s.symbol} is sold out: ${s.minted}/${s.max_supply} minted. There is no primary left to buy. Watching for sells on the curve is the only way in.`, { ...s, quote: null });
      if (BigInt(s.remaining) < q) return reply(`Only ${s.remaining} ${s.symbol} remain on the curve; ${qty} would revert with SoldOut.`, { ...s, quote: null });
      const cost = await read(token_address, 'quoteBuy', [q]);
      const burn = (cost * 1n) / BPS;
      const fanout = (cost * 1n) / BPS;
      const buyback = (cost * BigInt(s.buyback_bps)) / BPS;
      const data = {
        worst_case_if_you_sell_straight_back: s.max_loss_pct,
        max_loss_bps: s.max_loss_bps,
        contract_max_loss_bps: s.contract_max_loss_bps,
        contract_note: s.contract_note,
        token: token_address, symbol: s.symbol, qty,
        cost_xmoney: fmtXMoney(cost), cost_wei: cost,
        avg_per_token: fmtXMoney(cost / q),
        fees: {
          burn: fmtXMoney(burn), fanout_sink: fmtXMoney(fanout),
          ...(s.buyback_bps && { xgas_dev_buyback: fmtXMoney(buyback) }),
          note: `${feeText(s.buyback_bps)} of the price; the rest backs the floor`,
        },
        floor_after_context: `Redemption floor right now is ${s.floor_xmoney} $xMoney per token`,
        why: `Fees are only ${2 + s.buyback_bps}bps of the ${s.max_loss_pct}. The rest is the gap between the next price (${s.next_price_xmoney}) and what one token redeems for straight after (${s.sell_back_proceeds_xmoney})` +
          (s.contract_skew === 'understated'
            ? `: the step has carried the price above floor/β, so the β=${s.beta_bps}bps bound behind maxLossBps no longer holds.`
            : s.contract_skew === 'overstated'
              ? `: the floor sits closer to the price than β=${s.beta_bps}bps assumes, so maxLossBps overstates the loss.`
              : `, which β=${s.beta_bps}bps bounds by design.`),
      };
      return reply(
        `Worst case if you sell straight back: ${riskText(s)}.\n` +
        `${qty} ${s.symbol} costs ${fmtXMoney(cost)} $xMoney (${fmtXMoney(cost / q)} each). Floor is ${s.floor_xmoney}.\n` +
        `Fees: ${fmtXMoney(burn)} burned, ${fmtXMoney(fanout)} to the FanoutSink${s.buyback_bps ? `, ${fmtXMoney(buyback)} to buy and burn XGAS.DEV` : ''}.`,
        data,
      );
    },
  },

  {
    name: 'prepare_ngu_buy',
    description: 'Prepare an unsigned buy on an NGU curve. Overpayment is refunded by the contract, so the value carries a small buffer against someone buying ahead of you. Signs nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        token_address: addr,
        qty: { type: 'integer', minimum: 1, maximum: 50 },
        to: { ...addr, description: 'Who receives the tokens. Defaults to the signer.' },
        buffer_bps: { type: 'integer', minimum: 0, maximum: 2000, description: 'Extra value above the quote, refunded if unused. Default 100 (1%).' },
      },
      required: ['token_address', 'qty'],
      additionalProperties: false,
    },
    async handler({ token_address, qty, to, buffer_bps = 100 }) {
      if (!isAddress(token_address)) throw new Error(`Not an address: ${token_address}`);
      const q = wholeTokens(qty);
      const s = await tokenState(token_address);
      if (s.sold_out) return reply(`${s.symbol} is sold out. Nothing prepared.`, { ...s, blocked: 'sold_out' });
      const cost = await read(token_address, 'quoteBuy', [q]);
      const value = cost + (cost * BigInt(buffer_bps)) / BPS;
      const p = prepared({
        action: `Buy ${qty} ${s.symbol} on the NGU curve`,
        chainId: XGAS_CHAIN_ID,
        to: token_address,
        data: encodeFunctionData({ abi: NGU_TOKEN_ABI, functionName: 'buy', args: [q, to && isAddress(to) ? to : ZERO] }),
        value,
        asset: `native $xMoney → ${s.symbol} (${token_address})`,
        amount: `${qty} whole ${s.symbol} for ${fmtXMoney(cost)} $xMoney`,
        counterparty: `the curve itself: ${s.name} at ${token_address}`,
        fees: [
          { label: 'Burn', amount: `${fmtXMoney((cost * 1n) / BPS)} xMoney`, note: '0.01% to 0x…dEaD' },
          { label: 'FanoutSink', amount: `${fmtXMoney((cost * 1n) / BPS)} xMoney`, note: '0.01%' },
          ...(s.buyback_bps ? [{ label: 'XGAS.DEV buy & burn', amount: `${fmtXMoney((cost * BigInt(s.buyback_bps)) / BPS)} xMoney`, note: '0.02%, bridged to Robinhood to buy and burn XGAS.DEV' }] : []),
        ],
        net: `${qty} ${s.symbol}, redeemable right now at ${s.floor_xmoney} $xMoney each`,
        timeline: ['One transaction on xGas'],
        irreversible: `Worst case if you sell straight back: ${riskText(s)}. That gap is the distance from the price you pay down to the floor, not the fee. The floor is protected (sells and buys revert rather than let it drop), but nothing protects the price you paid.`,
        notes: [
          `Value carries a ${buffer_bps}bps buffer (${fmtXMoney(value - cost)} xMoney) because the price steps up if someone buys ahead of you. The contract refunds whatever it does not use.`,
          'Whole tokens only on the primary curve.',
        ],
      });
      return reply(renderApproval(p), { ...p, quote: { cost_xmoney: fmtXMoney(cost), value_sent: fmtXMoney(value), max_loss_pct: s.max_loss_pct } });
    },
  },

  {
    name: 'quote_ngu_sell',
    description: 'Payout for burning whole tokens back to an NGU curve, with the sell basis shown: floor, or lastPrice when the cap binds. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { token_address: addr, qty: { type: 'integer', minimum: 1, maximum: 50 } },
      required: ['token_address', 'qty'],
      additionalProperties: false,
    },
    async handler({ token_address, qty }) {
      if (!isAddress(token_address)) throw new Error(`Not an address: ${token_address}`);
      const q = wholeTokens(qty);
      const s = await tokenState(token_address);
      const payout = await read(token_address, 'quoteSell', [q]);
      const lastPrice = await read(token_address, 'lastPrice');
      const basis = BigInt(s.raw.floor) > lastPrice ? 'lastPrice (the cap binds: donations have lifted the floor above the last paid price)' : 'floor';
      const minOut = (payout * 9950n) / BPS;
      return reply(
        `${qty} ${s.symbol} burns back for ${fmtXMoney(payout)} $xMoney (${fmtXMoney(payout / q)} each), priced off ${basis}.\n` +
        `Suggested minOut at 0.5% tolerance: ${fmtXMoney(minOut)}.`,
        {
          token: token_address, symbol: s.symbol, qty,
          payout_xmoney: fmtXMoney(payout), payout_wei: payout,
          sell_basis: basis, floor_xmoney: s.floor_xmoney, last_price_xmoney: fmtXMoney(lastPrice),
          suggested_min_out_xmoney: fmtXMoney(minOut), suggested_min_out_wei: minOut,
          note: 'Selling never moves the curve price; it only draws down the reserve. The contract reverts rather than let the floor drop.',
        },
      );
    },
  },

  {
    name: 'prepare_ngu_sell',
    description: 'Prepare an unsigned sell back to an NGU curve, with an explicit minOut. Signs nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        token_address: addr,
        qty: { type: 'integer', minimum: 1, maximum: 50 },
        to: { ...addr, description: 'Who receives the $xMoney. Defaults to the signer.' },
        min_out: { type: 'string', description: 'Minimum $xMoney to accept. Defaults to the quote minus 0.5%.' },
      },
      required: ['token_address', 'qty'],
      additionalProperties: false,
    },
    async handler({ token_address, qty, to, min_out }) {
      if (!isAddress(token_address)) throw new Error(`Not an address: ${token_address}`);
      const q = wholeTokens(qty);
      const s = await tokenState(token_address);
      const payout = await read(token_address, 'quoteSell', [q]);
      const minOut = min_out !== undefined ? parseXMoney(min_out) : (payout * 9950n) / BPS;
      const tolerance = payout === 0n ? '0%' : `${(Number((payout - minOut) * 10000n / payout) / 100).toFixed(2)}%`;
      const p = prepared({
        action: `Sell ${qty} ${s.symbol} back to the curve`,
        chainId: XGAS_CHAIN_ID,
        to: token_address,
        data: encodeFunctionData({ abi: NGU_TOKEN_ABI, functionName: 'sell', args: [q, to && isAddress(to) ? to : ZERO, minOut] }),
        value: 0n,
        asset: `${s.symbol} → native $xMoney`,
        amount: `${qty} ${s.symbol}`,
        counterparty: `the curve itself: ${token_address}`,
        fees: [
          { label: 'Burn', amount: '0.01% of the redemption basis' },
          { label: 'FanoutSink', amount: '0.01% of the redemption basis' },
          ...(s.buyback_bps ? [{ label: 'XGAS.DEV buy & burn', amount: '0.02% of the redemption basis' }] : []),
        ],
        net: `${fmtXMoney(payout)} $xMoney at current state`,
        timeline: ['One transaction on xGas'],
        irreversible: 'Your tokens are burned. If the reserve has moved by the time this lands, the transaction reverts with Slippage rather than paying you less than minOut.',
        notes: [`minOut is ${fmtXMoney(minOut)} $xMoney, a ${tolerance} tolerance.`, 'Whole tokens only.'],
      });
      return reply(renderApproval(p), p);
    },
  },

  {
    name: 'prepare_ngu_donate',
    description: 'Prepare an unsigned donate: a gift of $xMoney that lifts the redemption floor for every holder. You receive no tokens. Signs nothing.',
    inputSchema: {
      type: 'object',
      properties: { token_address: addr, xmoney_amount: { type: 'string' } },
      required: ['token_address', 'xmoney_amount'],
      additionalProperties: false,
    },
    async handler({ token_address, xmoney_amount }) {
      if (!isAddress(token_address)) throw new Error(`Not an address: ${token_address}`);
      const value = parseXMoney(xmoney_amount);
      const s = await tokenState(token_address);
      const newFloor = BigInt(s.raw.supply) === 0n ? 0n : (BigInt(s.raw.floor) * BigInt(s.raw.supply) + value) / BigInt(s.raw.supply);
      const p = prepared({
        action: `Donate ${fmtXMoney(value)} $xMoney to ${s.symbol}`,
        chainId: XGAS_CHAIN_ID,
        to: token_address,
        data: encodeFunctionData({ abi: NGU_TOKEN_ABI, functionName: 'donate', args: [] }),
        value,
        asset: 'native $xMoney',
        amount: `${fmtXMoney(value)} $xMoney`,
        counterparty: `${s.name} reserve at ${token_address}`,
        fees: [],
        net: 'nothing; you receive no tokens',
        timeline: ['One transaction on xGas'],
        irreversible: 'This is a gift, not a trade. You get no tokens and no claim. The $xMoney joins the reserve and raises the floor for everyone who already holds.',
        notes: [
          `Floor would move from ${s.floor_xmoney} to about ${fmtXMoney(newFloor)} $xMoney per token across ${s.supply} outstanding.`,
          'If you meant to buy, use prepare_ngu_buy instead.',
        ],
      });
      return reply(renderApproval(p), p);
    },
  },

  {
    name: 'launch_ngu_token',
    description: 'Prepare an unsigned launch of a new NGU curve. Validates every parameter against the contract\'s limits first, and states plainly that the economics are immutable afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        symbol: { type: 'string' },
        max_supply: { type: 'integer', minimum: 1, description: 'Whole tokens ever mintable.' },
        base_price: { type: 'string', description: 'First token price in $xMoney, e.g. "0.01".' },
        step_bps: { type: 'integer', minimum: 0, maximum: 5000, description: 'Price step per token. Max 5000.' },
        beta_bps: { type: 'integer', minimum: 5000, maximum: 9500, description: 'Floor protection. 9000 puts the floor at 90% of the buy price.' },
        seed_qty: { type: 'integer', minimum: 0, description: 'Genesis tokens to you, backed by seed_value.' },
        seed_value: { type: 'string', description: '$xMoney sent with the launch to back the seed tokens. Only together with seed_qty of 1 or more: a seed with no seed tokens backs nothing of yours, and the first buyer can take it out of the reserve.' },
        from: addr,
      },
      required: ['name', 'symbol', 'max_supply', 'base_price', 'step_bps', 'beta_bps'],
      additionalProperties: false,
    },
    async handler(a) {
      const launcher = await nguLauncher();
      if (!launcher) return reply(NO_LAUNCHER, { launcher: null, blocked: 'launcher_not_deployed' });

      const errs = [];
      if (a.step_bps > NGU_LIMITS.MAX_STEP_BPS) errs.push(`step_bps ${a.step_bps} exceeds MAX_STEP_BPS ${NGU_LIMITS.MAX_STEP_BPS}`);
      if (a.beta_bps < NGU_LIMITS.MIN_BETA_BPS || a.beta_bps > NGU_LIMITS.MAX_BETA_BPS) errs.push(`beta_bps ${a.beta_bps} is outside ${NGU_LIMITS.MIN_BETA_BPS} to ${NGU_LIMITS.MAX_BETA_BPS}`);
      const seedQty = BigInt(a.seed_qty ?? 0);
      if (seedQty > BigInt(a.max_supply)) errs.push(`seed_qty ${a.seed_qty} exceeds max_supply ${a.max_supply}`);
      const basePrice = parseXMoney(a.base_price);
      if (basePrice === 0n) errs.push('base_price must be greater than zero');
      if (errs.length) return reply(`The contract would revert with BadParams: ${errs.join('; ')}. Nothing prepared.`, { blocked: 'bad_params', errors: errs });

      const seedValue = a.seed_value ? parseXMoney(a.seed_value) : 0n;
      if (seedValue > 0n && seedQty === 0n) {
        return reply(
          `seed_value ${a.seed_value} with seed_qty 0 would put ${fmtXMoney(seedValue)} $xMoney in the reserve behind no tokens of yours. `
          + 'Whoever buys first can buy two tokens and sell both straight back for more than they paid, taking the seed with them. '
          + 'Nothing prepared. Pass seed_qty (the genesis tokens that seed backs), or launch with no seed_value.',
          { blocked: 'seed_without_tokens', seed_value: a.seed_value, seed_qty: 0 },
        );
      }
      // A launcher with buybackSink() mints curves that pay the XGAS.DEV buyback; the first launcher has none.
      const buybackBps = await xgas.readContract({ address: launcher, abi: NGU_LAUNCHER_ABI, functionName: 'buybackSink' }).then(() => Number(BUYBACK_BPS), zeroIfReverted);
      // The first buyer's true worst case, from the state the launch leaves behind. Mirrors NguToken._next:
      // with no seed the first price is basePrice; with a seed, max(step over basePrice, floor/β), in integer math.
      const beta = BigInt(a.beta_bps);
      const firstPrice = seedQty === 0n
        ? basePrice
        : (() => {
          const p1 = (basePrice * (BPS + BigInt(a.step_bps))) / BPS;
          const p2 = (seedValue * BPS) / (beta * seedQty);
          return p1 > p2 ? p1 : p2;
        })();
      const firstRisk = trueMaxLoss({ nextPrice: firstPrice, reserve: seedValue, supply: seedQty, buybackBps });
      const p = prepared({
        action: `Launch ${a.name} (${a.symbol}) as a new NGU curve`,
        chainId: XGAS_CHAIN_ID,
        to: launcher,
        data: encodeFunctionData({
          abi: NGU_LAUNCHER_ABI, functionName: 'launch',
          args: [a.name, a.symbol, BigInt(a.max_supply), basePrice, a.step_bps, a.beta_bps, seedQty],
        }),
        value: seedValue,
        asset: 'native $xMoney (the seed)',
        amount: `${fmtXMoney(seedValue)} $xMoney backing ${seedQty} genesis tokens`,
        counterparty: `NguLauncher ${launcher}`,
        fees: [{ label: 'Launch fee', amount: 'none', note: `the money is in the flow: ${feeText(buybackBps)} on every later buy and sell` }],
        net: `A new ERC-20 you control ${seedQty} of at genesis, out of ${a.max_supply}`,
        timeline: ['One transaction on xGas; the token address comes back in the NguLaunched event'],
        irreversible: `The economics are fixed forever at launch: max supply ${a.max_supply}, base price ${a.base_price}, step ${a.step_bps}bps, β ${a.beta_bps}bps. Nobody, including you, can change them afterwards. The first buyer pays ${fmtXMoney(firstPrice)} $xMoney and, selling straight back, gets ${firstRisk ? fmtXMoney(firstRisk.proceeds) : '0'}: a worst case of ${firstRisk ? pct(firstRisk.lossBps) : '100.00%'}, fees included. That figure moves as the curve trades, and grows once the step carries the price above floor/β (get_ngu_token reports the live figure).`,
        notes: ['Seed tokens pay no fee and take no curve step; your own $xMoney backs them at genesis.'],
      });
      return reply(renderApproval(p), p);
    },
  },

  {
    name: 'submit_ngu',
    description: 'Broadcast any signed NGU transaction on xGas (buy, sell, donate, launch).',
    inputSchema: {
      type: 'object',
      properties: { ...submitFields },
      required: ['signed_tx', 'idempotency_key'],
      additionalProperties: false,
    },
    async handler({ signed_tx, idempotency_key }) {
      const res = await submitRaw({ chainId: XGAS_CHAIN_ID, signedTx: signed_tx, idempotencyKey: idempotency_key, kind: 'ngu' });
      return reply(res.replayed ? `Already submitted under this key: ${res.hash}.` : `Sent on xGas: ${res.hash}.`, res);
    },
  },
];
