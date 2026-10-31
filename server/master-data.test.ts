import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { bookkeeping, type Bill, type BillContent, type Source } from './bookkeeping.js';
import { LedgerError } from './ledger-write.js';
import { masterData } from './master-data.js';

interface Result {
  entityType: 'account' | 'category' | 'tag';
  entityId: string;
  snapshot: {
    id: string; name: string; active: boolean; version: number;
    balance?: string | null; category?: number; currency?: string; type?: number;
    parentId?: string | null; sortOrder?: number;
  };
  changeSequence: string;
}

async function fixture() {
  const db = new PGlite();
  await db.exec(await readFile(new URL('../doc/sql/init.sql', import.meta.url), 'utf8'));
  let tail = Promise.resolve();
  const query = (sql: string, params?: unknown[]) => db.query(sql, params);
  const pool = { query, async connect() {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    return { query, release };
  } } as unknown as Pool;
  const request = (entityType: Result['entityType'], content: Record<string, unknown>,
    entityId: string | null = null, expectedVersion = 0, action = 'save') =>
    ({ operationId: randomUUID(), entityType, entityId, expectedVersion, action, content });
  const submit = (payload: unknown) => masterData(pool, payload) as Promise<Result>;
  const accountContent = { name: 'Cash', category: 2, currency: 'CNY', active: true };
  const account = (balance: string | null = '100000') => submit(request('account', { ...accountContent, balance }));
  const category = (patch: Record<string, unknown> = {}) => submit(request('category', {
    name: 'Meals', type: 2, parentId: null, active: true, sortOrder: 0, ...patch,
  }));
  const calibrate = (id: string, version: number, balance: string | null, expectedBalance: string | null, reason = 'Counted cash') =>
    submit(request('account', { balance, expectedBalance, reason }, id, version, 'balance'));
  const expense = (await db.query<{ id: string }>('SELECT id::text FROM money_categories WHERE type=2 ORDER BY id LIMIT 1')).rows[0].id;
  const content = (id: string): BillContent => ({
    kind: 'expense', amountCents: 2500, accountId: id, categoryId: expense,
    occurredAt: 1793260800000, merchant: 'Lunch', note: '', tagIds: [],
    excludeFromStatistics: false, excludeFromBudget: false,
  });
  const bill = (id: string, billId: string = randomUUID(), expectedVersion = 0, patch: Record<string, unknown> = {}) =>
    bookkeeping(pool, 'v2/bills/submit', { operationId: randomUUID(), billId, expectedVersion,
      action: 'save', status: 'posted', content: content(id), ...patch }, new URLSearchParams()) as Promise<Bill>;
  const balance = async (id: string) => (await db.query<{ balance: string | null }>(
    'SELECT balance::text FROM money_accounts WHERE id=$1', [id])).rows[0].balance;
  return { db, pool, submit, request, accountContent, account, category, calibrate, content, bill, balance };
}

const conflict = (error: unknown) => error instanceof LedgerError && error.status === 409;
const invalid = (error: unknown) => error instanceof LedgerError && error.status === 400;

test('master data: versioned snapshots and durable normalized retries share the ledger sequence', async () => {
  const f = await fixture();
  try {
    const payload = f.request('account', { ...f.accountContent, balance: '100000' });
    const first = await f.submit(payload);
    assert.deepEqual(first, { entityType: 'account', entityId: first.entityId,
      snapshot: { id: first.entityId, ...f.accountContent, balance: '100000', type: 1, version: 1 },
      changeSequence: '1' });
    assert.deepEqual(await masterData(f.pool, { ...payload, operationId: payload.operationId.toUpperCase(),
      content: { balance: '100000', active: true, currency: 'CNY', category: 2, name: ' Cash ' } }), first);
    await assert.rejects(f.submit({ ...payload, content: { ...payload.content, name: 'Changed' } }), conflict);
    const changed = await f.submit(f.request('account', { ...f.accountContent, name: 'Wallet', active: false }, first.entityId, 1));
    assert.equal(changed.snapshot.version, 2);
    assert.equal(changed.snapshot.balance, '100000');
    assert.equal(changed.snapshot.active, false);
    await assert.rejects(f.submit(f.request('account', f.accountContent, first.entityId, 1)),
      (error: unknown) => conflict(error) && error instanceof LedgerError && error.code === 'VERSION_CONFLICT');
    const tag = await f.submit(f.request('tag', { name: 'Work', active: true, sortOrder: 3 }));
    const category = await f.category();
    assert.equal(tag.changeSequence, '3');
    assert.equal(category.changeSequence, '4');
    assert.deepEqual(tag.snapshot, { id: tag.entityId, name: 'Work', active: true, sortOrder: 3, version: 1 });
    assert.equal(category.snapshot.version, 1);
    const events = (await f.db.query<{ sequence: string; entity_type: string; entity_id: string; bill_id: null; snapshot: unknown }>(
      'SELECT sequence::text,entity_type,entity_id,bill_id,snapshot FROM money_changes ORDER BY sequence')).rows;
    assert.deepEqual(events.map(row => row.entity_type), ['account', 'account', 'tag', 'category']);
    assert.deepEqual(events[0], { sequence: '1', entity_type: 'account', entity_id: first.entityId, bill_id: null, snapshot: first.snapshot });
    assert.equal((await f.db.query('SELECT * FROM money_requests')).rows.length, 4);
  } finally { await f.db.close(); }
});

test('master data: malformed identifiers, fields and balance writes fail without effects', async () => {
  const f = await fixture();
  try {
    const base = f.request('account', f.accountContent);
    for (const patch of [
      { operationId: 'bad' }, { entityType: 'other' }, { action: 'delete' }, { entityId: undefined },
      { entityId: '0', expectedVersion: 1 }, { entityId: '9223372036854775808', expectedVersion: 1 },
      { entityId: null, expectedVersion: 1 }, { entityId: '1', expectedVersion: 0 },
      { expectedVersion: 0.5 }, { content: null },
      ...[{ name: '' }, { name: 'x'.repeat(101) }, { category: 10 }, { active: 'yes' },
        { currency: 'USD' }, { balance: 100 }, { balance: '1.2' }, { balance: '9007199254740992' }]
        .map(content => ({ content: { ...f.accountContent, ...content } })),
    ]) await assert.rejects(f.submit({ ...base, ...patch }), invalid);
    const account = await f.account();
    await assert.rejects(f.submit(f.request('account', { ...f.accountContent, balance: null }, account.entityId, 1)), invalid);
    await assert.rejects(f.calibrate(account.entityId, 1, '100', '100000', '  '), invalid);
    await assert.rejects(f.submit(f.request('account', { balance: '1', reason: 'Missing guard' }, account.entityId, 1, 'balance')), invalid);
    await assert.rejects(f.submit(f.request('account', { balance: '1', expectedBalance: null, reason: 'New' }, null, 0, 'balance')), invalid);
    for (const entityType of ['category', 'tag'] as const) {
      await assert.rejects(f.submit(f.request(entityType, { name: 'Bad', active: true, sortOrder: -1, type: 2, parentId: null })), invalid);
      await assert.rejects(f.submit(f.request(entityType, { name: 'Bad', active: true, sortOrder: 2147483648, type: 2, parentId: null })), invalid);
      await assert.rejects(f.submit(f.request(entityType, { balance: '1', expectedBalance: null, reason: 'Wrong entity' }, '1', 1, 'balance')), invalid);
    }
    await assert.rejects(f.submit(f.request('tag', { name: 'Missing', active: true, sortOrder: 0 }, '99999', 1)),
      (error: unknown) => error instanceof LedgerError && error.status === 404);
    assert.equal((await f.db.query('SELECT * FROM money_changes')).rows.length, 1);
    assert.equal((await f.db.query('SELECT * FROM money_requests')).rows.length, 1);
    assert.equal(await f.balance(account.entityId), '100000');
  } finally { await f.db.close(); }
});

test('master data: categories enforce two levels, same type, cycles and active parent rules', async () => {
  const f = await fixture();
  try {
    const root = await f.category();
    const child = await f.category({ parentId: root.entityId });
    await assert.rejects(f.category({ parentId: child.entityId }), invalid);
    await assert.rejects(f.category({ parentId: root.entityId, type: 1 }), invalid);
    await assert.rejects(f.category({ parentId: '99999' }), invalid);
    const edit = (result: Result, patch: Record<string, unknown>) => f.submit(f.request('category',
      { ...result.snapshot, ...patch }, result.entityId, result.snapshot.version));
    await assert.rejects(edit(root, { parentId: root.entityId }), invalid);
    await assert.rejects(edit(root, { parentId: child.entityId }), invalid);
    await assert.rejects(edit(root, { type: 1 }), invalid);
    await assert.rejects(edit(root, { active: false }), invalid);
    const inactiveChild = await edit(child, { active: false });
    const inactiveRoot = await edit(root, { active: false });
    await assert.rejects(f.category({ parentId: root.entityId }), invalid);
    await assert.rejects(edit(inactiveChild, { active: true }), invalid);
    assert.equal(inactiveRoot.snapshot.version, 2);
    assert.equal(inactiveRoot.snapshot.active, false);
    assert.equal(inactiveChild.snapshot.parentId, root.entityId);
  } finally { await f.db.close(); }
});

test('master data: referenced category structure is immutable but name and active state remain editable', async () => {
  const f = await fixture();
  try {
    const account = await f.account();
    const category = await f.category();
    const parent = await f.category();
    const bill = await f.bill(account.entityId, randomUUID(), 0,
      { content: { ...f.content(account.entityId), categoryId: category.entityId } });
    const edit = (patch: Record<string, unknown>) => f.submit(f.request('category',
      { ...category.snapshot, ...patch }, category.entityId, 1));
    await assert.rejects(edit({ type: 1 }), invalid);
    await assert.rejects(edit({ parentId: parent.entityId }), invalid);
    const disabled = await edit({ name: 'Past meals', active: false });
    assert.equal(disabled.snapshot.version, 2);
    assert.equal((await f.db.query<{ version: number }>('SELECT version FROM money_bills WHERE id=$1', [bill.billId])).rows[0].version, 1);
  } finally { await f.db.close(); }
});

test('master data: calibration retains actual effects, records reason, and guards bill balance races', async () => {
  const f = await fixture();
  try {
    const account = await f.account();
    const bill = await f.bill(account.entityId);
    await assert.rejects(f.calibrate(account.entityId, 1, '120000', '100000'),
      (error: unknown) => conflict(error) && error instanceof LedgerError && error.code === 'BALANCE_CONFLICT');
    const calibrated = await f.calibrate(account.entityId, 1, '120000', '97500');
    assert.equal(calibrated.snapshot.version, 2);
    assert.equal(calibrated.changeSequence, '3');
    assert.deepEqual((await f.db.query<{ applied_effect: unknown }>('SELECT applied_effect FROM money_bills WHERE id=$1', [bill.billId])).rows[0].applied_effect,
      { [account.entityId]: -2500 });
    await f.bill(account.entityId, bill.billId, 1, { action: 'delete' });
    assert.equal(await f.balance(account.entityId), '122500');
    const history = (await f.db.query('SELECT delta::text,balance_after::text,note,bill_id FROM money_balance_history WHERE reason=$1', ['balance'])).rows;
    assert.deepEqual(history, [{ delta: '22500', balance_after: '120000', note: 'Counted cash', bill_id: null }]);
  } finally { await f.db.close(); }
});

test('master data: unknown balance activation does not replay old bills', async () => {
  const f = await fixture();
  try {
    const account = await f.account(null);
    const bill = await f.bill(account.entityId);
    await f.calibrate(account.entityId, 1, '50000', null);
    await f.bill(account.entityId, bill.billId, 1, { content: { ...f.content(account.entityId), note: 'Note only' } });
    await f.bill(account.entityId, bill.billId, 2, { action: 'delete' });
    await f.bill(account.entityId, bill.billId, 3, { action: 'restore' });
    assert.equal(await f.balance(account.entityId), '50000');
    const history = (await f.db.query('SELECT delta,balance_after::text FROM money_balance_history WHERE reason=$1', ['balance'])).rows;
    assert.deepEqual(history, [{ delta: null, balance_after: '50000' }]);
  } finally { await f.db.close(); }
});

test('master data: disabling balance invalidates live and deleted bill versions and preserves other transfer effects', async () => {
  const f = await fixture();
  try {
    const account = await f.account();
    const bank = await f.account('200000');
    const transferCategory = (await f.db.query<{ id: string }>('SELECT id::text FROM money_categories WHERE type=3 LIMIT 1')).rows[0].id;
    const sources: Source[] = [
      { app: 'bank', key: 'transfer-1', capturedAt: 1793260800000, ruleVersion: '1' },
      { app: 'wechat', key: 'payment-1', capturedAt: 1793260800100, ruleVersion: '2' },
    ];
    const live = await f.bill(account.entityId, randomUUID(), 0, { content: {
      ...f.content(account.entityId), kind: 'transfer', destinationAccountId: bank.entityId, categoryId: transferCategory,
    }, sources });
    const deleted = await f.bill(account.entityId);
    await f.bill(account.entityId, deleted.billId, 1, { action: 'delete' });
    const payload = f.request('account', { balance: null, expectedBalance: '97500', reason: 'Stop tracking' }, account.entityId, 1, 'balance');
    const disabled = await f.submit(payload);
    assert.deepEqual(await f.submit(payload), disabled);
    assert.equal(disabled.snapshot.balance, null);
    const rows = (await f.db.query<{ id: string; version: number; applied_effect: unknown; restore_effect: unknown }>(
      'SELECT id,version,applied_effect,restore_effect FROM money_bills ORDER BY id')).rows;
    const liveRow = rows.find(row => row.id === live.billId)!;
    const deletedRow = rows.find(row => row.id === deleted.billId)!;
    assert.equal(liveRow.version, 2);
    assert.equal(deletedRow.version, 3);
    assert.deepEqual(liveRow.applied_effect, { [bank.entityId]: 2500 });
    assert.deepEqual(liveRow.restore_effect, { [bank.entityId]: 2500 });
    assert.deepEqual(deletedRow.applied_effect, {});
    assert.deepEqual(deletedRow.restore_effect, {});
    const snapshots = (await f.db.query<{ bill_id: string; snapshot: Bill & {
      appliedEffect: Record<string, number>; restoreEffect: Record<string, number>; sources: Source[];
    } }>(
      'SELECT bill_id,snapshot FROM money_changes WHERE sequence>5 AND bill_id IS NOT NULL ORDER BY sequence')).rows;
    assert.equal(snapshots.length, 2);
    const liveSnapshot = snapshots.find(row => row.bill_id === live.billId)!.snapshot;
    assert.deepEqual(liveSnapshot.appliedEffect, { [bank.entityId]: 2500 });
    assert.deepEqual(liveSnapshot.restoreEffect, { [bank.entityId]: 2500 });
    assert.deepEqual(liveSnapshot.sources, sources);
    const deletedSnapshot = snapshots.find(row => row.bill_id === deleted.billId)!.snapshot;
    assert.deepEqual(deletedSnapshot.appliedEffect, {});
    assert.deepEqual(deletedSnapshot.restoreEffect, {});
    assert.deepEqual(deletedSnapshot.sources, []);
    for (const row of snapshots) {
      const detail = await bookkeeping(f.pool, 'v2/bills/detail', undefined, new URLSearchParams({ billId: row.bill_id })) as Bill & { sources: unknown[] };
      const stored = rows.find(bill => bill.id === row.bill_id)!;
      assert.deepEqual(row.snapshot, { ...detail, appliedEffect: stored.applied_effect, restoreEffect: stored.restore_effect });
      assert.ok(BigInt(row.snapshot.changeSequence) < BigInt(disabled.changeSequence));
    }
    await assert.rejects(f.bill(account.entityId, live.billId, 1, { action: 'delete' }), conflict);
    await f.calibrate(account.entityId, 2, '50000', null);
    await f.bill(account.entityId, live.billId, 2, { action: 'delete' });
    await f.bill(account.entityId, live.billId, 3, { action: 'restore' });
    await f.bill(account.entityId, deleted.billId, 3, { action: 'restore' });
    assert.equal(await f.balance(account.entityId), '50000');
    assert.equal(await f.balance(bank.entityId), '202500');
    const history = (await f.db.query('SELECT delta,balance_after::text FROM money_balance_history WHERE reason=$1 ORDER BY sequence', ['balance'])).rows;
    assert.deepEqual(history, [{ delta: null, balance_after: null }, { delta: null, balance_after: '50000' }]);
  } finally { await f.db.close(); }
});

test('master data: unsafe calibration delta rolls back and only one same-version concurrent edit wins', async () => {
  const f = await fixture();
  try {
    const account = await f.account(String(-Number.MAX_SAFE_INTEGER));
    await assert.rejects(f.calibrate(account.entityId, 1, String(Number.MAX_SAFE_INTEGER), String(-Number.MAX_SAFE_INTEGER)), invalid);
    assert.equal(await f.balance(account.entityId), String(-Number.MAX_SAFE_INTEGER));
    const results = await Promise.allSettled([
      f.submit(f.request('account', { ...f.accountContent, name: 'First' }, account.entityId, 1)),
      f.submit(f.request('account', { ...f.accountContent, name: 'Second' }, account.entityId, 1)),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.ok(rejected?.status === 'rejected' && conflict(rejected.reason));
    assert.equal((await f.db.query('SELECT * FROM money_changes')).rows.length, 2);
    assert.equal((await f.db.query('SELECT * FROM money_balance_history')).rows.length, 0);
  } finally { await f.db.close(); }
});

test('master data: account deactivation preserves actual effects and old retry snapshots', async () => {
  const f = await fixture();
  try {
    const payload = f.request('account', { ...f.accountContent, balance: '100000' });
    const account = await f.submit(payload);
    const bill = await f.bill(account.entityId);
    const disabled = await f.submit(f.request('account', { ...f.accountContent, active: false }, account.entityId, 1));
    assert.equal(disabled.snapshot.balance, '97500');
    assert.deepEqual((await f.db.query<{ applied_effect: unknown; version: number }>(
      'SELECT applied_effect,version FROM money_bills WHERE id=$1', [bill.billId])).rows[0],
    { applied_effect: { [account.entityId]: -2500 }, version: 1 });
    assert.deepEqual(await f.submit(payload), account);
    assert.equal((await f.db.query('SELECT * FROM money_balance_history')).rows.length, 1);
  } finally { await f.db.close(); }
});

test('master data: tag updates check versions and calibration replay returns the original result', async () => {
  const f = await fixture();
  try {
    const tag = await f.submit(f.request('tag', { name: 'Work', active: true, sortOrder: 0 }));
    const updated = await f.submit(f.request('tag', { name: 'Past work', active: false, sortOrder: 10 }, tag.entityId, 1));
    assert.deepEqual(updated.snapshot, { id: tag.entityId, name: 'Past work', active: false, sortOrder: 10, version: 2 });
    await assert.rejects(f.submit(f.request('tag', { name: 'Stale', active: true, sortOrder: 0 }, tag.entityId, 1)), conflict);
    const account = await f.account();
    const payload = f.request('account', { balance: '90000', expectedBalance: '100000', reason: 'Counted' }, account.entityId, 1, 'balance');
    const calibrated = await f.submit(payload);
    await f.bill(account.entityId);
    assert.deepEqual(await f.submit(payload), calibrated);
    assert.equal(await f.balance(account.entityId), '87500');
    await assert.rejects(f.submit({ ...payload, content: { ...payload.content, reason: 'Different reason' } }), conflict);
    assert.equal((await f.db.query("SELECT * FROM money_balance_history WHERE reason='balance'")).rows.length, 1);
  } finally { await f.db.close(); }
});

test('master data: legacy-only category references prevent structural changes', async () => {
  const f = await fixture();
  try {
    const account = await f.account();
    const category = await f.category();
    await f.db.query(`INSERT INTO money_transactions(type,time,category_id,source_account_id,source_amount)
      VALUES(3,1,$1,$2,100)`, [category.entityId, account.entityId]);
    await assert.rejects(f.submit(f.request('category', { ...category.snapshot, type: 1 }, category.entityId, 1)), invalid);
    assert.equal((await f.db.query('SELECT * FROM money_changes')).rows.length, 2);
  } finally { await f.db.close(); }
});

test('master data: failure after stripping effects rolls back bill versions, balance, sequence and idempotence', async () => {
  const f = await fixture();
  try {
    const account = await f.account();
    const bill = await f.bill(account.entityId);
    await f.db.query('UPDATE money_ledger_state SET sequence=$1 WHERE id=1', ['9223372036854775806']);
    const payload = f.request('account', { balance: null, expectedBalance: '97500', reason: 'Stop' }, account.entityId, 1, 'balance');
    // A bill change fits, but the following master change exceeds PostgreSQL bigint.
    await assert.rejects(f.submit(payload), invalid);
    const row = (await f.db.query<{ version: number; applied_effect: unknown; restore_effect: unknown }>(
      'SELECT version,applied_effect,restore_effect FROM money_bills WHERE id=$1', [bill.billId])).rows[0];
    assert.deepEqual(row, { version: 1, applied_effect: { [account.entityId]: -2500 }, restore_effect: { [account.entityId]: -2500 } });
    assert.equal(await f.balance(account.entityId), '97500');
    assert.equal((await f.db.query<{ sequence: string }>('SELECT sequence::text FROM money_ledger_state')).rows[0].sequence, '9223372036854775806');
    assert.equal((await f.db.query('SELECT * FROM money_changes')).rows.length, 2);
    assert.equal((await f.db.query('SELECT * FROM money_requests')).rows.length, 2);
    await f.db.query('UPDATE money_ledger_state SET sequence=2 WHERE id=1');
    assert.equal((await f.submit(payload)).snapshot.balance, null);
  } finally { await f.db.close(); }
});
