import React, { useCallback, useEffect, useState } from 'react';
import { sendL4Tx } from '../contracts/gas';
import { L4GasPanel } from './L4GasPanel';
import { Disclosure } from './Disclosure';
import { UserWallet } from '../types';
import { Rocket, TrendingUp, TrendingDown, RefreshCw, AlertTriangle, Wallet, Info, Image as ImageIcon } from 'lucide-react';

// NFT NGU: the staccpad fleet's bonding-curve NFT collections, live on the xGas L4.
// Every quote, risk figure and transaction comes from the same connector tools the MCP serves
// (POST /api/connector/<tool>), so the site and a model always see the same numbers.

interface Collection {
  collection: string;
  name: string;
  symbol: string;
  worst_case_loss_pct: string | null;
  next_price_xmoney: string;
  floor_xmoney: string;
  vault_xmoney: string;
  minted: string;
  max_supply: string;
  remaining: string;
  sold_out: boolean;
  lp_bps: number;
  fees: string;
  holder?: { redeemable_ids: string[]; companion_ids: string[] };
}

interface PreparedTx { label: string; chainId: number; to: string; data: string; value: string }

// Stranger-written names arrive wrapped in «» for models; the page shows them plain.
const plain = (s: string) => String(s ?? '').replace(/[«»]/g, '').replace(/\*\*/g, '');

async function tool<T = any>(name: string, args: Record<string, unknown>): Promise<{ summary: string; data: T }> {
  const r = await fetch(`/api/connector/${name}`, {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${name} failed (${r.status})`);
  return j;
}

async function sendPrepared(data: { transactions?: PreparedTx[] }) {
  const txs = data?.transactions || [];
  if (!txs.length) throw new Error('Nothing to sign.');
  let last = '';
  for (const t of txs) {
    const r = await sendL4Tx({ to: t.to, data: t.data, valueWei: BigInt(t.value || '0'), waitForConfirmation: true });
    last = (r as any)?.hash || last;
  }
  return last;
}

function CollectionCard({ c, wallet, onTrade }: { c: Collection; wallet: UserWallet; onTrade: () => void }) {
  const [qty, setQty] = useState('1');
  const [quote, setQuote] = useState<string | null>(null);
  const [mine, setMine] = useState<string[] | null>(null);
  const [pick, setPick] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const progress = Number(c.max_supply) ? (Number(c.minted) / Number(c.max_supply)) * 100 : 0;

  useEffect(() => {
    const n = Math.floor(Number(qty));
    if (!(n >= 1 && n <= 50) || c.sold_out) { setQuote(null); return; }
    let live = true;
    tool('quote_nft_ngu_buy', { collection: c.collection, qty: n }).then((r) => live && setQuote(r.data?.cost_xmoney ?? null)).catch(() => live && setQuote(null));
    return () => { live = false; };
  }, [qty, c.collection, c.sold_out, c.minted]);

  useEffect(() => {
    if (!wallet.connected) { setMine(null); return; }
    let live = true;
    tool<Collection>('get_nft_ngu', { collection: c.collection, holder: wallet.address })
      .then((r) => live && setMine(r.data?.holder?.redeemable_ids ?? []))
      .catch(() => live && setMine(null));
    return () => { live = false; };
  }, [wallet.connected, wallet.address, c.collection, c.minted]);

  const run = async (fn: () => Promise<string>) => {
    if (!wallet.connected || busy) return;
    setBusy(true); setErr(null); setOk(null);
    try { setOk(await fn()); setPick([]); onTrade(); } catch (e: any) { setErr(e?.shortMessage || e?.message || 'Failed'); } finally { setBusy(false); }
  };
  const doMint = () => run(async () => {
    const r = await tool('prepare_nft_ngu_buy', { collection: c.collection, qty: Math.floor(Number(qty)), to: wallet.address });
    await sendPrepared(r.data);
    return `Minted ${qty}.`;
  });
  const doRedeem = () => run(async () => {
    if (!pick.length) throw new Error('Pick the NFTs to redeem.');
    const r = await tool('prepare_nft_ngu_sell', { collection: c.collection, token_ids: pick, seller: wallet.address, to: wallet.address });
    if (!r.data?.transactions) throw new Error(r.summary);
    await sendPrepared(r.data);
    return `Redeemed ${pick.length}.`;
  });

  return (
    <div className="rounded-2xl bg-[#0b0e17] border border-[#1e2538] p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-black text-white text-lg leading-tight truncate">{plain(c.name)}</div>
          <div className="text-xs font-mono text-slate-400">{plain(c.symbol)} · <span className="text-slate-500">{c.collection.slice(0, 6)}…{c.collection.slice(-4)}</span></div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10px] font-mono text-slate-500 uppercase">max instant loss</div>
          <div className="text-sm font-black font-mono text-amber-400" title="Mint one at the next price and redeem it straight back, fees included">{c.worst_case_loss_pct ?? '—'}</div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        {[['floor', c.floor_xmoney, 'text-emerald-400'], ['next price', c.next_price_xmoney, 'text-white'], ['you hold', mine == null ? '—' : String(mine.length), 'text-cyan-300']].map(([k, v, cls]) => (
          <div key={k} className="rounded-xl bg-[#121624] border border-[#1e2538] px-2 py-2">
            <div className="text-[10px] font-mono text-slate-500 uppercase">{k}</div>
            <div className={`font-mono font-bold text-sm ${cls}`}>{v}</div>
          </div>
        ))}
      </div>

      <div>
        <div className="flex justify-between text-[10px] font-mono text-slate-500 mb-1">
          <span>minted {c.minted} / {c.max_supply}</span><span>{progress.toFixed(1)}%</span>
        </div>
        <div className="h-1.5 rounded-full bg-[#1a2033] overflow-hidden">
          <div className="h-full bg-gradient-to-r from-emerald-500 to-teal-400" style={{ width: `${Math.min(100, progress)}%` }} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div className="rounded-xl bg-[#121624] border border-[#1e2538] p-2.5">
          <div className="text-[10px] font-mono text-slate-500 uppercase mb-1.5 flex items-center gap-1"><TrendingUp className="w-3 h-3 text-emerald-400" /> mint</div>
          <div className="flex gap-1.5">
            <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="numeric" aria-label="NFTs to mint"
              className="w-full min-w-0 bg-[#0b0e17] border border-[#1e2538] rounded-lg px-2 py-1.5 text-sm font-mono text-white outline-none focus:border-emerald-500/60" />
            <button onClick={doMint} disabled={busy || c.sold_out || !wallet.connected}
              className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 text-xs font-black cursor-pointer whitespace-nowrap">
              {busy ? '…' : c.sold_out ? 'sold out' : 'Mint'}
            </button>
          </div>
          <div className="text-[10px] font-mono text-slate-500 mt-1">{quote ? `${quote} $xMoney` : ' '}</div>
        </div>
        <div className="rounded-xl bg-[#121624] border border-[#1e2538] p-2.5">
          <div className="text-[10px] font-mono text-slate-500 uppercase mb-1.5 flex items-center gap-1"><TrendingDown className="w-3 h-3 text-rose-400" /> redeem</div>
          {mine && mine.length ? (
            <>
              <div className="flex flex-wrap gap-1 mb-1.5 max-h-16 overflow-y-auto">
                {mine.map((id) => (
                  <button key={id} onClick={() => setPick((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(0, 50)))}
                    className={`px-1.5 py-0.5 rounded text-[10px] font-mono cursor-pointer border ${pick.includes(id) ? 'bg-rose-500/20 border-rose-500/60 text-rose-200' : 'border-[#1e2538] text-slate-400'}`}>#{id}</button>
                ))}
              </div>
              <button onClick={doRedeem} disabled={busy || !pick.length}
                className="w-full px-3 py-1.5 rounded-lg bg-rose-500/90 hover:bg-rose-400 disabled:opacity-40 text-slate-950 text-xs font-black cursor-pointer">
                {busy ? '…' : `Redeem ${pick.length || ''}`}
              </button>
            </>
          ) : (
            <div className="text-[11px] text-slate-500">{wallet.connected ? 'No redeemable NFTs in this wallet.' : 'Connect to see yours.'}</div>
          )}
        </div>
      </div>

      <div className="text-[10px] text-slate-500 leading-snug">{c.fees}</div>
      {err && <div className="text-xs text-rose-300 flex gap-1"><AlertTriangle className="w-3.5 h-3.5 shrink-0" />{err}</div>}
      {ok && <div className="text-xs text-emerald-300">{ok}</div>}
    </div>
  );
}

function LaunchForm({ wallet, onLaunched }: { wallet: UserWallet; onLaunched: () => void }) {
  const [f, setF] = useState({ name: '', symbol: '', base_uri: '', max_supply: '1000', base_price_xmoney: '0.01', step_bps: '100', beta_bps: '9000', lp_bps: '0' });
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  const args = () => {
    const lp = Number(f.lp_bps) || 0;
    return {
      name: f.name.trim(), symbol: f.symbol.trim(), base_uri: f.base_uri.trim(), max_supply: Number(f.max_supply), base_price_xmoney: f.base_price_xmoney.trim(),
      step_bps: Number(f.step_bps), beta_bps: Number(f.beta_bps), lp_bps: lp, companions_per_mint: lp > 0 ? 1 : 0,
    };
  };
  const doPreview = async () => {
    setErr(null); setPreview(null);
    try { const r = await tool('launch_nft_ngu', args()); setPreview(r.summary); } catch (e: any) { setErr(e?.message || 'Invalid'); }
  };
  const doLaunch = async () => {
    if (!wallet.connected || busy) return;
    setBusy(true); setErr(null); setMade(null);
    try {
      const r = await tool('launch_nft_ngu', args());
      const hash = await sendPrepared(r.data);
      const found = hash ? await tool('find_nft_ngu_launch', { tx_hash: hash }) : null;
      setMade(found?.data?.collection || 'Launched.');
      onLaunched();
    } catch (e: any) { setErr(e?.shortMessage || e?.message || 'Launch failed'); } finally { setBusy(false); }
  };
  const field = (k: keyof typeof f, label: string, ph = '') => (
    <label className="flex flex-col gap-1 text-[10px] font-mono text-slate-500 uppercase">
      {label}
      <input value={f[k]} onChange={set(k)} placeholder={ph}
        className="bg-[#0b0e17] border border-[#1e2538] rounded-lg px-2 py-1.5 text-sm font-mono text-white normal-case outline-none focus:border-emerald-500/60" />
    </label>
  );
  return (
    <div className="rounded-2xl bg-[#0b0e17] border border-[#1e2538] p-4 flex flex-col gap-3">
      <div className="font-black text-white flex items-center gap-2"><Rocket className="w-4 h-4 text-emerald-400" /> Launch an NFT NGU collection</div>
      <div className="grid grid-cols-2 gap-2">
        {field('name', 'name', 'My Collection')}
        {field('symbol', 'symbol', 'MINE')}
        <div className="col-span-2">{field('base_uri', 'metadata base uri', 'ipfs://…/')}</div>
        {field('max_supply', 'max supply')}
        {field('base_price_xmoney', 'first price ($xMoney)')}
        {field('step_bps', 'step per mint (bps)')}
        {field('beta_bps', 'floor β (bps, 5000–9500)')}
        {field('lp_bps', 'LP slice (bps, 0 = none)')}
      </div>
      <div className="flex gap-2">
        <button onClick={doPreview} className="px-3 py-2 rounded-lg border border-[#1e2538] text-slate-300 hover:text-white text-xs font-black cursor-pointer">Preview terms</button>
        <button onClick={doLaunch} disabled={busy || !wallet.connected || !f.name || !f.symbol}
          className="flex-1 px-3 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 text-xs font-black cursor-pointer">
          {busy ? 'Launching…' : wallet.connected ? 'Launch' : 'Connect a wallet to launch'}
        </button>
      </div>
      {preview && <pre className="whitespace-pre-wrap text-[11px] text-slate-300 bg-[#121624] border border-[#1e2538] rounded-lg p-2.5 max-h-72 overflow-y-auto">{plain(preview)}</pre>}
      {err && <div className="text-xs text-rose-300 flex gap-1"><AlertTriangle className="w-3.5 h-3.5 shrink-0" />{err}</div>}
      {made && <div className="text-xs text-emerald-300 break-all">Live: {made}</div>}
    </div>
  );
}

export function NftNguDesk({ wallet, onConnectWallet }: { wallet: UserWallet; onConnectWallet: () => void }) {
  const [cols, setCols] = useState<Collection[] | null>(null);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const r = await tool<{ collections: Collection[]; total: number }>('list_nft_ngus', { limit: 50 });
      setCols((r.data?.collections || []).filter((c: any) => !c.error));
      setTotal(r.data?.total ?? 0);
    } catch (e: any) { setErr(e?.message || 'Could not load collections'); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl bg-[#0b0e17] border border-[#1e2538] p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-black text-white text-xl flex items-center gap-2"><ImageIcon className="w-5 h-5 text-emerald-400" /> NFT NGU</div>
          <div className="text-xs text-slate-400 mt-1">NFT collections on a bonding curve. Each mint costs a little more; every NFT redeems against the collection's vault. From the staccpad fleet, now on xGas.</div>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className="px-3 py-2 rounded-lg border border-[#1e2538] text-slate-300 hover:text-white text-xs font-black cursor-pointer flex items-center gap-1">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
          {!wallet.connected && (
            <button onClick={onConnectWallet} className="px-3 py-2 rounded-lg bg-emerald-500 text-slate-950 text-xs font-black cursor-pointer flex items-center gap-1"><Wallet className="w-3.5 h-3.5" /> Connect</button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-4 items-start">
        <div className="flex flex-col gap-3">
          {err && <div className="text-sm text-rose-300 flex gap-1.5"><AlertTriangle className="w-4 h-4 shrink-0" />{err}</div>}
          {cols && !cols.length && !err && <div className="text-sm text-slate-400">No collections yet. Launch the first one.</div>}
          {cols && cols.length > 0 && <div className="text-[11px] font-mono text-slate-500">{cols.length} of {total} collections, newest first</div>}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {(cols || []).map((c) => <CollectionCard key={c.collection} c={c} wallet={wallet} onTrade={load} />)}
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <LaunchForm wallet={wallet} onLaunched={load} />
          {wallet.connected && <L4GasPanel owner={wallet.address} />}
          <Disclosure label={<span className="inline-flex items-center gap-1"><Info className="w-3 h-3" aria-hidden="true" /> How the curve works</span>}>
            <div className="text-xs text-slate-400 leading-relaxed flex flex-col gap-2">
              <p>The next mint costs the larger of the last price plus the step and the vault per NFT divided by β. Price never goes down.</p>
              <p>Redeeming burns the NFT and pays the lower of the floor and the last price paid, less a 6% exit fee. Part of that fee goes to protocol and the rest stays in the vault, which lifts the floor for everyone left.</p>
              <p>With an LP slice, part of each mint and some companion NFTs are locked forever as liquidity on the xGas PoolManager, and the minter keeps the fee receipt. Companion NFTs trade in the pool but never redeem.</p>
              <p>"Max instant loss" is minting one now and redeeming it straight back, fees included. Unaudited contracts: use amounts you can afford to lose.</p>
            </div>
          </Disclosure>
        </div>
      </div>
    </div>
  );
}
