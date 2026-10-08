import React, { useCallback, useEffect, useState } from 'react';
import { UserWallet } from '../../types';
import { L4GasPanel } from '../L4GasPanel';
import { tool, sendPrepared, plain } from './connector';
import { card, inputCls, btnPrimary, btnGhost, Stat, Field, Msg, useAction } from './ui';
import { RefreshCw, Wallet, ArrowLeftRight, Plus } from 'lucide-react';

// Peg markets on xGas: any ERC-721 vaulted into claims with a native $xMoney pool on the xGas PoolManager.
interface Market { vault: string; collection: string; collection_name: string; collection_symbol: string; nfts_in_vault: number; floor_token_id?: string; buy_floor_xmoney?: string | null; sell_one_xmoney?: string | null; buy_quote_error?: string; platform_fee_bps: number; snipe_premium_bps: number }

function MarketCard({ m, wallet, onTrade }: { m: Market; wallet: UserWallet; onTrade: () => void }) {
  const [id, setId] = useState('');
  const a = useAction();
  return (
    <div className={card}>
      <div className="min-w-0"><div className="font-black text-white truncate">{plain(m.collection_name)}</div><div className="text-xs font-mono text-slate-400">{plain(m.collection_symbol)} · vault {m.vault.slice(0, 6)}…{m.vault.slice(-4)}</div></div>
      <div className="grid grid-cols-3 gap-2">
        <Stat label="in vault" value={m.nfts_in_vault} />
        <Stat label="buy floor" value={m.buy_floor_xmoney ?? 'n/a'} cls="text-emerald-400" />
        <Stat label="sell one" value={m.sell_one_xmoney ?? 'n/a'} cls="text-rose-300" />
      </div>
      <div className="flex gap-1.5">
        <button className={`${btnPrimary} flex-1`} disabled={a.busy || !wallet.connected || !m.buy_floor_xmoney} onClick={() => a.run(async () => {
          const r = await tool('prepare_peg_buy_floor', { vault: m.vault, receiver: wallet.address });
          if (!r.data?.transactions) throw new Error(plain(r.summary));
          await sendPrepared(r.data); onTrade(); return `Bought #${m.floor_token_id}.`;
        })}>Buy floor{m.floor_token_id ? ` #${m.floor_token_id}` : ''}</button>
      </div>
      <div className="flex gap-1.5">
        <input value={id} onChange={(e) => setId(e.target.value.replace(/\D/g, ''))} placeholder="your token id" aria-label="Token id to sell" className={inputCls} />
        <button className={btnGhost} disabled={a.busy || !wallet.connected || !id || !m.sell_one_xmoney} onClick={() => a.run(async () => {
          const r = await tool('prepare_peg_sell', { vault: m.vault, token_id: id, seller: wallet.address });
          if (!r.data?.transactions) throw new Error(plain(r.summary));
          await sendPrepared(r.data); onTrade(); return `Sold #${id}.`;
        })}>Sell</button>
      </div>
      {m.buy_quote_error && <div className="text-[10px] text-slate-500">{m.buy_quote_error}</div>}
      <div className="text-[10px] text-slate-500">Platform {(m.platform_fee_bps / 100).toFixed(2)}%, snipe premium {(m.snipe_premium_bps / 100).toFixed(2)}%; quotes include the pool fee and the xGas JIT toll.</div>
      <Msg err={a.err} ok={a.ok} />
    </div>
  );
}

function OpenMarket({ wallet, onDone }: { wallet: UserWallet; onDone: () => void }) {
  const [collection, setCollection] = useState('');
  const [price, setPrice] = useState('0.01');
  const a = useAction();
  return (
    <div className={card}>
      <div className="font-black text-white flex items-center gap-2"><Plus className="w-4 h-4 text-emerald-400" /> Open a market for a collection</div>
      <Field label="collection address (on xGas)" value={collection} onChange={setCollection} placeholder="0x…" />
      <Field label="starting price per NFT ($xMoney)" value={price} onChange={setPrice} />
      <button className={btnPrimary} disabled={a.busy || !wallet.connected || !/^0x[0-9a-fA-F]{40}$/.test(collection)} onClick={() => a.run(async () => {
        const r = await tool('create_peg_market', { collection, price_per_nft_xmoney: price });
        await sendPrepared(r.data); onDone(); return 'Market opened. Add liquidity or deposit NFTs to make it tradable.';
      })}>{a.busy ? '…' : wallet.connected ? 'Open market' : 'Connect a wallet'}</button>
      <Msg err={a.err} ok={a.ok} />
    </div>
  );
}

export function MarketsDesk({ wallet, onConnectWallet }: { wallet: UserWallet; onConnectWallet: () => void }) {
  const [markets, setMarkets] = useState<Market[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try { const r = await tool('list_peg_markets', { limit: 50 }); setMarkets((r.data?.markets || []).filter((m: any) => !m.error)); }
    catch (e: any) { setErr(e?.message || 'Could not load markets'); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="flex flex-col gap-4">
      <div className={`${card} !flex-row flex-wrap items-center justify-between`}>
        <div className="min-w-0">
          <div className="font-black text-white text-xl flex items-center gap-2"><ArrowLeftRight className="w-5 h-5 text-cyan-300" /> NFT markets</div>
          <div className="text-xs text-slate-400 mt-1">Any collection, vaulted into claims with a $xMoney pool: buy the floor or sell one NFT instantly, no listings. From the staccpad fleet, on xGas.</div>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className={`${btnGhost} flex items-center gap-1`}><RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh</button>
          {!wallet.connected && <button onClick={onConnectWallet} className={`${btnPrimary} flex items-center gap-1`}><Wallet className="w-3.5 h-3.5" /> Connect</button>}
        </div>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-4 items-start">
        <div className="flex flex-col gap-3">
          <Msg err={err} />
          {markets && !markets.length && !err && <div className="text-sm text-slate-400">No markets yet.</div>}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">{(markets || []).map((m) => <MarketCard key={m.vault} m={m} wallet={wallet} onTrade={load} />)}</div>
        </div>
        <div className="flex flex-col gap-3">
          <OpenMarket wallet={wallet} onDone={load} />
          {wallet.connected && <L4GasPanel owner={wallet.address} />}
        </div>
      </div>
    </div>
  );
}
