import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { bookkeeping, type Bill } from './bookkeeping.js';
import { ledger, LedgerError } from './ledger.js';

interface Page {
  changes: { sequence: string; entityType: string; entityId: string; snapshot: Record<string, unknown> }[];
  nextSequence: string;
  hasMore: boolean;
  accounts: { id: string; balance: string | null }[];
}

async function fixture() {
  const db = new PGlite();
  await db.exec(await readFile(new URL('../doc/sql/init.sql', import.meta.url), 'utf8'));
  const query = (sql: string, params?: unknown[]) => db.query(sql, params);
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  const call = (route: string, body?: unknown, query = '') => bookkeeping(pool, `v2/${route}`, body, new URLSearchParams(query));
  const account = await ledger(pool, 'v1/accounts/add', {
    name: '隔离同步钱包', category: 1, balance: '100000', currency: 'CNY', clientSessionId: randomUUID(),
  }, new URLSearchParams()) as { id: string };
  const submit = (billId: string, version = 0, action = 'save', occurredAt = 1000) => call('bills/submit', {
    operationId: randomUUID(), billId, expectedVersion: version, action, status: 'posted',
    content: { kind: 'expense', amountCents: 500, accountId: account.id, categoryId: '3', occurredAt,
      merchant: '合成商户', note: '', tagIds: [], excludeFromStatistics: false, excludeFromBudget: false },
  }) as Promise<Bill>;
  const changes = (after: string, count = 200) => call('sync/changes', undefined, `after=${after}&count=${count}`) as Promise<Page>;
  return { db, pool, call, submit, changes, account };
}

test('incremental sync pages by commit sequence and includes compatibility master changes', async () => {
  const f = await fixture();
  try {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (let i = 0; i < ids.length; i++) await f.submit(ids[i], 0, 'save', 3000 - i * 1000);
    const first = await f.changes('0', 2);
    assert.equal(first.hasMore, true);
    assert.deepEqual(first.changes.map(c => c.entityType), ['account', 'bill']);
    assert.equal(first.changes[0].entityId, f.account.id);
    assert.equal(first.nextSequence, first.changes[1].sequence);
    const second = await f.changes(first.nextSequence, 2);
    assert.equal(second.hasMore, false);
    assert.deepEqual(second.changes.map(c => c.entityId), ids.slice(1));
    assert.equal(second.nextSequence, second.changes[1].sequence);
    assert.equal(second.accounts[0].balance, '98500');
    const empty = await f.changes(second.nextSequence);
    assert.equal(empty.hasMore, false);
    assert.deepEqual(empty.changes, []);
    assert.equal(empty.nextSequence, second.nextSequence);
    await ledger(f.pool, 'v1/transaction/categories/add', {
      name: '新增分类', type: 2, clientSessionId: randomUUID(),
    }, new URLSearchParams());
    const master = await f.changes(empty.nextSequence);
    assert.equal(master.changes[0].entityType, 'category');
    assert.equal(master.hasMore, false);
  } finally { await f.db.close(); }
});

test('snapshot to incremental handoff includes pending, edits, deletion and restoration', async () => {
  const f = await fixture();
  try {
    const snapshot = await f.call('snapshot') as { sequence: string };
    const id = randomUUID();
    await f.submit(id);
    await f.submit(id, 1, 'delete');
    await f.submit(id, 2, 'restore');
    const page = await f.changes(snapshot.sequence);
    assert.deepEqual(page.changes.map(c => c.snapshot.status), ['posted', 'deleted', 'posted']);
    assert.deepEqual(page.changes.map(c => c.snapshot.version), [1, 2, 3]);
    const replay = await f.changes(snapshot.sequence);
    assert.deepEqual(replay.changes, page.changes);
    assert.equal(page.accounts[0].balance, '99500');
  } finally { await f.db.close(); }
});

test('expiry appends a scrubbed tombstone even for an already caught-up device', async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    await f.submit(id);
    const deleted = await f.submit(id, 1, 'delete');
    await f.db.query('UPDATE money_bills SET deleted_at=$1 WHERE id=$2', [Date.now() - 31 * 86400000, id]);
    const page = await f.changes(deleted.changeSequence);
    assert.equal(page.changes.length, 1);
    assert.equal(page.changes[0].entityId, id);
    assert.equal(page.changes[0].snapshot.expired, true);
    assert.equal(page.changes[0].snapshot.legacyId, deleted.legacyId);
    assert.equal(Object.hasOwn(page.changes[0].snapshot, 'content'), false);
    const all = await f.changes('0');
    assert.equal(JSON.stringify(all.changes.filter(c => c.entityType === 'bill')).includes('合成商户'), false);
    assert.equal((await f.changes(page.nextSequence)).changes.length, 0);
    const snapshot = await f.call('snapshot') as { tombstones?: { billId: string; legacyId: string | null; expired: boolean }[] };
    assert.deepEqual(snapshot.tombstones?.map(b => [b.billId, b.legacyId, b.expired]), [[id, deleted.legacyId, true]]);
    await assert.rejects(f.submit(id, 2), (e: unknown) => e instanceof LedgerError && e.status === 409);
  } finally { await f.db.close(); }
});

test('incremental cursor validation never rounds bigint strings or silently skips a restored database', async () => {
  const f = await fixture();
  try {
    for (const value of ['-1', '01', '1.5', '1e2', '9223372036854775808', '']) {
      await assert.rejects(f.changes(value), (e: unknown) => e instanceof LedgerError && e.status === 400);
    }
    for (const value of ['0', '-1', '201', '1.5', 'NaN']) {
      await assert.rejects(f.call('sync/changes', undefined, `after=0&count=${value}`), LedgerError);
    }
    await assert.rejects(f.changes('9007199254740992'), (e: unknown) => e instanceof LedgerError && e.code === 'CURSOR_INVALID');
    await f.db.query("UPDATE money_ledger_state SET sequence=9007199254740992 WHERE id=1");
    assert.equal((await f.changes('9007199254740992')).nextSequence, '9007199254740992');
  } finally { await f.db.close(); }
});
