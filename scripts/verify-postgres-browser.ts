import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { handle } from '../server/http';
import { hashPassword } from '../server/auth';
import { statementWorkbook } from './statement-fixtures';
import type { Bill } from '../server/bookkeeping';
import type { LedgerSnapshot } from '../src/bookkeeping-api';

const { chromium } = createRequire(import.meta.url)('playwright');
const db = new PGlite();
await db.exec(await readFile('doc/sql/init.sql', 'utf8'));
const query = (sql: string, params?: unknown[]) => db.query(sql, params);
let transactionTail = Promise.resolve();
const pool = { query, async connect() {
  const previous = transactionTail;
  let release!: () => void;
  transactionTail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  return { query, release };
} } as unknown as Pool;
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
  await page.getByRole('heading', { name: '账单', exact: true }).waitFor();
  await page.getByRole('button', { name: '导入账单', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '创建账户', exact: true }).click();
  await page.getByLabel('账户名称', { exact: true }).fill('验证储蓄卡');
  await page.getByLabel('当前余额（人民币元）', { exact: true }).fill('1000');
  const createdAccountResponse = page.waitForResponse('**/api/v2/master/submit.json');
  await page.getByRole('dialog').getByRole('button', { name: '创建账户', exact: true }).click();
  const createdAccount = await createdAccountResponse;
  assert.equal(createdAccount.status(), 200, JSON.stringify(await createdAccount.json()));
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByLabel('账户筛选').locator('option', { hasText: '验证储蓄卡' }).waitFor({ state: 'attached' });
  await page.getByRole('button', { name: '记一笔', exact: true }).click();
  await page.locator('input[name=amount]').fill('0.29');
  await page.getByLabel('备注', { exact: true }).fill('真实接口验证');
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
  await page.getByRole('navigation', { name: '手机导航' }).getByRole('button', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: '创建账户', exact: true }).click();
  await page.getByLabel('账户名称', { exact: true }).fill('测试钱包');
  await page.getByLabel('当前余额（人民币元）', { exact: true }).fill('0');
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
  for (const name of ['账单', '统计', '我的']) {
    await page.getByRole('navigation', { name: '手机导航' }).getByRole('button', { name, exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  await page.getByRole('navigation', { name: '手机导航' }).getByRole('button', { name: '账单', exact: true }).click();
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
    await page.getByRole('heading', { name: '账单', exact: true }).waitFor();
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

  // The core v2 paths use real requests and check balances after every mutation.
  const currentMonth = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7);
  await page.getByLabel('统计月份', { exact: true }).fill(currentMonth);
  const originalRow = () => page.locator('.transaction-row').filter({ hasText: '真实接口验证' });
  const ledgerSnapshot = async (): Promise<{ bills: Bill[]; accounts: { id: string; balance: string | null }[]; categories: { id: string; type: number }[] }> => {
    const response = await page.request.get(`${origin}/api/v2/snapshot.json`);
    assert.equal(response.status(), 200);
    return (await response.json()).result;
  };
  const accountBalance = async () => Number((await ledgerSnapshot()).accounts[0].balance);
  const baseline = await accountBalance();
  let originalBill = (await ledgerSnapshot()).bills.find(b => b.content.note === '真实接口验证')!;
  assert.ok(originalBill);
  await originalRow().click();
  await page.getByRole('dialog').getByRole('button', { name: '修改账单', exact: true }).click();
  await page.getByLabel('金额（元）', { exact: true }).fill('0.30');
  const submissions: string[] = [];
  const observeSubmission = (req: { url: () => string; postData: () => string | null }) => {
    if (req.url().endsWith('/api/v2/bills/submit.json')) submissions.push(req.postData()!);
  };
  page.on('request', observeSubmission);
  await page.route('**/api/v2/bills/submit.json', async (route: { fetch: () => Promise<unknown>; abort: () => Promise<void> }) => {
    await route.fetch();
    await route.abort();
  }, { times: 1 });
  await page.getByRole('button', { name: '保存到账本', exact: true }).click();
  await page.getByRole('button', { name: '重试确认本次操作', exact: true }).waitFor();
  assert.equal(await page.getByLabel('金额（元）', { exact: true }).isEnabled(), false);
  assert.equal(await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).isEnabled(), false);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').isVisible(), true);
  await page.context().clearCookies();
  await page.getByRole('button', { name: '重试确认本次操作', exact: true }).click();
  await page.getByLabel('重新登录账号', { exact: true }).fill(auth.username);
  await page.getByLabel('重新登录密码', { exact: true }).fill(password);
  assert.equal(await page.getByLabel('金额（元）', { exact: true }).isEnabled(), false);
  assert.equal(await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).isEnabled(), false);
  await page.getByRole('button', { name: '重新登录并确认原请求', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  page.off('request', observeSubmission);
  assert.equal(submissions.length, 3);
  assert.deepEqual(JSON.parse(submissions[0]), JSON.parse(submissions[1]));
  assert.deepEqual(JSON.parse(submissions[0]), JSON.parse(submissions[2]));
  assert.equal(await accountBalance(), baseline - 1);

  // An old durable retry response must not replace an already consumed newer change.
  await originalRow().click();
  await page.getByRole('button', { name: '修改账单', exact: true }).click();
  await page.getByLabel('备注', { exact: true }).fill('真实接口验证 · 已提交待确认');
  await page.route('**/api/v2/bills/submit.json', async (route: { fetch: () => Promise<unknown>; abort: () => Promise<void> }) => {
    await route.fetch(); await route.abort();
  }, { times: 1 });
  await page.getByRole('button', { name: '保存到账本', exact: true }).click();
  await page.getByRole('button', { name: '重试确认本次操作', exact: true }).waitFor();
  const unknownOutcome = (await ledgerSnapshot()).bills.find(b => b.billId === originalBill.billId)!;
  const newerNote = '真实接口验证 · 云端较新版本';
  const newerResponse = await page.request.post(`${origin}/api/v2/bills/submit.json`, { headers: { Origin: origin }, data: {
    operationId: randomUUID(), billId: unknownOutcome.billId, expectedVersion: unknownOutcome.version,
    action: 'save', status: 'posted', content: { ...unknownOutcome.content, note: newerNote },
  } });
  assert.equal(newerResponse.status(), 200);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.locator('.transaction-row').filter({ hasText: newerNote }).waitFor({ state: 'attached' });
  await page.getByRole('button', { name: '重试确认本次操作', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.locator('.transaction-row').filter({ hasText: newerNote }).waitFor();
  assert.equal(await accountBalance(), baseline - 1);

  // A stale edit retains the user's draft and requires an explicit version choice.
  await originalRow().click();
  await page.getByRole('button', { name: '修改账单', exact: true }).click();
  await page.getByLabel('备注', { exact: true }).fill('真实接口验证 · 本机输入');
  originalBill = (await ledgerSnapshot()).bills.find(b => b.billId === originalBill.billId)!;
  const external = await page.request.post(`${origin}/api/v2/bills/submit.json`, { headers: { Origin: origin }, data: {
    operationId: randomUUID(), billId: originalBill.billId, expectedVersion: originalBill.version,
    action: 'save', status: 'posted', content: { ...originalBill.content, note: '真实接口验证 · 其他设备' },
  } });
  assert.equal(external.status(), 200);
  await page.getByRole('button', { name: '保存到账本', exact: true }).click();
  await page.getByRole('heading', { name: '账单有更新，当前输入已保留' }).waitFor();
  assert.equal(await page.getByLabel('备注', { exact: true }).inputValue(), '真实接口验证 · 本机输入');
  await page.getByRole('button', { name: '已核对，保留输入继续编辑', exact: true }).click();
  await page.getByRole('button', { name: '保存到账本', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await accountBalance(), baseline - 1);

  await originalRow().click();
  await page.getByRole('button', { name: '删除账单', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await accountBalance(), baseline + 29);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的', exact: true }).click();
  await page.getByText('回收站', { exact: false }).first().click();
  await page.locator('.trash-row').filter({ hasText: '真实接口验证' }).click();
  await page.getByRole('button', { name: '恢复账单', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await originalRow().waitFor();
  assert.equal(await accountBalance(), baseline - 1);
  await originalRow().click();
  await page.getByRole('button', { name: '登记退款', exact: true }).click();
  await page.getByLabel('金额（元）', { exact: true }).fill('0.10');
  await page.getByLabel('商户 / 摘要', { exact: true }).fill('退款核对');
  await page.getByRole('button', { name: '保存到账本', exact: true }).click();
  await page.locator('.transaction-row').filter({ hasText: '退款核对' }).waitFor();
  assert.equal(await accountBalance(), baseline + 9);
  await page.locator('.summary-breakdown > summary').click();
  assert.ok((await page.locator('.summary-breakdown').innerText()).includes('0.10'));
  await page.locator('.transaction-row').filter({ hasText: '退款核对' }).click();
  await page.getByRole('button', { name: '删除账单', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await accountBalance(), baseline - 1);

  await page.getByRole('button', { name: '记一笔', exact: true }).click();
  await page.getByLabel('商户 / 摘要', { exact: true }).fill('待确认核对');
  await page.getByLabel('账户', { exact: true }).selectOption('');
  await page.getByRole('button', { name: '存为待确认', exact: true }).click();
  await page.locator('.pending-row').filter({ hasText: '待确认核对' }).waitFor();
  assert.equal(await accountBalance(), baseline - 1);
  await page.locator('.pending-row').filter({ hasText: '待确认核对' }).click();
  await page.getByLabel('金额（元）', { exact: true }).fill('1.00');
  await page.getByLabel('账户', { exact: true }).selectOption((await ledgerSnapshot()).accounts[0].id);
  await page.getByRole('button', { name: '确认入账', exact: true }).click();
  await page.locator('.transaction-row').filter({ hasText: '待确认核对' }).waitFor();
  assert.equal(await accountBalance(), baseline - 101);

  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: '创建账户', exact: true }).click();
  await page.getByLabel('账户名称', { exact: true }).fill('余额未知钱包');
  await page.getByRole('dialog').getByRole('button', { name: '创建账户', exact: true }).click();
  const unknownAccount = page.locator('.account-row').filter({ hasText: '余额未知钱包' });
  await unknownAccount.waitFor();
  assert.ok((await unknownAccount.innerText()).includes('未设置'));
  assert.equal((await ledgerSnapshot()).accounts.at(-1)?.balance, null);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '账单', exact: true }).click();
  await page.locator('.workspace-footer').filter({ hasText: '更新于' }).waitFor();
  let releaseOldSnapshot!: () => void;
  let observedOldSnapshot!: () => void;
  const heldSnapshot = new Promise<void>(resolve => { releaseOldSnapshot = resolve; });
  const observedSnapshot = new Promise<void>(resolve => { observedOldSnapshot = resolve; });
  let activeSnapshots = 0;
  let maxActiveSnapshots = 0;
  let snapshotRequests = 0;
  await page.route('**/api/v2/sync/changes.json?*', async (route: {
    fetch: () => Promise<unknown>; fulfill: (options: { response: unknown }) => Promise<void>;
  }) => {
    activeSnapshots++;
    maxActiveSnapshots = Math.max(maxActiveSnapshots, activeSnapshots);
    const number = ++snapshotRequests;
    try {
      const response = await route.fetch();
      if (number === 1) { observedOldSnapshot(); await heldSnapshot; }
      else await new Promise(resolve => setTimeout(resolve, 100));
      await route.fulfill({ response });
    } finally { activeSnapshots--; }
  });
  await page.getByRole('button', { name: '刷新账本', exact: true }).click();
  await observedSnapshot;
  for (const merchant of ['连续保存一', '连续保存二']) {
    await page.getByRole('button', { name: '记一笔', exact: true }).click();
    await page.getByLabel('金额（元）', { exact: true }).fill('0.01');
    await page.getByLabel('商户 / 摘要', { exact: true }).fill(merchant);
    await page.getByRole('button', { name: '保存到账本', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  }
  releaseOldSnapshot();
  await page.locator('.workspace-footer').filter({ hasText: '更新于' }).waitFor();
  assert.equal(maxActiveSnapshots, 1);
  await page.unroute('**/api/v2/sync/changes.json?*');
  await page.locator('.transaction-row').filter({ hasText: '连续保存一' }).waitFor();
  await page.locator('.transaction-row').filter({ hasText: '连续保存二' }).waitFor();
  assert.equal(await accountBalance(), baseline - 103);

  // A successful response produced before cleanup may arrive after its tombstone.
  let releaseExpiredAck!: () => void;
  let observeExpiredAck!: () => void;
  const holdExpiredAck = new Promise<void>(resolve => { releaseExpiredAck = resolve; });
  const observedExpiredAck = new Promise<void>(resolve => { observeExpiredAck = resolve; });
  await page.route('**/api/v2/bills/submit.json', async (route: {
    fetch: () => Promise<unknown>; fulfill: (options: { response: unknown }) => Promise<void>;
  }) => {
    const response = await route.fetch();
    observeExpiredAck();
    await holdExpiredAck;
    await route.fulfill({ response });
  }, { times: 1 });
  try {
    await page.getByRole('button', { name: '记一笔', exact: true }).click();
    await page.getByLabel('金额（元）', { exact: true }).fill('0.01');
    await page.getByLabel('商户 / 摘要', { exact: true }).fill('过期迟到确认');
    await page.getByRole('button', { name: '保存到账本', exact: true }).click();
    await observedExpiredAck;
    const expiring = (await ledgerSnapshot()).bills.find(b => b.content.merchant === '过期迟到确认')!;
    const removed = await page.request.post(`${origin}/api/v2/bills/submit.json`, { headers: { Origin: origin }, data: {
      operationId: randomUUID(), billId: expiring.billId, expectedVersion: expiring.version, action: 'delete',
    } });
    assert.equal(removed.status(), 200);
    await db.query('UPDATE money_bills SET deleted_at=$1 WHERE id=$2', [Date.now() - 31 * 86400000, expiring.billId]);
    const expiredSnapshot = (await (await page.request.get(`${origin}/api/v2/snapshot.json`)).json()).result as LedgerSnapshot;
    const caughtUp = page.waitForResponse(async (response: { url: () => string; json: () => Promise<{ result: { nextSequence: string } }> }) =>
      response.url().includes('/api/v2/sync/changes.json?') && (await response.json()).result.nextSequence === expiredSnapshot.sequence);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await caughtUp;
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('button[aria-label="刷新账本"]')?.disabled);
    releaseExpiredAck();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('button[aria-label="刷新账本"]')?.disabled);
    assert.equal(await page.locator('.transaction-row').filter({ hasText: '过期迟到确认' }).count(), 0);
  } finally { releaseExpiredAck(); }

  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的', exact: true }).click();
  const masterSnapshot = async (): Promise<LedgerSnapshot> => (await (await page.request.get(`${origin}/api/v2/snapshot.json`)).json()).result;
  await page.locator('.account-row').filter({ hasText: '余额未知钱包' }).click();
  await page.getByRole('button', { name: '编辑账户', exact: true }).click();
  await page.getByLabel('账户名称', { exact: true }).fill('主数据验证钱包');
  const masterPayloads: string[] = [];
  const observeMaster = (req: { url: () => string; postData: () => string | null }) => {
    if (req.url().endsWith('/api/v2/master/submit.json')) masterPayloads.push(req.postData()!);
  };
  page.on('request', observeMaster);
  await page.route('**/api/v2/master/submit.json', async (route: { fetch: () => Promise<unknown>; abort: () => Promise<void> }) => {
    await route.fetch(); await route.abort();
  }, { times: 1 });
  await page.getByRole('button', { name: '保存账户', exact: true }).click();
  await page.getByRole('button', { name: '重试确认本次操作', exact: true }).waitFor();
  assert.equal(await page.getByLabel('账户名称', { exact: true }).isEnabled(), false);
  await page.context().clearCookies();
  await page.getByRole('button', { name: '重试确认本次操作', exact: true }).click();
  await page.getByLabel('重新登录账号', { exact: true }).fill(auth.username);
  await page.getByLabel('重新登录密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '重新登录并确认原请求', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  page.off('request', observeMaster);
  assert.equal(masterPayloads.length, 3);
  assert.equal(masterPayloads[0], masterPayloads[1]);
  assert.equal(masterPayloads[0], masterPayloads[2]);
  assert.equal(Object.hasOwn(JSON.parse(masterPayloads[0]).content, 'balance'), false);
  const masterAccountRow = () => page.locator('.account-row').filter({ hasText: '主数据验证钱包' });
  await masterAccountRow().waitFor();
  await masterAccountRow().click();
  await page.getByRole('button', { name: '余额设置', exact: true }).click();
  await page.getByLabel('启用账面余额', { exact: true }).check();
  await page.getByLabel('校准余额（人民币元）', { exact: true }).fill('100');
  await page.getByLabel('调整原因', { exact: true }).fill('启用余额基线');
  await page.getByRole('button', { name: '保存余额设置', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '刷新账本', exact: true }).waitFor({ state: 'visible' });
  await masterAccountRow().filter({ hasText: '100.00' }).waitFor();
  await masterAccountRow().click();
  await page.getByRole('button', { name: '余额设置', exact: true }).click();
  await page.getByLabel('校准余额（人民币元）', { exact: true }).fill('120');
  await page.getByLabel('调整原因', { exact: true }).fill('核对实际现金');
  const masterBase = await masterSnapshot();
  const managedAccount = masterBase.accounts.find(a => a.name === '主数据验证钱包')!;
  const balanceRace = await page.request.post(`${origin}/api/v2/bills/submit.json`, { headers: { Origin: origin }, data: {
    operationId: randomUUID(), billId: randomUUID(), expectedVersion: 0, action: 'save', status: 'posted',
    content: { ...originalBill.content, amountCents: 100, accountId: managedAccount.id, merchant: '余额并发验证', note: '' },
  } });
  assert.equal(balanceRace.status(), 200);
  await page.getByRole('button', { name: '保存余额设置', exact: true }).click();
  await page.getByRole('button', { name: '读取最新余额并保留输入', exact: true }).waitFor();
  assert.equal(await page.getByLabel('校准余额（人民币元）', { exact: true }).inputValue(), '120');
  await page.getByRole('button', { name: '读取最新余额并保留输入', exact: true }).click();
  await page.getByRole('button', { name: '保存余额设置', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await masterAccountRow().filter({ hasText: '120.00' }).waitFor();
  await masterAccountRow().click();
  await page.getByText('核对实际现金', { exact: true }).waitFor();
  const historyCount = await page.locator('.balance-history > li').count();
  let releaseNetZero!: () => void;
  let observeNetZero!: () => void;
  const heldNetZero = new Promise<void>(resolve => { releaseNetZero = resolve; });
  const observedNetZero = new Promise<void>(resolve => { observeNetZero = resolve; });
  await page.route('**/api/v2/sync/changes.json?*', async (route: {
    fetch: () => Promise<unknown>; fulfill: (options: { response: unknown }) => Promise<void>;
  }) => {
    observeNetZero();
    await heldNetZero;
    await route.fulfill({ response: await route.fetch() });
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await observedNetZero;
  for (const kind of ['income', 'expense']) {
    const categoryId = (await masterSnapshot()).categories.find(c => c.type === (kind === 'income' ? 1 : 2) && c.active)!.id;
    const response = await page.request.post(`${origin}/api/v2/bills/submit.json`, { headers: { Origin: origin }, data: {
      operationId: randomUUID(), billId: randomUUID(), expectedVersion: 0, action: 'save', status: 'posted',
      content: { ...originalBill.content, kind, categoryId, accountId: managedAccount.id, amountCents: 100,
        merchant: '历史净零验证', note: '' },
    } });
    assert.equal(response.status(), 200);
  }
  releaseNetZero();
  await page.waitForFunction((count: number) => document.querySelectorAll('.balance-history > li').length === count, historyCount + 2);
  await page.unroute('**/api/v2/sync/changes.json?*');
  await page.getByRole('button', { name: '余额设置', exact: true }).click();
  await page.getByLabel('启用账面余额', { exact: true }).uncheck();
  await page.getByLabel('调整原因', { exact: true }).fill('停用余额基线');
  await page.getByRole('button', { name: '保存余额设置', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await masterAccountRow().filter({ hasText: '未设置' }).waitFor();
  await masterAccountRow().click();
  await page.getByText('停用余额基线', { exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑账户', exact: true }).click();
  await page.getByLabel('启用账户', { exact: true }).uncheck();
  await page.getByRole('button', { name: '保存账户', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await masterAccountRow().filter({ hasText: '已停用' }).waitFor();
  await page.getByRole('button', { name: '记一笔', exact: true }).click();
  assert.equal(await page.getByLabel('账户', { exact: true }).locator('option', { hasText: '主数据验证钱包' }).count(), 0);
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();

  await page.getByRole('button', { name: '创建分类', exact: true }).click();
  await page.getByLabel('分类名称', { exact: true }).fill('测试父分类');
  await page.getByRole('dialog').getByRole('button', { name: '创建分类', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.locator('.master-row').filter({ hasText: '测试父分类' }).waitFor();
  await page.getByRole('button', { name: '创建分类', exact: true }).click();
  await page.getByLabel('分类名称', { exact: true }).fill('测试子分类');
  const parentCategory = (await masterSnapshot()).categories.find(c => c.name === '测试父分类')!;
  await page.getByLabel('上级分类', { exact: true }).selectOption(parentCategory.id);
  await page.getByRole('dialog').getByRole('button', { name: '创建分类', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.locator('.master-row').filter({ hasText: '测试父分类 / 测试子分类' }).click();
  await page.getByLabel('启用分类', { exact: true }).uncheck();
  await page.getByRole('button', { name: '保存分类', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.locator('.master-row').filter({ hasText: '测试子分类（已停用）' }).waitFor();
  await page.getByRole('button', { name: '创建标签', exact: true }).click();
  await page.getByLabel('标签名称', { exact: true }).fill('测试旅行');
  await page.getByRole('dialog').getByRole('button', { name: '创建标签', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.locator('.master-row').filter({ hasText: '测试旅行' }).click();
  await page.getByLabel('启用标签', { exact: true }).uncheck();
  await page.getByRole('button', { name: '保存标签', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.locator('.master-row').filter({ hasText: '测试旅行（已停用）' }).waitFor();
  await page.screenshot({ path: '.local/p1-master-desktop.png', fullPage: true });
  await page.getByRole('button', { name: '深色', exact: true }).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.setViewportSize({ width: 360, height: 800 });
  for (const name of ['账单', '统计', '我的']) {
    await page.getByRole('navigation', { name: '手机导航' }).getByRole('button', { name, exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  await page.screenshot({ path: '.local/m4-dark-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '创建分类', exact: true }).click();
  assert.equal(await page.evaluate(() => {
    const dialog = document.querySelector('dialog')!;
    return dialog.scrollWidth <= dialog.clientWidth;
  }), true);
  await page.screenshot({ path: '.local/p1-master-mobile.png', fullPage: true });
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '浅色', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  // A full reload must recover the exact operation, including repeated lost acknowledgements.
  for (const entityType of ['tag', 'account'] as const) {
    const noun = entityType === 'tag' ? '标签' : '账户';
    const name = `重载恢复${noun}`;
    const bodies: string[] = [];
    const observe = (req: { url: () => string; postData: () => string | null }) => {
      if (req.url().endsWith('/api/v2/master/submit.json')) bodies.push(req.postData()!);
    };
    page.on('request', observe);
    await page.getByRole('button', { name: `创建${noun}`, exact: true }).click();
    await page.getByLabel(`${noun}名称`, { exact: true }).fill(name);
    await page.route('**/api/v2/master/submit.json', async (route: {
      fetch: () => Promise<unknown>; abort: () => Promise<void>; request: () => { postData: () => string | null };
    }) => {
      const sent = route.request().postData()!;
      const stored = await page.evaluate((operationId: string) => Object.keys(localStorage)
        .filter(key => key.startsWith('jiancai-mutation-v1:'))
        .map(key => JSON.parse(localStorage.getItem(key)!))
        .find(entry => entry.operationId === operationId), JSON.parse(sent).operationId);
      assert.equal(stored.bodyJson, sent);
      assert.equal(stored.owner, auth.username);
      assert.equal(stored.path, 'v2/master/submit');
      await route.fetch(); await route.abort();
    }, { times: 1 });
    await page.getByRole('dialog').getByRole('button', { name: `创建${noun}`, exact: true }).click();
    await page.getByRole('button', { name: '重试确认本次操作', exact: true }).waitFor();
    page.once('dialog', (dialog: { accept: () => Promise<void> }) => void dialog.accept());
    await page.reload();
    await page.getByRole('heading', { name: '待确认的操作', exact: true }).waitFor({ timeout: 5000 });
    if (entityType === 'tag') {
      await page.setViewportSize({ width: 360, height: 800 });
      assert.equal(await page.getByRole('dialog').evaluate((element: HTMLElement) => element.scrollWidth > element.clientWidth), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: '.local/web-recovery-mobile.png', fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    await page.route('**/api/v2/master/submit.json', async (route: { fetch: () => Promise<unknown>; abort: () => Promise<void> }) => {
      await route.fetch(); await route.abort();
    }, { times: 1 });
    await page.getByRole('button', { name: '确认原请求', exact: true }).click();
    await page.getByRole('dialog').getByRole('alert').waitFor();
    page.once('dialog', (dialog: { accept: () => Promise<void> }) => void dialog.accept());
    await page.reload();
    await page.getByRole('heading', { name: '待确认的操作', exact: true }).waitFor();
    await page.getByRole('button', { name: '确认原请求', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    page.off('request', observe);
    assert.equal(bodies.length, 3);
    assert.equal(bodies[0], bodies[1]);
    assert.equal(bodies[0], bodies[2]);
    const recovered = await masterSnapshot();
    assert.equal((entityType === 'tag' ? recovered.tags : recovered.accounts).filter(row => row.name === name).length, 1);
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的', exact: true }).click();
  }
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('jiancai-mutation-v1:')).length), 0);
  // A denied durable write must never reach the network.
  let deniedRequests = 0;
  const observeDenied = (req: { url: () => string }) => { if (req.url().endsWith('/api/v2/master/submit.json')) deniedRequests++; };
  page.on('request', observeDenied);
  await page.getByRole('button', { name: '创建标签', exact: true }).click();
  await page.getByLabel('标签名称', { exact: true }).fill('存储失败不发送');
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('jiancai-mutation-v1:')) throw new DOMException('Storage denied', 'QuotaExceededError');
      original.call(this, key, value);
    };
  });
  await page.getByRole('dialog').getByRole('button', { name: '创建标签', exact: true }).click();
  await page.getByRole('dialog').getByRole('alert').filter({ hasText: '本次未发送' }).waitFor();
  assert.equal(deniedRequests, 0);
  assert.equal(await page.getByLabel('标签名称', { exact: true }).isEnabled(), false);
  page.off('request', observeDenied);
  page.once('dialog', (dialog: { accept: () => Promise<void> }) => void dialog.accept());
  await page.reload();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的', exact: true }).click();
  // A partial local write must freeze its ID even when verification throws before any network request.
  await page.getByRole('button', { name: '创建标签', exact: true }).click();
  await page.getByLabel('标签名称', { exact: true }).fill('写后读失败恢复');
  const partialBodies: string[] = [];
  const observePartial = (req: { url: () => string; postData: () => string | null }) => {
    if (req.url().endsWith('/api/v2/master/submit.json')) partialBodies.push(req.postData()!);
  };
  page.on('request', observePartial);
  await page.evaluate(() => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function(key) {
      const value = original.call(this, key);
      if (key.startsWith('jiancai-mutation-v1:') && value !== null) throw new DOMException('Read-back denied', 'SecurityError');
      return value;
    };
  });
  await page.getByRole('dialog').getByRole('button', { name: '创建标签', exact: true }).click();
  await page.getByRole('dialog').getByRole('alert').filter({ hasText: '本次未发送' }).waitFor();
  assert.equal(partialBodies.length, 0);
  assert.equal(await page.getByLabel('标签名称', { exact: true }).isEnabled(), false);
  // Repeated clicks still retry the storage write, with no second operation or network request.
  await page.getByRole('button', { name: '重试确认本次操作', exact: true }).click();
  await page.getByRole('dialog').getByRole('alert').filter({ hasText: '本次未发送' }).waitFor();
  assert.equal(partialBodies.length, 0);
  const partialEntry = await page.evaluate(() => {
    const keys = Object.keys(localStorage).filter(key => key.startsWith('jiancai-mutation-v1:'));
    if (keys.length !== 1) throw new Error(`Expected one frozen operation, found ${keys.length}`);
    return JSON.parse(localStorage[keys[0]]);
  });
  page.once('dialog', (dialog: { accept: () => Promise<void> }) => void dialog.accept());
  await page.reload();
  await page.getByRole('heading', { name: '待确认的操作', exact: true }).waitFor();
  await page.getByRole('button', { name: '确认原请求', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  page.off('request', observePartial);
  assert.deepEqual(partialBodies, [partialEntry.bodyJson]);
  assert.equal(JSON.parse(partialBodies[0]).operationId, partialEntry.operationId);
  assert.equal((await masterSnapshot()).tags.filter(t => t.name === '写后读失败恢复').length, 1);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的', exact: true }).click();
  // Transient HTTP failures keep one payload; a definitive rejection clears it and unlocks.
  await page.getByRole('button', { name: '创建标签', exact: true }).click();
  await page.getByLabel('标签名称', { exact: true }).fill('明确拒绝解锁');
  const rejectedBodies: string[] = [];
  const statuses = [403, 408, 429, 400];
  await page.route('**/api/v2/master/submit.json', async (route: {
    request: () => { postData: () => string | null };
    fulfill: (options: { status: number; contentType: string; body: string }) => Promise<void>;
  }) => {
    rejectedBodies.push(route.request().postData()!);
    const status = statuses[rejectedBodies.length - 1];
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ success: false, errorMessage: `模拟${status}` }) });
  });
  await page.getByRole('dialog').getByRole('button', { name: '创建标签', exact: true }).click();
  for (const status of statuses) {
    await page.getByRole('dialog').getByRole('alert').filter({ hasText: `模拟${status}` }).waitFor();
    const remaining = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('jiancai-mutation-v1:')).length);
    assert.equal(remaining, status === 400 ? 0 : 1);
    assert.equal(await page.getByLabel('标签名称', { exact: true }).isEnabled(), status === 400);
    if (status !== 400) await page.getByRole('button', { name: '重试确认本次操作', exact: true }).click();
  }
  assert.equal(rejectedBodies.length, 4);
  assert.ok(rejectedBodies.every(body => body === rejectedBodies[0]));
  await page.unroute('**/api/v2/master/submit.json');
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  // Bills use the same durable confirmation path after a full reload.
  const billBodies: string[] = [];
  const observeBill = (req: { url: () => string; postData: () => string | null }) => {
    if (req.url().endsWith('/api/v2/bills/submit.json')) billBodies.push(req.postData()!);
  };
  page.on('request', observeBill);
  await page.getByRole('button', { name: '记一笔', exact: true }).click();
  await page.getByLabel('金额（元）', { exact: true }).fill('0.01');
  await page.getByLabel('商户 / 摘要', { exact: true }).fill('账单重载恢复');
  await page.route('**/api/v2/bills/submit.json', async (route: { fetch: () => Promise<unknown>; abort: () => Promise<void> }) => {
    await route.fetch(); await route.abort();
  }, { times: 1 });
  await page.getByRole('button', { name: '保存到账本', exact: true }).click();
  await page.getByRole('button', { name: '重试确认本次操作', exact: true }).waitFor();
  page.once('dialog', (dialog: { accept: () => Promise<void> }) => void dialog.accept());
  await page.reload();
  await page.getByRole('heading', { name: '待确认的操作', exact: true }).waitFor();
  await page.context().clearCookies();
  await page.getByRole('button', { name: '确认原请求', exact: true }).click();
  await page.getByLabel('重新登录账号', { exact: true }).fill(auth.username);
  await page.getByLabel('重新登录密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '重新登录并确认原请求', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  page.off('request', observeBill);
  assert.equal(billBodies.length, 3);
  assert.ok(billBodies.every(body => body === billBodies[0]));
  assert.equal((await masterSnapshot()).bills.filter(b => b.content.merchant === '账单重载恢复').length, 1);
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('jiancai-mutation-v1:')).length), 0);
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('button', { name: '登录账本', exact: true }).waitFor();
  assert.equal((await page.request.get(`${origin}/api/v1/accounts/list.json`)).status(), 401);
  assert.deepEqual(errors, []);
  process.stdout.write('PASS browser: durable bill/master journals before network, master double replay across reload without duplicates, recovery reauth, denied/partial storage writes fail closed, 403/408/429 retention and definitive 400 unlock, frozen form retries and reauth, stale/purged acknowledgement guards, serialized incremental refresh, master/balance/history including zero-net refresh, desktop/360px recovery, CSV/XLSX retry/deduplication, HttpOnly session and logout\n');
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await db.close();
}
