import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { handle } from '../server/http.js';
import { hashPassword } from '../server/auth.js';
import { ledger } from '../server/ledger.js';

// Standalone JVM integration fixture. It never loads production configuration.
const db = new PGlite();
await db.exec(await readFile('doc/sql/init.sql', 'utf8'));
let tail = Promise.resolve();
async function acquire() {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>(done => { release = done; });
  await previous;
  return release;
}
const direct = (sql: string, params?: unknown[]) => db.query(sql, params);
const pool = {
  async query(sql: string, params?: unknown[]) {
    const release = await acquire();
    try { return await direct(sql, params); } finally { release(); }
  },
  async connect() {
    const release = await acquire();
    return { query: direct, release };
  },
} as unknown as Pool;
for (const [name, balance] of [['合成现金', '100000'], ['合成银行卡', '200000']]) {
  await ledger(pool, 'v1/accounts/add', {
    name, balance, category: 2, currency: 'CNY', clientSessionId: randomUUID(),
  }, new URLSearchParams());
}
const username = `wire-${randomUUID()}`;
const password = randomBytes(24).toString('base64url');
const auth = { username, passwordHash: hashPassword(password), secret: randomBytes(32).toString('hex') };
const server = createServer(async (request, response) => {
  try {
    const address = server.address();
    if (!address || typeof address === 'string' || request.headers.host !== `127.0.0.1:${address.port}`) {
      response.writeHead(403); response.end(); return;
    }
    const path = new URL(request.url ?? '/', `http://127.0.0.1:${address.port}`);
    if (path.pathname === '/health' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ready":true}'); return;
    }
    if (!path.pathname.startsWith('/api/')) { response.writeHead(404); response.end(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += Buffer.byteLength(chunk);
      if (size > 16384) { response.writeHead(413); response.end(); return; }
      chunks.push(Buffer.from(chunk));
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(key, value);
    // Only this fixture redirects the native transport to loopback. Its canonical
    // URL retains the app's Origin so the real API still checks its normal boundary.
    const canonical = new URL(headers.get('origin') ?? 'https://android-wire.test');
    if (canonical.protocol !== 'https:') { response.writeHead(403); response.end(); return; }
    const result = await handle(new Request(new URL(path.pathname + path.search, canonical), {
      method: request.method, headers,
      ...(request.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
    }), { pool, auth });
    if (['/api/v2/bills/submit.json', '/api/v2/master/submit.json'].includes(path.pathname)
      && request.headers['x-android-wire-drop'] === 'yes' && result.ok) {
      response.destroy();
      return;
    }
    response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
    response.end(await result.text());
  } catch {
    response.writeHead(500); response.end('Isolated Android wire fixture failed');
  }
});
await new Promise<void>((done, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); done(); });
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Fixture failed to listen');
await mkdir('.local', { recursive: true });
const fixturePath = resolve('.local', `android-wire-${randomUUID()}.json`);
await writeFile(fixturePath, JSON.stringify({
  origin: `http://127.0.0.1:${address.port}`, username, password,
}), { mode: 0o600, flag: 'wx' });
process.stdout.write(`BOOKKEEPING_ANDROID_WIRE_FIXTURE=${fixturePath}\n`);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await new Promise<void>(done => server.close(() => done()));
  await tail;
  await db.close();
  await unlink(fixturePath);
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
