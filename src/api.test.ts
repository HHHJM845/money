import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, loadSnapshot, login, request } from './api.ts';

test('cookie requests preserve routes and never send a bearer token', async () => {
  const original = globalThis.fetch;
  const calls: { path: string; options?: RequestInit }[] = [];
  globalThis.fetch = async (input, options) => {
    calls.push({ path: String(input), options });
    return Response.json({ success: true, result: { username: 'owner' } });
  };
  try {
    assert.deepEqual(await login('owner', 'password'), { username: 'owner' });
    await request('session', 'ignored-legacy-token');
    await request('logout', '', {});
    assert.deepEqual(calls.map(c => c.path), ['/api/authorize.json', '/api/session.json', '/api/logout.json']);
    assert.deepEqual(calls.map(c => c.options?.method), ['POST', 'GET', 'POST']);
    assert.deepEqual(JSON.parse(String(calls[0].options?.body)), { loginName: 'owner', password: 'password' });
    for (const call of calls) {
      assert.equal(call.options?.credentials, 'same-origin');
      assert.equal(new Headers(call.options?.headers).has('Authorization'), false);
    }
  } finally { globalThis.fetch = original; }
});

test('session expiration is distinct from service failure', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ success: false }, { status: 401 });
    await assert.rejects(request('session'), e => e instanceof ApiError && e.unauthorized);
    globalThis.fetch = async () => Response.json({ success: false }, { status: 503 });
    await assert.rejects(request('session'), e => e instanceof ApiError && !e.unauthorized);
    globalThis.fetch = async () => new Response('unavailable', { status: 502 });
    await assert.rejects(request('session'), /账本服务返回异常/);
  } finally { globalThis.fetch = original; }
});

test('snapshot follows transaction cursor and deduplicates repeated boundary records', async () => {
  const original = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async input => {
    const path = String(input);
    paths.push(path);
    let result: unknown = [];
    if (path.includes('categories')) result = {};
    if (path.includes('transactions/list')) {
      result = path.includes('max_time=1000')
        ? { items: [{ id: '2', time: 200 }, { id: '1', time: 100 }], nextTimeSequenceId: null }
        : { items: [{ id: '2', time: 200 }], nextTimeSequenceId: '1000' };
    }
    return Response.json({ success: true, result });
  };
  try {
    const snapshot = await loadSnapshot('test');
    assert.equal(snapshot.transactions.length, 2);
    assert(paths.includes('/api/v1/transactions/list.json?count=50&page=1&max_time=1000'));
  } finally { globalThis.fetch = original; }
});

test('a failed later page never returns an incomplete snapshot', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async input => {
    const path = String(input);
    if (path.includes('max_time=')) return Response.json({ success: false, error: { message: '读取失败' } }, { status: 500 });
    const result = path.includes('categories') ? {} : path.includes('transactions/list')
      ? { items: [{ id: 'first' }], nextTimeSequenceId: '1000' } : [];
    return Response.json({ success: true, result });
  };
  try { await assert.rejects(loadSnapshot('test'), /读取失败/); }
  finally { globalThis.fetch = original; }
});

test('merged pages sort by transaction time then exact bigint ID descending', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async input => {
    const path = String(input);
    let result: unknown = [];
    if (path.includes('categories')) result = {};
    if (path.includes('transactions/list')) result = path.includes('max_time=1000')
      ? { items: [{ id: '9007199254740992', time: 200 }, { id: '10', time: 300 }, { id: '9', time: 300 }], nextTimeSequenceId: null }
      : { items: [{ id: '9007199254740994', time: 100 }, { id: '9007199254740993', time: 200 }, { id: '9007199254740992', time: 200 }], nextTimeSequenceId: '1000' };
    return Response.json({ success: true, result });
  };
  try {
    const snapshot = await loadSnapshot();
    assert.deepEqual(snapshot.transactions.map(t => t.id), [
      '10', '9', '9007199254740993', '9007199254740992', '9007199254740994',
    ]);
  } finally { globalThis.fetch = original; }
});
