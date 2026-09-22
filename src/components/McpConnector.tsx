import React, { useEffect, useMemo, useState } from 'react';
import { Terminal, Copy, Check, Search, KeyRound, Zap, Globe, ArrowRight } from 'lucide-react';

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
          wallet signs. Give it Privy credentials and it can run an agent wallet of its own instead, which is the one part
          of this that is custodial, and the one part a public URL will not hand out without a token.
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
