import React, { useState, useEffect, useMemo } from 'react';
import { 
  Zap, 
  Flame, 
  TrendingUp, 
  ArrowRight, 
  ShieldCheck, 
  Coins, 
  Clock, 
  ExternalLink, 
  CheckCircle, 
  AlertTriangle, 
  Percent, 
  RefreshCw, 
  Send,
  Lock,
  Sparkles,
  Layers,
  ChevronRight,
  Info,
  Award,
  Hash,
  Database,
  Share2,
  Link2,
  Plus,
  ArrowDownUp
} from 'lucide-react';
import { UserWallet } from '../types';
import { CONTRACT_ADDRESSES, l4Addresses } from '../contracts/abis';
import { OrbitL4Explorer } from './OrbitL4Explorer';
import { publicClient, l4PublicClient, sendOnChainTx, encodeAbiCall, fetchL4XMoneyBalance, loadL4Info, waitForL4Credit, fetchWithdrawals, executeWithdrawal, type Withdrawal, L3_CHAIN_ID, L4_CHAIN_ID } from '../contracts/web3Client';
import { sendL4Tx, useL4Gas, isOwnAddress } from '../contracts/gas';
import { L4GasPanel } from './L4GasPanel';
import { Disclosure } from './Disclosure';
import { sounds } from '../utils/audio';
import confetti from 'canvas-confetti';
import { formatEther, parseEther, parseAbi } from 'viem';

interface OtcOrder {
  id: number;
  contractAddress: string;
  cohort: 'legacy' | 'fireball';
  maker: string;
  makerXHandle: string;
  side: 'ASK' | 'BID';
  availableXMoney: number; // in $xMoney
  fiatRateBps: number;      // 10000 = $1.00 USD
  minAmount: number;
  maxAmount: number;
  active: boolean;
}

interface OtcTrade {
  id: number;
  contractAddress: string;
  cohort: 'legacy' | 'fireball';
  orderId: number;
  side: 'ASK' | 'BID';
  seller: string;
  sellerXHandle: string;
  buyer: string;
  buyerXHandle: string;
  xMoneyAmount: number;
  expectedCents: number;
  deadline: number;
  completed: boolean;
  cancelled: boolean;
}

interface FomoState {
  roundId: number;
  roundDeadline: number;
  currentLeader: string;
  currentLeaderXHandle: string;
  jackpotPot: number;
  totalKeys: number;
  keyPrice: number;
  playerKeys: number;
  playerDividends: number;
}

interface OrbitXMoneyOtcProps {
  wallet: UserWallet;
  onConnectWallet: () => void;
  /** X handle from Sign in with X; when set, all handle fields are locked to it */
  xHandle?: string | null;
}

const USDG_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)'
]);

// Kill switch for the deposit button. Off on #466302: the vault's setBridgeSystem has pointed enterRollup at the
// new inbox. Turn it back on (and reword the message) if deposits ever have to stop again.
const DEPOSITS_PAUSED = false;
// Robinhood helper for deposits before the vault's timelocked switch (reviewed; see ~/.xgas-orbit/relaunch-466302/early).
const EARLY_DEPOSITOR = '0x36e52831ba473e9374bad7cc22ed942a99b4d431';
const EARLY_DEPOSITOR_ABI = parseAbi(['function deposit(uint256 usdgAmount, address l3Recipient) returns (uint256)']);
const DEPOSITS_PAUSED_MSG = 'Deposits are paused for now. Nothing you already hold is affected, and withdrawals keep working.';

// XMoney: the vault + gas token on Robinhood. enterRollup bridges to the Orbit L4 in the same tx.
const XUSD_VAULT_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function inbox() view returns (address)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function enterRollup(uint256 usdgAmount, address l3Recipient) returns (uint256)',
  'function exitRollup(uint256 xMoneyAmount) returns (uint256)',
  'function migrate(uint256 legacyAmount, address l3Recipient) returns (uint256)',
  'function getReserveNAV() view returns (uint256 navRay, uint256 usdgReserve, uint256 circulatingXMoney)',
  'function totalXMoneyBurned() view returns (uint256)',
  'function totalUsdgRakedToFanout() view returns (uint256)',
  'function totalXMoneyBridgedToL4() view returns (uint256)',
  'event RollupEntered(address indexed user, address indexed l3Recipient, uint256 usdgIn, uint256 xMoneyBridged, uint256 usdgRaked, uint256 xMoneyBurned, uint256 retryableTicketId)',
  'event RollupExited(address indexed user, uint256 xMoneyBurned, uint256 usdgReturned, uint256 usdgRaked)'
]);

// ArbSys precompile on the L4: withdrawEth burns native xMoney and queues an L4->L3 message.
const ARBSYS_ABI = parseAbi(['function withdrawEth(address destination) payable returns (uint256)']);

// xgas Orbit L4 P2P escrow: every amount is NATIVE $xMoney (18 decimals)
const ESCROW_ABI = parseAbi([
  'function nextOrderId() view returns (uint256)',
  'function nextTradeId() view returns (uint256)',
  'function totalXMoneyBurned() view returns (uint256)',
  'function totalXMoneyRakedToFanout() view returns (uint256)',
  'function totalXMoneyToBuyback() view returns (uint256)',
  'function totalSettledVolumeXMoney() view returns (uint256)',
  'function orders(uint256) view returns (address maker, string makerXHandle, uint8 side, uint256 availableXMoney, uint256 fiatRateBps, uint256 minAmount, uint256 maxAmount, bool active)',
  'function trades(uint256) view returns (uint256 orderId, uint8 side, address seller, string sellerXHandle, address buyer, string buyerXHandle, uint256 xMoneyAmount, uint256 expectedCents, uint256 deadline, bool completed, bool cancelled)',
  'function createSellAsk(string makerXHandle, uint256 xMoneyAmount, uint256 fiatRateBps, uint256 minAmount, uint256 maxAmount) payable returns (uint256)',
  'function createBuyBid(string makerXHandle, uint256 maxXMoneyWanted, uint256 fiatRateBps, uint256 minAmount, uint256 maxAmount) returns (uint256)',
  'function fillSellAsk(uint256 orderId, uint256 xMoneyAmount, string buyerXHandle) returns (uint256)',
  'function fillBuyBid(uint256 orderId, uint256 xMoneyAmount, string sellerXHandle) payable returns (uint256)',
  'function releaseTrade(uint256 tradeId)',
  'function cancelTradeTimeout(uint256 tradeId)',
  'function cancelOrder(uint256 orderId)'
]);

const FOMO_ABI = parseAbi([
  'function roundId() view returns (uint256)',
  'function roundDeadline() view returns (uint256)',
  'function jackpotPot() view returns (uint256)',
  'function totalKeys() view returns (uint256)',
  'function getKeyPrice() view returns (uint256)',
  'function currentLeader() view returns (address)',
  'function currentLeaderXHandle() view returns (string)',
  'function totalBurned() view returns (uint256)',
  'function totalFanoutRaked() view returns (uint256)',
  'function totalBuyback() view returns (uint256)',
  'function players(address) view returns (uint256 keys, uint256 rewardDebt, uint256 pendingDividends, string xHandle)',
  'function pendingDividendsOf(address) view returns (uint256)',
  'function pendingDividendsOfRound(uint256 round, address) view returns (uint256)',
  'function buyKeys(string xHandle, uint256 keyCount) payable',
  'function claimDividends()',
  'function claimDividendsForRound(uint256 round)',
  'function claimJackpot()',
  'function jackpotOwed(address) view returns (uint256)',
  'function totalJackpotOwed() view returns (uint256)',
  'function nextRoundSeed() view returns (uint256)',
  'function withdrawJackpot(address to)'
]);

type TabId = 'otc' | 'explorer' | 'fomo3d' | 'specs';
const TAB_IDS: TabId[] = ['otc', 'explorer', 'fomo3d', 'specs'];
const TAB_ALIASES: Record<string, TabId> = {
  otc: 'otc', desk: 'otc', p2p: 'otc', trade: 'otc',
  explorer: 'explorer', scan: 'explorer', blocks: 'explorer',
  fomo3d: 'fomo3d', fomo: 'fomo3d', attrition: 'fomo3d', war: 'fomo3d', game: 'fomo3d',
  specs: 'specs', docs: 'specs', contracts: 'specs',
};

/** Parse /order/:id, /trade/:id, /<tab> or #<tab> into a route. */
function parseRoute(): { tab: TabId; orderId: number | null; tradeId: number | null; cohort: 'legacy' | 'fireball' | null } {
  if (typeof window === 'undefined') return { tab: 'otc', orderId: null, tradeId: null, cohort: null };
  const raw = (window.location.pathname.replace(/^\/+|\/+$/g, '') || window.location.hash.replace(/^#\/?/, '')).toLowerCase();
  const m = raw.match(/^(?:(legacy|fireball)\/)?(?:otc\/)?(order|offer|bid|ask|trade|settlement)\/(\d+)$/);
  if (m) {
    const id = parseInt(m[3], 10);
    // Historical /order/:id and /trade/:id links keep their original contract.
    const cohort = m[1] === 'fireball' ? 'fireball' : 'legacy';
    return m[2] === 'trade' || m[2] === 'settlement'
      ? { tab: 'otc', orderId: null, tradeId: id, cohort }
      : { tab: 'otc', orderId: id, tradeId: null, cohort };
  }
  const cohort = raw.startsWith('legacy/') ? 'legacy' : raw.startsWith('fireball/') ? 'fireball' : null;
  const tab = cohort ? raw.split('/').slice(1).join('/') : raw;
  return { tab: TAB_ALIASES[tab] || 'otc', orderId: null, tradeId: null, cohort };
}

/** Resolve the tab from /path or #hash so every tab is a shareable URL. */
function tabFromLocation(): TabId {
  return parseRoute().tab;
}

const origin = () => (typeof window !== 'undefined' ? window.location.origin : '');
export const deepLink = (tab: TabId, cohort: 'legacy' | 'fireball' = 'fireball') => `${origin()}/${cohort === 'legacy' ? 'legacy/' : ''}${tab}`;
export const orderLink = (orderId: number, cohort: 'legacy' | 'fireball' = 'legacy') => `${origin()}/${cohort === 'fireball' ? 'fireball/' : ''}order/${orderId}`;
export const tradeLink = (tradeId: number, cohort: 'legacy' | 'fireball' = 'legacy') => `${origin()}/${cohort === 'fireball' ? 'fireball/' : ''}trade/${tradeId}`;

/** Withdrawal progress in plain words: Withdrawn on L4 → Confirming on Robinhood (minutes) → Claimed → Redeem. */
const WITHDRAWAL_STEPS: { key: Withdrawal['status'] | 'redeem'; label: string }[] = [
  { key: 'pending', label: 'Withdrawn from L4' },
  { key: 'claimable', label: 'Confirmed on Robinhood' },
  { key: 'executed', label: 'Landed in your wallet' },
  { key: 'redeem', label: 'Redeem for USDG' },
];
function WithdrawalSteps({ status }: { status: Withdrawal['status'] }) {
  // How many steps are done. 'pending' = withdrawn, waiting on Robinhood; 'claimable' = confirmed, claim is next;
  // 'executed' = claimed, redeem is optional and next.
  const done = status === 'pending' ? 1 : status === 'claimable' ? 2 : 3;
  const current = WITHDRAWAL_STEPS[Math.min(done, WITHDRAWAL_STEPS.length - 1)];
  return (
    <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] font-mono" aria-label={`Withdrawal progress: ${current.label} is next`}>
      {WITHDRAWAL_STEPS.map((s, i) => {
        const isDone = i < done;
        const isNext = i === done;
        return (
          <li key={s.key} className="flex items-center gap-1.5">
            {i > 0 && <span aria-hidden="true" className={isDone || isNext ? 'text-slate-500' : 'text-slate-700'}>→</span>}
            <span
              aria-current={isNext ? 'step' : undefined}
              className={`px-1.5 py-0.5 rounded border ${
                isDone ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                : isNext ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                : 'border-[#1e2538] text-slate-600'
              }`}
            >
              {isDone ? '✓ ' : ''}{s.label}{isNext && s.key === 'claimable' ? ' · waiting' : ''}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export const OrbitXMoneyOtc: React.FC<OrbitXMoneyOtcProps> = ({
  wallet,
  onConnectWallet,
  xHandle = null
}) => {
  const [activeTab, setActiveTabState] = useState<TabId>(() => tabFromLocation());
  const [selectedCohort, setSelectedCohort] = useState<'legacy' | 'fireball'>(() => parseRoute().cohort || 'fireball');
  const [fireballAvailable, setFireballAvailable] = useState(false);
  const cohort = selectedCohort === 'fireball' && fireballAvailable ? 'fireball' : 'legacy';
  const activeEscrowAddress = cohort === 'fireball' ? l4Addresses.fireballEscrow : l4Addresses.escrow;
  const activeFomoAddress = cohort === 'fireball' ? l4Addresses.fireballFomo : l4Addresses.fomo;
  const createEscrowAddress = fireballAvailable ? l4Addresses.fireballEscrow : l4Addresses.escrow;
  // Which gas pays L4 writes (xMoney, or XGAS.DEV through a paymaster); orders made from the xGas account count as yours.
  const { plan: gasPlan } = useL4Gas(wallet.connected ? wallet.address : '');
  const isMine = (addr: string) => wallet.connected && isOwnAddress(addr, wallet.address, gasPlan);
  const [deepOrderId, setDeepOrderId] = useState<number | null>(() => parseRoute().orderId);
  const [deepTradeId, setDeepTradeId] = useState<number | null>(() => parseRoute().tradeId);
  const [deepLinkNotice, setDeepLinkNotice] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState<string | null>(null);
  const copyLink = (url: string) => {
    navigator.clipboard.writeText(url).catch(() => {});
    setCopiedLink(url);
    setTimeout(() => setCopiedLink(null), 1500);
  };

  // Deep links: /otc, /explorer, /fomo3d, /specs (and #fomo3d etc.) open that tab directly.
  const setActiveTab = (tab: TabId) => {
    setActiveTabState(tab);
    const nextPath = `/${cohort === 'legacy' && fireballAvailable ? 'legacy/' : ''}${tab}`;
    if (typeof window !== 'undefined' && window.location.pathname !== nextPath) {
      window.history.pushState({ tab, cohort }, '', nextPath);
    }
  };
  const selectCohort = (next: 'legacy' | 'fireball') => {
    setSelectedCohort(next);
    setSelectedOrderForTrade(null);
    setOrders([]);
    setTrades([]);
    setPastRoundDividends([]);
    window.history.pushState({ tab: activeTab, cohort: next }, '', `/${next === 'legacy' ? 'legacy/' : ''}${activeTab}`);
  };
  useEffect(() => {
    const onPop = () => {
      const r = parseRoute();
      setActiveTabState(r.tab);
      setSelectedCohort(r.cohort || 'fireball');
      setDeepOrderId(r.orderId);
      setDeepTradeId(r.tradeId);
      if (r.orderId == null) setSelectedOrderForTrade(null);
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener('hashchange', onPop);
    if (window.location.pathname === '/' && !window.location.hash) {
      window.history.replaceState({ tab: activeTab }, '', `/${activeTab}`);
    }
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('hashchange', onPop);
    };
  }, []);
  
  // Real On-Chain Metrics (Abstracted to xMoney)
  const [totalBurnedSupply, setTotalBurnedSupply] = useState<number>(0);
  const [totalFanoutRaked, setTotalFanoutRaked] = useState<number>(0);
  const [totalSettledXMoney, setTotalSettledXMoney] = useState<number>(0);
  const [navMultiplier, setNavMultiplier] = useState<number>(1.00000);

  // User Balance in xMoney
  const [userXMoneyBalance, setUserXMoneyBalance] = useState<number>(0);
  const [userL3XMoney, setUserL3XMoney] = useState<number>(0);      // xMoney sitting on Robinhood (withdrawn, not yet redeemed)
  const [userUsdg, setUserUsdg] = useState<number>(0);
  const [bridgeStatus, setBridgeStatus] = useState<string | null>(null);
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [executorEnabled, setExecutorEnabled] = useState<boolean>(false);
  const [pastRoundDividends, setPastRoundDividends] = useState<{ round: number; amount: number }[]>([]);

  // Vault On-Ramp / Off-Ramp State
  const [vaultAmount, setVaultAmount] = useState('50');

  // Orders & Trades
  const [orders, setOrders] = useState<OtcOrder[]>([]);
  const [trades, setTrades] = useState<OtcTrade[]>([]);
  const [orderBookSide, setOrderBookSide] = useState<'ALL' | 'ASK' | 'BID'>('ALL');

  // Modals & Forms
  const [isCreateOrderModalOpen, setIsCreateOrderModalOpen] = useState(false);
  const [orderSideToCreate, setOrderSideToCreate] = useState<'ASK' | 'BID'>('ASK');
  const [newOrderAmount, setNewOrderAmount] = useState('50');
  const [newOrderHandle, setNewOrderHandle] = useState('');
  const [newOrderSpread, setNewOrderSpread] = useState('2.0'); // +2.0%
  const [newOrderMin, setNewOrderMin] = useState('10');
  const [newOrderMax, setNewOrderMax] = useState('50');
  const [isSubmittingTx, setIsSubmittingTx] = useState(false);
  // Inline errors for the two modals and the game, instead of alert(). Cleared when the modal closes / next attempt starts.
  const [modalError, setModalError] = useState<string | null>(null);
  const [fomoError, setFomoError] = useState<string | null>(null);
  const [fomoBusy, setFomoBusy] = useState(false);

  // Fill Modal
  const [selectedOrderForTrade, setSelectedOrderForTrade] = useState<OtcOrder | null>(null);
  const [tradeAmount, setTradeAmount] = useState('10');
  const [takerHandle, setTakerHandle] = useState('');

  // FOMO3D Game State
  const [fomo, setFomo] = useState<FomoState>({
    roundId: 1,
    roundDeadline: Date.now() + 3600 * 1000,
    currentLeader: '0x0000000000000000000000000000000000000000',
    currentLeaderXHandle: '',
    jackpotPot: 0,
    totalKeys: 0,
    keyPrice: 0.001,
    playerKeys: 0,
    playerDividends: 0
  });

  const [keysToBuy, setKeysToBuy] = useState<number>(1);
  const [fomoXHandle, setFomoXHandle] = useState<string>('');

  // Signed in with X: every handle field is the verified handle
  useEffect(() => {
    if (xHandle) {
      setNewOrderHandle(xHandle);
      setTakerHandle(xHandle);
      setFomoXHandle(xHandle);
    }
  }, [xHandle]);
  const handleLocked = !!xHandle;
  const [timeLeftStr, setTimeLeftStr] = useState<string>('00:00:00');

  // 1. POLL STRICTLY REAL ON-CHAIN DATA
  useEffect(() => {
    let isMounted = true;

    const fetchRealData = async () => {
      try {
        const [navData, totalBurnedBig, totalRakedBig] = await Promise.all([
          publicClient.readContract({ address: CONTRACT_ADDRESSES.XMONEY_USD_L3 as `0x${string}`, abi: XUSD_VAULT_ABI, functionName: 'getReserveNAV' }),
          publicClient.readContract({ address: CONTRACT_ADDRESSES.XMONEY_USD_L3 as `0x${string}`, abi: XUSD_VAULT_ABI, functionName: 'totalXMoneyBurned' }),
          publicClient.readContract({ address: CONTRACT_ADDRESSES.XMONEY_USD_L3 as `0x${string}`, abi: XUSD_VAULT_ABI, functionName: 'totalUsdgRakedToFanout' })
        ]);

        // Everything below the vault lives on the xgas Orbit L4
        const info = await loadL4Info();
        const newReady = info?.fireball?.active === true
          && !!info.fireball.contracts?.escrow && !!info.fireball.contracts?.fomo;
        if (isMounted) setFireballAvailable(newReady);
        const useFireball = selectedCohort === 'fireball' && newReady;
        const escrowAddr = (useFireball ? l4Addresses.fireballEscrow : l4Addresses.escrow) as `0x${string}`;
        const fomoAddr = (useFireball ? l4Addresses.fireballFomo : l4Addresses.fomo) as `0x${string}`;
        const readCohort: 'legacy' | 'fireball' = useFireball ? 'fireball' : 'legacy';
        // Empty until the desk and the game are deployed on this chain: the vault, balances and withdrawals
        // still load, the order book and the game read as empty.
        const appsLive = !!escrowAddr && !!fomoAddr;

        const [nextOrderBig, nextTradeBig, escrowVolBig] = !appsLive ? [0n, 0n, 0n] : await Promise.all([
          l4PublicClient.readContract({ address: escrowAddr, abi: ESCROW_ABI, functionName: 'nextOrderId' }),
          l4PublicClient.readContract({ address: escrowAddr, abi: ESCROW_ABI, functionName: 'nextTradeId' }),
          l4PublicClient.readContract({ address: escrowAddr, abi: ESCROW_ABI, functionName: 'totalSettledVolumeXMoney' })
        ]);

        const [roundIdBig, deadlineBig, potBig, keysBig, priceBig, leader, handle] = !appsLive
          ? [0n, 0n, 0n, 0n, 0n, '0x0000000000000000000000000000000000000000' as `0x${string}`, '']
          : await Promise.all([
          l4PublicClient.readContract({ address: fomoAddr, abi: FOMO_ABI, functionName: 'roundId' }),
          l4PublicClient.readContract({ address: fomoAddr, abi: FOMO_ABI, functionName: 'roundDeadline' }),
          l4PublicClient.readContract({ address: fomoAddr, abi: FOMO_ABI, functionName: 'jackpotPot' }),
          l4PublicClient.readContract({ address: fomoAddr, abi: FOMO_ABI, functionName: 'totalKeys' }),
          l4PublicClient.readContract({ address: fomoAddr, abi: FOMO_ABI, functionName: 'getKeyPrice' }),
          l4PublicClient.readContract({ address: fomoAddr, abi: FOMO_ABI, functionName: 'currentLeader' }),
          l4PublicClient.readContract({ address: fomoAddr, abi: FOMO_ABI, functionName: 'currentLeaderXHandle' })
        ]);

        if (!isMounted) return;

        const navFloat = Number(navData[0]) / 1e18;
        setNavMultiplier(navFloat > 0 ? navFloat : 1.00000);
        setTotalBurnedSupply(Number(formatEther(totalBurnedBig)));
        setTotalFanoutRaked(Number(totalRakedBig) / 1e6);
        setTotalSettledXMoney(Number(formatEther(escrowVolBig)));

        setFomo(prev => ({
          ...prev,
          roundId: Number(roundIdBig),
          roundDeadline: Number(deadlineBig) * 1000,
          currentLeader: leader,
          currentLeaderXHandle: handle,
          jackpotPot: Number(formatEther(potBig)),
          totalKeys: Number(keysBig),
          keyPrice: Number(formatEther(priceBig))
        }));

        const activeUser = wallet.address || (typeof window !== 'undefined' && (window as any).ethereum?.selectedAddress) || null;
        if (activeUser) {
          try {
            const [l4Bal, p, owed, l3X, l3U] = await Promise.all([
              fetchL4XMoneyBalance(activeUser),
              appsLive ? l4PublicClient.readContract({ address: fomoAddr, abi: FOMO_ABI, functionName: 'players', args: [activeUser as `0x${string}`] }) : null,
              appsLive ? l4PublicClient.readContract({ address: fomoAddr, abi: FOMO_ABI, functionName: 'pendingDividendsOf', args: [activeUser as `0x${string}`] }) : 0n,
              publicClient.readContract({ address: CONTRACT_ADDRESSES.XMONEY_USD_L3 as `0x${string}`, abi: XUSD_VAULT_ABI, functionName: 'balanceOf', args: [activeUser as `0x${string}`] }),
              publicClient.readContract({ address: CONTRACT_ADDRESSES.USDG as `0x${string}`, abi: USDG_ABI, functionName: 'balanceOf', args: [activeUser as `0x${string}`] }),
            ]);
            // dividends left behind in finished rounds (last 8 rounds)
            const rid = Number(roundIdBig);
            const past: { round: number; amount: number }[] = [];
            for (let r = Math.max(1, rid - 8); r < rid; r++) {
              const o = await l4PublicClient.readContract({ address: fomoAddr, abi: FOMO_ABI, functionName: 'pendingDividendsOfRound', args: [BigInt(r), activeUser as `0x${string}`] });
              if (o > 0n) past.push({ round: r, amount: Number(formatEther(o)) });
            }
            if (wallet.connected) {
              fetchWithdrawals(activeUser).then(w => { if (isMounted) { setWithdrawals(w.withdrawals); setExecutorEnabled(w.executorEnabled); } }).catch(() => {});
            }

            if (isMounted) {
              setUserXMoneyBalance(l4Bal);
              setUserL3XMoney(Number(formatEther(l3X)));
              setUserUsdg(Number(l3U) / 1e6);
              setPastRoundDividends(past);
              if (p) {
                setFomo(prev => ({
                  ...prev,
                  playerKeys: Number(p[0]),
                  playerDividends: Number(formatEther(owed))
                }));
              }
            }
          } catch (e) {
            console.warn('User balances warning:', e);
          }
        }

        // Read real active orders
        const numOrders = Number(nextOrderBig);
        if (numOrders > 0) {
          const orderPromises = [];
          for (let i = 0; i < numOrders; i++) {
            orderPromises.push(l4PublicClient.readContract({
              address: escrowAddr,
              abi: ESCROW_ABI,
              functionName: 'orders',
              args: [BigInt(i)]
            }));
          }
          const rawOrders = await Promise.all(orderPromises);
          if (isMounted) {
            const parsed: OtcOrder[] = rawOrders.map((o: any, idx: number) => ({
              id: idx,
              contractAddress: escrowAddr,
              cohort: readCohort,
              maker: o[0],
              makerXHandle: o[1],
              side: o[2] === 0 ? 'ASK' : 'BID',
              availableXMoney: Number(formatEther(o[3])),
              fiatRateBps: Number(o[4]),
              minAmount: Number(formatEther(o[5])),
              maxAmount: Number(formatEther(o[6])),
              active: o[7]
            }));
            // active AND still fillable: a fully-taken order keeps active=true on-chain until cancelled
            setOrders(parsed.filter(o => o.active && o.availableXMoney > 0 && o.availableXMoney >= o.minAmount));
          }
        } else {
          setOrders([]);
        }

        // Read real active trades
        const numTrades = Number(nextTradeBig);
        if (numTrades > 0) {
          const tradePromises = [];
          for (let i = 0; i < numTrades; i++) {
            tradePromises.push(l4PublicClient.readContract({
              address: escrowAddr,
              abi: ESCROW_ABI,
              functionName: 'trades',
              args: [BigInt(i)]
            }));
          }
          const rawTrades = await Promise.all(tradePromises);
          if (isMounted) {
            const parsedTrades: OtcTrade[] = rawTrades.map((t: any, idx: number) => ({
              id: idx,
              contractAddress: escrowAddr,
              cohort: readCohort,
              orderId: Number(t[0]),
              side: t[1] === 0 ? 'ASK' : 'BID',
              seller: t[2],
              sellerXHandle: t[3],
              buyer: t[4],
              buyerXHandle: t[5],
              xMoneyAmount: Number(formatEther(t[6])),
              expectedCents: Number(t[7]),
              deadline: Number(t[8]) * 1000,
              completed: t[9],
              cancelled: t[10]
            }));
            setTrades(parsedTrades.filter(t => !t.completed && !t.cancelled));
          }
        } else {
          setTrades([]);
        }
      } catch (err) {
        console.warn('Live state poll warning:', err);
      }
    };

    fetchRealData();
    const interval = setInterval(fetchRealData, 4000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [wallet.connected, wallet.address, selectedCohort]);

  // Deep link /order/:id -> open that offer/bid in the fill modal once the book has loaded
  useEffect(() => {
    if (deepOrderId == null || orders.length === 0 && trades.length === 0) return;
    const order = orders.find(o => o.id === deepOrderId && o.cohort === selectedCohort);
    if (order) {
      setSelectedOrderForTrade(order);
      setTradeAmount(String(Math.min(10, order.maxAmount)));
      setDeepLinkNotice(null);
    } else if (orders.length > 0 || trades.length > 0) {
      setDeepLinkNotice(`Order #${deepOrderId} is no longer open on the book (filled or cancelled).`);
    }
    setDeepOrderId(null);
  }, [deepOrderId, orders, trades, selectedCohort]);

  useEffect(() => {
    if (deepTradeId == null || trades.length === 0) return;
    const el = document.getElementById(`trade-${selectedCohort}-${deepTradeId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ring-2', 'ring-cyan-400');
      setTimeout(() => el.classList.remove('ring-2', 'ring-cyan-400'), 4000);
    } else {
      setDeepLinkNotice(`Trade #${deepTradeId} is not in active settlement (released or cancelled).`);
    }
    setDeepTradeId(null);
  }, [deepTradeId, trades, selectedCohort]);

  // Keep the URL in sync with the open offer/bid
  const openOrder = (order: OtcOrder) => {
    setSelectedOrderForTrade(order);
    setTradeAmount(String(Math.min(10, order.maxAmount)));
    setModalError(null);
    const path = order.cohort === 'fireball' ? `/fireball/order/${order.id}` : `/order/${order.id}`;
    if (window.location.pathname !== path) window.history.pushState({ order: order.id, cohort: order.cohort }, '', path);
  };
  const closeOrder = () => {
    setSelectedOrderForTrade(null);
    setModalError(null);
    if (/^\/(?:fireball\/)?order\//.test(window.location.pathname)) {
      window.history.replaceState({ tab: 'otc', cohort }, '', `/${cohort === 'legacy' && fireballAvailable ? 'legacy/' : ''}otc`);
    }
  };

  // Countdown timer string
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      const diff = Math.max(0, fomo.roundDeadline - now);
      const hours = Math.floor(diff / (1000 * 60 * 60));
      const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const secs = Math.floor((diff % (1000 * 60)) / 1000);
      setTimeLeftStr(
        `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
      );
    }, 1000);
    return () => clearInterval(timer);
  }, [fomo.roundDeadline]);

  const refreshL4Balance = async () => {
    try {
      const l4Bal = await fetchL4XMoneyBalance(wallet.address);
      setUserXMoneyBalance(l4Bal);
    } catch (e) {
      console.warn('L4 balance read warning:', e);
    }
  };

  // ON-CHAIN WRITE (L3 -> L4): Enter rollup = lock USDG in the Robinhood vault; the vault bridges native
  // $xMoney to your address on the xgas Orbit L4 through the canonical Inbox (retryable ticket, auto-redeemed).
  const handleMintXMoney = async (e: React.FormEvent) => {
    e.preventDefault();
    if (DEPOSITS_PAUSED) {
      alert(DEPOSITS_PAUSED_MSG);
      return;
    }
    if (!wallet.connected) {
      onConnectWallet();
      return;
    }

    setIsSubmittingTx(true);
    setBridgeStatus(null);
    try {
      const rawUnits = BigInt(Math.round(parseFloat(vaultAmount) * 1e6));
      if (rawUnits <= 0n) throw new Error('Enter a USDG amount');
      // enterRollup sends to whatever inbox the vault holds. Until its timelocked setBridgeSystem points it at this
      // chain's inbox, a deposit would go to the retired chain (whose inbox is paused, so it would just revert).
      const vaultInbox = await publicClient.readContract({ address: CONTRACT_ADDRESSES.XMONEY_USD_L3 as `0x${string}`, abi: XUSD_VAULT_ABI, functionName: 'inbox' });
      // Until the vault's timelocked switch lands, deposits go through EarlyDepositor: one call mints xMoney from the
      // vault and opens a retryable to exactly this wallet on the new chain (no aliasing, nothing left in the helper).
      const viaHelper = vaultInbox.toLowerCase() !== CONTRACT_ADDRESSES.ORBIT_INBOX.toLowerCase();
      const spender = (viaHelper ? EARLY_DEPOSITOR : CONTRACT_ADDRESSES.XMONEY_USD_L3) as `0x${string}`;
      // Say what is actually missing before the wallet does. Without this, USDG's InsufficientFunds revert
      // reaches the user as "execution reverted for an unknown reason".
      const who = wallet.address as `0x${string}`;
      const [usdgBal, ethBal] = await Promise.all([
        publicClient.readContract({ address: CONTRACT_ADDRESSES.USDG as `0x${string}`, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [who] }),
        publicClient.getBalance({ address: who }),
      ]);
      if (usdgBal < rawUnits) {
        throw new Error(`You have ${(Number(usdgBal) / 1e6).toFixed(2)} USDG on Robinhood Chain, and this deposit needs ${(Number(rawUnits) / 1e6).toFixed(2)}. xgas only takes USDG on Robinhood Chain (#4663); USDG on Ethereum or any other chain has to be bridged there first.`);
      }
      if (ethBal < 20_000_000_000_000n) {
        throw new Error('You need a little plain ETH on Robinhood Chain for gas (about 0.00002 ETH covers a deposit). WETH does not pay gas; unwrap some first.');
      }
      const before = await l4PublicClient.getBalance({ address: who }).catch(() => 0n);

      // 1) Approve exactly this deposit, never an unlimited allowance (same as the MCP enter path)
      const allowance = await publicClient.readContract({ address: CONTRACT_ADDRESSES.USDG as `0x${string}`, abi: parseAbi(['function allowance(address,address) view returns (uint256)']), functionName: 'allowance', args: [wallet.address as `0x${string}`, spender] });
      if (allowance < rawUnits) {
        setBridgeStatus('Approving USDG on Robinhood…');
        const approveCall = encodeAbiCall(USDG_ABI, 'approve', [spender, rawUnits], CONTRACT_ADDRESSES.USDG, '0', L3_CHAIN_ID);
        await sendOnChainTx({ to: CONTRACT_ADDRESSES.USDG, data: approveCall.calldata, from: wallet.address, chainId: L3_CHAIN_ID, waitForConfirmation: true });
      }

      // 2) enterRollup: USDG locked, xMoney minted and sent through the Orbit Inbox to you on the L4
      setBridgeStatus('Locking USDG and sending $xMoney to your L4 wallet…');
      const depositCall = viaHelper
        ? encodeAbiCall(EARLY_DEPOSITOR_ABI, 'deposit', [rawUnits, wallet.address], EARLY_DEPOSITOR, '0', L3_CHAIN_ID)
        : encodeAbiCall(XUSD_VAULT_ABI, 'enterRollup', [rawUnits, wallet.address], CONTRACT_ADDRESSES.XMONEY_USD_L3, '0', L3_CHAIN_ID);
      const res = await sendOnChainTx({ to: viaHelper ? EARLY_DEPOSITOR : CONTRACT_ADDRESSES.XMONEY_USD_L3, data: depositCall.calldata, from: wallet.address, chainId: L3_CHAIN_ID, waitForConfirmation: true });

      // 3) The sequencer includes the delayed message; the retryable auto-redeems and credits native gas
      setBridgeStatus(`Deposit confirmed on Robinhood (tx ${res.txHash.slice(0, 10)}…). $xMoney gas arrives in your L4 wallet in under a minute.`);
      const after = await waitForL4Credit(wallet.address, before);
      if (after == null) {
        setBridgeStatus('Deposit is on Robinhood but the L4 credit is taking longer than expected. It will arrive; check back shortly.');
      } else {
        setBridgeStatus(null);
        sounds.playConnect();
        confetti({ particleCount: 70, spread: 90 });
        setUserXMoneyBalance(Number(formatEther(after)));
      }
      await refreshL4Balance();
    } catch (err: any) {
      console.error('Enter rollup error:', err);
      setBridgeStatus(null);
      alert(err?.shortMessage || err?.message || 'Enter rollup failed');
    } finally {
      setIsSubmittingTx(false);
    }
  };

  // ON-CHAIN WRITE (L4 -> L3) step 1: withdraw native $xMoney from the L4 through ArbSys.
  // It becomes claimable on Robinhood once an assertion covering it is confirmed (minutes when 2 of the 3 validators fast-confirm through the Safe).
  const handleBurnXMoney = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wallet.connected) {
      onConnectWallet();
      return;
    }
    setIsSubmittingTx(true);
    try {
      const rawXMoney = parseEther(vaultAmount);
      if (rawXMoney <= 0n) throw new Error('Enter an $xMoney amount');
      const wCall = encodeAbiCall(ARBSYS_ABI, 'withdrawEth', [wallet.address], CONTRACT_ADDRESSES.ARB_SYS, formatEther(rawXMoney));
      await sendL4Tx({ to: CONTRACT_ADDRESSES.ARB_SYS, data: wCall.calldata, valueWei: rawXMoney, from: wallet.address, chainId: L4_CHAIN_ID, waitForConfirmation: true });
      sounds.playConnect();
      setBridgeStatus('Withdrawal started. It lands in your Robinhood wallet automatically once Robinhood confirms (usually minutes); progress is shown below.');
      await refreshL4Balance();
      fetchWithdrawals(wallet.address).then(w => { setWithdrawals(w.withdrawals); setExecutorEnabled(w.executorEnabled); }).catch(() => {});
    } catch (err: any) {
      console.error('Withdraw error:', err);
      alert(err?.shortMessage || err?.message || 'Withdraw failed');
    } finally {
      setIsSubmittingTx(false);
    }
  };

  // Step 2: execute the confirmed withdrawal on the Robinhood Outbox (host pays gas; permissionless call)
  const handleClaimWithdrawal = async (w: Withdrawal) => {
    setIsSubmittingTx(true);
    try {
      const r = await executeWithdrawal(w.txHash, w.position, w.chainId);
      sounds.playConnect();
      setBridgeStatus(r.alreadyExecuted ? 'Already delivered.' : `Delivered: ${w.amount} $xMoney is now in your Robinhood wallet (ERC-20). Hold it, or redeem it for USDG below.`);
      fetchWithdrawals(wallet.address).then(x => setWithdrawals(x.withdrawals)).catch(() => {});
    } catch (err: any) {
      alert(err?.message || 'Claim failed');
    } finally {
      setIsSubmittingTx(false);
    }
  };

  // Step 3: redeem L3 xMoney for USDG from the vault (0.01% rake)
  const handleRedeemUsdg = async () => {
    if (!wallet.connected) { onConnectWallet(); return; }
    setIsSubmittingTx(true);
    try {
      const bal = await publicClient.readContract({ address: CONTRACT_ADDRESSES.XMONEY_USD_L3 as `0x${string}`, abi: XUSD_VAULT_ABI, functionName: 'balanceOf', args: [wallet.address as `0x${string}`] });
      if (bal <= 0n) throw new Error('No $xMoney on Robinhood to redeem');
      const redeemCall = encodeAbiCall(XUSD_VAULT_ABI, 'exitRollup', [bal], CONTRACT_ADDRESSES.XMONEY_USD_L3, '0', L3_CHAIN_ID);
      await sendOnChainTx({ to: CONTRACT_ADDRESSES.XMONEY_USD_L3, data: redeemCall.calldata, from: wallet.address, chainId: L3_CHAIN_ID, waitForConfirmation: true });
      sounds.playConnect();
      confetti({ particleCount: 70, spread: 90 });
      setBridgeStatus('Redeemed: USDG is back in your wallet on Robinhood Chain.');
      setUserL3XMoney(0);
    } catch (err: any) {
      alert(err?.shortMessage || err?.message || 'Redeem failed');
    } finally {
      setIsSubmittingTx(false);
    }
  };

  // War of Attrition: claim dividends left in a finished round
  const handleClaimPastRound = async (round: number) => {
    if (!wallet.connected) { onConnectWallet(); return; }
    try {
      const c = encodeAbiCall(FOMO_ABI, 'claimDividendsForRound', [BigInt(round)], activeFomoAddress);
      await sendL4Tx({ to: activeFomoAddress, data: c.calldata, from: wallet.address, chainId: L4_CHAIN_ID, waitForConfirmation: true });
      sounds.playConnect();
      confetti({ particleCount: 50, spread: 70 });
      await refreshL4Balance();
    } catch (err: any) {
      alert(err?.shortMessage || err?.message || 'Claim failed');
    }
  };

  // ON-CHAIN WRITE (L4): Create Order (Sell Ask escrows native $xMoney; Buy Bid is a fiat commitment)
  const handleCreateOrderOnChain = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wallet.connected) {
      onConnectWallet();
      return;
    }

    setIsSubmittingTx(true);
    try {
      const rawUnits = parseEther(newOrderAmount || '0');
      const spreadPct = parseFloat(newOrderSpread);
      const bps = Math.round(10000 + spreadPct * 100);
      const minRaw = parseEther(newOrderMin || '0');
      const maxRaw = parseEther(newOrderMax || '0');
      const handle = newOrderHandle.replace('@', '');

      if (orderSideToCreate === 'ASK') {
        const askCall = encodeAbiCall(ESCROW_ABI, 'createSellAsk', [handle, rawUnits, BigInt(bps), minRaw, maxRaw], createEscrowAddress);
        const res = await sendL4Tx({
          to: createEscrowAddress,
          data: askCall.calldata,
          valueWei: rawUnits,
          from: wallet.address,
          chainId: L4_CHAIN_ID,
          waitForConfirmation: true
        });
        if (res.txHash) {
          sounds.playConnect();
          confetti({ particleCount: 50, spread: 70 });
          setIsCreateOrderModalOpen(false);
          if (fireballAvailable) selectCohort('fireball');
        }
      } else {
        const bidCall = encodeAbiCall(ESCROW_ABI, 'createBuyBid', [handle, rawUnits, BigInt(bps), minRaw, maxRaw], createEscrowAddress);
        const res = await sendL4Tx({
          to: createEscrowAddress,
          data: bidCall.calldata,
          from: wallet.address,
          chainId: L4_CHAIN_ID,
          waitForConfirmation: true
        });
        if (res.txHash) {
          sounds.playConnect();
          confetti({ particleCount: 50, spread: 70 });
          setIsCreateOrderModalOpen(false);
          if (fireballAvailable) selectCohort('fireball');
        }
      }
      await refreshL4Balance();
    } catch (err: any) {
      console.error('Create order error:', err);
      setModalError(err?.shortMessage || err?.message || 'Transaction failed');
    } finally {
      setIsSubmittingTx(false);
    }
  };

  // ON-CHAIN WRITE (L4): Fill Order (taking a Bid escrows native $xMoney)
  const handleFillOrderOnChain = async () => {
    if (!selectedOrderForTrade) return;
    if (!wallet.connected) {
      onConnectWallet();
      return;
    }

    setIsSubmittingTx(true);
    try {
      const rawUnits = parseEther(tradeAmount || '0');
      const handle = takerHandle.replace('@', '');
      const escrowAddress = selectedOrderForTrade.contractAddress;

      if (selectedOrderForTrade.side === 'ASK') {
        const takeAskCall = encodeAbiCall(ESCROW_ABI, 'fillSellAsk', [BigInt(selectedOrderForTrade.id), rawUnits, handle], escrowAddress);
        const res = await sendL4Tx({
          to: escrowAddress,
          data: takeAskCall.calldata,
          from: wallet.address,
          chainId: L4_CHAIN_ID,
          waitForConfirmation: true
        });
        if (res.txHash) {
          sounds.playConnect();
          confetti({ particleCount: 60, spread: 80 });
          closeOrder();
        }
      } else {
        const takeBidCall = encodeAbiCall(ESCROW_ABI, 'fillBuyBid', [BigInt(selectedOrderForTrade.id), rawUnits, handle], escrowAddress);
        const res = await sendL4Tx({
          to: escrowAddress,
          data: takeBidCall.calldata,
          valueWei: rawUnits,
          from: wallet.address,
          chainId: L4_CHAIN_ID,
          waitForConfirmation: true
        });
        if (res.txHash) {
          sounds.playConnect();
          confetti({ particleCount: 60, spread: 80 });
          closeOrder();
        }
      }
      await refreshL4Balance();
    } catch (err: any) {
      console.error('Fill order error:', err);
      setModalError(err?.shortMessage || err?.message || 'Transaction failed');
    } finally {
      setIsSubmittingTx(false);
    }
  };

  // ON-CHAIN WRITE (L4): Release Escrow (0.01% burn to 0xdead + 0.01% rake to Fanout + 0.02% XGAS.DEV buyback, 99.96% to buyer)
  const handleReleaseTradeOnChain = async (trade: OtcTrade) => {
    if (!wallet.connected) {
      onConnectWallet();
      return;
    }

    try {
      const releaseCall = encodeAbiCall(ESCROW_ABI, 'releaseTrade', [BigInt(trade.id)], trade.contractAddress);
      const res = await sendL4Tx({
        to: trade.contractAddress,
        data: releaseCall.calldata,
        from: wallet.address,
        chainId: L4_CHAIN_ID,
        waitForConfirmation: true
      });

      if (res.txHash) {
        sounds.playConnect();
        confetti({ particleCount: 70, spread: 90 });
      }
      await refreshL4Balance();
    } catch (err: any) {
      console.error('Release trade error:', err);
      alert(err?.shortMessage || err?.message || 'Release failed');
    }
  };

  // ON-CHAIN WRITE (L4): Cancel a maker order (refunds uncommitted escrowed $xMoney on Asks)
  const handleCancelOrderOnChain = async (order: OtcOrder) => {
    if (!wallet.connected) {
      onConnectWallet();
      return;
    }
    try {
      const cancelCall = encodeAbiCall(ESCROW_ABI, 'cancelOrder', [BigInt(order.id)], order.contractAddress);
      await sendL4Tx({
        to: order.contractAddress,
        data: cancelCall.calldata,
        from: wallet.address,
        chainId: L4_CHAIN_ID,
        waitForConfirmation: true
      });
      sounds.playConnect();
      await refreshL4Balance();
    } catch (err: any) {
      console.error('Cancel order error:', err);
      alert(err?.shortMessage || err?.message || 'Cancel failed');
    }
  };

  // ON-CHAIN WRITE (L4): War of Attrition — buy keys with native $xMoney (exact cost read on-chain; overpay is refunded)
  const handleBuyKeysOnChain = async () => {
    if (!wallet.connected) {
      onConnectWallet();
      return;
    }

    setFomoBusy(true); setFomoError(null);
    try {
      if (fireballAvailable && cohort === 'legacy') throw new Error('New keys are sold in the current game. Go back to the current game to buy.');
      const count = BigInt(Math.max(1, Math.floor(keysToBuy)));
      const priceWei = await l4PublicClient.readContract({ address: activeFomoAddress as `0x${string}`, abi: FOMO_ABI, functionName: 'getKeyPrice' });
      const costWei = priceWei * count;
      const buyCall = encodeAbiCall(FOMO_ABI, 'buyKeys', [fomoXHandle.replace('@', ''), count], activeFomoAddress, formatEther(costWei));
      const res = await sendL4Tx({
        to: activeFomoAddress,
        data: buyCall.calldata,
        valueWei: costWei,
        from: wallet.address,
        chainId: L4_CHAIN_ID,
        waitForConfirmation: true
      });

      if (res.txHash) {
        sounds.playConnect();
        confetti({ particleCount: 50, spread: 70 });
      }
      await refreshL4Balance();
    } catch (err: any) {
      console.error('Buy keys error:', err);
      setFomoError(err?.shortMessage || err?.message || 'Transaction failed');
    } finally {
      setFomoBusy(false);
    }
  };

  // ON-CHAIN WRITE (L4): War of Attrition — claim continuous dividends in native $xMoney
  const handleClaimDividendsOnChain = async () => {
    if (!wallet.connected) {
      onConnectWallet();
      return;
    }

    setFomoBusy(true); setFomoError(null);
    try {
      const claimCall = encodeAbiCall(FOMO_ABI, 'claimDividends', [], activeFomoAddress);
      const res = await sendL4Tx({
        to: activeFomoAddress,
        data: claimCall.calldata,
        from: wallet.address,
        chainId: L4_CHAIN_ID,
        waitForConfirmation: true
      });

      if (res.txHash) {
        sounds.playConnect();
        confetti({ particleCount: 50, spread: 70 });
      }
      await refreshL4Balance();
    } catch (err: any) {
      console.error('Claim dividends error:', err);
      setFomoError(err?.shortMessage || err?.message || 'Transaction failed');
    } finally {
      setFomoBusy(false);
    }
  };

  // ON-CHAIN WRITE (L4): War of Attrition — pay the expired round's jackpot to the last king and open the next round
  const handleClaimJackpotOnChain = async () => {
    if (!wallet.connected) {
      onConnectWallet();
      return;
    }
    setFomoBusy(true); setFomoError(null);
    try {
      const jackpotCall = encodeAbiCall(FOMO_ABI, 'claimJackpot', [], activeFomoAddress);
      const res = await sendL4Tx({
        to: activeFomoAddress,
        data: jackpotCall.calldata,
        from: wallet.address,
        chainId: L4_CHAIN_ID,
        waitForConfirmation: true
      });
      if (res.txHash) {
        sounds.playConnect();
        confetti({ particleCount: 120, spread: 120 });
      }
      await refreshL4Balance();
    } catch (err: any) {
      console.error('Claim jackpot error:', err);
      setFomoError(err?.shortMessage || err?.message || 'Transaction failed');
    } finally {
      setFomoBusy(false);
    }
  };

  // A winner whose wallet couldn't take the jackpot push gets it held on-chain; they pull it with withdrawJackpot.
  const [myJackpotOwed, setMyJackpotOwed] = useState(0n);
  useEffect(() => {
    if (!wallet.connected || !activeFomoAddress) { setMyJackpotOwed(0n); return; }
    let alive = true;
    const read = () => l4PublicClient.readContract({ address: activeFomoAddress as `0x${string}`, abi: FOMO_ABI, functionName: 'jackpotOwed', args: [wallet.address as `0x${string}`] })
      .then((v) => { if (alive) setMyJackpotOwed(v as bigint); }).catch(() => {});
    read();
    const t = setInterval(read, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, [wallet.connected, wallet.address, activeFomoAddress]);

  const handleWithdrawJackpotOnChain = async () => {
    setFomoBusy(true); setFomoError(null);
    try {
      const call = encodeAbiCall(FOMO_ABI, 'withdrawJackpot', [wallet.address], activeFomoAddress);
      await sendL4Tx({ to: activeFomoAddress, data: call.calldata, from: wallet.address, chainId: L4_CHAIN_ID, waitForConfirmation: true });
      setMyJackpotOwed(0n);
      sounds.playConnect();
      confetti({ particleCount: 120, spread: 120 });
      await refreshL4Balance();
    } catch (err: any) {
      console.error('Withdraw jackpot error:', err);
      setFomoError(err?.shortMessage || err?.message || 'Transaction failed');
    } finally {
      setFomoBusy(false);
    }
  };

  const roundExpired = Date.now() > fomo.roundDeadline && fomo.currentLeader !== '0x0000000000000000000000000000000000000000';

  const filteredOrders = useMemo(() => {
    if (orderBookSide === 'ALL') return orders;
    return orders.filter(o => o.side === orderBookSide);
  }, [orders, orderBookSide]);

  return (
    <div className="max-w-[1780px] mx-auto px-3 sm:px-6 py-4 space-y-5 font-sans">
      
      {/* 1. TOPOLOGY & PROTOCOL BANNER */}
      <div className="relative overflow-hidden rounded-2xl border border-emerald-500/30 bg-gradient-to-r from-[#0d121f] via-[#090e18] to-[#120a1f] p-3.5 sm:p-5 shadow-2xl">
        <div className="absolute top-0 right-0 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none -mr-20 -mt-20" />

        <div className="relative z-10 flex flex-col lg:flex-row lg:items-center justify-between gap-4 sm:gap-6">
          <div className="space-y-2 min-w-0">
            <div className="flex items-center gap-2 overflow-x-auto no-scrollbar -mx-3.5 px-3.5 sm:mx-0 sm:px-0 sm:flex-wrap [&>*]:shrink-0 [&>*]:whitespace-nowrap">
              <span className="px-2.5 py-0.5 rounded-full text-xs font-black bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 font-mono tracking-wider flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                ARBITRUM ORBIT L4 · LIVE
              </span>
              <a 
                href="https://robinhoodchain.blockscout.com" 
                target="_blank" 
                rel="noreferrer"
                className="px-2 py-0.5 rounded-md text-[11px] font-bold bg-slate-800 hover:bg-slate-700 text-slate-300 font-mono border border-slate-700 flex items-center gap-1 transition-colors"
              >
                <span>SETTLES ON ROBINHOOD CHAIN #4663</span>
                <ExternalLink className="w-2.5 h-2.5" />
              </a>
              <span className="px-2 py-0.5 rounded-md text-[11px] font-bold bg-emerald-500/20 text-emerald-300 font-mono border border-emerald-500/40 flex items-center gap-1">
                <ShieldCheck className="w-3 h-3" />
                <span>100% FULL RESERVE BACKING</span>
              </span>
            </div>

            <h1 className="text-lg sm:text-3xl font-black text-white font-display tracking-tight leading-tight">
              The @XMoney Gas Rollup on Robinhood Chain
            </h1>

            <p className="text-xs sm:text-sm text-slate-400 max-w-2xl leading-relaxed">
              Deposit USDG, get $xMoney gas on the xgas L4. Trade it peer-to-peer for X Money, or withdraw it back to Robinhood and redeem USDG.
            </p>

            {/* Fee meta: small, one line, linked. The breakdown lives in the fee disclosure on the desk. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-mono text-slate-500">
              <span>0.04% fee per trade:</span>
              <a href="https://robinhoodchain.blockscout.com/address/0x000000000000000000000000000000000000dEaD" target="_blank" rel="noreferrer" className="text-amber-400/80 hover:text-amber-300 hover:underline">0.01% burn</a>
              <a href="https://robinhoodchain.blockscout.com/address/0x04C9229Fba6AFDC6ac9eD4312acb4BC74f1a436e" target="_blank" rel="noreferrer" className="text-cyan-400/80 hover:text-cyan-300 hover:underline">0.01% Stacc Wizards fanout</a>
              <a href={`https://robinhoodchain.blockscout.com/token/${CONTRACT_ADDRESSES.XGAS_DEV}`} target="_blank" rel="noreferrer" className="text-emerald-400/80 hover:text-emerald-300 hover:underline">0.02% XGAS.DEV buy &amp; burn</a>
            </div>
          </div>

          {/* Real Metrics Cards */}
          <div className="grid grid-cols-3 gap-2 sm:gap-3 shrink-0 font-mono">
            <div className="p-2.5 sm:p-3 rounded-xl bg-[#121624] border border-amber-500/30 min-w-0">
              <div className="flex items-center gap-1 text-[11px] font-bold text-amber-400 uppercase tracking-wider">
                <Flame className="w-3.5 h-3.5" />
                <span className="truncate">Burned</span>
              </div>
              <div className="text-sm sm:text-xl font-black text-white mt-1 truncate">
                {totalBurnedSupply.toFixed(4)} <span className="hidden sm:inline text-xs text-slate-400">$xMoney</span>
              </div>
              <a 
                href="https://robinhoodchain.blockscout.com/address/0x000000000000000000000000000000000000dEaD" 
                target="_blank" 
                rel="noreferrer"
                className="hidden sm:flex text-[10px] text-amber-400 hover:underline items-center gap-1 mt-0.5"
              >
                <span>0x000...dEaD</span>
                <ExternalLink className="w-2.5 h-2.5" />
              </a>
            </div>

            <div className="p-2.5 sm:p-3 rounded-xl bg-[#121624] border border-cyan-500/30 min-w-0">
              <div className="flex items-center gap-1 text-[11px] font-bold text-cyan-400 uppercase tracking-wider">
                <Award className="w-3.5 h-3.5" />
                <span className="truncate"><span className="sm:hidden">Rake</span><span className="hidden sm:inline">Fanout Rake</span></span>
              </div>
              <div className="text-sm sm:text-xl font-black text-cyan-300 mt-1 truncate">
                ${totalFanoutRaked.toFixed(2)} <span className="hidden sm:inline text-xs text-slate-400">USD</span>
              </div>
              <a 
                href="https://robinhoodchain.blockscout.com/address/0x04C9229Fba6AFDC6ac9eD4312acb4BC74f1a436e" 
                target="_blank" 
                rel="noreferrer"
                className="hidden sm:flex text-[10px] text-cyan-400 hover:underline items-center gap-1 mt-0.5"
              >
                <span>0x04C9...36e</span>
                <ExternalLink className="w-2.5 h-2.5" />
              </a>
            </div>

            <div className="p-2.5 sm:p-3 rounded-xl bg-[#121624] border border-[#1e2538] min-w-0">
              <div className="flex items-center gap-1 text-[11px] font-bold text-emerald-400 uppercase tracking-wider">
                <TrendingUp className="w-3.5 h-3.5" />
                <span className="truncate">NAV</span>
              </div>
              <div className="text-sm sm:text-xl font-black text-emerald-400 mt-1 truncate">
                <span className="sm:hidden">${navMultiplier.toFixed(4)}</span><span className="hidden sm:inline">${navMultiplier.toFixed(6)}</span>
              </div>
              <div className="text-[10px] text-emerald-500 font-bold">&gt; $1.00 Pegged</div>
            </div>
          </div>
        </div>
      </div>

      {/* 2. SUB-NAVIGATION TABS */}
      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center sm:justify-between gap-2.5 sm:gap-3 border-b border-[#1f2638] pb-2">
        <div className="flex items-center gap-1 sm:gap-2 overflow-x-auto no-scrollbar -mx-3 px-3 sm:mx-0 sm:px-0 snap-x [&>button]:shrink-0 [&>button]:whitespace-nowrap [&>button]:snap-start">
          <button
            onClick={() => setActiveTab('otc')}
            className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold font-display transition-all cursor-pointer flex items-center gap-2 ${
              activeTab === 'otc'
                ? 'bg-emerald-500 text-slate-950 shadow-lg shadow-emerald-500/20'
                : 'text-slate-400 hover:text-white hover:bg-[#121624]'
            }`}
          >
            <Coins className="w-4 h-4" />
            <span className="sm:hidden">Desk</span><span className="hidden sm:inline">P2P desk</span>
            <span className="px-1.5 py-0.2 rounded text-[10px] font-black bg-black/20 text-slate-900 font-mono">
              {orders.length}
            </span>
          </button>

          <button
            onClick={() => setActiveTab('explorer')}
            className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold font-display transition-all cursor-pointer flex items-center gap-2 ${
              activeTab === 'explorer'
                ? 'bg-gradient-to-r from-cyan-400 to-blue-500 text-slate-950 shadow-lg shadow-cyan-500/20 font-black'
                : 'text-slate-400 hover:text-white hover:bg-[#121624]'
            }`}
          >
            <Database className="w-4 h-4" />
            <span className="sm:hidden">Explorer</span><span className="hidden sm:inline">L4 Explorer</span>
            <span className="px-1.5 py-0.2 rounded text-[10px] font-black bg-cyan-500/20 text-cyan-300">
              LIVE
            </span>
          </button>

          <button
            onClick={() => setActiveTab('fomo3d')}
            className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold font-display transition-all cursor-pointer flex items-center gap-2 ${
              activeTab === 'fomo3d'
                ? 'bg-gradient-to-r from-amber-500 to-rose-500 text-slate-950 shadow-lg shadow-amber-500/20 font-black'
                : 'text-slate-400 hover:text-white hover:bg-[#121624]'
            }`}
          >
            <Clock className="w-4 h-4" />
            <span className="sm:hidden">FOMO3D</span><span className="hidden sm:inline">FOMO3D game</span>
            <span className="px-1.5 py-0.2 rounded text-[10px] font-black bg-rose-500/20 text-rose-300">
              POT: ${fomo.jackpotPot.toFixed(2)}
            </span>
          </button>

          <button
            onClick={() => setActiveTab('specs')}
            className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold font-display transition-all cursor-pointer flex items-center gap-2 ${
              activeTab === 'specs'
                ? 'bg-emerald-500 text-slate-950 shadow-lg shadow-emerald-500/20'
                : 'text-slate-400 hover:text-white hover:bg-[#121624]'
            }`}
          >
            <Info className="w-4 h-4" />
            <span className="sm:hidden">Specs</span><span className="hidden sm:inline">Specs &amp; trust model</span>
          </button>
        </div>

        <div className="grid grid-cols-2 sm:flex items-center gap-2">
          <button
            onClick={() => {
              setOrderSideToCreate('ASK');
              setIsCreateOrderModalOpen(true);
            }}
            className="px-3.5 py-2.5 sm:py-2 rounded-xl text-xs font-bold bg-gradient-to-r from-emerald-500 to-teal-500 text-slate-950 hover:brightness-110 transition-all shadow-md flex items-center justify-center gap-1.5 cursor-pointer font-display"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Post Sell Ask</span>
          </button>

          <button
            onClick={() => {
              setOrderSideToCreate('BID');
              setIsCreateOrderModalOpen(true);
            }}
            className="px-3.5 py-2.5 sm:py-2 rounded-xl text-xs font-bold bg-gradient-to-r from-cyan-400 to-blue-500 text-slate-950 hover:brightness-110 transition-all shadow-md flex items-center justify-center gap-1.5 cursor-pointer font-display"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Post Buy Bid</span>
          </button>
        </div>
      </div>

      {wallet.connected && (activeTab === 'otc' || activeTab === 'fomo3d') && <L4GasPanel owner={wallet.address} />}

      {fireballAvailable && (activeTab === 'otc' || activeTab === 'fomo3d') && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-cyan-500/30 bg-[#0e1521] px-3 py-2 text-xs font-mono">
          {cohort === 'legacy' ? (
            <>
              <span className="text-amber-200">Viewing older positions (original contracts).</span>
              <button onClick={() => selectCohort('fireball')} className="rounded-lg px-3 py-1.5 bg-cyan-400 text-slate-950 font-black cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300">Back to current desk</button>
            </>
          ) : (
            <>
              <span className="text-slate-500">Have orders, trades or round rewards from before the relaunch?</span>
              <button onClick={() => selectCohort('legacy')} className="text-amber-200 hover:text-white underline-offset-2 hover:underline cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300 rounded">older positions</button>
            </>
          )}
        </div>
      )}

      {/* 2.5 TAB: REAL L4 EXPLORER */}
      {activeTab === 'explorer' && <OrbitL4Explorer />}

      {/* 3. TAB A: P2P OTC ORDERBOOK & ON-RAMP / OFF-RAMP */}
      {activeTab === 'otc' && (
        <div className="space-y-6">
          {deepLinkNotice && (
            <div className="px-4 py-2.5 rounded-xl bg-amber-500/15 border border-amber-500/40 text-amber-200 text-xs font-mono flex items-center justify-between gap-3">
              <span>{deepLinkNotice}</span>
              <button onClick={() => setDeepLinkNotice(null)} className="text-amber-300 hover:text-white cursor-pointer">✕</button>
            </div>
          )}
          
          {/* TOP SECTION: 1-CLICK ON-RAMP & CASH-OUT (ABSTRACTED IN XMONEY) */}
          <div className="bg-[#0e121d] border border-emerald-500/40 rounded-2xl p-5 shadow-xl space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#1b2334] pb-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <h3 className="text-base font-bold text-white font-display flex items-center gap-2">
                    <ArrowDownUp className="w-4 h-4 text-emerald-400" />
                    <span>Move money in and out</span>
                  </h3>
                </div>
                <p className="text-xs text-slate-400 mt-0.5">
                  <strong className="text-emerald-300">Deposit</strong> turns USDG into $xMoney gas on the L4. <strong className="text-rose-300">Withdraw</strong> is how $xMoney gets back to Robinhood, where you can redeem it for USDG.
                </p>
              </div>

              <div className="flex items-center gap-3 font-mono text-xs">
                <div className="px-3 py-1.5 rounded-xl bg-[#141a29] border border-emerald-500/40">
                  <span className="text-slate-400">L4 gas: </span>
                  <strong className="text-emerald-400 font-bold">{userXMoneyBalance.toFixed(3)} $xMoney</strong>
                  <span className="text-slate-600"> · </span>
                  <span className="text-slate-400">USDG on Robinhood: </span>
                  <strong className="text-white font-bold">${userUsdg.toFixed(2)}</strong>
                </div>
              </div>
            </div>

            {/* Mint & Burn Action Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 font-mono text-xs">
              {/* ENTER / MINT */}
              <div className="p-4 rounded-xl bg-[#121624] border border-emerald-500/30 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
                    <Plus className="w-3.5 h-3.5" />
                    <span>Deposit USDG</span>
                  </span>
                  <span className="text-[10px] text-slate-500">1:1 backed · 0.01% fanout + 0.01% burn</span>
                </div>

                <p className="text-[11px] text-slate-300 leading-relaxed font-sans">
                  Lands as <strong className="text-emerald-300">$xMoney gas in your L4 wallet</strong> in about a minute. Nothing arrives on Robinhood; to hold $xMoney there, withdraw it (right).
                </p>
                <Disclosure label="How it works">
                  <p>Your USDG is locked in the XMoney vault on Robinhood Chain. The vault mints $xMoney and sends it through the canonical Orbit Inbox to your address on the L4, where it is the native gas token. One transaction, plus a USDG approval the first time.</p>
                </Disclosure>

                {DEPOSITS_PAUSED && (
                  <p className="text-[11px] leading-relaxed text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">{DEPOSITS_PAUSED_MSG}</p>
                )}
                <form onSubmit={handleMintXMoney} className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <span className="absolute left-3 top-2.5 text-slate-500 font-bold">$</span>
                    <input
                      type="number"
                      step="1"
                      required
                      value={vaultAmount}
                      onChange={e => setVaultAmount(e.target.value)}
                      placeholder="Amount USD"
                      className="w-full bg-[#141a29] border border-[#1e2538] rounded-xl pl-7 pr-3 py-2 text-white font-bold focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isSubmittingTx || DEPOSITS_PAUSED}
                    aria-busy={isSubmittingTx || undefined}
                    className="px-5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 font-black text-xs font-display shadow-md shadow-emerald-500/20 cursor-pointer shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
                  >
                    <span className="sm:hidden">Deposit → L4 gas</span><span className="hidden sm:inline">Deposit → $xMoney gas on L4</span>
                  </button>
                </form>
              </div>

              {/* EXIT / BURN */}
              <div className="p-4 rounded-xl bg-[#121624] border border-rose-500/30 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-rose-400 uppercase tracking-wider flex items-center gap-1.5">
                    <Flame className="w-3.5 h-3.5" />
                    <span>Withdraw to Robinhood</span>
                  </span>
                  <span className="text-[10px] text-slate-500">Full reserve · 0.01% fanout on redeem</span>
                </div>

                <p className="text-[11px] text-slate-300 leading-relaxed font-sans">
                  Lands as <strong className="text-rose-300">$xMoney (ERC-20) in your Robinhood wallet</strong> automatically once Robinhood confirms, usually minutes. Redeem it for USDG there whenever you like.
                </p>
                <Disclosure label="How it works">
                  <p>Withdrawing burns native $xMoney on the L4 and queues a message to Robinhood. Robinhood must confirm an L4 state assertion that includes it: usually minutes with fast confirmation, up to ~7 days if the fast confirmer is down. Once confirmed, xgas.dev executes the delivery on the Robinhood Outbox for you and pays that gas; the call is permissionless, so anyone can do it if the host does not. Then redeem $xMoney for USDG from the vault whenever you like.</p>
                </Disclosure>

                <form onSubmit={handleBurnXMoney} className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <span className="absolute left-3 top-2.5 text-slate-500 font-bold">$</span>
                    <input
                      type="number"
                      step="1"
                      required
                      value={vaultAmount}
                      onChange={e => setVaultAmount(e.target.value)}
                      placeholder="Amount $xMoney"
                      className="w-full bg-[#141a29] border border-[#1e2538] rounded-xl pl-7 pr-3 py-2 text-white font-bold focus:outline-none focus:border-rose-500"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isSubmittingTx}
                    aria-busy={isSubmittingTx || undefined}
                    className="px-5 py-2 rounded-xl bg-rose-500 hover:bg-rose-400 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 font-black text-xs font-display shadow-md shadow-rose-500/20 cursor-pointer shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"
                  >
                    <span className="sm:hidden">Withdraw</span><span className="hidden sm:inline">Withdraw → $xMoney on Robinhood</span>
                  </button>
                </form>
              </div>
            </div>

            {bridgeStatus && (
              <div className="px-4 py-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-200 text-xs font-mono flex items-center justify-between gap-3">
                <span>{bridgeStatus}</span>
                <button onClick={() => setBridgeStatus(null)} className="text-cyan-300 hover:text-white cursor-pointer">✕</button>
              </div>
            )}

            {/* Withdrawals: L4 -> Robinhood -> USDG */}
            {wallet.connected && (withdrawals.length > 0 || userL3XMoney > 0) && (
              <div className="p-4 rounded-xl bg-[#121624] border border-[#1e2538] space-y-3 font-mono text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-white uppercase tracking-wider">Your withdrawals</span>
                  <span className="text-[10px] text-slate-500">{withdrawals.filter(w => w.status !== 'executed').length} in progress</span>
                </div>
                {withdrawals.filter(w => w.status !== 'executed').map(w => (
                  <div key={`${w.txHash}:${w.position}`} className="flex flex-wrap items-center justify-between gap-3 p-2.5 rounded-lg bg-[#0e121d] border border-[#1e2538]">
                    <div className="space-y-1.5 min-w-0">
                      <div className="text-white font-bold">{Number(w.amount).toFixed(4)} $xMoney</div>
                      <WithdrawalSteps status={w.status} />
                      <div className="text-[10px] text-slate-500">{w.legacy ? `Old chain #${w.chainId} · ` : ''}L4 tx {w.txHash.slice(0, 10)}… · #{w.position}</div>
                    </div>
                    {w.status === 'claimable' ? (
                      <div className="flex flex-col items-end gap-1">
                        <span className="px-2.5 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[11px]" title="Robinhood has confirmed it. xgas.dev delivers it to your wallet within about a minute.">Confirmed · landing in your wallet</span>
                        {executorEnabled && (
                          <button onClick={() => handleClaimWithdrawal(w)} disabled={isSubmittingTx} className="text-[10px] text-slate-500 hover:text-white underline-offset-2 hover:underline disabled:opacity-50 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 rounded" title="Deliver it now instead of waiting for the automatic run">
                            {isSubmittingTx ? 'Delivering…' : 'deliver now'}
                          </button>
                        )}
                      </div>
                    ) : (
                      <span className="px-2.5 py-1 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[11px]" title="Robinhood has to confirm an L4 state assertion that includes this withdrawal. Usually minutes.">Confirming on Robinhood · minutes</span>
                    )}
                  </div>
                ))}
                {userL3XMoney > 0 && (
                  <div className="flex flex-wrap items-center justify-between gap-3 p-2.5 rounded-lg bg-[#0e121d] border border-emerald-500/30">
                    <div className="space-y-1.5">
                      <div className="text-white font-bold">{userL3XMoney.toFixed(4)} $xMoney on Robinhood</div>
                      <WithdrawalSteps status="executed" />
                      <div className="text-[10px] text-slate-500">Yours to hold, or redeem for USDG (0.01% fanout).</div>
                    </div>
                    <button onClick={handleRedeemUsdg} disabled={isSubmittingTx} className="px-3 py-1.5 rounded-lg bg-rose-500 hover:bg-rose-400 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 font-black cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300">
                      {isSubmittingTx ? 'Redeeming…' : 'Redeem → USDG'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* LOWER SECTION: P2P ORDERBOOK (TRADING $XMONEY PEER-TO-PEER) */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            
            {/* Main Book Column */}
            <div className="lg:col-span-2 space-y-4">
              <div className="bg-[#0e121d] border border-[#1e2538] rounded-2xl p-4 shadow-xl">
                <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[#1b2234]">
                  <div>
                    <h3 className="text-base font-bold text-white flex items-center gap-2 font-display">
                      <Coins className="w-4 h-4 text-emerald-400" />
                      <span>Order book</span>
                    </h3>
                    <p className="text-xs text-slate-400">
                      Sellers escrow $xMoney on the L4; buyers pay them in X Money. 0.04% fee on release.
                    </p>
                    {fireballAvailable && cohort === 'legacy' && (
                      <p className="mt-1 text-xs text-amber-300">Older order book: you can still fill, cancel and release here. New orders go to the current desk.</p>
                    )}
                  </div>

                  {/* Filter Side Pills */}
                  <div className="flex items-center gap-1 text-xs font-mono">
                    {(['ALL', 'ASK', 'BID'] as const).map(s => (
                      <button
                        key={s}
                        onClick={() => setOrderBookSide(s)}
                        className={`px-3 py-1 rounded-lg cursor-pointer transition-all ${
                          orderBookSide === s
                            ? (s === 'ASK' ? 'bg-emerald-500 text-slate-950 font-black' : (s === 'BID' ? 'bg-cyan-400 text-slate-950 font-black' : 'bg-slate-700 text-white font-bold'))
                            : 'bg-[#151c2d] text-slate-400 hover:text-white'
                        }`}
                      >
                        {s === 'ALL' ? 'All Orders' : (s === 'ASK' ? 'Sell Asks' : 'Buy Bids')}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Order Table */}
                <div className="mt-3 overflow-x-auto">
                  {filteredOrders.length === 0 ? (
                    <div className="text-center py-12 space-y-3">
                      <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center mx-auto text-slate-500">
                        <Coins className="w-6 h-6" />
                      </div>
                      <div className="text-sm font-bold text-white font-display">No open orders yet</div>
                      <p className="text-xs text-slate-400 max-w-sm mx-auto font-sans">
                        Post the first ask or bid.
                      </p>
                      <div className="flex flex-col sm:flex-row justify-center gap-2 pt-2">
                        <button
                          onClick={() => {
                            setOrderSideToCreate('ASK');
                            setIsCreateOrderModalOpen(true);
                          }}
                          className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs font-display shadow-lg shadow-emerald-500/20 cursor-pointer"
                        >
                          Post First Sell Ask
                        </button>
                        <button
                          onClick={() => {
                            setOrderSideToCreate('BID');
                            setIsCreateOrderModalOpen(true);
                          }}
                          className="px-4 py-2 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-black text-xs font-display shadow-lg shadow-cyan-500/20 cursor-pointer"
                        >
                          Post First Buy Bid
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                    {/* Phone: one card per order, action full-width */}
                    <div className="sm:hidden divide-y divide-[#171d2c] font-mono">
                      {filteredOrders.map(order => {
                        const spreadPct = ((order.fiatRateBps - 10000) / 100).toFixed(1);
                        const unitPrice = (order.fiatRateBps / 10000).toFixed(3);
                        const mine = isMine(order.maker);
                        return (
                          <div key={order.id} className="py-3 space-y-2">
                            <div className="flex items-center justify-between gap-2">
                              <span className={`px-2 py-0.5 rounded text-[10px] font-black ${
                                order.side === 'ASK' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/40'
                              }`}>
                                {order.side === 'ASK' ? 'SELL ASK' : 'BUY BID'}
                              </span>
                              <a href={`https://x.com/${order.makerXHandle}`} target="_blank" rel="noreferrer" className="font-bold text-white text-xs font-sans truncate">
                                @{order.makerXHandle}
                              </a>
                            </div>
                            <div className="grid grid-cols-3 gap-2 text-[11px]">
                              <div>
                                <div className="text-[9px] uppercase text-slate-500">Available</div>
                                <div className="font-bold text-white">${order.availableXMoney.toFixed(2)}</div>
                              </div>
                              <div>
                                <div className="text-[9px] uppercase text-slate-500">Rate</div>
                                <div className="font-bold text-emerald-400">${unitPrice} <span className="text-slate-500 font-normal">({spreadPct > '0' ? `+${spreadPct}%` : '0%'})</span></div>
                              </div>
                              <div>
                                <div className="text-[9px] uppercase text-slate-500">Min / Max</div>
                                <div className="text-slate-300">${order.minAmount} – ${order.maxAmount}</div>
                              </div>
                            </div>
                            {mine ? (
                              <button
                                onClick={() => handleCancelOrderOnChain(order)}
                                className="w-full py-2 rounded-lg bg-rose-500/20 border border-rose-500/40 text-rose-300 font-bold text-xs cursor-pointer"
                              >
                                Cancel Mine
                              </button>
                            ) : (
                              <button
                                onClick={() => openOrder(order)}
                                className="w-full py-2 rounded-lg bg-emerald-500 text-slate-950 font-bold text-xs cursor-pointer shadow-md shadow-emerald-500/20"
                              >
                                {order.side === 'ASK' ? 'Buy $xMoney' : 'Sell $xMoney'}
                              </button>
                            )}
                            <button
                              onClick={() => copyLink(orderLink(order.id, order.cohort))}
                              className="w-full py-1.5 rounded-lg bg-[#151c2d] text-slate-400 text-[11px] cursor-pointer"
                            >
                              {copiedLink === orderLink(order.id, order.cohort) ? 'Link copied ✓' : `Copy link · ${order.cohort === 'fireball' ? '/fireball' : ''}/order/${order.id}`}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                    <table className="hidden sm:table w-full text-left text-xs">
                      <thead>
                        <tr className="text-slate-400 border-b border-[#1a2133] uppercase font-mono text-[10px]">
                          <th className="pb-2">Side</th>
                          <th className="pb-2">Maker / X Handle</th>
                          <th className="pb-2">Available $xMoney</th>
                          <th className="pb-2">Price Rate</th>
                          <th className="pb-2">Min / Max</th>
                          <th className="pb-2 text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#171d2c] font-mono">
                        {filteredOrders.map(order => {
                          const spreadPct = ((order.fiatRateBps - 10000) / 100).toFixed(1);
                          const unitPrice = (order.fiatRateBps / 10000).toFixed(3);

                          return (
                            <tr key={order.id} className="hover:bg-[#131826] transition-colors">
                              <td className="py-3">
                                <span className={`px-2 py-0.5 rounded text-[10px] font-black ${
                                  order.side === 'ASK' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/40'
                                }`}>
                                  {order.side === 'ASK' ? 'SELL ASK' : 'BUY BID'}
                                </span>
                              </td>
                              <td className="py-3 font-sans">
                                <div className="flex items-center gap-2">
                                  <a 
                                    href={`https://x.com/${order.makerXHandle}`} 
                                    target="_blank" 
                                    rel="noreferrer"
                                    className="font-bold text-white hover:text-emerald-400 flex items-center gap-1 transition-colors"
                                  >
                                    <span>@{order.makerXHandle}</span>
                                    <ExternalLink className="w-2.5 h-2.5 text-slate-500" />
                                  </a>
                                </div>
                              </td>
                              <td className="py-3 font-bold text-white">
                                ${order.availableXMoney.toFixed(2)}
                              </td>
                              <td className="py-3">
                                <span className="font-bold text-emerald-400">${unitPrice}</span>
                                <span className="text-[10px] ml-1 text-slate-400">({spreadPct > '0' ? `+${spreadPct}%` : '0%'})</span>
                              </td>
                              <td className="py-3 text-slate-300">
                                ${order.minAmount} – ${order.maxAmount}
                              </td>
                              <td className="py-3 text-right">
                                {isMine(order.maker) ? (
                                  <button
                                    onClick={() => handleCancelOrderOnChain(order)}
                                    className="px-3 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/40 border border-rose-500/40 text-rose-300 font-bold transition-all text-xs cursor-pointer"
                                    title="Cancel your order and withdraw escrowed $xMoney"
                                  >
                                    Cancel Mine
                                  </button>
                                ) : (
                                  <button
                                    onClick={() => openOrder(order)}
                                    className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold transition-all text-xs cursor-pointer shadow-md shadow-emerald-500/20"
                                  >
                                    {order.side === 'ASK' ? 'Buy $xMoney' : 'Sell $xMoney'}
                                  </button>
                                )}
                                <button
                                  onClick={() => copyLink(orderLink(order.id, order.cohort))}
                                  className="ml-1.5 px-2 py-1.5 rounded-lg bg-[#151c2d] hover:bg-[#1c2438] text-slate-400 hover:text-white text-xs cursor-pointer align-middle"
                                  title={`Copy deep link ${orderLink(order.id, order.cohort)}`}
                                >
                                  {copiedLink === orderLink(order.id, order.cohort) ? '✓' : <Link2 className="w-3.5 h-3.5 inline" />}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    </>
                  )}
                </div>
              </div>

              {/* Active Escrow Trades */}
              <div className="bg-[#0e121d] border border-[#1e2538] rounded-2xl p-4 shadow-xl">
                <div className="flex items-center justify-between pb-3 border-b border-[#1b2234]">
                  <h3 className="text-base font-bold text-white flex items-center gap-2 font-display">
                    <ShieldCheck className="w-4 h-4 text-cyan-400" />
                    <span>Open trades</span>
                  </h3>
                  <span className="text-xs text-slate-400 font-mono">
                    {trades.length} in escrow · seller releases once paid
                  </span>
                </div>

                <div className="mt-3 space-y-3">
                  {trades.length === 0 ? (
                    <div className="text-center py-6 text-slate-500 text-xs font-mono">
                      No trades in escrow. Take an order above to start one.
                    </div>
                  ) : (
                    trades.map(trade => (
                      <div 
                        key={`${trade.contractAddress}-${trade.id}`}
                        id={`trade-${trade.cohort}-${trade.id}`}
                        className="p-3.5 rounded-xl border bg-[#121624] border-cyan-500/40 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-shadow"
                      >
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => copyLink(tradeLink(trade.id, trade.cohort))}
                              className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 hover:bg-slate-700 text-slate-300 font-mono cursor-pointer"
                              title={`Copy deep link ${tradeLink(trade.id, trade.cohort)}`}
                            >
                              {copiedLink === tradeLink(trade.id, trade.cohort) ? 'LINK COPIED ✓' : `TRADE #${trade.id} 🔗`}
                            </button>
                            <span className="text-xs font-bold text-white font-sans">
                              @{trade.buyerXHandle} taking ${trade.xMoneyAmount.toFixed(2)} from @{trade.sellerXHandle}
                            </span>
                          </div>
                          <div className="text-xs text-slate-400 flex flex-wrap items-center gap-3 font-mono">
                            <span>Buyer pays <strong className="text-emerald-400">${(trade.expectedCents / 100).toFixed(2)}</strong> in X Money</span>
                            <span>•</span>
                            <span title={`0.01% burn $${((trade.xMoneyAmount * 1) / 10000).toFixed(4)} · 0.01% fanout $${((trade.xMoneyAmount * 1) / 10000).toFixed(4)} · 0.02% XGAS.DEV buy & burn $${((trade.xMoneyAmount * 2) / 10000).toFixed(4)}`}>
                              0.04% fee: <strong className="text-amber-400">${((trade.xMoneyAmount * 4) / 10000).toFixed(4)}</strong>
                            </span>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 shrink-0 [&>button]:flex-1 sm:[&>button]:flex-none">
                          <a
                            href={`https://x.com/${trade.sellerXHandle}`}
                            target="_blank"
                            rel="noreferrer"
                            className="px-2.5 py-1.5 rounded-lg bg-[#1a2133] hover:bg-[#222b40] text-slate-300 text-xs font-bold flex items-center gap-1 font-sans"
                          >
                            <span>Open @{trade.sellerXHandle}</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>

                          <a
                            href={`https://x.com/intent/post?text=${encodeURIComponent(`Settling Trade #${trade.id} on @xgas_dev! @${trade.buyerXHandle} -> @${trade.sellerXHandle} on @XMoney. 0.01% burned to 0xdead + 0.01% to Stacc Wizards Fee Fanout + 0.02% XGAS.DEV buy & burn. xgas.dev`)}`}
                            target="_blank"
                            rel="noreferrer"
                            className="p-1.5 rounded-lg bg-blue-500/20 text-blue-400 hover:bg-blue-500/30"
                            title="Share on X"
                          >
                            <Share2 className="w-3.5 h-3.5" />
                          </a>

                          <button
                            onClick={() => handleReleaseTradeOnChain(trade)}
                            className="px-3 py-2 sm:py-1.5 rounded-lg bg-gradient-to-r from-emerald-500 to-teal-500 hover:brightness-110 text-slate-950 font-bold text-xs shadow-md shadow-emerald-500/20 cursor-pointer flex items-center justify-center gap-1.5 font-display"
                          >
                            <CheckCircle className="w-3.5 h-3.5" />
                            <span>Release $xMoney</span>
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            {/* Right Column: Deep Link Protocol Hub */}
            <div className="space-y-4">
              
              {/* Deep Links Hub */}
              <div className="bg-[#0e121d] border border-[#1e2538] rounded-2xl p-4 shadow-xl space-y-3">
                <h4 className="text-sm font-bold text-white flex items-center gap-2 font-display">
                  <ExternalLink className="w-4 h-4 text-emerald-400" />
                  <span>Links &amp; contracts</span>
                </h4>
                <div className="space-y-2 text-xs font-mono">
                  <div className="grid grid-cols-2 gap-2">
                    {TAB_IDS.map(tab => (
                      <a
                        key={tab}
                        href={`/${tab}`}
                        onClick={(ev) => { ev.preventDefault(); setActiveTab(tab); }}
                        className={`p-2.5 rounded-lg border flex items-center justify-between transition-colors ${
                          activeTab === tab ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300' : 'bg-[#141a29] hover:bg-[#1a2336] border-[#1e2538] text-slate-300'
                        }`}
                        title={`Deep link: ${deepLink(tab, cohort)}`}
                      >
                        <span className="font-bold">
                          {tab === 'otc' ? 'P2P Desk' : tab === 'explorer' ? 'L4 Explorer' : tab === 'fomo3d' ? 'FOMO3D' : 'Specs'}
                        </span>
                        <span className="text-[10px] text-slate-500">/{tab}</span>
                      </a>
                    ))}
                  </div>
                  <div className="flex items-center justify-between gap-2 p-2 rounded-lg bg-[#0b0e17] border border-[#1e2538]">
                    <span className="text-slate-400 truncate">{deepLink(activeTab, cohort)}</span>
                    <button
                      onClick={() => navigator.clipboard.writeText(deepLink(activeTab, cohort))}
                      className="px-2 py-1 rounded bg-emerald-500 text-slate-950 font-black uppercase text-[10px] cursor-pointer shrink-0"
                    >
                      Copy link
                    </button>
                  </div>
                  <Disclosure label="Details / contracts" className="pt-1">
                  <div className="space-y-2 font-mono text-xs">
                  <a
                    href={`https://robinhoodchain.blockscout.com/address/${CONTRACT_ADDRESSES.XMONEY_USD_L3}`}
                    target="_blank"
                    rel="noreferrer"
                    className="p-2.5 rounded-lg bg-[#141a29] hover:bg-[#1a2336] border border-[#1e2538] flex items-center justify-between text-slate-300 transition-colors"
                  >
                    <span className="text-slate-400">Vault Contract:</span>
                    <span className="text-cyan-400 font-bold flex items-center gap-1">
                      <span>{CONTRACT_ADDRESSES.XMONEY_USD_L3.slice(0, 8)}...</span>
                      <ExternalLink className="w-3 h-3" />
                    </span>
                  </a>

                  <a
                    href="#explorer"
                    onClick={(ev) => { ev.preventDefault(); setActiveTab('explorer'); }}
                    className="p-2.5 rounded-lg bg-[#141a29] hover:bg-[#1a2336] border border-[#1e2538] flex items-center justify-between text-slate-300 transition-colors"
                  >
                    <span className="text-slate-400">P2P Escrow (Orbit L4):</span>
                    <span className="text-emerald-400 font-bold flex items-center gap-1">
                      <span>{activeEscrowAddress.slice(0, 8)}...</span>
                      <ExternalLink className="w-3 h-3" />
                    </span>
                  </a>

                  <a
                    href="https://robinhoodchain.blockscout.com/address/0x04C9229Fba6AFDC6ac9eD4312acb4BC74f1a436e"
                    target="_blank"
                    rel="noreferrer"
                    className="p-2.5 rounded-lg bg-[#141a29] hover:bg-[#1a2336] border border-[#1e2538] flex items-center justify-between text-slate-300 transition-colors"
                  >
                    <span className="text-slate-400">Stacc Wizards Fee Fanout:</span>
                    <span className="text-cyan-400 font-bold flex items-center gap-1">
                      <span>0x04C9...36e</span>
                      <ExternalLink className="w-3 h-3" />
                    </span>
                  </a>

                  <a
                    href="https://robinhoodchain.blockscout.com/address/0x000000000000000000000000000000000000dEaD"
                    target="_blank"
                    rel="noreferrer"
                    className="p-2.5 rounded-lg bg-[#141a29] hover:bg-[#1a2336] border border-[#1e2538] flex items-center justify-between text-slate-300 transition-colors"
                  >
                    <span className="text-slate-400">Dead Burn Sink:</span>
                    <span className="text-amber-400 font-bold flex items-center gap-1">
                      <span>0x000...dEaD</span>
                      <ExternalLink className="w-3 h-3" />
                    </span>
                  </a>

                  <a
                    href={`https://robinhoodchain.blockscout.com/token/${CONTRACT_ADDRESSES.XGAS_DEV}`}
                    target="_blank"
                    rel="noreferrer"
                    className="p-2.5 rounded-lg bg-[#141a29] hover:bg-[#1a2336] border border-[#1e2538] flex items-center justify-between text-slate-300 transition-colors"
                  >
                    <span className="text-slate-400">XGAS.DEV Buy & Burn:</span>
                    <span className="text-emerald-400 font-bold flex items-center gap-1">
                      <span>{CONTRACT_ADDRESSES.XGAS_DEV.slice(0, 6)}...{CONTRACT_ADDRESSES.XGAS_DEV.slice(-3)}</span>
                      <ExternalLink className="w-3 h-3" />
                    </span>
                  </a>
                  </div>
                  </Disclosure>

                  <a
                    href={`https://x.com/intent/post?text=${encodeURIComponent(`Trading @XMoney P2P on @xgas_dev L4! Every single trade burns 1 bp to 0xdead, rakes 1 bp to the @staccpad Stacc Wizards Fee Fanout on Robinhood Chain, and spends 2 bp buying and burning XGAS.DEV. xgas.dev`)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="w-full py-2.5 rounded-xl bg-gradient-to-r from-blue-500/20 to-cyan-500/20 hover:brightness-110 border border-blue-500/40 text-cyan-300 font-bold flex items-center justify-center gap-2 transition-colors mt-2 font-sans"
                  >
                    <Share2 className="w-3.5 h-3.5" />
                    <span>Share on X</span>
                  </a>
                </div>
              </div>

              {/* The Nash Mechanics Card */}
              <div className="bg-gradient-to-b from-[#111726] to-[#0d111c] border border-amber-500/30 rounded-2xl p-4 shadow-xl">
                <div className="flex items-center gap-2 text-amber-400 text-xs font-bold uppercase tracking-wider mb-2 font-mono">
                  <Flame className="w-4 h-4" />
                  <span>Fees</span>
                </div>
                <h4 className="text-sm font-bold text-white mb-1 font-display">0.04% per trade, taken on release</h4>
                <p className="text-xs text-slate-400 leading-relaxed font-sans">
                  0.01% burned, 0.01% to the Stacc Wizards fanout, 0.02% buys and burns XGAS.DEV.
                </p>
                <Disclosure label="Where each part goes, and why this is not deflation" className="mt-2">
                  <p>
                    The burn goes to <code className="text-amber-400 font-mono">0xdead</code> on the L4. The fanout share goes to <code className="text-cyan-400 font-mono" title="0x652125E71C7f209e640C0069e4a5e77FAfa99b4B">FanoutSink 0x6521...9b4B</code> on the L4, which bridges to the Stacc Wizards Fee Fanout on Robinhood once it holds 0.01 xMoney. The buyback buys and burns <code className="text-emerald-400 font-mono">XGAS.DEV</code> on Robinhood.
                  </p>
                  <p>
                    Burns on the L4 do not reduce the supply the vault counts, and each vault deposit also mints 0.0001 unbacked xMoney to pay L4 delivery gas. The burns are small: NAV rose about 0.018% in the last week. r/s (vault USDG over circulating xMoney) is a division, not a forecast.
                  </p>
                </Disclosure>

                <div className="mt-4 p-3 rounded-xl bg-black/40 border border-amber-500/20 space-y-2 font-mono text-xs">
                  <div className="flex justify-between text-slate-400">
                    <span>Gross Trade:</span>
                    <span className="text-white">$100.00 xMoney</span>
                  </div>
                  <div className="flex justify-between text-amber-400">
                    <span>0.01% Burn (0xdead):</span>
                    <span>-$0.01</span>
                  </div>
                  <div className="flex justify-between text-cyan-400">
                    <span>0.01% Fanout Rake:</span>
                    <span>-$0.01</span>
                  </div>
                  <div className="flex justify-between text-emerald-400">
                    <span>0.02% XGAS.DEV Buy & Burn:</span>
                    <span>-$0.02</span>
                  </div>
                  <div className="flex justify-between text-emerald-400 font-bold border-t border-slate-800 pt-1">
                    <span>Net Delivered:</span>
                    <span>$99.96</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 4. TAB B: FOMO3D ATTRITION MACHINE */}
      {activeTab === 'fomo3d' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-4">
            <div className="relative overflow-hidden rounded-2xl border border-rose-500/40 bg-gradient-to-b from-[#180d19] via-[#0f0a14] to-[#0a070d] p-6 shadow-2xl text-center">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-rose-500/20 border border-rose-500/40 text-rose-400 text-xs font-mono font-bold mb-3">
                <Flame className="w-3.5 h-3.5 animate-bounce" />
                <span>ROUND #{fomo.roundId} WAR OF ATTRITION</span>
              </div>

              {/* Countdown Clock */}
              <div className="space-y-1 my-4">
                <div className="text-[11px] font-mono uppercase tracking-widest text-slate-400">Time left · last key buyer wins the pot</div>
                <div className="text-[13vw] sm:text-7xl font-black font-mono tracking-tighter leading-none text-transparent bg-clip-text bg-gradient-to-r from-rose-400 via-amber-300 to-rose-400 animate-pulse">
                  {timeLeftStr}
                </div>
              </div>

              {/* Current King */}
              <div className="mt-4 p-4 rounded-xl bg-black/50 border border-rose-500/30 max-w-xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-3 font-mono">
                <div className="text-left space-y-0.5 min-w-0">
                  <div className="text-[10px] text-slate-400 uppercase tracking-wider">Leader · last key buyer</div>
                  <div className="text-base font-bold text-white flex items-center gap-2 font-sans">
                    <Award className="w-4 h-4 text-amber-400" />
                    <span className="truncate">{fomo.currentLeaderXHandle ? `@${fomo.currentLeaderXHandle}` : 'No Leader Yet'}</span>
                    <span className="hidden sm:inline text-xs text-slate-500 font-mono">({fomo.currentLeader.slice(0, 6)}...{fomo.currentLeader.slice(-4)})</span>
                  </div>
                </div>

                <div className="text-left sm:text-right flex sm:block items-baseline justify-between gap-2 border-t sm:border-0 border-rose-500/20 pt-2 sm:pt-0">
                  <div className="text-[10px] text-slate-400 uppercase tracking-wider">Pot</div>
                  <div className="text-lg font-black text-emerald-400 font-mono">
                    ${fomo.jackpotPot.toFixed(2)} USD
                  </div>
                </div>
              </div>

              {/* Buy Keys Action Row */}
              <div className="mt-6 pt-5 border-t border-rose-500/20 max-w-xl mx-auto space-y-4 font-mono">
                <div className="grid grid-cols-4 gap-1.5 sm:gap-2">
                  {[1, 5, 10, 50].map(k => (
                    <button
                      key={k}
                      onClick={() => setKeysToBuy(k)}
                      className={`py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                        keysToBuy === k
                          ? 'bg-rose-500 text-slate-950 font-black shadow-lg shadow-rose-500/30 scale-105'
                          : 'bg-[#1b1422] text-slate-300 hover:bg-[#251b2e]'
                      }`}
                    >
                      {k} {k === 1 ? 'Key' : 'Keys'} <span className="hidden sm:inline">(+{k * 30}s)</span>
                    </button>
                  ))}
                </div>

                <div className="flex flex-col sm:flex-row sm:items-center gap-2 [&>button]:w-full sm:[&>button]:w-auto">
                  <div className="relative flex-1">
                    <span className="absolute left-3 top-2.5 text-slate-500 text-xs font-bold">@</span>
                    <input
                      type="text"
                      value={fomoXHandle}
                      onChange={e => setFomoXHandle(e.target.value)}
                      readOnly={handleLocked}
                      placeholder="your_x_handle"
                      title={handleLocked ? 'Verified via Sign in with X' : 'Sign in with X (header) to verify your handle'}
                      className={`w-full bg-[#120d17] border rounded-xl pl-7 pr-3 py-2 text-xs font-bold text-white placeholder-slate-600 focus:outline-none font-sans ${handleLocked ? 'border-emerald-500/40 text-emerald-300' : 'border-[#2a1b32] focus:border-rose-500'}`}
                    />
                  </div>
                  {myJackpotOwed > 0n && (
                    <button
                      onClick={handleWithdrawJackpotOnChain}
                      disabled={fomoBusy}
                      aria-busy={fomoBusy || undefined}
                      className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-emerald-400 to-cyan-400 hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 font-black text-xs font-display shadow-lg transition-all cursor-pointer shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-200"
                    >
                      Withdraw your held jackpot: {Number(formatEther(myJackpotOwed)).toFixed(4)} xMoney
                    </button>
                  )}
                  {roundExpired ? (
                    <button
                      onClick={handleClaimJackpotOnChain}
                      disabled={fomoBusy}
                      aria-busy={fomoBusy || undefined}
                      className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-amber-400 via-yellow-300 to-amber-400 hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 font-black text-xs font-display shadow-lg shadow-amber-500/30 transition-all cursor-pointer shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-200"
                    >
                      Round over: pay ${fomo.jackpotPot.toFixed(2)} jackpot &amp; start round #{fomo.roundId + 1}
                    </button>
                  ) : fireballAvailable && cohort === 'legacy' ? (
                    <button onClick={() => selectCohort('fireball')} className="px-6 py-2.5 rounded-xl bg-cyan-400 text-slate-950 font-black text-xs font-display cursor-pointer shrink-0">
                      Back to the current game to buy keys
                    </button>
                  ) : (
                    <button
                      onClick={handleBuyKeysOnChain}
                      disabled={fomoBusy}
                      aria-busy={fomoBusy || undefined}
                      className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-rose-500 via-amber-500 to-rose-500 hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 font-black text-xs font-display shadow-lg shadow-rose-500/30 transition-all cursor-pointer shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"
                    >
                      {fomoBusy ? 'Buying…' : `Buy ${keysToBuy} ${keysToBuy === 1 ? 'key' : 'keys'} for ${(keysToBuy * fomo.keyPrice).toFixed(3)} $xMoney`}
                    </button>
                  )}
                </div>

                {fomoError && (
                  <p role="alert" className="text-[11px] font-mono text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2 break-words text-left">{fomoError}</p>
                )}
                <div className="text-[11px] text-slate-400 flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
                  <span>Each key: 55% to key holders · 35% to the pot · 0.04% fee</span>
                </div>
                <div className="flex justify-center">
                  <Disclosure label="Details / contracts">
                    <p className="text-left">Fee split per key: <span className="text-amber-400">0.01% burned</span>, <span className="text-cyan-400">0.01% to the Stacc Wizards fanout</span>, <span className="text-emerald-400">0.02% buys and burns XGAS.DEV</span>. Every key adds +30s to the clock; the last buyer when it hits zero takes the pot.</p>
                    <p className="text-left font-mono">Game contract (L4): <a href="#explorer" onClick={(ev) => { ev.preventDefault(); setActiveTab('explorer'); }} className="text-cyan-400 hover:underline">{activeFomoAddress}</a></p>
                  </Disclosure>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Player Stash & Continuous Dividends */}
          <div className="space-y-4">
            <div className="bg-[#0e121d] border border-[#1e2538] rounded-2xl p-5 shadow-xl space-y-4 font-mono">
              <h3 className="text-base font-bold text-white flex items-center gap-2 font-display">
                <Coins className="w-4 h-4 text-emerald-400" />
                <span>Your Continuous Dividends</span>
              </h3>

              <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 space-y-1">
                <div className="text-[11px] text-emerald-400 uppercase tracking-wider font-bold">ACCUMULATED REWARD</div>
                <div className="text-3xl font-black text-white">
                  ${fomo.playerDividends.toFixed(2)} <span className="text-xs text-slate-400">$xMoney</span>
                </div>
                <div className="text-[11px] text-slate-400 font-sans">From {fomo.playerKeys} keys held in Round #{fomo.roundId}</div>
              </div>

              <button
                onClick={handleClaimDividendsOnChain}
                disabled={fomo.playerDividends <= 0 || fomoBusy}
                aria-busy={fomoBusy || undefined}
                title={fomo.playerDividends <= 0 ? 'Nothing to claim yet' : undefined}
                className="w-full py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 font-black text-xs font-display shadow-lg shadow-emerald-500/20 transition-all cursor-pointer flex items-center justify-center gap-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
              >
                <CheckCircle className="w-4 h-4" aria-hidden="true" />
                <span>{fomoBusy ? 'Working…' : 'Claim dividends'}</span>
              </button>

              {pastRoundDividends.map(pr => (
                <button
                  key={pr.round}
                  onClick={() => handleClaimPastRound(pr.round)}
                  className="w-full py-2 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-200 font-bold text-xs font-display cursor-pointer"
                >
                  Claim {pr.amount.toFixed(4)} $xMoney left from Round #{pr.round}
                </button>
              ))}

              <div className="p-3 rounded-xl bg-[#141a29] border border-[#1e2538] space-y-1 text-xs">
                <div className="flex justify-between text-slate-400">
                  <span>Current Key Price:</span>
                  <span className="text-white">${fomo.keyPrice.toFixed(4)}</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Total Keys Minted:</span>
                  <span className="text-white">{fomo.totalKeys.toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Contract Address:</span>
                  <a 
                    href="#explorer"
                    onClick={(ev) => { ev.preventDefault(); setActiveTab('explorer'); }}
                    className="text-cyan-400 hover:underline flex items-center gap-1"
                  >
                    <span>{activeFomoAddress.slice(0, 8)}... (Orbit L4)</span>
                    <ExternalLink className="w-2.5 h-2.5" />
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 5. TAB C: SPECS & DEEP LINKS */}
      {activeTab === 'specs' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 font-mono text-xs">
          {/* Trust model, units, admin powers: everything an integrator or auditor needs, stated plainly */}
          <div className="lg:col-span-2 bg-[#0e121d] border border-emerald-500/30 rounded-2xl p-5 shadow-xl space-y-4">
            <h3 className="text-base font-bold text-white flex items-center gap-2 font-display">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>Trust Model, Units &amp; Admin Powers</span>
            </h3>
            {/* The short version. Must stay consistent with the detail below: the chain-owner key has UpgradeExecutor with no timelock. */}
            <p className="text-xs leading-relaxed text-slate-300 font-sans border-l-2 border-amber-500/50 pl-3">
              <strong className="text-white">Short version:</strong> chain data and exits are verifiable on Robinhood without trusting xgas.dev. Today you still trust the single xgas.dev sequencer, a 2-of-3 validator Safe that fast-confirms state, and one chain-owner key that can upgrade the Rollup, Bridge, Inbox and Outbox and force-confirm assertions with no timelock. The vault itself sits behind a 24-hour timelock.
            </p>
            <Disclosure label="Full detail: what is verifiable, admin powers, units &amp; accounting" className="pt-1">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-[11px] leading-relaxed text-slate-300">
              <div className="space-y-2">
                <div className="text-emerald-400 font-bold uppercase tracking-wider">What is verifiable</div>
                <p>xgas Orbit L4 (#{CONTRACT_ADDRESSES.ORBIT_L4_CHAIN_ID}) is an Arbitrum Orbit rollup. Every batch of transactions is posted in full to the <a href={`https://robinhoodchain.blockscout.com/address/${CONTRACT_ADDRESSES.ORBIT_SEQUENCER_INBOX}`} target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline">SequencerInbox</a> on Robinhood Chain, and every state assertion goes to the <a href={`https://robinhoodchain.blockscout.com/address/${CONTRACT_ADDRESSES.ORBIT_ROLLUP}`} target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline">Rollup</a> contract there. All of the chain's data lives on Robinhood, so a node configured from <a href="/chain-info.json" className="text-cyan-400 hover:underline">chain-info.json</a> (see <a href="/RUN-A-NODE.md" className="text-cyan-400 hover:underline">RUN-A-NODE.md</a>) can rebuild and verify the chain from Robinhood alone, without trusting xgas.dev.</p>
                <p>Validation is permissionless: the validator whitelist is off on-chain, so anyone can bond 0.01 WETH and post or challenge assertions (<a href="/run-a-validator.md" className="text-cyan-400 hover:underline">run a validator</a>). Deposits go through the canonical Orbit Inbox; exits go through the Outbox on Robinhood. The site executes Outbox claims as a convenience, but the call is permissionless.</p>
                <p className="text-slate-400">What you do trust today: a single sequencer run by xgas.dev (ordering and liveness; it cannot forge state), and the fast confirmer. Assertions are confirmed early by a 2-of-3 <a href={`https://robinhoodchain.blockscout.com/address/${CONTRACT_ADDRESSES.ORBIT_FAST_CONFIRM_SAFE}`} target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline">Safe</a> owned by the three validator keys, so any 2 of them can confirm a state, a wrong one included, without waiting out the challenge period. Without the Safe, an assertion confirms after about 7 days unless someone challenges it.</p>
              </div>
              <div className="space-y-2">
                <div className="text-amber-400 font-bold uppercase tracking-wider">Admin powers</div>
                <p>The L4 escrow, War of Attrition and router are ownerless: no owner, pause, upgrade, role or withdraw path. Source: <a href="/source/XMoneyEscrow.sol" className="text-cyan-400 hover:underline">escrow</a>, <a href="/source/FomoAttritionL4.sol" className="text-cyan-400 hover:underline">game</a>, <a href="/source/XGasRouter.sol" className="text-cyan-400 hover:underline">router</a>.</p>
                <p>The XMoney vault (<a href="/source/XMoney.sol" className="text-cyan-400 hover:underline">source</a>) has exactly two owner functions: setBridgeSystem (inbox/bridge addresses) and setL3RetryableParams (gas for the L4 leg). Minting only happens inside enterRollup / migrate, and the owner cannot pause or withdraw the reserve. Not every mint is backed: each deposit also mints 0.0001 xMoney with no USDG behind it to pay L4 delivery gas, and the owner sets that size through the timelock.</p>
                <p>Vault owner = a 24-hour <a href={`https://robinhoodchain.blockscout.com/address/${CONTRACT_ADDRESSES.XMONEY_TIMELOCK}`} target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline">TimelockController</a>: any change is queued publicly and waits a day before it can execute. The timelock owns only the vault and the XGAS.DEV buyback.</p>
                <p className="text-slate-400">The chain owner key (<a href={`https://robinhoodchain.blockscout.com/address/${CONTRACT_ADDRESSES.ORBIT_OWNER}`} target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline">0xC3D6...B14F</a>) holds the <a href={`https://robinhoodchain.blockscout.com/address/${CONTRACT_ADDRESSES.ORBIT_UPGRADE_EXECUTOR}`} target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline">UpgradeExecutor</a> role with no timelock: it can still upgrade the Rollup, Bridge, Inbox and Outbox on Robinhood, and it can forceConfirm any assertion, bypassing both the validators and the Safe. It is also the chain owner on the L4 itself.</p>
                <p className="text-slate-400">L4 gas fees are not kept by xgas.dev: the chain's network and infra fee accounts point at a ValidatorFeeSplitter on the L4 (<span className="text-white">{CONTRACT_ADDRESSES.VALIDATOR_FEE_SPLITTER_L4.slice(0, 6)}...{CONTRACT_ADDRESSES.VALIDATOR_FEE_SPLITTER_L4.slice(-4)}</span>; same hex as the XMoney vault on Robinhood, by deployer-nonce coincidence), which splits them equally between the validators. The owner key picks that payee set and can repoint the fee accounts.</p>
              </div>
              <div className="space-y-2">
                <div className="text-cyan-400 font-bold uppercase tracking-wider">Units &amp; accounting</div>
                <p><code className="text-white">getReserveNAV()</code> returns <code className="text-white">navRay</code> scaled by 1e18 (a WAD, despite the name), <code className="text-white">usdgReserve</code> in 6 decimals, <code className="text-white">circulatingXMoney</code> in 18 decimals. The name is frozen because the token is the chain's native gas asset and cannot be redeployed.</p>
                <p>Burns are sent to 0x…dEaD and stay inside <code className="text-white">totalSupply()</code>. The canonical supply figure is <code className="text-white">totalSupply − balanceOf(0xdead)</code>, which is what circulatingXMoney reports and what NAV is computed from.</p>
                <p>0x…dEaD on Robinhood is a shared sink used by other projects; only XMoney's own balance there is xgas burn.</p>
              </div>
            </div>
            </Disclosure>
          </div>
          <div className="bg-[#0e121d] border border-[#1e2538] rounded-2xl p-5 shadow-xl space-y-3">
            <h3 className="text-base font-bold text-white flex items-center gap-2 font-display">
              <Layers className="w-4 h-4 text-cyan-400" />
              <span>Chain</span>
            </h3>
            <p className="text-xs text-slate-400 font-sans">An Arbitrum Orbit rollup that settles on Robinhood Chain. Gas is $xMoney, backed by USDG in the vault.</p>
            <Disclosure label="Details / contracts">
            <div className="space-y-2 text-slate-300 font-mono text-xs">
              <div className="p-2.5 rounded-lg bg-[#141a29] border border-[#1e2538] flex justify-between">
                <span className="text-slate-500">Rollup Framework:</span>
                <span className="text-white font-bold">Arbitrum Nitro (Orbit L4)</span>
              </div>
              <div className="p-2.5 rounded-lg bg-[#141a29] border border-[#1e2538] flex justify-between">
                <span className="text-slate-500">Parent Settlement L3:</span>
                <span className="text-emerald-400 font-bold">Robinhood Chain (#4663)</span>
              </div>
              <div className="p-2.5 rounded-lg bg-[#141a29] border border-[#1e2538] flex justify-between">
                <span className="text-slate-500">L4 Gas Token:</span>
                <span className="text-amber-400 font-bold">$xMoney (18 Decimals, 1:1 Backed)</span>
              </div>
              <div className="p-2.5 rounded-lg bg-[#141a29] border border-[#1e2538] flex justify-between">
                <span className="text-slate-500">0.01% Burn Sink:</span>
                <a href="https://robinhoodchain.blockscout.com/address/0x000000000000000000000000000000000000dEaD" target="_blank" rel="noreferrer" className="text-amber-400 hover:underline flex items-center gap-1">
                  <span>0x000...dEaD</span>
                  <ExternalLink className="w-2.5 h-2.5" />
                </a>
              </div>
              <div className="p-2.5 rounded-lg bg-[#141a29] border border-[#1e2538] flex justify-between">
                <span className="text-slate-500">0.01% Protocol Rake:</span>
                <a href="https://robinhoodchain.blockscout.com/address/0x04C9229Fba6AFDC6ac9eD4312acb4BC74f1a436e" target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline flex items-center gap-1">
                  <span>Stacc Wizards Fee Fanout</span>
                  <ExternalLink className="w-2.5 h-2.5" />
                </a>
              </div>
              <div className="p-2.5 rounded-lg bg-[#141a29] border border-[#1e2538] flex justify-between">
                <span className="text-slate-500">0.02% L4 Buy & Burn:</span>
                <a href={`https://robinhoodchain.blockscout.com/token/${CONTRACT_ADDRESSES.XGAS_DEV}`} target="_blank" rel="noreferrer" className="text-emerald-400 hover:underline flex items-center gap-1">
                  <span>XGAS.DEV</span>
                  <ExternalLink className="w-2.5 h-2.5" />
                </a>
              </div>
            </div>
            </Disclosure>
          </div>

          <div className="bg-[#0e121d] border border-[#1e2538] rounded-2xl p-5 shadow-xl space-y-3">
            <h3 className="text-base font-bold text-white flex items-center gap-2 font-display">
              <Hash className="w-4 h-4 text-emerald-400" />
              <span>Contracts</span>
            </h3>
            <p className="text-xs text-slate-400 font-sans">The vault lives on Robinhood Chain; the P2P escrow and the game live on the L4. Source is linked from the trust model above.</p>
            <Disclosure label="Details / contracts">
            <div className="space-y-2 text-slate-300 font-mono text-xs">
              <div className="p-2.5 rounded-lg bg-[#141a29] border border-[#1e2538] space-y-1">
                <div className="flex justify-between text-slate-400">
                  <span>$xMoney Vault Contract:</span>
                  <span className="text-cyan-400 font-bold">1:1 Backing</span>
                </div>
                <a 
                  href={`https://robinhoodchain.blockscout.com/address/${CONTRACT_ADDRESSES.XMONEY_USD_L3}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-white hover:text-cyan-400 flex items-center gap-1 truncate"
                >
                  <span className="truncate">{CONTRACT_ADDRESSES.XMONEY_USD_L3}</span>
                  <ExternalLink className="w-3 h-3 shrink-0" />
                </a>
              </div>

              <div className="p-2.5 rounded-lg bg-[#141a29] border border-[#1e2538] space-y-1">
                <div className="flex justify-between text-slate-400">
                  <span>P2P Escrow Contract:</span>
                  <span className="text-emerald-400 font-bold">Two-Sided Book</span>
                </div>
                <a 
                  href="#explorer"
                  onClick={(ev) => { ev.preventDefault(); setActiveTab('explorer'); }}
                  className="text-white hover:text-emerald-400 flex items-center gap-1 truncate"
                >
                  <span className="truncate">{activeEscrowAddress} · xgas Orbit L4 #{CONTRACT_ADDRESSES.ORBIT_L4_CHAIN_ID}</span>
                  <ExternalLink className="w-3 h-3 shrink-0" />
                </a>
              </div>

              <div className="p-2.5 rounded-lg bg-[#141a29] border border-[#1e2538] space-y-1">
                <div className="flex justify-between text-slate-400">
                  <span>Stacc Wizards Fee Fanout:</span>
                  <span className="text-cyan-400 font-bold">0x04C9...36e</span>
                </div>
                <a 
                  href="https://robinhoodchain.blockscout.com/address/0x04C9229Fba6AFDC6ac9eD4312acb4BC74f1a436e"
                  target="_blank"
                  rel="noreferrer"
                  className="text-white hover:text-cyan-400 flex items-center gap-1 truncate"
                >
                  <span className="truncate">0x04C9229Fba6AFDC6ac9eD4312acb4BC74f1a436e</span>
                  <ExternalLink className="w-3 h-3 shrink-0" />
                </a>
              </div>
            </div>
            </Disclosure>
          </div>
        </div>
      )}

      {/* MODAL: CREATE ON-CHAIN ORDER (SELL ASK OR BUY BID IN $XMONEY) */}
      {isCreateOrderModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-[#0e121d] border border-emerald-500/40 rounded-t-2xl sm:rounded-2xl max-w-md w-full p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl space-y-4 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-[#1f2638]">
              <h3 className="text-base font-bold text-white flex items-center gap-2 font-display">
                <Coins className="w-4 h-4 text-emerald-400" />
                <span>Post {orderSideToCreate === 'ASK' ? 'Sell Ask' : 'Buy Bid'} ($xMoney)</span>
              </h3>
              <button
                onClick={() => { setIsCreateOrderModalOpen(false); setModalError(null); }}
                aria-label="Close"
                className="text-slate-400 hover:text-white text-lg font-bold cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 rounded"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateOrderOnChain} className="space-y-3 text-xs font-mono">
              <div className="space-y-1">
                <label className="text-[11px] text-slate-400 uppercase font-sans">Your X Handle</label>
                <div className="relative">
                  <span className="absolute left-3 top-2.5 text-slate-500 font-bold">@</span>
                  <input
                    type="text"
                    required
                    value={newOrderHandle}
                    onChange={e => setNewOrderHandle(e.target.value)}
                    readOnly={handleLocked}
                    placeholder="my_handle"
                    title={handleLocked ? 'Verified via Sign in with X' : 'Sign in with X (header) to verify your handle'}
                    className={`w-full bg-[#141a29] border rounded-xl pl-7 pr-3 py-2 font-bold focus:outline-none font-sans ${handleLocked ? 'border-emerald-500/40 text-emerald-300' : 'border-[#1e2538] text-white focus:border-emerald-500'}`}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="text-[11px] text-slate-400 uppercase font-sans">
                    {orderSideToCreate === 'ASK' ? 'Amount to Sell ($xMoney)' : 'Amount Wanted ($xMoney)'}
                  </label>
                  <input
                    type="number"
                    step="1"
                    required
                    value={newOrderAmount}
                    onChange={e => setNewOrderAmount(e.target.value)}
                    className="w-full bg-[#141a29] border border-[#1e2538] rounded-xl px-3 py-2 text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] text-slate-400 uppercase font-sans">Price Spread (%)</label>
                  <input
                    type="number"
                    step="0.1"
                    required
                    value={newOrderSpread}
                    onChange={e => setNewOrderSpread(e.target.value)}
                    placeholder="2.0"
                    className="w-full bg-[#141a29] border border-[#1e2538] rounded-xl px-3 py-2 text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="text-[11px] text-slate-400 uppercase font-sans">Min Limit ($)</label>
                  <input
                    type="number"
                    step="1"
                    required
                    value={newOrderMin}
                    onChange={e => setNewOrderMin(e.target.value)}
                    className="w-full bg-[#141a29] border border-[#1e2538] rounded-xl px-3 py-2 text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] text-slate-400 uppercase font-sans">Max Limit ($)</label>
                  <input
                    type="number"
                    step="1"
                    required
                    value={newOrderMax}
                    onChange={e => setNewOrderMax(e.target.value)}
                    className="w-full bg-[#141a29] border border-[#1e2538] rounded-xl px-3 py-2 text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <div className="p-3 rounded-xl bg-black/40 border border-slate-800 text-[11px] text-slate-400 space-y-1">
                <div>Price: <strong className="text-emerald-400">${(1 + parseFloat(newOrderSpread || '0') / 100).toFixed(3)} USD per $xMoney</strong></div>
                <div>0.04% fee on release (0.01% burn · 0.01% fanout · 0.02% XGAS.DEV buy &amp; burn)</div>
              </div>

              {modalError && (
                <p role="alert" className="text-[11px] font-mono text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2 break-words">{modalError}</p>
              )}
              <button
                type="submit"
                disabled={isSubmittingTx}
                aria-busy={isSubmittingTx || undefined}
                className="w-full py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 font-black text-xs font-display shadow-lg shadow-emerald-500/20 transition-all cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
              >
                {isSubmittingTx ? 'Posting…' : orderSideToCreate === 'ASK' ? 'Post sell ask · escrows your $xMoney' : 'Post buy bid'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: FILL ORDER */}
      {selectedOrderForTrade && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-[#0e121d] border border-cyan-500/40 rounded-t-2xl sm:rounded-2xl max-w-md w-full p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl space-y-4 font-mono text-xs max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-[#1f2638]">
              <h3 className="text-base font-bold text-white flex items-center gap-2 font-display">
                <Coins className="w-4 h-4 text-cyan-400" />
                <span>Fill Order #{selectedOrderForTrade.id} with @{selectedOrderForTrade.makerXHandle}</span>
              </h3>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => copyLink(orderLink(selectedOrderForTrade.id, selectedOrderForTrade.cohort))}
                  className="px-2 py-1 rounded-lg bg-[#151c2d] hover:bg-[#1c2438] text-slate-300 hover:text-white text-[11px] cursor-pointer flex items-center gap-1"
                  title={orderLink(selectedOrderForTrade.id, selectedOrderForTrade.cohort)}
                >
                  <Link2 className="w-3.5 h-3.5" />
                  <span>{copiedLink === orderLink(selectedOrderForTrade.id, selectedOrderForTrade.cohort) ? 'Copied' : 'Link'}</span>
                </button>
                <a
                  href={`https://x.com/intent/post?text=${encodeURIComponent(`${selectedOrderForTrade.side === 'ASK' ? 'Buy' : 'Sell'} ${selectedOrderForTrade.availableXMoney.toFixed(2)} $xMoney @ $${(selectedOrderForTrade.fiatRateBps / 10000).toFixed(3)} from @${selectedOrderForTrade.makerXHandle} on @xgas_dev L4 → ${orderLink(selectedOrderForTrade.id, selectedOrderForTrade.cohort)}`)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="p-1.5 rounded-lg bg-blue-500/20 text-blue-400 hover:bg-blue-500/30"
                  title="Share this offer on X"
                >
                  <Share2 className="w-3.5 h-3.5" />
                </a>
                <button
                  onClick={closeOrder}
                  aria-label="Close"
                  className="text-slate-400 hover:text-white text-lg font-bold cursor-pointer px-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 rounded"
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-[11px] text-slate-400 uppercase font-sans">Amount ($xMoney)</label>
                <input
                  type="number"
                  step="1"
                  value={tradeAmount}
                  onChange={e => setTradeAmount(e.target.value)}
                  className="w-full bg-[#141a29] border border-[#1e2538] rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-cyan-500 font-bold"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[11px] text-slate-400 uppercase font-sans">Your X Handle</label>
                <div className="relative">
                  <span className="absolute left-3 top-2.5 text-slate-500 font-bold">@</span>
                  <input
                    type="text"
                    value={takerHandle}
                    onChange={e => setTakerHandle(e.target.value)}
                    readOnly={handleLocked}
                    placeholder="my_handle"
                    title={handleLocked ? 'Verified via Sign in with X' : 'Sign in with X (header) to verify your handle'}
                    className={`w-full bg-[#141a29] border rounded-xl pl-7 pr-3 py-2 font-bold focus:outline-none font-sans ${handleLocked ? 'border-emerald-500/40 text-emerald-300' : 'border-[#1e2538] text-white focus:border-cyan-500'}`}
                  />
                </div>
              </div>

              <div className="p-3 rounded-xl bg-black/40 border border-slate-800 text-[11px] space-y-1.5">
                <div className="flex justify-between text-slate-400">
                  <span>Unit Price:</span>
                  <span className="text-white">${(selectedOrderForTrade.fiatRateBps / 10000).toFixed(3)}</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>{selectedOrderForTrade.side === 'ASK' ? 'You pay in X Money:' : 'You receive in X Money:'}</span>
                  <span className="text-emerald-400 font-black text-sm">
                    ${((parseFloat(tradeAmount || '0') * selectedOrderForTrade.fiatRateBps) / 10000).toFixed(2)} USD
                  </span>
                </div>
              </div>

              {modalError && (
                <p role="alert" className="text-[11px] font-mono text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2 break-words">{modalError}</p>
              )}
              <button
                onClick={handleFillOrderOnChain}
                disabled={isSubmittingTx}
                aria-busy={isSubmittingTx || undefined}
                className="w-full py-2.5 rounded-xl bg-gradient-to-r from-cyan-500 to-emerald-500 hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 font-black text-xs font-display shadow-lg shadow-cyan-500/20 transition-all cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
              >
                {isSubmittingTx ? 'Starting trade…' : selectedOrderForTrade.side === 'ASK' ? 'Start trade · then pay the seller in X Money' : 'Escrow $xMoney · get paid in X Money'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
