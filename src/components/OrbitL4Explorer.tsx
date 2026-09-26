import React, { useState, useEffect, useMemo } from 'react';
import { 
  Search, 
  Layers, 
  Flame, 
  Clock, 
  ArrowRight, 
  CheckCircle, 
  Coins, 
  ExternalLink, 
  Copy, 
  ShieldCheck, 
  TrendingUp, 
  Zap, 
  Award,
  Hash, 
  Database,
  Plus
} from 'lucide-react';
import { CONTRACT_ADDRESSES, l4Addresses } from '../contracts/abis';
import { publicClient, l4PublicClient, loadL4Info, orbitL4RpcUrl } from '../contracts/web3Client';
import { formatEther, parseAbi, decodeEventLog, type Log } from 'viem';

export interface OrbitBlock {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
  txCount: number;
  totalValueXMoney: number;
  totalBurnedXMoney: number;
  sequencer: string;
}

export type OrbitTxType =
  | 'MINT_XMONEY' | 'BURN_XMONEY'
  | 'P2P_ORDER' | 'P2P_TRADE' | 'P2P_ESCROW_SETTLE' | 'P2P_CANCEL'
  | 'FOMO_BUY' | 'FOMO_CLAIM' | 'FOMO_JACKPOT'
  | 'ROUTER_SEND';

export interface OrbitTx {
  hash: string;
  blockNumber: number;
  timestamp: number;
  from: string;
  fromHandle?: string;
  to: string;
  toHandle?: string;
  valueXMoney: number;
  burnedAmount: number; // 0.01% burned to 0xdead
  fanoutRakeAmount: number; // 0.01% to the Stacc Wizards Fee Fanout
  buybackAmount?: number; // 0.02% to the XGAS.DEV buyback sink (L4 fee paths only)
  /** The event does not carry the buyback leg; buybackAmount is derived from the burn or the gross and is shown as est. */
  buybackEstimated?: boolean;
  type: OrbitTxType;
  status: 'CONFIRMED';
  calldata: string;
  /** L3 (Robinhood) tx hashes are viewable on Blockscout; L4 ones live on our sequencer */
  layer: 'L3' | 'L4';
}

const XUSD_VAULT_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function totalXMoneyBurned() view returns (uint256)',
  'function totalUsdgRakedToFanout() view returns (uint256)',
  'function getReserveNAV() view returns (uint256 navRay, uint256 usdgReserve, uint256 circulatingXMoney)',
  'event RollupEntered(address indexed user, address indexed l3Recipient, uint256 usdgIn, uint256 xMoneyBridged, uint256 usdgRaked, uint256 xMoneyBurned, uint256 retryableTicketId)',
  'event RollupExited(address indexed user, uint256 xMoneyBurned, uint256 usdgReturned, uint256 usdgRaked)'
]);

const USDG_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)'
]);

// Every event the three xgas Orbit L4 contracts emit
const L4_EVENTS_ABI = parseAbi([
  'event OrderCreated(uint256 indexed orderId, address indexed maker, string makerXHandle, uint8 side, uint256 xMoneyAmount, uint256 fiatRateBps, uint256 minAmount, uint256 maxAmount)',
  'event OrderCancelled(uint256 indexed orderId, uint256 refundedXMoney)',
  'event TradeInitiated(uint256 indexed tradeId, uint256 indexed orderId, uint8 side, address seller, string sellerXHandle, address buyer, string buyerXHandle, uint256 xMoneyAmount, uint256 expectedCents, uint256 deadline)',
  'event TradeCompleted(uint256 indexed tradeId, uint256 indexed orderId, address indexed buyer, uint256 netXMoneyDelivered, uint256 xMoneyBurned, uint256 xMoneyRake)',
  'event TradeCancelled(uint256 indexed tradeId, uint256 indexed orderId, string reason)',
  'event KeysPurchased(address indexed buyer, string xHandle, uint256 keysBought, uint256 costXMoney, uint256 newDeadline)',
  'event DividendsClaimed(address indexed player, uint256 amountXMoney)',
  'event JackpotAwarded(address indexed winner, string xHandle, uint256 jackpotAmountXMoney, uint256 newRoundId)',
  'event ValueTransferred(address indexed from, address indexed to, uint256 netAmount, uint256 burnAmount, uint256 rakeAmount, string memo)'
]);

const L3_BRIDGE_FROM_BLOCK = 66624961n; // xgas Orbit rollup + XMoney deploy block on Robinhood Chain
const BP = 1 / 10000;

function labelFor(address: string): string {
  const a = address.toLowerCase();
  if (a === l4Addresses.escrow.toLowerCase()) return 'xgas_escrow';
  if (a === l4Addresses.fomo.toLowerCase()) return 'war_of_attrition';
  if (a === l4Addresses.router.toLowerCase()) return 'xgas_router';
  if (a === CONTRACT_ADDRESSES.XMONEY_USD_L3.toLowerCase()) return 'xgas_vault';
  if (a === CONTRACT_ADDRESSES.FEE_FANOUT.toLowerCase()) return 'stacc_fanout';
  if (a === '0x000000000000000000000000000000000000dead') return 'burn';
  return address.slice(0, 6);
}

export const OrbitL4Explorer: React.FC = () => {
  const [blocks, setBlocks] = useState<OrbitBlock[]>([]);
  const [txs, setTxs] = useState<OrbitTx[]>([]);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedTx, setSelectedTx] = useState<OrbitTx | null>(null);
  const [selectedBlock, setSelectedBlock] = useState<OrbitBlock | null>(null);
  const [copiedText, setCopiedText] = useState<string | null>(null);

  // Real On-Chain Metrics for OUR Orbit Chain
  const [realUsdgReserve, setRealUsdgReserve] = useState<number>(0);
  const [realCirculatingSupply, setRealCirculatingSupply] = useState<number>(0);
  const [realTotalBurned, setRealTotalBurned] = useState<number>(0);
  const [realTotalRaked, setRealTotalRaked] = useState<number>(0);
  const [realNav, setRealNav] = useState<number>(1);
  const [l4Head, setL4Head] = useState<number>(0);

  // Fetch strictly OUR ORBIT L4 LEDGER (real blocks + decoded events) and the L3 vault state
  useEffect(() => {
    let isMounted = true;
    const blockTsCache = new Map<string, number>(); // `${layer}:${n}` -> ms

    const tsFor = async (layer: 'L3' | 'L4', n: bigint): Promise<number> => {
      const key = `${layer}:${n}`;
      const hit = blockTsCache.get(key);
      if (hit) return hit;
      const client = layer === 'L4' ? l4PublicClient : publicClient;
      const b = await client.getBlock({ blockNumber: n });
      const ms = Number(b.timestamp) * 1000;
      blockTsCache.set(key, ms);
      return ms;
    };

    const fetchOurOrbitLedger = async () => {
      try {
        await loadL4Info();
        const vaultAddr = CONTRACT_ADDRESSES.XMONEY_USD_L3 as `0x${string}`;
        const usdgAddr = CONTRACT_ADDRESSES.USDG as `0x${string}`;

        // --- L3 vault (reserve backing) ---
        const [navData, burnBig, rakeBig, vaultUsdgBal] = await Promise.all([
          publicClient.readContract({ address: vaultAddr, abi: XUSD_VAULT_ABI, functionName: 'getReserveNAV' }),
          publicClient.readContract({ address: vaultAddr, abi: XUSD_VAULT_ABI, functionName: 'totalXMoneyBurned' }),
          publicClient.readContract({ address: vaultAddr, abi: XUSD_VAULT_ABI, functionName: 'totalUsdgRakedToFanout' }),
          publicClient.readContract({ address: usdgAddr, abi: USDG_ABI, functionName: 'balanceOf', args: [vaultAddr] })
        ]);
        if (!isMounted) return;

        const navFloat = Number(navData[0]) / 1e18;
        setRealNav(navFloat > 0 ? navFloat : 1);
        setRealUsdgReserve(Number(vaultUsdgBal) / 1e6);
        setRealCirculatingSupply(Number(formatEther(navData[2])));
        setRealTotalBurned(Number(formatEther(burnBig)));
        setRealTotalRaked(Number(rakeBig) / 1e6);

        const ourTxs: OrbitTx[] = [];

        // --- L3 bridge events (enter = mint on L4, exit = burn on L4) ---
        try {
          const bridgeLogs = await publicClient.getLogs({
            address: vaultAddr,
            events: [XUSD_VAULT_ABI[4], XUSD_VAULT_ABI[5]],
            fromBlock: L3_BRIDGE_FROM_BLOCK,
            toBlock: 'latest'
          });
          for (const log of bridgeLogs) {
            const ts = await tsFor('L3', log.blockNumber!);
            if (log.eventName === 'RollupEntered') {
              const a = log.args as any;
              ourTxs.push({
                hash: log.transactionHash!, blockNumber: Number(log.blockNumber), timestamp: ts,
                from: a.user, to: a.l3Recipient, toHandle: 'orbit_l4',
                valueXMoney: Number(formatEther(a.xMoneyBridged)), burnedAmount: Number(formatEther(a.xMoneyBurned)), fanoutRakeAmount: Number(a.usdgRaked) / 1e6,
                type: 'MINT_XMONEY', status: 'CONFIRMED', layer: 'L3',
                calldata: `enterRollup(${Number(a.usdgIn) / 1e6} USDG → ${Number(formatEther(a.xMoneyBridged)).toFixed(4)} $xMoney on L4)`
              });
            } else if (log.eventName === 'RollupExited') {
              const a = log.args as any;
              ourTxs.push({
                hash: log.transactionHash!, blockNumber: Number(log.blockNumber), timestamp: ts,
                from: a.user, fromHandle: 'orbit_l4', to: vaultAddr, toHandle: 'xgas_vault',
                valueXMoney: Number(formatEther(a.xMoneyBurned)), burnedAmount: Number(formatEther(a.xMoneyBurned)), fanoutRakeAmount: Number(a.usdgRaked) / 1e6,
                type: 'BURN_XMONEY', status: 'CONFIRMED', layer: 'L3',
                calldata: `exitRollup(${Number(formatEther(a.xMoneyBurned)).toFixed(4)} $xMoney → ${Number(a.usdgReturned) / 1e6} USDG)`
              });
            }
          }
        } catch (e) {
          console.warn('L3 bridge log query warning:', e);
        }

        // --- L4: real head + last blocks ---
        const head = await l4PublicClient.getBlockNumber();
        if (!isMounted) return;
        setL4Head(Number(head));

        const blockNums: bigint[] = [];
        for (let i = 0n; i < 8n && head - i >= 0n; i++) blockNums.push(head - i);
        const rawBlocks = await Promise.all(blockNums.map(n => l4PublicClient.getBlock({ blockNumber: n, includeTransactions: true })));
        const ourBlocks: OrbitBlock[] = rawBlocks.map(b => {
          const full = (b.transactions as any[]).filter(t => typeof t === 'object');
          const value = full.reduce((acc, t) => acc + Number(formatEther(BigInt(t.value ?? 0))), 0);
          blockTsCache.set(`L4:${b.number}`, Number(b.timestamp) * 1000);
          return {
            number: Number(b.number),
            hash: b.hash!,
            parentHash: b.parentHash,
            timestamp: Number(b.timestamp) * 1000,
            txCount: b.transactions.length,
            totalValueXMoney: value,
            totalBurnedXMoney: value * BP,
            sequencer: b.miner
          };
        });

        // --- L4: every event from our three contracts since genesis ---
        const addrs = [l4Addresses.escrow, l4Addresses.fomo, l4Addresses.router] as `0x${string}`[];
        let l4Logs: Log[] = [];
        try {
          l4Logs = await l4PublicClient.getLogs({ address: addrs, fromBlock: 0n, toBlock: 'latest' });
        } catch (e) {
          console.warn('L4 log query warning:', e);
        }
        for (const log of l4Logs) {
          let decoded: any;
          try {
            decoded = decodeEventLog({ abi: L4_EVENTS_ABI, data: log.data, topics: log.topics });
          } catch {
            continue;
          }
          const ts = await tsFor('L4', log.blockNumber!);
          const base = { hash: log.transactionHash!, blockNumber: Number(log.blockNumber), timestamp: ts, status: 'CONFIRMED' as const, layer: 'L4' as const, to: log.address, toHandle: labelFor(log.address) };
          const a = decoded.args;
          switch (decoded.eventName) {
            case 'OrderCreated':
              ourTxs.push({ ...base, from: a.maker, fromHandle: a.makerXHandle, valueXMoney: Number(formatEther(a.xMoneyAmount)), burnedAmount: 0, fanoutRakeAmount: 0, type: 'P2P_ORDER',
                calldata: `${a.side === 0 ? 'createSellAsk' : 'createBuyBid'}(#${a.orderId}, ${Number(formatEther(a.xMoneyAmount))} $xMoney @ ${Number(a.fiatRateBps) / 100}¢)` });
              break;
            case 'OrderCancelled':
              ourTxs.push({ ...base, from: log.address, fromHandle: 'xgas_escrow', valueXMoney: Number(formatEther(a.refundedXMoney)), burnedAmount: 0, fanoutRakeAmount: 0, type: 'P2P_CANCEL', calldata: `cancelOrder(#${a.orderId})` });
              break;
            case 'TradeInitiated':
              ourTxs.push({ ...base, from: a.buyer, fromHandle: a.buyerXHandle, valueXMoney: Number(formatEther(a.xMoneyAmount)), burnedAmount: 0, fanoutRakeAmount: 0, type: 'P2P_TRADE',
                calldata: `${a.side === 0 ? 'fillSellAsk' : 'fillBuyBid'}(#${a.tradeId}, ${Number(formatEther(a.xMoneyAmount))} $xMoney, expects $${(Number(a.expectedCents) / 100).toFixed(2)} on X Money)` });
              break;
            // TradeCompleted and ValueTransferred carry burn + rake only; the 2 bp buyback is twice the 1 bp burn.
            case 'TradeCompleted':
              ourTxs.push({ ...base, from: log.address, fromHandle: 'xgas_escrow', to: a.buyer, toHandle: a.buyer.slice(0, 6), valueXMoney: Number(formatEther(a.netXMoneyDelivered)), burnedAmount: Number(formatEther(a.xMoneyBurned)), fanoutRakeAmount: Number(formatEther(a.xMoneyRake)), buybackAmount: Number(formatEther(a.xMoneyBurned)) * 2, buybackEstimated: true, type: 'P2P_ESCROW_SETTLE', calldata: `releaseTrade(#${a.tradeId})` });
              break;
            case 'TradeCancelled':
              ourTxs.push({ ...base, from: log.address, fromHandle: 'xgas_escrow', valueXMoney: 0, burnedAmount: 0, fanoutRakeAmount: 0, type: 'P2P_CANCEL', calldata: `cancelTradeTimeout(#${a.tradeId}) ${a.reason}` });
              break;
            case 'KeysPurchased': {
              const cost = Number(formatEther(a.costXMoney));
              ourTxs.push({ ...base, from: a.buyer, fromHandle: a.xHandle, valueXMoney: cost, burnedAmount: cost * BP, fanoutRakeAmount: cost * BP, buybackAmount: cost * 2 * BP, buybackEstimated: true, type: 'FOMO_BUY', calldata: `buyKeys("${a.xHandle}", ${a.keysBought})` });
              break;
            }
            case 'DividendsClaimed': {
              const v = Number(formatEther(a.amountXMoney));
              ourTxs.push({ ...base, from: log.address, fromHandle: 'war_of_attrition', to: a.player, toHandle: a.player.slice(0, 6), valueXMoney: v, burnedAmount: v * BP, fanoutRakeAmount: v * BP, buybackAmount: v * 2 * BP, buybackEstimated: true, type: 'FOMO_CLAIM', calldata: 'claimDividends()' });
              break;
            }
            case 'JackpotAwarded': {
              const v = Number(formatEther(a.jackpotAmountXMoney));
              ourTxs.push({ ...base, from: log.address, fromHandle: 'war_of_attrition', to: a.winner, toHandle: a.xHandle, valueXMoney: v, burnedAmount: v * BP, fanoutRakeAmount: v * BP, buybackAmount: v * 2 * BP, buybackEstimated: true, type: 'FOMO_JACKPOT', calldata: `claimJackpot() → round #${a.newRoundId}` });
              break;
            }
            case 'ValueTransferred':
              ourTxs.push({ ...base, from: a.from, to: a.to, toHandle: labelFor(a.to), valueXMoney: Number(formatEther(a.netAmount)), burnedAmount: Number(formatEther(a.burnAmount)), fanoutRakeAmount: Number(formatEther(a.rakeAmount)), buybackAmount: Number(formatEther(a.burnAmount)) * 2, buybackEstimated: true, type: 'ROUTER_SEND', calldata: `sendValue("${a.memo}")` });
              break;
          }
        }

        ourTxs.sort((x, y) => y.timestamp - x.timestamp || y.blockNumber - x.blockNumber);
        if (!isMounted) return;
        setTxs(ourTxs.slice(0, 60));
        setBlocks(ourBlocks);
      } catch (err) {
        console.warn('Orbit ledger query warning:', err);
      }
    };

    fetchOurOrbitLedger();
    const interval = setInterval(fetchOurOrbitLedger, 5000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(text);
    setTimeout(() => setCopiedText(null), 2000);
  };

  const filteredTxs = useMemo(() => {
    if (!searchQuery.trim()) return txs;
    const q = searchQuery.toLowerCase().trim();
    return txs.filter(tx => 
      tx.hash.toLowerCase().includes(q) ||
      tx.from.toLowerCase().includes(q) ||
      tx.to.toLowerCase().includes(q) ||
      (tx.fromHandle && tx.fromHandle.toLowerCase().includes(q)) ||
      tx.blockNumber.toString().includes(q)
    );
  }, [txs, searchQuery]);

  return (
    <div className="space-y-5 font-sans">
      
      {/* 1. TOP HEADER: STRICTLY OUR XMONEY ORBIT L4 STATS */}
      <div className="bg-[#0b0e17] border border-cyan-500/30 rounded-2xl p-5 shadow-2xl space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[#172033] pb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-ping" />
              <h2 className="text-xl sm:text-2xl font-black text-white font-display flex items-center gap-2">
                <span>xgas Orbit L4 Rollup Explorer</span>
                <span className="px-2 py-0.5 rounded text-xs font-mono font-bold bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">
                  OUR ORBIT LEDGER
                </span>
              </h2>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Arbitrum Orbit (Nitro, AnyTrust) chain #{CONTRACT_ADDRESSES.ORBIT_L4_CHAIN_ID} settling on Robinhood Chain. Native gas: <strong className="text-white">$xMoney</strong>, 100% USDG-backed. Rollup <a href={`https://robinhoodchain.blockscout.com/address/${CONTRACT_ADDRESSES.ORBIT_ROLLUP}`} target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline">{CONTRACT_ADDRESSES.ORBIT_ROLLUP.slice(0, 10)}…</a> · Inbox <a href={`https://robinhoodchain.blockscout.com/address/${CONTRACT_ADDRESSES.ORBIT_INBOX}`} target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline">{CONTRACT_ADDRESSES.ORBIT_INBOX.slice(0, 10)}…</a> · RPC <a href={CONTRACT_ADDRESSES.ORBIT_L4_RPC} target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline">{CONTRACT_ADDRESSES.ORBIT_L4_RPC.replace('https://', '')}</a>
            </p>
          </div>

          <div className="flex items-center gap-2 font-mono text-xs">
            <div className="px-3 py-1.5 rounded-xl bg-[#131929] border border-[#1f2940] text-slate-300">
              Sequencer: <strong className="text-emerald-400 font-bold">@staccoverflow</strong> · L4 head <strong className="text-cyan-400">#{l4Head}</strong> · chain #{CONTRACT_ADDRESSES.ORBIT_L4_CHAIN_ID}
            </div>
          </div>
        </div>

        {/* Real Metrics Bar: Our Reserve & Supply */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 sm:gap-3 font-mono">
          <div className="p-3 rounded-xl bg-[#111728] border border-emerald-500/30">
            <div className="text-[10px] text-emerald-400 uppercase flex items-center gap-1 font-bold">
              <ShieldCheck className="w-3 h-3" />
              <span>Vault USDG Reserve</span>
            </div>
            <div className="text-lg font-black text-white mt-0.5">${realUsdgReserve.toFixed(2)}</div>
            <div className="text-[10px] text-emerald-500">100% Full (Never Burned)</div>
          </div>

          <div className="p-3 rounded-xl bg-[#111728] border border-[#1a233a]">
            <div className="text-[10px] text-cyan-400 uppercase flex items-center gap-1 font-bold">
              <Coins className="w-3 h-3" />
              <span>Circulating $xMoney</span>
            </div>
            <div className="text-lg font-black text-white mt-0.5">${realCirculatingSupply.toFixed(2)}</div>
            <div className="text-[10px] text-slate-500">Backing Supply</div>
          </div>

          <div className="p-3 rounded-xl bg-[#111728] border border-amber-500/30">
            <div className="text-[10px] text-amber-400 uppercase flex items-center gap-1 font-bold">
              <Flame className="w-3 h-3" />
              <span>Supply Burned (0xdead)</span>
            </div>
            <div className="text-lg font-black text-amber-300 mt-0.5">{realTotalBurned.toFixed(4)}</div>
            <div className="text-[10px] text-amber-500">0.01% on every mint/burn</div>
          </div>

          <div className="p-3 rounded-xl bg-[#111728] border border-cyan-500/30">
            <div className="text-[10px] text-cyan-400 uppercase flex items-center gap-1 font-bold">
              <Award className="w-3 h-3" />
              <span>Stacc Wizards Fee Fanout Rake</span>
            </div>
            <div className="text-lg font-black text-cyan-300 mt-0.5">${realTotalRaked.toFixed(4)}</div>
            <div className="text-[10px] text-cyan-500">0.01% USDG to Fanout</div>
          </div>

          <div className="p-3 rounded-xl bg-[#111728] border border-emerald-500/30">
            <div className="text-[10px] text-emerald-400 uppercase flex items-center gap-1 font-bold">
              <TrendingUp className="w-3 h-3" />
              <span>Reserve NAV</span>
            </div>
            <div className="text-lg font-black text-emerald-400 mt-0.5">${realNav.toFixed(6)}</div>
            <div className="text-[10px] text-emerald-500 font-bold">&gt; $1.00 USDG</div>
          </div>
        </div>

        {/* Search Bar */}
        <div className="relative">
          <Search className="w-4 h-4 text-slate-500 absolute left-4 top-3.5" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search Orbit Tx Hash (0x...), Block Number, or X Handle (@staccoverflow)..."
            className="w-full bg-[#121829] border border-[#202b45] rounded-xl pl-11 pr-4 py-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 font-mono transition-colors"
          />
        </div>
      </div>

      {/* 2. DUAL COLUMN: OUR ORBIT BLOCKS & OUR ORBIT TXS */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        
        {/* Left: Our Orbit Blocks */}
        <div className="lg:col-span-5 bg-[#0b0e17] border border-[#1b2338] rounded-2xl p-4 shadow-xl space-y-3">
          <div className="flex items-center justify-between border-b border-[#172033] pb-2.5">
            <h3 className="text-sm font-bold text-white font-display flex items-center gap-2">
              <Layers className="w-4 h-4 text-cyan-400" />
              <span>xgas Orbit Blocks</span>
            </h3>
            <span className="text-[11px] font-mono text-slate-500">Nitro Sequencer</span>
          </div>

          <div className="divide-y divide-[#151c2d] font-mono text-xs">
            {blocks.map(block => (
              <div 
                key={block.number} 
                onClick={() => setSelectedBlock(block)}
                className="py-3 px-2 -mx-2 hover:bg-[#121828] rounded-xl transition-colors cursor-pointer flex items-center justify-between"
              >
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-cyan-400 hover:underline">Block #{block.number}</span>
                    <span className="text-[10px] text-slate-500">
                      {Math.max(0, Math.round((Date.now() - block.timestamp) / 1000))}s ago
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-400 truncate max-w-[200px]">
                    Hash: <span className="text-slate-300">{block.hash.slice(0, 10)}...{block.hash.slice(-6)}</span>
                  </div>
                </div>

                <div className="text-right space-y-0.5">
                  <div className="text-xs font-bold text-white">{block.txCount} tx</div>
                  <div className="text-[10px] text-amber-400 flex items-center gap-1 justify-end">
                    <Flame className="w-2.5 h-2.5" />
                    <span>-{block.totalBurnedXMoney.toFixed(4)} $xMoney</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right: Our Orbit Transactions */}
        <div className="lg:col-span-7 bg-[#0b0e17] border border-[#1b2338] rounded-2xl p-4 shadow-xl space-y-3">
          <div className="flex items-center justify-between border-b border-[#172033] pb-2.5">
            <h3 className="text-sm font-bold text-white font-display flex items-center gap-2">
              <Zap className="w-4 h-4 text-emerald-400" />
              <span>xgas Orbit Transactions</span>
            </h3>
            <span className="text-[11px] font-mono text-slate-500">{filteredTxs.length} confirmed</span>
          </div>

          <div className="divide-y divide-[#151c2d] font-mono text-xs">
            {filteredTxs.map((tx, idx) => (
              <div 
                key={idx} 
                onClick={() => setSelectedTx(tx)}
                className="py-3 px-2 -mx-2 hover:bg-[#121828] rounded-xl transition-colors cursor-pointer flex items-center justify-between gap-2"
              >
                <div className="space-y-0.5 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-cyan-400 truncate max-w-[140px]">
                      {tx.hash.slice(0, 10)}...{tx.hash.slice(-6)}
                    </span>
                    <span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                      {tx.type}
                    </span>
                    <span className="text-[10px] text-slate-500">
                      {Math.max(0, Math.round((Date.now() - tx.timestamp) / 1000))}s ago
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5 text-[11px] text-slate-400 truncate">
                    <span>@{tx.fromHandle || tx.from.slice(0, 6)}</span>
                    <ArrowRight className="w-2.5 h-2.5 text-slate-600 shrink-0" />
                    <span>@{tx.toHandle || tx.to.slice(0, 6)}</span>
                  </div>
                </div>

                <div className="text-right shrink-0">
                  <div className="text-xs font-bold text-white">
                    ${tx.valueXMoney.toFixed(2)} $xMoney
                  </div>
                  <div className="text-[10px] text-amber-400 flex items-center gap-1 justify-end font-bold">
                    <Flame className="w-2.5 h-2.5" />
                    <span>-${tx.burnedAmount.toFixed(4)} burn</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 3. TRANSACTION DETAILS MODAL */}
      {selectedTx && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-[#0b0e17] border border-cyan-500/40 rounded-t-2xl sm:rounded-2xl max-w-xl w-full p-5 sm:p-6 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl space-y-4 font-mono text-xs max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-[#1b2338]">
              <div className="flex items-center gap-2">
                <Zap className="w-4 h-4 text-cyan-400" />
                <h3 className="text-base font-bold text-white font-display">Orbit Transaction Overview</h3>
              </div>
              <button 
                onClick={() => setSelectedTx(null)}
                className="text-slate-400 hover:text-white text-lg font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="space-y-2.5 text-slate-300">
              <div className="p-2.5 rounded-lg bg-[#111728] border border-[#1a233a] flex justify-between items-center">
                <span className="text-slate-500">Tx Hash:</span>
                <div className="flex items-center gap-2">
                  <span className="text-white font-bold truncate max-w-[240px]">{selectedTx.hash}</span>
                  <button onClick={() => copyToClipboard(selectedTx.hash)} className="text-slate-400 hover:text-white">
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <div className="p-2.5 rounded-lg bg-[#111728] border border-[#1a233a] flex justify-between">
                <span className="text-slate-500">Orbit Block Height:</span>
                <span className="text-cyan-400 font-bold">#{selectedTx.blockNumber}</span>
              </div>

              <div className="p-2.5 rounded-lg bg-[#111728] border border-[#1a233a] flex justify-between">
                <span className="text-slate-500">From:</span>
                <span className="text-white">@{selectedTx.fromHandle} ({selectedTx.from.slice(0, 8)}...)</span>
              </div>

              <div className="p-2.5 rounded-lg bg-[#111728] border border-[#1a233a] flex justify-between">
                <span className="text-slate-500">To:</span>
                <span className="text-white">{selectedTx.to}</span>
              </div>

              <div className="p-2.5 rounded-lg bg-[#111728] border border-[#1a233a] flex justify-between">
                <span className="text-slate-500">Value:</span>
                <span className="text-emerald-400 font-bold text-sm">${selectedTx.valueXMoney.toFixed(2)} $xMoney</span>
              </div>

              {/* Fee Highlight (L4 txs add the XGAS.DEV buyback) */}
              <div className="grid grid-cols-2 gap-2">
                <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/40 space-y-1">
                  <div className="flex items-center gap-1.5 text-amber-400 font-bold text-[11px]">
                    <Flame className="w-3.5 h-3.5" />
                    <span>0.01% Burn (0xdead)</span>
                  </div>
                  <div className="text-sm font-black text-amber-300">-${selectedTx.burnedAmount.toFixed(4)} $xMoney</div>
                </div>

                <div className="p-3 rounded-xl bg-cyan-500/10 border border-cyan-500/40 space-y-1">
                  <div className="flex items-center gap-1.5 text-cyan-400 font-bold text-[11px]">
                    <Award className="w-3.5 h-3.5" />
                    <span>0.01% Stacc Wizards Fee Fanout Rake</span>
                  </div>
                  <div className="text-sm font-black text-cyan-300">+${selectedTx.fanoutRakeAmount.toFixed(4)} {selectedTx.layer === 'L3' ? 'USDG' : '$xMoney'}</div>
                </div>

                {selectedTx.layer === 'L4' && (
                  <div className="col-span-2 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/40 space-y-1">
                    <div className="flex items-center gap-1.5 text-emerald-400 font-bold text-[11px]">
                      <Flame className="w-3.5 h-3.5" />
                      <span>0.02% XGAS.DEV Buy & Burn</span>
                    </div>
                    <div className="text-sm font-black text-emerald-300">{selectedTx.buybackEstimated && <span className="text-[10px] font-mono font-normal text-emerald-400/70 mr-1" title="Derived from the event's burn or gross amount; the event does not carry the buyback leg">est.</span>}+${(selectedTx.buybackAmount ?? 0).toFixed(4)} $xMoney</div>
                  </div>
                )}
              </div>

              <div className="p-2.5 rounded-lg bg-[#111728] border border-[#1a233a] space-y-1">
                <span className="text-slate-500">Action Call:</span>
                <div className="text-white font-mono">{selectedTx.calldata}</div>
              </div>

              <a
                href={selectedTx.layer === 'L3' ? `https://robinhoodchain.blockscout.com/tx/${selectedTx.hash}` : orbitL4RpcUrl()}
                target="_blank"
                rel="noreferrer"
                className="w-full py-2.5 rounded-xl bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/40 text-cyan-400 font-bold text-xs flex items-center justify-center gap-2 transition-colors"
              >
                <span>View On-Chain L3 Proof on RobinhoodScan</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>

            <div className="pt-2">
              <button
                onClick={() => setSelectedTx(null)}
                className="w-full py-2 rounded-xl bg-[#1b2338] hover:bg-[#25314d] text-white font-bold cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 4. BLOCK DETAILS MODAL */}
      {selectedBlock && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-[#0b0e17] border border-cyan-500/40 rounded-t-2xl sm:rounded-2xl max-w-xl w-full p-5 sm:p-6 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl space-y-4 font-mono text-xs max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-[#1b2338]">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-cyan-400" />
                <h3 className="text-base font-bold text-white font-display">Orbit Block #{selectedBlock.number}</h3>
              </div>
              <button 
                onClick={() => setSelectedBlock(null)}
                className="text-slate-400 hover:text-white text-lg font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="space-y-2.5 text-slate-300">
              <div className="p-2.5 rounded-lg bg-[#111728] border border-[#1a233a] flex justify-between">
                <span className="text-slate-500">Block Hash:</span>
                <span className="text-white truncate max-w-[260px]">{selectedBlock.hash}</span>
              </div>
              <div className="p-2.5 rounded-lg bg-[#111728] border border-[#1a233a] flex justify-between">
                <span className="text-slate-500">Parent Hash:</span>
                <span className="text-slate-400 truncate max-w-[260px]">{selectedBlock.parentHash}</span>
              </div>
              <div className="p-2.5 rounded-lg bg-[#111728] border border-[#1a233a] flex justify-between">
                <span className="text-slate-500">Transactions in Block:</span>
                <span className="text-white font-bold">{selectedBlock.txCount} tx</span>
              </div>
              <div className="p-2.5 rounded-lg bg-[#111728] border border-[#1a233a] flex justify-between">
                <span className="text-slate-500">Total Value:</span>
                <span className="text-emerald-400 font-bold">${selectedBlock.totalValueXMoney.toFixed(2)} $xMoney</span>
              </div>
              <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 flex justify-between text-amber-300 font-bold">
                <span>Total 0.01% Burned to Dead:</span>
                <span>-${selectedBlock.totalBurnedXMoney.toFixed(4)}</span>
              </div>
              <div className="p-2.5 rounded-lg bg-[#111728] border border-[#1a233a] flex justify-between">
                <span className="text-slate-500">Nitro Sequencer:</span>
                <span className="text-emerald-400 truncate max-w-[260px]">{selectedBlock.sequencer}</span>
              </div>
            </div>

            <div className="pt-2">
              <button
                onClick={() => setSelectedBlock(null)}
                className="w-full py-2 rounded-xl bg-[#1b2338] hover:bg-[#25314d] text-white font-bold cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
