import React from 'react';
import { AlertTriangle } from 'lucide-react';

export const card = 'rounded-2xl bg-[#0b0e17] border border-[#1e2538] p-4 flex flex-col gap-3';
export const inset = 'rounded-xl bg-[#121624] border border-[#1e2538]';
export const inputCls = 'bg-[#0b0e17] border border-[#1e2538] rounded-lg px-2 py-1.5 text-sm font-mono text-white outline-none focus:border-emerald-500/60 w-full min-w-0';
export const btnPrimary = 'px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 text-xs font-black cursor-pointer whitespace-nowrap';
export const btnGhost = 'px-3 py-1.5 rounded-lg border border-[#1e2538] text-slate-300 hover:text-white text-xs font-black cursor-pointer whitespace-nowrap';

export function Stat({ label, value, cls = 'text-white' }: { label: string; value: React.ReactNode; cls?: string }) {
  return (
    <div className={`${inset} px-2 py-2 text-center`}>
      <div className="text-[10px] font-mono text-slate-500 uppercase">{label}</div>
      <div className={`font-mono font-bold text-sm ${cls}`}>{value}</div>
    </div>
  );
}

export function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="flex flex-col gap-1 text-[10px] font-mono text-slate-500 uppercase">
      {label}
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={`${inputCls} normal-case`} />
    </label>
  );
}

export function Msg({ err, ok }: { err?: string | null; ok?: string | null }) {
  return (
    <>
      {err && <div className="text-xs text-rose-300 flex gap-1"><AlertTriangle className="w-3.5 h-3.5 shrink-0" />{err}</div>}
      {ok && <div className="text-xs text-emerald-300 break-all">{ok}</div>}
    </>
  );
}

/** Run one connector-backed action with busy/error/ok state. */
export function useAction() {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [ok, setOk] = React.useState<string | null>(null);
  const run = async (fn: () => Promise<string>) => {
    if (busy) return;
    setBusy(true); setErr(null); setOk(null);
    try { setOk(await fn()); } catch (e: any) { setErr(e?.shortMessage || e?.message || 'Failed'); } finally { setBusy(false); }
  };
  return { busy, err, ok, run };
}
