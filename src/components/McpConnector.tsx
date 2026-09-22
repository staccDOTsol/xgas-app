import React, { useEffect, useMemo, useState } from 'react';
import { Terminal, Copy, Check, Search, KeyRound, Zap, Globe, ArrowRight, Wallet, RefreshCw, PartyPopper, Link2 } from 'lucide-react';

/**
 * The connector, front and centre: this chain is mostly used by models, so the landing page is the
 * "add this server" screen. Everything below is read live from /api/mcp, the tool list is the one
 * the server actually serves, never a list typed into a page.
 */
interface McpTool { name: string; description: string; kind: 'read' | 'prepare' | 'submit' }
interface McpInfo { name: string; version: string; transport: { http: string; stdio: string }; npm: string; tool_count: number; tools: McpTool[] }

const KIND_COPY: Record<McpTool['kind'], { label: string; hint: string; cls: string }> = {
  read: { label: 'read', hint: 'answers a question, touches nothing', cls: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' },
  prepare: { label: 'prepare', hint: 'builds an unsigned transaction and the terms you are agreeing to', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  submit: { label: 'submit', hint: 'relays what your wallet already signed', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
};

const PROMPTS = [
  'Send 0.01 ETH to my Base address and pay for it in X Money.',
  'What is the vault NAV, and what would 100 USDG get me in $xMoney?',
  'Sell this NFT on ApeChain for at least 5 X Money.',
  'Show me the OTC book and post an ask at $1.00.',
  'Has anyone bid on my swap yet, and what is it costing me?',
];

const CopyLine: React.FC<{ text: string; label?: string; mono?: boolean }> = ({ text, label, mono = true }) => {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1400); }); }}
      className="group w-full flex items-center gap-3 px-3 py-2.5 rounded-xl bg-[#0b0e17] border border-[#1e2538] hover:border-emerald-500/40 text-left cursor-pointer transition-colors"
      title="Copy"
    >
      <div className="min-w-0 flex-1">
        {label && <div className="text-[10px] uppercase font-black tracking-wide text-slate-500 mb-0.5">{label}</div>}
        <div className={`${mono ? 'font-mono' : ''} text-xs sm:text-sm text-slate-200 truncate`}>{text}</div>
      </div>
      {done ? <Check className="w-4 h-4 text-emerald-400 shrink-0" /> : <Copy className="w-4 h-4 text-slate-500 group-hover:text-emerald-400 shrink-0" />}
    </button>
  );
};

interface XUser { id: string; handle: string; name?: string; avatar?: string }
interface WalletState { configured: boolean; wallet: { address: string; id: string; source: string } | null; balances?: { xgas_native_xmoney: string; parent_usdg: string; parent_xmoney: string } }

/**
 * The part a person actually came back for. Signing in with X and landing on an identical page is how
 * people end up asking whether it worked, so this says it worked, and shows the address it made for them.
 */
/**
 * A model is not a browser and has no cookie. This mints a token that carries only this person's X id,
 * so their agent can reach their wallet from any host, and nobody else's.
 */
const ConnectAModel: React.FC<{ handle: string }> = ({ handle }) => {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);

  const mint = async () => {
    setBusy(true);
    const r = await fetch('/api/connector/token', { method: 'POST', credentials: 'same-origin' }).then(res => res.json()).catch(() => null);
    setToken(r?.token ?? null);
    setBusy(false);
  };

  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://xgas.dev';
  const config = token
    ? JSON.stringify({ mcpServers: { xgas: { url: `${origin}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)
    : '';

  return (
    <div className="mt-4 pt-4 border-t border-[#1e2538]">
      <div className="flex items-center gap-2 mb-2">
        <Link2 className="w-3.5 h-3.5 text-cyan-400" />
        <span className="text-[11px] uppercase font-black tracking-widest text-cyan-300 font-mono">connect a model to this wallet</span>
      </div>
      {!token ? (
        <>
          <p className="text-xs text-slate-400 mb-3">
            Your browser has a session; a model somewhere else does not. Mint a token and paste it into your host,
            and that model acts as @{handle} on this wallet, nothing more.
          </p>
          <button onClick={mint} disabled={busy}
            className="px-4 py-2 rounded-xl bg-[#121624] border border-cyan-500/40 text-cyan-300 text-xs font-black font-mono flex items-center gap-2 cursor-pointer hover:bg-[#1a2033]">
            {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />} {busy ? 'minting…' : 'Mint my connector token'}
          </button>
        </>
      ) : (
        <>
          <p className="text-xs text-slate-400 mb-2">
            Paste this into your MCP host. Treat it like a key: anyone holding it can spend this wallet, and it lasts 180 days.
          </p>
          <CopyLine label="host config" text={config} mono />
          <button onClick={() => setShown(v => !v)} className="mt-2 text-[11px] font-mono text-slate-500 hover:text-slate-300 cursor-pointer">
            {shown ? 'hide the raw token' : 'show the raw token'}
          </button>
          {shown && <div className="mt-1"><CopyLine label="token" text={token} /></div>}
        </>
      )}
    </div>
  );
};

const YourWallet: React.FC = () => {
  const [user, setUser] = useState<XUser | null>(null);
  const [configured, setConfigured] = useState(false);
  const [state, setState] = useState<WalletState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const justSignedIn = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('xauth') === 'ok';

  const load = React.useCallback(async () => {
    setLoading(true);
    const me = await fetch('/api/me', { credentials: 'same-origin' }).then(r => r.json()).catch(() => null);
    setConfigured(!!me?.configured);
    setUser(me?.user ?? null);
    if (!me?.user) { setState(null); setLoading(false); return; }
    const w = await fetch('/api/connector/wallet_status', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(r => r.json()).catch(() => null);
    setState(w?.data ?? null);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  // The address exists the moment they ask for it; nobody should have to go and find it.
  const create = async () => {
    setBusy(true); setErr(null);
    const r = await fetch('/api/connector/wallet_create', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(res => res.json()).catch(() => null);
    if (r?.error) setErr(r.error);
    await load();
    setBusy(false);
  };

  if (!configured) return null;

  if (!user) {
    return (
      <section className="rounded-2xl border border-[#1e2538] bg-[#0b0e17] p-4 sm:p-5 flex flex-wrap items-center gap-3">
        <Wallet className="w-4 h-4 text-emerald-400" />
        <div className="text-sm text-slate-300 mr-auto">
          Sign in with X and this connector runs a wallet of your own. Nothing to install, nothing to paste.
        </div>
        <a href={`/auth/x/login?returnTo=${encodeURIComponent('/')}`}
          className="px-4 py-2 rounded-xl bg-white text-black text-xs font-black font-mono flex items-center gap-2 hover:bg-slate-200">
          <span className="font-black">𝕏</span> Sign in with X
        </a>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {justSignedIn && <PartyPopper className="w-4 h-4 text-emerald-400" />}
        <span className="text-[11px] uppercase font-black tracking-widest text-emerald-300 font-mono">
          {justSignedIn ? `thanks for connecting, @${user.handle}` : `signed in as @${user.handle}`}
        </span>
        <button onClick={load} className="ml-auto p-1.5 rounded-lg bg-[#121624] border border-[#1e2538] text-slate-400 hover:text-white cursor-pointer" title="Refresh">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {loading ? (
        <div className="text-xs font-mono text-slate-500 flex items-center gap-2"><RefreshCw className="w-3.5 h-3.5 animate-spin" /> reading your wallet…</div>
      ) : !state?.configured ? (
        <div className="text-xs font-mono text-slate-400">Wallets are not switched on for this host yet.</div>
      ) : state.wallet ? (
        <>
          <p className="text-xs text-slate-400 mb-2">This is your wallet on this connector. It is yours alone, and it signs when you ask a model to do something here.</p>
          <CopyLine label="your address" text={state.wallet.address} />
          {state.balances && (
            <div className="mt-2 grid gap-1.5 sm:grid-cols-3 text-[11px] font-mono">
              <div className="px-3 py-2 rounded-xl bg-[#0b0e17] border border-[#1e2538]"><span className="text-slate-500">xGas L4</span><br /><span className="text-slate-200">{state.balances.xgas_native_xmoney} $xMoney</span></div>
              <div className="px-3 py-2 rounded-xl bg-[#0b0e17] border border-[#1e2538]"><span className="text-slate-500">parent USDG</span><br /><span className="text-slate-200">{state.balances.parent_usdg}</span></div>
              <div className="px-3 py-2 rounded-xl bg-[#0b0e17] border border-[#1e2538]"><span className="text-slate-500">parent xMoney</span><br /><span className="text-slate-200">{state.balances.parent_xmoney}</span></div>
            </div>
          )}
          <p className="mt-2 text-[11px] text-slate-500">Send it a little $xMoney on L4 for gas and it can start doing things. It holds what you put in it and no more.</p>
          <ConnectAModel handle={user.handle} />
        </>
      ) : (
        <>
          <p className="text-xs text-slate-400 mb-3">You do not have a wallet here yet. Make one and its address appears right below, ready to fund.</p>
          <button onClick={create} disabled={busy}
            className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-black font-mono flex items-center gap-2 cursor-pointer disabled:opacity-60">
            {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Wallet className="w-3.5 h-3.5" />} {busy ? 'making it…' : 'Create my wallet'}
          </button>
        </>
      )}
      {err && <div className="mt-2 text-[11px] font-mono text-rose-300">{err}</div>}
    </section>
  );
};

export const McpConnector: React.FC = () => {
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'all' | McpTool['kind']>('all');

  useEffect(() => { fetch('/api/mcp').then(r => r.json()).then(setInfo).catch(() => setInfo(null)); }, []);

  const tools = useMemo(() => {
    const list = info?.tools ?? [];
    const needle = q.trim().toLowerCase();
    return list
      .filter(t => (kind === 'all' ? true : t.kind === kind))
      .filter(t => (needle ? t.name.includes(needle) || t.description.toLowerCase().includes(needle) : true));
  }, [info, q, kind]);

  const counts = useMemo(() => {
    const c = { read: 0, prepare: 0, submit: 0 };
    for (const t of info?.tools ?? []) c[t.kind]++;
    return c;
  }, [info]);

  const hostConfig = JSON.stringify({ mcpServers: { xgas: { command: 'npx', args: ['-y', 'xgas-mcp'] } } }, null, 2);

  return (
    <div className="space-y-5">
      <YourWallet />
      {/* The pitch */}
      <section className="rounded-2xl border border-[#1e2538] bg-gradient-to-b from-[#0d1220] to-[#0b0e17] p-5 sm:p-8">
        <div className="flex items-center gap-2 mb-3">
          <Terminal className="w-4 h-4 text-emerald-400" />
          <span className="text-[11px] uppercase font-black tracking-widest text-emerald-400 font-mono">Model Context Protocol server</span>
          {info && <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-[#121624] border border-[#1e2538] text-slate-400">v{info.version}</span>}
        </div>
        <h1 className="text-2xl sm:text-4xl font-black text-white font-display tracking-tight leading-tight">
          Hand this chain to your model.
        </h1>
        <p className="mt-3 text-sm sm:text-base text-slate-400 max-w-3xl leading-relaxed">
          {info ? info.tool_count : '49'} tools over the whole xGas stack: the USDG vault bridge, the P2P OTC desk, NGU curves, fiat ramps,
          and X Money swaps that land an asset on any of 39 EVM chains. Ask in words; it quotes, it prepares, and your own
          wallet signs. Or sign in with X and it runs a wallet of your own, held by Privy: the one custodial part of this, and
          the one part nobody reaches without being signed in as you.
        </p>

        <div className="mt-6 grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
            <div className="flex items-center gap-2 mb-2"><Globe className="w-4 h-4 text-emerald-400" /><span className="text-xs font-black uppercase tracking-wide text-emerald-300 font-mono">Hosted, nothing to install</span></div>
            <p className="text-xs text-slate-400 mb-3">Add it as a remote MCP server in any host that speaks Streamable HTTP.</p>
            <CopyLine text={info?.transport.http ?? 'https://xgas.dev/mcp'} />
          </div>
          <div className="rounded-xl border border-[#1e2538] bg-[#0b0e17]/60 p-4">
            <div className="flex items-center gap-2 mb-2"><Terminal className="w-4 h-4 text-cyan-400" /><span className="text-xs font-black uppercase tracking-wide text-cyan-300 font-mono">Or run it yourself, over stdio</span></div>
            <p className="text-xs text-slate-400 mb-3">
              Published on npm as <a className="text-cyan-300 underline" href={info?.npm ?? 'https://www.npmjs.com/package/xgas-mcp'} target="_blank" rel="noreferrer">xgas-mcp</a>.
            </p>
            <CopyLine text={info?.transport.stdio ?? 'npx -y xgas-mcp'} />
          </div>
        </div>

        <details className="mt-3 group">
          <summary className="cursor-pointer text-xs font-mono text-slate-500 hover:text-slate-300 select-none">host config (claude_desktop_config.json, .mcp.json, …)</summary>
          <pre className="mt-2 p-3 rounded-xl bg-[#0b0e17] border border-[#1e2538] text-[11px] font-mono text-slate-300 overflow-x-auto">{hostConfig}</pre>
        </details>
      </section>

      {/* What "non-custodial" actually means here */}
      <section className="grid gap-3 md:grid-cols-3">
        {[
          { icon: <Search className="w-4 h-4 text-cyan-400" />, head: '1 · it reads', body: 'Balances, NAV, the order book, your open swaps, a solver\'s record. Straight off the chains, no index in between.' },
          { icon: <KeyRound className="w-4 h-4 text-emerald-400" />, head: '2 · it prepares', body: 'Every write comes back unsigned, with the exact amounts, every fee, the net, the timeline and what cannot be undone. Your wallet signs it, or nothing happens.' },
          { icon: <Zap className="w-4 h-4 text-amber-400" />, head: '3 · it relays', body: 'Signed transactions go out with an idempotency key, so a retry returns the first hash instead of sending twice. An agent with no browser can let its own Privy wallet sign that step, if you have given it one.' },
        ].map(c => (
          <div key={c.head} className="rounded-2xl border border-[#1e2538] bg-[#0b0e17] p-4">
            <div className="flex items-center gap-2 mb-2">{c.icon}<span className="text-xs font-black uppercase tracking-wide text-slate-300 font-mono">{c.head}</span></div>
            <p className="text-xs text-slate-400 leading-relaxed">{c.body}</p>
          </div>
        ))}
      </section>

      {/* Say this to it */}
      <section className="rounded-2xl border border-[#1e2538] bg-[#0b0e17] p-4 sm:p-5">
        <div className="text-[11px] uppercase font-black tracking-widest text-slate-500 font-mono mb-3">say this to it</div>
        <div className="grid gap-2 sm:grid-cols-2">
          {PROMPTS.map(p => (
            <div key={p} className="flex items-start gap-2 px-3 py-2 rounded-xl bg-[#0d1220] border border-[#1e2538]">
              <ArrowRight className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" />
              <span className="text-xs text-slate-300 leading-relaxed">{p}</span>
            </div>
          ))}
        </div>
      </section>

      {/* The live tool list */}
      <section className="rounded-2xl border border-[#1e2538] bg-[#0b0e17] p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <div className="text-[11px] uppercase font-black tracking-widest text-slate-500 font-mono mr-auto">
            the tools, as the server serves them {info && <span className="text-slate-600">· {info.tool_count}</span>}
          </div>
          <div className="flex items-center gap-1.5">
            {(['all', 'read', 'prepare', 'submit'] as const).map(k => (
              <button key={k} onClick={() => setKind(k)}
                className={`px-2.5 py-1 rounded-lg text-[10px] font-black uppercase font-mono tracking-wide cursor-pointer border transition-colors ${
                  kind === k ? 'bg-emerald-500 text-slate-950 border-emerald-500' : 'bg-[#121624] border-[#1e2538] text-slate-400 hover:text-white'}`}>
                {k}{k !== 'all' && info ? ` ${counts[k]}` : ''}
              </button>
            ))}
          </div>
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="filter"
              className="pl-8 pr-3 py-1.5 rounded-lg bg-[#121624] border border-[#1e2538] text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500/40 w-32 sm:w-44" />
          </div>
        </div>

        {!info ? (
          <div className="text-xs font-mono text-slate-500">reading /api/mcp…</div>
        ) : (
          <div className="grid gap-1.5 sm:grid-cols-2">
            {tools.map(t => (
              <div key={t.name} className="px-3 py-2.5 rounded-xl bg-[#0d1220] border border-[#1e2538] hover:border-[#2a3350] transition-colors">
                <div className="flex items-center gap-2 mb-1">
                  <code className="text-xs font-mono font-bold text-white">{t.name}</code>
                  <span className={`px-1.5 py-0.5 rounded text-[9px] font-black uppercase font-mono border ${KIND_COPY[t.kind].cls}`} title={KIND_COPY[t.kind].hint}>
                    {KIND_COPY[t.kind].label}
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">{t.description}</p>
              </div>
            ))}
            {tools.length === 0 && <div className="text-xs font-mono text-slate-500">nothing matches "{q}".</div>}
          </div>
        )}
      </section>

      <p className="text-[11px] font-mono text-slate-600 px-1">
        The hosted endpoint serves everything except the one tool that would spend this host's own gas. Same code either way:
        one tool set, served over stdio and over HTTP.
      </p>
    </div>
  );
};

export default McpConnector;
