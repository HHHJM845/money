import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { positiveCents, replacementDelta, summarize, type SummaryRow } from './ledger-core.js';

test('cents reject fractional, non-positive and unsafe amounts', () => {
  assert.equal(positiveCents(1234), 1234);
  for (const value of [0, -1, 0.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => positiveCents(value));
  }
});

test('edit, move account, delete and restore reverse actual applied effects', () => {
  assert.deepEqual(replacementDelta({ cash: -2500 }, { cash: -3000 }), { cash: -500 });
  assert.deepEqual(replacementDelta({ cash: -3000 }, { bank: -3000 }), { cash: 3000, bank: -3000 });
  assert.deepEqual(replacementDelta({ bank: -3000 }, {}), { bank: 3000 });
  assert.deepEqual(replacementDelta({}, { bank: -3000 }), { bank: -3000 });
  assert.deepEqual(replacementDelta({ cash: -2500 }, { cash: -2500 }), {});
});

test('historical import without an applied effect deletes without crediting money', () => {
  assert.deepEqual(replacementDelta({}, {}), {});
});

test('balance effects reject fractional values and overflow', () => {
  assert.throws(() => replacementDelta({ cash: 0.5 }, {}));
  assert.throws(() => replacementDelta({}, { bank: Infinity }));
  assert.throws(() => replacementDelta({ cash: -Number.MAX_SAFE_INTEGER }, { cash: 1 }));
  assert.deepEqual(replacementDelta({}, JSON.parse('{"__proto__":42}')), JSON.parse('{"__proto__":42}'));
});

const row = (patch: Partial<SummaryRow> = {}): SummaryRow => ({
  kind: 'expense', status: 'posted', amountCents: 2500,
  occurredAt: Date.parse('2026-10-29T04:00:00Z'), excludeFromStatistics: false, ...patch,
});

test('statistics separate income, expense and refund and omit non-statistical records', () => {
  assert.deepEqual(summarize([
    row(), row({ kind: 'income', amountCents: 10000 }), row({ kind: 'refund', amountCents: 500 }),
    row({ kind: 'transfer' }), row({ status: 'pending' }), row({ status: 'deleted' }),
    row({ excludeFromStatistics: true }),
  ], '2026-10'), {
    incomeCents: 10000, expenseCents: 2500, refundCents: 500,
    netExpenseCents: 2000, surplusCents: 8000,
  });
});

test('refund uses arrival month and Shanghai month boundary', () => {
  const rows = [row(), row({ kind: 'refund', amountCents: 500,
    occurredAt: Date.parse('2026-10-31T16:00:00Z') })];
  assert.equal(summarize(rows, '2026-10').netExpenseCents, 2500);
  assert.equal(summarize(rows, '2026-11').netExpenseCents, -500);
  assert.equal(summarize([row({ occurredAt: Date.parse('2026-10-31T15:59:59.999Z') })], '2026-10').expenseCents, 2500);
  for (const month of ['2026-13', '2026-1', '2026-00', 'October']) {
    assert.throws(() => summarize(rows, month));
  }
});

test('invalid dates and overflowing totals fail visibly', () => {
  for (const occurredAt of [NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => summarize([row({ occurredAt })], '2026-10'));
  }
  assert.throws(() => summarize([row({ amountCents: Number.MAX_SAFE_INTEGER }), row()], '2026-10'));
  assert.throws(() => summarize([
    row({ kind: 'income', amountCents: Number.MAX_SAFE_INTEGER }),
    row({ kind: 'refund', amountCents: 1 }),
  ], '2026-10'));
  assert.throws(() => summarize([row({ amountCents: 0 })], '2026-10'));
});

test('empty month returns zero totals', () => {
  assert.deepEqual(summarize([], '2026-10'), {
    incomeCents: 0, expenseCents: 0, refundCents: 0, netExpenseCents: 0, surplusCents: 0,
  });
});

test('shared fixture replays each balance replacement', async () => {
  const fixture = JSON.parse(await readFile(new URL('../test/fixtures/bookkeeping-v1.json', import.meta.url), 'utf8')) as {
    initialBalances: Record<string, number>;
    operations: Array<{ before: Record<string, number>; after: Record<string, number>; balances: Record<string, number> }>;
  };
  const balances = { ...fixture.initialBalances };
  for (const operation of fixture.operations) {
    for (const [id, delta] of Object.entries(replacementDelta(operation.before, operation.after))) {
      balances[id] += delta;
    }
    assert.deepEqual(balances, operation.balances);
  }
});
