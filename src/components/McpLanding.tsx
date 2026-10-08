import { useState } from 'react';
import { ArrowRight, Check, Copy, Terminal } from 'lucide-react';

type Client = 'codex' | 'claude' | 'chatgpt' | 'grok' | 'cursor' | 'other';

const CODEX_COMMAND = 'codex mcp add xgas -- npx -y xgas-mcp';
const OTHER_CONFIG = `{
  "mcpServers": {
    "xgas": {
      "command": "npx",
      "args": ["-y", "xgas-mcp"]
    }
  }
}`;
const REMOTE_URL = 'https://xgas.dev/mcp';
const CLIENTS: Client[] = ['codex', 'claude', 'chatgpt', 'grok', 'cursor', 'other'];
const SETUP: Record<Client, { name: string; value: string; where: string; format: string; button: string; next: string }> = {
  codex: {
    name: 'Codex', value: CODEX_COMMAND, where: 'Paste in your terminal', format: 'Command',
    button: 'Copy install command', next: 'Run once, then restart Codex.',
  },
  claude: {
    name: 'Claude', value: REMOTE_URL, where: 'Customize → Connectors → Add custom connector', format: 'Server URL',
    button: 'Copy server URL', next: 'Add the connector, then enable it in chat.',
  },
  chatgpt: {
    name: 'ChatGPT', value: REMOTE_URL, where: 'Settings → Apps → Create', format: 'Server URL',
    button: 'Copy server URL', next: 'Enable developer mode first. Write tools require a supported workspace plan.',
  },
  grok: {
    name: 'Grok', value: REMOTE_URL, where: 'grok.com/connectors → New Connector → Custom', format: 'Server URL',
    button: 'Copy server URL', next: 'Add the connector, then use it in Grok.',
  },
  cursor: {
    name: 'Cursor', value: OTHER_CONFIG, where: 'Paste in ~/.cursor/mcp.json', format: 'JSON',
    button: 'Copy MCP config', next: 'Save the file, then restart Cursor.',
  },
  other: {
    name: 'Other MCP', value: OTHER_CONFIG, where: 'Paste in your app’s MCP settings', format: 'JSON',
    button: 'Copy MCP config', next: 'Save your settings, then restart your AI app.',
  },
};

export function McpLanding() {
  const [client, setClient] = useState<Client>('codex');
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied(current => current === label ? null : current), 2000);
    } catch {
      setCopied('failed');
    }
  }

  const setup = SETUP[client];

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#080d10] text-[#ecf7f1]">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_60%_45%_at_76%_30%,rgba(34,197,94,0.12),transparent_75%)]" />
      <div className="relative mx-auto flex min-h-screen max-w-6xl flex-col px-5 sm:px-8">
        <header className="flex items-center justify-between border-b border-white/10 py-5">
          <a href="/" className="flex items-center gap-3 font-display text-xl font-bold tracking-tight text-white" aria-label="xgas home">
            <img src="/favicon.svg" alt="" className="h-8 w-8" />
            xgas<span className="text-emerald-400">.</span>
          </a>
          <a href="/otc" className="group inline-flex items-center gap-2 text-sm font-semibold text-slate-300 transition-colors hover:text-white">
            Open app <ArrowRight aria-hidden="true" className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </a>
        </header>

        <main className="grid flex-1 items-center gap-12 py-12 md:grid-cols-[0.9fr_1.1fr] md:gap-16 md:py-20">
          <section className="max-w-lg">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              xgas MCP
            </div>
            <h1 className="font-display text-5xl font-bold leading-[1.06] tracking-[-0.055em] text-white sm:text-6xl lg:text-7xl">
              Add xgas<br />to your AI<span className="text-emerald-400">.</span>
            </h1>
            <p className="mt-6 max-w-md text-base leading-relaxed text-slate-300 sm:text-lg">
              Ask about X Money and Robinhood Chain. Prepare transactions in plain English. Your wallet signs.
            </p>
            <div className="mt-9 flex flex-wrap gap-x-6 gap-y-3 text-xs font-semibold uppercase tracking-widest text-slate-400">
              <span>01&nbsp; Ask</span><span>02&nbsp; Prepare</span><span>03&nbsp; Sign</span>
            </div>
          </section>

          <section aria-labelledby="install-title" className="overflow-hidden rounded-3xl border border-emerald-300/25 bg-[#101a1b] shadow-[0_20px_80px_rgba(0,0,0,0.32)]">
            <div className="border-b border-white/10 px-5 py-5 sm:px-7">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-400/15 text-emerald-300"><Terminal aria-hidden="true" className="h-5 w-5" /></div>
                <div>
                  <h2 id="install-title" className="font-display text-xl font-bold text-white">Install the MCP</h2>
                  <p className="text-xs text-slate-400">Choose your AI app. Copy. Paste.</p>
                </div>
              </div>
            </div>

            <div className="p-5 sm:p-7">
              <div className="mb-4 flex flex-wrap gap-1.5" role="group" aria-label="Choose an AI app">
                {CLIENTS.map(key => (
                  <button key={key} type="button" onClick={() => { setClient(key); setCopied(null); }} aria-pressed={client === key}
                    className={`rounded-lg border px-3 py-2 text-xs font-semibold transition-colors sm:text-sm ${client === key ? 'border-emerald-400 bg-emerald-400 text-[#071411]' : 'border-white/10 bg-black/25 text-slate-300 hover:border-white/25 hover:text-white'}`}>
                    {SETUP[key].name}
                  </button>
                ))}
              </div>

              <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#080e10]">
                <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 text-[11px] font-semibold uppercase tracking-widest text-slate-500">
                  <span>{setup.where}</span>
                  <span className="shrink-0 pl-3">{setup.format}</span>
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words px-4 py-5 text-sm leading-relaxed text-emerald-200 sm:text-base"><code>{setup.value}</code></pre>
              </div>

              <button type="button" onClick={() => copy(setup.value, 'setup')} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-400 px-5 py-3.5 text-sm font-bold text-[#071411] transition-colors hover:bg-emerald-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300">
                {copied === 'setup' ? <Check aria-hidden="true" className="h-4 w-4" /> : <Copy aria-hidden="true" className="h-4 w-4" />}
                {copied === 'setup' ? 'Copied' : setup.button}
              </button>
              <p className="mt-3 text-center text-xs text-slate-400">{setup.next}</p>
              <span aria-live="polite" className="sr-only">{copied === 'failed' ? 'Copy failed. Select and copy the text manually.' : copied ? 'Copied to clipboard.' : ''}</span>
            </div>
          </section>
        </main>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 py-5 text-xs text-slate-500">
          <span>Try asking: “What can I do with X Money?”</span>
          <a href="https://www.npmjs.com/package/xgas-mcp" target="_blank" rel="noreferrer" className="hover:text-slate-300">View package ↗</a>
        </footer>
      </div>
    </div>
  );
}
