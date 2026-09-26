import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDownUp, CheckCircle, Clock, ExternalLink, Gavel, Link2, Lock, RefreshCw, ShieldCheck, Upload, Wallet, AlertTriangle, Droplet } from 'lucide-react';
import { encodeFunctionData, formatEther, parseAbi, parseEther, type Abi } from 'viem';
import { UserWallet } from '../types';
import { CONTRACT_ADDRESSES, ROBINHOOD_OTC_ABI, ROBINHOOD_OTC_SIDE, ROBINHOOD_OTC_STATUS } from '../contracts/abis';
import { publicClient, sendOnChainTx, switchNetwork, xLoginUrl, L3_CHAIN_ID, TxError } from '../contracts/web3Client';
import { RobinhoodArbiters } from './RobinhoodArbiters';

// ---------------------------------------------------------------------------
// Robinhood desk: dollars on X Money (off-chain, X account to X account) <-> native ETH on Robinhood Chain #4663.
// ETH sits in RobinhoodEthOtc; the dollar leg happens inside the X app, so every trade has a payment window,
// an optimistic release window and a staked, commit-reveal dispute path (OtcArbitration). Not the $xMoney token.
// All reads go through getters (the Robinhood RPC keeps little history), never log ranges.
// ---------------------------------------------------------------------------

const EXPLORER = 'https://robinhoodchain.blockscout.com';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const WEI_PER_ETH = 10n ** 18n;
const PAGE = 100;
const LOW_GAS_WEI = 10n ** 13n; // 0.00001 ETH: below this a wallet cannot pay for a Robinhood Chain tx
const MAX_URI_BYTES = 512; // OtcArbitration.MAX_URI_BYTES: longer evidence links revert
const MAX_EVIDENCE_PER_PARTY = 16; // OtcArbitration.MAX_EVIDENCE_PER_PARTY
const LONG_STOP_FALLBACK = 14 * 24 * 3600; // OtcArbitration.LONG_STOP, until the chain answers
const bytesOf = (s: string) => new TextEncoder().encode(s).length;

// Only what this page calls on the arbitration contract. The full ABI lives with the Arbiters tab.
const ARB_MIN_ABI = parseAbi([
  'function submitEvidence(uint256 tradeId, string uri)',
  'function resolve(uint256 tradeId)',
  'function disputeOf(uint256 tradeId) view returns (address buyer, address seller, uint256 bond, uint64 openedAt, uint64 commitEnd, uint64 revealEnd, uint16 extensions, bool resolved, uint8 outcome, uint256 weightBuyerPaid, uint256 weightDidNotPay, uint256 revealers)',
  'function evidenceOf(uint256 tradeId) view returns (string[] uris, address[] by)',
  'function LONG_STOP() view returns (uint256)',
]);

type SubTab = 'book' | 'post' | 'trades' | 'arbiters';
const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: 'book', label: 'Order book' },
  { id: 'post', label: 'Post an order' },
  { id: 'trades', label: 'My trades' },
  { id: 'arbiters', label: 'Arbiters' },
];

function parseSubRoute(): { sub: SubTab; tradeId: number | null } {
  if (typeof window === 'undefined') return { sub: 'book', tradeId: null };
  const rest = window.location.pathname.replace(/^\/robinhood\/?/i, '').replace(/\/+$/, '').toLowerCase();
  const m = rest.match(/^trade\/(\d+)$/);
  if (m) return { sub: 'trades', tradeId: parseInt(m[1], 10) };
  if (rest === 'post' || rest === 'trades' || rest === 'arbiters') return { sub: rest, tradeId: null };
  return { sub: 'book', tradeId: null };
}

interface OtcOrder {
  id: number;
  maker: string;
  side: number;
  makerXHandle: string;
  priceCentsPerEth: bigint;
  remainingEth: bigint;
  minEth: bigint;
  maxEth: bigint;
  active: boolean;
  cancelled: boolean;
}

interface OtcTrade {
  id: number;
  orderId: number;
  seller: string;
  buyer: string;
  sellerXHandle: string;
  buyerXHandle: string;
  ethAmount: bigint;
  expectedCents: bigint;
  openedAt: number;
  paidAt: number;
  status: number;
  paymentNote: string;
}

interface DisputeInfo {
  bond: bigint;
  openedAt: number;
  commitEnd: number;
  revealEnd: number;
  extensions: number;
  resolved: boolean;
  outcome: number;
  weightBuyerPaid: bigint;
  weightDidNotPay: bigint;
  revealers: number;
  evidence: { uri: string; by: string }[];
}

interface DripInfo { available?: boolean; amountWei?: string; reason?: string | null }

interface RobinhoodOtcProps {
  wallet: UserWallet;
  onConnectWallet: () => void;
  /** Verified handle from Sign in with X. Every handle this page writes on-chain is this one. */
  xHandle: string | null;
  xConfigured: boolean;
}

// --- exact money helpers -----------------------------------------------------
/** "3456.78" or "$3,456.78" -> 345678n cents. Null when it is not a dollar amount with at most 2 decimals. */
function parseUsdCents(s: string): bigint | null {
  const t = s.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(t) && !/^\.\d{1,2}$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  return BigInt(w || '0') * 100n + BigInt((f + '00').slice(0, 2));
}

/** Exact ETH string -> wei. Null for anything with more than 18 decimals or not a number. */
function parseEthWei(s: string): bigint | null {
  const t = s.trim();
  if (!/^\d+(\.\d{0,18})?$/.test(t) && !/^\.\d{1,18}$/.test(t)) return null;
  try { return parseEther(t.startsWith('.') ? `0${t}` : t); } catch { return null; }
}

function fmtCents(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  const whole = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${whole}.${(a % 100n).toString().padStart(2, '0')}`;
}

/** Exact ETH, every significant digit kept. */
const fmtEth = (wei: bigint) => formatEther(wei);

// Percent buttons. Keep a little ETH back for gas, and round down to 6 decimals so the amount reads cleanly.
const PCTS = [5, 10, 25, 50, 90] as const;
const GAS_KEEP_WEI = 50_000_000_000_000n; // 0.00005 ETH, several Robinhood Chain transactions
const pctOf = (base: bigint, pct: number) => {
  const raw = (base * BigInt(pct)) / 100n;
  return raw - (raw % 1_000_000_000_000n);
};

/** Dollars owed for `wei` at `priceCents` per ETH, rounded down to the cent (the contract stores the exact figure on the trade). */
const centsFor = (wei: bigint, priceCents: bigint) => (wei * priceCents) / WEI_PER_ETH;

const feeOf = (wei: bigint, feeBps: bigint) => (wei * feeBps) / 10000n;

/** RobinhoodEthOtc.bondFor: max(0.002 ETH, 5% of the trade). dispute() takes exactly this, no more, no less. */
const bondForWei = (wei: bigint) => { const pct = (wei * 500n) / 10000n; const min = 2n * 10n ** 15n; return pct > min ? pct : min; };

function fmtDur(sec: number): string {
  if (sec <= 0) return '0s';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}

const short = (a: string) => (a ? `${a.slice(0, 6)}...${a.slice(-4)}` : '');
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const cleanHandle = (h: string) => h.replace(/^@/, '').trim();

function pickAddr(...vals: any[]): string {
  for (const v of vals) {
    if (typeof v === 'string' && ADDR_RE.test(v) && v.toLowerCase() !== ZERO_ADDR) return v;
    if (v && typeof v === 'object' && typeof v.address === 'string' && ADDR_RE.test(v.address) && v.address.toLowerCase() !== ZERO_ADDR) return v.address;
  }
  return '';
}

function errMsg(e: any): string {
  if (e instanceof TxError) return e.message;
  const m = e?.shortMessage || e?.details || e?.message || String(e);
  if (/user rejected|denied transaction|rejected the request/i.test(m)) return 'You rejected the request in your wallet. Nothing was sent.';
  return m.length > 300 ? `${m.slice(0, 300)}...` : m;
}

const STATUS_LABEL: Record<number, string> = {
  [ROBINHOOD_OTC_STATUS.OPEN]: 'Waiting for the X Money payment',
  [ROBINHOOD_OTC_STATUS.PAID]: 'Buyer marked paid',
  [ROBINHOOD_OTC_STATUS.RELEASED]: 'Released to the buyer',
  [ROBINHOOD_OTC_STATUS.CLAIMED]: 'Claimed by the buyer',
  [ROBINHOOD_OTC_STATUS.CANCELLED_UNPAID]: 'Cancelled: not paid in time',
  [ROBINHOOD_OTC_STATUS.DISPUTED]: 'In dispute',
  [ROBINHOOD_OTC_STATUS.RESOLVED]: 'Resolved by arbiters',
};

const OUTCOME_LABEL: Record<number, string> = {
  1: 'Arbiters found the buyer paid. The ETH, minus the fee, went to the buyer. The seller\'s whole bond went to the arbiters who voted with the majority.',
  2: 'Arbiters found the buyer did not pay. The ETH went back to the seller (onto the sell order if the maker had not cancelled it), half the bond went to the majority arbiters and half back to the seller, and the buyer\'s address is now flagged.',
  3: 'No decision within 14 days of the dispute opening (the long-stop). The ETH went back to the seller (onto the sell order if the maker had not cancelled it), the whole bond went back to the seller, and the buyer was not flagged.',
};

const card = 'bg-[#0e121d] border border-[#1e2538] rounded-2xl p-4 sm:p-5 shadow-xl';
const input = 'w-full bg-[#090c14] border border-[#1e2538] rounded-xl px-3 py-2 text-sm font-mono text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500/60';
const btn = 'px-3 py-2 rounded-xl text-xs font-black font-mono uppercase tracking-wide cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const btnPrimary = `${btn} bg-emerald-500 hover:bg-emerald-400 text-slate-950`;
const btnGhost = `${btn} bg-[#121624] border border-[#1e2538] text-slate-300 hover:text-white`;
const btnWarn = `${btn} bg-amber-500 hover:bg-amber-400 text-slate-950`;
const btnDanger = `${btn} bg-rose-500 hover:bg-rose-400 text-slate-950`;

export const RobinhoodOtc: React.FC<RobinhoodOtcProps> = ({ wallet, onConnectWallet, xHandle, xConfigured }) => {
  const account = wallet.connected && wallet.address ? wallet.address : null;
  const handle = xHandle ? cleanHandle(xHandle) : '';

  const [sub, setSubState] = useState<SubTab>(() => parseSubRoute().sub);
  const [focusTradeId, setFocusTradeId] = useState<number | null>(() => parseSubRoute().tradeId);
  const setSub = (next: SubTab) => {
    setSubState(next);
    setFocusTradeId(null);
    const path = next === 'book' ? '/robinhood' : `/robinhood/${next}`;
    if (window.location.pathname !== path) window.history.pushState({ appTab: 'robinhood', rhSub: next }, '', path);
  };
  useEffect(() => {
    const onPop = () => {
      if (!/^\/robinhood(\/|$)/i.test(window.location.pathname)) return;
      const r = parseSubRoute();
      setSubState(r.sub);
      setFocusTradeId(r.tradeId);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // --- addresses -------------------------------------------------------------
  const [otcAddr, setOtcAddr] = useState<string>(CONTRACT_ADDRESSES.ROBINHOOD_OTC);
  const [arbAddr, setArbAddr] = useState<string>(CONTRACT_ADDRESSES.OTC_ARBITRATION);
  const [addrsLoaded, setAddrsLoaded] = useState(false);
  const [apiNote, setApiNote] = useState<string | null>(null);
  const [drip, setDrip] = useState<DripInfo | null>(null);

  const loadAddrs = useCallback(async () => {
    try {
      const res = await fetch('/api/robinhood/otc', { credentials: 'same-origin' });
      const type = res.headers.get('content-type') || '';
      if (!res.ok || !type.includes('application/json')) {
        setApiNote(`The host did not return desk addresses (/api/robinhood/otc answered ${res.status}).`);
        return;
      }
      const j = await res.json();
      const otc = pickAddr(j.otc, j.robinhoodOtc, j.escrow, j.address, j.contracts?.robinhoodOtc, j.addresses?.robinhoodOtc);
      const arb = pickAddr(j.arbitration, j.otcArbitration, j.contracts?.otcArbitration, j.addresses?.otcArbitration);
      setOtcAddr(otc || CONTRACT_ADDRESSES.ROBINHOOD_OTC);
      setArbAddr(arb || CONTRACT_ADDRESSES.OTC_ARBITRATION);
      setDrip(j.drip && typeof j.drip === 'object' ? j.drip : null);
      setApiNote(null);
    } catch {
      setApiNote('Could not reach the host for the desk addresses.');
    } finally {
      setAddrsLoaded(true);
    }
  }, []);
  useEffect(() => { loadAddrs(); }, [loadAddrs]);

  const deployed = ADDR_RE.test(otcAddr);

  // --- chain state -------------------------------------------------------------
  const [orders, setOrders] = useState<OtcOrder[]>([]);
  const [trades, setTrades] = useState<OtcTrade[]>([]);
  const [payWindow, setPayWindow] = useState(1800);
  const [releaseWindow, setReleaseWindow] = useState(43200);
  const [feeBps, setFeeBps] = useState(10n);
  const [longStop, setLongStop] = useState(LONG_STOP_FALLBACK);
  const [ethBal, setEthBal] = useState<bigint | null>(null);
  const [owed, setOwed] = useState<bigint>(0n);
  const [meFlagged, setMeFlagged] = useState(false);
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [bonds, setBonds] = useState<Record<number, bigint>>({});
  const [disputes, setDisputes] = useState<Record<number, DisputeInfo>>({});
  const [loading, setLoading] = useState(false);
  const [readErr, setReadErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => { const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000); return () => clearInterval(t); }, []);

  const refresh = useCallback(async () => {
    if (!deployed) return;
    const address = otcAddr as `0x${string}`;
    const abi = ROBINHOOD_OTC_ABI as unknown as Abi;
    const read = (functionName: string, args: any[] = []) => publicClient.readContract({ address, abi, functionName, args }) as Promise<any>;
    setLoading(true);
    try {
      const [oLen, tLen, pw, rw, fb, arbOnChain] = await Promise.all([
        read('ordersLength'), read('tradesLength'),
        read('PAY_WINDOW').catch(() => 1800n), read('RELEASE_WINDOW').catch(() => 43200n), read('FEE_BPS').catch(() => 10n),
        read('arbitration').catch(() => ''),
      ]);
      setPayWindow(Number(pw)); setReleaseWindow(Number(rw)); setFeeBps(BigInt(fb));
      if (!ADDR_RE.test(arbAddr) && typeof arbOnChain === 'string' && ADDR_RE.test(arbOnChain)) setArbAddr(arbOnChain);

      const pages = (len: number) => Array.from({ length: Math.ceil(len / PAGE) }, (_, i) => i * PAGE);
      const oN = Number(oLen), tN = Number(tLen);
      const [oPages, tPages] = await Promise.all([
        Promise.all(pages(oN).map(off => read('getOrders', [BigInt(off), BigInt(Math.min(PAGE, oN - off))]))),
        Promise.all(pages(tN).map(off => read('getTrades', [BigInt(off), BigInt(Math.min(PAGE, tN - off))]))),
      ]);
      const os: OtcOrder[] = [];
      oPages.forEach((pg: any[], pi) => pg.forEach((o: any, i: number) => os.push({
        id: pi * PAGE + i, maker: o.maker, side: Number(o.side), makerXHandle: o.makerXHandle,
        priceCentsPerEth: BigInt(o.priceCentsPerEth), remainingEth: BigInt(o.remainingEth),
        minEth: BigInt(o.minEth), maxEth: BigInt(o.maxEth), active: !!o.active, cancelled: !!o.cancelled,
      })));
      const ts: OtcTrade[] = [];
      tPages.forEach((pg: any[], pi) => pg.forEach((t: any, i: number) => ts.push({
        id: pi * PAGE + i, orderId: Number(t.orderId), seller: t.seller, buyer: t.buyer,
        sellerXHandle: t.sellerXHandle, buyerXHandle: t.buyerXHandle, ethAmount: BigInt(t.ethAmount),
        expectedCents: BigInt(t.expectedCents), openedAt: Number(t.openedAt), paidAt: Number(t.paidAt),
        status: Number(t.status), paymentNote: t.paymentNote,
      })));
      setOrders(os);
      setTrades(ts);

      const mine = account ? ts.filter(t => same(t.seller, account) || same(t.buyer, account)) : [];
      const people = new Set<string>();
      os.filter(o => o.active).forEach(o => people.add(o.maker.toLowerCase()));
      mine.forEach(t => { people.add(t.buyer.toLowerCase()); people.add(t.seller.toLowerCase()); });
      if (account) people.add(account.toLowerCase());
      const flagEntries = await Promise.all([...people].map(async p => [p, !!(await read('flagged', [p]).catch(() => false))] as const));
      const f: Record<string, boolean> = {};
      flagEntries.forEach(([p, v]) => { f[p] = v; });
      setFlags(f);

      if (account) {
        const [bal, ow] = await Promise.all([
          publicClient.getBalance({ address: account as `0x${string}` }).catch(() => null),
          read('ethOwed', [account]).catch(() => 0n),
        ]);
        setEthBal(bal); setOwed(BigInt(ow)); setMeFlagged(!!f[account.toLowerCase()]);

        const bondPairs = await Promise.all(mine.filter(t => t.status === ROBINHOOD_OTC_STATUS.PAID && same(t.seller, account))
          .map(async t => [t.id, BigInt(await read('bondFor', [t.ethAmount]))] as const));
        const b: Record<number, bigint> = {};
        bondPairs.forEach(([id, v]) => { b[id] = v; });
        setBonds(b);

        const arb = (ADDR_RE.test(arbAddr) ? arbAddr : (typeof arbOnChain === 'string' ? arbOnChain : '')) as `0x${string}`;
        if (ADDR_RE.test(arb)) {
          publicClient.readContract({ address: arb, abi: ARB_MIN_ABI, functionName: 'LONG_STOP' }).then(v => setLongStop(Number(v))).catch(() => {});
          const dPairs = await Promise.all(mine.filter(t => t.status === ROBINHOOD_OTC_STATUS.DISPUTED || t.status === ROBINHOOD_OTC_STATUS.RESOLVED)
            .map(async t => {
              const [d, ev] = await Promise.all([
                publicClient.readContract({ address: arb, abi: ARB_MIN_ABI, functionName: 'disputeOf', args: [BigInt(t.id)] }),
                publicClient.readContract({ address: arb, abi: ARB_MIN_ABI, functionName: 'evidenceOf', args: [BigInt(t.id)] }).catch(() => [[], []] as readonly [readonly string[], readonly `0x${string}`[]]),
              ]);
              const info: DisputeInfo = {
                bond: d[2], openedAt: Number(d[3]), commitEnd: Number(d[4]), revealEnd: Number(d[5]), extensions: Number(d[6]), resolved: d[7],
                outcome: Number(d[8]), weightBuyerPaid: d[9], weightDidNotPay: d[10], revealers: Number(d[11]),
                evidence: ev[0].map((uri, i) => ({ uri, by: ev[1][i] || '' })),
              };
              return [t.id, info] as const;
            }).map(p => p.catch(() => null)));
          const d: Record<number, DisputeInfo> = {};
          dPairs.forEach(p => { if (p) d[p[0]] = p[1]; });
          setDisputes(d);
        }
      } else {
        setEthBal(null); setOwed(0n); setMeFlagged(false);
      }
      setReadErr(null);
    } catch (e: any) {
      setReadErr(`Could not read the desk on Robinhood Chain: ${errMsg(e)}`);
    } finally {
      setLoading(false);
    }
  }, [deployed, otcAddr, arbAddr, account]);

  useEffect(() => {
    if (!deployed) return;
    refresh();
    const t = setInterval(refresh, 12000);
    return () => clearInterval(t);
  }, [deployed, refresh]);

  // --- tx plumbing -------------------------------------------------------------
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; hash?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async (label: string, to: string, abi: Abi | readonly unknown[], functionName: string, args: any[], valueWei?: bigint) => {
    if (!account) { onConnectWallet(); return false; }
    setBusy(label); setError(null); setNotice(null);
    try {
      const data = encodeFunctionData({ abi: abi as Abi, functionName, args });
      const { txHash } = await sendOnChainTx({ to, data, valueWei: valueWei ?? 0n, from: account, chainId: L3_CHAIN_ID, waitForConfirmation: true });
      setNotice({ text: `${label}: confirmed on Robinhood Chain.`, hash: txHash });
      await refresh();
      return true;
    } catch (e: any) {
      setError(`${label} failed: ${errMsg(e)}`);
      return false;
    } finally {
      setBusy(null);
    }
  };
  const sendOtc = (label: string, fn: string, args: any[], valueWei?: bigint) => send(label, otcAddr, ROBINHOOD_OTC_ABI as unknown as Abi, fn, args, valueWei);
  const sendArb = (label: string, fn: string, args: any[]) => send(label, arbAddr, ARB_MIN_ABI, fn, args);

  // --- gas drip ------------------------------------------------------------------
  const [dripState, setDripState] = useState<{ busy: boolean; msg: string | null; hash?: string }>({ busy: false, msg: null });
  const requestDrip = async () => {
    if (!account) return;
    setDripState({ busy: true, msg: null });
    try {
      const res = await fetch('/api/robinhood/gas/drip', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: account }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setDripState({ busy: false, msg: j.error || `The drip failed (${res.status}).`, hash: j.txHash || undefined }); return; }
      if (j.uncertain) { setDripState({ busy: false, msg: j.message || 'The drip was sent, but the node did not confirm it took it. Do not ask again; check the transaction.', hash: j.txHash }); setTimeout(refresh, 15000); return; }
      const amt = j.amountWei ? `${fmtEth(BigInt(j.amountWei))} ETH` : 'A little ETH';
      setDripState({ busy: false, msg: `${amt} is on its way to ${short(account)} for gas.`, hash: j.txHash });
      setTimeout(refresh, 6000);
    } catch (e: any) {
      setDripState({ busy: false, msg: `The drip failed: ${errMsg(e)}` });
    }
  };

  // --- derived -----------------------------------------------------------------
  const liveOrders = useMemo(() => orders.filter(o => o.active && !o.cancelled && o.remainingEth > 0n), [orders]);
  const sellOrders = useMemo(() => liveOrders.filter(o => o.side === ROBINHOOD_OTC_SIDE.SELL).sort((a, b) => (a.priceCentsPerEth < b.priceCentsPerEth ? -1 : a.priceCentsPerEth > b.priceCentsPerEth ? 1 : a.id - b.id)), [liveOrders]);
  const buyOrders = useMemo(() => liveOrders.filter(o => o.side === ROBINHOOD_OTC_SIDE.BUY).sort((a, b) => (a.priceCentsPerEth > b.priceCentsPerEth ? -1 : a.priceCentsPerEth < b.priceCentsPerEth ? 1 : a.id - b.id)), [liveOrders]);
  // Every order of mine that still holds something, including one that fills left below its minimum (inactive,
  // but a sell order's leftover ETH is still in it and only cancelOrder gives it back).
  const myOrders = useMemo(() => (account ? orders.filter(o => same(o.maker, account) && !o.cancelled && o.remainingEth > 0n) : []), [orders, account]);
  // The contract allows one trade in Open status per buyer address (BuyerBusy). An Open trade past its pay window
  // still counts until someone cancels it.
  const openTradeOfBuyer = useMemo(() => {
    const m: Record<string, OtcTrade> = {};
    trades.forEach(t => { if (t.status === ROBINHOOD_OTC_STATUS.OPEN) m[t.buyer.toLowerCase()] = t; });
    return m;
  }, [trades]);
  const myOpenBuy = account ? openTradeOfBuyer[account.toLowerCase()] || null : null;
  const myTrades = useMemo(() => (account ? trades.filter(t => same(t.seller, account) || same(t.buyer, account)).sort((a, b) => b.id - a.id) : []), [trades, account]);
  const actionable = myTrades.filter(t => t.status <= ROBINHOOD_OTC_STATUS.PAID || t.status === ROBINHOOD_OTC_STATUS.DISPUTED).length;
  const feePct = `${(Number(feeBps) / 100).toFixed(2)}%`;
  const payMin = Math.round(payWindow / 60);
  const releaseH = Math.round(releaseWindow / 3600);
  const needsGas = !!account && ethBal != null && ethBal < LOW_GAS_WEI;

  // --- take order ----------------------------------------------------------------
  const [taking, setTaking] = useState<OtcOrder | null>(null);
  const [takeAmt, setTakeAmt] = useState('');
  const takeBounds = (o: OtcOrder) => {
    const hi = o.maxEth < o.remainingEth ? o.maxEth : o.remainingEth;
    const lo = o.minEth < o.remainingEth ? o.minEth : o.remainingEth;
    return { lo, hi };
  };
  const openTake = (o: OtcOrder) => {
    setTaking(o);
    const { hi } = takeBounds(o);
    setTakeAmt(fmtEth(hi));
    setError(null);
  };
  const takeWei = parseEthWei(takeAmt);
  // Blocks the contract would enforce anyway (it reverts), checked here so the button says why instead.
  const takeBlock = (o: OtcOrder): string | null => {
    if (!o.active || o.cancelled) return 'This order is not active any more.';
    if (o.side === ROBINHOOD_OTC_SIDE.SELL) {
      if (meFlagged) return 'This address is flagged, and the contract does not let a flagged address buy ETH here.';
      if (myOpenBuy) return `You already have an open trade (#${myOpenBuy.id}). The contract allows one per buyer: mark it paid, or cancel it once its payment window has passed.`;
    } else {
      if (flags[o.maker.toLowerCase()]) return 'This buyer\'s address is flagged, so the contract does not let anyone sell ETH to it.';
      const busy = openTradeOfBuyer[o.maker.toLowerCase()];
      if (busy) return `This buyer already has an open trade (#${busy.id}), and the contract allows one at a time. Try again once it is paid or cancelled.`;
    }
    return null;
  };
  const takingLive = taking ? (orders[taking.id] ?? taking) : null;
  const takeErr = (() => {
    if (!takingLive) return null;
    const blocked = takeBlock(takingLive);
    if (blocked) return blocked;
    if (takeWei == null || takeWei <= 0n) return 'Enter an ETH amount (up to 18 decimals).';
    const { lo, hi } = takeBounds(takingLive);
    if (takeWei < lo) return `The minimum for this order is ${fmtEth(lo)} ETH.`;
    if (takeWei > hi) return `The maximum you can take is ${fmtEth(hi)} ETH.`;
    if (takingLive.side === ROBINHOOD_OTC_SIDE.BUY && ethBal != null && takeWei > ethBal) return `You have ${fmtEth(ethBal)} ETH on Robinhood Chain, less than ${fmtEth(takeWei)} ETH plus gas.`;
    return null;
  })();
  const submitTake = async () => {
    const o = takingLive;
    if (!o || takeWei == null || takeErr || !handle) return;
    const ok = o.side === ROBINHOOD_OTC_SIDE.SELL
      ? await sendOtc(`Take sell order #${o.id}`, 'takeSell', [BigInt(o.id), takeWei, handle])
      : await sendOtc(`Take buy order #${o.id}`, 'takeBuy', [BigInt(o.id), handle], takeWei);
    if (ok) { setTaking(null); setSub('trades'); }
  };

  // --- post order ----------------------------------------------------------------
  const [postSide, setPostSide] = useState<'sell' | 'buy'>('sell');
  const [postPrice, setPostPrice] = useState('');
  // Fair ETH/USD reference (median of public spot tickers, via the host). Prefills an empty price once.
  const [fair, setFair] = useState<{ usd: string; cents: bigint; method: string; at: number } | null>(null);
  const [fairUsed, setFairUsed] = useState(false);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const r = await fetch('/api/robinhood/eth-price');
        if (!r.ok) return;
        const j = await r.json();
        if (live && j?.cents) setFair({ usd: j.usd, cents: BigInt(j.cents), method: j.method, at: Date.parse(j.at) || Date.now() });
      } catch { /* keep the last value */ }
    };
    tick();
    const t = setInterval(tick, 30_000);
    return () => { live = false; clearInterval(t); };
  }, []);
  useEffect(() => {
    if (fair && !fairUsed && postPrice === '') { setPostPrice(fair.usd); setFairUsed(true); }
  }, [fair, fairUsed, postPrice]);
  /** "+1.23% vs fair" for a price in cents, or null without a reference. */
  const vsFair = (cents: bigint | null) => {
    if (!fair || cents == null || fair.cents <= 0n) return null;
    const bps = Number(((cents - fair.cents) * 10000n) / fair.cents);
    return `${bps >= 0 ? '+' : ''}${(bps / 100).toFixed(2)}% vs fair`;
  };
  const [postAmt, setPostAmt] = useState('');
  const [postMin, setPostMin] = useState('');
  const [postMax, setPostMax] = useState('');
  const pPrice = parseUsdCents(postPrice);
  const pAmt = parseEthWei(postAmt);
  const pMin = postMin.trim() ? parseEthWei(postMin) : pAmt;
  const pMax = postMax.trim() ? parseEthWei(postMax) : pAmt;
  const postErr = (() => {
    if (pPrice == null || pPrice <= 0n) return 'Enter a price in US dollars per 1 ETH, like 3456.78.';
    if (pAmt == null || pAmt <= 0n) return 'Enter an ETH amount (up to 18 decimals).';
    if (pMin == null || pMin <= 0n) return 'Enter a minimum fill above 0.';
    if (pMax == null || pMax <= 0n) return 'Enter a maximum fill above 0.';
    if (pMin > pMax) return 'The minimum fill is larger than the maximum.';
    if (pMax > pAmt) return 'The maximum fill is larger than the total amount.';
    if (centsFor(pMin, pPrice) < 1n) return 'The minimum fill is worth less than 1 cent at this price.';
    if (postSide === 'buy' && meFlagged) return 'This address is flagged, and the contract does not let a flagged address post a buy order.';
    if (postSide === 'sell' && ethBal != null && pAmt > ethBal) return `You have ${fmtEth(ethBal)} ETH on Robinhood Chain, less than ${fmtEth(pAmt)} ETH plus gas.`;
    return null;
  })();
  const submitPost = async () => {
    if (postErr || !handle || pPrice == null || pAmt == null || pMin == null || pMax == null) return;
    const ok = postSide === 'sell'
      ? await sendOtc('Post sell order', 'postSell', [handle, pPrice, pMin, pMax], pAmt)
      : await sendOtc('Post buy order', 'postBuy', [handle, pAmt, pPrice, pMin, pMax]);
    if (ok) { setPostAmt(''); setPostMin(''); setPostMax(''); setSub('book'); }
  };

  // --- per-trade inputs ------------------------------------------------------------
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [reasons, setReasons] = useState<Record<number, string>>({});
  const [evText, setEvText] = useState<Record<number, string>>({});
  const [evLink, setEvLink] = useState<Record<number, string>>({});
  const [evFile, setEvFile] = useState<Record<number, File | null>>({});
  const [copied, setCopied] = useState<number | null>(null);

  // The host takes one item per upload: JSON { tradeId, text } or { tradeId, image } (png, jpeg or webp, 2 MB max),
  // only for a trade in dispute, checks the signed-in X account is one side of it, and returns the uri for the chain.
  const uploadEvidence = async (tradeId: number, body: { text?: string; image?: string }): Promise<string> => {
    const res = await fetch('/api/robinhood/evidence', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tradeId, ...body }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `The host refused the upload (${res.status}).`);
    const uri = j.uri || j.url || j.path || '';
    if (!uri) throw new Error('The host did not return a link for the evidence.');
    if (bytesOf(uri) > MAX_URI_BYTES) throw new Error('The host returned a link longer than the contract accepts.');
    return uri;
  };

  const uploadAndSubmitEvidence = async (t: OtcTrade) => {
    if (!ADDR_RE.test(arbAddr)) { setError('The arbitration contract address is not known yet.'); return; }
    // Everything is checked before anything is uploaded, so a bad link can not strand an upload.
    const link = (evLink[t.id] || '').trim();
    const text = (evText[t.id] || '').trim();
    const file = evFile[t.id] || null;
    if (!link && !text && !file) { setError('Add a note, a screenshot or a link first.'); return; }
    if (link && !/^https?:\/\/\S+$/i.test(link)) { setError('The link must start with https:// or http://.'); return; }
    if (link && bytesOf(link) > MAX_URI_BYTES) { setError(`That link is ${bytesOf(link)} bytes; the contract takes at most ${MAX_URI_BYTES}. Remove the tracking part after "?" or upload a screenshot instead.`); return; }
    if (file && !/^image\/(png|jpeg|webp)$/.test(file.type)) { setError('Screenshots must be PNG, JPEG or WebP.'); return; }
    if (file && file.size > 2 * 1024 * 1024) { setError('That screenshot is over 2 MB. Crop or compress it and try again.'); return; }
    if (bytesOf(text) > 20 * 1024) { setError('The note is over 20 KB. Shorten it.'); return; }
    const items = (link ? 1 : 0) + (text ? 1 : 0) + (file ? 1 : 0);
    const mineSoFar = (disputes[t.id]?.evidence || []).filter(ev => same(ev.by, account)).length;
    if (mineSoFar + items > MAX_EVIDENCE_PER_PARTY) { setError(`Each side can add at most ${MAX_EVIDENCE_PER_PARTY} items to a dispute. You have ${MAX_EVIDENCE_PER_PARTY - mineSoFar} left.`); return; }
    const uris: string[] = [];
    if (link) uris.push(link);
    if (text || file) {
      setBusy(`Upload evidence for trade #${t.id}`); setError(null);
      try {
        if (file) {
          const image = await new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result));
            r.onerror = () => reject(new Error('Could not read the file.'));
            r.readAsDataURL(file);
          });
          uris.push(await uploadEvidence(t.id, { image }));
        }
        if (text) uris.push(await uploadEvidence(t.id, { text }));
      } catch (e: any) {
        setError(`Evidence upload failed: ${errMsg(e)}`);
        setBusy(null);
        return;
      }
      setBusy(null);
    }
    // One submitEvidence per item, so each shows up as its own entry for the arbiters.
    for (let i = 0; i < uris.length; i++) {
      const ok = await sendArb(`Submit evidence${uris.length > 1 ? ` ${i + 1} of ${uris.length}` : ''} for trade #${t.id}`, 'submitEvidence', [BigInt(t.id), uris[i]]);
      if (!ok) return;
    }
    setEvText(p => ({ ...p, [t.id]: '' })); setEvLink(p => ({ ...p, [t.id]: '' })); setEvFile(p => ({ ...p, [t.id]: null }));
  };

  // Scroll a deep-linked trade into view once it is loaded.
  useEffect(() => {
    if (sub !== 'trades' || focusTradeId == null) return;
    const el = document.getElementById(`rh-trade-${focusTradeId}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [sub, focusTradeId, trades.length]);

  // --- render helpers ---------------------------------------------------------------
  const txLink = (hash: string) => (
    <a href={`${EXPLORER}/tx/${hash}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-emerald-400 hover:underline">
      {short(hash)} <ExternalLink className="w-3 h-3" />
    </a>
  );
  const addrLink = (a: string) => (
    <a href={`${EXPLORER}/address/${a}`} target="_blank" rel="noreferrer" className="text-slate-400 hover:text-white hover:underline">{short(a)}</a>
  );
  const flagBadge = (a: string) => flags[a.toLowerCase()]
    ? <span className="ml-1 px-1.5 py-0.5 rounded text-[9px] font-black bg-rose-500/20 text-rose-300 border border-rose-500/40" title="This address lost a dispute as a buyer (arbiters found it did not pay).">FLAGGED</span>
    : null;

  const signInX = (
    xConfigured ? (
      <a href={xLoginUrl('/robinhood')} className={`${btn} bg-white text-black hover:bg-slate-200 inline-flex items-center gap-1.5`}>
        <span className="font-black">𝕏</span> Sign in with X
      </a>
    ) : (
      <span className="text-[11px] font-mono text-slate-500">Sign in with X is not configured on this host yet.</span>
    )
  );

  const orderRow = (o: OtcOrder) => {
    const { lo, hi } = takeBounds(o);
    const mine = !!account && same(o.maker, account);
    const block = !mine ? takeBlock(o) : null;
    const isSell = o.side === ROBINHOOD_OTC_SIDE.SELL;
    return (
      <div key={o.id} className="px-3 py-2.5 rounded-xl bg-[#0a0d16] border border-[#1a2133] font-mono text-xs space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <div className="min-w-[88px]">
            <div className="text-white font-black text-sm">{fmtCents(o.priceCentsPerEth)}</div>
            <div className="text-[10px] text-slate-500">per ETH{vsFair(o.priceCentsPerEth) ? <>, {vsFair(o.priceCentsPerEth)}</> : null}</div>
          </div>
          <div className="flex-1 min-w-[140px]">
            <div className="text-slate-200">{fmtEth(o.remainingEth)} ETH <span className="text-slate-500">{isSell ? 'left' : 'still wanted'}</span></div>
            <div className="text-[10px] text-slate-500">{o.active ? <>take {fmtEth(lo)} to {fmtEth(hi)} ETH</> : <>below the {fmtEth(o.minEth)} ETH minimum fill</>}</div>
          </div>
          <div className="min-w-[110px] text-[11px]">
            <div className="text-cyan-300">@{o.makerXHandle}{flagBadge(o.maker)}</div>
            <div className="text-[10px]">#{o.id} {addrLink(o.maker)}</div>
          </div>
          {mine ? (
            <button className={btnGhost} disabled={!!busy}
              onClick={() => sendOtc(`Cancel order #${o.id}`, 'cancelOrder', [BigInt(o.id)])}>
              {isSell ? `Cancel (${fmtEth(o.remainingEth)} ETH back)` : 'Cancel'}
            </button>
          ) : (
            <button className={btnPrimary} disabled={!!busy || !deployed || !!block} title={block || undefined} onClick={() => openTake(o)}>
              {isSell ? 'Buy ETH' : 'Sell ETH'}
            </button>
          )}
        </div>
        {mine && !o.active && (
          <div className="text-[10px] text-amber-300">
            {isSell
              ? `Nobody can take this order: the ${fmtEth(o.remainingEth)} ETH left is below your ${fmtEth(o.minEth)} ETH minimum fill. It stays in the escrow until you cancel; cancel to get it back. If an open trade on it is cancelled unpaid, that ETH comes back onto the order and it reopens.`
              : `Nobody can fill this order: the ${fmtEth(o.remainingEth)} ETH still wanted is below your ${fmtEth(o.minEth)} ETH minimum fill. Cancel to close it.`}
          </div>
        )}
        {block && !isSell && <div className="text-[10px] text-slate-500">{block}</div>}
      </div>
    );
  };

  const tradeCard = (t: OtcTrade) => {
    const iAmBuyer = same(t.buyer, account);
    const iAmSeller = same(t.seller, account);
    const payDeadline = t.openedAt + payWindow;
    const releaseDeadline = t.paidAt + releaseWindow;
    const fee = feeOf(t.ethAmount, feeBps);
    const net = t.ethAmount - fee;
    const memo = `xgas #${t.id}`;
    const dollars = fmtCents(t.expectedCents);
    const d = disputes[t.id];
    const bond = bonds[t.id];
    const focused = focusTradeId === t.id;
    const order = orders[t.orderId];
    const fromSellOrder = !order || order.side === ROBINHOOD_OTC_SIDE.SELL;
    const ethBackTo = fromSellOrder
      ? 'back onto the sell order (or to the maker, if they cancelled it)'
      : 'back to the seller who escrowed it';
    const payOpen = now <= payDeadline; // markPaid works while block time <= openedAt + PAY_WINDOW
    const releaseOpen = now <= releaseDeadline; // dispute works while block time <= paidAt + RELEASE_WINDOW
    const myEvidence = d ? d.evidence.filter(ev => same(ev.by, account)).length : 0;
    const longStopAt = d ? d.openedAt + longStop : 0;
    const tone = t.status === ROBINHOOD_OTC_STATUS.DISPUTED ? 'border-amber-500/50'
      : t.status <= ROBINHOOD_OTC_STATUS.PAID ? 'border-emerald-500/40' : 'border-[#1e2538]';
    return (
      <div key={t.id} id={`rh-trade-${t.id}`} className={`${card} ${tone} ${focused ? 'ring-2 ring-cyan-400/60' : ''} space-y-3 font-mono text-xs`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-white font-black text-sm">Trade #{t.id}</span>
          <span className="px-2 py-0.5 rounded-lg bg-[#121624] border border-[#1e2538] text-[10px] text-slate-300">{STATUS_LABEL[t.status] || `Status ${t.status}`}</span>
          <span className="text-[10px] text-slate-500">order #{t.orderId}</span>
          <span className="ml-auto text-[10px] text-slate-400">You are the {iAmBuyer ? 'buyer (you pay dollars, get ETH)' : 'seller (you get dollars, your ETH is escrowed)'}</span>
          <button className="p-1 rounded hover:bg-[#1a2033] text-slate-400 hover:text-white cursor-pointer" title="Copy a link to this trade"
            onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/robinhood/trade/${t.id}`).catch(() => {}); setCopied(t.id); setTimeout(() => setCopied(null), 1500); }}>
            {copied === t.id ? <CheckCircle className="w-3.5 h-3.5 text-emerald-400" /> : <Link2 className="w-3.5 h-3.5" />}
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="p-2 rounded-lg bg-[#0a0d16] border border-[#1a2133]"><div className="text-[10px] text-slate-500">ETH escrowed</div><div className="text-white">{fmtEth(t.ethAmount)}</div></div>
          <div className="p-2 rounded-lg bg-[#0a0d16] border border-[#1a2133]"><div className="text-[10px] text-slate-500">Dollars on X Money</div><div className="text-white">{dollars}</div></div>
          <div className="p-2 rounded-lg bg-[#0a0d16] border border-[#1a2133]"><div className="text-[10px] text-slate-500">Buyer gets ({feePct} fee)</div><div className="text-white">{fmtEth(net)} ETH</div></div>
          <div className="p-2 rounded-lg bg-[#0a0d16] border border-[#1a2133]"><div className="text-[10px] text-slate-500">Parties</div><div className="text-cyan-300 truncate">@{t.buyerXHandle} pays @{t.sellerXHandle}</div></div>
        </div>
        {t.status <= ROBINHOOD_OTC_STATUS.PAID && (
          <div className="text-[10px] text-slate-500">
            The contract does not verify these handles: whoever opened the order or the trade typed them. {iAmSeller ? `Release only for a payment from exactly @${t.buyerXHandle} with the memo ${memo}. A payment from anyone else, even for the right amount, is not this trade.` : `Pay exactly @${t.sellerXHandle} with the memo ${memo}.`}
          </div>
        )}

        {t.status === ROBINHOOD_OTC_STATUS.OPEN && (
          <div className="space-y-2">
            <div className={`p-3 rounded-xl border ${payOpen ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-rose-500/10 border-rose-500/30'}`}>
              {iAmBuyer ? (
                <div className="text-sm text-white font-bold">Send {dollars} on X Money to @{t.sellerXHandle}, memo {memo}</div>
              ) : (
                <div className="text-sm text-white font-bold">Wait for {dollars} on X Money from @{t.buyerXHandle}, memo {memo}</div>
              )}
              <div className="flex items-center gap-1.5 mt-1 text-[11px] text-slate-300">
                <Clock className="w-3.5 h-3.5" />
                {payOpen
                  ? <>Payment window: {fmtDur(payDeadline - now)} left of {payMin} minutes.</>
                  : <>The {payMin} minute payment window has passed without a payment mark. Anyone can cancel it, and the ETH goes {ethBackTo}. No one is penalised for an unpaid trade.</>}
              </div>
            </div>
            {iAmBuyer && payOpen && (
              <div className="flex flex-col sm:flex-row gap-2">
                <input className={input} placeholder={`Payment note (optional), e.g. X Money confirmation for ${memo}`} maxLength={140}
                  value={notes[t.id] ?? ''} onChange={e => setNotes(p => ({ ...p, [t.id]: e.target.value }))} />
                <button className={btnPrimary} disabled={!!busy || bytesOf(notes[t.id] ?? '') > 280}
                  onClick={() => { if (window.confirm(`Only mark paid after ${dollars} has left your X Money account to @${t.sellerXHandle}. Marking paid without paying lets the seller dispute, and if arbiters find you did not pay, your address is flagged. Continue?`)) sendOtc(`Mark trade #${t.id} paid`, 'markPaid', [BigInt(t.id), (notes[t.id] || memo).slice(0, 140)]); }}>
                  I sent it: mark paid
                </button>
              </div>
            )}
            {iAmBuyer && !payOpen && (
              <div className="text-[11px] text-rose-300">The payment window has closed, so this trade can no longer be marked paid. Do not send the dollars now. If you already sent them, contact @{t.sellerXHandle}: only the seller can still release.</div>
            )}
            {iAmSeller && (
              <div className="flex flex-wrap items-center gap-2">
                <button className={btnWarn} disabled={!!busy}
                  onClick={() => { if (window.confirm(`Release sends ${fmtEth(net)} ETH to the buyer now (plus the ${feePct} fee out of the ${fmtEth(t.ethAmount)} ETH) and cannot be undone. Only release if ${dollars} from @${t.buyerXHandle} is already in your X Money balance. Release?`)) sendOtc(`Release trade #${t.id}`, 'release', [BigInt(t.id)]); }}>
                  Release early
                </button>
                <span className="text-[10px] text-slate-500">Only if the dollars already arrived. Release cannot be undone.</span>
              </div>
            )}
            {!payOpen && (
              <button className={btnGhost} disabled={!!busy} onClick={() => sendOtc(`Cancel unpaid trade #${t.id}`, 'cancelUnpaid', [BigInt(t.id)])}>Cancel unpaid trade</button>
            )}
          </div>
        )}

        {t.status === ROBINHOOD_OTC_STATUS.PAID && (
          <div className="space-y-2">
            <div className="p-3 rounded-xl border bg-cyan-500/10 border-cyan-500/30 space-y-1">
              <div className="text-white font-bold">@{t.buyerXHandle} says {dollars} was sent to @{t.sellerXHandle} (memo {memo}).</div>
              {t.paymentNote && <div className="text-[11px] text-slate-300">Payment note: <span className="text-white break-all">{t.paymentNote}</span></div>}
              <div className="flex items-center gap-1.5 text-[11px] text-slate-300">
                <Clock className="w-3.5 h-3.5" />
                {releaseOpen
                  ? <>Release window: {fmtDur(releaseDeadline - now)} left of {releaseH} hours. The seller can release or dispute until then; after it, the buyer can claim.</>
                  : <>The {releaseH} hour release window has passed with no dispute. The buyer can claim now; the seller can still release.</>}
              </div>
            </div>
            {iAmSeller && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <button className={btnPrimary} disabled={!!busy}
                    onClick={() => { if (window.confirm(`Release sends ${fmtEth(net)} ETH to @${t.buyerXHandle} now and cannot be undone. Only release if ${dollars} is in your X Money balance. Release?`)) sendOtc(`Release trade #${t.id}`, 'release', [BigInt(t.id)]); }}>
                    Dollars arrived: release
                  </button>
                </div>
                {releaseOpen && (
                  <div className="p-3 rounded-xl bg-amber-500/5 border border-amber-500/30 space-y-2">
                    <div className="text-[11px] text-amber-200 space-y-1">
                      <div>
                        Did not get {dollars}? Open a dispute before the window ends, or the buyer can claim the ETH. You post a bond of exactly {bond != null ? `${fmtEth(bond)} ETH` : 'the larger of 0.002 ETH and 5% of the trade'}.
                        Staked arbiters vote in secret for 24 hours, then reveal for 24 hours. A tie or fewer than 3 revealers starts another 24h + 24h round, again and again, each only once someone calls resolve.
                      </div>
                      <div>
                        If they find the buyer paid: the buyer gets the ETH and the whole bond goes to the arbiters. If they find the buyer did not pay: the ETH goes {ethBackTo}, half the bond comes back to you, half pays the arbiters, and the buyer is flagged.
                        If there is still no decision {Math.round(longStop / 86400)} days after the dispute opens: the ETH and the whole bond come back to you and the buyer is not flagged.
                      </div>
                      <div className="text-slate-400">
                        Only the two trade addresses are barred from voting. Stake counts on a dispute only if it was in place 3 days before the dispute opened, and weight is the stake, so the side with more eligible stake decides. A buyer or seller who staked from other addresses early enough can vote on their own dispute.
                      </div>
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <input className={input} placeholder="Reason, e.g. no payment from this handle in my X Money history" maxLength={280}
                        value={reasons[t.id] ?? ''} onChange={e => setReasons(p => ({ ...p, [t.id]: e.target.value }))} />
                      <button className={btnDanger} disabled={!!busy || bond == null || !(reasons[t.id] || '').trim() || (ethBal != null && bond != null && ethBal < bond)}
                        onClick={() => { if (bond != null && window.confirm(`Dispute trade #${t.id} with a bond of exactly ${fmtEth(bond)} ETH? You lose all of it if arbiters find the buyer paid, and half of it if they find the buyer did not pay.`)) sendOtc(`Dispute trade #${t.id}`, 'dispute', [BigInt(t.id), (reasons[t.id] || '').trim()], bond); }}>
                        Dispute ({bond != null ? `${fmtEth(bond)} ETH bond` : 'reading bond'})
                      </button>
                    </div>
                    {ethBal != null && bond != null && ethBal < bond && <div className="text-[11px] text-rose-300">You have {fmtEth(ethBal)} ETH on Robinhood Chain, less than the {fmtEth(bond)} ETH bond plus gas.</div>}
                  </div>
                )}
              </div>
            )}
            {iAmBuyer && (
              !releaseOpen ? (
                <button className={btnPrimary} disabled={!!busy} onClick={() => sendOtc(`Claim trade #${t.id}`, 'claim', [BigInt(t.id)])}>Claim {fmtEth(net)} ETH</button>
              ) : (
                <div className="text-[11px] text-slate-400">If the seller neither releases nor disputes, you can claim {fmtEth(net)} ETH in {fmtDur(releaseDeadline - now + 1)}.</div>
              )
            )}
          </div>
        )}

        {(t.status === ROBINHOOD_OTC_STATUS.DISPUTED || t.status === ROBINHOOD_OTC_STATUS.RESOLVED) && (
          <div className="space-y-2">
            {d ? (
              <div className="p-3 rounded-xl bg-amber-500/5 border border-amber-500/30 space-y-1 text-[11px] text-slate-300">
                <div className="flex items-center gap-1.5 text-amber-200 font-bold"><Gavel className="w-3.5 h-3.5" /> Dispute{d.extensions > 0 ? ` (round ${d.extensions + 1})` : ''}: seller bond {fmtEth(d.bond)} ETH</div>
                {d.resolved || t.status === ROBINHOOD_OTC_STATUS.RESOLVED ? (
                  <div className="text-white">{OUTCOME_LABEL[d.outcome] || 'Resolved.'}</div>
                ) : now <= d.commitEnd ? (
                  <div>Arbiters are committing sealed votes: {fmtDur(d.commitEnd - now)} left, then 24 hours to reveal.</div>
                ) : now <= d.revealEnd ? (
                  <div>Arbiters are revealing votes: {fmtDur(d.revealEnd - now)} left. Revealed so far: {d.revealers} ({fmtEth(d.weightBuyerPaid)} ETH weight for "buyer paid", {fmtEth(d.weightDidNotPay)} for "did not pay").</div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <span>
                      Voting is over. Anyone can call resolve now.{' '}
                      {now < longStopAt
                        ? 'With 3 or more revealers and one side ahead on weight it settles; otherwise it starts another 24h + 24h round.'
                        : 'The long-stop has passed: without a decision it ends with the ETH and the bond back to the seller.'}
                    </span>
                    <button className={btnWarn} disabled={!!busy || !ADDR_RE.test(arbAddr)} onClick={() => sendArb(`Resolve dispute on trade #${t.id}`, 'resolve', [BigInt(t.id)])}>Resolve</button>
                  </div>
                )}
                {!d.resolved && t.status === ROBINHOOD_OTC_STATUS.DISPUTED && (
                  <div className="text-slate-500">
                    Long-stop: {new Date(longStopAt * 1000).toLocaleString()}. No decision by then means the ETH and the whole bond go back to the seller and the buyer is not flagged. Each round only moves on when someone calls resolve, so it can run past that time by up to one round.
                  </div>
                )}
                {d.evidence.length > 0 && (
                  <div className="pt-1 space-y-0.5">
                    <div className="text-slate-500">Evidence on-chain:</div>
                    {d.evidence.map((ev, i) => (
                      <div key={i} className="break-all">
                        <span className="text-slate-500">{same(ev.by, t.buyer) ? 'buyer' : same(ev.by, t.seller) ? 'seller' : short(ev.by)}: </span>
                        {/^https?:\/\//i.test(ev.uri) || /^\/api\/robinhood\/evidence\/[A-Za-z0-9._-]+$/.test(ev.uri)
                          ? <a href={ev.uri} target="_blank" rel="noreferrer noopener" className="text-cyan-300 hover:underline">{/\.txt$/i.test(ev.uri) ? 'text note ' : ''}{ev.uri}</a>
                          : <span className="text-white">{ev.uri}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-[11px] text-slate-400">{ADDR_RE.test(arbAddr) ? 'Reading the dispute from the arbitration contract...' : 'The arbitration contract address is not known yet.'}</div>
            )}
            {t.status === ROBINHOOD_OTC_STATUS.DISPUTED && d && !d.resolved && (iAmBuyer || iAmSeller) && (
              <div className="p-3 rounded-xl bg-[#0a0d16] border border-[#1a2133] space-y-2">
                <div className="text-[11px] text-slate-300 flex items-center gap-1.5"><Upload className="w-3.5 h-3.5" /> Add evidence for the arbiters: a screenshot of the X Money payment (or of its absence), with the memo {memo} visible. PNG, JPEG or WebP up to 2 MB, notes up to 20 KB, links up to {MAX_URI_BYTES} bytes. Each item is its own transaction, and it is public. You have {Math.max(0, MAX_EVIDENCE_PER_PARTY - myEvidence)} of {MAX_EVIDENCE_PER_PARTY} items left.</div>
                <div className="text-[10px] text-slate-500">Only the two trade addresses are barred from voting. Stake counts on this dispute only if it was in place 3 days before it opened, and the side with more eligible stake decides.</div>
                <textarea className={`${input} min-h-[60px]`} placeholder="What happened, in a few lines" maxLength={1000}
                  value={evText[t.id] ?? ''} onChange={e => setEvText(p => ({ ...p, [t.id]: e.target.value }))} />
                <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
                  <input type="file" accept="image/png,image/jpeg,image/webp" className="text-[11px] text-slate-400 file:mr-2 file:px-2 file:py-1 file:rounded-lg file:border-0 file:bg-[#121624] file:text-slate-200"
                    onChange={e => setEvFile(p => ({ ...p, [t.id]: e.target.files?.[0] || null }))} />
                  <input className={input} placeholder="or paste a link instead (https://...)" maxLength={MAX_URI_BYTES} value={evLink[t.id] ?? ''} onChange={e => setEvLink(p => ({ ...p, [t.id]: e.target.value }))} />
                  <button className={btnPrimary} disabled={!!busy || myEvidence >= MAX_EVIDENCE_PER_PARTY || bytesOf((evLink[t.id] || '').trim()) > MAX_URI_BYTES} onClick={() => uploadAndSubmitEvidence(t)}>Submit evidence</button>
                </div>
                {bytesOf((evLink[t.id] || '').trim()) > MAX_URI_BYTES && <div className="text-[11px] text-rose-300">That link is over {MAX_URI_BYTES} bytes, the most the contract accepts.</div>}
              </div>
            )}
          </div>
        )}

        {(t.status === ROBINHOOD_OTC_STATUS.RELEASED || t.status === ROBINHOOD_OTC_STATUS.CLAIMED) && (
          <div className="text-[11px] text-emerald-300 flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5" /> Done. {fmtEth(net)} ETH went to the buyer and {fmtEth(fee)} ETH was the fee.</div>
        )}
        {t.status === ROBINHOOD_OTC_STATUS.CANCELLED_UNPAID && (
          <div className="text-[11px] text-slate-400">Cancelled after the payment window with no payment mark. The {fmtEth(t.ethAmount)} ETH went {ethBackTo}. No fee was charged.</div>
        )}
        <div className="text-[10px] text-slate-600">buyer {addrLink(t.buyer)}{flagBadge(t.buyer)} · seller {addrLink(t.seller)}{flagBadge(t.seller)}</div>
      </div>
    );
  };

  // --- render ------------------------------------------------------------------
  return (
    <div className="space-y-4">
      <div className="relative overflow-hidden rounded-2xl border border-emerald-500/30 bg-gradient-to-r from-[#0d121f] via-[#090e18] to-[#0a1a14] p-4 sm:p-5 shadow-2xl space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <ArrowDownUp className="w-5 h-5 text-emerald-400" />
          <h2 className="text-lg sm:text-xl font-black text-white font-display tracking-tight">Robinhood desk: X Money dollars for ETH</h2>
          <span className="px-1.5 py-0.5 rounded text-[10px] font-black bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 font-mono">Robinhood Chain #{L3_CHAIN_ID}</span>
        </div>
        <p className="text-xs sm:text-sm text-slate-300 max-w-3xl">
          Trade US dollars on X Money (payments inside the X app, X account to X account) for native ETH on Robinhood Chain, peer to peer, either direction.
          The ETH is escrowed in a contract with no admin; the dollars move off-chain, so every trade has a payment window, an optimistic release and a staked-arbiter dispute path.
          This is not the $xMoney token.
        </p>
        <div className="flex flex-wrap gap-1.5 text-[10px] font-mono">
          <span className="px-2 py-1 rounded-lg bg-[#121624] border border-[#1e2538] text-slate-300">Fee: {feePct} of the ETH the buyer receives, all of it to the Fee Fanout as WETH</span>
          <span className="px-2 py-1 rounded-lg bg-[#121624] border border-[#1e2538] text-slate-300">Pay window: {payMin} min</span>
          <span className="px-2 py-1 rounded-lg bg-[#121624] border border-[#1e2538] text-slate-300">Release window: {releaseH} h</span>
          <span className="px-2 py-1 rounded-lg bg-[#121624] border border-[#1e2538] text-slate-300">Dispute bond: exactly the larger of 0.002 ETH and 5% of the trade</span>
          <span className="px-2 py-1 rounded-lg bg-[#121624] border border-[#1e2538] text-slate-300">One open trade per buyer address</span>
          <span className="px-2 py-1 rounded-lg bg-[#121624] border border-[#1e2538] text-slate-300">Plus Robinhood Chain gas on every transaction</span>
        </div>
      </div>

      {/* identity + wallet strip */}
      <div className={`${card} flex flex-wrap items-center gap-3 font-mono text-xs`}>
        <div className="flex items-center gap-2">
          <ShieldCheck className={`w-4 h-4 ${handle ? 'text-emerald-400' : 'text-slate-500'}`} />
          {handle ? <span className="text-emerald-300">Trading as @{handle} <span className="text-slate-500">(verified with X, locked)</span></span> : <>{signInX}<span className="text-slate-500">required to post or take orders</span></>}
        </div>
        <div className="flex items-center gap-2">
          <Wallet className="w-4 h-4 text-slate-400" />
          {account ? (
            <span className="text-slate-300">{short(account)}: {ethBal != null ? `${fmtEth(ethBal)} ETH` : '...'} on Robinhood Chain</span>
          ) : (
            <button className={btnPrimary} onClick={onConnectWallet}>Connect wallet</button>
          )}
          {account && <button className={btnGhost} onClick={() => switchNetwork(L3_CHAIN_ID)}>Switch to #{L3_CHAIN_ID}</button>}
        </div>
        {owed > 0n && (
          <div className="flex items-center gap-2 px-2 py-1 rounded-xl bg-emerald-500/10 border border-emerald-500/30">
            <span className="text-emerald-200">{fmtEth(owed)} ETH is waiting for you (a direct transfer failed, so it was credited)</span>
            <button className={btnPrimary} disabled={!!busy} onClick={() => sendOtc('Withdraw owed ETH', 'withdrawEth', [])}>Withdraw</button>
          </div>
        )}
        {needsGas && handle && (
          <div className="flex flex-wrap items-center gap-2 px-2 py-1 rounded-xl bg-cyan-500/10 border border-cyan-500/30">
            <Droplet className="w-3.5 h-3.5 text-cyan-300" />
            <span className="text-cyan-100">No ETH for gas? Buyers can ask for a one-time sponsored drip{drip?.amountWei ? ` of ${fmtEth(BigInt(drip.amountWei))} ETH` : ''}.</span>
            <button className={btnGhost} disabled={dripState.busy || drip?.available === false} onClick={requestDrip}>{dripState.busy ? 'Sending...' : 'Get gas'}</button>
            {drip?.available === false && drip.reason && <span className="text-slate-400">{drip.reason}</span>}
          </div>
        )}
        {dripState.msg && <div className="basis-full text-[11px] text-cyan-200">{dripState.msg} {dripState.hash && txLink(dripState.hash)}</div>}
        {meFlagged && (
          <div className="basis-full flex items-start gap-1.5 text-rose-300 text-[11px]"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> This address is flagged on the desk: arbiters found it did not pay as a buyer. The flag is permanent. The contract no longer lets it buy ETH (take a sell order or post a buy order), and nobody can take a buy order it posted. It can still sell ETH, and everyone sees the flag.</div>
        )}
        {myOpenBuy && !meFlagged && (
          <div className="basis-full flex items-start gap-1.5 text-amber-200 text-[11px]"><Clock className="w-3.5 h-3.5 shrink-0 mt-0.5" /> You have an open trade as the buyer (#{myOpenBuy.id}). The contract allows one per buyer address, so you cannot buy on another order until it is marked paid, released or cancelled.</div>
        )}
        <button className={`${btnGhost} ml-auto inline-flex items-center gap-1`} onClick={() => { loadAddrs(); refresh(); }} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {(notice || error || busy) && (
        <div className="space-y-1 font-mono text-xs">
          {busy && <div className="px-3 py-2 rounded-xl bg-[#121624] border border-[#1e2538] text-slate-200 flex items-center gap-2"><RefreshCw className="w-3.5 h-3.5 animate-spin" /> {busy}: confirm in your wallet, then wait for Robinhood Chain.</div>}
          {notice && <div className="px-3 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-200">{notice.text} {notice.hash && txLink(notice.hash)}</div>}
          {error && <div className="px-3 py-2 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200 break-words">{error}</div>}
        </div>
      )}

      <div className="flex gap-1.5 overflow-x-auto no-scrollbar [&>*]:shrink-0">
        {SUB_TABS.map(s => (
          <button key={s.id} onClick={() => setSub(s.id)}
            className={`px-3 py-1.5 rounded-xl text-[11px] font-black font-mono uppercase tracking-wide cursor-pointer transition-colors ${sub === s.id ? 'bg-cyan-400 text-slate-950' : 'bg-[#121624] border border-[#1e2538] text-slate-400 hover:text-white'}`}>
            {s.label}{s.id === 'trades' && actionable > 0 ? ` (${actionable})` : ''}
          </button>
        ))}
      </div>

      {sub === 'arbiters' ? (
        <RobinhoodArbiters account={account} otcAddress={deployed ? otcAddr : ''} arbitrationAddress={ADDR_RE.test(arbAddr) ? arbAddr : ''} />
      ) : !deployed ? (
        <div className={`${card} font-mono text-xs space-y-2`}>
          <div className="flex items-center gap-2 text-amber-300 font-black text-sm"><Lock className="w-4 h-4" /> Not deployed yet</div>
          <p className="text-slate-300">The escrow (RobinhoodEthOtc) and the arbitration contract (OtcArbitration) are not on Robinhood Chain yet, so nothing can be posted or taken. This page goes live on its own once the addresses are published.</p>
          {addrsLoaded && apiNote && <p className="text-slate-500">{apiNote}</p>}
        </div>
      ) : readErr && orders.length === 0 && trades.length === 0 ? (
        <div className={`${card} font-mono text-xs text-rose-200`}>{readErr}</div>
      ) : sub === 'book' ? (
        <div className="space-y-4">
          {readErr && <div className="text-[11px] font-mono text-amber-300">{readErr} Showing the last good read.</div>}
          <div className="grid lg:grid-cols-2 gap-4">
            <div className={`${card} space-y-2`}>
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-black text-white font-mono">Sell ETH for X Money dollars</h3>
                <span className="text-[10px] text-slate-500 font-mono">{sellOrders.length} order{sellOrders.length === 1 ? '' : 's'}, cheapest first</span>
              </div>
              <p className="text-[11px] text-slate-400 font-mono">These makers escrowed ETH and want dollars. Take one to buy ETH: you then have {payMin} minutes to pay them on X Money.</p>
              {account && (meFlagged || myOpenBuy) && <p className="text-[11px] text-amber-300 font-mono">{meFlagged ? 'This address is flagged, so the contract does not let it buy here.' : `You have an open trade (#${myOpenBuy!.id}); the contract allows one per buyer.`}</p>}
              {sellOrders.length === 0 ? <div className="text-[11px] text-slate-500 font-mono py-3">No ETH for sale right now. Post a buy order instead.</div> : sellOrders.map(orderRow)}
            </div>
            <div className={`${card} space-y-2`}>
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-black text-white font-mono">Buy ETH with X Money dollars</h3>
                <span className="text-[10px] text-slate-500 font-mono">{buyOrders.length} order{buyOrders.length === 1 ? '' : 's'}, best price first</span>
              </div>
              <p className="text-[11px] text-slate-400 font-mono">These makers pay dollars and want ETH. Take one to sell ETH: you escrow the ETH, they have {payMin} minutes to pay you.</p>
              {buyOrders.length === 0 ? <div className="text-[11px] text-slate-500 font-mono py-3">No buyers right now. Post a sell order instead.</div> : buyOrders.map(orderRow)}
            </div>
          </div>
          <p className="text-[10px] text-slate-500 font-mono px-1">Handles on the book are typed by the address that posted them; the contract does not verify them. This page only writes the handle you signed in with, but an order placed straight on the contract can carry any handle. Pay, or release, only for exactly the handle and memo shown on the trade.</p>
          {myOrders.length > 0 && (
            <div className={`${card} space-y-2`}>
              <h3 className="text-sm font-black text-white font-mono">My orders</h3>
              <p className="text-[11px] text-slate-400 font-mono">Cancelling a sell order refunds the ETH it still holds, including a leftover below your minimum fill. ETH in open trades stays until each trade finishes; if one ends with the ETH back to you after you cancelled, it is sent to your address instead of the order.</p>
              {myOrders.map(orderRow)}
            </div>
          )}
          <div className={`${card} font-mono text-[11px] text-slate-400 space-y-1`}>
            <div className="text-white font-black text-xs">How a trade runs</div>
            <div>1. A taker opens a trade on an order. The seller's ETH is locked in the escrow for it.</div>
            <div>2. The buyer sends the exact dollar amount on X Money to the seller's X handle with the memo "xgas #tradeId", then marks paid. They have {payMin} minutes; after that anyone can cancel, and the ETH goes back onto the sell order (or back to the seller, on a buy order). A buyer address can hold one open trade at a time.</div>
            <div>3. The seller releases once the dollars arrive. If the seller does nothing for {releaseH} hours after the paid mark, the buyer claims the ETH, so a seller has to check X Money and be able to dispute within {releaseH} hours of every paid mark.</div>
            <div>4. If the dollars never came, the seller disputes within those {releaseH} hours with a bond of exactly the larger of 0.002 ETH and 5%. Staked arbiters vote (commit, then reveal): at least 48 hours, longer with each extra round after a tie or too few votes, and each stage waits for someone (anyone) to call resolve. No decision {Math.round(longStop / 86400)} days after it opened returns the ETH and the bond to the seller. Each trade card spells out who gets what.</div>
            <div>The buyer receives the ETH minus {feePct}, and all of that fee goes to the Fee Fanout. Arbiters are paid only out of the seller's bond. Sellers pay no desk fee. X Money's own terms apply to the dollar payment; this desk never touches it.</div>
          </div>
        </div>
      ) : sub === 'post' ? (
        <div className={`${card} space-y-3 max-w-2xl font-mono text-xs`}>
          <div className="flex gap-1.5">
            <button onClick={() => setPostSide('sell')} className={`${btn} ${postSide === 'sell' ? 'bg-emerald-500 text-slate-950' : 'bg-[#121624] border border-[#1e2538] text-slate-400'}`}>Sell ETH for X Money dollars</button>
            <button onClick={() => setPostSide('buy')} className={`${btn} ${postSide === 'buy' ? 'bg-emerald-500 text-slate-950' : 'bg-[#121624] border border-[#1e2538] text-slate-400'}`}>Buy ETH with X Money dollars</button>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="space-y-1"><span className="text-slate-400">Price, US dollars per 1 ETH</span><input className={input} inputMode="decimal" placeholder={fair ? fair.usd : '3456.78'} value={postPrice} onChange={e => setPostPrice(e.target.value)} />
              {fair ? (
                <span className="block text-[10px] text-slate-500">
                  Fair price ${fair.usd} ({fair.method}, {Math.max(0, now - Math.floor(fair.at / 1000))} s ago){vsFair(parseUsdCents(postPrice)) ? <>. Yours: <span className="text-slate-300">{vsFair(parseUsdCents(postPrice))}</span></> : null}
                  {' '}<button type="button" className="underline text-cyan-400" onClick={() => setPostPrice(fair.usd)}>use fair price</button>
                </span>
              ) : <span className="block text-[10px] text-slate-500">Loading a fair price reference…</span>}
            </label>
            <label className="space-y-1"><span className="text-slate-400">{postSide === 'sell' ? 'ETH to sell (escrowed now)' : 'ETH wanted'}</span><input className={input} inputMode="decimal" placeholder="0.5" value={postAmt} onChange={e => setPostAmt(e.target.value)} />
              {postSide === 'sell' && ethBal != null && (
                <span className="flex flex-wrap gap-1 pt-1">
                  {PCTS.map(p => {
                    const spendable = ethBal > GAS_KEEP_WEI ? ethBal - GAS_KEEP_WEI : 0n;
                    const v = pctOf(spendable, p);
                    return <button key={p} type="button" disabled={v <= 0n} onClick={() => setPostAmt(fmtEth(v))} className="px-2 py-0.5 rounded-md bg-[#121624] border border-[#1e2538] text-[10px] text-slate-300 hover:border-emerald-500 disabled:opacity-40">{p}%</button>;
                  })}
                  <span className="text-[10px] text-slate-500 self-center">of your ETH, keeping {fmtEth(GAS_KEEP_WEI)} for gas</span>
                </span>
              )}
            </label>
            <label className="space-y-1"><span className="text-slate-400">Minimum per trade, ETH</span><input className={input} inputMode="decimal" placeholder={postAmt || '0.05'} value={postMin} onChange={e => setPostMin(e.target.value)} /></label>
            <label className="space-y-1"><span className="text-slate-400">Maximum per trade, ETH</span><input className={input} inputMode="decimal" placeholder={postAmt || '0.5'} value={postMax} onChange={e => setPostMax(e.target.value)} /></label>
          </div>
          <div className="text-[11px] text-slate-500">Leave min or max empty to use the full amount.</div>
          {!postErr && pPrice != null && pAmt != null && pMin != null && pMax != null && (
            <div className="p-3 rounded-xl bg-[#0a0d16] border border-[#1a2133] space-y-1 text-[11px] text-slate-300">
              <div>Price: <span className="text-white">{fmtCents(pPrice)} per ETH</span> ({pPrice.toString()} cents on-chain)</div>
              <div>Full fill: <span className="text-white">{fmtEth(pAmt)} ETH</span> ({pAmt.toString()} wei) for <span className="text-white">{fmtCents(centsFor(pAmt, pPrice))}</span> on X Money</div>
              <div>Per trade: {fmtEth(pMin)} ETH ({fmtCents(centsFor(pMin, pPrice))}) to {fmtEth(pMax)} ETH ({fmtCents(centsFor(pMax, pPrice))})</div>
              {postSide === 'sell' ? (
                <>
                  <div className="text-amber-200">You escrow exactly {fmtEth(pAmt)} ETH now. Each taker must pay you on X Money within {payMin} minutes; you release once the dollars arrive, or dispute within {releaseH} hours of their paid mark if they never came. If you are not around to dispute within those {releaseH} hours, the buyer can claim the ETH whether they paid or not.</div>
                  <div className="text-amber-200">A taker who never pays locks that ETH for {payMin} minutes before anyone can cancel; then it goes back onto your order. This can repeat, and there is no penalty for it beyond each buyer address being limited to one open trade at a time.</div>
                  <div>The {feePct} fee comes out of the ETH the buyer receives, not your dollars. Cancel any time to get back the ETH not locked in open trades.</div>
                </>
              ) : (
                <>
                  <div className="text-amber-200">You escrow nothing now. When a seller takes it, their ETH is locked and you have {payMin} minutes to send them the exact dollars on X Money and mark paid.</div>
                  <div>You receive the ETH minus {feePct}: for a full fill, {fmtEth(pAmt - feeOf(pAmt, feeBps))} ETH. Marking paid without paying can get your address flagged. While you have a trade waiting for your payment, nobody else can take this order: one open trade per buyer.</div>
                </>
              )}
            </div>
          )}
          {postErr && (postPrice || postAmt) && <div className="text-[11px] text-rose-300">{postErr}</div>}
          {!handle ? (
            <div className="flex items-center gap-2">{signInX}<span className="text-slate-500">Your order carries your verified X handle.</span></div>
          ) : !account ? (
            <button className={btnPrimary} onClick={onConnectWallet}>Connect wallet</button>
          ) : (
            <button className={btnPrimary} disabled={!!busy || !!postErr} onClick={submitPost}>
              {postSide === 'sell' ? `Post sell order as @${handle}${pAmt ? ` (escrow ${fmtEth(pAmt)} ETH)` : ''}` : `Post buy order as @${handle}`}
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {!account ? (
            <div className={`${card} font-mono text-xs flex items-center gap-2`}><button className={btnPrimary} onClick={onConnectWallet}>Connect wallet</button><span className="text-slate-400">to see your trades.</span></div>
          ) : myTrades.length === 0 ? (
            <div className={`${card} font-mono text-xs text-slate-400`}>No trades for {short(account)} yet. Take an order from the book or post one.</div>
          ) : myTrades.map(tradeCard)}
        </div>
      )}

      {/* take modal */}
      {taking && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setTaking(null)}>
          <div className="bg-[#0e121d] border border-emerald-500/40 rounded-t-2xl sm:rounded-2xl max-w-md w-full p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl space-y-3 font-mono text-xs max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="text-white font-black text-sm">
              {taking.side === ROBINHOOD_OTC_SIDE.SELL ? `Buy ETH from @${taking.makerXHandle}` : `Sell ETH to @${taking.makerXHandle}`} <span className="text-slate-500">order #{taking.id}</span>
            </div>
            {flags[taking.maker.toLowerCase()] && <div className="text-rose-300 text-[11px]">This maker's address is flagged: arbiters once found it did not pay as a buyer.{taking.side === ROBINHOOD_OTC_SIDE.BUY ? ' The contract does not let anyone sell ETH to it.' : ''}</div>}
            <div className="text-slate-300">Price {fmtCents(taking.priceCentsPerEth)} per ETH. Range {fmtEth(takeBounds(taking).lo)} to {fmtEth(takeBounds(taking).hi)} ETH.</div>
            <label className="space-y-1 block">
              <span className="text-slate-400">ETH amount</span>
              <input className={input} inputMode="decimal" value={takeAmt} onChange={e => setTakeAmt(e.target.value)} />
              <span className="flex flex-wrap gap-1 pt-1">
                {PCTS.map(p => {
                  const { lo, hi } = takeBounds(taking);
                  const sellingEth = taking.side === ROBINHOOD_OTC_SIDE.BUY;
                  const spendable = ethBal != null && ethBal > GAS_KEEP_WEI ? ethBal - GAS_KEEP_WEI : 0n;
                  const base = sellingEth ? (spendable < hi ? spendable : hi) : hi;
                  const v = pctOf(base, p);
                  return <button key={p} type="button" disabled={v <= 0n || v < lo} onClick={() => setTakeAmt(fmtEth(v))} className="px-2 py-0.5 rounded-md bg-[#121624] border border-[#1e2538] text-[10px] text-slate-300 hover:border-emerald-500 disabled:opacity-40">{p}%</button>;
                })}
                <span className="text-[10px] text-slate-500 self-center">{taking.side === ROBINHOOD_OTC_SIDE.BUY ? 'of your ETH (keeping gas), up to the order max' : 'of the most you can take from this order'}</span>
              </span>
            </label>
            {takeWei != null && !takeErr && (
              <div className="p-3 rounded-xl bg-[#0a0d16] border border-[#1a2133] space-y-1 text-[11px] text-slate-300">
                <div>{fmtEth(takeWei)} ETH ({takeWei.toString()} wei) for <span className="text-white font-bold">{fmtCents(centsFor(takeWei, taking.priceCentsPerEth))}</span> on X Money. The trade records the exact cents when it opens.</div>
                {taking.side === ROBINHOOD_OTC_SIDE.SELL ? (
                  <>
                    <div>You receive {fmtEth(takeWei - feeOf(takeWei, feeBps))} ETH after the {feePct} fee ({fmtEth(feeOf(takeWei, feeBps))} ETH).</div>
                    <div className="text-amber-200">After this you have {payMin} minutes to send the dollars to @{taking.makerXHandle} on X Money with the memo shown on the trade, then mark paid. If you do not, anyone can cancel and the ETH goes back to the order. Marking paid without paying can get your address flagged. Until this trade is marked paid or cancelled you cannot open another one.</div>
                  </>
                ) : (
                  <>
                    <div className="text-amber-200">You escrow exactly {fmtEth(takeWei)} ETH now. @{taking.makerXHandle} has {payMin} minutes to pay you on X Money. If they do not, anyone can cancel and the ETH comes back to you. Release only once the dollars are in your X Money balance; if they mark paid and never pay, dispute within {releaseH} hours with a bond of exactly {fmtEth(bondForWei(takeWei))} ETH. If you are not around to dispute within those {releaseH} hours, they can claim the ETH whether they paid or not.</div>
                    <div>The buyer receives {fmtEth(takeWei - feeOf(takeWei, feeBps))} ETH; the {feePct} fee comes out of their side.</div>
                  </>
                )}
              </div>
            )}
            {takeErr && <div className="text-rose-300 text-[11px]">{takeErr}</div>}
            <div className="flex gap-2">
              {!handle ? signInX : !account ? (
                <button className={btnPrimary} onClick={onConnectWallet}>Connect wallet</button>
              ) : (
                <button className={btnPrimary} disabled={!!busy || !!takeErr} onClick={submitTake}>
                  {taking.side === ROBINHOOD_OTC_SIDE.SELL ? `Open trade as @${handle}` : `Escrow ETH as @${handle}`}
                </button>
              )}
              <button className={btnGhost} onClick={() => setTaking(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default RobinhoodOtc;
