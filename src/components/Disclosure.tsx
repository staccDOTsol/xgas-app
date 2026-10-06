import React from 'react';
import { ChevronRight } from 'lucide-react';

/**
 * Small "how it works" disclosure. Native <details>/<summary>, so it is keyboard and screen-reader
 * accessible with no extra state. Collapsed by default: the one sentence a user needs stays visible,
 * the mechanics live in here.
 */
export function Disclosure({
  label,
  children,
  className = '',
  defaultOpen = false,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  defaultOpen?: boolean;
}) {
  return (
    <details className={`group ${className}`} open={defaultOpen || undefined}>
      <summary className="list-none cursor-pointer select-none inline-flex items-center gap-1 text-[11px] font-mono text-slate-500 hover:text-slate-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 rounded [&::-webkit-details-marker]:hidden">
        <ChevronRight className="w-3 h-3 transition-transform group-open:rotate-90" aria-hidden="true" />
        <span>{label}</span>
      </summary>
      <div className="mt-2 text-[11px] leading-relaxed text-slate-400 font-sans space-y-2">{children}</div>
    </details>
  );
}
