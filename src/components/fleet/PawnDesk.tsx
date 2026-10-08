import React, { useCallback, useEffect, useState } from 'react';
import { UserWallet } from '../../types';
import { L4GasPanel } from '../L4GasPanel';
import { tool, sendPrepared, plain } from './connector';
import { card, inputCls, btnPrimary, btnGhost, Stat, Field, Msg, useAction } from './ui';
import { RefreshCw, Wallet, Landmark } from 'lucide-react';

// Pawn on xGas: borrow WXM (wrapped xMoney, 1:1) against an NFT, priced by its CLMM market; lenders earn the APR.
interface Pool { pool_id: number; collection: string; lendable_xmoney: string; borrowed_xmoney: string; borrow_apr_pct: string; utilisation_pct: string; ltv_pct: string; liquidation_at_pct: string }

function PoolCard({ p, wallet, onDone }: { p: Pool; wallet: UserWallet; onDone: () => void }) {
  const [lend, setLend] = useState('0.01');
  const [tokenId, setTokenId] = useState('');
  const a = useAction();
  const go = (name: string, args: Record<string, unknown>, done: string) => a.run(async () => {
    const r = await tool(name, args);
    if (!r.data?.transactions) throw new Error(plain(r.summary));
    await sendPrepared(r.data); onDone(); return done;
  });
  return (
    <div className={card}>
      <div className="min-w-0"><div className="font-black text-white">Pool {p.pool_id}</div><div className="text-xs font-mono text-slate-400 truncate">{p.collection}</div></div>
      <div className="grid grid-cols-3 gap-2">
        <Stat label="lendable" value={p.lendable_xmoney} cls="text-emerald-400" />
        <Stat label="apr" value={`${p.borrow_apr_pct}%`} />
        <Stat label="ltv / liq" value={`${p.ltv_pct} / ${p.liquidation_at_pct}%`} cls="text-amber-300" />
      </div>
      <div className="flex gap-1.5">
        <input value={tokenId} onChange={(e) => setTokenId(e.target.value.replace(/\D/g, ''))} placeholder="NFT id to pawn" aria-label="NFT id to pawn" className={inputCls} />
        <button className={btnPrimary} disabled={a.busy || !wallet.connected || !tokenId} onClick={() => go('prepare_pawn', { pool_id: p.pool_id, token_id: tokenId, borrower: wallet.address }, `Pawned #${tokenId}. Your ticket NFT redeems it.`)}>Borrow</button>
      </div>
      <div className="flex gap-1.5">
        <input value={lend} onChange={(e) => setLend(e.target.value)} aria-label="xMoney to lend" className={inputCls} />
        <button className={btnGhost} disabled={a.busy || !wallet.connected} onClick={() => go('prepare_pawn_lend', { pool_id: p.pool_id, amount_xmoney: lend, lender: wallet.address }, `Lent ${lend}.`)}>Lend</button>
      </div>
      <div className="text-[10px] text-slate-500">Loans are paid in WXM (wrapped xMoney, 1:1). If the debt reaches {p.liquidation_at_pct}% of the NFT's floor, anyone can liquidate it.</div>
      <Msg err={a.err} ok={a.ok} />
    </div>
  );
}

function Redeem({ wallet, onDone }: { wallet: UserWallet; onDone: () => void }) {
  const [ticket, setTicket] = useState('');
  const a = useAction();
  return (
    <div className={card}>
      <div className="font-black text-white">Repay a ticket</div>
      <Field label="ticket id" value={ticket} onChange={(v) => setTicket(v.replace(/\D/g, ''))} />
      <button className={btnPrimary} disabled={a.busy || !wallet.connected || !ticket} onClick={() => a.run(async () => {
        const r = await tool('prepare_pawn_redeem', { ticket_id: ticket, holder: wallet.address });
        if (!r.data?.transactions) throw new Error(plain(r.summary));
        await sendPrepared(r.data); onDone(); return `Redeemed ticket ${ticket}; the NFT is back.`;
      })}>Repay and take the NFT back</button>
      <Msg err={a.err} ok={a.ok} />
    </div>
  );
}

export function PawnDesk({ wallet, onConnectWallet }: { wallet: UserWallet; onConnectWallet: () => void }) {
  const [pools, setPools] = useState<Pool[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try { const r = await tool('list_pawn_pools', {}); setPools(r.data?.pools || []); } catch (e: any) { setErr(e?.message || 'Could not load pools'); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="flex flex-col gap-4">
      <div className={`${card} !flex-row flex-wrap items-center justify-between`}>
        <div className="min-w-0">
          <div className="font-black text-white text-xl flex items-center gap-2"><Landmark className="w-5 h-5 text-amber-300" /> Pawn</div>
          <div className="text-xs text-slate-400 mt-1">Borrow wrapped xMoney against an NFT, priced live by its market. Lenders earn the APR. From the staccpad fleet, on xGas.</div>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className={`${btnGhost} flex items-center gap-1`}><RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh</button>
          {!wallet.connected && <button onClick={onConnectWallet} className={`${btnPrimary} flex items-center gap-1`}><Wallet className="w-3.5 h-3.5" /> Connect</button>}
        </div>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-4 items-start">
        <div className="flex flex-col gap-3">
          <Msg err={err} />
          {pools && !pools.length && !err && <div className="text-sm text-slate-400">No lending pools yet.</div>}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">{(pools || []).map((p) => <PoolCard key={p.pool_id} p={p} wallet={wallet} onDone={load} />)}</div>
        </div>
        <div className="flex flex-col gap-3">
          <Redeem wallet={wallet} onDone={load} />
          {wallet.connected && <L4GasPanel owner={wallet.address} />}
        </div>
      </div>
    </div>
  );
}
