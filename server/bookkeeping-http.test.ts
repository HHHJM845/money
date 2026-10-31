import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { handle } from './http.js';
import { hashPassword, issueSession } from './auth.js';
import { ledger } from './ledger.js';

test('v2 HTTP preserves auth/source boundaries and exposes snapshot, source detail and version conflicts', async () => {
  const db = new PGlite();
  try {
    await db.exec(await readFile(new URL('../doc/sql/init.sql', import.meta.url), 'utf8'));
    const query = (sql: string, params?: unknown[]) => db.query(sql, params);
    const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
    const auth = { username: 'owner', passwordHash: hashPassword('test-only-passphrase'), secret: 's'.repeat(40) };
    const cookie = `money_session=${issueSession(auth)}`;
    const call = (route: string, body?: unknown, session = cookie, origin = 'https://money.example') => handle(new Request(
      `https://money.example/api/${route.replace('?', '.json?')}${route.includes('?') ? '' : '.json'}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', cookie: session, origin },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    ), { pool, auth });
    const initial = await (await call('v2/snapshot')).json();
    assert.equal(initial.result.sequence, '0');
    assert.deepEqual(initial.result.accounts, []);
    assert.deepEqual(initial.result.bills, []);
    assert.equal((await call('v2/snapshot', undefined, '')).status, 401);
    assert.equal((await call('v2/bills/submit')).status, 405);
    assert.equal((await call('v2/bills/submit', {}, cookie, 'https://evil.example')).status, 403);
    const account = await ledger(pool, 'v1/accounts/add', { name: '无余额钱包', category: 4, currency: 'CNY',
      balance: null, clientSessionId: randomUUID() }, new URLSearchParams()) as { id: string };
    const billId = randomUUID();
    const payload = { operationId: randomUUID(), billId, expectedVersion: 0, action: 'save', status: 'posted',
      content: { kind: 'expense', amountCents: 1234, accountId: account.id, categoryId: '3',
        occurredAt: Date.parse('2026-10-29T04:00:00Z'), merchant: '测试商户', note: '独立备注',
        tagIds: [], excludeFromStatistics: false, excludeFromBudget: false },
      sources: [{ app: 'test', key: 'synthetic-1', capturedAt: Date.now(), ruleVersion: '1' }] };
    const saved = await call('v2/bills/submit', payload);
    assert.equal(saved.status, 200);
    const first = await saved.json();
    assert.equal(first.result.changeSequence, '2');
    assert.deepEqual(await (await call('v2/bills/submit', payload)).json(), first);
    const snapshot = (await (await call('v2/snapshot')).json()).result;
    assert.equal(snapshot.bills[0].content.merchant, '测试商户');
    assert.equal(snapshot.accounts[0].balance, null);
    assert.equal(snapshot.bills[0].createdAt, first.result.createdAt);
    const detail = (await (await call(`v2/bills/detail?billId=${billId}`)).json()).result;
    assert.equal(detail.sources[0].key, 'synthetic-1');
    assert.equal(detail.changeSequence, first.result.changeSequence);
    const conflict = await call('v2/bills/submit', { ...payload, operationId: randomUUID() });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).errorCode, 'VERSION_CONFLICT');
    assert.equal((await call(`v2/bills/detail?billId=${randomUUID()}`)).status, 404);
    assert.equal((await call('v2/bills/list?status=bad')).status, 400);
    assert.equal((await call('v2/bills/list?count=0')).status, 400);
    assert.equal((await call('v2/sync/changes?after=0', undefined, '')).status, 401);
    assert.equal((await call('v2/sync/changes?after=0', {})).status, 405);
    assert.equal((await call('v2/master/submit')).status, 405);
    assert.equal((await call('v2/master/submit', {}, cookie, 'https://evil.example')).status, 403);
    assert.equal((await call('v2/master/submit', {}, '')).status, 401);
    const tagPayload = { operationId: randomUUID(), entityType: 'tag', entityId: null,
      expectedVersion: 0, action: 'save', content: { name: '合成标签', active: true, sortOrder: 0 } };
    const tagResponse = await call('v2/master/submit', tagPayload);
    assert.equal(tagResponse.status, 200);
    const tag = (await tagResponse.json()).result;
    assert.equal(tag.snapshot.version, 1);
    assert.equal(tag.snapshot.name, '合成标签');
    const changes = (await (await call(`v2/sync/changes?after=${first.result.changeSequence}`)).json()).result;
    assert.equal(changes.changes[0].entityType, 'tag');
    assert.equal(changes.changes[0].sequence, tag.changeSequence);
    assert.equal(changes.tags[0].id, tag.entityId);
    const json = JSON.stringify(snapshot);
    assert.equal(json.includes('applied_effect'), false);
    assert.equal(json.includes('payload_hash'), false);
  } finally { await db.close(); }
});
