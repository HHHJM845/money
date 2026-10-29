import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:8080');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname),
  'Verification is restricted to a local test ledger.');
const checks = [];
let token;

async function request(path, body, authenticated = true) {
  const response = await fetch(new URL(path, origin), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Timezone-Name': 'Asia/Shanghai',
      'X-Timezone-Offset': '480',
      ...(authenticated && token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  assert(response.ok && data.success === true,
    `${path}: HTTP ${response.status}; ${JSON.stringify(data.error ?? 'unsuccessful response')}`);
  return data.result;
}

function pass(name, detail) {
  checks.push({ name, detail, passed: true });
  process.stdout.write(`PASS ${name}\n`);
}

async function main() {
  const home = await fetch(origin, { signal: AbortSignal.timeout(10000) });
  assert(home.ok);
  assert((await home.text()).includes('<html'));
  pass('Web page responds with HTML');

  const username = `verify_${randomBytes(5).toString('hex')}`;
  const password = randomBytes(20).toString('base64url');
  const auth = await request('/api/register.json', {
    username, password, email: `${username}@example.com`,
    nickname: 'Verification Demo', language: 'zh-Hans',
    defaultCurrency: 'CNY', firstDayOfWeek: 1, categories: [],
  }, false);
  assert.equal(typeof auth.token, 'string');
  token = auth.token;
  await mkdir('.local', { recursive: true });
  await writeFile('.local/demo-credentials.json',
    `${JSON.stringify({ origin: origin.origin, username, password }, null, 2)}\n`,
    { mode: 0o600 });
  pass('Fresh isolated demo account registered');

  const categories = {};
  for (const [name, type] of [['Expense', 2], ['Income', 1], ['Transfer', 3]]) {
    const parent = await request('/api/v1/transaction/categories/add.json', {
      name, type, parentId: '0', icon: '1', color: '00897B', clientSessionId: randomUUID(),
    });
    const child = await request('/api/v1/transaction/categories/add.json', {
      name: `${name} Test`, type, parentId: parent.id,
      icon: '1', color: '00897B', clientSessionId: randomUUID(),
    });
    categories[name] = child.id;
  }

  async function account(name, category, balance) {
    const result = await request('/api/v1/accounts/add.json', {
      name, category, type: 1, icon: '1', color: '00897B',
      currency: 'CNY', balance: String(balance),
      balanceTime: Math.floor(Date.now() / 1000) - 3600,
      clientSessionId: randomUUID(),
    });
    assert.equal(typeof result.id, 'string');
    return result;
  }

  const bank = await account('Demo CMB Bank', 2, 100000);
  const credit = await account('Demo CMB Credit', 3, 0);
  const wallet = await account('Demo WeChat', 4, 0);
  pass('Bank, credit card and wallet accounts created');

  async function transaction(overrides) {
    return request('/api/v1/transactions/add.json', {
      type: 3, categoryId: categories.Expense,
      time: Math.floor(Date.now() / 1000), utcOffset: 480,
      sourceAccountId: bank.id, sourceAmount: 2000,
      comment: 'Verification same merchant', clientSessionId: randomUUID(),
      ...overrides,
    });
  }

  const sessionId = randomUUID();
  const first = await transaction({ clientSessionId: sessionId });
  for (let attempt = 0; attempt < 10; attempt++) {
    const replay = await transaction({ clientSessionId: sessionId, time: first.time });
    assert.equal(replay.id, first.id, 'Replay created a new transaction');
  }
  pass('Ten sequential retries return the original transaction');

  const second = await transaction({});
  assert.notEqual(second.id, first.id);
  pass('A separate purchase with identical amount and merchant is retained');

  await transaction({
    type: 2, categoryId: categories.Income,
    sourceAmount: 10000, comment: 'Verification income',
  });
  await transaction({
    sourceAccountId: credit.id, sourceAmount: 5000,
    comment: 'Verification credit consumption',
  });
  const afterConsumption = await request(`/api/v1/accounts/get.json?id=${credit.id}`);
  assert.equal(afterConsumption.balance, '-5000');
  await transaction({
    type: 4, categoryId: categories.Transfer,
    sourceAmount: 5000, destinationAmount: 5000, destinationAccountId: credit.id,
    comment: 'Verification credit repayment',
  });
  await transaction({
    type: 4, categoryId: categories.Transfer,
    sourceAmount: 3000, destinationAmount: 3000, destinationAccountId: wallet.id,
    comment: 'Verification wallet transfer',
  });

  const balances = {};
  for (const acc of [bank, credit, wallet]) {
    const current = await request(`/api/v1/accounts/get.json?id=${acc.id}`);
    balances[acc.name] = current.balance;
  }
  assert.deepEqual(balances, {
    'Demo CMB Bank': '98000', 'Demo CMB Credit': '0', 'Demo WeChat': '3000',
  });
  pass('Consumption, income, repayment and transfers produce expected balances', balances);

  const statistics = await request('/api/v1/transactions/statistics.json');
  assert(Array.isArray(statistics.items));
  const expenses = statistics.items.filter(item => item.categoryId === categories.Expense);
  const incomes = statistics.items.filter(item => item.categoryId === categories.Income);
  assert.equal(expenses.reduce((sum, item) => sum + BigInt(item.amount), 0n), 9000n);
  assert.equal(incomes.reduce((sum, item) => sum + BigInt(item.amount), 0n), 10000n);
  pass('Income and expense totals exclude transfers and credit repayment');

  await writeFile('.local/ledger-verification.json', `${JSON.stringify({
    verifiedAt: new Date().toISOString(), origin: origin.origin, username,
    checks, balances, statistics,
    limits: ['Sequential retry only; concurrency and crash recovery are not verified.',
      'No Android device, bank account, securities account or real statement was accessed.'],
  }, null, 2)}\n`);
  process.stdout.write(`Verified ${checks.length} checks. Results: .local/ledger-verification.json\n`);
}

main().catch(error => {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
});
