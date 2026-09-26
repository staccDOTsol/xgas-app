import React, { useState } from 'react';
import { Copy, Check, ArrowDown } from 'lucide-react';

// XGAS.DEV token on Robinhood Chain (#4663).
const XGAS_TOKEN = '0x006D2D9e65f847e8B5f5053C9eb3a7824ec7dFa3';

export function Hero() {
  const [copied, setCopied] = useState(false);

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
      </div>
    </section>
  );
}
