const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const { chromium, devices } = require('playwright');

async function main() {
  const origin = process.argv[2] || 'http://127.0.0.1:5174';
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const checks = [];
  const errors = [];
  const pass = name => { checks.push(name); process.stdout.write(`PASS ${name}\n`); };
  await mkdir('.local', { recursive: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin);
    await page.getByRole('button', { name: '创建独立体验账本', exact: true }).click();
    await page.getByRole('button', { name: '查看净资产构成' }).waitFor({ timeout: 60000 });
    assert.match(await page.getByRole('button', { name: '查看净资产构成' }).innerText(), /1,010\.00/);
    assert.match(await page.locator('.flow-metrics').innerText(), /100\.00[\s\S]*90\.00[\s\S]*10\.00/);
    pass('Demo creates real ledger records and correct overview totals');
    await page.screenshot({ path: '.local/product-desktop.png', fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: '上个月', exact: true }).click();
    await page.getByText('这个月还没有支出', { exact: true }).waitFor();
    assert.match(await page.getByRole('button', { name: '查看净资产构成' }).innerText(), /1,010\.00/);
    await page.getByRole('button', { name: '下个月', exact: true }).click();
    pass('Month filter changes flow while retaining current net worth');
    await page.getByRole('button', { name: '记一笔', exact: true }).click();
    await page.locator('input[name=amount]').fill('0.29');
    await page.locator('input[name=comment]').fill('浏览器验证支出');
    await page.getByRole('button', { name: '保存到账本', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已保存到账本' }).waitFor();
    await page.waitForFunction(() => document.querySelector('.wealth-value')?.textContent.includes('1,009.71'));
    pass('Manual entry persists with exact cents and refreshes totals');
    await page.getByRole('button', { name: '本月支出', exact: false }).click();
    assert.equal(await page.locator('.transaction-row').count(), 4);
    await page.getByLabel('搜索账单').fill('浏览器验证支出');
    assert.equal(await page.locator('.transaction-row').count(), 1);
    await page.locator('.transaction-row').click();
    assert.match(await page.locator('dialog').innerText(), /0\.29/);
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出当前筛选账单' }).click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /账单-.*\.csv/);
    pass('Metric drilldown, search, detail and CSV export work');
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '资产', exact: true }).click();
    assert.equal(await page.locator('.account-row').count(), 3);
    await page.locator('.account-row').first().click();
    assert.notEqual(await page.getByLabel('账户筛选').inputValue(), '');
    pass('Account balances drill down to filtered transactions');
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '投资', exact: true }).click();
    await page.getByText('暂无证券持仓数据', { exact: true }).waitFor();
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '总览', exact: true }).click();
    await page.getByRole('button', { name: '隐藏金额' }).click();
    assert.match(await page.getByRole('button', { name: '查看净资产构成' }).innerText(), /••••/);
    await page.getByRole('button', { name: '显示金额' }).click();
    pass('Unavailable investment state and privacy toggle work');
    await page.route('**/api/v1/accounts/list.json', route => route.fulfill({
      status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: '验证服务故障' } }),
    }));
    await page.getByRole('button', { name: '刷新账本', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '上次成功读取' }).waitFor();
    await page.unroute('**/api/v1/accounts/list.json');
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[role=alert]'));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.wealth-value')?.textContent.includes('1,009.71'));
    pass('Refresh failure retains labeled stale data; retry and reload recover');
    const session = await page.evaluate(() => sessionStorage.getItem('money-session'));
    await writeFile('.local/product-demo-session.json', session, { mode: 0o600 });
    const mobile = await browser.newContext({ ...devices['Pixel 7'] });
    await mobile.addInitScript(value => sessionStorage.setItem('money-session', value), session);
    const phone = await mobile.newPage();
    phone.on('pageerror', e => errors.push(e.message));
    await phone.goto(origin);
    await phone.getByRole('button', { name: '查看净资产构成' }).waitFor();
    await phone.screenshot({ path: '.local/product-mobile.png', fullPage: true, animations: 'disabled' });
    for (const width of [412, 360]) {
      await phone.setViewportSize({ width, height: 915 });
      for (const name of ['总览', '收支', '资产', '投资']) {
        await phone.getByRole('navigation', { name: '手机导航' }).getByRole('button', { name, exact: true }).click();
        assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px ${name} overflow`);
      }
    }
    await phone.getByRole('button', { name: '导入账单', exact: true }).click();
    assert.match(await phone.locator('dialog').innerText(), /原版账本/);
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    pass('All four pages and import dialog fit Android widths 412px and 360px');
    assert.deepEqual(errors, []);
    pass('No uncaught browser errors');
    await writeFile('.local/product-verification.json', JSON.stringify({ at: new Date().toISOString(), origin, checks }, null, 2));
  } finally { await browser.close(); }
}
main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
