# M1 账务内核 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 superpowers:subagent-driven-development 或 superpowers:executing-plans 按任务执行；先运行失败用例，再实现。无需重新询问已经确认的产品选择。

**Goal:** 建立可测试的整数金额、修改余额差额及净支出口径，作为后续存储/同步与界面统一基础。

**Architecture:** 新建无网络、无数据库依赖的 TypeScript 纯函数及合成样例；既有网页/服务端在 M2 通过适配接入，M1 不改变线上行为。Android 使用同一份样例验证 Kotlin 等价实现，不能直接假装复用 TypeScript 运行时。

**Tech Stack:** Node 22、TypeScript、现有 tsx/node:test；不新增运行依赖。

## Global Constraints

- 基线为 `docs/superpowers/specs/2026-10-30-auto-bookkeeping-design.md`。
- 人民币整数分、最大可精确整数范围；不存在的余额不补零。
- 修改计算输入为“已经实际应用过的余额影响”，历史导入保留余额时其影响为空，不能从流水金额猜测旧影响。
- 待确认、删除、不计统计和转账不加入普通收支；退款按到账月冲减净支出。
- 本切片不修改生产 SQL、数据库连接、鉴权、`.env`、旧流水或现有 UI。
- 不自动 commit/push 文档，不使用 `any`、控制台调试输出或本机绝对路径。

## Task 1：先写账务纯函数失败测试

**Create:** `shared/ledger-core.test.ts`。
**Consumes:** 设计中的上海时区、现金/银行卡变动和跨月退款规则。
**Produces:** 下列可重复运行的断言，函数由 Task 2 提供。

- [x] 建立测试文件：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positiveCents, replacementDelta, summarize, type SummaryRow } from './ledger-core.js';

test('cents reject fractional, non-positive and unsafe amounts', () => {
  assert.equal(positiveCents(1234), 1234);
  for (const value of [0, -1, 0.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => positiveCents(value));
  }
});

test('edit, move account, delete and restore reverse actual applied effects', () => {
  assert.deepEqual(replacementDelta({ cash: -2500 }, { cash: -3000 }), { cash: -500 });
  assert.deepEqual(replacementDelta({ cash: -3000 }, { bank: -3000 }), { cash: 3000, bank: -3000 });
  assert.deepEqual(replacementDelta({ bank: -3000 }, {}), { bank: 3000 });
  assert.deepEqual(replacementDelta({}, { bank: -3000 }), { bank: -3000 });
  assert.deepEqual(replacementDelta({ cash: -2500 }, { cash: -2500 }), {});
});

test('historical import with no applied balance effect deletes without crediting money', () => {
  assert.deepEqual(replacementDelta({}, {}), {});
});

test('overflow is rejected even when each original effect is safe', () => {
  assert.throws(() => replacementDelta({ cash: -Number.MAX_SAFE_INTEGER }, { cash: 1 }));
});

const row = (patch: Partial<SummaryRow>): SummaryRow => ({
  kind: 'expense', status: 'posted', amountCents: 2500,
  occurredAt: Date.parse('2026-10-29T04:00:00Z'), excludeFromStatistics: false, ...patch,
});

test('statistics separate income, expense and refund; omit pending/deleted/transfer/excluded', () => {
  const rows = [row({}), row({kind: 'income', amountCents: 10000}),
    row({kind: 'refund', amountCents: 500}), row({kind: 'transfer'}),
    row({status: 'pending'}), row({status: 'deleted'}), row({excludeFromStatistics: true})];
  assert.deepEqual(summarize(rows, '2026-10'), {
    incomeCents: 10000, expenseCents: 2500, refundCents: 500,
    netExpenseCents: 2000, surplusCents: 8000,
  });
});

test('refund uses arrival month and Shanghai month boundary', () => {
  const rows = [row({}), row({kind: 'refund', amountCents: 500,
    occurredAt: Date.parse('2026-10-31T16:00:00Z')})];
  assert.equal(summarize(rows, '2026-10').netExpenseCents, 2500);
  assert.equal(summarize(rows, '2026-11').netExpenseCents, -500);
  assert.throws(() => summarize(rows, '2026-13'));
});
```

- [x] 运行 `npx tsx --test shared/ledger-core.test.ts`，确认因尚无模块而失败。测试不能连接生产服务。

## Task 2：实现金额与影响差额

**Create:** `shared/ledger-core.ts`。
**Produces:** `positiveCents(number)`、`replacementDelta(before,after)`、`summarize(rows,month)`，名称与 Task 1 完全一致。

- [x] 写入以下最小实现：

```ts
export interface SummaryRow {
  kind: 'income' | 'expense' | 'transfer' | 'refund';
  status: 'pending' | 'posted' | 'deleted';
  amountCents: number;
  occurredAt: number;
  excludeFromStatistics: boolean;
}

function signedCents(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error('金额超出可精确计算的范围');
  return value;
}

export function positiveCents(value: number): number {
  if (signedCents(value) <= 0) throw new Error('金额必须大于零');
  return value;
}

function exactNumber(value: bigint): number {
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  if (value > limit || value < -limit) throw new Error('金额汇总超出范围');
  return Number(value);
}

export function replacementDelta(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
): Record<string, number> {
  const result: Array<[string, number]> = [];
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const oldValue = Object.hasOwn(before, id) ? before[id] : 0;
    const newValue = Object.hasOwn(after, id) ? after[id] : 0;
    const delta = exactNumber(BigInt(signedCents(newValue)) - BigInt(signedCents(oldValue)));
    if (delta !== 0) result.push([id, delta]);
  }
  return Object.fromEntries(result);
}

export function summarize(rows: readonly SummaryRow[], month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('月份无效');
  let income = 0n, expense = 0n, refund = 0n;
  for (const row of rows) {
    if (row.status !== 'posted' || row.excludeFromStatistics) continue;
    if (!Number.isSafeInteger(row.occurredAt)) throw new Error('交易时间无效');
    const date = new Date(row.occurredAt + 8 * 3600000);
    if (!Number.isFinite(date.getTime())) throw new Error('交易时间无效');
    if (date.toISOString().slice(0, 7) !== month) continue;
    const amount = BigInt(positiveCents(row.amountCents));
    if (row.kind === 'income') income += amount;
    if (row.kind === 'expense') expense += amount;
    if (row.kind === 'refund') refund += amount;
  }
  return {
    incomeCents: exactNumber(income), expenseCents: exactNumber(expense),
    refundCents: exactNumber(refund), netExpenseCents: exactNumber(expense - refund),
    surplusCents: exactNumber(income - expense + refund),
  };
}
```

- [x] 运行同一测试命令，应全部通过。另补边界断言：多个合法金额相加溢出时失败，未知日期不返回空统计冒充成功。
- [x] 在 `package.json` 把 test 改为 `tsx --test src/*.test.ts server/*.test.ts shared/*.test.ts`；保持其他 scripts 和依赖不变。
- [x] 运行 `npm test` 及 `npm run build`，完成现有行为回归。此时生产页面仍未使用新函数，不宣称新增账务功能上线。

## Task 3：固定跨端样例和提交契约

**Create:** `test/fixtures/bookkeeping-v1.json`、`docs/contracts/bookkeeping-v1.md`。

- [x] 合成样例使用以下完整 JSON；后续 Kotlin 测试加载同一文件，校验输入单位为分而非元：

```json
{
  "version": 1,
  "currency": "CNY",
  "timeZone": "Asia/Shanghai",
  "initialBalances": {"cash": 100000, "bank": 200000},
  "operations": [
    {"before": {}, "after": {"cash": -2500}, "balances": {"cash": 97500, "bank": 200000}},
    {"before": {"cash": -2500}, "after": {"cash": -3000}, "balances": {"cash": 97000, "bank": 200000}},
    {"before": {"cash": -3000}, "after": {"bank": -3000}, "balances": {"cash": 100000, "bank": 197000}},
    {"before": {"bank": -3000}, "after": {}, "balances": {"cash": 100000, "bank": 200000}},
    {"before": {}, "after": {"bank": -3000}, "balances": {"cash": 100000, "bank": 197000}},
    {"before": {}, "after": {}, "balances": {"cash": 100000, "bank": 197000}}
  ]
}
```

- [x] 在测试末尾追加真实加载验证：

```ts
test('shared fixture applies each balance delta exactly once', async () => {
  const { readFile } = await import('node:fs/promises');
  const fixture = JSON.parse(await readFile(new URL('../test/fixtures/bookkeeping-v1.json', import.meta.url), 'utf8')) as {
    initialBalances: Record<string, number>;
    operations: Array<{before: Record<string, number>; after: Record<string, number>; balances: Record<string, number>}>;
  };
  const balances = { ...fixture.initialBalances };
  for (const op of fixture.operations) {
    for (const [id, delta] of Object.entries(replacementDelta(op.before, op.after))) balances[id] += delta;
    assert.deepEqual(balances, op.balances);
  }
});
```

- [x] 契约文档固定下列条款：

```text
1. 一个账本；CNY；金额数值为整数分，所有端拒绝超出 JavaScript 安全整数范围。
2. 新操作和新账单由客户端生成稳定 UUID；旧服务端 bigint ID 保留，通过唯一映射兼容，不改变原流水身份。
3. domain occurredAt/createdAt/updatedAt 使用 Unix 毫秒；旧 v1 秒字段只在适配边界转换。
4. 账单状态 pending/posted/deleted 与同步状态 queued/sending/synced/failed/conflict 分离。
5. 来源可多条：来源应用、来源范围内交易标识或摘要、采集时刻、适配规则版本；不发送整段页面原文。
6. 原始余额影响必须保存；preserve 模式历史导入的影响为空。replacementDelta 只撤销实际旧影响。
7. 提交包含 operationId、billId、expectedVersion 和内容；同 operationId 同内容返回原结果，不重复修改余额。
8. 服务端确认返回 billId、version、changeSequence；无效输入/未登录/版本冲突/服务不可用分别返回可辨识错误。
9. changeSequence 由服务端提交顺序产生，以整数串传输；不能用 occurredAt 作增量游标。
10. 删除和恢复均形成新版本；回收站30天后不可恢复完整记录，删除版本标记仍可阻止旧设备复活记录。
11. AI 和采集输入只生成候选，能否 posted 由已批准确认规则和完整校验决定，不由模型输出字段直接控制。
12. v1 兼容路由和新版路由共享账务事务入口；不得保留两套独立写余额实现。
```

- [x] M1 切片测试与构建通过后推进 M2；M1 当时仅新增内核/样例/契约并调整测试及类型检查路径。后续 SQL/UI 更动属于 M2/M4，不能与 M1 完成证据混淆。

2026-10-30：M1 TypeScript 新增 9 项测试，连同既有 38 项共 47 项通过，构建通过。Kotlin 等价内核已新增，读取同一 JSON 样例；Android Gradle 集成结果另记执行记录。

## 完成后的移交

M2 服务端和 Android Repository 分别消费这份契约与合成样例。预算、退款关联上限、账户启用余额、版本冲突仍由存储层负责校验；本模块的纯计算不能替代那些约束。M1 完成只证明这些计算切片，不证明完整同步、真实采集或 APK 可安装。
