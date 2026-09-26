#!/usr/bin/env node
// xgas-rpc: one JSON-RPC endpoint in front of every Robinhood Chain (4663) RPC we have.
//
// Consumers reach it over Fly's private network at http://xgas-rpc.internal:8545: the xgas-l4 sequencer's inbox
// reader and batch poster, the two BoLD validators, and the site server (viem). A single upstream that 429s, lags or
// has pruned history must not stall them. On 2026-09 the official RPC's 429s stalled deposits for 70 minutes.
// So every request, and every item of a batch, goes to the healthiest upstream that can answer it. It moves on to the
// next upstream when the answer means "this node can't" (429, 5xx, timeout, unknown block, pruned state, range limit)
// and returns it unchanged when the answer means "no" (execution reverted, nonce too low, bad params).
//
// Measured on the live upstreams while building this (see test/live.test.mjs):
//   - Robinhood Chain makes ~10 blocks/s. The official RPC and staccpad usually sit 5-40 blocks behind publicnode.
//   - publicnode without a token answers 403 "Archive requests require a personal token" for anything older than
//     ~64-100 blocks (eth_getLogs over the last 500 blocks included). Fine for head reads, useless for history.
//   - the official RPC keeps ~1-10k blocks of state ("historical state ... is not available" at safe/finalized) and
//     answers eth_getLogs ranges that run past its head with a silent [] instead of an error. So does staccpad.
//   - staccpad is itself a load balancer that sometimes relays publicnode's rate limit.
//
// No dependencies: node:http, global fetch, and a local keccak256 for transaction hashes.

import http from 'node:http';
import { pathToFileURL } from 'node:url';

// ------------------------------------------------------------------------------------------------ keccak256
// eth_sendRawTransaction answered "already known" still owes the caller the tx hash: keccak256(raw envelope bytes).
const RC_HI = Uint32Array.from([
  0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x00000000, 0x00000000, 0x80000000, 0x80000000,
  0x00000000, 0x00000000, 0x00000000, 0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x80000000,
  0x80000000, 0x80000000, 0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x00000000, 0x80000000,
]);
const RC_LO = Uint32Array.from([
  0x00000001, 0x00008082, 0x0000808a, 0x80008000, 0x0000808b, 0x80000001, 0x80008081, 0x00008009,
  0x0000008a, 0x00000088, 0x80008009, 0x8000000a, 0x8000808b, 0x0000008b, 0x00008089, 0x00008003,
  0x00008002, 0x00000080, 0x0000800a, 0x8000000a, 0x80008081, 0x00008080, 0x80000001, 0x80008008,
]);
// rho rotation for lane x + 5y
const RHO = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];

function keccakF(lo, hi, cLo, cHi, bLo, bHi) {
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) {
      cLo[x] = lo[x] ^ lo[x + 5] ^ lo[x + 10] ^ lo[x + 15] ^ lo[x + 20];
      cHi[x] = hi[x] ^ hi[x + 5] ^ hi[x + 10] ^ hi[x + 15] ^ hi[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      const l1 = cLo[(x + 1) % 5], h1 = cHi[(x + 1) % 5];
      const dLo = cLo[(x + 4) % 5] ^ ((l1 << 1) | (h1 >>> 31));
      const dHi = cHi[(x + 4) % 5] ^ ((h1 << 1) | (l1 >>> 31));
      for (let y = 0; y < 25; y += 5) { lo[x + y] ^= dLo; hi[x + y] ^= dHi; }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const i = x + 5 * y, r = RHO[i], j = y + 5 * ((2 * x + 3 * y) % 5);
        let l = lo[i], h = hi[i];
        if (r >= 32) { const t = l; l = h; h = t; }
        const s = r & 31;
        if (s) { const nl = (l << s) | (h >>> (32 - s)); h = (h << s) | (l >>> (32 - s)); l = nl; }
        bLo[j] = l; bHi[j] = h;
      }
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        lo[x + y] = bLo[x + y] ^ (~bLo[((x + 1) % 5) + y] & bLo[((x + 2) % 5) + y]);
        hi[x + y] = bHi[x + y] ^ (~bHi[((x + 1) % 5) + y] & bHi[((x + 2) % 5) + y]);
      }
    }
    lo[0] ^= RC_LO[round];
    hi[0] ^= RC_HI[round];
  }
}

export function keccak256(bytes) {
  const rate = 136;
  const lo = new Uint32Array(25), hi = new Uint32Array(25);
  const scratch = [new Uint32Array(5), new Uint32Array(5), new Uint32Array(25), new Uint32Array(25)];
  const padded = new Uint8Array((Math.floor(bytes.length / rate) + 1) * rate);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const dv = new DataView(padded.buffer);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      lo[i] ^= dv.getUint32(off + 8 * i, true);
      hi[i] ^= dv.getUint32(off + 8 * i + 4, true);
    }
    keccakF(lo, hi, ...scratch);
  }
  const out = new Uint8Array(32), odv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) { odv.setUint32(8 * i, lo[i], true); odv.setUint32(8 * i + 4, hi[i], true); }
  return out;
}

export function txHashOf(rawHex) {
  if (typeof rawHex !== 'string' || !/^0x([0-9a-fA-F]{2})+$/.test(rawHex)) return null;
  return '0x' + Buffer.from(keccak256(Buffer.from(rawHex.slice(2), 'hex'))).toString('hex');
}

// ------------------------------------------------------------------------------------------------ config
// RPC_UPSTREAMS: comma list of [name=]url[|weight]. $VAR / ${VAR} (or a bare VAR name) expands from the environment
// after splitting, so a secret URL (DRPC_URL) can contain anything. An entry whose variable is unset is skipped.
// Weight 0 = backup only: never picked first, still tried on failover.
export const DEFAULT_UPSTREAMS = [
  'drpc=${DRPC_URL}|4',
  'publicnode=https://robinhood-rpc.publicnode.com|3',
  'staccpad=https://staccpad.fun/rpc|2',
  'official=https://rpc.mainnet.chain.robinhood.com|1',
].join(',');

export function parseUpstreams(spec, env = process.env) {
  const upstreams = [], warnings = [], names = new Set(), urls = new Set();
  for (const raw of String(spec ?? '').split(',')) {
    let entry = raw.trim();
    if (!entry) continue;
    let name = null, weight = 1;
    const named = /^([A-Za-z][\w.-]*)=(.*)$/.exec(entry);
    if (named) { name = named[1]; entry = named[2].trim(); }
    const bar = entry.lastIndexOf('|');
    if (bar !== -1) {
      const w = entry.slice(bar + 1).trim();
      if (!/^\d+(\.\d+)?$/.test(w)) { warnings.push(`skipping ${name ?? 'an upstream'}: weight "${w}" is not a number`); continue; }
      weight = Number(w);
      entry = entry.slice(0, bar).trim();
    }
    let missing = null;
    if (/^[A-Z_][A-Z0-9_]*$/.test(entry)) entry = '$' + entry;
    const url = entry.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, a, b) => {
      const v = env[a || b];
      if (!v || !v.trim()) { missing = a || b; return ''; }
      return v.trim();
    });
    if (missing) { warnings.push(`skipping ${name ?? 'an upstream'}: $${missing} is not set`); continue; }
    let parsed;
    try { parsed = new URL(url); } catch { warnings.push(`skipping ${name ?? 'an upstream'}: not a valid URL`); continue; }
    if (!/^https?:$/.test(parsed.protocol)) { warnings.push(`skipping ${name ?? parsed.host}: only http(s) upstreams are supported`); continue; }
    if (urls.has(url)) { warnings.push(`skipping ${name ?? parsed.host}: duplicate URL`); continue; }
    urls.add(url);
    name ||= parsed.hostname;
    let unique = name;
    for (let n = 2; names.has(unique); n++) unique = `${name}${n}`;
    names.add(unique);
    upstreams.push({ name: unique, url, weight });
  }
  return { upstreams, warnings };
}

export const DEFAULTS = {
  port: 8545,
  host: '::',
  chainId: 4663,
  timeoutMs: 8_000,            // per attempt
  logsTimeoutMs: 20_000,       // per eth_getLogs attempt
  // Whole request including failovers. Nitro's parent-chain client gives up after 60s (parent-chain.connection.timeout
  // default 1m) and does not retry a deadline error, so work past ~50s is wasted: answer with an error first.
  deadlineMs: 50_000,
  headPollMs: 2_000,           // eth_blockNumber to every upstream
  headTimeoutMs: 3_000,
  repollMinMs: 500,            // an on-demand head poll (block N nobody is known to have) waits this long after the last
  maxLagBlocks: 5,             // skip for latest/safe/finalized reads if this far behind the best head
  breakerFails: 5,             // consecutive hard failures that open the circuit
  breakerMs: 30_000,           // how long it stays open
  rateLimitCooldownMs: 5_000,  // after a 429 (or Retry-After, capped at 60s) the upstream goes to the back of the line
  capTtlMs: 300_000,           // after "archive"/"pruned"/"range" errors, skip that upstream for that kind of request
  capStrikes: 2,               // ...once it has failed that kind of request this many times in a row (LBs are uneven)
  // Upstreams that answer eth_getLogs past their head with [] (or whose probe was inconclusive) only get a range whose
  // end is this far below their head (~5s at 10 blocks/s), and never as a last resort: a silent [] loses logs.
  clampMarginBlocks: 50,
  clampReprobeMs: 60_000,      // re-probe an upstream whose clamp probe was inconclusive (strict ones: every 10 min)
  recentBlocks: 32,            // a "pruned state" error for a block this close to the head means lag, not pruning
  nullRetryMax: 2,             // extra upstreams asked when a receipt/tx/block lookup comes back null
  nullRetryMethods: ['eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getBlockByHash', 'eth_getBlockByNumber'],
  nullRetryBatchItems: 20,     // per batch
  strategy: 'weighted',        // 'weighted': first pick is random by weight x health; 'priority': always the top score
  statsIntervalMs: 60_000,
  verifyRetryMs: 15_000,
  maxBodyBytes: 32 * 1024 * 1024,
  maxBatch: 1_000,
  failoverLogsPerInterval: 30,
  maxFilters: 10_000,
  maxCapKeys: 500,
};

const num = (v, d) => { if (v === undefined || v === '') return d; const n = Number(v); return Number.isFinite(n) ? n : d; };

export function configFromEnv(env = process.env) {
  const { upstreams, warnings } = parseUpstreams(env.RPC_UPSTREAMS || DEFAULT_UPSTREAMS, env);
  return {
    upstreams,
    warnings,
    port: num(env.PORT, DEFAULTS.port),
    host: env.HOST || DEFAULTS.host,
    chainId: num(env.EXPECTED_CHAIN_ID, DEFAULTS.chainId),
    timeoutMs: num(env.TIMEOUT_MS, DEFAULTS.timeoutMs),
    logsTimeoutMs: num(env.LOGS_TIMEOUT_MS, DEFAULTS.logsTimeoutMs),
    deadlineMs: num(env.REQUEST_DEADLINE_MS, DEFAULTS.deadlineMs),
    headPollMs: num(env.HEAD_POLL_MS, DEFAULTS.headPollMs),
    headTimeoutMs: num(env.HEAD_TIMEOUT_MS, DEFAULTS.headTimeoutMs),
    maxLagBlocks: num(env.MAX_LAG_BLOCKS, DEFAULTS.maxLagBlocks),
    breakerFails: num(env.BREAKER_FAILS, DEFAULTS.breakerFails),
    breakerMs: num(env.BREAKER_MS, DEFAULTS.breakerMs),
    rateLimitCooldownMs: num(env.RATE_LIMIT_COOLDOWN_MS, DEFAULTS.rateLimitCooldownMs),
    capTtlMs: num(env.CAP_TTL_MS, DEFAULTS.capTtlMs),
    capStrikes: num(env.CAP_STRIKES, DEFAULTS.capStrikes),
    clampMarginBlocks: num(env.CLAMP_MARGIN_BLOCKS, DEFAULTS.clampMarginBlocks),
    clampReprobeMs: num(env.CLAMP_REPROBE_MS, DEFAULTS.clampReprobeMs),
    // names of upstreams known to answer eth_getLogs past their head with [] (probes of an LB can miss it)
    clampingUpstreams: String(env.CLAMPING_UPSTREAMS ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    repollMinMs: num(env.REPOLL_MIN_MS, DEFAULTS.repollMinMs),
    nullRetryMax: num(env.NULL_RETRY_MAX, DEFAULTS.nullRetryMax),
    nullRetryMethods: env.NULL_RETRY_METHODS !== undefined
      ? env.NULL_RETRY_METHODS.split(',').map((s) => s.trim()).filter(Boolean)
      : DEFAULTS.nullRetryMethods,
    strategy: env.STRATEGY === 'priority' ? 'priority' : 'weighted',
    statsIntervalMs: num(env.STATS_INTERVAL_MS, DEFAULTS.statsIntervalMs),
    verifyRetryMs: num(env.VERIFY_RETRY_MS, DEFAULTS.verifyRetryMs),
  };
}

// ------------------------------------------------------------------------------------------------ errors
// 'final'      the node answered and the answer is the answer: return it (revert, bad params, insufficient funds)
// 'ratelimit'  429 or a JSON-RPC rate-limit error: fail over, cool the upstream down, counts toward the breaker
// 'transient'  5xx, timeouts, internal errors: fail over, counts toward the breaker
// 'capability' the node lacks the data for this kind of request (pruned/archive/range/method): fail over and skip it
//              for the same kind of request for capTtlMs. Not the node's health, so it does not trip the breaker.
// 'lag'        the node doesn't have this block yet (unknown block, header not found): fail over
const RE_REVERT = /revert/i;
const RE_RATE = /rate.?limit|too many requests|request limit|(?<!gas )limit reached|quota|throttl|exceeded (the )?(maximum )?(rate|number of requests|capacity|compute units)|compute units|capacity exceeded|daily limit|upgrade your plan/i;
const RE_CAP_STATE = /archive|personal token|historical state|missing trie node|unknown state|first available state|state (is )?not available|state histor|pruned|recreate-state|recreat(e|ing) state/i;
const RE_LAG = /unknown block|header not found|header for hash not found|block (0x[0-9a-f]+ |#?\d+ )?not found|could not find block|unsupported block number|invalid block range|not (yet )?synced|cannot query unfinalized|after last accepted|indexing (is )?in progress/i;
const RE_CAP_OTHER = /blocks? range|range (is )?too (large|wide|big)|range limit|max(imum)? (block )?range|limited to [\d,]+ blocks?|query returned more than|too many (results|logs|blocks)|response (size|too large)|result (set )?too large|max(imum)? results|method not (found|supported|available|allowed)|not supported|unsupported method|does not exist|batch/i;
// "context deadline exceeded" is geth/Nitro timing out its own eth_getLogs or eth_call: another node may finish it.
const RE_TRANSIENT = /timeout|timed out|deadline exceeded|context canceled|\bEOF\b|temporar|unavailable|internal (server )?error|bad gateway|gateway|upstream|no (healthy |available )?(backend|node|provider|upstream)s?|provider|try again|overloaded|busy|connection|econn|socket/i;

// A pruned-state message about a block at the head is lag: staccpad answers "Unknown state. First available state
// is 1" for a block its backend doesn't have yet. Only older blocks teach the proxy that a node lacks history.
export const isStateError = (err) => RE_CAP_STATE.test(String(err?.message ?? err ?? ''));

export function classifyError(err) {
  const code = Number(err?.code);
  const msg = String(err?.message ?? (typeof err === 'string' ? err : ''));
  if (code === 3 || RE_REVERT.test(msg)) return 'final';
  if (code === 429 || RE_RATE.test(msg)) return 'ratelimit';
  if (RE_CAP_STATE.test(msg)) return 'capability';
  if (RE_LAG.test(msg)) return 'lag';
  if (RE_CAP_OTHER.test(msg) || code === -32601) return 'capability';
  if (code === -32005) return /range|block|result|log/i.test(msg) ? 'capability' : 'ratelimit'; // EIP-1474 "limit exceeded"
  if (/(?<!gas )limit exceeded/i.test(msg)) return 'ratelimit';
  if (RE_TRANSIENT.test(msg) || code === -32603) return 'transient';
  return 'final';
}

// eth_sendRawTransaction outcomes that end the attempt instead of trying the next upstream
const RE_KNOWN_TX = /already known|known transaction|alreadyknown|already exists|already imported|already in (the )?(mempool|pool|txpool)|ALREADY_EXISTS/i;
const RE_NONCE_LOW = /nonce too low|nonce has already been used|NONCE_EXPIRED|invalid nonce.*(lower|low)/i;
// "nonce too high" / "nonce gap" can come from a node (or an LB backend) that hasn't seen the sender's previous tx
// land yet, so those try the next upstream like other errors. Underpriced replacements are the caller's to fix.
const RE_NONCE_OTHER = /replacement transaction underpriced|underpriced/i;

const normErr = (e) => (e && typeof e === 'object'
  ? { ...e, code: Number.isFinite(Number(e.code)) ? Number(e.code) : -32000, message: String(e.message ?? '') }
  : { code: -32000, message: String(e ?? 'error') });

// ------------------------------------------------------------------------------------------------ request shape
// Which param is the block, so a request knows whether it needs a fresh node (tags, hashes) or one that has block N.
const BLOCK_ARG = {
  eth_getBalance: 1, eth_getCode: 1, eth_getTransactionCount: 1, eth_getStorageAt: 2, eth_call: 1,
  eth_estimateGas: 1, eth_createAccessList: 1, eth_getProof: 2, eth_simulateV1: 1,
  eth_getBlockByNumber: 0, eth_getBlockTransactionCountByNumber: 0, eth_getTransactionByBlockNumberAndIndex: 0,
  eth_getBlockReceipts: 0, eth_getUncleCountByBlockNumber: 0, eth_getUncleByBlockNumberAndIndex: 0,
  eth_feeHistory: 1, debug_traceBlockByNumber: 0, debug_traceCall: 1,
};
const NO_BLOCK = new Set(['web3_clientVersion', 'net_version', 'net_listening', 'eth_chainId', 'eth_syncing', 'eth_protocolVersion', 'rpc_modules']);
const TAG_BUCKET = { latest: 'L', pending: 'L', safe: 'S', finalized: 'F', earliest: 'E' };

function blockRef(v) {
  if (v === undefined || v === null) return { tag: 'latest' };
  if (typeof v === 'number') return { num: v };
  if (typeof v === 'string') {
    if (/^0x[0-9a-fA-F]{64}$/.test(v)) return { hash: v };
    if (/^0x[0-9a-fA-F]{1,16}$/.test(v)) return { num: parseInt(v, 16) };
    if (/^\d+$/.test(v)) return { num: Number(v) };
    return { tag: v.toLowerCase() };
  }
  if (typeof v === 'object') {
    if (v.blockHash) return { hash: v.blockHash };
    if (v.blockNumber !== undefined) return blockRef(v.blockNumber);
  }
  return { tag: 'latest' };
}
const ageBucket = (age) => (!Number.isFinite(age) ? 'n?' : age <= 32 ? 'n0' : age <= 1024 ? 'n1' : age <= 65536 ? 'n2' : 'n3');
const spanBucket = (span) => (!Number.isFinite(span) ? '' : span <= 1000 ? 's0' : span <= 10_000 ? 's1' : span <= 50_000 ? 's2' : 's3');

// ------------------------------------------------------------------------------------------------ proxy
const LOCAL = new Set(['eth_chainId', 'net_version']);
const SENDS = new Set(['eth_sendRawTransaction', 'eth_sendRawTransactionConditional']);
const FILTER_NEW = new Set(['eth_newFilter', 'eth_newBlockFilter', 'eth_newPendingTransactionFilter']);
const FILTER_USE = new Set(['eth_getFilterChanges', 'eth_getFilterLogs', 'eth_uninstallFilter']);
const COUNTERS = ['req', 'ok', 'fail', 'soft', 'failovers', 'r429', 'timeouts', 'ms'];
const newCounters = () => Object.fromEntries(COUNTERS.map((k) => [k, 0]));
const GLOBAL_COUNTERS = ['calls', 'batches', 'batchItems', 'local', 'errors', 'failovers', 'nullRescues', 'sendKnown', 'abandoned'];
const newGlobal = () => Object.fromEntries(GLOBAL_COUNTERS.map((k) => [k, 0]));
const hex = (n) => '0x' + n.toString(16);
const short = (s, n = 140) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const isObj = (m) => m !== null && typeof m === 'object' && !Array.isArray(m);
const isResponse = (b) => isObj(b) && ('result' in b || 'error' in b);
const withId = (body, id) => (body.error !== undefined
  ? { jsonrpc: '2.0', id, error: body.error }
  : { jsonrpc: '2.0', id, result: body.result === undefined ? null : body.result });

export function createProxy(userCfg = {}) {
  const cfg = { ...DEFAULTS, ...userCfg };
  const log = cfg.log || ((line) => console.log(line));
  const chainHex = hex(cfg.chainId);
  const nullRetry = new Set(cfg.nullRetryMethods);
  const startedAt = Date.now();

  const ups = (cfg.upstreams || []).map((spec, index) => {
    const parsed = new URL(spec.url);
    const headers = { 'content-type': 'application/json', 'user-agent': 'xgas-rpc/1' };
    const creds = Boolean(parsed.username || parsed.password); // fetch refuses URLs with credentials: send them as a header
    if (creds) {
      headers.authorization = 'Basic ' + Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString('base64');
      parsed.username = ''; parsed.password = '';
    }
    return {
      index, name: spec.name || parsed.hostname, host: parsed.host, url: creds ? parsed.toString() : spec.url,
      headers, weight: Number(spec.weight ?? 1),
      verified: false, dropped: false, verifying: false, verifyError: null,
      // clampsLogs: true (answers [] past its head), false (errors), null (not known yet: treated as true)
      head: null, lag: null, lastPollOk: 0, clampProbeAt: 0,
      clampsLogs: (cfg.clampingUpstreams || []).includes(spec.name || parsed.hostname) ? true : null,
      consecFails: 0, openUntil: 0, cooldownUntil: 0, ewmaOk: 1, ewmaMs: 100,
      caps: new Map(),
      total: newCounters(), minute: newCounters(), lastMinute: newCounters(),
    };
  });

  const g = { total: newGlobal(), minute: newGlobal(), lastMinute: newGlobal() };
  let maxHead = null;
  let failoverLogs = 0, failoverLogsSuppressed = 0;
  const filters = new Map(); // filter id -> { u, at }: filters live on one node, so their follow-ups go there
  const timers = [];

  const bump = (u, k, n = 1) => { u.total[k] += n; u.minute[k] += n; };
  const gbump = (k, n = 1) => { g.total[k] += n; g.minute[k] += n; };
  const score = (u) => u.weight * u.ewmaOk * u.ewmaOk / (1 + u.ewmaMs / 1000);
  const isFresh = (u, now) => now - u.lastPollOk <= Math.max(3 * cfg.headPollMs, 6_000);
  // capability memory: key -> { fails, at, until }. Skipped (until > now) after capStrikes consecutive failures.
  const hasCap = (u, key, now) => {
    const e = u.caps.get(key);
    if (!e || !e.until) return false;
    if (e.until > now) return true;
    u.caps.delete(key);
    return false;
  };
  const pruneCaps = (u, now) => {
    for (const [k, e] of u.caps) if (e.until ? e.until <= now : now - e.at > cfg.capTtlMs) u.caps.delete(k);
    if (u.caps.size > cfg.maxCapKeys) u.caps.clear(); // method names are caller-supplied: never let them pile up
  };
  const penalize = (u, keys, now = Date.now()) => {
    if (keys.length && u.caps.size >= cfg.maxCapKeys) pruneCaps(u, now);
    for (const k of keys) {
      let e = u.caps.get(k);
      if (!e || now - e.at > cfg.capTtlMs) e = { fails: 0, at: now, until: 0 };
      e.fails++; e.at = now;
      if (e.fails >= cfg.capStrikes) e.until = now + cfg.capTtlMs;
      u.caps.set(k, e);
    }
  };

  // ---------------------------------------------------------------- upstream I/O
  async function post(u, payload, timeoutMs) {
    const t0 = performance.now();
    try {
      const res = await fetch(u.url, {
        method: 'POST', headers: u.headers, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs))),
      });
      const text = await res.text();
      const ms = performance.now() - t0;
      let body;
      try { body = JSON.parse(text); } catch { body = undefined; }
      if (res.status === 429) {
        return { ok: false, kind: 'ratelimit', status: 429, ms, retryAfter: retryAfterMs(res.headers.get('retry-after')), message: 'HTTP 429' };
      }
      // Some nodes put a JSON-RPC error on a 4xx/5xx (publicnode: 403 "Archive requests require a personal token").
      if (isResponse(body) || Array.isArray(body)) return { ok: true, status: res.status, body, ms };
      return { ok: false, kind: 'transient', status: res.status, ms, message: res.ok ? 'invalid JSON response' : `HTTP ${res.status}` };
    } catch (e) {
      const ms = performance.now() - t0;
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { ok: false, kind: 'timeout', ms, message: `timeout after ${Math.round(timeoutMs)}ms` };
      return { ok: false, kind: 'transient', ms, message: short(e?.cause?.code || e?.cause?.message || e?.message || String(e), 80) };
    }
  }

  function retryAfterMs(h) {
    if (!h) return undefined;
    if (/^\d+(\.\d+)?$/.test(h.trim())) return Number(h) * 1000;
    const t = Date.parse(h);
    return Number.isFinite(t) ? Math.max(0, t - Date.now()) : undefined;
  }

  function hardFail(u) {
    const now = Date.now();
    bump(u, 'fail');
    u.ewmaOk *= 0.9;
    u.consecFails++;
    if (u.consecFails >= cfg.breakerFails && u.openUntil <= now) {
      u.openUntil = now + cfg.breakerMs;
      log(`[breaker] ${u.name} open for ${Math.round(cfg.breakerMs / 1000)}s after ${u.consecFails} consecutive failures`);
    }
  }

  // One attempt's outcome: stats, health score, circuit breaker, rate-limit cooldown, capability memory.
  function account(u, outcome, { ms = 0, retryAfter, capKeys = [] } = {}) {
    const now = Date.now();
    bump(u, 'req');
    switch (outcome) {
      case 'ok':
        bump(u, 'ok'); bump(u, 'ms', ms);
        u.ewmaOk = u.ewmaOk * 0.9 + 0.1;
        u.ewmaMs = u.ewmaMs * 0.8 + ms * 0.2;
        if (u.consecFails >= cfg.breakerFails) log(`[breaker] ${u.name} closed`);
        u.consecFails = 0; u.openUntil = 0;
        for (const k of capKeys) u.caps.delete(k);
        break;
      case 'lag':
        bump(u, 'soft');
        break;
      case 'capability':
        bump(u, 'soft');
        penalize(u, capKeys, now);
        break;
      case 'ratelimit':
        bump(u, 'r429');
        u.cooldownUntil = now + Math.min(60_000, Math.max(500, retryAfter ?? cfg.rateLimitCooldownMs));
        hardFail(u);
        break;
      case 'timeout':
        bump(u, 'timeouts');
        hardFail(u);
        break;
      default:
        hardFail(u);
    }
  }

  function moved(u, what, reason, next) {
    bump(u, 'failovers');
    gbump('failovers');
    if (failoverLogs < cfg.failoverLogsPerInterval) {
      failoverLogs++;
      log(`[failover] ${u.name} ${what}: ${short(reason)} -> ${next ? next.name : 'none left'}`);
    } else failoverLogsSuppressed++;
  }

  // Opportunistic head tracking from traffic: whoever just told a consumer "latest is N" has block N.
  function observe(u, method, params, result) {
    let n = null;
    if (method === 'eth_blockNumber' && typeof result === 'string') n = parseInt(result, 16);
    else if (method === 'eth_getBlockByNumber' && isObj(result) && typeof result.number === 'string'
      && (params?.[0] === 'latest' || params?.[0] === 'pending')) n = parseInt(result.number, 16);
    if (Number.isFinite(n)) {
      if (u.head === null || n > u.head) u.head = n;
      if (maxHead === null || n > maxHead) maxHead = n;
    }
  }

  // ---------------------------------------------------------------- boot checks, head polling
  async function verify(u) {
    if (u.verifying || u.verified || u.dropped) return;
    u.verifying = true;
    try {
      const r = await post(u, { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }, cfg.timeoutMs);
      const res = r.ok ? r.body?.result : undefined;
      if (typeof res !== 'string') {
        const why = r.ok ? short(r.body?.error?.message ?? 'no result', 80) : r.message;
        if (u.verifyError !== why) log(`[boot] ${u.name} (${u.host}) eth_chainId failed (${why}); not used until it answers, retrying every ${Math.round(cfg.verifyRetryMs / 1000)}s`);
        u.verifyError = why;
        return;
      }
      if (parseInt(res, 16) !== cfg.chainId) {
        u.dropped = true;
        log(`[boot] DROPPING ${u.name} (${u.host}): eth_chainId ${res}, expected ${chainHex}`);
        return;
      }
      u.verified = true;
      u.verifyError = null;
      await detectClamp(u);
      const clamp = u.clampsLogs === true ? ', clamps eth_getLogs at its head'
        : u.clampsLogs === null ? ', eth_getLogs clamp probe inconclusive (treated as clamping until it answers)' : '';
      log(`[boot] ${u.name} (${u.host}) is chain ${cfg.chainId}, weight ${u.weight}${clamp}`);
    } finally {
      u.verifying = false;
    }
  }

  // Does this node answer an eth_getLogs range that runs past its head with [] (instead of an error)? Then a range
  // ending near the head is only trusted to it when its head is clampMarginBlocks past the range's end. Load
  // balancers are uneven (staccpad answered [] to one probe and "Unknown block" to the next), so three probes go out
  // at once and a single [] marks the node as clamping for good. Only all-errors proves it strict; anything else
  // (timeouts, 429s) leaves it unknown, which routes like clamping and is probed again later.
  async function detectClamp(u) {
    u.clampProbeAt = Date.now();
    if (u.clampsLogs === true) return;
    const hr = await post(u, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }, cfg.headTimeoutMs);
    const head = hr.ok && typeof hr.body?.result === 'string' ? parseInt(hr.body.result, 16) : NaN;
    if (!Number.isFinite(head)) return;
    const zero = '0x0000000000000000000000000000000000000000';
    const ranges = [[head + 500, head + 1000], [head - 10, head + 1000], [head - 5, head + 2000]];
    const rs = await Promise.all(ranges.map(([a, b]) => post(u, {
      jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: hex(Math.max(0, a)), toBlock: hex(b), address: zero }],
    }, cfg.headTimeoutMs)));
    if (rs.some((r) => r.ok && Array.isArray(r.body?.result))) u.clampsLogs = true;
    // a rate-limit or timeout error proves nothing about how it treats a range past its head
    else if (rs.every((r) => r.ok && isObj(r.body?.error) && !['ratelimit', 'transient'].includes(classifyError(r.body.error)))) u.clampsLogs = false;
  }

  let polling = null, lastPollAt = 0;
  function pollHeads() {
    if (polling) return polling;
    polling = (async () => {
      // An upstream cooling down after a 429 is left alone: polling it every HEAD_POLL_MS keeps it rate limited.
      const t = Date.now();
      const live = ups.filter((u) => u.verified && !u.dropped && u.cooldownUntil <= t);
      const heads = await Promise.all(live.map(async (u) => {
        const r = await post(u, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }, cfg.headTimeoutMs);
        const rateLimited = r.kind === 'ratelimit' || (r.ok && isObj(r.body?.error) && classifyError(r.body.error) === 'ratelimit');
        if (rateLimited) u.cooldownUntil = Date.now() + Math.min(60_000, Math.max(500, r.retryAfter ?? cfg.rateLimitCooldownMs));
        const n = r.ok && typeof r.body?.result === 'string' ? parseInt(r.body.result, 16) : NaN;
        return Number.isFinite(n) ? n : null;
      }));
      const roundMax = heads.reduce((m, h) => (h !== null && h > m ? h : m), -1);
      const now = Date.now();
      live.forEach((u, i) => {
        const h = heads[i];
        if (h === null) return;
        if (u.head === null || h > u.head) u.head = h;
        u.lag = roundMax - h; // lag only compares heads from the same round
        u.lastPollOk = now;
      });
      if (roundMax >= 0 && (maxHead === null || roundMax > maxHead)) maxHead = roundMax;
    })().finally(() => { polling = null; lastPollAt = Date.now(); });
    return polling;
  }

  // ---------------------------------------------------------------- routing
  function describe(method, params) {
    const p = Array.isArray(params) ? params : [];
    // recent: the oldest block the request touches is at the head, so a "no state" answer means lag, not pruning
    const r = { method, fresh: true, minBlock: null, recent: false, capKey: method, timeout: method === 'eth_getLogs' ? cfg.logsTimeoutMs : cfg.timeoutMs };
    const age = (n) => ageBucket(maxHead === null ? NaN : maxHead - n);
    const isRecent = (ref) => (ref.num !== undefined ? maxHead !== null && maxHead - ref.num <= cfg.recentBlocks
      : ref.tag === 'latest' || ref.tag === 'pending');
    if (method === 'eth_getLogs') {
      const f = isObj(p[0]) ? p[0] : {};
      if (f.blockHash) { r.capKey = `${method}|H`; return r; }
      const from = blockRef(f.fromBlock ?? 'latest'), to = blockRef(f.toBlock ?? 'latest');
      if (to.num !== undefined) { r.fresh = false; r.minBlock = to.num; }
      else if (to.tag === 'earliest') r.fresh = false;
      r.recent = isRecent(from);
      const fromN = from.num ?? (from.tag === 'earliest' ? 0 : maxHead);
      const toN = to.num ?? (to.tag === 'earliest' ? 0 : maxHead);
      const a = from.num !== undefined ? age(from.num) : (TAG_BUCKET[from.tag] ?? 'L');
      const s = fromN !== null && toN !== null ? spanBucket(toN - fromN) : '';
      r.capKey = `${method}|${a}${s ? '|' + s : ''}`;
      return r;
    }
    if (method in BLOCK_ARG) {
      const ref = blockRef(p[BLOCK_ARG[method]]);
      r.recent = isRecent(ref);
      if (ref.num !== undefined) { r.fresh = false; r.minBlock = ref.num; r.capKey = `${method}|${age(ref.num)}`; }
      else if (ref.hash) r.capKey = `${method}|H`;
      else { r.fresh = ref.tag !== 'earliest'; r.capKey = `${method}|${TAG_BUCKET[ref.tag] ?? 'L'}`; }
      return r;
    }
    if (NO_BLOCK.has(method)) r.fresh = false;
    return r;
  }

  // An upstream that answers eth_getLogs past its head with [] (or might: clampsLogs null) must not get a range that
  // ends near or past its head, not even as a last resort: it would answer with the logs it has and drop the rest.
  // An error sends Nitro back to retry; a short [] makes it walk back looking for a reorg, and the site's
  // /api/robinhood/stream cursor would skip those blocks for good.
  const logsUnsafe = (u, r) => r.method === 'eth_getLogs' && r.minBlock !== null && u.clampsLogs !== false
    && (u.head === null || u.head < r.minBlock + cfg.clampMarginBlocks);

  function fits(u, r, now) {
    if (hasCap(u, r.capKey, now)) return false;
    if (r.fresh && !(isFresh(u, now) && u.lag !== null && u.lag <= cfg.maxLagBlocks)) return false;
    if (r.minBlock !== null && (u.head === null || u.head < r.minBlock)) return false;
    return !logsUnsafe(u, r);
  }

  // Tier 0: closed breaker, not cooling down, can serve every request in reqs. First pick weighted by
  //         weight x health (or the top score for 'priority' / sends), then by score.
  // Tier 1: usable but lagging / cooling down / known to lack this kind of data: last resort, best-placed first.
  // Tier 2: breaker open: only when everything else failed.
  // Never: unverified, wrong chain, or (single requests) a clamping upstream for a range near its head. A batch keeps
  // such an upstream in its order and leaves the unsafe items out of what it sends there.
  function orderFor(reqs, { exclude, deterministic = false, batch = false } = {}) {
    const now = Date.now();
    const t0 = [], t1 = [], t2 = [];
    for (const u of ups) {
      if (!u.verified || u.dropped || exclude?.has(u)) continue;
      if (!batch && reqs.some((r) => logsUnsafe(u, r))) continue;
      if (u.openUntil > now) t2.push(u);
      else if (u.cooldownUntil > now || !reqs.every((r) => fits(u, r, now))) t1.push(u);
      else t0.push(u);
    }
    const byScore = (a, b) => score(b) - score(a) || a.index - b.index;
    t0.sort(byScore);
    if (!deterministic && cfg.strategy === 'weighted' && t0.length > 1) {
      const total = t0.reduce((s, u) => s + score(u), 0);
      if (total > 0) {
        let x = Math.random() * total, i = 0;
        for (; i < t0.length - 1; i++) { x -= score(t0[i]); if (x <= 0) break; }
        if (i > 0) t0.unshift(t0.splice(i, 1)[0]);
      }
    }
    const rank = (u) => (reqs.some((r) => hasCap(u, r.capKey, now)) ? 4 : 0) + (u.cooldownUntil > now ? 2 : 0);
    t1.sort((a, b) => rank(a) - rank(b) || (b.head ?? -1) - (a.head ?? -1) || byScore(a, b));
    t2.sort((a, b) => a.openUntil - b.openUntil);
    return [...t0, ...t1, ...t2];
  }

  // A request for block N that no usable upstream is known to have yet: refresh heads once before choosing.
  async function ensureHeads(reqs) {
    const need = reqs.reduce((m, r) => (r.minBlock !== null && r.minBlock > m ? r.minBlock : m), -1);
    if (need < 0) return;
    const now = Date.now();
    const known = ups.some((u) => u.verified && !u.dropped && u.openUntil <= now && u.cooldownUntil <= now
      && u.head !== null && u.head >= need && !reqs.some((r) => hasCap(u, r.capKey, now) || logsUnsafe(u, r)));
    if (known) return;
    // just polled: the block may not exist anywhere yet. (Each poll asks every upstream, so at most 2/s on demand.)
    if (!polling && now - lastPollAt < cfg.repollMinMs) return;
    await pollHeads();
  }

  // ---------------------------------------------------------------- single requests
  // A "pruned state" answer about a block at the head is lag (see isStateError), not something to remember.
  const classifyFor = (req, e) => {
    const cls = classifyError(e);
    return cls === 'capability' && req.recent && isStateError(e) ? 'lag' : cls;
  };

  // The caller hung up (viem gives up after 10s and retries): stop failing over on its behalf.
  const gone = (ctx, notes) => {
    if (!ctx?.aborted) return false;
    if (!ctx.counted) { ctx.counted = true; gbump('abandoned'); }
    notes?.push('caller went away');
    return true;
  };

  async function forwardOne(msg, req, order, deadline, ctx) {
    let lastRpcErr = null;
    const notes = [];
    for (let i = 0; i < order.length; i++) {
      const u = order[i];
      const left = deadline - Date.now();
      if (left <= 50) { notes.push('deadline reached'); break; }
      if (gone(ctx, notes)) break;
      const r = await post(u, { jsonrpc: '2.0', id: 1, method: msg.method, params: msg.params ?? [] }, Math.min(req.timeout, left));
      if (!r.ok || !isResponse(r.body)) {
        const kind = r.ok ? 'transient' : r.kind, why = r.ok ? 'malformed response' : r.message;
        account(u, kind, { retryAfter: r.retryAfter });
        notes.push(`${u.name}: ${why}`);
        moved(u, msg.method, why, order[i + 1]);
        continue;
      }
      const b = r.body;
      if (b.error !== undefined && b.error !== null) {
        const e = normErr(b.error), cls = classifyFor(req, e);
        if (cls === 'final') {
          account(u, 'ok', { ms: r.ms, capKeys: [req.capKey] });
          return { body: { error: e }, u };
        }
        account(u, cls, { retryAfter: r.retryAfter, capKeys: [req.capKey] });
        lastRpcErr = e;
        notes.push(`${u.name}: ${short(e.message, 80)}`);
        moved(u, msg.method, e.message, order[i + 1]);
        continue;
      }
      account(u, 'ok', { ms: r.ms, capKeys: [req.capKey] });
      observe(u, msg.method, msg.params, b.result);
      return { body: { result: b.result }, u };
    }
    gbump('errors');
    return {
      body: { error: lastRpcErr ?? { code: -32603, message: `xgas-rpc: no upstream answered ${msg.method}${notes.length ? ` (${notes.join('; ')})` : ''}` } },
      u: null,
    };
  }

  function wantsNullRetry(msg) {
    if (!nullRetry.has(msg.method) || cfg.nullRetryMax <= 0) return false;
    if (msg.method === 'eth_getBlockByNumber') return blockRef(msg.params?.[0]).num !== undefined;
    return true;
  }

  // A null from one node (receipt not indexed yet, block not there yet) is worth asking a couple of others about.
  async function retryNull(msg, req, servedBy, deadline, ctx) {
    const now = Date.now();
    if (gone(ctx)) return undefined;
    const alt = orderFor([req], { exclude: new Set(servedBy ? [servedBy] : []) })
      .filter((u) => u.openUntil <= now).slice(0, cfg.nullRetryMax);
    if (!alt.length) return undefined;
    const results = await Promise.all(alt.map(async (u) => {
      const left = deadline - Date.now();
      if (left <= 50) return undefined;
      const r = await post(u, { jsonrpc: '2.0', id: 1, method: msg.method, params: msg.params ?? [] }, Math.min(req.timeout, left));
      if (!r.ok) { account(u, r.kind, { retryAfter: r.retryAfter }); return undefined; }
      if (!isResponse(r.body) || r.body.error) return undefined;
      account(u, 'ok', { ms: r.ms });
      return r.body.result;
    }));
    const found = results.find((v) => v !== undefined && v !== null);
    if (found !== undefined) gbump('nullRescues');
    return found;
  }

  // Is this exact transaction on chain? Asked of the node that said "nonce too low" and up to two others at once:
  // behind a load balancer, the backend that answers the lookup may not be the one that saw the tx.
  async function txOnChain(hash, first) {
    const now = Date.now();
    const others = orderFor([{ method: 'eth_getTransactionByHash', fresh: true, minBlock: null, capKey: 'eth_getTransactionByHash' }], { exclude: new Set([first]) })
      .filter((u) => u.openUntil <= now).slice(0, 2);
    const found = await Promise.all([first, ...others].map(async (u) => {
      const q = await post(u, { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash', params: [hash] }, Math.min(3_000, cfg.timeoutMs));
      return q.ok && isObj(q.body?.result);
    }));
    return found.some(Boolean);
  }

  // eth_sendRawTransaction(Conditional): primary healthy upstream first (deterministic, no weighted pick).
  // "already known" is a success. "nonce too low" is the answer, unless this exact tx is already on chain (an earlier
  // attempt that timed out landed): then it is a success. Underpriced replacements are the answer. Any other error
  // (including "nonce too high", which a lagging backend says right after the previous tx landed) tries the next.
  // Sending the same signed bytes to a second node cannot execute twice: one hash, one nonce.
  async function sendRaw(msg, ctx) {
    const raw = msg.params?.[0];
    // Every node forwards to the sequencer, but one stuck far behind may not: prefer fresh ones, lagging as fallback.
    const req = { method: msg.method, fresh: true, minBlock: null, capKey: msg.method, timeout: cfg.timeoutMs };
    const order = orderFor([req], { deterministic: true });
    const deadline = Date.now() + cfg.deadlineMs;
    let lastRpcErr = null;
    const notes = [];
    for (let i = 0; i < order.length; i++) {
      const u = order[i];
      const left = deadline - Date.now();
      if (left <= 50) break;
      if (gone(ctx, notes)) break;
      const r = await post(u, { jsonrpc: '2.0', id: 1, method: msg.method, params: msg.params ?? [] }, Math.min(req.timeout, left));
      if (!r.ok || !isResponse(r.body)) {
        const why = r.ok ? 'malformed response' : r.message;
        account(u, r.ok ? 'transient' : r.kind, { retryAfter: r.retryAfter });
        notes.push(`${u.name}: ${why}`);
        moved(u, msg.method, why, order[i + 1]);
        continue;
      }
      if (r.body.error === undefined || r.body.error === null) {
        account(u, 'ok', { ms: r.ms });
        return { result: r.body.result };
      }
      const e = normErr(r.body.error);
      if (RE_KNOWN_TX.test(e.message)) {
        account(u, 'ok', { ms: r.ms });
        const h = txHashOf(raw);
        if (h) { gbump('sendKnown'); return { result: h }; }
        return { error: e };
      }
      if (RE_NONCE_LOW.test(e.message)) {
        account(u, 'ok', { ms: r.ms });
        const h = txHashOf(raw);
        if (h && await txOnChain(h, u)) { gbump('sendKnown'); return { result: h }; }
        return { error: e };
      }
      if (RE_NONCE_OTHER.test(e.message)) {
        account(u, 'ok', { ms: r.ms });
        return { error: e };
      }
      const cls = classifyError(e);
      account(u, cls === 'final' ? 'ok' : cls, { ms: r.ms, retryAfter: r.retryAfter });
      lastRpcErr = e;
      notes.push(`${u.name}: ${short(e.message, 80)}`);
      moved(u, msg.method, e.message, order[i + 1]);
    }
    gbump('errors');
    return { error: lastRpcErr ?? { code: -32603, message: `xgas-rpc: no upstream accepted the transaction${notes.length ? ` (${notes.join('; ')})` : ''}` } };
  }

  // Everything one JSON-RPC message needs, minus the id (callers put the caller's id back).
  async function dispatch(msg, ctx) {
    if (!isObj(msg) || typeof msg.method !== 'string') return { error: { code: -32600, message: 'invalid request' } };
    gbump('calls');
    if (msg.method === 'eth_chainId') { gbump('local'); return { result: chainHex }; }
    if (msg.method === 'net_version') { gbump('local'); return { result: String(cfg.chainId) }; }
    if (SENDS.has(msg.method)) return sendRaw(msg, ctx);
    const deadline = Date.now() + cfg.deadlineMs;
    if (FILTER_USE.has(msg.method)) {
      const id = String(msg.params?.[0] ?? '').toLowerCase();
      const pin = filters.get(id);
      if (pin) {
        pin.at = Date.now();
        const req = describe(msg.method, msg.params);
        const { body } = await forwardOne(msg, req, [pin.u], deadline, ctx);
        if (msg.method === 'eth_uninstallFilter') filters.delete(id);
        return body;
      }
    }
    const req = describe(msg.method, msg.params);
    await ensureHeads([req]);
    // Filters live on one node. A pending nonce goes where sends go (the same deterministic pick), so a wallet that
    // sends and then asks for its next nonce reads its own write instead of a random node that hasn't seen it yet.
    const sticky = FILTER_NEW.has(msg.method)
      || (msg.method === 'eth_getTransactionCount' && blockRef(msg.params?.[1]).tag === 'pending');
    const order = orderFor([req], { deterministic: sticky });
    if (!order.length && req.minBlock !== null && ups.some((u) => u.verified && !u.dropped)) {
      gbump('errors');
      return { error: { code: -32000, message: `xgas-rpc: no upstream can serve ${msg.method} through block ${req.minBlock} yet (unknown block)` } };
    }
    const { body, u } = await forwardOne(msg, req, order, deadline, ctx);
    if (FILTER_NEW.has(msg.method) && u && typeof body.result === 'string') {
      if (filters.size >= cfg.maxFilters) filters.delete(filters.keys().next().value); // oldest first
      filters.set(body.result.toLowerCase(), { u, at: Date.now() });
    }
    if (body.result === null && wantsNullRetry(msg)) {
      const v = await retryNull(msg, req, u, deadline, ctx);
      if (v !== undefined) return { result: v };
    }
    return body;
  }

  // ---------------------------------------------------------------- batches
  // The batch goes to the best upstream as a batch. Items that come back with a fail-over error (or not at all) go,
  // as a smaller batch, to the next upstream, and so on. Ids and order are the caller's. An eth_getLogs item that
  // would be unsafe on an upstream (clamping, range near its head) is held back from that upstream only.
  async function forwardBatch(arr, idxs, out, ctx) {
    gbump('calls', idxs.length);
    const reqs = idxs.map((i) => describe(arr[i].method, arr[i].params));
    const batchReq = { method: '__batch', fresh: false, minBlock: null, capKey: '__batch', timeout: 0 };
    const deadline = Date.now() + cfg.deadlineMs;
    await ensureHeads(reqs);
    const order = orderFor([...reqs, batchReq], { batch: true });
    const lastErr = new Map(), servedBy = new Map();
    const notes = [];
    let pending = idxs.map((_, k) => k);
    for (let oi = 0; oi < order.length && pending.length; oi++) {
      const u = order[oi];
      const left = deadline - Date.now();
      if (left <= 50) { notes.push('deadline reached'); break; }
      if (gone(ctx, notes)) break;
      const sent = pending.filter((k) => !logsUnsafe(u, reqs[k]));
      if (!sent.length) continue;
      const held = pending.filter((k) => logsUnsafe(u, reqs[k]));
      const payload = sent.map((k, j) => ({ jsonrpc: '2.0', id: j, method: arr[idxs[k]].method, params: arr[idxs[k]].params ?? [] }));
      const timeout = Math.max(...sent.map((k) => reqs[k].timeout));
      const r = await post(u, payload, Math.min(timeout, left));
      if (!r.ok || !Array.isArray(r.body)) {
        // the whole batch was refused: same items, next upstream
        let kind = r.ok ? 'transient' : r.kind, why = r.ok ? 'non-array batch response' : r.message;
        if (r.ok && isResponse(r.body) && r.body.error) {
          const e = normErr(r.body.error);
          kind = classifyError(e);
          if (kind === 'final' || kind === 'lag') kind = 'capability';
          why = e.message;
          for (const k of sent) lastErr.set(k, e);
        }
        account(u, kind, { retryAfter: r.retryAfter, capKeys: kind === 'capability' ? ['__batch'] : [] });
        notes.push(`${u.name}: ${short(why, 80)}`);
        moved(u, `batch(${sent.length})`, why, order[oi + 1]);
        continue;
      }
      const byId = new Map();
      for (const item of r.body) if (isObj(item)) byId.set(Number(item.id), item);
      const still = [...held];
      const capFail = [], capOk = [];
      let okN = 0, rateN = 0, transN = 0, why = '';
      sent.forEach((k, j) => {
        const item = byId.get(j);
        if (!isResponse(item)) { still.push(k); transN++; why ||= 'item missing from batch response'; return; }
        if (item.error !== undefined && item.error !== null) {
          const e = normErr(item.error), cls = classifyFor(reqs[k], e);
          if (cls !== 'final') {
            still.push(k); lastErr.set(k, e); why ||= e.message;
            if (cls === 'capability') capFail.push(reqs[k].capKey);
            else if (cls === 'ratelimit') rateN++;
            else if (cls === 'transient') transN++;
            return;
          }
          out[idxs[k]] = { error: e };
        } else {
          out[idxs[k]] = { result: item.result };
          observe(u, arr[idxs[k]].method, arr[idxs[k]].params, item.result);
        }
        okN++; capOk.push(reqs[k].capKey); servedBy.set(k, u);
      });
      if (okN > 0) account(u, 'ok', { ms: r.ms, capKeys: capOk });
      else account(u, rateN ? 'ratelimit' : transN ? 'transient' : capFail.length ? 'capability' : 'lag', { retryAfter: r.retryAfter });
      penalize(u, capFail);
      if (still.length > held.length) {
        notes.push(`${u.name}: ${short(why, 80)}`);
        moved(u, `batch(${still.length - held.length}/${sent.length})`, why, order[oi + 1]);
      }
      still.sort((x, y) => x - y);
      pending = still;
    }
    for (const k of pending) {
      const m = arr[idxs[k]];
      const fallback = notes.length || reqs[k].minBlock === null
        ? `xgas-rpc: no upstream answered ${m.method}${notes.length ? ` (${notes.join('; ')})` : ''}`
        : `xgas-rpc: no upstream can serve ${m.method} through block ${reqs[k].minBlock} yet (unknown block)`;
      out[idxs[k]] = { error: lastErr.get(k) ?? { code: notes.length ? -32603 : -32000, message: fallback } };
    }
    if (pending.length) gbump('errors', pending.length);
    // null rescue for at most NULL_RETRY_BATCH_ITEMS items: a big batch of missing receipts must not fan out 3x
    const nulls = idxs.map((i, k) => [i, k]).filter(([i]) => out[i] && !out[i].error && out[i].result === null && wantsNullRetry(arr[i]))
      .slice(0, cfg.nullRetryBatchItems);
    await Promise.all(nulls.map(async ([i, k]) => {
      const v = await retryNull(arr[i], reqs[k], servedBy.get(k), deadline, ctx);
      if (v !== undefined) out[i] = { result: v };
    }));
  }

  async function handleBatch(arr, ctx) {
    if (arr.length === 0) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'empty batch' } };
    if (arr.length > cfg.maxBatch) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: `batch larger than ${cfg.maxBatch}` } };
    gbump('batches'); gbump('batchItems', arr.length);
    const out = new Array(arr.length);
    const plain = [], special = [];
    arr.forEach((m, i) => {
      if (!isObj(m) || typeof m.method !== 'string') out[i] = { error: { code: -32600, message: 'invalid request' } };
      else if (LOCAL.has(m.method) || SENDS.has(m.method) || FILTER_NEW.has(m.method) || FILTER_USE.has(m.method)) special.push(i);
      else plain.push(i);
    });
    await Promise.all([
      ...special.map(async (i) => { out[i] = await dispatch(arr[i], ctx); }),
      plain.length ? forwardBatch(arr, plain, out, ctx) : null,
    ]);
    const resp = [];
    arr.forEach((m, i) => {
      if (isObj(m) && typeof m.method === 'string' && !('id' in m)) return; // notification: no response
      resp.push(withId(out[i], isObj(m) ? (m.id ?? null) : null));
    });
    return resp.length ? resp : undefined;
  }

  async function handleSingle(msg, ctx) {
    const body = await dispatch(msg, ctx);
    if (isObj(msg) && typeof msg.method === 'string' && !('id' in msg)) return undefined;
    return withId(body, isObj(msg) ? (msg.id ?? null) : null);
  }

  // ---------------------------------------------------------------- stats, health
  function status(u, now = Date.now()) {
    if (u.dropped) return 'dropped';
    if (!u.verified) return 'unverified';
    if (u.openUntil > now) return 'open';
    if (u.cooldownUntil > now) return 'cooldown';
    if (!isFresh(u, now)) return 'stale';
    if (u.lag !== null && u.lag > cfg.maxLagBlocks) return 'lagging';
    return 'ok';
  }

  function health() {
    const now = Date.now();
    const usable = ups.filter((u) => u.verified && !u.dropped && u.openUntil <= now);
    return {
      ok: usable.length > 0, chainId: cfg.chainId, head: maxHead, usable: usable.length,
      upstreams: ups.map((u) => ({ name: u.name, status: status(u, now), lag: u.lag })),
    };
  }

  function statsJson() {
    const now = Date.now();
    const avg = (c) => (c.ok ? Math.round(c.ms / c.ok) : null);
    return {
      chainId: cfg.chainId, uptimeSec: Math.round((now - startedAt) / 1000), head: maxHead,
      config: {
        strategy: cfg.strategy, maxLagBlocks: cfg.maxLagBlocks, timeoutMs: cfg.timeoutMs, logsTimeoutMs: cfg.logsTimeoutMs,
        breakerFails: cfg.breakerFails, breakerMs: cfg.breakerMs, headPollMs: cfg.headPollMs,
        deadlineMs: cfg.deadlineMs, clampMarginBlocks: cfg.clampMarginBlocks,
      },
      totals: g.total, lastMinute: g.lastMinute, currentMinute: g.minute,
      upstreams: ups.map((u) => ({
        name: u.name, host: u.host, weight: u.weight, status: status(u, now),
        head: u.head, lag: u.lag, lastPollAgoMs: u.lastPollOk ? now - u.lastPollOk : null,
        score: Number(score(u).toFixed(3)), consecFails: u.consecFails,
        openForMs: Math.max(0, u.openUntil - now), cooldownForMs: Math.max(0, u.cooldownUntil - now),
        clampsLogs: u.clampsLogs === null ? 'unknown' : u.clampsLogs, skipping: [...u.caps].filter(([, e]) => e.until > now).map(([k]) => k),
        totals: { ...u.total, avgMs: avg(u.total) }, lastMinute: { ...u.lastMinute, avgMs: avg(u.lastMinute) },
      })),
    };
  }

  function flushStats() {
    const now = Date.now();
    const m = g.minute;
    const parts = ups.map((u) => {
      const c = u.minute, st = status(u, now);
      return `${u.name} ok=${c.ok} fo=${c.failovers} 429=${c.r429} to=${c.timeouts} lag=${u.lag ?? '?'}${c.ok ? ` ${Math.round(c.ms / c.ok)}ms` : ''}${st === 'ok' ? '' : ' ' + st}`;
    });
    log(`[stats] ${Math.round(cfg.statsIntervalMs / 1000)}s head=${maxHead ?? '?'} calls=${m.calls} batches=${m.batches} local=${m.local} errors=${m.errors} failovers=${m.failovers}${m.abandoned ? ` abandoned=${m.abandoned}` : ''}`
      + `${failoverLogsSuppressed ? ` (+${failoverLogsSuppressed} failover lines suppressed)` : ''} | ${parts.join(' | ')}`);
    g.lastMinute = m; g.minute = newGlobal();
    for (const u of ups) { u.lastMinute = u.minute; u.minute = newCounters(); }
    failoverLogs = 0; failoverLogsSuppressed = 0;
    for (const [id, f] of filters) if (now - f.at > 15 * 60_000) filters.delete(id);
    for (const u of ups) pruneCaps(u, now);
  }

  // ---------------------------------------------------------------- HTTP
  function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > cfg.maxBodyBytes) { reject(new Error('request body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const path = (req.url || '/').split('?')[0];
      if (req.method === 'GET' && path === '/health') { const h = health(); return sendJson(res, h.ok ? 200 : 503, h); }
      if (req.method === 'GET' && path === '/stats') return sendJson(res, 200, statsJson());
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST a JSON-RPC request, or GET /health or /stats' });
      let text;
      try { text = await readBody(req); } catch (e) { return sendJson(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: e.message } }); }
      let msg;
      try { msg = JSON.parse(text); } catch { return sendJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
      // The caller hanging up before the answer stops further failovers for it (in-flight attempts still finish,
      // so an upstream is never blamed for our own abort).
      const ctx = { aborted: false };
      res.once('close', () => { if (!res.writableFinished) ctx.aborted = true; });
      const out = Array.isArray(msg) ? await handleBatch(msg, ctx) : await handleSingle(msg, ctx);
      if (ctx.aborted) return undefined;
      if (out === undefined) { res.writeHead(204); return res.end(); }
      return sendJson(res, 200, out);
    } catch (e) {
      log(`[error] ${e?.stack || e}`);
      if (!res.headersSent) sendJson(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'xgas-rpc internal error' } });
    }
  });
  // Idle keep-alive must outlast the clients' own idle timeout (Go's http.Transport, which Nitro uses: 90s), so the
  // client always closes an idle connection first. The other way round, a POST written just as we close it fails
  // with EOF, which Nitro's parent-chain client does not retry.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;

  async function start() {
    for (const w of cfg.warnings || []) log(`[boot] ${w}`);
    if (!ups.length) log('[boot] no upstreams configured');
    await Promise.all(ups.map(verify));
    if (!ups.some((u) => u.verified)) log('[boot] WARNING: no upstream verified yet; every request fails and /health is 503 until one answers');
    await pollHeads();
    if (cfg.headPollMs > 0) timers.push(setInterval(() => { pollHeads().catch(() => {}); }, cfg.headPollMs));
    timers.push(setInterval(() => {
      const now = Date.now();
      for (const u of ups) {
        if (!u.verified && !u.dropped) verify(u).catch(() => {});
        // an inconclusive clamp probe is repeated every minute, a strict verdict every 3 (an LB's next backend may
        // clamp: staccpad passed one boot probe and failed the next)
        else if (u.verified && !u.dropped && u.clampsLogs !== true
          && now - u.clampProbeAt > (u.clampsLogs === null ? cfg.clampReprobeMs : 3 * cfg.clampReprobeMs)) {
          detectClamp(u).then(() => { if (u.clampsLogs === true) log(`[probe] ${u.name} answers eth_getLogs past its head with []: ranges near its head go elsewhere`); }).catch(() => {});
        }
      }
    }, cfg.verifyRetryMs));
    if (cfg.statsIntervalMs > 0) timers.push(setInterval(flushStats, cfg.statsIntervalMs));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, cfg.host, () => { server.off('error', reject); resolve(); });
    });
    const a = server.address();
    log(`[boot] xgas-rpc listening on ${typeof a === 'string' ? a : `[${a.address}]:${a.port}`}: chain ${cfg.chainId}, ${ups.filter((u) => u.verified).length}/${ups.length} upstreams verified`
      + ` (${ups.map((u) => `${u.name}=${u.host} w${u.weight}`).join(', ')}), strategy ${cfg.strategy}, max lag ${cfg.maxLagBlocks} blocks`);
    return a;
  }

  // graceMs > 0 (SIGTERM/SIGINT): stop accepting, drop idle keep-alive connections, let in-flight requests finish for
  // up to graceMs, then cut whatever is left. graceMs 0 (tests): cut everything now.
  async function close({ graceMs = 0 } = {}) {
    for (const t of timers) clearInterval(t);
    timers.length = 0;
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
      if (graceMs > 0) setTimeout(() => server.closeAllConnections?.(), graceMs).unref();
      else server.closeAllConnections?.();
    });
  }

  return {
    start, close, server, health, stats: statsJson, flushStats, pollHeads,
    address: () => server.address(),
    state: { upstreams: ups, get maxHead() { return maxHead; }, filters },
    _internals: { describe, orderFor, classifyError },
  };
}

// ------------------------------------------------------------------------------------------------ main
async function main() {
  const cfg = configFromEnv(process.env);
  const proxy = createProxy(cfg);
  // fly.toml kill_timeout is 10s: in-flight requests get 8s to finish (a batch post or a failover chain mid-way).
  const graceMs = num(process.env.SHUTDOWN_GRACE_MS, 8_000);
  let stopping = false;
  const stop = (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`[exit] ${sig}: finishing in-flight requests (up to ${Math.round(graceMs / 1000)}s)`);
    proxy.close({ graceMs }).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), graceMs + 1_000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  await proxy.start();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`[fatal] ${e?.stack || e}`); process.exit(1); });
}
