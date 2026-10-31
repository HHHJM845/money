import type { Pool, PoolClient } from 'pg';
import type { Bill, BillContent, Source } from './bookkeeping.js';
import { LedgerError, write } from './ledger-write.js';

type EntityType = 'account' | 'category' | 'tag';
interface Header { entityId: string | null; expectedVersion: number }
interface AccountContent { name: string; category: number; currency: 'CNY'; active: boolean; balance?: string | null }
interface CategoryContent { name: string; type: number; parentId: string | null; active: boolean; sortOrder: number }
interface TagContent { name: string; active: boolean; sortOrder: number }
interface BalanceContent { balance: string | null; expectedBalance: string | null; reason: string }
type Input = Header & (
  { entityType: 'account'; action: 'save'; content: AccountContent }
  | { entityType: 'account'; action: 'balance'; content: BalanceContent }
  | { entityType: 'category'; action: 'save'; content: CategoryContent }
  | { entityType: 'tag'; action: 'save'; content: TagContent }
);
interface Row { id: string; name: string; active: boolean; version: number }
interface AccountRow extends Row { category: number; type: 1; currency: 'CNY'; balance: string | null }
interface CategoryRow extends Row { type: number; parentId: string | null; sortOrder: number }
interface TagRow extends Row { sortOrder: number }
interface AffectedBill {
  id: string; legacy_id: string | null; version: number; status: Bill['status']; content: BillContent;
  restore_status: 'pending' | 'posted';
  applied_effect: Record<string, number>; restore_effect: Record<string, number>;
  balance_mode: Bill['balanceMode']; created_at: string; updated_at: string; deleted_at: string | null;
}
const accountColumns = 'id::text,name,category,1 AS type,currency,balance::text,active,version';
const categoryColumns = 'id::text,name,type,parent_id::text AS "parentId",active,sort_order AS "sortOrder",version';
const tagColumns = 'id::text,name,active,sort_order AS "sortOrder",version';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LedgerError('请求必须为对象');
  return value as Record<string, unknown>;
}
function numericId(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) {
    throw new LedgerError('账户、分类或标签编号无效');
  }
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new LedgerError('整数无效');
  return value;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || !value.trim()) throw new LedgerError('文本不能为空或超出长度');
  return value.trim();
}
function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new LedgerError('启用状态无效');
  return value;
}
function balance(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^-?(0|[1-9]\d*)$/.test(value) || value.length > 17) throw new LedgerError('余额必须为整数分或空值');
  const amount = BigInt(value);
  if (amount < -9007199254740991n || amount > 9007199254740991n) throw new LedgerError('余额超出允许范围');
  return String(amount);
}
function normalize(body: unknown): { operationId: string; input: Input } {
  const data = object(body);
  if (typeof data.operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.operationId)) {
    throw new LedgerError('稳定标识无效');
  }
  const operationId = data.operationId.toLowerCase();
  const entityId = data.entityId === null ? null : numericId(data.entityId);
  const expectedVersion = integer(data.expectedVersion, 0, 2147483646);
  if ((entityId === null) !== (expectedVersion === 0)) throw new LedgerError('新建或更新版本无效');
  const header = { entityId, expectedVersion };
  const content = object(data.content);
  if (data.action === 'balance') {
    if (data.entityType !== 'account' || entityId === null) throw new LedgerError('只有已有账户可以校正余额');
    return { operationId, input: { ...header, entityType: 'account', action: 'balance', content: {
      balance: balance(content.balance), expectedBalance: balance(content.expectedBalance), reason: text(content.reason, 2000),
    } } };
  }
  if (data.action !== 'save') throw new LedgerError('主数据操作无效');
  const common = { name: text(content.name, 100), active: flag(content.active) };
  if (data.entityType === 'account') {
    if (content.currency !== 'CNY') throw new LedgerError('仅支持人民币');
    if (entityId !== null && Object.hasOwn(content, 'balance')) throw new LedgerError('修改账户信息不能改变余额');
    return { operationId, input: { ...header, entityType: 'account', action: 'save', content: {
      ...common, category: integer(content.category, 1, 9), currency: 'CNY',
      ...(entityId === null ? { balance: content.balance === undefined ? null : balance(content.balance) } : {}),
    } } };
  }
  const sortOrder = integer(content.sortOrder, 0, 2147483647);
  if (data.entityType === 'category') return { operationId, input: { ...header, entityType: 'category', action: 'save', content: {
    ...common, type: integer(content.type, 1, 3), parentId: content.parentId === null ? null : numericId(content.parentId), sortOrder,
  } } };
  if (data.entityType === 'tag') return { operationId, input: { ...header, entityType: 'tag', action: 'save', content: { ...common, sortOrder } } };
  throw new LedgerError('主数据类型无效');
}

function checkVersion(row: Row | undefined, input: Header): void {
  if (input.entityId !== null && !row) throw new LedgerError('记录不存在', 404);
  if ((row?.version ?? 0) !== input.expectedVersion) {
    throw new LedgerError('记录已在其他设备修改，请刷新后处理冲突', 409, 'VERSION_CONFLICT');
  }
}
async function nextSequence(client: PoolClient): Promise<string> {
  return (await client.query<{ sequence: string }>(
    'UPDATE money_ledger_state SET sequence=sequence+1 WHERE id=1 RETURNING sequence::text')).rows[0].sequence;
}
async function masterChange(client: PoolClient, entityType: EntityType, snapshot: Row): Promise<string> {
  const sequence = await nextSequence(client);
  await client.query(`INSERT INTO money_changes(sequence,bill_id,entity_type,entity_id,snapshot)
    VALUES($1,NULL,$2,$3,$4::jsonb)`, [sequence, entityType, snapshot.id, JSON.stringify(snapshot)]);
  return sequence;
}

async function saveCategory(client: PoolClient, input: Extract<Input, { entityType: 'category' }>): Promise<CategoryRow> {
  const old = input.entityId === null ? undefined : (await client.query<CategoryRow>(
    `SELECT ${categoryColumns} FROM money_categories WHERE id=$1 FOR UPDATE`, [input.entityId])).rows[0];
  checkVersion(old, input);
  const data = input.content;
  if (data.parentId !== null) {
    if (data.parentId === input.entityId) throw new LedgerError('分类不能引用自身');
    const parent = (await client.query<CategoryRow>(`SELECT ${categoryColumns} FROM money_categories WHERE id=$1`, [data.parentId])).rows[0];
    if (!parent || parent.parentId !== null || parent.type !== data.type || (data.active && !parent.active)) {
      throw new LedgerError('上级分类不存在、层级或类型不匹配，或已停用');
    }
  }
  if (old) {
    const children = (await client.query<CategoryRow>(`SELECT ${categoryColumns} FROM money_categories WHERE parent_id=$1`, [old.id])).rows;
    if (!data.active && children.some(child => child.active)) throw new LedgerError('请先停用所有子分类');
    const structureChanged = old.type !== data.type || old.parentId !== data.parentId;
    if (structureChanged) {
      if (children.some(child => child.active || data.parentId !== null || child.type !== data.type)) {
        throw new LedgerError('存在子分类，不能改变分类层级或类型');
      }
      const referenced = (await client.query<{ used: boolean }>(`SELECT
        EXISTS(SELECT 1 FROM money_bills WHERE content->>'categoryId'=$1)
        OR EXISTS(SELECT 1 FROM money_transactions WHERE category_id=$1::bigint) AS used`, [old.id])).rows[0].used;
      if (referenced) throw new LedgerError('已被账单引用的分类不能改变类型或上级');
    }
  }
  const values = [data.name, data.type, data.parentId, data.active, data.sortOrder];
  return old ? (await client.query<CategoryRow>(`UPDATE money_categories SET name=$1,type=$2,parent_id=$3,
    active=$4,sort_order=$5,version=version+1 WHERE id=$6 RETURNING ${categoryColumns}`, [...values, old.id])).rows[0]
    : (await client.query<CategoryRow>(`INSERT INTO money_categories(name,type,parent_id,active,sort_order)
      VALUES($1,$2,$3,$4,$5) RETURNING ${categoryColumns}`, values)).rows[0];
}

async function saveTag(client: PoolClient, input: Extract<Input, { entityType: 'tag' }>): Promise<TagRow> {
  const old = input.entityId === null ? undefined : (await client.query<TagRow>(
    `SELECT ${tagColumns} FROM money_tags WHERE id=$1 FOR UPDATE`, [input.entityId])).rows[0];
  checkVersion(old, input);
  const data = input.content;
  return old ? (await client.query<TagRow>(`UPDATE money_tags SET name=$1,active=$2,sort_order=$3,
    version=version+1 WHERE id=$4 RETURNING ${tagColumns}`, [data.name, data.active, data.sortOrder, old.id])).rows[0]
    : (await client.query<TagRow>(`INSERT INTO money_tags(name,active,sort_order) VALUES($1,$2,$3) RETURNING ${tagColumns}`,
      [data.name, data.active, data.sortOrder])).rows[0];
}

async function stripBalanceEffects(client: PoolClient, accountId: string): Promise<void> {
  const now = Date.now();
  // Removing both maps also covers deleted bills whose effects only survive for restoration.
  const affected = (await client.query<AffectedBill>(`UPDATE money_bills SET
    applied_effect=applied_effect-$1::text,restore_effect=restore_effect-$1::text,version=version+1,updated_at=$2
    WHERE applied_effect ? $1::text OR restore_effect ? $1::text
    RETURNING id,legacy_id::text,version,status,restore_status,content,balance_mode,applied_effect,restore_effect,
      created_at::text,updated_at::text,deleted_at::text`,
  [accountId, now])).rows.sort((a, b) => a.id.localeCompare(b.id));
  if (!affected.length) return;
  const sourceRows = (await client.query<Source & { bill_id: string }>(`SELECT bill_id,app,key,
    captured_at::float8 AS "capturedAt",rule_version AS "ruleVersion" FROM money_bill_sources
    WHERE bill_id=ANY($1::uuid[]) ORDER BY bill_id,app,key`, [affected.map(bill => bill.id)])).rows;
  const sources = new Map<string, Source[]>();
  for (const { bill_id, ...source } of sourceRows) {
    const list = sources.get(bill_id) ?? [];
    list.push(source);
    sources.set(bill_id, list);
  }
  for (const bill of affected) {
    const sequence = await nextSequence(client);
    const snapshot: Bill = {
      billId: bill.id, legacyId: bill.legacy_id, version: bill.version, status: bill.status, content: bill.content,
      appliedEffect: bill.applied_effect, restoreEffect: bill.restore_effect, sources: sources.get(bill.id) ?? [],
      restoreStatus: bill.restore_status,
      balanceMode: bill.balance_mode, createdAt: Number(bill.created_at), updatedAt: Number(bill.updated_at),
      deletedAt: bill.deleted_at === null ? null : Number(bill.deleted_at), changeSequence: sequence,
    };
    await client.query(`INSERT INTO money_changes(sequence,bill_id,snapshot) VALUES($1,$2,$3::jsonb)`,
      [sequence, bill.id, JSON.stringify(snapshot)]);
  }
}

async function saveAccount(client: PoolClient, input: Extract<Input, { entityType: 'account'; action: 'save' }>): Promise<AccountRow> {
  const old = input.entityId === null ? undefined : (await client.query<AccountRow>(
    `SELECT ${accountColumns} FROM money_accounts WHERE id=$1 FOR UPDATE`, [input.entityId])).rows[0];
  checkVersion(old, input);
  const data = input.content;
  return old ? (await client.query<AccountRow>(`UPDATE money_accounts SET name=$1,category=$2,currency=$3,active=$4,
    version=version+1 WHERE id=$5 RETURNING ${accountColumns}`, [data.name, data.category, data.currency, data.active, old.id])).rows[0]
    : (await client.query<AccountRow>(`INSERT INTO money_accounts(name,category,currency,active,balance)
      VALUES($1,$2,$3,$4,$5) RETURNING ${accountColumns}`,
    [data.name, data.category, data.currency, data.active, data.balance ?? null])).rows[0];
}

async function calibrate(client: PoolClient, input: Extract<Input, { action: 'balance' }>): Promise<AccountRow> {
  const old = (await client.query<AccountRow>(
    `SELECT ${accountColumns} FROM money_accounts WHERE id=$1 FOR UPDATE`, [input.entityId])).rows[0];
  checkVersion(old, input);
  const data = input.content;
  if (old.balance !== data.expectedBalance) throw new LedgerError('余额已被其他操作改变，请刷新后核对', 409, 'BALANCE_CONFLICT');
  const delta = old.balance === null || data.balance === null ? null : BigInt(data.balance) - BigInt(old.balance);
  if (delta !== null && (delta < -9007199254740991n || delta > 9007199254740991n)) throw new LedgerError('余额变化超出允许范围');
  if (old.balance !== null && data.balance === null) await stripBalanceEffects(client, old.id);
  return (await client.query<AccountRow>(`UPDATE money_accounts SET balance=$1,version=version+1 WHERE id=$2 RETURNING ${accountColumns}`,
    [data.balance, old.id])).rows[0];
}

export async function masterData(pool: Pool, body: unknown): Promise<unknown> {
  const { operationId, input } = normalize(body);
  return write(pool, `import:master:${operationId}`, 'v2/master/submit', input, async client => {
    const snapshot = input.entityType === 'category' ? await saveCategory(client, input)
      : input.entityType === 'tag' ? await saveTag(client, input)
      : input.action === 'balance' ? await calibrate(client, input) : await saveAccount(client, input);
    const changeSequence = await masterChange(client, input.entityType, snapshot);
    if (input.action === 'balance') {
      const { balance: after, expectedBalance: before, reason } = input.content;
      const delta = before === null || after === null ? null : String(BigInt(after) - BigInt(before));
      await client.query(`INSERT INTO money_balance_history(sequence,account_id,bill_id,delta,balance_after,reason,note)
        VALUES($1,$2,NULL,$3,$4,'balance',$5)`, [changeSequence, snapshot.id, delta, after, reason]);
    }
    return { entityType: input.entityType, entityId: snapshot.id, snapshot, changeSequence };
  });
}
