#!/usr/bin/env node
// Plaid from the command line, for proving the X Money leg of a desk trade before any of it goes on the site.
//
//   node scripts/plaid-cli.mjs institutions "X Money"   is X Money (or its bank) linkable through Plaid?
//   node scripts/plaid-cli.mjs sandbox-e2e               end to end in Plaid's sandbox: link a test bank, post an
//                                                        X Money-style payment with the memo, find it with the
//                                                        same matcher the server uses, unlink
//
// Keys come from the environment or a .env next to package.json (this checkout's, else ~/xgas-app's):
//   PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV=sandbox (default) | production
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { matchPayment, fmtCents } from '../server/plaid.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const f of [path.join(root, '.env'), path.join(os.homedir(), 'xgas-app', '.env')]) {
  if (fs.existsSync(f)) { dotenv.config({ path: f, quiet: true }); break; }
}
const HOSTS = { sandbox: 'https://sandbox.plaid.com', production: 'https://production.plaid.com' };
const env = String(process.env.PLAID_ENV || 'sandbox').toLowerCase();
const host = HOSTS[env];
const clientId = process.env.PLAID_CLIENT_ID, secret = process.env.PLAID_SECRET;
if (!host || !clientId || !secret) {
  console.error('Set PLAID_CLIENT_ID and PLAID_SECRET (and PLAID_ENV=sandbox|production) in the environment or in ~/xgas-app/.env.');
  process.exit(2);
}

async function call(p, body) {
  const r = await fetch(host + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'PLAID-CLIENT-ID': clientId, 'PLAID-SECRET': secret, 'Plaid-Version': '2020-09-14' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`${p}: ${j.error_code || r.status} ${j.error_message || ''}`.trim()), { code: j.error_code });
  return j;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (d) => d.toISOString().slice(0, 10);

async function institutions(query) {
  const q = query || 'X Money';
  const seen = new Map();
  for (const products of [['transactions'], undefined]) {
    const r = await call('/institutions/search', { query: q, country_codes: ['US'], ...(products ? { products } : {}), options: { include_optional_metadata: true } });
    for (const i of r.institutions || []) if (!seen.has(i.institution_id)) seen.set(i.institution_id, i);
  }
  console.log(`Plaid ${env}: ${seen.size} institution(s) for "${q}"`);
  for (const i of seen.values()) {
    console.log(`  ${i.name}  (${i.institution_id})  products: ${(i.products || []).join(', ')}${i.oauth ? '  oauth' : ''}${i.url ? `  ${i.url}` : ''}`);
  }
  if (!seen.size) console.log('  none: an X Money wallet can not be linked directly; link the bank the dollars cash out to instead.');
}

async function syncAll(accessToken) {
  const byId = new Map();
  let cursor, status;
  for (let page = 0; page < 20; page++) {
    const r = await call('/transactions/sync', { access_token: accessToken, ...(cursor ? { cursor } : {}), count: 500, options: { include_original_description: true } });
    status = r.transactions_update_status;
    for (const t of [...r.added, ...r.modified]) byId.set(t.transaction_id, t);
    for (const t of r.removed) byId.delete(t.transaction_id);
    cursor = r.next_cursor;
    if (!r.has_more) break;
  }
  return { transactions: [...byId.values()], status };
}

async function sandboxE2e() {
  if (env !== 'sandbox') throw new Error('sandbox-e2e only runs with PLAID_ENV=sandbox.');
  const tradeId = 900000 + Math.floor(Math.random() * 99999);
  const openedAt = Math.floor(Date.now() / 1000) - 3600;
  const cents = 2500 + Math.floor(Math.random() * 7500);
  const dollars = cents / 100;
  const tag = `xgas #${tradeId}`;
  console.log(`trade #${tradeId}: @buyer_alice pays @seller_bob ${fmtCents(cents)} on X Money, memo "${tag}"`);

  // First Platypus Bank with Plaid's dynamic-transactions test user, so we can post our own transactions.
  const { public_token } = await call('/sandbox/public_token/create', {
    institution_id: 'ins_109508',
    initial_products: ['transactions'],
    options: { override_username: 'user_transactions_dynamic', override_password: 'pass_good', transactions: { days_requested: 30 } },
  });
  const { access_token } = await call('/item/public_token/exchange', { public_token });
  console.log('linked a sandbox account (seller side)');
  try {
    for (let i = 0; i < 30; i++) {
      const { status } = await syncAll(access_token);
      if (status && status !== 'NOT_READY') break;
      await sleep(2000);
    }
    const today = day(new Date());
    const post = (amount, description) => ({ amount, description, date_posted: today, date_transacted: today, iso_currency_code: 'USD' });
    // The seller's view: money in is negative. One real payment, and the decoys a matcher has to get right.
    const wanted = [
      post(-dollars, `X Money transfer from @buyer_alice ${tag}`),       // strong
      post(-dollars, 'X Money transfer from @someone_else'),              // weak: same amount, no memo
      post(-(dollars + 0.01), `X Money transfer from @buyer_alice ${tag}`), // a cent off: never
      post(dollars, `X Money to @buyer_alice ${tag}`),                    // wrong direction for the seller
    ];
    await call('/sandbox/transactions/create', { access_token, transactions: wanted });
    await call('/transactions/refresh', { access_token });
    console.log('posted 4 transactions, waiting for Plaid to surface them...');

    let txs = [];
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      ({ transactions: txs } = await syncAll(access_token));
      if (wanted.every((w) => txs.some((t) => (t.original_description || t.name || '').includes(w.description.slice(0, 30))))) break;
    }
    const mine = txs.filter((t) => (t.original_description || t.name || '').toLowerCase().includes('x money'));
    console.log(`Plaid returned ${txs.length} transactions, ${mine.length} of ours:`);
    for (const t of mine) console.log(`  ${t.date}  ${t.amount > 0 ? 'out' : 'in '} ${fmtCents(Math.abs(Math.round(t.amount * 100)))}  ${t.original_description || t.name}`);

    const seller = matchPayment(txs, { tradeId, expectedCents: cents, openedAt, side: 'seller', counterparty: 'buyer_alice' });
    const buyer = matchPayment(txs, { tradeId, expectedCents: cents, openedAt, side: 'buyer', counterparty: 'seller_bob' });
    console.log('\nseller check (money in):');
    for (const m of seller) console.log(`  ${m.strength.padEnd(6)} ${m.t.date} ${m.text}`);
    console.log('buyer check on the same account (money out):');
    for (const m of buyer) console.log(`  ${m.strength.padEnd(6)} ${m.t.date} ${m.text}`);

    const ok = seller.length === 2 && seller[0].strength === 'strong' && seller[1].strength === 'weak'
      && buyer.length === 1 && buyer[0].strength === 'strong';
    console.log(ok ? '\nPASS: the payment was found, the decoys were not mistaken for it.' : '\nFAIL: see the matches above.');
    process.exitCode = ok ? 0 : 1;
  } finally {
    await call('/item/remove', { access_token }).then(() => console.log('unlinked the sandbox account')).catch((e) => console.error('could not unlink:', e.message));
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const run = { institutions: () => institutions(rest.join(' ')), 'sandbox-e2e': sandboxE2e }[cmd];
if (!run) { console.error('usage: node scripts/plaid-cli.mjs institutions "X Money" | sandbox-e2e'); process.exit(2); }
run().catch((e) => { console.error(e.message); process.exit(1); });
