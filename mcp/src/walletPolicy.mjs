// The spending policy for the custodial agent wallet, enforced here on the server and never by the model.
//
// wallet_execute used to need only confirm:true, which the model sets itself. A model that reads a hostile X handle
// or token name could therefore be talked into spending the whole wallet. Now every prepared execution is decoded
// step by step and runs on its own only when all of this holds:
//   - every step goes to a contract on the allowlist below (the xgas contracts in the deployment file), calls a
//     function this module can read, and any recipient or spender inside the calldata is this wallet or the allowlist;
//   - the value it moves (native value plus the token amounts in the calldata) is within the per-transaction cap;
//   - that value plus what the wallet already moved in the last 24 hours is within the daily cap.
// Anything else needs the wallet's owner to approve it in a browser (walletApprovals.mjs). Unknown means no: a
// call this module cannot value is a call a person has to look at.
//
// NGU curves are not all ours. The launcher is permissionless, so "the launcher made it" only proves the code, not
// who controls the curve: anyone can launch one, give it a name written to steer an agent, and sell into whatever
// this wallet pays. So a curve counts as allowlisted only when THIS wallet launched it (the launcher's own
// NguLaunched log says so). On anyone else's curve a sell still runs (the payout comes back here, and sells cannot
// be pushed below the floor), a buy needs a person unless the host sets XGAS_WALLET_MAX_THIRD_PARTY_NGU_USD, and a
// donate always needs a person anywhere: it is a gift. A launch that sends a seed but mints no seed tokens needs a
// person too, since nothing of this wallet's backs that seed and the first buyer can take it.
import fs from 'fs';
import path from 'path';
import { decodeFunctionData, formatUnits, getAddress, isAddress, parseAbi, parseAbiItem } from 'viem';
import { PARENT_CHAIN_ID, XGAS_CHAIN_ID, L3, L4, L4_ORIGINAL, EARLY_DEPOSITOR, XSWAP, ZERO, XGAS_API, parent, xgas, nguLauncher } from './config.mjs';
import {
  ERC20_ABI, VAULT_ABI, EARLY_DEPOSITOR_ABI, ARBSYS_ABI, ESCROW_ABI, NGU_TOKEN_ABI, NGU_LAUNCHER_ABI, XSWAP_INTENTS_ABI, XSWAP_ASKS_ABI,
} from './abis.mjs';
import { clean } from './untrusted.mjs';

const DATA_DIR = process.env.XGAS_MCP_DATA
  || (fs.existsSync('/data') ? '/data' : path.join(process.env.HOME || '.', '.xgas-mcp'));
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------------------------------------------
// Configuration. Read from the environment on every call, so the host sets it and a test can vary it.
// ---------------------------------------------------------------------------------------------------------------
export const POLICY_DEFAULTS = Object.freeze({ maxTxUsd: 25, maxDayUsd: 100, approvalTtlS: 600, thirdPartyNguUsd: 0 });

const num = (v, d) => {
  if (v === undefined || v === null || String(v).trim() === '') return d;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};
const flag = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());

export function policyConfig(env = process.env) {
  return {
    maxTxUsd: num(env.XGAS_WALLET_MAX_TX_USD, POLICY_DEFAULTS.maxTxUsd),
    maxDayUsd: num(env.XGAS_WALLET_MAX_DAY_USD, POLICY_DEFAULTS.maxDayUsd),
    approveAll: flag(env.XGAS_WALLET_APPROVE_ALL),
    autoRelease: flag(env.XGAS_WALLET_AUTO_RELEASE),
    approvalTtlS: Math.min(1800, Math.max(60, num(env.XGAS_WALLET_APPROVAL_TTL_S, POLICY_DEFAULTS.approvalTtlS))),
    // Per transaction, on NGU curves this wallet did not launch. 0 (the default) means every such buy needs a person.
    thirdPartyNguUsd: num(env.XGAS_WALLET_MAX_THIRD_PARTY_NGU_USD, POLICY_DEFAULTS.thirdPartyNguUsd),
  };
}

export const usd = (n) => (Number.isFinite(n) ? `$${n.toFixed(2)}` : 'an amount this policy could not price');

// ---------------------------------------------------------------------------------------------------------------
// The allowlist. Chain-aware: the same address means different things on Robinhood and on the L4 (0x6067…f7F8 is
// the XGAS.DEV buyback on one and the NGU launcher on the other), so an entry is a (chain, address) pair.
// ---------------------------------------------------------------------------------------------------------------
const P = PARENT_CHAIN_ID;
const X = XGAS_CHAIN_ID;
export const CHAIN_NAMES = { [P]: `Robinhood Chain (${P})`, [X]: `xGas L4 (${X})` };

const valid = (a) => typeof a === 'string' && isAddress(a) && a.toLowerCase() !== ZERO;
const safe = async (fn) => { try { return await fn(); } catch { return null; } };

export function staticAllowlist() {
  const out = [];
  const add = (chainId, address, label, key) => { if (valid(address)) out.push({ chainId, address: getAddress(address), label, key }); };
  add(P, L3.xMoney, 'XMoney vault ($xMoney ERC-20)', 'vault');
  add(P, L3.usdg, 'USDG token', 'usdg');
  add(P, EARLY_DEPOSITOR, 'EarlyDepositor (USDG into the L4)', 'earlyDepositor');
  add(P, L3.robinhoodOtc, 'Robinhood OTC desk', 'robinhoodOtc');
  add(P, L3.otcArbitration, 'Robinhood OTC arbitration', 'otcArbitration');
  // ArbSys is how $xMoney leaves the L4 for the vault side: the exit half of the vault bridge.
  add(X, L4.arbSys, 'ArbSys (exit to Robinhood)', 'arbSys');
  add(X, L4.escrow, 'xGas OTC escrow', 'escrow');
  add(X, L4.router, 'xGas router', 'router');
  add(X, L4.fomo, 'FOMO', 'fomo');
  add(X, L4.nguLauncher, 'NGU launcher', 'nguLauncher');
  // The original generation stays allowlisted so existing positions there can still be released, cancelled,
  // claimed and withdrawn; new orders, keys and launches go to the current generation above.
  if (L4.generation) {
    for (const [k, label] of [['escrow', 'xGas OTC escrow (original)'], ['router', 'xGas router (original)'],
      ['fomo', 'FOMO (original)'], ['nguLauncher', 'NGU launcher (original)']]) {
      if (L4_ORIGINAL[k] && L4_ORIGINAL[k].toLowerCase() !== String(L4[k]).toLowerCase()) add(X, L4_ORIGINAL[k], label, `${k}Original`);
    }
  }
  add(X, L4.xgasDevPaymaster, 'XGAS.DEV paymaster', 'paymaster');
  return out;
}

// Contracts the connector can prepare calls to that are NOT on the allowlist. Named so a person reading the approval
// page sees what they are, decoded so they see what the call does. A call to one of these always needs a person.
function displayOnly() {
  const out = [];
  if (valid(XSWAP.intents)) out.push({ chainId: P, address: getAddress(XSWAP.intents), label: 'XSwap intents (not on the allowlist)', key: 'xswapIntents' });
  if (valid(XSWAP.asks)) out.push({ chainId: P, address: getAddress(XSWAP.asks), label: 'XSwap asks (not on the allowlist)', key: 'xswapAsks' });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// What each allowlisted function moves. A decoder returns:
//   outflows: [{ asset, amount, kind, spender? }]  value leaving the wallet or committed by it, beyond msg.value
//   checks:   [{ role: 'recipient' | 'spender', address, zeroIsSelf? }]  addresses inside the calldata
//   human:    a reason this call always needs a person, whatever its size
// Allowance and pull outflows to the same spender count once (approve 50 then deposit 50 is 50, not 100).
// ---------------------------------------------------------------------------------------------------------------
const TOKEN_EXTRA = parseAbi([
  'function transfer(address to, uint256 value) returns (bool)',
  'function transferFrom(address from, address to, uint256 value) returns (bool)',
  'function increaseAllowance(address spender, uint256 addedValue) returns (bool)',
]);
const TOKEN_ABI = [...ERC20_ABI, ...TOKEN_EXTRA];

const erc20Fns = (asset) => ({
  approve: ({ args: [spender, amount] }) => ({ outflows: [{ asset, amount, kind: 'allowance', spender }], checks: [{ role: 'spender', address: spender }] }),
  increaseAllowance: ({ args: [spender, amount] }) => ({ outflows: [{ asset, amount, kind: 'allowance', spender }], checks: [{ role: 'spender', address: spender }] }),
  transfer: ({ args: [to, amount] }) => ({ outflows: [{ asset, amount, kind: 'transfer' }], checks: [{ role: 'recipient', address: to }] }),
  transferFrom: ({ args: [from, to, amount] }) => ({ outflows: [{ asset, amount, kind: 'transfer' }], checks: [{ role: 'recipient', address: from }, { role: 'recipient', address: to }] }),
});

const RELEASE_REASON = 'releaseTrade hands escrowed $xMoney to the buyer on the strength of a fiat payment that only a person can check in their own X Money account';
const DONATE_REASON = 'donate gives $xMoney to a curve\'s reserve and returns nothing to this wallet: it is a gift, so a person decides, whatever the size';
const UNBACKED_SEED_REASON = 'it sends a seed with seedQty 0: the $xMoney backs no tokens of this wallet, and whoever buys first can buy two tokens and sell both back with the seed';

const SPECS = {
  usdg: { abi: TOKEN_ABI, fns: erc20Fns('usdg') },
  vault: {
    abi: [...VAULT_ABI, ...TOKEN_EXTRA, ...ERC20_ABI.filter((f) => f.name === 'approve')],
    fns: {
      ...erc20Fns('xmoney20'),
      enterRollup: ({ args: [amount, recipient], to }) => ({ outflows: [{ asset: 'usdg', amount, kind: 'pull', spender: to }], checks: [{ role: 'recipient', address: recipient }] }),
      enterRollupToL3: ({ args: [amount], to }) => ({ outflows: [{ asset: 'usdg', amount, kind: 'pull', spender: to }] }),
      exitRollup: ({ args: [amount] }) => ({ outflows: [{ asset: 'xmoney20', amount, kind: 'redeemed for USDG to this wallet' }] }),
    },
  },
  earlyDepositor: {
    abi: EARLY_DEPOSITOR_ABI,
    fns: { deposit: ({ args: [amount, recipient], to }) => ({ outflows: [{ asset: 'usdg', amount, kind: 'pull', spender: to }], checks: [{ role: 'recipient', address: recipient }] }) },
  },
  arbSys: { abi: ARBSYS_ABI, fns: { withdrawEth: ({ args: [destination] }) => ({ checks: [{ role: 'recipient', address: destination }] }) } },
  escrow: {
    abi: ESCROW_ABI,
    fns: {
      createSellAsk: () => ({}), // the escrowed $xMoney is msg.value, counted below
      fillBuyBid: () => ({}), // likewise
      createBuyBid: ({ args: [, maxWanted] }) => ({ outflows: [{ asset: 'xmoney', amount: maxWanted, kind: 'committed to pay for in fiat' }] }),
      fillSellAsk: ({ args: [, amount] }) => ({ outflows: [{ asset: 'xmoney', amount, kind: 'committed to pay for in fiat' }] }),
      releaseTrade: async ({ args: [tradeId], ctx, config }) => ({
        outflows: [{ asset: 'xmoney', amount: await ctx.tradeAmount(tradeId), kind: 'released from escrow to the buyer' }],
        human: config.autoRelease ? null : RELEASE_REASON,
      }),
      cancelTradeTimeout: () => ({}), // back to this wallet
      cancelOrder: () => ({}),
    },
  },
  nguLauncher: {
    abi: NGU_LAUNCHER_ABI,
    fns: {
      // The seed is msg.value, counted like any native value. Seed value with no seed tokens backs nothing of ours.
      launch: ({ args: [, , , , , , seedQty], value }) => (value > 0n && BigInt(seedQty) === 0n ? { human: UNBACKED_SEED_REASON } : {}),
    },
  },
  nguToken: {
    abi: NGU_TOKEN_ABI,
    fns: {
      // A buy on a curve this wallet did not launch goes to a person unless the host set a third-party cap (evaluate()).
      buy: ({ args: [, to], trust }) => ({ checks: [{ role: 'recipient', address: to, zeroIsSelf: true }], thirdPartyBuy: trust === 'third_party_curve' }),
      // Only tokens this wallet holds can be sold, the payout lands here, and a sell never pays under min(floor, last price).
      sell: ({ args: [qty, to], to: token }) => ({ outflows: [{ asset: 'ngu', token, qty, kind: 'sold back to the curve' }], checks: [{ role: 'recipient', address: to, zeroIsSelf: true }] }),
      donate: () => ({ human: DONATE_REASON }),
    },
  },
  // Allowlisted by address but with nothing the connector prepares for them: no decoder, so a person decides.
  robinhoodOtc: {}, otcArbitration: {}, router: {}, fomo: {}, paymaster: {},
  xswapIntents: { abi: XSWAP_INTENTS_ABI, fns: {} },
  xswapAsks: { abi: XSWAP_ASKS_ABI, fns: {} },
};

// ---------------------------------------------------------------------------------------------------------------
// Prices. Conservative on purpose: $xMoney is valued at no less than $1 even if the vault NAV dips under it, and a
// price that cannot be read makes the step unpriced, which sends it to a person rather than letting it through.
// ---------------------------------------------------------------------------------------------------------------
const ASSETS = {
  eth: { symbol: 'ETH', decimals: 18 },
  xmoney: { symbol: '$xMoney', decimals: 18 },
  xmoney20: { symbol: 'xMoney (ERC-20)', decimals: 18 },
  usdg: { symbol: 'USDG', decimals: 6 },
};

let ethUsdSource = null;
/** The host can hand over its own ETH price (server.js has a median of three exchanges). */
export function setEthUsdSource(fn) { ethUsdSource = typeof fn === 'function' ? fn : null; }

function cached(ms, fn) {
  let at = 0; let val; let inflight = null;
  return async () => {
    if (val !== undefined && Date.now() - at < ms) return val;
    if (inflight) return inflight;
    inflight = fn().then((v) => { val = v; at = Date.now(); return v; }).finally(() => { inflight = null; });
    return inflight;
  };
}

const nguCache = new Set();
const launchedCache = new Set();
const NGU_LAUNCHED = parseAbiItem('event NguLaunched(address indexed token, address indexed creator, uint256 maxSupply, uint256 basePrice, uint16 stepBps, uint16 betaBps, uint256 seedQty, uint256 seedValue)');
export function liveContext() {
  return {
    xMoneyUsd: cached(60_000, async () => {
      const [, reserve, circulating] = await parent.readContract({ address: L3.xMoney, abi: VAULT_ABI, functionName: 'getReserveNAV' });
      const nav = circulating > 0n ? Number(formatUnits(reserve * 10n ** 12n, 18)) / Number(formatUnits(circulating, 18)) : 1;
      return Math.max(1, Number.isFinite(nav) ? nav : 1);
    }),
    ethUsd: cached(60_000, async () => {
      let v = ethUsdSource ? await ethUsdSource() : null;
      if (v == null) {
        const res = await fetch(`${XGAS_API}/api/robinhood/eth-price`, { signal: AbortSignal.timeout(8000) });
        v = res.ok ? Number((await res.json())?.usd) : null;
      }
      if (!Number.isFinite(Number(v)) || Number(v) <= 0) throw new Error('no ETH price');
      return Number(v);
    }),
    // What `qty` tokens sell back for, in $xMoney wei. Falls back to qty at the next buy price, which is higher.
    nguPayout: async (token, qty) => {
      try { return await xgas.readContract({ address: token, abi: NGU_TOKEN_ABI, functionName: 'quoteSell', args: [qty] }); } catch { /* next */ }
      return qty * await xgas.readContract({ address: token, abi: NGU_TOKEN_ABI, functionName: 'nextPrice' });
    },
    tradeAmount: async (tradeId) => (await xgas.readContract({ address: L4.escrow, abi: ESCROW_ABI, functionName: 'trades', args: [tradeId] }))[6],
    launcher: async () => nguLauncher(),
    // Tokens the NGU launcher created, and only those: asked of the launcher itself, never of the token.
    isNguToken: async (address) => {
      const k = address.toLowerCase();
      if (nguCache.has(k)) return true;
      const launchers = [await nguLauncher().catch(() => null), L4.legacy2bp?.nguLauncher].filter(valid);
      for (const la of launchers) {
        const yes = await xgas.readContract({ address: la, abi: NGU_LAUNCHER_ABI, functionName: 'isNguToken', args: [address] }).catch(() => false);
        if (yes) { nguCache.add(k); return true; }
      }
      return false;
    },
    // Did `creator` launch `token`? Read from the launcher's own NguLaunched log (token and creator are both indexed),
    // so only the launcher can say yes. An RPC that cannot answer is a no: the buy then goes to a person.
    launchedBy: async (token, creator) => {
      const k = `${token.toLowerCase()}|${creator.toLowerCase()}`;
      if (launchedCache.has(k)) return true;
      const launchers = [await nguLauncher().catch(() => null), L4.legacy2bp?.nguLauncher].filter(valid);
      for (const la of launchers) {
        const logs = await xgas.getLogs({ address: la, event: NGU_LAUNCHED, args: { token, creator }, fromBlock: 0n, toBlock: 'latest' }).catch(() => []);
        if (logs.some((l) => l.address?.toLowerCase() === la.toLowerCase())) { launchedCache.add(k); return true; }
      }
      return false;
    },
  };
}

async function priceUsd(o, ctx) {
  if (o.asset === 'usdg') return Number(formatUnits(o.amount, 6));
  if (o.asset === 'eth') return Number(formatUnits(o.amount, 18)) * await ctx.ethUsd();
  if (o.asset === 'xmoney' || o.asset === 'xmoney20') return Number(formatUnits(o.amount, 18)) * await ctx.xMoneyUsd();
  if (o.asset === 'ngu') return Number(formatUnits(await ctx.nguPayout(o.token, o.qty), 18)) * await ctx.xMoneyUsd();
  throw new Error(`unknown asset ${o.asset}`);
}

const fmtAmount = (o) => (o.asset === 'ngu'
  ? `${o.qty} NGU token${o.qty === 1n ? '' : 's'} of ${o.token}`
  : `${formatUnits(o.amount, ASSETS[o.asset].decimals)} ${ASSETS[o.asset].symbol}`);

// ---------------------------------------------------------------------------------------------------------------
// Decoding and evaluation
// ---------------------------------------------------------------------------------------------------------------
function display(v) {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string') return isAddress(v) ? getAddress(v) : clean(v, 120);
  if (Array.isArray(v)) return v.map(display);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, display(x)]));
  return v;
}

async function decodeStep(t, i, { me, entries, ctx, config }) {
  const n = i + 1;
  const chainId = Number(t.chainId);
  const to = valid(t.to) ? getAddress(t.to) : t.to;
  const reasons = [];
  const outflows = [];
  const view = {
    index: n, label: clean(t.label || '', 200), chain_id: chainId, chain: CHAIN_NAMES[chainId] || `chain ${chainId}`,
    to, to_label: null, allowlisted: false, trust: 'unknown', function: null, args: [], value_wei: String(t.value ?? '0'), native_value: null,
    counted: [], usd: 0, problems: [],
  };
  const flagIt = (msg) => { reasons.push(`step ${n}: ${msg}`); view.problems.push(msg); };
  let thirdPartyBuy = false;

  const nativeAsset = chainId === X ? 'xmoney' : chainId === P ? 'eth' : null;
  if (!nativeAsset) flagIt(`it is for chain ${chainId}, which this wallet does not sign for`);
  const value = BigInt(t.value ?? 0);
  if (nativeAsset) view.native_value = `${formatUnits(value, 18)} ${ASSETS[nativeAsset].symbol}`;
  if (value > 0n && nativeAsset) outflows.push({ asset: nativeAsset, amount: value, kind: 'sent with the call', step: n });

  const toSelf = valid(to) && to.toLowerCase() === me;
  let entry = entries.find((e) => e.chainId === chainId && valid(to) && e.address.toLowerCase() === to.toLowerCase());
  if (!entry && chainId === X && valid(to) && await safe(() => ctx.isNguToken(to))) {
    // The launcher made it, so the code is the NGU curve. Who controls it is another matter: see the header.
    entry = await safe(() => ctx.launchedBy?.(to, me))
      ? { chainId, address: to, label: 'NGU curve this wallet launched', key: 'nguToken', trust: 'own_curve' }
      : { chainId, address: to, label: 'Third-party NGU curve (someone else launched it; anyone can)', key: 'nguToken', trust: 'third_party_curve' };
  }
  const shown = entry || displayOnly().find((e) => e.chainId === chainId && valid(to) && e.address.toLowerCase() === to.toLowerCase());
  view.to_label = shown ? shown.label : toSelf ? 'this wallet' : 'unknown address';
  // covered: this policy can read calls to it. allowlisted: it may also receive them without a person, per function.
  const covered = !!entry || toSelf;
  view.trust = entry ? entry.trust || 'allowlisted' : toSelf ? 'this_wallet' : shown ? 'display_only' : 'unknown';
  view.allowlisted = covered && view.trust !== 'third_party_curve';
  if (!covered) flagIt(`${to} on ${view.chain} is not on this wallet's allowlist`);

  const spec = SPECS[shown?.key] || {};
  const data = typeof t.data === 'string' ? t.data : '0x';
  if (data === '0x' || data === '') {
    view.function = '(plain transfer)';
    if (to?.toLowerCase() !== me) flagIt('it sends value with no call data, which this policy does not auto-approve');
  } else if (!spec.abi) {
    if (covered) flagIt(`it calls ${data.slice(0, 10)} on ${view.to_label}, which this policy cannot read or value`);
  } else {
    let decoded = null;
    try { decoded = decodeFunctionData({ abi: spec.abi, data }); } catch { /* below */ }
    if (!decoded) {
      flagIt(`it calls ${data.slice(0, 10)} on ${view.to_label}, which this policy cannot read or value`);
    } else {
      const item = spec.abi.find((f) => f.type === 'function' && f.name === decoded.functionName && (f.inputs || []).length === (decoded.args || []).length);
      view.function = decoded.functionName;
      view.args = (item?.inputs || []).map((inp, k) => {
        const value = display(decoded.args[k]);
        const arg = { name: inp.name || `arg${k}`, type: inp.type, value };
        if (inp.type === 'address' && typeof value === 'string') {
          const hit = entries.find((e) => e.chainId === chainId && e.address.toLowerCase() === value.toLowerCase());
          arg.label = value.toLowerCase() === me ? 'this wallet' : value.toLowerCase() === ZERO ? 'zero address' : hit ? hit.label : 'not on the allowlist';
        }
        return arg;
      });
      const fn = spec.fns?.[decoded.functionName];
      if (!fn) {
        if (covered) flagIt(`${decoded.functionName} on ${view.to_label} is not a call this policy auto-approves`);
      } else {
        let r = {};
        try {
          r = (await fn({ args: decoded.args || [], to, ctx, config, me, value, trust: view.trust })) || {};
        } catch (e) {
          flagIt(`could not read what ${decoded.functionName} would move (${e.shortMessage || e.message})`);
          outflows.push({ asset: 'unknown', amount: 0n, kind: 'unreadable', step: n });
        }
        for (const o of r.outflows || []) outflows.push({ ...o, step: n });
        for (const c of r.checks || []) {
          const a = String(c.address || '').toLowerCase();
          if (c.role === 'recipient') {
            const self = a === me || (c.zeroIsSelf && a === ZERO);
            if (!self) flagIt(`it sends to ${valid(c.address) ? getAddress(c.address) : c.address}, which is not this wallet`);
          } else if (c.role === 'spender') {
            const ok = entries.some((e) => e.chainId === chainId && e.address.toLowerCase() === a);
            if (!ok) flagIt(`it lets ${valid(c.address) ? getAddress(c.address) : c.address} spend this wallet's tokens, and that address is not on the allowlist`);
          }
        }
        if (r.human) flagIt(r.human);
        if (r.thirdPartyBuy) thirdPartyBuy = true;
      }
    }
  }
  return { view, outflows, reasons, thirdPartyBuy };
}

/**
 * Decide whether a prepared envelope may run without a person. Pure given its context: prices, the NGU launcher and
 * the escrow come in through `ctx`, the spend so far through `ledger`, so tests need no network.
 */
export async function evaluate({ envelope, wallet }, ctx = liveContext(), { config = policyConfig(), ledger = spendLedger, now = Date.now() } = {}) {
  const me = String(wallet).toLowerCase();
  const launcher = await safe(() => ctx.launcher());
  const entries = staticAllowlist();
  if (valid(launcher) && !entries.some((e) => e.chainId === X && e.address.toLowerCase() === launcher.toLowerCase())) {
    entries.push({ chainId: X, address: getAddress(launcher), label: 'NGU launcher', key: 'nguLauncher' });
  }

  const reasons = [];
  const steps = [];
  const outflows = [];
  const thirdPartyBuys = [];
  for (const [i, t] of (envelope?.transactions || []).entries()) {
    const s = await decodeStep(t, i, { me, entries, ctx, config });
    steps.push(s.view);
    outflows.push(...s.outflows);
    reasons.push(...s.reasons);
    if (s.thirdPartyBuy) thirdPartyBuys.push(i + 1);
  }
  if (!steps.length) reasons.push('there is nothing to execute');

  // Price each outflow once, for the per-step view.
  let unpriced = false;
  for (const o of outflows) {
    try {
      if (o.asset === 'unknown') throw new Error('unreadable');
      o.usd = await priceUsd(o, ctx);
      if (!Number.isFinite(o.usd)) throw new Error('not finite');
    } catch (e) {
      o.usd = Infinity;
      unpriced = true;
    }
    const v = steps[o.step - 1];
    if (v && o.asset !== 'unknown') {
      const spender = o.spender && entries.find((e) => e.address.toLowerCase() === String(o.spender).toLowerCase());
      const kind = o.kind === 'allowance' ? `allowance for ${spender ? spender.label : o.spender}`
        : o.kind === 'pull' ? 'taken from this wallet by this call' : o.kind;
      v.counted.push({ amount: fmtAmount(o), kind, usd: Number.isFinite(o.usd) ? Number(o.usd.toFixed(2)) : null });
      v.usd = v.usd === null || !Number.isFinite(o.usd) ? null : Number((v.usd + o.usd).toFixed(2));
    }
  }
  if (unpriced) reasons.push('a step moves an amount this policy could not price right now');

  // Buys on curves this wallet did not launch: a person decides, unless the host set a (small) cap for them.
  for (const n of thirdPartyBuys) {
    const spend = outflows.filter((o) => o.step === n).reduce((sum, o) => sum + o.usd, 0);
    const cap = config.thirdPartyNguUsd;
    let msg = null;
    if (!(cap > 0)) {
      msg = 'it buys on an NGU curve this wallet did not launch. Anyone can launch a curve, name it to steer an agent and sell into the price this wallet pays, so a person decides';
    } else if (!(spend <= cap)) {
      msg = `it spends ${usd(spend)} on an NGU curve this wallet did not launch, over the ${usd(cap)} this host allows per transaction on third-party curves`;
    }
    if (msg) {
      reasons.push(`step ${n}: ${msg}`);
      steps[n - 1]?.problems.push(msg);
    }
  }

  // The total: allowances and the pulls they fund count once per (asset, spender), everything else adds up.
  let total = 0;
  const pairs = new Map();
  for (const o of outflows) {
    if (o.kind === 'allowance' || o.kind === 'pull') {
      const k = `${o.asset}|${String(o.spender).toLowerCase()}`;
      const p = pairs.get(k) || { allow: 0, pull: 0 };
      p[o.kind === 'allowance' ? 'allow' : 'pull'] += o.usd;
      pairs.set(k, p);
    } else {
      total += o.usd;
    }
  }
  const notes = [];
  for (const p of pairs.values()) {
    total += Math.max(p.allow, p.pull);
    if (p.allow > 0 && p.pull > 0) notes.push('An approval and the call that spends it count once, not twice.');
  }

  const spent = ledger.spent24h(me, now);
  if (config.approveAll) reasons.unshift('this host asks a person to approve every agent wallet transaction');
  if (Number.isFinite(total) && total > config.maxTxUsd) reasons.push(`it moves ${usd(total)}, over the ${usd(config.maxTxUsd)} per-transaction cap`);
  if (Number.isFinite(total) && total <= config.maxTxUsd && spent + total > config.maxDayUsd) {
    reasons.push(`this wallet already moved ${usd(spent)} in the last 24 hours, and ${usd(total)} more would pass the ${usd(config.maxDayUsd)} daily cap`);
  }

  return {
    auto: reasons.length === 0,
    reasons: [...new Set(reasons)],
    steps,
    total_usd: Number.isFinite(total) ? Number(total.toFixed(2)) : null,
    notes: [...new Set(notes)],
    spent_24h_usd: Number(spent.toFixed(2)),
    caps: { per_transaction_usd: config.maxTxUsd, per_24h_usd: config.maxDayUsd, approve_all: config.approveAll, third_party_ngu_usd: config.thirdPartyNguUsd },
  };
}

/** One line for a tool result: what the policy decided, and why. */
export function verdictText(v) {
  const caps = `caps: ${usd(v.caps.per_transaction_usd)} per transaction, ${usd(v.caps.per_24h_usd)} per 24 hours, ${usd(v.spent_24h_usd)} used`;
  return v.auto
    ? `Policy: within limits (${usd(v.total_usd ?? NaN)}; ${caps}). Every destination is an allowlisted xgas contract, this wallet, an NGU curve this wallet launched, or a curve it is selling its own tokens back to.`
    : `Policy: needs the wallet owner's approval in a browser, because ${v.reasons.join('; ')}. (${caps})`;
}

// ---------------------------------------------------------------------------------------------------------------
// The rolling 24-hour ledger, per wallet address. A reservation is taken synchronously, check and write in one
// tick, so two executions racing each other cannot both fit under the same remaining allowance.
// ---------------------------------------------------------------------------------------------------------------
const DAY_MS = 24 * 3600 * 1000;

export function createLedger(file = path.join(DATA_DIR, 'wallet-spend.json')) {
  let book = {};
  try { if (file && fs.existsSync(file)) book = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) {
    console.error(`[wallet-policy] ${file} is unreadable (${e.message}); starting an empty ledger.`);
    book = {};
  }
  const save = () => {
    const cutoff = Date.now() - 2 * DAY_MS;
    for (const k of Object.keys(book)) {
      book[k] = book[k].filter((e) => e.at > cutoff);
      if (!book[k].length) delete book[k];
    }
    if (!file) return;
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(book), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) { console.error('[wallet-policy] could not save the spend ledger:', e.message); }
  };
  const key = (a) => String(a).toLowerCase();
  const spent24h = (addr, now = Date.now()) => (book[key(addr)] || [])
    .filter((e) => now - e.at < DAY_MS).reduce((s, e) => s + (Number.isFinite(e.usd) ? e.usd : 0), 0);
  return {
    spent24h,
    tryReserve(addr, amountUsd, capUsd, ref, now = Date.now()) {
      if (!Number.isFinite(amountUsd) || amountUsd < 0) return false;
      if (spent24h(addr, now) + amountUsd > capUsd + 1e-9) return false;
      (book[key(addr)] ||= []).push({ at: now, usd: amountUsd, ref, state: 'reserved' });
      save();
      return true;
    },
    /** keep: the money moved (or may have), so it stays counted. Otherwise the reservation is dropped. */
    settle(ref, keep) {
      for (const k of Object.keys(book)) {
        book[k] = book[k].flatMap((e) => (e.ref !== ref ? [e] : keep ? [{ ...e, state: 'spent' }] : []));
      }
      save();
    },
    add(addr, amountUsd, ref, now = Date.now()) {
      if (!Number.isFinite(amountUsd) || amountUsd <= 0) return;
      (book[key(addr)] ||= []).push({ at: now, usd: amountUsd, ref, state: 'spent' });
      save();
    },
  };
}

export const spendLedger = createLedger();

/** The policy as a wallet's owner should see it: the caps, what is used, and where the approval link comes from. */
export function policySnapshot(address, { config = policyConfig(), ledger = spendLedger, now = Date.now() } = {}) {
  const spent = address ? ledger.spent24h(address, now) : 0;
  return {
    per_transaction_usd: config.maxTxUsd,
    per_24h_usd: config.maxDayUsd,
    spent_24h_usd: Number(spent.toFixed(2)),
    remaining_24h_usd: Number(Math.max(0, config.maxDayUsd - spent).toFixed(2)),
    approve_all: config.approveAll,
    approval_ttl_s: config.approvalTtlS,
    third_party_ngu_usd: config.thirdPartyNguUsd,
    allowlist: staticAllowlist().map((e) => ({ chain_id: e.chainId, address: e.address, label: e.label })),
    also_allowed: 'this wallet itself as a recipient; buys and sells on NGU curves this wallet launched; sells of tokens it holds back to any NGU curve (the payout comes here)',
    always_needs_you: 'donations to any NGU curve, buys on NGU curves someone else launched'
      + (config.thirdPartyNguUsd > 0 ? ` (over ${usd(config.thirdPartyNguUsd)} per transaction)` : '')
      + ', launches that send a seed without seed tokens, releasing an OTC trade, XSwap, and any address or call not listed here',
    rule: 'Inside the caps and the allowlist, wallet_execute with confirm: true sends at once. Anything else returns a one-time approval link that only the wallet owner, signed in with X, can approve.',
  };
}
