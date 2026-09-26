// Offline tests for the Plaid payment matcher: node --test scripts/plaid-match.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchPayment, memoPattern, paymentWindow } from '../server/plaid.mjs';

const openedAt = Date.parse('2026-09-26T15:00:00Z') / 1000;
const trade = { tradeId: 12n, expectedCents: 2500n, openedAt };
// Plaid's sign: negative = money into the account, positive = money out.
const tx = (id, amount, name, date = '2026-09-26', extra = {}) => ({ transaction_id: id, amount, name, date, iso_currency_code: 'USD', ...extra });

const history = [
  tx('in-memo', -25, 'X Money transfer from @alice xgas #12'),
  tx('in-handle', -25, 'X Money from @alice xgas #123'),
  tx('in-plain', -25, 'Transfer from BOB'),
  tx('in-cent-off', -25.01, 'X Money from @alice xgas #12'),
  tx('out-memo', 25, 'X Money to @alice xgas #12'),
  tx('in-too-early', -25, 'xgas #12', '2026-09-24'),
  tx('in-too-late', -25, 'xgas #12', '2026-10-04'),
  tx('in-eur', -25, 'xgas #12', '2026-09-26', { iso_currency_code: 'EUR' }),
];

test('seller sees money in, strongest first, exact cents only', () => {
  const m = matchPayment(history, { ...trade, side: 'seller', counterparty: '@alice' });
  assert.deepEqual(m.map((x) => [x.t.transaction_id, x.strength]), [['in-memo', 'strong'], ['in-handle', 'medium'], ['in-plain', 'weak']]);
});

test('buyer sees money out', () => {
  const m = matchPayment(history, { ...trade, side: 'buyer', counterparty: 'alice' });
  assert.deepEqual(m.map((x) => [x.t.transaction_id, x.strength]), [['out-memo', 'strong']]);
});

test('memo never matches a longer trade id', () => {
  assert.ok(memoPattern(12).test('xgas #12'));
  assert.ok(memoPattern(12).test('XGAS#12.'));
  assert.ok(memoPattern(12).test('xgas 12'));
  assert.ok(!memoPattern(12).test('xgas #123'));
});

test('handle match is whole-word', () => {
  const m = matchPayment([tx('a', -25, 'from @alicex')], { ...trade, side: 'seller', counterparty: 'alice' });
  assert.equal(m[0].strength, 'weak');
});

test('an authorized date inside the window counts even when it posts later', () => {
  const m = matchPayment([tx('late-post', -25, 'xgas #12', '2026-10-04', { authorized_date: '2026-09-27' })], { ...trade, side: 'seller', counterparty: 'alice' });
  assert.deepEqual(m.map((x) => x.strength), ['strong'], 'sent inside the window, posted after it');
  const { from, to } = paymentWindow(openedAt);
  assert.equal(from, '2026-09-25');
  assert.equal(to, '2026-10-03');
});
