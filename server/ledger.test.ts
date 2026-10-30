import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { ledger, LedgerError } from './ledger';

test('real PostgreSQL schema: atomic balances, durable retries, validation and pagination', async () => {
  const db = new PGlite();
  await db.exec(await readFile(new URL('../doc/sql/init.sql', import.meta.url), 'utf8'));
  // PGlite has one connection; serialize entire transactions, not individual queries.
  let tail = Promise.resolve();
  const query = (sql: string, params?: unknown[]) => db.query(sql, params);
  const pool = {
    query,
    async connect() {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      return { query, release };
    },
  } as unknown as Pool;
  const call = (route: string, body?: unknown, q = '') => ledger(pool, `v1/${route}`, body, new URLSearchParams(q));
  const account = async (name: string, balance: string) => await call('accounts/add', {
    name, balance, category: 2, type: 1, currency: 'CNY', clientSessionId: randomUUID(),
  }) as { id: string };
  const a = await account('银行', '10000');
  const b = await account('信用卡', '0');
  const categories = await call('transaction/categories/list') as Record<string, {id: string}[]>;
  const transfer = { type: 4, categoryId: categories['3'][0].id, sourceAccountId: a.id,
    destinationAccountId: b.id, sourceAmount: 2000, destinationAmount: 2000,
    time: 1793232000, comment: '还款', clientSessionId: randomUUID() };
  const first = await call('transactions/add', transfer);
  const retries = await Promise.all(Array.from({length: 5}, () => call('transactions/add', transfer)));
  retries.forEach(value => assert.deepEqual(value, first));
  const balances = async () => (await call('accounts/list') as {balance: string}[]).map(a => a.balance);
  assert.deepEqual(await balances(), ['8000', '2000']);
  await assert.rejects(call('transactions/add', {...transfer, sourceAmount: 3000, destinationAmount: 3000}), (e: unknown) => e instanceof LedgerError && e.status === 409);
  for (const patch of [
    {sourceAmount: 0}, {sourceAmount: 1.5}, {sourceAmount: Number.MAX_SAFE_INTEGER + 1},
    {categoryId: categories['1'][0].id}, {sourceAccountId: '9999'},
    {destinationAccountId: a.id}, {destinationAmount: 3},
  ]) {
    await assert.rejects(call('transactions/add', {...transfer, ...patch, clientSessionId: randomUUID()}), LedgerError);
  }
  assert.deepEqual(await balances(), ['8000', '2000']);
  const max = await account('上限', String(Number.MAX_SAFE_INTEGER));
  await assert.rejects(call('transactions/add', {...transfer, destinationAccountId: max.id, clientSessionId: randomUUID()}), LedgerError);
  assert.deepEqual((await balances()).slice(0, 2), ['8000', '2000']);
  await assert.rejects(call('accounts/add', {name: '美元', category: 2, currency: 'USD', balance: '0', clientSessionId: randomUUID()}), LedgerError);
  await call('transactions/add', {type: 3, categoryId: categories['2'][0].id, sourceAccountId: a.id, sourceAmount: 50, time: transfer.time, clientSessionId: randomUUID()});
  const page = await call('transactions/list', undefined, 'count=1') as {items: {id:string}[]; nextTimeSequenceId:string};
  const next = await call('transactions/list', undefined, `count=1&max_time=${page.nextTimeSequenceId}`) as typeof page;
  assert.equal(next.items.length, 1);
  assert.notEqual(next.items[0].id, page.items[0].id);
  assert.equal(next.nextTimeSequenceId, null);
  const income = {type: 2, categoryId: categories['1'][0].id, sourceAccountId: a.id, sourceAmount: 100, time: transfer.time, clientSessionId: randomUUID()};
  await call('transactions/add', income);
  assert.deepEqual((await balances()).slice(0, 2), ['8050', '2000']);
  const snapshot = await db.dumpDataDir();
  await db.close();
  const reopened = new PGlite({loadDataDir: snapshot});
  const reopenedQuery = (sql: string, params?: unknown[]) => reopened.query(sql, params);
  const reopenedPool = {query: reopenedQuery, connect: async () => ({query: reopenedQuery, release() {}})} as unknown as Pool;
  assert.deepEqual(await ledger(reopenedPool, 'v1/transactions/add', transfer, new URLSearchParams()), first);
  const stored = await reopened.query<{balance: number}>('SELECT balance FROM money_accounts WHERE id=$1', [a.id]);
  assert.equal(String(stored.rows[0].balance), '8050');
  await reopened.close();
});

test('SQL constraints and login limit schema are present in both initialization paths', async () => {
  const initial = await readFile(new URL('../doc/sql/init.sql', import.meta.url), 'utf8');
  const incremental = await readFile(new URL('../doc/sql/increment.sql', import.meta.url), 'utf8');
  assert.ok(initial.includes('CREATE TABLE money_login_limits'));
  const db = new PGlite();
  await db.exec(incremental);
  await assert.rejects(db.query("INSERT INTO money_accounts(name,category,currency,balance) VALUES('x',2,'USD',0)"));
  await assert.rejects(db.query("INSERT INTO money_accounts(name,category,currency,balance) VALUES('x',2,'CNY',9007199254740992)"));
  await assert.rejects(db.query("INSERT INTO money_login_limits(key,window_start,attempts) VALUES('owner',now(),-1)"));
  await db.query("INSERT INTO money_login_limits(key,window_start,attempts) VALUES('owner',now(),10)");
  await assert.rejects(db.query("INSERT INTO money_transactions(type,time,category_id,source_account_id,destination_account_id,source_amount,destination_amount) VALUES(4,1,1,1,1,10,10)"));
  await assert.rejects(db.query("INSERT INTO money_transactions(type,time,category_id,source_account_id,destination_account_id,source_amount,destination_amount) VALUES(4,1,1,1,2,10,NULL)"));
  await db.close();
});

for (const script of ['init.sql', 'increment.sql']) {
  test(`${script}: all ledger tables deny Data API roles through policy-free RLS`, async () => {
    const db = new PGlite();
    try {
      await db.exec(await readFile(new URL(`../doc/sql/${script}`, import.meta.url), 'utf8'));
      const metadata = await db.query<{relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean}>(`
        SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
        WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname LIKE 'money_%' ORDER BY relname`);
      assert.ok(metadata.rows.length >= 5, 'expected the ledger tables to exist');
      for (const row of metadata.rows) {
        assert.equal(row.relrowsecurity, true, `${row.relname} must enable RLS`);
        assert.equal(row.relforcerowsecurity, false, `${row.relname} must not force RLS`);
      }
      const policies = await db.query("SELECT * FROM pg_policies WHERE schemaname='public' AND tablename LIKE 'money_%'");
      assert.equal(policies.rows.length, 0);
      const inserts = [
        "INSERT INTO money_accounts(name,category,balance) VALUES('private',2,100)",
        "INSERT INTO money_categories(name,type) VALUES('private',1)",
        "INSERT INTO money_login_limits(key,window_start,attempts) VALUES('owner',now(),1)",
        "INSERT INTO money_requests(key,payload_hash,response) VALUES('private','hash','{\"secret\":true}')",
        "INSERT INTO money_transactions(type,time,category_id,source_account_id,source_amount) VALUES(2,1,1,1,100)",
      ];
      for (const sql of inserts) await db.query(sql);
      // Simulate Supabase's grants: RLS must still protect rows even with table privileges.
      await db.exec(`
        CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS;
        CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS;
        GRANT USAGE ON SCHEMA public TO anon, authenticated;
        GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated;
        GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
      `);
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`SET ROLE ${role}`);
        for (const table of metadata.rows.map(row => row.relname)) {
          assert.equal((await db.query(`SELECT * FROM ${table}`)).rows.length, 0);
          assert.equal((await db.query(`DELETE FROM ${table} RETURNING *`)).rows.length, 0);
        }
        assert.equal((await db.query("UPDATE money_requests SET response='{}' RETURNING *")).rows.length, 0);
        for (const sql of inserts) await assert.rejects(db.query(sql), /row-level security/i);
        await db.exec('RESET ROLE');
      }
      const populated = ['money_accounts', 'money_categories', 'money_login_limits', 'money_requests', 'money_transactions', 'money_change_log'];
      for (const table of populated) assert.ok((await db.query(`SELECT * FROM ${table}`)).rows.length > 0);
    } finally { await db.close(); }
  });
}
