import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle, Landmark, RefreshCw, Search, Unlink } from 'lucide-react';

// ---------------------------------------------------------------------------
// Plaid on a Robinhood desk trade: a party links the account their X Money dollars move through, and the host
// looks in it for this trade's payment (exact amount, right direction, memo "xgas #id"). Read-only: it never moves
// money and never releases or claims; the seller still releases, and a dispute still goes to the arbiters, who can
// get a receipt the host wrote from Plaid's data. Renders nothing when the host has no Plaid keys.
// ---------------------------------------------------------------------------

interface PlaidItem { id: string; institution: string; accounts: { mask: string | null; name: string; subtype: string | null }[]; linkedAt: number; needsRelink: boolean }
interface PlaidInfo { configured: boolean; env: string | null; signedIn: boolean; items: PlaidItem[] }
interface PlaidMatch {
  date: string; amount: string; direction: 'in' | 'out'; pending: boolean; description: string;
  memo: boolean; handle: boolean; strength: 'strong' | 'medium' | 'weak'; institution: string; mask: string | null; alreadyUsedFor: string | null;
}
interface PlaidResult {
  tradeId: string; side: 'buyer' | 'seller'; amount: string; direction: 'in' | 'out'; memo: string; counterparty: string;
  window: { from: string; to: string }; env: string; found: boolean; refreshed: boolean;
  checked: { institution: string; accounts: number; status: string | null; error?: string; needsRelink?: boolean }[];
  matches: PlaidMatch[];
}

declare global {
  interface Window {
    Plaid?: { create: (cfg: Record<string, unknown>) => { open: () => void; exit: (o?: unknown) => void; destroy: () => void } };
  }
}

const LINK_SCRIPT = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
const TOKEN_KEY = 'xgas_plaid_link_token';

// One /api/plaid read shared by every trade card on the page.
let infoPromise: Promise<PlaidInfo> | null = null;
const infoListeners = new Set<(i: PlaidInfo) => void>();
function loadInfo(force = false): Promise<PlaidInfo> {
  if (!infoPromise || force) {
    infoPromise = fetch('/api/plaid', { credentials: 'same-origin' })
      .then(r => r.json())
      .then((i: PlaidInfo) => { infoListeners.forEach(fn => fn(i)); return i; })
      .catch(() => ({ configured: false, env: null, signedIn: false, items: [] }));
  }
  return infoPromise;
}
function usePlaidInfo(): [PlaidInfo | null, () => Promise<PlaidInfo>] {
  const [info, setInfo] = useState<PlaidInfo | null>(null);
  useEffect(() => {
    infoListeners.add(setInfo);
    loadInfo().then(setInfo);
    return () => { infoListeners.delete(setInfo); };
  }, []);
  return [info, useCallback(() => loadInfo(true), [])];
}

let scriptPromise: Promise<void> | null = null;
function loadLinkScript(): Promise<void> {
  if (window.Plaid) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = LINK_SCRIPT;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { scriptPromise = null; reject(new Error('Could not load Plaid Link. A content blocker may be stopping cdn.plaid.com.')); };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `The host answered ${r.status}.`);
  return j as T;
}

/** Opens Plaid Link with a token; resolves true once the new account is stored on the host, false if closed. */
async function runLink(token: string, receivedRedirectUri?: string): Promise<boolean> {
  await loadLinkScript();
  return new Promise((resolve, reject) => {
    const handler = window.Plaid!.create({
      token,
      ...(receivedRedirectUri ? { receivedRedirectUri } : {}),
      onSuccess: (publicToken: string) => {
        postJson('/api/plaid/exchange', { public_token: publicToken })
          .then(() => resolve(true), reject)
          .finally(() => { try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage off */ } handler.destroy(); });
      },
      onExit: (err: { display_message?: string; error_message?: string } | null) => {
        handler.destroy();
        if (err) reject(new Error(err.display_message || err.error_message || 'Plaid Link closed with an error.'));
        else resolve(false);
      },
    });
    handler.open();
  });
}

// OAuth banks send the browser away and back with ?oauth_state_id=...; finish that link once per page load.
let oauthResumed = false;
function resumeOauth(onDone: () => void) {
  if (oauthResumed) return;
  oauthResumed = true;
  if (!new URLSearchParams(window.location.search).has('oauth_state_id')) return;
  let token: string | null = null;
  try { token = sessionStorage.getItem(TOKEN_KEY); } catch { /* storage off */ }
  if (!token) return;
  runLink(token, window.location.href).then(onDone).catch(() => { /* the user can link again */ });
}

const btn = 'px-3 py-2 rounded-xl text-xs font-black font-mono uppercase tracking-wide cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const btnPrimary = `${btn} bg-cyan-400 hover:bg-cyan-300 text-slate-950`;
const btnGhost = `${btn} bg-[#121624] border border-[#1e2538] text-slate-300 hover:text-white`;
const cleanHandle = (h: string) => h.replace(/^@/, '').trim().toLowerCase();

interface PlaidCheckProps {
  tradeId: number;
  side: 'buyer' | 'seller';
  /** The handle signed in with X on this page ('' when signed out). */
  xHandle: string;
  /** This side's handle on the trade; only that X account can check. */
  partyHandle: string;
  counterparty: string;
  dollars: string;
  disputed: boolean;
  busy: boolean;
  /** False once this address has used up its evidence slots on the dispute. */
  canPublish: boolean;
  /** Submits a receipt link to the arbiters on-chain. */
  onPublish: (uri: string) => unknown;
}

export const PlaidCheck: React.FC<PlaidCheckProps> = ({ tradeId, side, xHandle, partyHandle, counterparty, dollars, disputed, busy, canPublish, onPublish }) => {
  const [info, reload] = usePlaidInfo();
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PlaidResult | null>(null);

  useEffect(() => { if (info?.configured) resumeOauth(() => { reload(); }); }, [info?.configured, reload]);

  if (!info?.configured) return null;
  const sandbox = info.env !== 'production';
  const signedInAsParty = !!xHandle && cleanHandle(xHandle) === cleanHandle(partyHandle);
  const dir = side === 'seller' ? `into your account from @${cleanHandle(counterparty)}` : `out of your account to @${cleanHandle(counterparty)}`;

  const wrap = (label: string, fn: () => Promise<unknown>) => async () => {
    setWorking(label); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setWorking(null); }
  };
  const link = wrap('Opening Plaid', async () => {
    const { link_token } = await postJson<{ link_token: string }>('/api/plaid/link-token', {});
    try { sessionStorage.setItem(TOKEN_KEY, link_token); } catch { /* OAuth resume just will not work */ }
    if (await runLink(link_token)) await reload();
  });
  const unlink = (id: string, name: string) => wrap('Unlinking', async () => {
    if (!window.confirm(`Unlink ${name}? xgas.dev stops reading it and asks Plaid to drop the connection.`)) return;
    await postJson('/api/plaid/unlink', { item: id });
    setResult(null);
    await reload();
  })();
  const check = wrap('Checking', async () => {
    setResult(await postJson<PlaidResult>('/api/robinhood/plaid-check', { tradeId }));
    await reload();
  });
  const publish = wrap('Writing receipt', async () => {
    if (!window.confirm(`Publish a Plaid receipt for trade #${tradeId}? The host re-checks now and writes what it finds (date, amount, the transaction's description, the last 4 digits of the account). It is public to anyone with the link, then you submit the link to the arbiters in one transaction.`)) return;
    const r = await postJson<{ uri: string }>('/api/robinhood/plaid-receipt', { tradeId });
    await onPublish(r.uri);
  });

  const items = info.items || [];
  const usable = (result?.matches || []).filter(m => !m.alreadyUsedFor);
  const strong = usable.find(m => m.strength === 'strong');

  return (
    <div className="p-3 rounded-xl bg-cyan-500/5 border border-cyan-500/30 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Landmark className="w-3.5 h-3.5 text-cyan-300" />
        <span className="text-[11px] font-bold text-cyan-200">Check the payment with Plaid</span>
        {sandbox && <span className="px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-[9px] text-amber-300 uppercase">Plaid {info.env}: test data</span>}
      </div>

      {!signedInAsParty ? (
        <div className="text-[11px] text-slate-400">
          {xHandle ? `Only @${cleanHandle(partyHandle)} can check this payment; you are signed in as @${cleanHandle(xHandle)}.` : `Sign in with X as @${cleanHandle(partyHandle)} to check this payment against your own account.`}
        </div>
      ) : (
        <>
          <div className="text-[11px] text-slate-300">
            Link the account your X Money dollars move through, and xgas.dev looks for exactly {dollars} {dir} with the memo xgas #{tradeId}. Read-only: it never moves money and never {side === 'seller' ? 'releases for you' : 'claims for you'}. Unlink any time.
          </div>

          {items.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {items.map(it => (
                <span key={it.id} className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[10px] ${it.needsRelink ? 'border-rose-500/40 text-rose-300' : 'border-[#1e2538] text-slate-300'}`}>
                  {it.institution}{it.accounts.length ? ` · ${it.accounts.map(a => a.mask ? `••${a.mask}` : a.name).join(', ')}` : ''}{it.needsRelink ? ' · sign in again' : ''}
                  <button className="text-slate-500 hover:text-rose-300 cursor-pointer" title="Unlink" disabled={!!working} onClick={() => unlink(it.id, it.institution)}><Unlink className="w-3 h-3" /></button>
                </span>
              ))}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {items.length > 0 && (
              <button className={btnPrimary} disabled={!!working || busy} onClick={check}>
                {working === 'Checking' ? <RefreshCw className="w-3.5 h-3.5 inline animate-spin" /> : <Search className="w-3.5 h-3.5 inline" />} Check for {dollars}
              </button>
            )}
            {items.length < 3 && (
              <button className={items.length ? btnGhost : btnPrimary} disabled={!!working || busy} onClick={link}>
                {items.length ? 'Link another account' : 'Link your account (Plaid)'}
              </button>
            )}
            {disputed && items.length > 0 && (
              <button className={btnGhost} disabled={!!working || busy || !canPublish} onClick={publish} title={canPublish ? '' : 'You have used all your evidence slots on this dispute.'}>
                Publish Plaid receipt to arbiters
              </button>
            )}
            {working && working !== 'Checking' && <span className="text-[10px] text-slate-400 self-center">{working}…</span>}
          </div>

          {result && (
            <div className="space-y-1.5">
              {strong ? (
                <div className="flex items-start gap-1.5 text-[11px] text-emerald-300">
                  <CheckCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>
                    Found: {strong.amount} {strong.direction === 'in' ? 'in' : 'out'} on {strong.date}{strong.pending ? ' (pending)' : ''} at {strong.institution}{strong.mask ? ` ••${strong.mask}` : ''}, with the memo.
                    {side === 'seller' ? ' Release when you are satisfied: this check does not release anything.' : ' If the seller disputes, publish this as a receipt.'}
                  </span>
                </div>
              ) : usable.length ? (
                <div className="flex items-start gap-1.5 text-[11px] text-amber-300">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>{usable.length === 1 ? 'A transaction' : `${usable.length} transactions`} of exactly {result.amount} {result.direction}, but without the memo xgas #{tradeId}. It may be this payment or another of the same size.</span>
                </div>
              ) : (
                <div className="flex items-start gap-1.5 text-[11px] text-slate-300">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-slate-400" />
                  <span>
                    Nothing of exactly {result.amount} {result.direction} between {result.window.from} and {result.window.to} yet.
                    {result.refreshed ? ' Asked your bank for fresh transactions; check again in a minute or two.' : ' Banks can take a while to show a transfer; check again shortly.'}
                  </span>
                </div>
              )}
              {usable.map((m, i) => (
                <div key={i} className="text-[10px] text-slate-400 font-mono break-all">
                  {m.strength.toUpperCase()} · {m.date}{m.pending ? ' pending' : ''} · {m.direction} {m.amount} · {m.institution}{m.mask ? ` ••${m.mask}` : ''} · {m.description}
                </div>
              ))}
              {(result.matches || []).filter(m => m.alreadyUsedFor).map((m, i) => (
                <div key={`u${i}`} className="text-[10px] text-slate-500 font-mono">Already matched to trade #{m.alreadyUsedFor}: {m.date} {m.amount}</div>
              ))}
              {result.checked.filter(c => c.error).map((c, i) => (
                <div key={`e${i}`} className="text-[10px] text-rose-300">{c.institution}: {c.error}</div>
              ))}
            </div>
          )}
        </>
      )}
      {error && <div className="text-[11px] text-rose-300">{error}</div>}
    </div>
  );
};
