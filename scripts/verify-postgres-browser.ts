import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { handle } from '../server/http';
import { hashPassword } from '../server/auth';

const { chromium } = createRequire(import.meta.url)('playwright');
const db = new PGlite();
await db.exec(await readFile('doc/sql/init.sql', 'utf8'));
const query = (sql: string, params?: unknown[]) => db.query(sql, params);
const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
const password = randomBytes(24).toString('base64url');
const auth = { username: 'browser-test', passwordHash: hashPassword(password), secret: randomBytes(32).toString('hex') };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
      const response = await handle(new Request(url, { method: req.method, headers,
        ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }), { pool, auth });
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.end(await response.text());
    } else {
      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      if (!/^\/(index\.html|assets\/[\w.-]+)$/.test(path)) { res.statusCode = 404; res.end(); return; }
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(await readFile(`dist${path}`));
    }
  } catch { res.statusCode = 500; res.end('Test server failure'); }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.goto(origin);
  await page.getByLabel('账号', { exact: true }).fill(auth.username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录账本', exact: true }).click();
  await page.getByRole('button', { name: '查看净资产构成' }).waitFor();
  await page.getByRole('button', { name: '导入账单', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '创建账户', exact: true }).click();
  await page.getByLabel('账户名称', { exact: true }).fill('验证储蓄卡');
  await page.getByLabel('当前余额（人民币元）', { exact: true }).fill('1000');
  await page.getByRole('dialog').getByRole('button', { name: '创建账户', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.wealth-value')?.textContent?.includes('1,000.00'));
  await page.getByRole('button', { name: '记一笔', exact: true }).click();
  await page.locator('input[name=amount]').fill('0.29');
  await page.locator('input[name=comment]').fill('真实接口验证');
  await page.getByRole('button', { name: '保存到账本', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.wealth-value')?.textContent?.includes('999.71'));
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.wealth-value')?.textContent?.includes('999.71'));
  assert.equal(await page.evaluate(() => document.cookie.includes('money_session')), false);
  await mkdir('.local', { recursive: true });
  await page.screenshot({ path: '.local/postgres-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 360, height: 800 });
  for (const name of ['总览', '收支', '资产', '投资']) {
    await page.getByRole('navigation', { name: '手机导航' }).getByRole('button', { name, exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  await page.getByRole('navigation', { name: '手机导航' }).getByRole('button', { name: '总览', exact: true }).click();
  await page.screenshot({ path: '.local/postgres-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('button', { name: '登录账本', exact: true }).waitFor();
  assert.equal((await page.request.get(`${origin}/api/v1/accounts/list.json`)).status(), 401);
  assert.deepEqual(errors, []);
  process.stdout.write('PASS browser: login, create account, exact-cent expense, refresh, HttpOnly cookie, 360px views, logout and unauthorized API\n');
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await db.close();
}
