import React, { useState, useEffect, useCallback } from 'react';
import { formatEther, parseEther } from 'viem';
import { NGU_TOKEN_ABI, NGU_LAUNCHER_ABI } from '../contracts/nguAbis';
import { l4Addresses } from '../contracts/abis';
import { l4PublicClient, sendOnChainTx, encodeAbiCall, loadL4Info, L4_CHAIN_ID } from '../contracts/web3Client';
import { UserWallet } from '../types';
import { Rocket, TrendingUp, TrendingDown, Plus, RefreshCw, AlertTriangle, Wallet, Info } from 'lucide-react';

interface NguTokenState {
  address: string;
  name: string;
  symbol: string;
  floor: bigint;
  nextPrice: bigint;
  lastPrice: bigint;
  supply: bigint;
  minted: bigint;
  maxSupply: bigint;
  reserve: bigint;
  maxLossBps: bigint;
  betaBps: number;
  stepBps: number;
  balance: bigint;
}

const ZERO = '0x0000000000000000000000000000000000000000';
const addr = (a: string) => a as `0x${string}`;

function fmtX(wei: bigint, digits = 4): string {
  const n = Number(formatEther(wei));
  return n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: Math.min(digits, 2) });
}

async function readToken(tokenAddr: string, walletAddr: string): Promise<NguTokenState> {
  const a = addr(tokenAddr);
  const [
    name, symbol, floor, nextPrice, lastPrice, supply, minted, maxSupply,
    reserve, maxLossBps, betaBps, stepBps, balance,
  ] = await Promise.all([
    l4PublicClient.readContract({ address: a, abi: NGU_TOKEN_ABI, functionName: 'name' }),
    l4PublicClient.readContract({ address: a, abi: NGU_TOKEN_ABI, functionName: 'symbol' }),
    l4PublicClient.readContract({ address: a, abi: NGU_TOKEN_ABI, functionName: 'floor' }),
    l4PublicClient.readContract({ address: a, abi: NGU_TOKEN_ABI, functionName: 'nextPrice' }),
    l4PublicClient.readContract({ address: a, abi: NGU_TOKEN_ABI, functionName: 'lastPrice' }),
    l4PublicClient.readContract({ address: a, abi: NGU_TOKEN_ABI, functionName: 'supply' }),
    l4PublicClient.readContract({ address: a, abi: NGU_TOKEN_ABI, functionName: 'minted' }),
    l4PublicClient.readContract({ address: a, abi: NGU_TOKEN_ABI, functionName: 'maxSupply' }),
    l4PublicClient.readContract({ address: a, abi: NGU_TOKEN_ABI, functionName: 'reserve' }),
    l4PublicClient.readContract({ address: a, abi: NGU_TOKEN_ABI, functionName: 'maxLossBps' }),
    l4PublicClient.readContract({ address: a, abi: NGU_TOKEN_ABI, functionName: 'betaBps' }),
    l4PublicClient.readContract({ address: a, abi: NGU_TOKEN_ABI, functionName: 'stepBps' }),
    walletAddr
      ? l4PublicClient.readContract({ address: a, abi: NGU_TOKEN_ABI, functionName: 'balanceOf', args: [addr(walletAddr)] })
      : Promise.resolve(0n),
  ]);
  return {
    address: tokenAddr, name, symbol, floor, nextPrice, lastPrice, supply, minted,
    maxSupply, reserve, maxLossBps, betaBps: Number(betaBps), stepBps: Number(stepBps), balance,
  };
}

function TokenCard({ token, wallet, onTrade }: { token: NguTokenState; wallet: UserWallet; onTrade: () => void }) {
  const [buyQty, setBuyQty] = useState('1');
  const [sellQty, setSellQty] = useState('1');
  const [buyQuote, setBuyQuote] = useState<bigint | null>(null);
  const [sellQuote, setSellQuote] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refreshQuotes = useCallback(async () => {
    try {
      const bq = Number(buyQty) > 0 ? await l4PublicClient.readContract({
        address: addr(token.address), abi: NGU_TOKEN_ABI, functionName: 'quoteBuy', args: [BigInt(Math.floor(Number(buyQty)))],
      }) : null;
      setBuyQuote(bq);
    } catch { setBuyQuote(null); }
    try {
      const sq = Number(sellQty) > 0 ? await l4PublicClient.readContract({
        address: addr(token.address), abi: NGU_TOKEN_ABI, functionName: 'quoteSell', args: [BigInt(Math.floor(Number(sellQty)))],
      }) : null;
      setSellQuote(sq);
    } catch { setSellQuote(null); }
  }, [token.address, buyQty, sellQty]);

  useEffect(() => { refreshQuotes(); }, [refreshQuotes]);

  const doBuy = async () => {
    if (!wallet.connected || busy) return;
    setBusy(true); setErr(null);
    try {
      const qty = BigInt(Math.floor(Number(buyQty)));
      if (qty <= 0n || qty > 50n) throw new Error('Quantity must be 1–50 whole tokens.');
      const cost: bigint = await l4PublicClient.readContract({
        address: addr(token.address), abi: NGU_TOKEN_ABI, functionName: 'quoteBuy', args: [qty],
      });
      const enc = encodeAbiCall(NGU_TOKEN_ABI, 'buy', [qty, addr(wallet.address)], token.address, formatEther(cost), L4_CHAIN_ID);
      await sendOnChainTx({ to: token.address, data: enc.calldata, valueWei: BigInt(enc.valueWei), waitForConfirmation: true });
      onTrade();
    } catch (e: any) {
      setErr(e?.message || 'Buy failed');
    } finally { setBusy(false); }
  };

  const doSell = async () => {
    if (!wallet.connected || busy) return;
    setBusy(true); setErr(null);
    try {
      const qty = BigInt(Math.floor(Number(sellQty)));
      if (qty <= 0n || qty > 50n) throw new Error('Quantity must be 1–50 whole tokens.');
      const payout: bigint = await l4PublicClient.readContract({
        address: addr(token.address), abi: NGU_TOKEN_ABI, functionName: 'quoteSell', args: [qty],
      });
      const minOut = (payout * 9950n) / 10000n; // 0.5% slippage tolerance
      const enc = encodeAbiCall(NGU_TOKEN_ABI, 'sell', [qty, addr(wallet.address), minOut], token.address, '0', L4_CHAIN_ID);
      await sendOnChainTx({ to: token.address, data: enc.calldata, waitForConfirmation: true });
      onTrade();
    } catch (e: any) {
      setErr(e?.message || 'Sell failed');
    } finally { setBusy(false); }
  };

  const maxLossPct = (Number(token.maxLossBps) / 100).toFixed(2);
  const soldOut = token.minted >= token.maxSupply;
  const progress = token.maxSupply > 0n ? Number((token.minted * 10000n) / token.maxSupply) / 100 : 0;

  return (
    <div className="rounded-2xl bg-[#0b0e17] border border-[#1e2538] p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between">
        <div>
          <div className="font-black text-white text-lg leading-tight">{token.name}</div>
          <div className="text-xs font-mono text-slate-400">${token.symbol} · <span className="text-slate-500">{token.address.slice(0, 6)}…{token.address.slice(-4)}</span></div>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-mono text-slate-500 uppercase">max instant loss</div>
          <div className="text-sm font-black font-mono text-amber-400">{maxLossPct}%</div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-xl bg-[#121624] border border-[#1e2538] px-2 py-2">
          <div className="text-[10px] font-mono text-slate-500 uppercase">floor</div>
          <div className="font-mono font-bold text-emerald-400 text-sm">{fmtX(token.floor)}</div>
        </div>
        <div className="rounded-xl bg-[#121624] border border-[#1e2538] px-2 py-2">
          <div className="text-[10px] font-mono text-slate-500 uppercase">next price</div>
          <div className="font-mono font-bold text-white text-sm">{fmtX(token.nextPrice)}</div>
        </div>
        <div className="rounded-xl bg-[#121624] border border-[#1e2538] px-2 py-2">
          <div className="text-[10px] font-mono text-slate-500 uppercase">you hold</div>
          <div className="font-mono font-bold text-cyan-300 text-sm">{fmtX(token.balance, 2)}</div>
        </div>
      </div>

      <div>
        <div className="flex justify-between text-[10px] font-mono text-slate-500 mb-1">
          <span>minted {token.minted.toString()} / {token.maxSupply.toString()}</span>
          <span>{progress.toFixed(1)}%</span>
        </div>
        <div className="h-1.5 rounded-full bg-[#1a2033] overflow-hidden">
          <div className="h-full bg-gradient-to-r from-emerald-500 to-teal-400" style={{ width: `${Math.min(100, progress)}%` }} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-[#121624] border border-[#1e2538] p-2.5">
          <div className="text-[10px] font-mono text-slate-500 uppercase mb-1.5 flex items-center gap-1"><TrendingUp className="w-3 h-3 text-emerald-400" /> buy</div>
          <div className="flex gap-1.5">
            <input value={buyQty} onChange={e => setBuyQty(e.target.value)} inputMode="numeric"
              className="w-full min-w-0 bg-[#0b0e17] border border-[#1e2538] rounded-lg px-2 py-1.5 text-sm font-mono text-white outline-none focus:border-emerald-500/60" />
            <button onClick={doBuy} disabled={busy || soldOut || !wallet.connected}
              className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 text-xs font-black cursor-pointer whitespace-nowrap">
              {busy ? '…' : soldOut ? 'sold out' : 'Buy'}
            </button>
          </div>
          <div className="text-[11px] font-mono text-slate-400 mt-1.5">
            {buyQuote != null ? <>cost <span className="text-white">{fmtX(buyQuote)} $xMoney</span></> : '—'}
          </div>
        </div>
        <div className="rounded-xl bg-[#121624] border border-[#1e2538] p-2.5">
          <div className="text-[10px] font-mono text-slate-500 uppercase mb-1.5 flex items-center gap-1"><TrendingDown className="w-3 h-3 text-rose-400" /> sell</div>
          <div className="flex gap-1.5">
            <input value={sellQty} onChange={e => setSellQty(e.target.value)} inputMode="numeric"
              className="w-full min-w-0 bg-[#0b0e17] border border-[#1e2538] rounded-lg px-2 py-1.5 text-sm font-mono text-white outline-none focus:border-rose-500/60" />
            <button onClick={doSell} disabled={busy || !wallet.connected}
              className="px-3 py-1.5 rounded-lg bg-rose-500 hover:bg-rose-400 disabled:opacity-40 text-slate-950 text-xs font-black cursor-pointer whitespace-nowrap">
              {busy ? '…' : 'Sell'}
            </button>
          </div>
          <div className="text-[11px] font-mono text-slate-400 mt-1.5">
            {sellQuote != null ? <>get <span className="text-white">{fmtX(sellQuote)} $xMoney</span></> : '—'}
          </div>
        </div>
      </div>
      {err && <div className="text-[11px] font-mono text-rose-400 break-words">{err}</div>}
      <div className="text-[10px] font-mono text-slate-600">β {(token.betaBps / 100).toFixed(0)}% · step {(token.stepBps / 100).toFixed(2)}% · 0.01% burn + 0.01% fanout per trade</div>
    </div>
  );
}

function LaunchForm({ launcher, wallet, onConnectWallet, onLaunched }: { launcher: string; wallet: UserWallet; onConnectWallet: () => void; onLaunched: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [maxSupply, setMaxSupply] = useState('1000');
  const [basePrice, setBasePrice] = useState('1');
  const [stepBps, setStepBps] = useState('100');
  const [betaBps, setBetaBps] = useState('9000');
  const [seedQty, setSeedQty] = useState('0');
  const [seedValue, setSeedValue] = useState('0');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const doLaunch = async () => {
    if (!wallet.connected || busy) return;
    setBusy(true); setErr(null);
    try {
      const ms = BigInt(maxSupply || '0');
      const bp = parseEther(basePrice || '0');
      const step = Number(stepBps); const beta = Number(betaBps);
      const sq = BigInt(seedQty || '0');
      if (!name.trim() || !symbol.trim()) throw new Error('Name and symbol are required.');
      if (ms <= 0n) throw new Error('Max supply must be > 0.');
      if (bp <= 0n) throw new Error('Base price must be > 0.');
      if (!(step >= 0 && step <= 5000)) throw new Error('Step must be 0–5000 bps (0–50%).');
      if (!(beta >= 5000 && beta <= 9500)) throw new Error('Beta must be 5000–9500 bps.');
      if (sq > ms) throw new Error('Seed quantity cannot exceed max supply.');
      const enc = encodeAbiCall(
        NGU_LAUNCHER_ABI, 'launch',
        [name.trim(), symbol.trim().toUpperCase(), ms, bp, step, beta, sq],
        launcher, seedValue || '0', L4_CHAIN_ID,
      );
      await sendOnChainTx({ to: launcher, data: enc.calldata, valueWei: BigInt(enc.valueWei), waitForConfirmation: true });
      setOpen(false); onLaunched();
    } catch (e: any) {
      setErr(e?.message || 'Launch failed');
    } finally { setBusy(false); }
  };

  if (!open) {
    return (
      <button onClick={() => wallet.connected ? setOpen(true) : onConnectWallet()}
        className="w-full rounded-2xl border border-dashed border-emerald-500/40 bg-emerald-500/5 hover:bg-emerald-500/10 px-4 py-4 flex items-center justify-center gap-2 text-emerald-300 font-bold text-sm cursor-pointer transition-colors">
        <Rocket className="w-4 h-4" /> Launch a new NGU token — zero launch fee
      </button>
    );
  }

  const field = 'w-full bg-[#0b0e17] border border-[#1e2538] rounded-lg px-2.5 py-2 text-sm font-mono text-white outline-none focus:border-emerald-500/60';
  return (
    <div className="rounded-2xl bg-[#0b0e17] border border-emerald-500/30 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="font-black text-white flex items-center gap-2"><Rocket className="w-4 h-4 text-emerald-400" /> Launch NGU token</div>
        <button onClick={() => setOpen(false)} className="text-slate-500 hover:text-white text-xs font-mono cursor-pointer">cancel</button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <label className="text-xs font-mono text-slate-400">name<input value={name} onChange={e => setName(e.target.value)} placeholder="My Token" className={field} /></label>
        <label className="text-xs font-mono text-slate-400">symbol<input value={symbol} onChange={e => setSymbol(e.target.value)} placeholder="MTK" className={field} /></label>
        <label className="text-xs font-mono text-slate-400">max supply<input value={maxSupply} onChange={e => setMaxSupply(e.target.value)} inputMode="numeric" className={field} /></label>
        <label className="text-xs font-mono text-slate-400">base price ($xMoney)<input value={basePrice} onChange={e => setBasePrice(e.target.value)} inputMode="decimal" className={field} /></label>
        <label className="text-xs font-mono text-slate-400">step bps (100 = 1%)<input value={stepBps} onChange={e => setStepBps(e.target.value)} inputMode="numeric" className={field} /></label>
        <label className="text-xs font-mono text-slate-400">beta bps (9000 = 90%)<input value={betaBps} onChange={e => setBetaBps(e.target.value)} inputMode="numeric" className={field} /></label>
        <label className="text-xs font-mono text-slate-400">seed qty<input value={seedQty} onChange={e => setSeedQty(e.target.value)} inputMode="numeric" className={field} /></label>
        <label className="text-xs font-mono text-slate-400">seed $xMoney<input value={seedValue} onChange={e => setSeedValue(e.target.value)} inputMode="decimal" className={field} /></label>
      </div>
      {err && <div className="text-[11px] font-mono text-rose-400 mt-2 break-words">{err}</div>}
      <button onClick={doLaunch} disabled={busy}
        className="mt-3 px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 text-sm font-black cursor-pointer">
        {busy ? 'Launching…' : 'Launch token'}
      </button>
      <div className="text-[10px] font-mono text-slate-600 mt-2">Seed $xMoney backs your seed tokens at genesis — no fee, no curve step. Economics are immutable after launch.</div>
    </div>
  );
}

export function NguLaunchpad({ wallet, onConnectWallet }: { wallet: UserWallet; onConnectWallet: () => void }) {
  const [launcher, setLauncher] = useState<string>(l4Addresses.nguLauncher);
  const [tokens, setTokens] = useState<NguTokenState[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    await loadL4Info().catch(() => null);
    const la = l4Addresses.nguLauncher;
    setLauncher(la);
    if (!la || la === ZERO) { setTokens([]); setLoading(false); return; }
    try {
      const n: bigint = await l4PublicClient.readContract({ address: addr(la), abi: NGU_LAUNCHER_ABI, functionName: 'allTokensLength' });
      const addrs: string[] = [];
      for (let i = 0n; i < n; i++) {
        addrs.push(await l4PublicClient.readContract({ address: addr(la), abi: NGU_LAUNCHER_ABI, functionName: 'allTokens', args: [i] }) as string);
      }
      const states = await Promise.all(addrs.map(a => readToken(a, wallet.connected ? wallet.address : '')));
      setTokens(states.reverse());
    } catch {
      setTokens([]);
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [wallet.connected, wallet.address]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => { setRefreshing(true); load(); }, 15000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl bg-[#0b0e17] border border-[#1e2538] p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2 justify-between">
          <div>
            <div className="font-black text-xl text-white font-display tracking-tight">NGU <span className="text-emerald-400">LAUNCHPAD</span></div>
            <div className="text-xs font-mono text-slate-400 mt-1">Number go up: the collection is its own market. Every buy mints on a rising curve; every sell burns and redeems from the reserve.</div>
          </div>
          <button onClick={() => { setRefreshing(true); load(); }} className="p-2 rounded-xl bg-[#121624] border border-[#1e2538] text-slate-400 hover:text-white cursor-pointer" title="Refresh">
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
        <div className="mt-3 flex items-start gap-2 text-[11px] font-mono text-slate-500">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-slate-600" />
          <span>The contract guarantees the mint price and the redemption floor never decrease — the primary curve only. If a token also trades on a DEX, that price can deviate. Each card shows the worst case for buying then selling straight back.</span>
        </div>
      </div>

      {(!launcher || launcher === ZERO) ? (
        <div className="rounded-2xl bg-[#0b0e17] border border-amber-500/30 p-6 text-center">
          <AlertTriangle className="w-6 h-6 text-amber-400 mx-auto mb-2" />
          <div className="font-bold text-white">NGU launcher not deployed yet</div>
          <div className="text-xs font-mono text-slate-400 mt-1">Contracts are built and tested (20/20). Once the launcher deploys, this page lights up — launch with zero fee, trade on the curve.</div>
        </div>
      ) : (<>
        {!wallet.connected && (
          <button onClick={onConnectWallet}
            className="rounded-2xl border border-[#1e2538] bg-[#0b0e17] px-4 py-4 flex items-center justify-center gap-2 text-slate-200 font-bold text-sm cursor-pointer hover:border-emerald-500/40">
            <Wallet className="w-4 h-4 text-emerald-400" /> Connect wallet to launch & trade
          </button>
        )}
        <LaunchForm launcher={launcher} wallet={wallet} onConnectWallet={onConnectWallet} onLaunched={load} />
        {loading ? (
          <div className="text-center text-xs font-mono text-slate-500 py-8">loading tokens…</div>
        ) : tokens.length === 0 ? (
          <div className="rounded-2xl bg-[#0b0e17] border border-[#1e2538] p-8 text-center text-sm font-mono text-slate-500">
            No NGU tokens yet. Launch the first one.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {tokens.map(t => <TokenCard key={t.address} token={t} wallet={wallet} onTrade={load} />)}
          </div>
        )}
      </>)}
    </div>
  );
}
