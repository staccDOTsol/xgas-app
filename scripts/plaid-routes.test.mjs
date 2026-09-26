// The Plaid routes end to end against a fake Plaid: node --test scripts/plaid-routes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createPlaid } from '../server/plaid.mjs';

process.env.PLAID_CLIENT_ID = 'test-client';
process.env.PLAID_SECRET = 'test-secret';
process.env.PLAID_ENV = 'sandbox';

const openedAt = Math.floor(Date.now() / 1000) - 3600;
const today = new Date().toISOString().slice(0, 10);
const trades = {
  12: { seller: '0x1', sellerXHandle: 'seller_bob', buyerXHandle: 'buyer_alice', expectedCents: 2500n, openedAt, status: 1 },
  13: { seller: '0x1', sellerXHandle: 'seller_bob', buyerXHandle: 'buyer_alice', expectedCents: 2500n, openedAt, status: 5 },
  14: { seller: '0x1', sellerXHandle: 'seller_bob', buyerXHandle: 'buyer_alice', expectedCents: 2500n, openedAt, status: 2 },
};
const history = [
  { transaction_id: 'tx-12', account_id: 'acc-1', amount: -25, name: 'X Money from @buyer_alice xgas #12', date: today, iso_currency_code: 'USD', pending: false },
  { transaction_id: 'tx-rent', account_id: 'acc-1', amount: 900, name: 'Rent', date: today, iso_currency_code: 'USD', pending: false },
];
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('https://sandbox.plaid.com')) return realFetch(url, init);
  const p = new URL(url).pathname;
  const body = JSON.parse(init.body);
  calls.push(p);
  const ok = (j) => new Response(JSON.stringify(j), { status: 200 });
  switch (p) {
    case '/link/token/create': return ok({ link_token: 'link-sandbox-abc', expiration: 'x' });
    case '/item/public_token/exchange': return ok({ access_token: 'access-sandbox-secret', item_id: 'item-1' });
    case '/accounts/get': return ok({ item: { institution_id: 'ins_1', institution_name: 'First Platypus Bank' }, accounts: [{ account_id: 'acc-1', mask: '0000', name: 'Checking', type: 'depository', subtype: 'checking' }] });
    case '/transactions/sync':
      assert.equal(body.access_token, 'access-sandbox-secret');
      return ok({ added: history, modified: [], removed: [], has_more: false, next_cursor: 'c1', transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' });
    case '/transactions/refresh': return ok({});
    case '/item/remove': return ok({});
    default: return new Response(JSON.stringify({ error_code: 'NOT_MOCKED' }), { status: 400 });
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaid-test-'));
let handle = 'seller_bob';
const app = express();
app.use(express.json());
const plaid = createPlaid({
  dataDir: dir,
  sessionSecret: 'test',
  currentUser: () => ({ id: handle === 'seller_bob' ? '1' : '2', handle }),
  origin: 'https://xgas.dev',
  readTrade: async (id) => trades[Number(id)] ? { trade: trades[Number(id)] } : { status: 404, error: 'no trade' },
});
plaid.mount(app);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (p, body) => { const r = await realFetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return [r.status, await r.json()]; };
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('link: token, exchange, stored encrypted', async () => {
  let [s, j] = await post('/api/plaid/link-token', {});
  assert.equal(s, 200); assert.equal(j.link_token, 'link-sandbox-abc');
  [s, j] = await post('/api/plaid/exchange', { public_token: 'public-sandbox-12345678-1234-1234-1234-123456789012' });
  assert.equal(s, 200, JSON.stringify(j));
  assert.equal(j.item.institution, 'First Platypus Bank');
  const raw = fs.readFileSync(path.join(dir, 'plaid-items.json'), 'utf8');
  assert.ok(!raw.includes('access-sandbox-secret'), 'access token is not stored in the clear');
  assert.equal((fs.statSync(path.join(dir, 'plaid-items.json')).mode & 0o777), 0o600);
});

test('seller check finds trade #12 with the memo and binds it', async () => {
  const [s, j] = await post('/api/robinhood/plaid-check', { tradeId: 12 });
  assert.equal(s, 200, JSON.stringify(j));
  assert.equal(j.found, true);
  assert.equal(j.matches[0].strength, 'strong');
  assert.equal(j.matches[0].mask, '0000');
  assert.equal(j.matches[0].alreadyUsedFor, null);
});

test('the same transaction does not count for trade #13', async () => {
  const [s, j] = await post('/api/robinhood/plaid-check', { tradeId: 13 });
  assert.equal(s, 200);
  assert.equal(j.found, false);
  assert.equal(j.matches[0].alreadyUsedFor, '12');
  assert.ok(calls.includes('/transactions/refresh'), 'no match asks the bank for fresh data');
});

test('a released trade is not checkable; a stranger is refused', async () => {
  let [s] = await post('/api/robinhood/plaid-check', { tradeId: 14 });
  assert.equal(s, 409);
  handle = 'mallory';
  [s] = await post('/api/robinhood/plaid-check', { tradeId: 12 });
  assert.equal(s, 409, 'mallory has nothing linked');
  handle = 'seller_bob';
});

test('receipts only for disputes, and they read back', async () => {
  let [s, j] = await post('/api/robinhood/plaid-receipt', { tradeId: 12 });
  assert.equal(s, 409);
  [s, j] = await post('/api/robinhood/plaid-receipt', { tradeId: 13 });
  assert.equal(s, 200, JSON.stringify(j));
  assert.match(j.uri, /^https:\/\/xgas\.dev\/api\/robinhood\/plaid-receipt\/[0-9a-f]{32}$/);
  assert.equal(j.receipt.result, 'not found');
  assert.match(j.receipt.warning, /SANDBOX/);
  assert.match(j.receipt.lookedFor, /into @seller_bob's linked accounts from @buyer_alice/);
  const r = await realFetch(`${base}${j.path}`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).tradeId, '13');
});

test('unlink removes the item', async () => {
  const info = await (await realFetch(`${base}/api/plaid`)).json();
  const [s] = await post('/api/plaid/unlink', { item: info.items[0].id });
  assert.equal(s, 200);
  const after = await (await realFetch(`${base}/api/plaid`)).json();
  assert.equal(after.items.length, 0);
  assert.ok(calls.includes('/item/remove'));
});
