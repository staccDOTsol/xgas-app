import React, { useCallback, useEffect, useState } from 'react';
import { UserWallet } from '../../types';
import { L4GasPanel } from '../L4GasPanel';
import { tool, sendPrepared, plain } from './connector';
import { card, inset, inputCls, btnPrimary, btnGhost, Stat, Field, Msg, useAction } from './ui';
import { Rocket, RefreshCw, Wallet, Sparkles, TrendingUp, TrendingDown } from 'lucide-react';

// Drops on xGas from the staccpad fleet: PumpDrop curves (graduate into a locked pool) and staged StaccDrops.
interface Drop { kind: 'pump' | 'drop' | 'clmm'; collection: string; name: string; symbol: string; [k: string]: any }

function PumpCard({ d, wallet, onTrade }: { d: Drop; wallet: UserWallet; onTrade: () => void }) {
  const [qty, setQty] = useState('1');
  const [mine, setMine] = useState<string[] | null>(null);
  const [pick, setPick] = useState<string[]>([]);
  const a = useAction();
  useEffect(() => {
    if (!wallet.connected) { setMine(null); return; }
    tool('get_drop', { collection: d.collection, holder: wallet.address }).then((r) => setMine(r.data?.holder?.ids ?? [])).catch(() => setMine(null));
  }, [wallet.connected, wallet.address, d.collection, d.minted]);
  const progress = d.supply ? (d.minted / d.supply) * 100 : 0;
  return (
    <div className={card}>
      <div className="flex justify-between gap-2">
        <div className="min-w-0"><div className="font-black text-white truncate">{plain(d.name)}</div><div className="text-xs font-mono text-slate-400">{plain(d.symbol)} · pump · {d.collection.slice(0, 6)}…{d.collection.slice(-4)}</div></div>
        {d.graduated && <span className="text-[10px] font-mono text-emerald-300 border border-emerald-500/40 rounded px-1.5 h-fit">graduated</span>}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Stat label="next" value={d.next_price_xmoney} />
        <Stat label="reserve" value={d.reserve_xmoney} cls="text-emerald-400" />
        <Stat label="you hold" value={mine == null ? '—' : mine.length} cls="text-cyan-300" />
      </div>
      <div>
        <div className="flex justify-between text-[10px] font-mono text-slate-500 mb-1"><span>{d.minted} / {d.supply} to graduation</span><span>{progress.toFixed(1)}%</span></div>
        <div className="h-1.5 rounded-full bg-[#1a2033] overflow-hidden"><div className="h-full bg-gradient-to-r from-fuchsia-500 to-emerald-400" style={{ width: `${Math.min(100, progress)}%` }} /></div>
      </div>
      {!d.graduated && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className={`${inset} p-2.5`}>
            <div className="text-[10px] font-mono text-slate-500 uppercase mb-1.5 flex items-center gap-1"><TrendingUp className="w-3 h-3 text-emerald-400" /> mint</div>
            <div className="flex gap-1.5">
              <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="numeric" aria-label="NFTs to mint" className={inputCls} />
              <button className={btnPrimary} disabled={a.busy || !wallet.connected} onClick={() => a.run(async () => {
                const r = await tool('prepare_pump_buy', { collection: d.collection, qty: Math.floor(Number(qty)), to: wallet.address });
                if (!r.data?.transactions) throw new Error(plain(r.summary));
                await sendPrepared(r.data); onTrade(); return `Minted ${qty}.`;
              })}>{a.busy ? '…' : 'Mint'}</button>
            </div>
          </div>
          <div className={`${inset} p-2.5`}>
            <div className="text-[10px] font-mono text-slate-500 uppercase mb-1.5 flex items-center gap-1"><TrendingDown className="w-3 h-3 text-rose-400" /> sell back</div>
            {mine && mine.length ? (
              <>
                <div className="flex flex-wrap gap-1 mb-1.5 max-h-16 overflow-y-auto">
                  {mine.map((id) => <button key={id} onClick={() => setPick((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))}
                    className={`px-1.5 py-0.5 rounded text-[10px] font-mono cursor-pointer border ${pick.includes(id) ? 'bg-rose-500/20 border-rose-500/60 text-rose-200' : 'border-[#1e2538] text-slate-400'}`}>#{id}</button>)}
                </div>
                <button className={`${btnPrimary} w-full !bg-rose-500/90`} disabled={a.busy || !pick.length} onClick={() => a.run(async () => {
                  const r = await tool('prepare_pump_sell', { collection: d.collection, token_ids: pick, seller: wallet.address });
                  if (!r.data?.transactions) throw new Error(plain(r.summary));
                  await sendPrepared(r.data); setPick([]); onTrade(); return `Sold ${pick.length}.`;
                })}>Sell {pick.length || ''}</button>
              </>
            ) : <div className="text-[11px] text-slate-500">{wallet.connected ? 'None in this wallet.' : 'Connect to see yours.'}</div>}
          </div>
        </div>
      )}
      <div className="text-[10px] text-slate-500 leading-snug">{d.graduated ? 'Graduated: the curve is closed and this collection now trades in NFT markets.' : d.how_it_works}</div>
      <Msg err={a.err} ok={a.ok} />
    </div>
  );
}

function StaccDropCard({ d, wallet, onTrade }: { d: Drop; wallet: UserWallet; onTrade: () => void }) {
  const [qty, setQty] = useState('1');
  const a = useAction();
  const live = (d.stages || []).find((s: any) => s.status === 'live');
  return (
    <div className={card}>
      <div className="min-w-0"><div className="font-black text-white truncate">{plain(d.name)}</div><div className="text-xs font-mono text-slate-400">{plain(d.symbol)} · drop · {d.collection.slice(0, 6)}…{d.collection.slice(-4)}</div></div>
      <div className="grid grid-cols-3 gap-2">
        <Stat label="price" value={live ? live.price_xmoney : '—'} />
        <Stat label="minted" value={`${d.minted}/${d.max_supply}`} />
        <Stat label="stage" value={live ? `#${live.stage} live` : 'closed'} cls={live ? 'text-emerald-400' : 'text-slate-400'} />
      </div>
      {live && (
        <div className="flex gap-1.5">
          <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="numeric" aria-label="NFTs to mint" className={inputCls} />
          <button className={btnPrimary} disabled={a.busy || !wallet.connected} onClick={() => a.run(async () => {
            const r = await tool('prepare_drop_mint', { collection: d.collection, stage: live.stage, qty: Math.floor(Number(qty)), to: wallet.address });
            if (!r.data?.transactions) throw new Error(plain(r.summary));
            await sendPrepared(r.data); onTrade(); return `Minted ${qty}.`;
          })}>{a.busy ? '…' : 'Mint'}</button>
        </div>
      )}
      <Msg err={a.err} ok={a.ok} />
    </div>
  );
}

function ClmmCard({ d, wallet, onTrade }: { d: Drop; wallet: UserWallet; onTrade: () => void }) {
  const [qty, setQty] = useState('1');
  const a = useAction();
  return (
    <div className={card}>
      <div className="min-w-0"><div className="font-black text-white truncate">{plain(d.name)}</div><div className="text-xs font-mono text-slate-400">{plain(d.symbol)} · liquidity launch · {d.collection.slice(0, 6)}…{d.collection.slice(-4)}</div></div>
      <div className="grid grid-cols-3 gap-2">
        <Stat label="price" value={d.mint_price_xmoney} />
        <Stat label="minted" value={`${d.minted}/${d.max_supply}`} />
        <Stat label="to lp" value={`${(d.lp_proceeds_bps / 100).toFixed(0)}%`} cls="text-cyan-300" />
      </div>
      {!d.sold_out && (
        <div className="flex gap-1.5">
          <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="numeric" aria-label="NFTs to mint" className={inputCls} />
          <button className={btnPrimary} disabled={a.busy || !wallet.connected} onClick={() => a.run(async () => {
            const r = await tool('prepare_clmm_mint', { collection: d.collection, qty: Math.floor(Number(qty)) });
            if (!r.data?.transactions) throw new Error(plain(r.summary));
            await sendPrepared(r.data); onTrade(); return `Minted ${qty}.`;
          })}>{a.busy ? '…' : 'Mint'}</button>
        </div>
      )}
      <div className="text-[10px] text-slate-500 leading-snug">{d.how_it_works}</div>
      <Msg err={a.err} ok={a.ok} />
    </div>
  );
}

function LaunchPump({ wallet, onLaunched }: { wallet: UserWallet; onLaunched: () => void }) {
  const [kind, setKind] = useState<'pump' | 'drop' | 'clmm'>('pump');
  const [f, setF] = useState({ name: '', symbol: '', base_uri: '', supply: '100', base: '0.001', final: '0.01', price: '0.005' });
  const [preview, setPreview] = useState<string | null>(null);
  const a = useAction();
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const args = (): readonly [string, Record<string, unknown>] => kind === 'pump'
    ? ['launch_pump_drop', { name: f.name, symbol: f.symbol, base_uri: f.base_uri, supply: Number(f.supply), base_price_xmoney: f.base, final_price_xmoney: f.final }]
    : kind === 'clmm'
      ? ['launch_clmm_collection', { name: f.name, symbol: f.symbol, base_uri: f.base_uri, max_supply: Number(f.supply), mint_price_xmoney: f.price, lp_proceeds_bps: 5000, companions_per_mint: 1 }]
      : ['launch_drop', { name: f.name, symbol: f.symbol, base_uri: f.base_uri, max_supply: Number(f.supply), price_xmoney: f.price }];
  return (
    <div className={card}>
      <div className="font-black text-white flex items-center gap-2"><Rocket className="w-4 h-4 text-emerald-400" /> Launch a drop</div>
      <div className="flex gap-1.5">
        {(['pump', 'drop', 'clmm'] as const).map((k) => <button key={k} onClick={() => setKind(k)} className={kind === k ? btnPrimary : btnGhost}>{k === 'pump' ? 'Pump curve' : k === 'clmm' ? 'Liquidity launch' : 'Fixed price'}</button>)}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="name" value={f.name} onChange={set('name')} />
        <Field label="symbol" value={f.symbol} onChange={set('symbol')} />
        <div className="col-span-2"><Field label="metadata base uri" value={f.base_uri} onChange={set('base_uri')} placeholder="ipfs://…/" /></div>
        <Field label={kind === 'pump' ? 'supply' : 'max supply'} value={f.supply} onChange={set('supply')} />
        {kind === 'pump' ? (<>
          <Field label="first price" value={f.base} onChange={set('base')} />
          <Field label="last price" value={f.final} onChange={set('final')} />
        </>) : <Field label="price ($xMoney)" value={f.price} onChange={set('price')} />}
      </div>
      <div className="flex gap-2">
        <button className={btnGhost} onClick={async () => { const [n, x] = args(); try { setPreview(plain((await tool(n, x)).summary)); } catch (e: any) { setPreview(e.message); } }}>Preview terms</button>
        <button className={`${btnPrimary} flex-1`} disabled={a.busy || !wallet.connected || !f.name || !f.symbol} onClick={() => a.run(async () => {
          const [n, x] = args();
          const r = await tool(n, x);
          const hash = await sendPrepared(r.data);
          const found = kind === 'clmm'
            ? await tool('list_clmm_collections', { limit: 1 }).then((x) => ({ data: { collection: x.data?.collections?.[0]?.collection } })).catch(() => null)
            : hash ? await tool('find_drop_launch', { tx_hash: hash }) : null;
          onLaunched();
          return `Live: ${found?.data?.collection || hash}`;
        })}>{a.busy ? 'Launching…' : wallet.connected ? 'Launch' : 'Connect a wallet to launch'}</button>
      </div>
      {preview && <pre className={`${inset} whitespace-pre-wrap text-[11px] text-slate-300 p-2.5 max-h-72 overflow-y-auto`}>{preview}</pre>}
      <Msg err={a.err} ok={a.ok} />
    </div>
  );
}

export function DropsDesk({ wallet, onConnectWallet }: { wallet: UserWallet; onConnectWallet: () => void }) {
  const [drops, setDrops] = useState<Drop[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const [r, c] = await Promise.all([tool('list_drops', { limit: 50 }), tool('list_clmm_collections', { limit: 50 }).catch(() => null)]);
      const clmm = (c?.data?.collections || []).filter((d: any) => !d.error).map((d: any) => ({ ...d, kind: 'clmm' }));
      setDrops([...clmm, ...(r.data?.drops || []).filter((d: any) => !d.error)]);
    }
    catch (e: any) { setErr(e?.message || 'Could not load drops'); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="flex flex-col gap-4">
      <div className={`${card} !flex-row flex-wrap items-center justify-between`}>
        <div className="min-w-0">
          <div className="font-black text-white text-xl flex items-center gap-2"><Sparkles className="w-5 h-5 text-fuchsia-400" /> Drops</div>
          <div className="text-xs text-slate-400 mt-1">Pump curves you can sell back into until they graduate into a locked pool, fixed-price drops, and liquidity launches that lock part of every mint into the collection's own market. From the staccpad fleet, on xGas.</div>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className={`${btnGhost} flex items-center gap-1`}><RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh</button>
          {!wallet.connected && <button onClick={onConnectWallet} className={`${btnPrimary} flex items-center gap-1`}><Wallet className="w-3.5 h-3.5" /> Connect</button>}
        </div>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-4 items-start">
        <div className="flex flex-col gap-3">
          <Msg err={err} />
          {drops && !drops.length && !err && <div className="text-sm text-slate-400">No drops yet. Launch the first one.</div>}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {(drops || []).map((d) => d.kind === 'pump' ? <PumpCard key={d.collection} d={d} wallet={wallet} onTrade={load} />
              : d.kind === 'clmm' ? <ClmmCard key={d.collection} d={d} wallet={wallet} onTrade={load} />
              : <StaccDropCard key={d.collection} d={d} wallet={wallet} onTrade={load} />)}
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <LaunchPump wallet={wallet} onLaunched={load} />
          {wallet.connected && <L4GasPanel owner={wallet.address} />}
        </div>
      </div>
    </div>
  );
}
