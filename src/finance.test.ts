import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetTotals, cashflow, cents, monthOf, monthTransactions, parseAmount, previousMonth, type Account, type Transaction } from './finance.ts';

const accounts: Account[] = [
  { id: 'bank', name: '银行', category: 2, type: 1, balance: '98000', currency: 'CNY' },
  { id: 'card', name: '信用卡', category: 3, type: 1, balance: '-5000', currency: 'CNY' },
  { id: 'usd', name: '美元', category: 2, type: 1, balance: '50000', currency: 'USD' },
  { id: 'group', name: '分组', category: 2, type: 2, balance: '98000', currency: 'CNY' },
];
function transaction(type: number, amount: number, account = 'bank'): Transaction {
  return { id: `${type}`, timeSequenceId: '1', type, sourceAmount: amount,
    sourceAccountId: account, time: 0, categoryId: '1', comment: '' };
}

test('assets exclude currency conversion and parent double counting; negative balances are debt', () => {
  assert.deepEqual(assetTotals(accounts), { assets: 98000, liabilities: 5000, net: 93000 });
});
test('cashflow excludes transfers, repayment, opening adjustments and foreign currency', () => {
  assert.deepEqual(cashflow([
    transaction(1, 100000), transaction(2, 10000), transaction(3, 4000),
    transaction(3, 5000, 'card'), transaction(4, 5000), transaction(2, 50000, 'usd'),
  ], accounts), { income: 10000, expense: 9000, surplus: 1000 });
});
test('month boundary is Beijing time, including year rollover', () => {
  const seconds = Date.parse('2026-10-31T16:00:00Z') / 1000;
  assert.equal(monthOf(seconds), '2026-11');
  assert.equal(monthTransactions([{ ...transaction(3, 100), time: seconds }], '2026-10').length, 0);
  assert.equal(previousMonth('2026-01'), '2025-12');
});
test('amount parser retains cents exactly and rejects invalid values', () => {
  assert.equal(parseAmount('0.29'), 29);
  assert.equal(parseAmount('123.4'), 12340);
  for (const value of ['0', '-2', '1.123', '1e3', 'abc']) assert.throws(() => parseAmount(value));
  assert.throws(() => cents(Number.MAX_SAFE_INTEGER + 1));
});
