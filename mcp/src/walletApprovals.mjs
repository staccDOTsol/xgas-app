// Human approval for the custodial agent wallet, and the one place that wallet actually sends from.
//
// wallet_execute prepares, decodes and values a transaction (walletPolicy.mjs). Inside the caps and the allowlist it
// sends at once. Outside them it files an approval here and returns a link, https://xgas.dev/approve/<id>, that:
//   - only the wallet's owner can use, signed in with X in a browser (a connector token is not a session, so the
//     model holding one cannot approve anything);
//   - shows the exact steps it will send, decoded, with destinations, amounts and fees;
//   - expires after ten minutes and works once.
// On approval the host sends exactly the stored steps, nothing re-prepared, and wallet_approval_status reports how
// it went. The page lives in server.js; this module is the state behind it, so over stdio (no page) the approval
// path is closed and a request outside the policy is refused with the reason.
//
// Concurrency. Two wallet_execute calls with the same idempotency key (parallel tool calls, or a client retrying
// while the first waits for a receipt) must not both send. So the key is claimed synchronously, before anything is
// awaited, in an in-process set, and persisted as "executing" before the first signature; a second caller is told it
// is already in progress. Each spend reservation carries its own ref, so settling one can never drop another's.
// And every send from one wallet, auto or approved, runs under that wallet's lock, one at a time, so two sends never
// sign the same pending nonce.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { clientFor, assertChains, XGAS_API } from './config.mjs';
import { reply, renderApproval } from './approval.mjs';
import { agentWallet as defaultAgentWallet, signStep as defaultSignStep, privyConfigured as defaultPrivyConfigured, NOT_CONFIGURED } from './privy.mjs';
import { actorKey, actorLabel, currentActor, runAs } from './actor.mjs';
import { record as defaultRecord, recorded as defaultRecorded, submitRaw as defaultSubmitRaw } from './idempotency.mjs';
import { evaluate as defaultEvaluate, liveContext, policyConfig, spendLedger, verdictText, usd } from './walletPolicy.mjs';

const DATA_DIR = process.env.XGAS_MCP_DATA
  || (fs.existsSync('/data') ? '/data' : path.join(process.env.HOME || '.', '.xgas-mcp'));
fs.mkdirSync(DATA_DIR, { recursive: true });

const MAX_PENDING_PER_WALLET = 5;
const KEEP_MS = 7 * 24 * 3600 * 1000;

/** Idempotency keys (namespaced per caller) whose execution is running in this process right now. */
export const inflightKeys = new Set();

// One send at a time per wallet address: a promise chain per address. A failure does not break the chain.
const walletQueues = new Map();
export function withWalletLock(address, fn) {
  const k = String(address).toLowerCase();
  const prev = walletQueues.get(k) || Promise.resolve();
  const run = prev.then(() => fn());
  const tail = run.then(() => {}, () => {});
  walletQueues.set(k, tail);
  tail.then(() => { if (walletQueues.get(k) === tail) walletQueues.delete(k); });
  return run;
}
const reservationRef = (nsKey) => `${nsKey}#${crypto.randomBytes(8).toString('hex')}`;

// ---------------------------------------------------------------------------------------------------------------
// The approval page host. server.js registers itself at boot; nothing else does, so over stdio this stays null.
// ---------------------------------------------------------------------------------------------------------------
let pageHost = null;
export function enableApprovalPage({ origin } = {}) {
  pageHost = { origin: typeof origin === 'function' ? origin : () => origin || XGAS_API };
}
export function disableApprovalPage() { pageHost = null; }
const approvalUrl = (id) => `${String(pageHost.origin()).replace(/\/+$/, '')}/approve/${id}`;

/** The X account that may approve for this caller's wallet: the person themselves, or whoever the host names for the operator. */
export function ownerXId(actor = currentActor()) {
  if (actor.kind === 'user') return String(actor.id);
  return process.env.XGAS_WALLET_OPERATOR_X_ID ? String(process.env.XGAS_WALLET_OPERATOR_X_ID) : null;
}
export const approvalsAvailable = (actor = currentActor()) => !!pageHost && !!ownerXId(actor);

// ---------------------------------------------------------------------------------------------------------------
// The store: one JSON file, written whole and renamed into place, so a crash leaves the old file or the new one.
// ---------------------------------------------------------------------------------------------------------------
export function createApprovalStore(file = path.join(DATA_DIR, 'wallet-approvals.json')) {
  let items = {};
  try { if (file && fs.existsSync(file)) items = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) {
    console.error(`[wallet-approvals] ${file} is unreadable (${e.message}); starting empty. Pending approvals in it are void.`);
    items = {};
  }
  // A process that died mid-execution leaves "executing" behind. Nobody knows how far it got except the chain.
  for (const r of Object.values(items)) {
    if (r.status === 'executing') {
      r.status = 'interrupted';
      r.result = { ok: false, error: 'The host restarted while this was sending. Check the hashes below on chain before trying again.' };
    }
  }
  const save = () => {
    const cutoff = Date.now() - KEEP_MS;
    for (const [id, r] of Object.entries(items)) if (r.created_ms < cutoff) delete items[id];
    if (!file) return;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(items), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const expire = (r, now = Date.now()) => {
    if (r && r.status === 'pending' && now > r.expires_ms) { r.status = 'expired'; save(); }
    return r;
  };
  return {
    save,
    get: (id, now) => (typeof id === 'string' && Object.prototype.hasOwnProperty.call(items, id) ? expire(items[id], now) : null),
    put: (r) => { items[r.id] = r; save(); return r; },
    all: (now) => Object.values(items).map((r) => expire(r, now)),
  };
}

export const approvalStore = createApprovalStore();

function newId() {
  return crypto.randomBytes(18).toString('base64url'); // 144 bits, URL-safe, 24 characters
}

/** File a request for approval, or return the live one already filed under the same idempotency key. */
export function createApproval({ actor, wallet, tool, args, idempotencyKey, envelope, verdict, store = approvalStore, now = Date.now(), ttlS = policyConfig().approvalTtlS }) {
  const key = actorKey(actor);
  const mine = store.all(now).filter((r) => r.actor_key === key && r.wallet.address.toLowerCase() === wallet.address.toLowerCase());
  const same = mine.find((r) => r.idempotency_key === idempotencyKey && ['pending', 'executing', 'executed'].includes(r.status));
  if (same) return { rec: same, reused: true };
  if (mine.filter((r) => r.status === 'pending').length >= MAX_PENDING_PER_WALLET) {
    return { error: `This wallet already has ${MAX_PENDING_PER_WALLET} approvals waiting. Let them expire (${Math.round(ttlS / 60)} minutes) or have the owner decide on them first.` };
  }
  const rec = {
    id: newId(),
    status: 'pending',
    created_ms: now,
    expires_ms: now + ttlS * 1000,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlS * 1000).toISOString(),
    actor: { kind: actor.kind, id: String(actor.id), handle: actor.handle || null, label: actor.label || null },
    actor_key: key,
    owner_x_id: ownerXId(actor),
    owner_label: actorLabel(actor),
    wallet: { address: wallet.address, id: wallet.id },
    tool,
    args,
    idempotency_key: idempotencyKey,
    terms: envelope.approval,
    transactions: envelope.transactions,
    policy: { reasons: verdict.reasons, steps: verdict.steps, total_usd: verdict.total_usd, notes: verdict.notes || [], spent_24h_usd: verdict.spent_24h_usd, caps: verdict.caps },
    hashes: [],
    result: null,
    decided_at: null,
  };
  store.put(rec);
  return { rec, reused: false };
}

/** What the page, the JSON route and the status tool show. Never the raw args object: it is in the steps already. */
export function approvalView(r) {
  return {
    id: r.id,
    status: r.status,
    created_at: r.created_at,
    expires_at: r.expires_at,
    decided_at: r.decided_at,
    owner: r.owner_label,
    wallet: r.wallet.address,
    tool: r.tool,
    terms: r.terms,
    steps: r.policy.steps,
    transactions: r.transactions,
    reasons: r.policy.reasons,
    total_usd: r.policy.total_usd,
    total_notes: r.policy.notes || [],
    hashes: r.hashes,
    result: r.result,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Sending. One loop, shared by the direct path and the approved path, so they cannot drift apart.
// ---------------------------------------------------------------------------------------------------------------
const defaultWaitReceipt = (chainId, hash) => clientFor(chainId).waitForTransactionReceipt({ hash, timeout: 180_000 });

export async function runSteps(steps, { kind, signStep = defaultSignStep, submitRaw = defaultSubmitRaw, waitReceipt = defaultWaitReceipt, onHash } = {}) {
  const hashes = [];
  for (const [i, step] of steps.entries()) {
    const n = i + 1;
    let signed;
    try {
      signed = await signStep({ chainId: step.chainId, to: step.to, data: step.data, value: BigInt(step.value) });
    } catch (e) {
      return { ok: false, hashes, failed_step: n, label: step.label, error: `could not be signed: ${e.shortMessage || e.message}` };
    }
    let res;
    try {
      res = await submitRaw({ chainId: step.chainId, signedTx: signed.signedTransaction, kind });
    } catch (e) {
      return { ok: false, hashes, failed_step: n, label: step.label, error: `could not be broadcast: ${e.shortMessage || e.message}` };
    }
    hashes.push(res.hash);
    if (onHash) onHash(res.hash);
    let rc;
    try {
      rc = await waitReceipt(step.chainId, res.hash);
    } catch (e) {
      return { ok: false, hashes, failed_step: n, label: step.label, error: `was sent as ${res.hash} but no receipt came back (${e.shortMessage || e.message}); check it on chain`, unknown: true };
    }
    if (rc.status !== 'success') return { ok: false, hashes, failed_step: n, label: step.label, reverted: res.hash, error: `reverted on chain: ${res.hash}` };
  }
  return { ok: true, hashes };
}

/** A failed run in words. With a revert or a missing receipt the last hash is the failing step itself. */
function failText(r) {
  const earlier = r.reverted || r.unknown ? r.hashes.slice(0, -1) : r.hashes;
  return `Step ${r.failed_step} (${r.label}) ${r.error}.`
    + (earlier.length ? ` Earlier steps already went through: ${earlier.join(', ')}. Those cannot be undone.` : ' No earlier step was sent.')
    + ' Nothing after it was sent.';
}

/**
 * The owner decided. Approve runs the stored steps as the stored wallet; reject closes it. Single use: only a
 * pending, unexpired approval changes state, and it changes before anything is sent.
 */
export function decideApproval(id, xUserId, decision, deps = {}) {
  const store = deps.store || approvalStore;
  const now = deps.now ?? Date.now();
  const rec = store.get(id, now);
  if (!rec) return { http: 404, error: 'No such approval.' };
  if (!rec.owner_x_id || String(rec.owner_x_id) !== String(xUserId)) return { http: 403, error: 'This approval belongs to another account.' };
  if (rec.status === 'expired') return { http: 410, error: 'This approval expired. Nothing was sent. Ask your agent to prepare it again.', rec };
  if (rec.status !== 'pending') return { http: 409, error: `This approval was already used (${rec.status}).`, rec };
  rec.decided_at = new Date(now).toISOString();
  if (decision === 'reject') {
    rec.status = 'rejected';
    rec.result = { ok: false, error: 'Rejected by the owner. Nothing was sent.' };
    store.put(rec);
    return { http: 200, rec };
  }
  if (decision !== 'approve') return { http: 400, error: 'Unknown decision.' };
  rec.status = 'executing';
  store.put(rec);
  const done = executeApproved(rec, deps).catch((e) => {
    rec.status = 'failed';
    rec.result = { ok: false, error: e.shortMessage || e.message || String(e) };
    store.put(rec);
  });
  return { http: 202, rec, done };
}

async function executeApproved(rec, deps = {}) {
  const store = deps.store || approvalStore;
  const ledger = deps.ledger || spendLedger;
  const agentWallet = deps.agentWallet || defaultAgentWallet;
  const recordFn = deps.record || defaultRecord;
  const checkChains = deps.assertChains || assertChains;
  await runAs(rec.actor, async () => {
    const w = await agentWallet();
    if (!w || w.address.toLowerCase() !== rec.wallet.address.toLowerCase()) {
      throw new Error(`The wallet for ${rec.owner_label} is no longer ${rec.wallet.address}. Nothing was sent.`);
    }
    await checkChains('wallet approval');
    const res = await withWalletLock(rec.wallet.address, () => runSteps(rec.transactions, {
      kind: `wallet_approval:${rec.tool}`,
      signStep: deps.signStep, submitRaw: deps.submitRaw, waitReceipt: deps.waitReceipt,
      onHash: (h) => { rec.hashes.push(h); store.put(rec); },
    }));
    // Approved spending counts toward the rolling 24 hours too; the cap limits what runs without a person, not what a person allows.
    if (res.hashes.length && Number.isFinite(rec.policy.total_usd)) ledger.add(rec.wallet.address, rec.policy.total_usd, `approval:${rec.id}`);
    rec.status = res.ok ? 'executed' : 'failed';
    rec.result = res.ok ? { ok: true } : { ok: false, error: failText(res), failed_step: res.failed_step, reverted: res.reverted || null };
    store.put(rec);
    if (res.ok) {
      recordFn(`wallet_execute:${rec.actor_key}:${rec.idempotency_key}`, {
        state: 'executed', hashes: res.hashes, hash: res.hashes[res.hashes.length - 1], tool: rec.tool, wallet: rec.wallet.address, kind: 'wallet_execute', approval_id: rec.id,
      });
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------
// wallet_execute and wallet_approval_status. Dependencies are injectable so tests can run the whole flow offline.
// ---------------------------------------------------------------------------------------------------------------
function defaults() {
  return {
    privyConfigured: defaultPrivyConfigured,
    agentWallet: defaultAgentWallet,
    resolveTool: async (name) => {
      // lazy: the registry imports the wallet tools, so importing it at load time would cycle
      const { TOOLS_BY_NAME, unwrap } = await import('./registry.mjs');
      const t = TOOLS_BY_NAME.get(name);
      return t ? { tool: t, unwrap } : null;
    },
    ctx: null,
    evaluate: defaultEvaluate,
    ledger: spendLedger,
    store: approvalStore,
    record: defaultRecord,
    recorded: defaultRecorded,
    signStep: defaultSignStep,
    submitRaw: defaultSubmitRaw,
    waitReceipt: defaultWaitReceipt,
    approvalsAvailable,
    inflight: inflightKeys,
    now: () => Date.now(),
  };
}

const EXECUTABLE = /^(prepare_|post_|take_|launch_|release_|cancel_|reclaim_)/;
const ADDRESS_FIELDS = ['from', 'to', 'destination', 'l3_recipient', 'holder', 'address'];

export async function walletExecute({ tool, args = {}, idempotency_key, confirm } = {}, overrides = {}) {
  const d = { ...defaults(), ...overrides };
  if (!d.privyConfigured()) return reply(NOT_CONFIGURED, { configured: false });
  const w = await d.agentWallet();
  if (!w) return reply('No wallet yet. Call wallet_create first.', { wallet: null });
  if (typeof idempotency_key !== 'string' || !idempotency_key.trim()) {
    return reply('idempotency_key is required: a repeat with the same key returns the first result instead of sending again.', { blocked: 'missing_idempotency_key' });
  }
  const actor = currentActor();
  const nsKey = `wallet_execute:${actorKey(actor)}:${idempotency_key}`;
  // From here to the claim below nothing is awaited, so no second call can slip in between the check and the claim.
  if (d.inflight.has(nsKey)) {
    return reply('Already in progress under this idempotency key; nothing new was prepared or sent. Wait for the first call to return, then call again with the same key to get its result.', { executed: false, in_progress: true, blocked: 'in_progress' });
  }
  // Keys used to be global; a record from before carries the wallet it ran as, and only that wallet may replay it.
  const legacy = d.recorded(idempotency_key);
  const prior = d.recorded(nsKey) || (legacy && legacy.kind === 'wallet_execute' && legacy.wallet === w.address ? legacy : null);
  if (prior && (prior.state === 'executing' || prior.state === 'unknown')) {
    return reply(
      `An execution under this key started at ${prior.started_at || prior.at} and never recorded how it ended (the host may have restarted mid-send). `
      + `Nothing was re-sent. Check ${prior.wallet || w.address} on chain first; if nothing went out, use a new idempotency key.`,
      { ...prior, executed: null, replayed: true, blocked: 'unfinished' },
    );
  }
  if (prior && prior.state === 'failed') {
    return reply(`Already tried under this key and it failed after sending; nothing re-sent. ${prior.error || ''} Hashes: ${JSON.stringify(prior.hashes || [])}. Use a new idempotency key to try again.`, { ...prior, executed: false, replayed: true });
  }
  // state 'not_sent': the last attempt under this key broadcast nothing, so it may run again.
  if (prior && prior.state !== 'not_sent') return reply(`Already executed under this key; nothing re-sent. ${JSON.stringify(prior.hashes || prior.hash)}`, { ...prior, replayed: true });

  // An approval already filed under this key answers the call: re-preparing would build a second request.
  const filed = d.store.all(d.now()).find((r) => r.actor_key === actorKey(actor) && r.idempotency_key === idempotency_key
    && r.wallet.address.toLowerCase() === w.address.toLowerCase() && ['pending', 'executing', 'executed'].includes(r.status));
  if (filed) return statusReply(filed, 'An approval is already filed under this idempotency key; nothing new was prepared.');

  d.inflight.add(nsKey);
  try {
    return await executeClaimed({ d, w, actor, nsKey, tool, args, idempotency_key, confirm });
  } finally {
    d.inflight.delete(nsKey);
  }
}

/** Everything after the key is claimed. Only walletExecute calls this, and only while it holds nsKey. */
async function executeClaimed({ d, w, actor, nsKey, tool, args, idempotency_key, confirm }) {
  const found = await d.resolveTool(tool);
  if (!found) return reply(`No such tool: ${tool}`, { blocked: 'unknown_tool' });
  if (!EXECUTABLE.test(String(tool))) return reply(`${tool} is not something to execute. Pass a tool that prepares a transaction.`, { blocked: 'not_executable' });

  const filled = { ...args };
  for (const k of ADDRESS_FIELDS) {
    if (k in (found.tool.inputSchema?.properties || {}) && filled[k] === undefined) filled[k] = w.address;
  }
  const out = found.unwrap(await found.tool.handler(filled));
  const env = out.data;
  if (!env || env.kind !== 'unsigned') return reply(`${tool} did not produce a transaction:\n${out.summary}`, { ...out, executed: false });

  const verdict = await d.evaluate({ envelope: env, wallet: w.address }, d.ctx || liveContext(), { config: policyConfig(), ledger: d.ledger, now: d.now() });
  const policy = { auto: verdict.auto, reasons: verdict.reasons, total_usd: verdict.total_usd, spent_24h_usd: verdict.spent_24h_usd, caps: verdict.caps, steps: verdict.steps };

  if (!confirm) {
    const next = verdict.auto
      ? `Nothing was sent. Call again with confirm: true to execute as ${w.address}.`
      : d.approvalsAvailable(actor)
        ? `Nothing was sent. Calling again with confirm: true files an approval request and returns a link for ${actorLabel(actor)} to open; it still sends nothing until they approve it in a browser.`
        : 'Nothing was sent, and confirm: true will not send it either: this connector has no approval page for this wallet. See the reasons above.';
    return reply(`${renderApproval(env)}\n\n${verdictText(verdict)}\n\n${next}`, { ...env, executed: false, awaiting_confirmation: true, policy });
  }

  if (verdict.auto) {
    // Re-checked and reserved in one synchronous step: a concurrent execution may have used the room since evaluate().
    // The ref is this reservation's own, so settling it cannot touch any other execution's entry.
    const ref = reservationRef(nsKey);
    if (d.ledger.tryReserve(w.address, verdict.total_usd ?? Infinity, verdict.caps.per_24h_usd, ref, d.now())) {
      const base = { tool, wallet: w.address, kind: 'wallet_execute' };
      // Persisted before the first signature: after a crash the key says "unfinished" instead of sending again.
      d.record(nsKey, { ...base, state: 'executing', started_at: new Date(d.now()).toISOString() });
      let res;
      try {
        res = await withWalletLock(w.address, () => runSteps(env.transactions, { kind: `wallet_execute:${tool}`, signStep: d.signStep, submitRaw: d.submitRaw, waitReceipt: d.waitReceipt }));
      } catch (e) {
        // runSteps catches every signing, broadcast and receipt error itself; anything else leaves the outcome unknown.
        d.ledger.settle(ref, true);
        d.record(nsKey, { ...base, state: 'unknown', error: e.shortMessage || e.message || String(e) });
        return reply(`Stopped with an unexpected error (${e.shortMessage || e.message}). It may or may not have sent: check ${w.address} on chain before trying again with a new idempotency key.`, { executed: null, policy });
      }
      d.ledger.settle(ref, res.hashes.length > 0);
      if (!res.ok) {
        d.record(nsKey, res.hashes.length
          ? { ...base, state: 'failed', hashes: res.hashes, hash: res.hashes[res.hashes.length - 1], error: failText(res) }
          : { ...base, state: 'not_sent', error: failText(res) });
        return reply(failText(res), { executed: false, failed_step: res.failed_step, hashes: res.hashes, reverted: res.reverted || null, policy });
      }
      d.record(nsKey, { ...base, state: 'executed', hashes: res.hashes, hash: res.hashes[res.hashes.length - 1] });
      return reply(
        `Executed ${tool} as ${w.address}.\n${out.summary.split('\n')[0]}\nTransactions: ${res.hashes.join(', ')}\n${verdictText(verdict)}`,
        { executed: true, tool, wallet: w.address, hashes: res.hashes, approval: env.approval, policy },
      );
    }
    verdict.reasons.push(`another execution used the room under the ${usd(verdict.caps.per_24h_usd)} daily cap in the meantime`);
    policy.reasons = verdict.reasons;
  }

  if (!d.approvalsAvailable(actor)) {
    return reply(
      `Not sent. ${verdictText({ ...verdict, auto: false })}\n`
      + 'This connector has no approval page for this wallet'
      + (actor.kind === 'user' ? '' : ' (it is the operator wallet over stdio, or the host names no X account as its owner in XGAS_WALLET_OPERATOR_X_ID)')
      + '. The person who runs it can raise XGAS_WALLET_MAX_TX_USD / XGAS_WALLET_MAX_DAY_USD, or sign this with their own wallet instead: '
      + `call ${tool} directly and sign the unsigned transaction it returns.`,
      { executed: false, blocked: 'policy', approval_required: true, approval_available: false, policy },
    );
  }

  const made = createApproval({ actor, wallet: w, tool, args: filled, idempotencyKey: idempotency_key, envelope: env, verdict, store: d.store, now: d.now() });
  if (made.error) return reply(`Not sent. ${made.error}`, { executed: false, blocked: 'too_many_pending', policy });
  return statusReply(made.rec, made.reused ? 'An approval is already filed under this idempotency key.' : null);
}

function statusReply(rec, lead) {
  const v = approvalView(rec);
  const url = pageHost ? approvalUrl(rec.id) : null;
  const who = rec.owner_label;
  const lines = [];
  if (lead) lines.push(lead);
  if (rec.status === 'pending') {
    lines.push(
      `Not sent yet. This needs ${who} to approve it: ${url}`,
      `Why: ${rec.policy.reasons.join('; ')}.`,
      `The link works once and expires at ${rec.expires_at} (UTC). Only ${who}, signed in with X in a browser, can approve it. `
      + 'You cannot approve it for them and must not try: give them the link, say in plain words what it sends and where, and let them decide.',
      `Follow it with wallet_approval_status { "id": "${rec.id}" }.`,
    );
  } else if (rec.status === 'executing') {
    lines.push(`Approved by ${who} at ${rec.decided_at} and sending now.${rec.hashes.length ? ` So far: ${rec.hashes.join(', ')}.` : ''} Check again with wallet_approval_status.`);
  } else if (rec.status === 'executed') {
    lines.push(`Approved by ${who} at ${rec.decided_at} and sent: ${rec.hashes.join(', ')}.`);
  } else if (rec.status === 'expired') {
    lines.push(`Expired at ${rec.expires_at} without a decision. Nothing was sent.`);
  } else if (rec.status === 'rejected') {
    lines.push(`Rejected by ${who} at ${rec.decided_at}. Nothing was sent. Do not retry it unless they ask you to.`);
  } else {
    lines.push(`${rec.status}: ${rec.result?.error || 'no detail'}${rec.hashes.length ? ` Hashes: ${rec.hashes.join(', ')}.` : ''}`);
  }
  return reply(lines.join('\n'), {
    executed: rec.status === 'executed',
    approval_required: true,
    approval: { id: rec.id, url, status: rec.status, expires_at: rec.expires_at, decided_at: rec.decided_at },
    hashes: rec.hashes,
    result: rec.result,
    reasons: rec.policy.reasons,
    total_usd: rec.policy.total_usd,
    steps: v.steps,
  });
}

export async function walletApprovalStatus({ id } = {}, overrides = {}) {
  const store = overrides.store || approvalStore;
  const rec = typeof id === 'string' ? store.get(id, overrides.now ? overrides.now() : Date.now()) : null;
  // Someone else's approval does not exist, as far as this caller can tell.
  if (!rec || rec.actor_key !== actorKey(currentActor())) return reply(`No approval ${id} for ${actorLabel()}'s wallet.`, { found: false });
  return statusReply(rec, null);
}

