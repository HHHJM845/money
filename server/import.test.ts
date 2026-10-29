import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { ledger, LedgerError } from './ledger.js';
import { handle } from './http.js';
import { hashPassword, issueSession } from './auth.js';

async function fixture() {
  const db = new PGlite();
  await db.exec(await readFile(new URL('../doc/sql/init.sql', import.meta.url), 'utf8'));
  let tail = Promise.resolve();
  const query = (sql: string, params?: unknown[]) => db.query(sql, params);
  const pool = {query, async connect() {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    return {query, release};
  }} as unknown as Pool;
  const call = (body: unknown) => ledger(pool, 'v1/transactions/import', body, new URLSearchParams());
  const account = await ledger(pool, 'v1/accounts/add', {clientSessionId: randomUUID(), name: '银行', currency: 'CNY', category: 2, balance: '10000'}, new URLSearchParams()) as {id: string};
  const categories = await ledger(pool, 'v1/transaction/categories/list', undefined, new URLSearchParams()) as Record<string, {id: string}[]>;
  const row = {rowNumber: 1, sourceId: 'order-1', time: 1793232000, type: 3, amount: 250, comment: '午餐'};
  const body = {clientSessionId: randomUUID(), provider: 'wechat', accountId: account.id,
    incomeCategoryId: categories['1'][0].id, expenseCategoryId: categories['2'][0].id,
    balanceMode: 'preserve', rows: [row]};
  const state = async () => ({
    balance: (await db.query<{balance: string}>('SELECT balance::text FROM money_accounts WHERE id=$1', [account.id])).rows[0].balance,
    count: (await db.query<{count: number}>('SELECT count(*)::int AS count FROM money_transactions')).rows[0].count,
    requests: (await db.query<{count: number}>('SELECT count(*)::int AS count FROM money_requests')).rows[0].count,
  });
  return {db, pool, call, row, body, state};
}

test('import: durable retries, overlap, distinct IDs, anonymous occurrences, apply/preserve', async () => {
  const {db, call, row, body, state} = await fixture();
  try {
    const first = {imported: 1, duplicates: 0, anonymousDuplicates: 0, latestTime: row.time};
    assert.deepEqual(await call(body), first);
    assert.deepEqual(await call(body), first);
    assert.equal((await state()).balance, '10000');
    const fresh = (rows: (Omit<typeof row, 'sourceId'> & {sourceId?: string})[] = body.rows, balanceMode = 'preserve') => ({...body, clientSessionId: randomUUID(), rows, balanceMode});
    assert.deepEqual(await call(fresh()), {...first, imported: 0, duplicates: 1});
    assert.deepEqual(await call(fresh([row, {...row, sourceId: 'order-2', rowNumber: 2}], 'apply')), {...first, duplicates: 1});
    assert.equal((await state()).balance, '9750');
    const anonymous = {...row, sourceId: undefined};
    assert.deepEqual(await call(fresh([anonymous, {...anonymous, rowNumber: 2}])), {...first, imported: 2});
    assert.deepEqual(await call(fresh([anonymous, {...anonymous, rowNumber: 2}])), {...first, imported: 0, duplicates: 2, anonymousDuplicates: 2});
    assert.equal((await state()).count, 4);
    const results = await Promise.all([call(fresh([{...row, sourceId: 'parallel'}], 'apply')), call(fresh([{...row, sourceId: 'parallel'}], 'apply'))]);
    assert.deepEqual(results, [first, {...first, imported: 0, duplicates: 1}]);
    assert.equal((await state()).balance, '9500');
    await call(fresh([{...row, sourceId: 'income', type: 2, amount: 100}], 'apply'));
    assert.equal((await state()).balance, '9600');
    const defaultMode = {...fresh([{...row, sourceId: 'default'}]), balanceMode: undefined};
    await call(defaultMode);
    assert.equal((await state()).balance, '9600');
    const snapshot = await db.dumpDataDir();
    const reopened = new PGlite({loadDataDir: snapshot});
    try {
      const query = (sql: string, params?: unknown[]) => reopened.query(sql, params);
      const pool = {query, connect: async () => ({query, release() {}})} as unknown as Pool;
      assert.deepEqual(await ledger(pool, 'v1/transactions/import', body, new URLSearchParams()), first);
    } finally { await reopened.close(); }
  } finally { await db.close(); }
});

test('import: conflicting IDs and invalid rows roll back whole batch and request keys', async () => {
  const {db, call, row, body, state} = await fixture();
  try {
    await call(body);
    const initial = await state();
    const conflict = (error: unknown) => error instanceof LedgerError && error.status === 409;
    await assert.rejects(call({...body, rows: [{...row, amount: 251}]}), conflict);
    await assert.rejects(call({...body, clientSessionId: randomUUID(), rows: [{...row, sourceId: 'new'}, {...row, amount: 251}]}), conflict);
    await assert.rejects(call({...body, clientSessionId: randomUUID(), rows: [{...row, sourceId: 'new'}, {...row, sourceId: 'new', amount: 251}]}), conflict);
    for (const patch of [
      {rows: [row, {...row, amount: -1}]}, {rows: []}, {rows: Array(1001).fill(row)},
      {rows: [{...row, amount: 1.5}]}, {rows: [{...row, type: 4}]}, {rows: [{...row, time: NaN}]},
      {rows: [{...row, comment: 'x'.repeat(2001)}]}, {rows: [{...row, rowNumber: 0}]},
      {provider: 'unknown'}, {balanceMode: 'bad'}, {anonymousMode: 'bad'}, {anonymousMode: null}, {accountId: '999999'},
      {incomeCategoryId: body.expenseCategoryId}, {expenseCategoryId: body.incomeCategoryId},
    ]) await assert.rejects(call({...body, ...patch, clientSessionId: randomUUID()}), LedgerError);
    assert.deepEqual(await state(), initial);
    await db.query('UPDATE money_accounts SET balance=$1', [String(Number.MAX_SAFE_INTEGER)]);
    const beforeOverflow = await state();
    await assert.rejects(call({...body, clientSessionId: randomUUID(), balanceMode: 'apply', rows: [{...row, sourceId: 'overflow', type: 2}]}), LedgerError);
    assert.deepEqual(await state(), beforeOverflow);
  } finally { await db.close(); }
});

test('import HTTP: auth, methods, scoped 1 MiB byte limit and normal 16 KiB limit', async () => {
  const {db, pool, body, row} = await fixture();
  try {
    const auth = {username: 'owner', passwordHash: hashPassword('test-only-passphrase'), secret: 'z'.repeat(40)};
    const cookie = `money_session=${issueSession(auth)}`;
    const call = (route: string, method: string, value: unknown, session = cookie, origin = 'https://money.example') => handle(new Request(`https://money.example/api/${route}.json`, {
      method, headers: {'content-type': 'application/json', origin, cookie: session},
      ...(method !== 'GET' ? {body: JSON.stringify(value)} : {}),
    }), {pool, auth});
    assert.equal((await call('v1/transactions/import', 'POST', body, '')).status, 401);
    assert.equal((await call('v1/transactions/import', 'GET', undefined)).status, 405);
    assert.equal((await call('v1/transactions/import', 'DELETE', body)).status, 405);
    assert.equal((await call('v1/transactions/import', 'POST', body, cookie, 'https://evil.example')).status, 403);
    const large = {...body, rows: Array.from({length: 20}, (_, index) => ({...row, rowNumber: index + 1, sourceId: String(index), comment: '支'.repeat(1000)}))};
    const response = await call('v1/transactions/import', 'POST', large);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.imported, 20);
    assert.equal((await call('v1/transactions/import', 'POST', {padding: '支'.repeat(350000)})).status, 413);
    assert.equal((await call('v1/transactions/add', 'POST', large)).status, 413);
  } finally { await db.close(); }
});

test('import namespaces isolate normal requests, providers and accounts; 1000 rows are supported', async () => {
  const {db, pool, call, body, row} = await fixture();
  try {
    // A normal transaction may reuse the public batch identifier without colliding internally.
    await ledger(pool, 'v1/transactions/add', {clientSessionId: body.clientSessionId, type: 3,
      categoryId: body.expenseCategoryId, sourceAccountId: body.accountId, sourceAmount: 10, time: row.time}, new URLSearchParams());
    assert.equal((await call(body) as {imported: number}).imported, 1);
    const rowKey = (await db.query<{key: string}>("SELECT key FROM money_requests WHERE key LIKE 'import:row:%'")).rows[0].key;
    await assert.rejects(ledger(pool, 'v1/accounts/add', {clientSessionId: rowKey, name: 'collision', category: 2, currency: 'CNY', balance: '0'}, new URLSearchParams()), LedgerError);
    assert.equal((await call({...body, clientSessionId: randomUUID(), provider: 'alipay'}) as {imported: number}).imported, 1);
    const another = await ledger(pool, 'v1/accounts/add', {clientSessionId: randomUUID(), name: '其他账户', category: 2, currency: 'CNY', balance: '0'}, new URLSearchParams()) as {id: string};
    assert.equal((await call({...body, clientSessionId: randomUUID(), accountId: another.id}) as {imported: number}).imported, 1);
    const rows = Array.from({length: 1000}, (_, index) => ({...row, rowNumber: index + 1, sourceId: `bulk-${index}`}));
    assert.deepEqual(await call({...body, clientSessionId: randomUUID(), rows}), {imported: 1000, duplicates: 0, anonymousDuplicates: 0, latestTime: row.time});
    assert.deepEqual(await call({...body, clientSessionId: randomUUID(), rows: [...rows].reverse()}), {imported: 0, duplicates: 1000, anonymousDuplicates: 0, latestTime: row.time});
  } finally { await db.close(); }
});

test('anonymous keep mode retains intentional new rows once per batch while source IDs remain deduplicated', async () => {
  const {db, call, body, row, state} = await fixture();
  try {
    const anonymous = {...row, sourceId: undefined};
    const result = {imported: 2, duplicates: 0, anonymousDuplicates: 0, latestTime: row.time};
    await call({...body, rows: [row, anonymous]});
    const partial = {...body, clientSessionId: randomUUID(), balanceMode: 'apply',
      rows: [row, anonymous, {...anonymous, rowNumber: 3, amount: 100}]};
    assert.deepEqual(await call(partial), {...result, imported: 1, duplicates: 2, anonymousDuplicates: 1});
    assert.equal((await state()).balance, '9900');
    // Explicit default and omitted default represent the same retry.
    assert.deepEqual(await call({...partial, anonymousMode: 'deduplicate'}), {...result, imported: 1, duplicates: 2, anonymousDuplicates: 1});
    const keep = {...body, clientSessionId: randomUUID(), balanceMode: 'apply', anonymousMode: 'keep',
      rows: [row, anonymous, {...anonymous, rowNumber: 3}]};
    assert.deepEqual(await call(keep), {...result, duplicates: 1});
    const afterKeep = await state();
    assert.equal(afterKeep.balance, '9400');
    assert.equal(afterKeep.count, 5);
    assert.deepEqual(await call(keep), {...result, duplicates: 1});
    assert.deepEqual(await state(), afterKeep);
    // A fresh explicit keep batch represents additional real transactions.
    assert.deepEqual(await call({...keep, clientSessionId: randomUUID()}), {...result, duplicates: 1});
    assert.equal((await state()).balance, '8900');
    // Keep cannot override official source-ID conflict checks or change a settled batch's mode.
    const beforeConflict = await state();
    const conflict = (error: unknown) => error instanceof LedgerError && error.status === 409;
    await assert.rejects(call({...keep, anonymousMode: 'deduplicate'}), conflict);
    await assert.rejects(call({...keep, clientSessionId: randomUUID(), rows: [{...row, amount: 251}]}), conflict);
    assert.deepEqual(await state(), beforeConflict);
  } finally { await db.close(); }
});

test('keep-first import registers default fingerprints atomically without counting aliases as transactions', async () => {
  const {db, call, body, row, state} = await fixture();
  try {
    const anonymous = {...row, sourceId: undefined};
    const keep = {...body, anonymousMode: 'keep', balanceMode: 'apply', rows: [row, anonymous, {...anonymous, rowNumber: 3}]};
    const first = {imported: 3, duplicates: 0, anonymousDuplicates: 0, latestTime: row.time};
    assert.deepEqual(await call(keep), first);
    const afterKeep = await state();
    assert.equal(afterKeep.count, 3);
    assert.equal(afterKeep.balance, '9250');
    assert.deepEqual(await call(keep), first);
    assert.deepEqual(await state(), afterKeep);
    assert.deepEqual(await call({...keep, clientSessionId: randomUUID(), anonymousMode: 'deduplicate'}),
      {imported: 0, duplicates: 3, anonymousDuplicates: 2, latestTime: row.time});
    assert.equal((await state()).balance, '9250');
    // New official IDs with the same content are independent of anonymous fingerprint aliases.
    assert.deepEqual(await call({...body, clientSessionId: randomUUID(), rows: [{...row, sourceId: 'new-official'}]}), {...first, imported: 1});
    const beforeFailure = await state();
    await assert.rejects(call({...keep, clientSessionId: randomUUID(), rows: [{...anonymous, amount: Number.MAX_SAFE_INTEGER, type: 2}]}), LedgerError);
    assert.deepEqual(await state(), beforeFailure);
  } finally { await db.close(); }
});
