import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { handle } from '../server/http';
import { hashPassword } from '../server/auth';
import { statementWorkbook } from './statement-fixtures';

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
  await page.getByRole('heading', { name: '收支明细', exact: true }).waitFor();
  await page.getByRole('button', { name: '导入账单', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '创建账户', exact: true }).click();
  await page.getByLabel('账户名称', { exact: true }).fill('验证储蓄卡');
  await page.getByLabel('当前余额（人民币元）', { exact: true }).fill('1000');
  await page.getByRole('dialog').getByRole('button', { name: '创建账户', exact: true }).click();
  await page.getByRole('button', { name: '记一笔', exact: true }).waitFor();
  await page.getByRole('button', { name: '记一笔', exact: true }).click();
  await page.locator('input[name=amount]').fill('0.29');
  await page.locator('input[name=comment]').fill('真实接口验证');
  await page.getByRole('button', { name: '保存到账本', exact: true }).click();
  await page.getByRole('button').filter({ hasText: '真实接口验证' }).waitFor();
  await page.reload();
  await page.getByRole('button').filter({ hasText: '真实接口验证' }).waitFor();
  assert.equal((await (await page.request.get(`${origin}/api/v1/accounts/list.json`)).json()).result[0].balance, '99971');
  assert.equal(await page.evaluate(() => document.cookie.includes('money_session')), false);
  await mkdir('.local', { recursive: true });
  const csv = '日期,类型,金额,备注,交易单号,币种\n2025-03-12 12:00:00,支出,20.50,历史午餐,test-001,CNY\n2025-03-13 09:00:00,收入,100.00,历史收入,test-002,CNY\n2025-03-14,支出,错误金额,应排除,test-003,CNY';
  for (const pass of [1, 2]) {
    await page.getByRole('button', { name: '导入账单', exact: true }).click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('选择账单文件').setInputFiles({ name: '通用账单.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await modal.getByText('通用账单 · 可导入 2 笔', { exact: true }).waitFor();
    assert.equal(await modal.getByRole('button', { name: '确认导入 2 笔' }).isEnabled(), false);
    await modal.getByText('1 行未纳入导入，请核对', { exact: true }).waitFor();
    await modal.getByRole('checkbox').check();
    if (pass === 1) await page.screenshot({ path: '.local/import-desktop.png', fullPage: true });
    if (pass === 1) await page.route('**/api/v1/transactions/import.json', async (route: { fetch: () => Promise<unknown>; abort: () => Promise<void> }) => {
      await route.fetch();
      await route.abort();
    }, { times: 1 });
    await modal.getByRole('button', { name: '确认导入 2 笔' }).click();
    if (pass === 1) {
      await modal.getByRole('button', { name: '重试确认本次导入', exact: true }).waitFor();
      assert.equal(await modal.getByLabel('记入账户').isEnabled(), false);
      assert.equal(await modal.getByRole('button', { name: '关闭', exact: true }).isEnabled(), false);
      await modal.getByRole('button', { name: '重试确认本次导入', exact: true }).click();
    }
    await modal.getByText(pass === 1 ? '新增 2 笔，重复 0 笔已跳过。' : '新增 0 笔，重复 2 笔已跳过。', { exact: true }).waitFor();
    await modal.getByRole('button', { name: '查看导入流水' }).click();
    await page.getByRole('button').filter({ hasText: '历史午餐' }).waitFor();
    assert.equal(await page.locator('input[type="month"]').inputValue(), '2025-03');
  }
  await page.reload();
  await page.getByRole('button').filter({ hasText: '真实接口验证' }).waitFor();
  assert.equal((await (await page.request.get(`${origin}/api/v1/accounts/list.json`)).json()).result[0].balance, '99971');
  assert.equal((await db.query('SELECT id FROM money_transactions')).rows.length, 3);
  // Exercise XLSX parsing and balance application on a narrow mobile viewport.
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByRole('button', { name: '导入账单', exact: true }).click();
  const importModal = page.getByRole('dialog');
  await importModal.getByLabel('选择账单文件').setInputFiles({ name: '招商银行.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: statementWorkbook([
    ['招商银行交易流水'], ['交易日期', '支出', '收入', '摘要', '交易流水号', '币种'],
    ['2025-03-15', '8.20', '', '公交消费', 'cmb-001', '人民币'],
  ]) });
  await importModal.getByText('招商银行 · 可导入 1 笔', { exact: true }).waitFor();
  await importModal.getByText('分类与余额设置', { exact: true }).click();
  await importModal.getByLabel('账户余额处理').selectOption('apply');
  await importModal.getByRole('checkbox').check();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await importModal.evaluate((element: HTMLElement) => element.scrollWidth > element.clientWidth), false);
  await page.screenshot({ path: '.local/import-mobile.png', fullPage: true });
  await importModal.getByRole('button', { name: '确认导入 1 笔' }).click();
  await importModal.getByText('新增 1 笔，重复 0 笔已跳过。', { exact: true }).waitFor();
  await importModal.getByRole('button', { name: '查看导入流水' }).click();
  await page.getByRole('button').filter({ hasText: '公交消费' }).waitFor();
  await page.reload();
  await page.getByRole('button').filter({ hasText: '真实接口验证' }).waitFor();
  assert.equal((await (await page.request.get(`${origin}/api/v1/accounts/list.json`)).json()).result[0].balance, '99151');
  await page.getByRole('navigation', { name: '手机导航' }).getByRole('button', { name: '账户', exact: true }).click();
  await page.getByRole('button', { name: '创建账户', exact: true }).click();
  await page.getByLabel('账户名称', { exact: true }).fill('测试钱包');
  await page.getByRole('dialog').getByRole('button', { name: '创建账户', exact: true }).click();
  await page.getByRole('button').filter({ hasText: '测试钱包' }).waitFor();
  await page.getByRole('button', { name: '记一笔', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '转账 / 还款', exact: true }).click();
  await page.getByLabel('金额（元）', { exact: true }).fill('10');
  await page.getByLabel('备注', { exact: true }).fill('转账验证');
  await page.getByRole('button', { name: '保存到账本', exact: true }).click();
  await page.getByRole('button').filter({ hasText: '转账验证' }).waitFor();
  const balances = (await (await page.request.get(`${origin}/api/v1/accounts/list.json`)).json()).result;
  assert.deepEqual(balances.map((a: {balance: string}) => a.balance), ['98151', '1000']);
  assert.ok((await page.locator('.cashflow-summary').innerText()).includes('0.29'));
  await page.getByLabel('统计月份', { exact: true }).fill('2025-03');
  await page.getByRole('button').filter({ hasText: '历史午餐' }).waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: '.local/postgres-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 360, height: 800 });
  for (const name of ['账本', '统计', '账户']) {
    await page.getByRole('navigation', { name: '手机导航' }).getByRole('button', { name, exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  await page.getByRole('navigation', { name: '手机导航' }).getByRole('button', { name: '账本', exact: true }).click();
  await page.screenshot({ path: '.local/postgres-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const anonymousCsv = '日期,类型,金额,备注\n2025-03-16,支出,1.00,无单号消费';
  for (const attempt of [1, 2, 3]) {
    await page.getByRole('button', { name: '导入账单', exact: true }).click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('选择账单文件').setInputFiles({ name: '无单号.csv', mimeType: 'text/csv', buffer: Buffer.from(anonymousCsv) });
    await modal.getByText('通用账单 · 可导入 1 笔', { exact: true }).waitFor();
    if (attempt === 3) {
      await modal.getByText('分类与余额设置', { exact: true }).click();
      await modal.getByRole('checkbox', { name: /^无单号的相同记录/ }).check();
    }
    await modal.getByRole('checkbox', { name: /^已核对账户/ }).check();
    await modal.getByRole('button', { name: '确认导入 1 笔' }).click();
    await modal.getByText(attempt === 2 ? '新增 0 笔，重复 1 笔已跳过。' : '新增 1 笔，重复 0 笔已跳过。', { exact: true }).waitFor();
    if (attempt === 2) await modal.getByText(/其中 1 笔没有交易单号/).waitFor();
    await modal.getByRole('button', { name: '查看导入流水' }).click();
    await page.getByRole('heading', { name: '收支明细', exact: true }).waitFor();
  }
  assert.equal((await db.query("SELECT id FROM money_transactions WHERE comment='无单号消费'")).rows.length, 2);
  await page.getByRole('button', { name: '导入账单', exact: true }).click();
  const conflictModal = page.getByRole('dialog');
  await conflictModal.getByLabel('选择账单文件').setInputFiles({ name: '冲突.csv', mimeType: 'text/csv', buffer: Buffer.from('日期,类型,金额,备注,交易单号\n2025-03-12 12:00:00,支出,22.00,历史午餐,test-001') });
  await conflictModal.getByRole('checkbox', { name: /^已核对账户/ }).check();
  await conflictModal.getByRole('button', { name: '确认导入 1 笔' }).click();
  await conflictModal.getByRole('alert').filter({ hasText: '内容不同' }).waitFor();
  assert.equal(await conflictModal.getByLabel('记入账户').isEnabled(), true);
  await conflictModal.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('button', { name: '登录账本', exact: true }).waitFor();
  assert.equal((await page.request.get(`${origin}/api/v1/accounts/list.json`)).status(), 401);
  assert.deepEqual(errors, []);
  process.stdout.write('PASS browser: ledger-first navigation, account, expense, transfer excluded from spending, CSV preview/issues/import/reimport/month selection, XLSX mobile import/balance, reload, HttpOnly cookie, 360px views, logout and unauthorized API\n');
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await db.close();
}
