import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { handle } from './http';
import { hashPassword, issueSession } from './auth';

test('HTTP auth boundary, CSRF, cookie session and durable login limit', async () => {
  const db = new PGlite();
  try {
    await db.exec(await readFile(new URL('../doc/sql/init.sql', import.meta.url), 'utf8'));
    const pool = { query: (sql: string, params?: unknown[]) => db.query(sql, params) } as unknown as Pool;
    const auth = { username: 'owner', passwordHash: hashPassword('test-only-passphrase'), secret: 'z'.repeat(40) };
    const call = (route: string, method = 'GET', body?: unknown, cookie = '', origin = 'https://money.example') => handle(new Request(`https://money.example/api/${route}.json`, {
      method, headers: { origin, 'content-type': 'application/json', cookie }, ...(body ? { body: JSON.stringify(body) } : {}),
    }), { pool, auth });
    assert.equal((await call('v1/accounts/list')).status, 401);
    assert.equal((await call('v1/accounts/add', 'POST', {})).status, 401);
    assert.equal((await call('authorize', 'POST', {}, '', 'https://evil.example')).status, 403);
    assert.equal((await call('authorize', 'POST', {}, '', '')).status, 403);
    const response = await call('authorize', 'POST', { loginName: 'owner', password: 'test-only-passphrase' });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.equal((await call('session', 'GET', undefined, cookie)).status, 200);
    assert.equal((await call('v1/accounts/list', 'GET', undefined, cookie)).status, 200);
    assert.equal((await call('v1/accounts/add', 'GET', undefined, cookie)).status, 405);
    assert.equal((await call('register', 'POST', {}, cookie)).status, 404);
    assert.match((await call('logout', 'POST', {}, cookie)).headers.get('set-cookie')!, /Max-Age=0/);
    const forged = `money_session=${issueSession({ ...auth, username: 'someone' })}`;
    assert.equal((await call('session', 'GET', undefined, forged)).status, 401);
    for (let i = 0; i < 9; i++) assert.equal((await call('authorize', 'POST', { loginName: 'owner', password: 'bad' })).status, 401);
    assert.equal((await call('authorize', 'POST', { loginName: 'owner', password: 'test-only-passphrase' })).status, 429);
    const independent = await handle(new Request('https://money.example/api/authorize.json', {
      method: 'POST', headers: { origin: 'https://money.example', 'content-type': 'application/json' },
      body: JSON.stringify({ loginName: 'owner', password: 'test-only-passphrase' }),
    }), { pool, auth, sourceIp: 'another-client' });
    assert.equal(independent.status, 200);
    await db.query("UPDATE money_login_limits SET window_start = now() - interval '16 minutes'");
    assert.equal((await call('authorize', 'POST', { loginName: 'owner', password: 'test-only-passphrase' })).status, 200);
  } finally { await db.close(); }
});
