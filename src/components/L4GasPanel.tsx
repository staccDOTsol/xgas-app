import React, { useEffect, useState } from 'react';
import { Fuel, Flame, RefreshCw, X } from 'lucide-react';
import {
  useL4Gas,
  registerGasConfirm,
  describeGasConfirm,
  approveXgasDevForGas,
  requestRobinhoodDrip,
  GAS_MODE_LABEL,
  fmt,
  short,
  type GasConfirmRequest,
} from '../contracts/gas';

const MODE_STYLE: Record<string, string> = {
  xmoney: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300',
  'wallet-paymaster': 'bg-fuchsia-500/15 border-fuchsia-500/40 text-fuchsia-300',
  'smart-account': 'bg-fuchsia-500/15 border-fuchsia-500/40 text-fuchsia-300',
  none: 'bg-amber-500/15 border-amber-500/40 text-amber-300',
};

/**
 * Which gas pays for L4 writes from this wallet, what XGAS.DEV gas costs, and the one-time Robinhood setup.
 * Also hosts the confirmation shown before any XGAS.DEV-paid send (gas.ts falls back to window.confirm without it).
 */
export function L4GasPanel({ owner }: { owner: string }) {
  const { plan, loading, error, last, refresh } = useL4Gas(owner);
  const [pending, setPending] = useState<{ req: GasConfirmRequest; resolve: (ok: boolean) => void } | null>(null);
  const [busy, setBusy] = useState<'approve' | 'drip' | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => registerGasConfirm((req) => new Promise<boolean>((resolve) => setPending({ req, resolve }))), []);

  const answer = (ok: boolean) => { pending?.resolve(ok); setPending(null); };

  const doApprove = async () => {
    setBusy('approve'); setNote(null);
    try {
      const r = await approveXgasDevForGas(owner);
      setNote(`Approved ${fmt(r.amount, 2)} XGAS.DEV for L4 gas (Robinhood tx ${short(r.txHash)}).`);
    } catch (e: any) {
      setNote(e?.shortMessage || e?.message || 'Approval failed.');
    } finally { setBusy(null); }
  };
  const doDrip = async () => {
    setBusy('drip'); setNote(null);
    try {
      const r = await requestRobinhoodDrip(owner);
      setNote(r.message);
    } catch (e: any) {
      setNote(e?.message || 'The drip failed.');
    } finally { setBusy(null); }
  };

  if (!owner) return null;

  const mode = plan?.mode ?? 'none';
  const xgasMode = mode === 'wallet-paymaster' || mode === 'smart-account';
  const st = plan?.status;
  const pos = plan?.xgasDev;
  // Show the XGAS.DEV route whenever it could apply: the wallet cannot cover gas in xMoney and the service is live.
  const showXgasDetails = !!plan && st?.live && (xgasMode || (mode === 'none' && !!pos));

  return (
    <>
      <div className="rounded-2xl bg-[#0b0e17] border border-[#1e2538] px-3.5 py-3 font-mono text-[11px] text-slate-400 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Fuel className="w-3.5 h-3.5 text-slate-500" />
          <span className="text-slate-300 font-bold uppercase tracking-wider text-[10px]">L4 gas</span>
          <span className={`px-2 py-0.5 rounded-full border text-[10px] font-bold ${MODE_STYLE[mode]}`}>
            {plan ? GAS_MODE_LABEL[mode] : loading ? 'checking...' : 'unknown'}
          </span>
          {plan && <span className="text-slate-500">wallet {fmt(plan.eoaXMoney)} xMoney</span>}
          {plan?.smartAccount && (plan.mode === 'smart-account' || plan.smartAccountXMoney > 0n) && (
            <span className="text-slate-500" title={plan.smartAccount}>xGas account {short(plan.smartAccount)} holds {fmt(plan.smartAccountXMoney)} xMoney</span>
          )}
          <button onClick={() => { void refresh(); }} className="ml-auto p-1 rounded-md text-slate-500 hover:text-white cursor-pointer" title="Recheck gas">
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {plan && <div className="text-slate-400">{plan.reason}</div>}
        {error && <div className="text-rose-400">{error}</div>}

        {showXgasDetails && pos && (
          <div className="flex flex-col gap-1.5">
            <div>
              {plan!.xgasDevEstimate != null
                ? <>About <span className="text-white">{fmt(plan!.xgasDevEstimate, 4)} XGAS.DEV</span> per transaction at the live pool price plus a {(st!.bufferBps / 100).toFixed(0)}% buffer. You are charged for the gas actually used, never above the cap you confirm.</>
                : <>XGAS.DEV gas is priced from the live Robinhood pool when you send.</>}
            </div>
            <div className="flex items-center gap-1.5 text-amber-300/90">
              <Flame className="w-3 h-3 shrink-0" />
              <span>XGAS.DEV spent on gas is burned: the relayer sends it to 0x...dEaD on Robinhood Chain.</span>
            </div>
            <div className="text-slate-500">
              Robinhood: {fmt(pos.balance, 2)} XGAS.DEV held, {fmt(pos.allowance, 2)} approved for gas, {fmt(pos.robinhoodEth, 6)} ETH.
            </div>
            {(plan!.needsApproval || plan!.needsDrip) && (
              <div className="flex flex-wrap items-center gap-2">
                {plan!.needsDrip && (
                  <button onClick={doDrip} disabled={busy !== null}
                    className="px-2.5 py-1 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-cyan-200 font-bold disabled:opacity-40 cursor-pointer">
                    {busy === 'drip' ? 'Sending...' : 'Get Robinhood gas'}
                  </button>
                )}
                {plan!.needsApproval && (
                  <button onClick={doApprove} disabled={busy !== null || plan!.needsDrip}
                    className="px-2.5 py-1 rounded-lg bg-fuchsia-500/15 hover:bg-fuchsia-500/25 border border-fuchsia-500/40 text-fuchsia-200 font-bold disabled:opacity-40 cursor-pointer">
                    {busy === 'approve' ? 'Approving...' : 'Approve XGAS.DEV for gas'}
                  </button>
                )}
                <span className="text-slate-500">
                  {plan!.needsDrip
                    ? 'One-time: a small ETH drip (Sign in with X) pays for the approval on Robinhood.'
                    : 'One-time approval on Robinhood, capped, never unlimited.'}
                </span>
              </div>
            )}
          </div>
        )}

        {mode === 'none' && plan && (!pos || pos.balance === 0n) && (
          <div className="text-slate-500">
            Get gas: bridge USDG into xMoney with Enter above{st?.live ? ', or hold XGAS.DEV on Robinhood Chain and pay L4 gas with it' : ''}.
          </div>
        )}

        {last && (last.mode === 'wallet-paymaster' || last.mode === 'smart-account') && (
          <div className="text-slate-500">
            Last transaction paid in XGAS.DEV{last.maxCharge != null ? `, capped at ${fmt(last.maxCharge, 4)}` : ''} ({short(last.txHash)}). The charge is burned from your Robinhood balance shortly after it lands.
          </div>
        )}
        {note && <div className="text-cyan-200 break-words">{note}</div>}
      </div>

      {pending && (
        <div className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => answer(false)}>
          <div className="w-full max-w-md rounded-2xl bg-[#0b0e17] border border-fuchsia-500/40 p-4 font-mono text-xs text-slate-300 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2 font-black text-white text-sm font-display">
                <Fuel className="w-4 h-4 text-fuchsia-300" /> Pay L4 gas in XGAS.DEV
              </div>
              <button onClick={() => answer(false)} className="text-slate-500 hover:text-white cursor-pointer"><X className="w-4 h-4" /></button>
            </div>
            <ul className="flex flex-col gap-2 list-none">
              {describeGasConfirm(pending.req).map((l, i) => <li key={i} className="leading-relaxed">{l}</li>)}
            </ul>
            <div className="flex gap-2 mt-4">
              <button onClick={() => answer(false)} className="flex-1 px-3 py-2 rounded-xl bg-[#121624] border border-[#1e2538] text-slate-300 font-bold cursor-pointer">Cancel</button>
              <button onClick={() => answer(true)} className="flex-1 px-3 py-2 rounded-xl bg-fuchsia-500 hover:bg-fuchsia-400 text-slate-950 font-black cursor-pointer">Continue</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
