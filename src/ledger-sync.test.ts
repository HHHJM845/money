import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageLedgerChanges, refreshLedger, type ChangesPage, type LedgerChange } from './ledger-sync';
import type { Bill, LedgerAccount, LedgerSnapshot } from './bookkeeping-api';

const account: LedgerAccount = { id: '1', name: '现金', category: 1, type: 1, currency: 'CNY', balance: '100', active: true, version: 1 };
const bill = (id: string, seq: string, note = ''): Bill => ({
  billId: id, version: 1, changeSequence: seq, status: 'posted', legacyId: null, balanceMode: 'apply',
  appliedEffect: { '1': -1 }, restoreEffect: {},
  restoreStatus: 'posted',
  content: { kind: 'expense', amountCents: 1, accountId: '1', categoryId: '1', occurredAt: 1,
    merchant: '测试', note, tagIds: [], excludeFromBudget: false, excludeFromStatistics: false },
  createdAt: 1, updatedAt: 1, deletedAt: null,
});
const snapshot = (): LedgerSnapshot => ({
  accounts: [account], categories: [], tags: [], bills: [bill('old', '1')], sequence: '1', fetchedAt: 1,
});
const change = (row: Bill): LedgerChange => ({ entityType: 'bill', entityId: row.billId, sequence: row.changeSequence, snapshot: row });
const page = (nextSequence: string, hasMore: boolean, changes: LedgerChange[] = []): ChangesPage => ({
  nextSequence, hasMore, changes, accounts: [{ ...account, balance: '99' }], categories: [], tags: [], fetchedAt: 2,
});

test('incremental pages stage all rows and highwater metadata until the tail', async () => {
  const original = snapshot();
  const frozen = structuredClone(original);
  let tail!: (value: ChangesPage) => void;
  const held = new Promise<ChangesPage>(resolve => { tail = resolve; });
  let published = false;
  const result = pageLedgerChanges(original, async after => after === '1' ? page('2', true, [change(bill('new', '2'))]) : held);
  void result.then(() => { published = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(published, false);
  assert.deepEqual(original, frozen);
  tail({ ...page('3', false, [change(bill('last', '3'))]), accounts: [{ ...account, balance: '98' }] });
  const next = await result;
  assert.deepEqual(next.bills.map(b => b.billId), ['old', 'new', 'last']);
  assert.equal(next.accounts[0].balance, '98');
  assert.equal(next.sequence, '3');
});

test('duplicate boundary changes never downgrade or duplicate bills', async () => {
  const next = await pageLedgerChanges(snapshot(), async after => after === '1'
    ? page('2', true, [change(bill('old', '2', 'updated')), change(bill('old', '2', 'updated'))])
    : page('3', false, [change(bill('old', '1', 'stale')), change(bill('old', '2', 'updated')), change(bill('new', '3'))]));
  assert.equal(next.bills.length, 2);
  assert.equal(next.bills[0].content.note, 'updated');
});

test('failed later page leaves original rows metadata and cursor intact; retry starts at original cursor', async () => {
  const original = snapshot();
  const frozen = structuredClone(original);
  await assert.rejects(pageLedgerChanges(original, async after => {
    if (after === '1') return page('2', true, [change(bill('new', '2'))]);
    throw new Error('network failed');
  }), /network failed/);
  assert.deepEqual(original, frozen);
  const calls: string[] = [];
  const result = await pageLedgerChanges(original, async after => {
    calls.push(after);
    return page('2', false, [change(bill('new', '2'))]);
  });
  assert.deepEqual(calls, ['1']);
  assert.equal(result.bills.length, 2);
});

test('master-only tail updates metadata with exact decimal sequence above JS safe integer', async () => {
  const original = { ...snapshot(), sequence: '9007199254740992' };
  const updated = { ...account, name: '已改名', version: 2, active: false };
  const result = await pageLedgerChanges(original, async () => ({
    ...page('9007199254740993', false), accounts: [updated],
    changes: [{ sequence: '9007199254740993', entityType: 'account', entityId: updated.id, snapshot: updated }],
  }));
  assert.equal(result.accounts[0].name, updated.name);
  assert.equal(result.accounts[0].active, false);
  assert.equal(result.sequence, '9007199254740993');
  assert.deepEqual(result.bills, original.bills);
});

test('expired tombstones purge recoverable bill content and cannot be reintroduced by duplicate rows', async () => {
  const original = snapshot();
  original.bills[0].status = 'deleted';
  const result = await pageLedgerChanges(original, async after => after === '1'
    ? page('2', true, [{ sequence: '2', entityType: 'bill', entityId: 'old',
      snapshot: { billId: 'old', version: 2, status: 'deleted', deletedAt: 1, changeSequence: '2', expired: true } }])
    : page('3', false, [change(bill('old', '1')), change(bill('new', '3'))]));
  assert.deepEqual(result.bills.map(b => b.billId), ['new']);
  assert.equal(JSON.stringify(result).includes('"old"'), false);
});

test('nonprogressing duplicate page fails without publishing', async () => {
  const original = snapshot();
  await assert.rejects(pageLedgerChanges(original, async () => page('1', true)), /未前进/);
  assert.equal(original.sequence, '1');
});

test('CURSOR_INVALID recovers with full snapshot; other 409s preserve original', async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  let invalid = true;
  globalThis.fetch = async input => {
    const path = String(input); paths.push(path);
    return path.includes('/snapshot')
      ? Response.json({ success: true, result: { ...snapshot(), sequence: '0' } })
      : Response.json({ success: false, errorCode: invalid ? 'CURSOR_INVALID' : 'VERSION_CONFLICT' }, { status: 409 });
  };
  try {
    assert.equal((await refreshLedger(snapshot())).sequence, '0');
    assert.deepEqual(paths, ['/api/v2/sync/changes.json?after=1&count=200', '/api/v2/snapshot.json']);
    invalid = false; paths.length = 0;
    await assert.rejects(refreshLedger(snapshot()));
    assert.equal(paths.length, 1);
  } finally { globalThis.fetch = originalFetch; }
});
