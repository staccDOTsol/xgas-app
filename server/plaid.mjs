// ---------------------------------------------------------------------------
// Plaid, read-only, for the Robinhood desk's dollar leg.
//
// The desk's weak spot is that the dollars move off-chain, X account to X account, where no contract can see them.
// With Plaid a party links the account those dollars move through (their X Money wallet if Plaid lists it, or the
// bank behind it), and this host looks for the one transaction the trade says happened: exactly the trade's dollars,
// in the right direction, on or after the day the trade opened, ideally with the memo "xgas #<tradeId>".
// It reads. It never moves money, holds funds, initiates a transfer, releases or claims: the seller still releases,
// and a dispute still goes to the arbiters, who can now read a receipt this host wrote from Plaid's own data
// instead of a screenshot anyone could edit.
//
//   GET  /api/plaid                          { configured, env, signedIn, items } for the signed-in X account
//   POST /api/plaid/link-token               a Plaid Link token (Transactions, US, 30 days of history)
//   POST /api/plaid/exchange                 { public_token } from Link's onSuccess; stores the item
//   POST /api/plaid/unlink                   { item } removes the item at Plaid and here
//   POST /api/robinhood/plaid-check          { tradeId } looks for this trade's payment in your linked accounts
//   POST /api/robinhood/plaid-receipt        { tradeId } for a disputed trade: writes a public receipt of the check
//   GET  /api/robinhood/plaid-receipt/:id    a receipt, read-only
//
// Env (Fly secrets): PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV (sandbox | production, default sandbox),
// PLAID_REDIRECT_URI (only for OAuth banks; it must also be allow-listed in the Plaid dashboard),
// PLAID_TOKEN_KEY (optional, 64 hex). Access tokens are encrypted at rest with it, or else with a key derived from
// the session secret, so rotating either means everyone relinks.
// ---------------------------------------------------------------------------
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const HOSTS = { sandbox: 'https://sandbox.plaid.com', production: 'https://production.plaid.com' };
const MAX_ITEMS_PER_ACCOUNT = 3;
const CHECKS_PER_HOUR = 30;
const RECEIPTS_PER_TRADE = 3;
const REFRESH_EVERY_MS = 2 * 60_000;
// Plaid dates are the bank's local day, so the window starts a day before the trade opened (UTC), and a transfer
// can post days after it was sent.
const LOOKBACK_DAYS = 1;
const LOOKAHEAD_DAYS = 7;
const DESCRIPTION_MAX = 160;
const RECEIPT_RE = /^[0-9a-f]{32}$/;
const STATUS = ['Open', 'Paid', 'Released', 'Claimed', 'CancelledUnpaid', 'Disputed', 'Resolved'];
const CHECKABLE = new Set([0, 1, 5]); // Open, Paid, Disputed
const DISPUTED = 5;

// --- pure helpers (exported for scripts/plaid-match.test.mjs) ----------------
export const normHandle = (h) => String(h || '').trim().replace(/^@/, '').toLowerCase();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const isoDay = (unixS) => new Date(Number(unixS) * 1000).toISOString().slice(0, 10);
export const fmtCents = (c) => `$${(Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** "xgas #12", "XGAS#12", "xgas 12", never "xgas #123" for trade 12. */
export const memoPattern = (tradeId) => new RegExp(`xgas\\s*#?\\s*${Number(tradeId)}(?!\\d)`, 'i');

export function paymentWindow(openedAt) {
  return { from: isoDay(Number(openedAt) - LOOKBACK_DAYS * 86400), to: isoDay(Number(openedAt) + LOOKAHEAD_DAYS * 86400) };
}

/**
 * The transactions that could be this trade's payment. Plaid's sign: a positive amount is money out of the account,
 * a negative one is money in. The seller looks for money in, the buyer for money out, of exactly the trade's cents.
 * strong = amount and memo, medium = amount and the counterparty's handle, weak = the amount alone.
 */
export function matchPayment(transactions, { tradeId, expectedCents, openedAt, side, counterparty }) {
  const want = (side === 'seller' ? -1 : 1) * Number(expectedCents);
  const { from, to } = paymentWindow(openedAt);
  const memo = memoPattern(tradeId);
  const h = normHandle(counterparty);
  const handleRe = h ? new RegExp(`(^|[^a-z0-9_])@?${escapeRe(h)}(?![a-z0-9_])`, 'i') : null;
  const rank = { strong: 0, medium: 1, weak: 2 };
  const out = [];
  for (const t of transactions || []) {
    if (Math.round(Number(t.amount) * 100) !== want) continue;
    if (t.iso_currency_code && t.iso_currency_code !== 'USD') continue;
    const first = t.authorized_date && t.authorized_date < t.date ? t.authorized_date : t.date;
    if (!t.date || t.date < from || first > to) continue;
    const text = [t.name, t.merchant_name, t.original_description, ...(t.counterparties || []).map((c) => c?.name)]
      .filter(Boolean).join(' | ');
    const signals = { memo: memo.test(text), handle: !!handleRe && handleRe.test(text), xMoney: /\bx\s*money\b/i.test(text) };
    out.push({ t, text, signals, strength: signals.memo ? 'strong' : signals.handle ? 'medium' : 'weak' });
  }
  const opened = isoDay(openedAt);
  return out.sort((a, b) => rank[a.strength] - rank[b.strength]
    || Math.abs(Date.parse(a.t.date) - Date.parse(opened)) - Math.abs(Date.parse(b.t.date) - Date.parse(opened)));
}

// --- the module --------------------------------------------------------------
export function createPlaid({ dataDir, sessionSecret, currentUser, readTrade, origin }) {
  const clientId = String(process.env.PLAID_CLIENT_ID || '').trim();
  const secret = String(process.env.PLAID_SECRET || '').trim();
  const env = String(process.env.PLAID_ENV || 'sandbox').trim().toLowerCase();
  const host = HOSTS[env];
  const redirectUri = String(process.env.PLAID_REDIRECT_URI || '').trim();
  const configured = !!(clientId && secret && host);
  if (!host) console.error(`[plaid] PLAID_ENV=${env} is not sandbox or production; the Plaid payment check is off.`);
  else if (!configured) console.log('[plaid] PLAID_CLIENT_ID / PLAID_SECRET not set; the Plaid payment check is off.');
  else console.log(`[plaid] payment check on (${env})`);

  const KEY = (() => {
    const raw = String(process.env.PLAID_TOKEN_KEY || '').trim();
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
    if (raw) console.error('[plaid] PLAID_TOKEN_KEY is set but is not 64 hex characters; using the session-derived key.');
    return Buffer.from(crypto.hkdfSync('sha256', String(sessionSecret), 'xgas-plaid', 'access-token-v1', 32));
  })();
  const seal = (plain) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  };
  const unseal = (sealed) => {
    const [v, iv, tag, ct] = String(sealed).split('.');
    if (v !== 'v1') throw new Error('unknown token format');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  };
  // Plaid gets a stable pseudonym per X account, never the X id itself.
  const plaidUserId = (xId) => crypto.createHmac('sha256', KEY).update(`plaid-user:${xId}`).digest('hex').slice(0, 32);
  // Transactions already matched to a trade, keyed per item so the ledger never holds raw Plaid ids.
  const usedKey = (itemId, txId) => crypto.createHmac('sha256', KEY).update(`${itemId}:${txId}`).digest('hex').slice(0, 32);
  const publicItemId = (itemId) => crypto.createHmac('sha256', KEY).update(`item:${itemId}`).digest('hex').slice(0, 16);

  // --- storage: one JSON file, written atomically, 0600 ---------------------
  const FILE = path.join(dataDir, 'plaid-items.json');
  const RECEIPT_DIR = path.join(dataDir, 'plaid-receipts');
  fs.mkdirSync(RECEIPT_DIR, { recursive: true });
  let store = { version: 1, users: {}, used: {}, receipts: {} };
  // A store that exists but will not parse is left alone (it holds the only copy of the access tokens), and every
  // Plaid route answers 503 until someone repairs it.
  let broken = false;
  try { if (fs.existsSync(FILE)) store = { ...store, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; }
  catch (e) { broken = true; console.error(`[plaid] ${FILE} is unreadable; the Plaid routes are off until it is fixed:`, e.message); }
  function save(next) {
    const tmp = `${FILE}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, FILE);
    store = next;
  }
  let chain = Promise.resolve();
  const locked = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
  const itemsOf = (xId) => store.users[String(xId)]?.items || [];
  function putUser(xId, patch) {
    const id = String(xId);
    save({ ...store, users: { ...store.users, [id]: { ...(store.users[id] || { items: [] }), ...patch } } });
  }

  // --- Plaid API -------------------------------------------------------------
  async function call(p, body) {
    const r = await fetch(host + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'PLAID-CLIENT-ID': clientId, 'PLAID-SECRET': secret, 'Plaid-Version': '2020-09-14' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(j.display_message || j.error_message || `Plaid ${p} answered HTTP ${r.status}`);
      e.plaid = { code: j.error_code, type: j.error_type, requestId: j.request_id };
      throw e;
    }
    return j;
  }
  const plaidCode = (e) => e?.plaid?.code || null;
  const RELINK = new Set(['ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION', 'ACCESS_NOT_GRANTED', 'NO_ACCOUNTS']);

  /** Every transaction Plaid has for the item (30 days were requested at link time), pending ones included. */
  async function transactionsOf(accessToken, retried = false) {
    const byId = new Map();
    let cursor, status = null;
    try {
      for (let page = 0; page < 20; page++) {
        const r = await call('/transactions/sync', { access_token: accessToken, ...(cursor ? { cursor } : {}), count: 500, options: { include_original_description: true } });
        status = r.transactions_update_status || status;
        for (const t of [...(r.added || []), ...(r.modified || [])]) byId.set(t.transaction_id, t);
        for (const t of r.removed || []) byId.delete(t.transaction_id);
        cursor = r.next_cursor;
        if (!r.has_more) break;
      }
    } catch (e) {
      if (!retried && plaidCode(e) === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') return transactionsOf(accessToken, true);
      throw e;
    }
    return { transactions: [...byId.values()], status };
  }

  // --- small guards ----------------------------------------------------------
  const checkLog = new Map(); // xId -> [ms]
  function rateLimited(xId) {
    const now = Date.now();
    const recent = (checkLog.get(xId) || []).filter((t) => now - t < 3600_000);
    if (recent.length >= CHECKS_PER_HOUR) { checkLog.set(xId, recent); return true; }
    recent.push(now);
    checkLog.set(xId, recent);
    return false;
  }
  const parseTradeId = (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) || (typeof v === 'string' && /^\d{1,20}$/.test(v)) ? BigInt(v) : null;
  function gate(req, res) {
    if (!configured) { res.status(503).json({ error: 'Plaid is not set up on this host.' }); return null; }
    if (broken) { res.status(503).json({ error: 'Plaid is paused on this host while its store is repaired.' }); return null; }
    const user = currentUser(req);
    if (!user || !user.id) { res.status(401).json({ error: 'Sign in with X first: linked accounts belong to your X account.' }); return null; }
    return user;
  }
  const itemView = (it) => ({ id: publicItemId(it.itemId), institution: it.institution || 'Unknown institution', accounts: it.accounts || [], linkedAt: it.linkedAt, needsRelink: !!it.needsRelink });

  // The trade and which side of it the signed-in X account is on.
  async function tradeFor(req, res, user) {
    const tradeId = parseTradeId(req.body?.tradeId);
    if (tradeId == null) { res.status(400).json({ error: 'Send {"tradeId": <number>}.' }); return null; }
    const got = await readTrade(tradeId);
    if (got.error) { res.status(got.status || 502).json({ error: got.error }); return null; }
    const t = got.trade;
    const me = normHandle(user.handle);
    const side = me && me === normHandle(t.sellerXHandle) ? 'seller' : me && me === normHandle(t.buyerXHandle) ? 'buyer' : null;
    if (!side) {
      res.status(403).json({ error: `Only the two X accounts on trade #${tradeId} (@${normHandle(t.sellerXHandle)} and @${normHandle(t.buyerXHandle)}) can check its payment. You are signed in as @${user.handle}.` });
      return null;
    }
    return { tradeId, t, side, counterparty: side === 'seller' ? t.buyerXHandle : t.sellerXHandle };
  }

  /** Looks through every linked item for the trade's payment. Binds a strong match to the trade the first time. */
  async function runCheck(user, { tradeId, t, side, counterparty }) {
    const xId = String(user.id);
    const items = itemsOf(xId);
    const key = tradeId.toString();
    const checked = [], matches = [];
    let refreshed = false;
    for (const it of items) {
      let token;
      try { token = unseal(it.token); } catch {
        checked.push({ institution: it.institution, accounts: (it.accounts || []).length, status: null, error: 'This link can no longer be read on this host. Unlink it and link again.', needsRelink: true });
        continue;
      }
      try {
        const { transactions, status } = await transactionsOf(token);
        const acct = new Map((it.accounts || []).map((a) => [a.id, a]));
        for (const m of matchPayment(transactions, { tradeId, expectedCents: t.expectedCents, openedAt: t.openedAt, side, counterparty })) {
          const k = usedKey(it.itemId, m.t.transaction_id);
          const kp = m.t.pending_transaction_id ? usedKey(it.itemId, m.t.pending_transaction_id) : null;
          const bound = store.used[k] || (kp && store.used[kp]) || null;
          matches.push({
            _keys: [k, kp].filter(Boolean),
            date: m.t.date,
            authorizedDate: m.t.authorized_date || null,
            amount: fmtCents(Math.abs(Math.round(Number(m.t.amount) * 100))),
            direction: Number(m.t.amount) < 0 ? 'in' : 'out',
            pending: !!m.t.pending,
            description: m.text.slice(0, DESCRIPTION_MAX),
            memo: m.signals.memo,
            handle: m.signals.handle,
            xMoney: m.signals.xMoney,
            strength: m.strength,
            institution: it.institution || 'Unknown institution',
            mask: acct.get(m.t.account_id)?.mask || null,
            alreadyUsedFor: bound && bound.tradeId !== key ? bound.tradeId : null,
          });
        }
        checked.push({ institution: it.institution, accounts: (it.accounts || []).length, status });
        if (it.needsRelink) await locked(() => putUser(xId, { items: itemsOf(xId).map((x) => x.itemId === it.itemId ? { ...x, needsRelink: false } : x) }));
      } catch (e) {
        const code = plaidCode(e);
        const needsRelink = RELINK.has(code);
        checked.push({ institution: it.institution, accounts: (it.accounts || []).length, status: null, error: needsRelink ? 'The bank wants you to sign in again. Unlink this account and link it again.' : code === 'PRODUCT_NOT_READY' ? 'Plaid is still pulling this account\'s history. Try again in a minute.' : `Plaid: ${e.message}`, needsRelink });
        if (needsRelink) await locked(() => putUser(xId, { items: itemsOf(xId).map((x) => x.itemId === it.itemId ? { ...x, needsRelink: true } : x) }));
        continue;
      }
    }
    const usable = matches.filter((m) => !m.alreadyUsedFor);
    const strong = usable.find((m) => m.strength === 'strong');
    if (strong) {
      await locked(() => {
        const used = { ...store.used };
        for (const k of strong._keys) if (!used[k]) used[k] = { tradeId: key, side, at: Date.now() };
        save({ ...store, used });
      });
    } else if (items.length) {
      // Banks refresh a few times a day on their own. Ask for a fresh pull (Plaid's Transactions Refresh, if the
      // account has it), at most every two minutes per item; the result shows up on a later check.
      const now = Date.now();
      for (const it of items) {
        if (it.needsRelink || (it.refreshedAt && now - it.refreshedAt < REFRESH_EVERY_MS)) continue;
        try {
          await call('/transactions/refresh', { access_token: unseal(it.token) });
          refreshed = true;
          await locked(() => putUser(xId, { items: itemsOf(xId).map((x) => x.itemId === it.itemId ? { ...x, refreshedAt: now } : x) }));
        } catch { /* Transactions Refresh not enabled, or the bank does not support it: the daily pulls still come. */ }
      }
    }
    const { from, to } = paymentWindow(t.openedAt);
    return {
      tradeId: key,
      side,
      status: STATUS[Number(t.status)] || String(t.status),
      counterparty: normHandle(counterparty),
      amount: fmtCents(t.expectedCents),
      direction: side === 'seller' ? 'in' : 'out',
      memo: `xgas #${key}`,
      window: { from, to },
      env,
      checked,
      matches: matches.map(({ _keys, ...m }) => m),
      found: !!strong || usable.length > 0,
      refreshed,
    };
  }

  function mount(app) {
    app.get('/api/plaid', (req, res) => {
      const user = currentUser(req);
      res.json({ configured: configured && !broken, env: configured ? env : null, signedIn: !!user, items: user ? itemsOf(user.id).map(itemView) : [] });
    });

    app.post('/api/plaid/link-token', async (req, res) => {
      const user = gate(req, res); if (!user) return;
      if (itemsOf(user.id).length >= MAX_ITEMS_PER_ACCOUNT) return res.status(409).json({ error: `You already linked ${MAX_ITEMS_PER_ACCOUNT} accounts, the most one X account can. Unlink one first.` });
      try {
        const r = await call('/link/token/create', {
          client_name: 'xgas.dev',
          language: 'en',
          country_codes: ['US'],
          user: { client_user_id: plaidUserId(user.id) },
          products: ['transactions'],
          transactions: { days_requested: 30 },
          ...(redirectUri ? { redirect_uri: redirectUri } : {}),
        });
        res.json({ link_token: r.link_token, expiration: r.expiration, env });
      } catch (e) {
        console.error('[plaid] link/token/create failed:', plaidCode(e) || e.message);
        res.status(502).json({ error: `Plaid would not start Link: ${e.message}` });
      }
    });

    app.post('/api/plaid/exchange', async (req, res) => {
      const user = gate(req, res); if (!user) return;
      const publicToken = req.body?.public_token;
      if (typeof publicToken !== 'string' || !/^public-[a-z]+-[0-9a-f-]{36}$/i.test(publicToken)) return res.status(400).json({ error: 'Send {"public_token": "public-..."} from Plaid Link.' });
      let accessToken, itemId;
      try {
        ({ access_token: accessToken, item_id: itemId } = await call('/item/public_token/exchange', { public_token: publicToken }));
      } catch (e) {
        return res.status(502).json({ error: `Plaid would not complete the link: ${e.message}` });
      }
      try {
        const a = await call('/accounts/get', { access_token: accessToken });
        let institution = a.item?.institution_name || null;
        if (!institution && a.item?.institution_id) {
          institution = await call('/institutions/get_by_id', { institution_id: a.item.institution_id, country_codes: ['US'] })
            .then((r) => r.institution?.name || null).catch(() => null);
        }
        const accounts = (a.accounts || []).map((x) => ({ id: x.account_id, mask: x.mask || null, name: String(x.name || '').slice(0, 60), type: x.type || null, subtype: x.subtype || null }));
        const out = await locked(() => {
          const items = itemsOf(user.id);
          if (items.some((x) => x.itemId === itemId)) return { status: 200, body: { ok: true, item: itemView(items.find((x) => x.itemId === itemId)) } };
          if (items.length >= MAX_ITEMS_PER_ACCOUNT) return { status: 409, body: { error: `You already linked ${MAX_ITEMS_PER_ACCOUNT} accounts, the most one X account can.` }, remove: true };
          const item = { itemId, token: seal(accessToken), institution: institution || 'Unknown institution', institutionId: a.item?.institution_id || null, accounts, linkedAt: Date.now() };
          putUser(user.id, { handle: user.handle, items: [...items, item] });
          return { status: 200, body: { ok: true, item: itemView(item) } };
        });
        if (out.remove) await call('/item/remove', { access_token: accessToken }).catch(() => {});
        else console.log(`[plaid] @${user.handle} linked an account at ${institution || 'an unknown institution'}`);
        res.status(out.status).json(out.body);
      } catch (e) {
        await call('/item/remove', { access_token: accessToken }).catch(() => {});
        console.error('[plaid] exchange failed after the token swap:', plaidCode(e) || e.message);
        res.status(502).json({ error: `Plaid linked the account but it could not be read, so the link was removed: ${e.message}` });
      }
    });

    app.post('/api/plaid/unlink', async (req, res) => {
      const user = gate(req, res); if (!user) return;
      const it = itemsOf(user.id).find((x) => publicItemId(x.itemId) === req.body?.item);
      if (!it) return res.status(404).json({ error: 'No such linked account on your X account.' });
      let remoteError = null;
      try { await call('/item/remove', { access_token: unseal(it.token) }); }
      catch (e) { if (plaidCode(e) !== 'ITEM_NOT_FOUND') remoteError = e.message; }
      await locked(() => putUser(user.id, { items: itemsOf(user.id).filter((x) => x.itemId !== it.itemId) }));
      res.json({ ok: true, removedAtPlaid: !remoteError, ...(remoteError ? { note: `Removed here; Plaid said: ${remoteError}` } : {}) });
    });

    app.post('/api/robinhood/plaid-check', async (req, res) => {
      const user = gate(req, res); if (!user) return;
      if (!itemsOf(user.id).length) return res.status(409).json({ error: 'Link the account your X Money dollars move through first.', needsLink: true });
      if (rateLimited(String(user.id))) return res.status(429).json({ error: `You ran ${CHECKS_PER_HOUR} checks in the last hour. Try again later.` });
      const ctx = await tradeFor(req, res, user); if (!ctx) return;
      if (!CHECKABLE.has(Number(ctx.t.status))) return res.status(409).json({ error: `Trade #${ctx.tradeId} is ${STATUS[Number(ctx.t.status)] || ctx.t.status}; there is no payment left to check.` });
      try { res.json(await runCheck(user, ctx)); }
      catch (e) { console.error('[plaid] check failed:', e.message); res.status(502).json({ error: 'The check failed. Nothing was stored; try again.' }); }
    });

    app.post('/api/robinhood/plaid-receipt', async (req, res) => {
      const user = gate(req, res); if (!user) return;
      if (!itemsOf(user.id).length) return res.status(409).json({ error: 'Link the account your X Money dollars move through first.', needsLink: true });
      if (rateLimited(String(user.id))) return res.status(429).json({ error: `You ran ${CHECKS_PER_HOUR} checks in the last hour. Try again later.` });
      const ctx = await tradeFor(req, res, user); if (!ctx) return;
      // The arbitration contract only takes evidence for an open dispute.
      if (Number(ctx.t.status) !== DISPUTED) return res.status(409).json({ error: `Receipts are for disputed trades. Trade #${ctx.tradeId} is ${STATUS[Number(ctx.t.status)] || ctx.t.status}.` });
      const key = ctx.tradeId.toString();
      const mine = Object.values(store.receipts).filter((r) => r.tradeId === key && r.xId === String(user.id)).length;
      if (mine >= RECEIPTS_PER_TRADE) return res.status(429).json({ error: `You already published ${RECEIPTS_PER_TRADE} Plaid receipts for trade #${key}.` });
      let result;
      try { result = await runCheck(user, ctx); }
      catch (e) { console.error('[plaid] receipt check failed:', e.message); return res.status(502).json({ error: 'The check failed. No receipt was written; try again.' }); }
      const items = itemsOf(user.id);
      const usable = result.matches.filter((m) => !m.alreadyUsedFor);
      const receipt = {
        kind: 'xgas.dev Plaid receipt',
        ...(env !== 'production' ? { warning: `PLAID ${env.toUpperCase()}: test data from Plaid's ${env}, not a real account or real money.` } : {}),
        writtenBy: `The xgas.dev host, from data it read from Plaid itself when @${user.handle} asked. The trade party did not write or edit it.`,
        tradeId: key,
        checkedAt: new Date().toISOString(),
        by: { xHandle: normHandle(user.handle), side: ctx.side },
        lookedFor: `Exactly ${result.amount} ${ctx.side === 'seller' ? `into @${normHandle(user.handle)}'s linked accounts from @${result.counterparty}` : `out of @${normHandle(user.handle)}'s linked accounts to @${result.counterparty}`}, dated ${result.window.from} to ${result.window.to}, ideally with the memo "${result.memo}".`,
        accountsChecked: items.map((it) => ({ institution: it.institution, accounts: (it.accounts || []).map((a) => `${a.name}${a.mask ? ` ••${a.mask}` : ''}`) })),
        result: usable.length ? 'found' : 'not found',
        matches: usable.map((m) => ({ date: m.date, authorizedDate: m.authorizedDate, amount: m.amount, direction: m.direction, pending: m.pending, description: m.description, memoMatched: m.memo, counterpartyHandleMatched: m.handle, strength: m.strength, institution: m.institution, account: m.mask ? `••${m.mask}` : null })),
        errors: result.checked.filter((c) => c.error).map((c) => `${c.institution}: ${c.error}`),
        howToRead: [
          'found / strong: a transaction of exactly this amount, in this direction, carrying the trade memo, moved through an account this X account linked.',
          'found / medium or weak: the amount matches but the memo does not; it may be another payment of the same size.',
          'not found: covers only the accounts listed. A party can leave an account unlinked, and banks can post a transfer days late.',
          'Each transaction counts for one trade: one already matched to another trade is left out.',
        ],
      };
      const id = crypto.randomBytes(16).toString('hex');
      try {
        const file = path.join(RECEIPT_DIR, `${id}.json`);
        const fd = fs.openSync(file, 'wx', 0o644);
        try { fs.writeSync(fd, JSON.stringify(receipt, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        await locked(() => save({ ...store, receipts: { ...store.receipts, [id]: { tradeId: key, xId: String(user.id), at: Date.now(), result: receipt.result } } }));
      } catch (e) {
        console.error('[plaid] could not store a receipt:', e.message);
        return res.status(500).json({ error: 'Could not store the receipt. Nothing was saved; try again.' });
      }
      const p = `/api/robinhood/plaid-receipt/${id}`;
      console.log(`[plaid] receipt for trade #${key} by @${user.handle} (${ctx.side}): ${receipt.result}`);
      res.json({ ok: true, id, path: p, uri: `${String(origin).replace(/\/+$/, '')}${p}`, result: receipt.result, receipt });
    });

    app.get('/api/robinhood/plaid-receipt/:id', (req, res) => {
      const id = String(req.params.id || '');
      if (!RECEIPT_RE.test(id) || !store.receipts[id]) return res.status(404).json({ error: 'No such Plaid receipt.' });
      const file = path.join(RECEIPT_DIR, `${id}.json`);
      fs.readFile(file, (err, buf) => {
        if (err) return res.status(404).json({ error: 'No such Plaid receipt.' });
        res.set({
          'Content-Type': 'application/json; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Referrer-Policy': 'no-referrer',
        });
        res.send(buf);
      });
    });
  }

  return { mount, configured, env };
}
