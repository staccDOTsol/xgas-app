import React, { useEffect, useState } from 'react';
import { Copy, Check, ArrowDown, Flame, FileText } from 'lucide-react';

// XGAS.DEV token on Robinhood Chain (#4663).
const XGAS_TOKEN = '0x006D2D9e65f847e8B5f5053C9eb3a7824ec7dFa3';
// The litepaper: what xgas is, what's broken, and what gets fixed first.
const LITEPAPER_URL = 'https://gist.github.com/staccDOTsol/e16868983742577cdee1eee90c5bc8bb';

type BuybackStats = { live: boolean; xgasBurned?: string };

export function Hero() {
  const [copied, setCopied] = useState(false);
  const [burned, setBurned] = useState<number | null>(null);

  // 0.02% of every xgas fee buys XGAS.DEV and burns it; show the running total once the flywheel is live.
  useEffect(() => {
    let alive = true;
    const load = () => fetch('/api/buyback').then(r => (r.ok ? r.json() : null)).then((b: BuybackStats | null) => {
      if (alive && b?.live && b.xgasBurned !== undefined) setBurned(Number(b.xgasBurned));
    }).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(XGAS_TOKEN);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  };

  return (
    <section className="relative overflow-hidden rounded-3xl border border-[#1b2338] bg-[#0b0e17] px-5 py-10 sm:px-10 sm:py-16 mb-5">
      <div className="pointer-events-none absolute -top-32 -right-24 w-[28rem] h-[28rem] rounded-full bg-emerald-500/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 -left-20 w-[24rem] h-[24rem] rounded-full bg-cyan-500/10 blur-3xl" />

      <div className="relative max-w-3xl">
        <p className="font-mono text-xs sm:text-sm uppercase tracking-[0.25em] text-emerald-400">you know what it is</p>

        <button
          onClick={copy}
          className="group mt-3 flex max-w-full items-center gap-2 rounded-xl border border-[#1e2538] bg-[#121624] px-3 py-2 font-mono text-[11px] sm:text-sm text-slate-300 hover:border-emerald-500/50 hover:text-white transition-colors cursor-pointer"
          title="Copy the XGAS.DEV token address (Robinhood Chain)"
        >
          <span className="truncate">{XGAS_TOKEN}</span>
          {copied ? <Check className="w-4 h-4 shrink-0 text-emerald-400" /> : <Copy className="w-4 h-4 shrink-0 text-slate-500 group-hover:text-emerald-400" />}
        </button>

        {burned !== null && (
          <p className="mt-2 flex items-center gap-1.5 font-mono text-[11px] sm:text-xs text-slate-500" title="0.02% of every fee on the new xgas contracts is routed to buy XGAS.DEV on Robinhood Chain and burn it; the keeper can also seed it with ETH">
            <Flame className="w-3.5 h-3.5 text-orange-400" />
            <span className="text-orange-300">{burned.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span> XGAS.DEV bought &amp; burned by the xgas flywheel
          </p>
        )}

        <h1 className="mt-8 font-display font-black tracking-tight text-white text-4xl sm:text-6xl leading-[1.02]">
          but seriously, xgas.dev is <span className="whitespace-nowrap text-emerald-400">rl tekk</span>
          <br />
          <span className="text-slate-400">and useful.</span>
        </h1>

        <p className="mt-6 text-base sm:text-lg text-slate-400 max-w-xl">
          look behind the marketing. click. play around. <span className="text-cyan-300 font-semibold">ouuu.</span>
        </p>

        <a
          href="#play"
          className="mt-8 inline-flex items-center gap-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 px-5 py-3 text-sm font-black font-mono uppercase tracking-wide text-slate-950 shadow-lg shadow-emerald-500/20 transition-colors"
        >
          play around <ArrowDown className="w-4 h-4" />
        </a>
        <a
          href={LITEPAPER_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-8 ml-3 inline-flex items-center gap-2 rounded-xl border border-[#1e2538] bg-[#121624] hover:border-emerald-500/50 px-5 py-3 text-sm font-black font-mono uppercase tracking-wide text-slate-300 hover:text-white transition-colors"
        >
          litepaper <FileText className="w-4 h-4" />
        </a>
      </div>
    </section>
  );
}
