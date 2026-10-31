import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { handle } from '../server/http.js';
import { hashPassword, issueSession, sessionCookie } from '../server/auth.js';
import { ledger } from '../server/ledger.js';
import { bookkeeping, type BillContent } from '../server/bookkeeping.js';

// This loopback-only preview uses its own synthetic database and ephemeral auth.
await mkdir('.local', { recursive: true });
const db = new PGlite('.local/bookkeeping-preview');
let tail = Promise.resolve();
async function acquire() {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  return release;
}
const directQuery = (sql: string, params?: unknown[]) => db.query(sql, params);
const pool = {
  async query(sql: string, params?: unknown[]) {
    const release = await acquire();
    try { return await directQuery(sql, params); } finally { release(); }
  },
  async connect() {
    const release = await acquire();
    return { query: directQuery, release };
  },
} as unknown as Pool;
const tables = await db.query<{ ready: string | null }>("SELECT to_regclass('public.money_ledger_state')::text AS ready");
if (!tables.rows[0].ready) {
  await db.exec(await readFile('doc/sql/init.sql', 'utf8'));
  const account = async (name: string, balance: string | null) => await ledger(pool, 'v1/accounts/add', {
    clientSessionId: randomUUID(), name, balance, category: 2, currency: 'CNY',
  }, new URLSearchParams()) as { id: string };
  const cash = await account('示例 · 招商储蓄卡', '832068');
  const wallet = await account('示例 · 现金', null);
  const now = Date.now();
  const base: BillContent = {
    kind: 'expense', amountCents: 3200, accountId: cash.id, categoryId: '3', occurredAt: now,
    merchant: '街角面馆', note: '午餐', tagIds: [], excludeFromStatistics: false, excludeFromBudget: false,
  };
  async function bill(content: BillContent, status = 'posted') {
    const billId = randomUUID();
    await bookkeeping(pool, 'v2/bills/submit', {
      operationId: randomUUID(), billId, expectedVersion: 0, action: 'save', status, content,
    }, new URLSearchParams());
    return billId;
  }
  await bill(base);
  await bill({ ...base, amountCents: 650, categoryId: '5', merchant: '地铁出行', note: '', occurredAt: now - 3600000 });
  const purchase = await bill({ ...base, amountCents: 19900, categoryId: '4', merchant: '日用商店', note: '生活用品', occurredAt: now - 86400000 });
  await bill({ ...base, kind: 'refund', amountCents: 2900, categoryId: '4', merchant: '日用商店', note: '部分退货', refundOfBillId: purchase });
  await bill({ ...base, kind: 'income', amountCents: 1200000, categoryId: '1', merchant: '', note: '本月工资', occurredAt: now - 2 * 86400000 });
  await bill({ ...base, kind: 'transfer', amountCents: 50000, categoryId: '7', destinationAccountId: wallet.id, merchant: '', note: '取现' });
  await bill({ ...base, amountCents: 1850, accountId: null, merchant: '待核对的付款', note: '资金账户待确认' }, 'pending');
} else {
  const ready = await db.query<{ ready: boolean }>(`SELECT EXISTS(
    SELECT 1 FROM information_schema.columns WHERE table_schema='public'
    AND table_name='money_accounts' AND column_name='version') AS ready`);
  if (!ready.rows[0].ready) {
    // Upgrade only this script's isolated synthetic preview, never the production database.
    const increment = await readFile('doc/sql/increment.sql', 'utf8');
    const offset = increment.indexOf('-- 2026-10-30 P1 ');
    if (offset < 0) throw new Error('Preview upgrade SQL missing');
    await db.exec(increment.slice(offset));
  }
}
const auth = {
  username: '本地示例',
  passwordHash: hashPassword(randomBytes(24).toString('base64url')),
  secret: randomBytes(32).toString('hex'),
};
const server = createServer(async (req, res) => {
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Preview not listening');
    const expectedHost = `127.0.0.1:${address.port}`;
    if (req.headers.host !== expectedHost) { res.writeHead(403); res.end(); return; }
    const url = new URL(req.url ?? '/', `http://${expectedHost}`);
    if (url.pathname.startsWith('/api/')) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > 1024 * 1024) { res.writeHead(413); res.end(); return; }
        chunks.push(Buffer.from(chunk));
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
      const response = await handle(new Request(url, {
        method: req.method, headers,
        ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
      }), { pool, auth });
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(await response.text());
      return;
    }
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!/^\/(index\.html|assets\/[\w.-]+)$/.test(path)) { res.writeHead(404); res.end(); return; }
    if (path === '/index.html') res.setHeader('Set-Cookie', sessionCookie(issueSession(auth), false));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(await readFile(`dist${path}`));
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('本地示例载入失败，请查看测试结果并重新构建。');
  }
});
let previewPort = 4173;
while (true) {
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(previewPort, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    break;
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE')) throw error;
    previewPort++;
  }
}
process.stdout.write(`Local synthetic ledger preview: http://127.0.0.1:${previewPort}\n`);
async function shutdown() {
  server.close();
  await tail;
  await db.close();
  process.exit(0);
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
