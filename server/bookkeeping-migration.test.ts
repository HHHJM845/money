import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { ledger } from './ledger.js';
import { bookkeeping, type Bill } from './bookkeeping.js';

const increment = await readFile(new URL('../doc/sql/increment.sql', import.meta.url), 'utf8');
const marker = '-- 2026-10-30 M2';
const offset = increment.indexOf(marker);
assert.ok(offset > 0);
const oldSchema = increment.slice(0, offset);
const upgrade = increment.slice(offset);

test('M2 empty initialization and historical upgrade produce equivalent structure', async () => {
  const initial = new PGlite();
  const upgraded = new PGlite();
  try {
    await initial.exec(await readFile(new URL('../doc/sql/init.sql', import.meta.url), 'utf8'));
    await upgraded.exec(increment);
    const metadata = `SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,
      pg_get_expr(d.adbin,d.adrelid) AS default_value,col_description(c.oid,a.attnum) AS comment
      FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relname LIKE 'money_%'
      AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`;
    assert.deepEqual((await upgraded.query(metadata)).rows, (await initial.query(metadata)).rows);
    const constraints = `SELECT c.relname,con.conname,pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
      WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'money_%' ORDER BY c.relname,con.conname`;
    assert.deepEqual((await upgraded.query(constraints)).rows, (await initial.query(constraints)).rows);
    const indexes = "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename LIKE 'money_%' ORDER BY indexname";
    assert.deepEqual((await upgraded.query(indexes)).rows, (await initial.query(indexes)).rows);
    const foreignKeys = await initial.query("SELECT * FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace");
    assert.equal(foreignKeys.rows.length, 0);
  } finally { await initial.close(); await upgraded.close(); }
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
