import {lazy, StrictMode, Suspense} from 'react';
import {createRoot} from 'react-dom/client';
import { McpLanding } from './components/McpLanding.tsx';
import './index.css';

const App = lazy(() => import('./App.tsx'));

// Polyfill BigInt serialization to prevent JSON.stringify crashes on on-chain values
if (typeof BigInt !== 'undefined' && !(BigInt.prototype as any).toJSON) {
  (BigInt.prototype as any).toJSON = function () {
    return this.toString();
  };
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {window.location.pathname === '/' && !new URLSearchParams(window.location.search).has('xauth')
      ? <McpLanding />
      : <Suspense fallback={<div className="p-8 text-slate-400">Loading xgas…</div>}><App /></Suspense>}
  </StrictMode>,
);
