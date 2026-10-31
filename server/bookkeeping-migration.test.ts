import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { ledger } from './ledger.js';
import { bookkeeping, type Bill } from './bookkeeping.js';

const increment = await readFile(new URL('../doc/sql/increment.sql', import.meta.url), 'utf8');
const marker = '-- 2026-10-30 自动收支记账结构基线';
const offset = increment.indexOf(marker);
assert.ok(offset > 0);
const oldSchema = increment.slice(0, offset);
const upgrade = increment.slice(offset);
const bridgeOffset = increment.indexOf('\n-- 2026-10-31 compatibility bridge');
assert.ok(bridgeOffset > offset);
const remoteBaseline = increment.slice(0, bridgeOffset);
const appended = increment.slice(bridgeOffset);

test('remote 348a9e7 increment history is preserved byte for byte', () => {
  assert.equal(createHash('sha256').update(remoteBaseline).digest('hex'),
    '387cfa0d1a9fcb424d85670f64f72736ab3b9f1667229b635878952d6de86de2');
});

test('actual original five-table empty production fixture upgrades without changing seed data', async () => {
  const db = new PGlite();
  try {
    await db.exec(oldSchema);
    assert.equal((await db.query("SELECT * FROM pg_tables WHERE schemaname='public'")).rows.length, 5);
    const categories = (await db.query('SELECT * FROM money_categories ORDER BY id')).rows;
    assert.equal(categories.length, 7);
    for (const table of ['money_accounts', 'money_transactions', 'money_requests']) {
      assert.equal((await db.query(`SELECT * FROM ${table}`)).rows.length, 0);
    }
    await db.exec(upgrade);
    assert.deepEqual((await db.query('SELECT id,name,type FROM money_categories ORDER BY id')).rows, categories);
    for (const table of ['money_accounts', 'money_transactions', 'money_requests', 'money_bills', 'money_balance_history']) {
      assert.equal((await db.query(`SELECT * FROM ${table}`)).rows.length, 0);
    }
  } finally { await db.close(); }
});

test('remote baseline tail preserves unknown balances, category state and archived balance history', async () => {
  const db = new PGlite();
  try {
    await db.exec(remoteBaseline);
    await db.exec(`INSERT INTO money_accounts(name,category,balance) VALUES('未知余额',2,NULL);
      UPDATE money_categories SET deactivated=true WHERE id=3;
      INSERT INTO money_tags(name) VALUES('保留标签');
      INSERT INTO money_balance_history(account_id,recorded_at,balance_after,reason)
        VALUES(1,1793232000000,NULL,'未启用余额');`);
    const history = (await db.query('SELECT * FROM money_balance_history')).rows;
    const changes = (await db.query('SELECT * FROM money_change_log ORDER BY change_sequence')).rows;
    await db.exec(appended);
    assert.deepEqual((await db.query('SELECT * FROM money_balance_history_legacy_20261030')).rows, history);
    assert.deepEqual((await db.query('SELECT * FROM money_change_log ORDER BY change_sequence')).rows, changes);
    assert.deepEqual((await db.query('SELECT balance FROM money_accounts')).rows, [{ balance: null }]);
    assert.deepEqual((await db.query('SELECT active FROM money_categories WHERE id=3')).rows, [{ active: false }]);
    assert.deepEqual((await db.query('SELECT name,active,version FROM money_tags')).rows,
      [{ name: '保留标签', active: true, version: 1 }]);
    await db.query("INSERT INTO money_balance_history_legacy_20261030(account_id,recorded_at,reason) VALUES(1,1793232000001,'保留序列')");
    assert.equal((await db.query('SELECT * FROM money_balance_history')).rows.length, 0);
    const query = (sql: string, params?: unknown[]) => db.query(sql, params);
    const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
    await bookkeeping(pool, 'v2/bills/submit', { operationId: randomUUID(), billId: randomUUID(),
      expectedVersion: 0, action: 'save', status: 'posted', content: { kind: 'income', amountCents: 100,
        accountId: '1', categoryId: '1', occurredAt: 1793232000000, merchant: '', note: '', tagIds: [],
        excludeFromStatistics: false, excludeFromBudget: false } }, new URLSearchParams());
    assert.deepEqual((await db.query('SELECT balance FROM money_accounts')).rows, [{ balance: null }]);
    assert.equal((await ledger(pool, 'v1/transactions/list', undefined, new URLSearchParams()) as { items: unknown[] }).items.length, 1);
  } finally { await db.close(); }
});

for (const [label, fixture] of [
  ['operations', "INSERT INTO money_operations(operation_id,payload,status,created_at) VALUES(gen_random_uuid(),'{}','received',1)"],
  ['sources', "INSERT INTO money_transaction_sources(transaction_id,app,scope,source_key) VALUES(1,'app','scope','key')"],
  ['tag links', 'INSERT INTO money_transaction_tags(transaction_id,tag_id) VALUES(1,1)'],
  ['deletion markers', 'INSERT INTO money_deletion_markers(stable_id,transaction_id,last_version,deleted_at) VALUES(gen_random_uuid(),1,1,1)'],
  ['pending bills', "INSERT INTO money_transactions(type,status,time,category_id,source_amount) VALUES(1,'pending',1,3,0)"],
  ['ambiguous balance', "INSERT INTO money_accounts(name,category,balance) VALUES('禁猜余额',2,123)"],
] as const) {
  test(`compatibility bridge refuses ${label} and rolls back without losing old data`, async () => {
    const db = new PGlite();
    try {
      await db.exec(remoteBaseline);
      await db.exec(fixture);
      const rows = async () => {
        const tables = await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
        return Promise.all(tables.rows.map(async ({ tablename }) => ({ table: tablename,
          rows: (await db.query(`SELECT to_jsonb(t) AS row FROM ${tablename} t ORDER BY to_jsonb(t)::text`)).rows })));
      };
      const before = await rows();
      await assert.rejects(db.exec(appended), /compatibility bridge refused/);
      await db.exec('ROLLBACK');
      assert.deepEqual(await rows(), before);
      assert.equal((await db.query<{ table_name: string | null }>("SELECT to_regclass('money_bills') AS table_name")).rows[0].table_name, null);
    } finally { await db.close(); }
  });
}

test('M2 empty initialization and historical upgrade produce equivalent structure', async () => {
  const initial = new PGlite();
  const upgraded = new PGlite();
  const alreadyRemote = new PGlite();
  try {
    await initial.exec(await readFile(new URL('../doc/sql/init.sql', import.meta.url), 'utf8'));
    await upgraded.exec(increment);
    await alreadyRemote.exec(remoteBaseline);
    await alreadyRemote.exec(appended);
    const metadata = `SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,
      pg_get_expr(d.adbin,d.adrelid) AS default_value,col_description(c.oid,a.attnum) AS comment
      FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relname LIKE 'money_%'
      AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`;
    assert.deepEqual((await upgraded.query(metadata)).rows, (await initial.query(metadata)).rows);
    assert.deepEqual((await alreadyRemote.query(metadata)).rows, (await initial.query(metadata)).rows);
    // PostgreSQL 18 names NOT NULL constraints after the original table name on rename.
    // Compare their semantics; attnotnull above also checks every column independently.
    const constraints = `SELECT c.relname,CASE WHEN con.contype='n' THEN NULL ELSE con.conname END AS name,
      pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
      WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'money_%' ORDER BY c.relname,name,definition`;
    assert.deepEqual((await upgraded.query(constraints)).rows, (await initial.query(constraints)).rows);
    assert.deepEqual((await alreadyRemote.query(constraints)).rows, (await initial.query(constraints)).rows);
    const indexes = "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename LIKE 'money_%' ORDER BY indexname";
    assert.deepEqual((await upgraded.query(indexes)).rows, (await initial.query(indexes)).rows);
    assert.deepEqual((await alreadyRemote.query(indexes)).rows, (await initial.query(indexes)).rows);
    const seeds = 'SELECT entity,entity_id,version,change_kind FROM money_change_log ORDER BY change_sequence';
    assert.deepEqual((await upgraded.query(seeds)).rows, (await initial.query(seeds)).rows);
    assert.deepEqual((await alreadyRemote.query(seeds)).rows, (await initial.query(seeds)).rows);
    const foreignKeys = await initial.query("SELECT * FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace");
    assert.equal(foreignKeys.rows.length, 0);
  } finally { await initial.close(); await upgraded.close(); await alreadyRemote.close(); }
});

test('M2 migration preserves old IDs, notes, balances and already committed request results', async () => {
  const db = new PGlite();
  try {
    await db.exec(oldSchema);
    await db.query("INSERT INTO money_accounts(name,category,balance) VALUES('旧账户',2,97500)");
    await db.query(`INSERT INTO money_transactions(type,time,category_id,source_account_id,source_amount,comment)
      VALUES(3,1793232000,3,1,2500,'旧备注不猜商户')`);
    const sessionId = randomUUID();
    const payload = { type: 3, categoryId: '3', sourceAccountId: '1', sourceAmount: 2500,
      time: 1793232000, destinationAccountId: null, destinationAmount: null, comment: '旧备注不猜商户' };
    const response = { id: '1', comment: payload.comment, existing: true };
    const hash = createHash('sha256').update(JSON.stringify(['v1/transactions/add', payload])).digest('hex');
    await db.query('INSERT INTO money_requests(key,payload_hash,response) VALUES($1,$2,$3::jsonb)', [sessionId, hash, JSON.stringify(response)]);
    await db.exec(upgrade);
    const query = (sql: string, params?: unknown[]) => db.query(sql, params);
    const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
    assert.deepEqual(await ledger(pool, 'v1/transactions/add', { ...payload, clientSessionId: sessionId }, new URLSearchParams()), response);
    const snapshot = await bookkeeping(pool, 'v2/snapshot', undefined, new URLSearchParams()) as { bills: Bill[]; accounts: { balance: string }[] };
    assert.equal(snapshot.bills.length, 1);
    assert.equal(snapshot.bills[0].legacyId, '1');
    assert.equal(snapshot.bills[0].content.note, payload.comment);
    assert.equal(snapshot.bills[0].content.merchant, '');
    assert.equal(snapshot.bills[0].content.occurredAt, payload.time * 1000);
    assert.equal(snapshot.accounts[0].balance, '97500');
    assert.equal(snapshot.bills[0].balanceMode, 'preserve');
    await bookkeeping(pool, 'v2/bills/submit', {
      operationId: randomUUID(), billId: snapshot.bills[0].billId, expectedVersion: 1, action: 'delete',
    }, new URLSearchParams());
    assert.equal((await db.query<{ balance: string }>('SELECT balance::text FROM money_accounts')).rows[0].balance, '97500');
    const oldList = await ledger(pool, 'v1/transactions/list', undefined, new URLSearchParams()) as { items: unknown[] };
    assert.equal(oldList.items.length, 0);
    assert.equal((await db.query('SELECT * FROM money_transactions WHERE id=1')).rows.length, 1);
  } finally { await db.close(); }
});

test('known v1 manual transactions retain balance corrections and all previously valid key prefixes', async () => {
  const db = new PGlite();
  try {
    await db.exec(oldSchema);
    await db.query("INSERT INTO money_accounts(name,category,balance) VALUES('旧现金',1,97500)");
    await db.query(`INSERT INTO money_transactions(type,time,category_id,source_account_id,source_amount,comment)
      VALUES(3,1793232000,3,1,2500,'有成功响应')`);
    const payload = { type: 3, categoryId: '3', sourceAccountId: '1', sourceAmount: 2500,
      time: 1793232000, destinationAccountId: null, destinationAmount: null, comment: '有成功响应' };
    const response = { id: '1', timeSequenceId: '1', ...payload };
    const key = 'bookkeeping:existing-manual-request';
    const hash = createHash('sha256').update(JSON.stringify(['v1/transactions/add', payload])).digest('hex');
    await db.query('INSERT INTO money_requests(key,payload_hash,response) VALUES($1,$2,$3::jsonb)', [key, hash, JSON.stringify(response)]);
    await db.exec(upgrade);
    const query = (sql: string, params?: unknown[]) => db.query(sql, params);
    const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
    assert.deepEqual(await ledger(pool, 'v1/transactions/add', { ...payload, clientSessionId: key }, new URLSearchParams()), response);
    const snapshot = await bookkeeping(pool, 'v2/snapshot', undefined, new URLSearchParams()) as { bills: Bill[] };
    const old = snapshot.bills[0];
    assert.equal(old.balanceMode, 'apply');
    const edited = await bookkeeping(pool, 'v2/bills/submit', {
      operationId: randomUUID(), billId: old.billId, expectedVersion: old.version, action: 'save', status: 'posted',
      content: { ...old.content, amountCents: 3000 },
    }, new URLSearchParams()) as Bill;
    assert.equal((await db.query<{ balance: string }>('SELECT balance::text FROM money_accounts')).rows[0].balance, '97000');
    await bookkeeping(pool, 'v2/bills/submit', { operationId: randomUUID(), billId: edited.billId, expectedVersion: edited.version, action: 'delete' }, new URLSearchParams());
    assert.equal((await db.query<{ balance: string }>('SELECT balance::text FROM money_accounts')).rows[0].balance, '100000');
  } finally { await db.close(); }
});
