const assert = require('node:assert/strict');
const { readFile, writeFile } = require('node:fs/promises');
const { chromium, devices } = require('playwright');

async function main() {
  const credentials = JSON.parse(await readFile('.local/demo-credentials.json', 'utf8'));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const results = [];
  try {
    for (const [name, options, pathname] of [
      ['desktop', { viewport: { width: 1440, height: 960 } }, '/desktop'],
      ['mobile', { ...devices['Pixel 7'] }, '/mobile'],
    ]) {
      const context = await browser.newContext(options);
      try {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${credentials.origin}${pathname}#/login`, { waitUntil: 'networkidle' });
        process.stdout.write(`${name} login inputs: ${JSON.stringify(
          await page.locator('input').evaluateAll(elements =>
            elements.map(element => ({ type: element.type, placeholder: element.placeholder }))),
        )}\n`);
        await page.locator('input[type=text]').first().fill(credentials.username);
        await page.locator('input[type=password]').first().fill(credentials.password);
        if (name === 'mobile') {
          await page.locator('a.list-button:visible').filter({ hasText: '登录' }).click();
        } else {
          await page.getByRole('button', { name: '登录', exact: true }).click();
        }
        if (name === 'desktop') {
          await page.waitForURL(url => !url.hash.includes('/login'), { timeout: 15000 });
        }
        await page.waitForLoadState('networkidle');
        await page.getByText('90.00', { exact: false }).first().waitFor();
        const text = await page.locator('body').innerText();
        if (name === 'desktop') {
          await page.getByText('1,010.00', { exact: false }).first().waitFor();
        }
        assert(text.includes('90.00'), `${name}: expected expenses missing`);
        assert(text.includes('100.00'), `${name}: expected income missing`);
        const overflow = await page.evaluate(() =>
          document.documentElement.scrollWidth > window.innerWidth + 1);
        assert.equal(overflow, false, `${name}: horizontal page overflow`);
        assert.deepEqual(errors, [], `${name}: JavaScript errors`);
        await page.screenshot({ path: `.local/${name}-overview.png`, fullPage: true, animations: 'disabled' });
        if (name === 'desktop') {
          await page.locator('a[href="#/account/list"]').first().click();
        } else {
          await page.getByText('账户', { exact: true }).click();
        }
        for (const [account, category] of [
          ['Demo CMB Credit', '信用卡'], ['Demo WeChat', '虚拟账户'], ['Demo CMB Bank', '借记账户'],
        ]) {
          if (name === 'desktop') {
            await page.getByText(category, { exact: true }).first().click();
          }
          await page.getByText(account, { exact: true }).first().waitFor();
        }
        const accounts = await page.locator('body').innerText();
        assert(accounts.includes('980.00'), `${name}: expected bank balance missing`);
        assert.deepEqual(errors, [], `${name}: JavaScript errors after navigation`);
        await page.screenshot({ path: `.local/${name}-accounts.png`, fullPage: true, animations: 'disabled' });
        assert.equal(await page.evaluate(() =>
          document.documentElement.scrollWidth > window.innerWidth + 1), false,
        `${name}: horizontal account page overflow`);
        results.push({ name, url: page.url(), errors, overflow, text });
        process.stdout.write(`PASS ${name} login, demo account display and page width\n`);
      } finally {
        await context.close();
      }
    }
    await writeFile('.local/browser-verification.json', `${JSON.stringify(results, null, 2)}\n`);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
});
