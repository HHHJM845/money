import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { ledger, LedgerError } from './ledger.js';
import { bookkeeping, type Bill, type BillContent } from './bookkeeping.js';

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
  const call = (route: string, body?: unknown, q = '') => bookkeeping(pool, `v2/${route}`, body, new URLSearchParams(q));
  const account = async (name: string, balance: string | null) => await ledger(pool, 'v1/accounts/add', {
    name, balance, category: 2, currency: 'CNY', clientSessionId: randomUUID(),
  }, new URLSearchParams()) as { id: string };
  const cash = await account('现金', '100000');
  const bank = await account('银行卡', '200000');
  const unknown = await account('未设置余额', null);
  const categories = await ledger(pool, 'v1/transaction/categories/list', undefined, new URLSearchParams()) as Record<string, { id: string }[]>;
  const expense = categories['2'][0].id;
  const content: BillContent = {
    kind: 'expense', amountCents: 2500, accountId: cash.id, categoryId: expense,
    occurredAt: Date.parse('2026-10-29T04:00:00Z'), merchant: '午餐', note: '', tagIds: [],
    excludeFromStatistics: false, excludeFromBudget: false,
  };
  const submit = (billId: string, expectedVersion: number, patch: Record<string, unknown> = {}) => call('bills/submit', {
    operationId: randomUUID(), billId, expectedVersion, action: 'save', status: 'posted', content, ...patch,
  }) as Promise<Bill>;
  const balances = async () => (await db.query<{ balance: string | null }>('SELECT balance::text FROM money_accounts ORDER BY id')).rows.map(r => r.balance);
  return { db, pool, call, submit, balances, cash, bank, unknown, content, categories };
}

test('bookkeeping: edits, account moves, deletion and restoration apply exact effects atomically', async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    let bill = await f.submit(id, 0);
    assert.equal(bill.version, 1);
    assert.deepEqual(bill.appliedEffect, { [f.cash.id]: -2500 });
    assert.deepEqual(await f.balances(), ['97500', '200000', null]);
    bill = await f.submit(id, bill.version, { content: { ...f.content, amountCents: 3000 } });
    assert.deepEqual(await f.balances(), ['97000', '200000', null]);
    bill = await f.submit(id, bill.version, { content: { ...f.content, amountCents: 3000, accountId: f.bank.id } });
    assert.deepEqual(await f.balances(), ['100000', '197000', null]);
    bill = await f.submit(id, bill.version, { action: 'delete', content: undefined });
    assert.deepEqual(bill.appliedEffect, {});
    assert.deepEqual(bill.restoreEffect, { [f.bank.id]: -3000 });
    assert.deepEqual(await f.balances(), ['100000', '200000', null]);
    bill = await f.submit(id, bill.version, { action: 'restore', content: undefined });
    assert.deepEqual(await f.balances(), ['100000', '197000', null]);
    assert.equal(bill.status, 'posted');
    const history = await f.call('accounts/history', undefined, `accountId=${f.bank.id}`) as { deltaCents: number }[];
    assert.deepEqual(history.map(r => r.deltaCents), [-3000, 3000, -3000]);
    assert.equal((await f.db.query('SELECT * FROM money_transactions')).rows.length, 1);
    assert.equal((await f.db.query("SELECT * FROM money_changes WHERE entity_type='bill'")).rows.length, 5);
  } finally { await f.db.close(); }
});

test('bookkeeping: stable retries, stale edits, changed payload and duplicate sources', async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    const operationId = randomUUID();
    const payload = { operationId, billId: id, expectedVersion: 0, action: 'save', status: 'posted', content: f.content,
      sources: [{ app: 'wechat', key: 'order-123', capturedAt: f.content.occurredAt, ruleVersion: '1' }] };
    const first = await f.call('bills/submit', payload);
    const { note, ...rest } = f.content;
    assert.deepEqual(await f.call('bills/submit', { ...payload, content: { note, ...rest } }), first);
    await assert.rejects(f.call('bills/submit', { ...payload, content: { ...f.content, amountCents: 1 } }), (e: unknown) => e instanceof LedgerError && e.status === 409);
    await assert.rejects(f.submit(id, 0), (e: unknown) => e instanceof LedgerError && e.status === 409);
    await assert.rejects(f.call('bills/submit', { ...payload, operationId: randomUUID(), billId: randomUUID() }), (e: unknown) => e instanceof LedgerError && e.status === 409);
    // The same amount/time without shared source identity is another real transaction.
    await f.submit(randomUUID(), 0);
    assert.deepEqual(await f.balances(), ['95000', '200000', null]);
    assert.equal((await f.db.query('SELECT * FROM money_bills')).rows.length, 2);
  } finally { await f.db.close(); }
});

test('bookkeeping: pending and historical imports do not change balances on edit/delete/restore', async () => {
  const f = await fixture();
  try {
    const pending = randomUUID();
    let bill = await f.submit(pending, 0, { status: 'pending', content: { ...f.content, accountId: null, amountCents: null } });
    assert.deepEqual(await f.balances(), ['100000', '200000', null]);
    bill = await f.submit(pending, bill.version);
    assert.deepEqual(await f.balances(), ['97500', '200000', null]);
    const imported = randomUUID();
    bill = await f.submit(imported, 0, { balanceMode: 'preserve' });
    bill = await f.submit(imported, bill.version, { content: { ...f.content, amountCents: 9000 } });
    bill = await f.submit(imported, bill.version, { action: 'delete' });
    await f.submit(imported, bill.version, { action: 'restore' });
    assert.deepEqual(await f.balances(), ['97500', '200000', null]);
    await f.submit(randomUUID(), 0, { content: { ...f.content, accountId: f.unknown.id } });
    assert.equal((await f.balances())[2], null);
  } finally { await f.db.close(); }
});

test('bookkeeping: linked refunds cannot exceed the expense or silently invalidate its links', async () => {
  const f = await fixture();
  try {
    const expenseId = randomUUID();
    const original = await f.submit(expenseId, 0);
    const refundId = randomUUID();
    const refundContent = { ...f.content, kind: 'refund', amountCents: 500, accountId: f.bank.id,
      refundOfBillId: expenseId, occurredAt: Date.parse('2026-11-02T04:00:00Z') };
    const refund = await f.submit(refundId, 0, { content: refundContent });
    assert.deepEqual(await f.balances(), ['97500', '200500', null]);
    await assert.rejects(f.submit(randomUUID(), 0, { content: { ...refundContent, amountCents: 2001 } }), LedgerError);
    await assert.rejects(f.submit(expenseId, original.version, { action: 'delete' }), LedgerError);
    await assert.rejects(f.submit(expenseId, original.version, { content: { ...f.content, amountCents: 400 } }), LedgerError);
    await f.submit(refundId, refund.version, { action: 'delete' });
    await f.submit(refundId, refund.version + 1, { action: 'restore' });
    await f.submit(refundId, refund.version + 2, { action: 'delete' });
    await f.submit(expenseId, original.version, { action: 'delete' });
    assert.deepEqual(await f.balances(), ['100000', '200000', null]);
    await assert.rejects(f.submit(refundId, refund.version + 3, { action: 'restore' }), LedgerError);
  } finally { await f.db.close(); }
});

test('bookkeeping: expired restoration and invalid fields roll back all effects', async () => {
  const f = await fixture();
  try {
    for (const patch of [
      { amountCents: 0 }, { amountCents: 0.5 }, { accountId: '9999' },
      { categoryId: f.categories['1'][0].id }, { tagIds: ['9999'] },
      { occurredAt: NaN }, { merchant: 'x'.repeat(201) },
      { kind: 'transfer', destinationAccountId: f.cash.id },
    ]) await assert.rejects(f.submit(randomUUID(), 0, { content: { ...f.content, ...patch } }), LedgerError);
    await f.db.query('UPDATE money_categories SET active=false WHERE id=$1', [f.content.categoryId]);
    await assert.rejects(f.submit(randomUUID(), 0), LedgerError);
    await f.db.query('UPDATE money_categories SET active=true WHERE id=$1', [f.content.categoryId]);
    await f.db.query('UPDATE money_accounts SET balance=$1 WHERE id=$2', [String(-Number.MAX_SAFE_INTEGER), f.cash.id]);
    await assert.rejects(f.submit(randomUUID(), 0), LedgerError);
    assert.equal((await f.db.query('SELECT * FROM money_bills')).rows.length, 0);
    await f.db.query('UPDATE money_accounts SET balance=100000 WHERE id=$1', [f.cash.id]);
    const id = randomUUID();
    await f.submit(id, 0);
    await f.submit(id, 1, { action: 'delete' });
    await f.db.query('UPDATE money_bills SET deleted_at=$1 WHERE id=$2', [Date.now() - 31 * 86400000, id]);
    await assert.rejects(f.submit(id, 2, { action: 'restore' }), LedgerError);
    await assert.rejects(f.submit(id, 2), LedgerError);
    assert.deepEqual(await f.balances(), ['100000', '200000', null]);
  } finally { await f.db.close(); }
});

test('expired deleted content is scrubbed from all replay paths while identity remains', async () => {
  const f = await fixture();
  try {
    const billId = randomUUID();
    const payload = { operationId: randomUUID(), billId, expectedVersion: 0, action: 'save',
      status: 'posted', content: { ...f.content, merchant: 'scrub-this-merchant', note: 'scrub-this-note' } };
    await f.call('bills/submit', payload);
    await f.submit(billId, 1, { action: 'delete' });
    await f.db.query('UPDATE money_bills SET deleted_at=$1 WHERE id=$2', [Date.now() - 31 * 86400000, billId]);
    await assert.rejects(f.call('bills/submit', payload), (e: unknown) => e instanceof LedgerError && e.status === 410 && e.code === 'RECORD_EXPIRED');
    await assert.rejects(f.call('bills/detail', undefined, `billId=${billId}`), (e: unknown) => e instanceof LedgerError && e.status === 404);
    const bill = (await f.db.query<{ version: number; content: unknown; legacy_id: string }>('SELECT version,content,legacy_id::text FROM money_bills WHERE id=$1', [billId])).rows[0];
    assert.deepEqual(bill.content, {});
    assert.equal(bill.version, 2);
    assert.ok(bill.legacy_id);
    assert.equal((await f.db.query('SELECT * FROM money_transactions')).rows.length, 0);
    const copies = JSON.stringify([
      (await f.db.query('SELECT * FROM money_requests')).rows,
      (await f.db.query('SELECT * FROM money_changes')).rows,
    ]);
    assert.equal(copies.includes('scrub-this-merchant'), false);
    assert.equal(copies.includes('scrub-this-note'), false);
    await assert.rejects(f.submit(billId, 0), (e: unknown) => e instanceof LedgerError && e.status === 409);
    assert.deepEqual(await f.balances(), ['100000', '200000', null]);
  } finally { await f.db.close(); }
});

test('a newly enabled balance baseline never replays an existing unknown-balance expense', async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    const content = { ...f.content, accountId: f.unknown.id };
    await f.submit(id, 0, { content });
    // Model the explicit account-baseline transition; there is no calibration API yet.
    await f.db.query('UPDATE money_accounts SET balance=50000 WHERE id=$1', [f.unknown.id]);
    await f.submit(id, 1, { content: { ...content, note: '仅补备注' } });
    assert.equal((await f.balances())[2], '50000');
    await f.submit(id, 2, { action: 'delete' });
    await f.submit(id, 3, { action: 'restore' });
    assert.equal((await f.balances())[2], '50000');
  } finally { await f.db.close(); }
});

test('inactive master references stay readable and editable but cannot be assigned to new posted bills', async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    await f.submit(id, 0);
    await f.db.query('UPDATE money_accounts SET active=false WHERE id=$1', [f.cash.id]);
    await f.db.query('UPDATE money_categories SET active=false WHERE id=$1', [f.content.categoryId]);
    const updated = await f.submit(id, 1, { content: { ...f.content, note: '保留原有历史关联' } });
    assert.equal(updated.version, 2);
    await assert.rejects(f.submit(randomUUID(), 0), LedgerError);
    await f.submit(id, 2, { action: 'delete' });
    await f.submit(id, 3, { action: 'restore' });
    assert.deepEqual(await f.balances(), ['97500', '200000', null]);
    await f.submit(randomUUID(), 0, { content: {
      ...f.content, kind: 'refund', accountId: f.bank.id, refundOfBillId: id, amountCents: 100,
    } });
    assert.deepEqual(await f.balances(), ['97500', '200100', null]);
  } finally { await f.db.close(); }
});

test('deleted pending bills expose their restore status for offline clients', async () => {
  const f = await fixture();
  try {
    const billId = randomUUID();
    await f.submit(billId, 0, { status: 'pending' });
    const deleted = await f.submit(billId, 1, { action: 'delete' });
    assert.equal(deleted.restoreStatus, 'pending');
    const snapshot = await f.call('snapshot') as { bills: Bill[] };
    assert.equal(snapshot.bills.find(b => b.billId === billId)?.restoreStatus, 'pending');
    const restored = await f.submit(billId, 2, { action: 'restore' });
    assert.equal(restored.status, 'pending');
    assert.deepEqual(await f.balances(), ['100000', '200000', null]);
  } finally { await f.db.close(); }
});
