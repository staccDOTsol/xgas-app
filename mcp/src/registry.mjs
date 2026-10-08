// The tool set, independent of MCP. src/index.mjs serves it over stdio; the app's
// express server serves the read and prepare tools over HTTP. One source of truth
// for quotes, fees and approval copy, whether the caller is a model or the website.
import { tools as chainTools } from './tools/chain.mjs';
import { tools as bridgeTools } from './tools/bridge.mjs';
import { tools as otcTools } from './tools/otc.mjs';
import { tools as nguTools } from './tools/ngu.mjs';
import { tools as fleetNguTools } from './tools/fleetNgu.mjs';
import { tools as rampTools } from './tools/ramps.mjs';
import { tools as walletTools } from './tools/wallet.mjs';
import { tools as xswapTools } from './tools/xswap.mjs';
import { assertChains } from './config.mjs';

/**
 * Tools that prepare, sign or broadcast something. Each one refuses unless the configured RPCs are the
 * deployment's chains (config.checkChains), so a stale RPC cannot turn a prepare into a transaction for
 * the wrong chain. Reads stay available so the problem can be diagnosed.
 */
export const isWriteTool = (name) =>
  /^(prepare_|submit_|post_|take_|release_|reclaim_|cancel_|launch_)/.test(name)
  || ['claim_exit', 'ramp_start', 'wallet_execute'].includes(name);

const guard = (t) => (isWriteTool(t.name)
  ? { ...t, handler: async (args) => { await assertChains(t.name); return t.handler(args); } }
  : t);

export const ALL_TOOLS = [...chainTools, ...bridgeTools, ...otcTools, ...nguTools, ...fleetNguTools, ...rampTools, ...xswapTools, ...walletTools].map(guard);

const seen = new Set();
const dupes = ALL_TOOLS.map((t) => t.name).filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
if (dupes.length) throw new Error(`Duplicate tool names: ${[...new Set(dupes)].join(', ')}`);

export const TOOLS_BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]));

/**
 * Tools the browser may call. Reads and prepares only: a prepared transaction is
 * inert until the user's wallet signs it, and the browser sends through the wallet,
 * so the submit relays stay off the public surface.
 */
export const isBrowserSafe = (name) =>
  !name.startsWith('submit_')
  && name !== 'claim_exit'
  // The wallet tools sign with the agent's Privy key. Exposing them over HTTP would
  // let anyone who can reach the site spend that wallet.
  && !name.startsWith('wallet_');

/** The JSON a caller gets back: readable text plus the structured payload, if any. */
export function unwrap(result) {
  const text = result.content?.[0]?.text ?? '';
  const [summary, ...rest] = text.split('\n```json\n');
  let data;
  if (rest.length) { try { data = JSON.parse(rest.join('\n```json\n').replace(/\n```\s*$/, '')); } catch { /* text only */ } }
  return { summary: summary.trim(), data, isError: !!result.isError };
}
