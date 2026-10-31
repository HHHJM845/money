import type { Pool, PoolClient } from 'pg';
import { exactCents, positiveCents, replacementDelta } from '../shared/ledger-core.js';
import { cleanupExpired, LedgerError, write } from './ledger-write.js';
import { incrementalChanges, masterCollectionsSql } from './sync.js';
import { masterData } from './master-data.js';

export interface BillContent {
  kind: 'income' | 'expense' | 'transfer' | 'refund';
  amountCents: number | null;
  accountId: string | null;
  categoryId: string | null;
  destinationAccountId?: string | null;
  refundOfBillId?: string | null;
  occurredAt: number;
  merchant: string;
  note: string;
  tagIds: string[];
  excludeFromStatistics: boolean;
  excludeFromBudget: boolean;
}

export interface Source {
  app: string;
  key: string;
  capturedAt: number;
  ruleVersion: string;
}

export interface Bill {
  billId: string;
  legacyId: string | null;
  version: number;
  status: 'pending' | 'posted' | 'deleted';
  content: BillContent;
  balanceMode: 'apply' | 'preserve';
  appliedEffect: Record<string, number>;
  restoreEffect: Record<string, number>;
  restoreStatus: 'pending' | 'posted';
  sources?: Source[];
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  changeSequence: string;
}

export interface BillChange {
  billId: string;
  expectedVersion: number;
  action: 'save' | 'delete' | 'restore';
  status?: 'pending' | 'posted';
  content?: BillContent;
  balanceMode?: 'apply' | 'preserve';
  sources?: Source[];
}

interface StoredBill {
  id: string;
  legacy_id: string | null;
  version: number;
  status: Bill['status'];
  content: BillContent;
  balance_mode: Bill['balanceMode'];
  applied_effect: Record<string, number>;
  restore_effect: Record<string, number>;
  restore_status: 'pending' | 'posted';
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LedgerError('请求必须为对象');
  return value as Record<string, unknown>;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new LedgerError('稳定标识无效');
  return value.toLowerCase();
}
function numericId(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) throw new LedgerError('账户、分类或标签编号无效');
  return value;
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new LedgerError('整数或时间无效');
  return value;
}
function timestamp(value: unknown): number {
  return integer(value, 253402271999999);
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw new LedgerError('文本内容过长或无效');
  return value.trim();
}
function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new LedgerError('统计或预算开关无效');
  return value;
}
function content(value: unknown): BillContent {
  const data = object(value);
  if (!['income', 'expense', 'transfer', 'refund'].includes(String(data.kind))) throw new LedgerError('账单类型无效');
  const kind = data.kind as BillContent['kind'];
  const amount = data.amountCents == null ? null : integer(data.amountCents);
  if (amount !== null && amount <= 0) throw new LedgerError('金额必须大于零');
  if (!Array.isArray(data.tagIds) || data.tagIds.length > 30) throw new LedgerError('标签最多三十个');
  const destination = data.destinationAccountId == null ? null : numericId(data.destinationAccountId);
  const refundOf = data.refundOfBillId == null ? null : uuid(data.refundOfBillId);
  if (kind !== 'transfer' && destination !== null) throw new LedgerError('只有转账可以指定转入账户');
  if (kind !== 'refund' && refundOf !== null) throw new LedgerError('只有退款可以关联原支出');
  return {
    kind, amountCents: amount,
    accountId: data.accountId == null ? null : numericId(data.accountId),
    categoryId: data.categoryId == null ? null : numericId(data.categoryId),
    destinationAccountId: destination, refundOfBillId: refundOf,
    occurredAt: timestamp(data.occurredAt), merchant: text(data.merchant, 200), note: text(data.note, 2000),
    tagIds: [...new Set(data.tagIds.map(numericId))].sort(),
    excludeFromStatistics: flag(data.excludeFromStatistics), excludeFromBudget: flag(data.excludeFromBudget),
  };
}
function source(value: unknown): Source {
  const data = object(value);
  const app = text(data.app, 100);
  const key = text(data.key, 256);
  const ruleVersion = text(data.ruleVersion, 100);
  if (!app || !key || !ruleVersion) throw new LedgerError('来源字段不能为空');
  return { app, key, ruleVersion, capturedAt: timestamp(data.capturedAt) };
}
function change(value: unknown): BillChange {
  const data = object(value);
  if (!['save', 'delete', 'restore'].includes(String(data.action))) throw new LedgerError('账单操作无效');
  const action = data.action as BillChange['action'];
  if (data.balanceMode !== undefined && data.balanceMode !== 'apply' && data.balanceMode !== 'preserve') throw new LedgerError('余额模式无效');
  if (action === 'save' && data.status !== 'pending' && data.status !== 'posted') throw new LedgerError('入账状态无效');
  if (data.sources !== undefined && (!Array.isArray(data.sources) || data.sources.length > 20)) throw new LedgerError('来源最多二十个');
  return {
    billId: uuid(data.billId), expectedVersion: integer(data.expectedVersion, 2147483646), action,
    ...(action === 'save' ? { content: content(data.content), status: data.status as BillChange['status'] } : {}),
    ...(data.balanceMode !== undefined ? { balanceMode: data.balanceMode as BillChange['balanceMode'] } : {}),
    sources: (data.sources as unknown[] | undefined)?.map(source) ?? [],
  };
}

function amount(value: bigint): number {
  try { return exactCents(value); } catch { throw new LedgerError('金额或余额超出允许范围'); }
}

// Both compatibility imports and new edits pass through this one transactional writer.
// The caller holds money_ledger_state's lock for the entire enclosing transaction.
export async function saveBills(client: PoolClient, inputs: readonly BillChange[]): Promise<Bill[]> {
  if (!inputs.length || inputs.length > 1000) throw new LedgerError('每次需提交一至一千笔账单');
  const changes = inputs.map(change);
  if (new Set(changes.map(c => c.billId)).size !== changes.length) throw new LedgerError('同一批次不能重复修改同一账单');
  const relatedIds = [...new Set(changes.flatMap(c => [c.billId, ...(c.content?.refundOfBillId ? [c.content.refundOfBillId] : [])]))];
  const stored = await client.query<StoredBill>(`SELECT *,legacy_id::text,created_at::text,updated_at::text,deleted_at::text
    FROM money_bills WHERE id=ANY($1::uuid[]) OR (status='posted' AND content->>'refundOfBillId'=ANY($2::text[]))`, [relatedIds, relatedIds]);
  const original = new Map(stored.rows.map(b => [b.id, b]));
  const missingOriginals = [...new Set(stored.rows.flatMap(b => b.content.refundOfBillId && !original.has(b.content.refundOfBillId) ? [b.content.refundOfBillId] : []))];
  if (missingOriginals.length) {
    const references = await client.query<StoredBill>(`SELECT *,legacy_id::text,created_at::text,updated_at::text,deleted_at::text
      FROM money_bills WHERE id=ANY($1::uuid[]) OR (status='posted' AND content->>'refundOfBillId'=ANY($2::text[]))`, [missingOriginals, missingOriginals]);
    references.rows.forEach(b => original.set(b.id, b));
  }
  const working = new Map(original);
  const accounts = (await client.query<{ id: string; balance: string | null; currency: string; active: boolean }>('SELECT id::text,balance::text,currency,active FROM money_accounts ORDER BY id FOR UPDATE')).rows;
  const activeAccounts = new Set(accounts.filter(a => a.active).map(a => a.id));
  const balances = new Map(accounts.map(a => [a.id, a.balance === null ? null : BigInt(a.balance)]));
  const categories = new Map((await client.query<{ id: string; type: number; active: boolean }>('SELECT id::text,type,active FROM money_categories')).rows.map(c => [c.id, c]));
  const tags = new Map((await client.query<{ id: string; active: boolean }>('SELECT id::text,active FROM money_tags')).rows.map(t => [t.id, t.active]));
  const state = (await client.query<{ sequence: string }>('SELECT sequence::text FROM money_ledger_state WHERE id=1')).rows[0];
  let sequence = BigInt(state.sequence);
  const now = Date.now();
  const result: Bill[] = [];
  const histories: { sequence: string; accountId: string; billId: string; delta: number; balanceAfter: number; reason: string }[] = [];
  const nextRows: StoredBill[] = [];

  for (const input of changes) {
    const old = original.get(input.billId);
    if ((old?.version ?? 0) !== input.expectedVersion) throw new LedgerError('账单已在其他设备修改，请刷新后处理冲突', 409, 'VERSION_CONFLICT');
    if (old && input.balanceMode !== undefined && old.balance_mode !== input.balanceMode) throw new LedgerError('已有账单不能静默切换余额模式');
    if (!old && input.action !== 'save') throw new LedgerError('账单不存在', 404);
    if (input.action === 'save' && old?.status === 'deleted') throw new LedgerError('已删除账单需通过恢复操作处理', 409);
    if (input.action === 'delete' && old?.status === 'deleted') throw new LedgerError('账单已经删除', 409);
    if (input.action === 'restore' && (old?.status !== 'deleted' || old.deleted_at === null || now - Number(old.deleted_at) >= 30 * 86400000)) {
      throw new LedgerError('账单已超过三十天恢复期限或未被删除', 409);
    }
    const body = input.action === 'save' ? input.content! : old!.content;
    const status = input.action === 'save' ? input.status! : input.action === 'delete' ? 'deleted' : old!.restore_status;
    const mode = old?.balance_mode ?? input.balanceMode ?? 'apply';
    if (status !== 'deleted') {
      const retainsPosted = old?.status === 'posted' || (input.action === 'restore' && old?.restore_status === 'posted');
      if (body.amountCents !== null) positiveCents(body.amountCents);
      for (const accountId of [body.accountId, body.destinationAccountId].filter((id): id is string => id != null)) {
        if (!balances.has(accountId)) throw new LedgerError('资金账户不存在');
        const unchanged = retainsPosted && (old!.content.accountId === accountId || old!.content.destinationAccountId === accountId);
        if (!activeAccounts.has(accountId) && !unchanged) throw new LedgerError('资金账户已停用，请选择启用的账户');
      }
      const expectedType = body.kind === 'income' ? 1 : body.kind === 'transfer' ? 3 : 2;
      const category = body.categoryId === null ? null : categories.get(body.categoryId);
      const refundOriginal = body.kind === 'refund' && body.refundOfBillId ? working.get(body.refundOfBillId) : null;
      const retainsCategory = (retainsPosted && old!.content.categoryId === body.categoryId)
        || (refundOriginal?.status === 'posted' && refundOriginal.content.categoryId === body.categoryId);
      if (body.categoryId !== null && (!category || category.type !== expectedType || (!category.active && !retainsCategory))) throw new LedgerError('分类已停用、不存在或类型不匹配');
      if (body.tagIds.some(id => !tags.has(id) || (!tags.get(id) && !(retainsPosted && old!.content.tagIds.includes(id))))) throw new LedgerError('标签已停用或不存在');
      if (status === 'posted' && (body.amountCents === null || body.accountId === null || body.categoryId === null)) throw new LedgerError('正式账单缺少金额、资金账户或分类');
      if (body.kind === 'transfer' && status === 'posted' && (!body.destinationAccountId || body.destinationAccountId === body.accountId)) throw new LedgerError('转出和转入账户必须存在且不同');
      if (body.kind === 'refund' && status === 'posted' && !body.refundOfBillId) throw new LedgerError('退款必须关联原支出');
    }
    let effect: Record<string, number> = {};
    if (input.action === 'restore') {
      effect = old!.restore_effect;
    } else if (status === 'posted' && mode === 'apply') {
      const entries: [string, number][] = [];
      // An account enabled after this bill already uses a newer balance baseline.
      const skippedBaseline = (id: string) => old?.status === 'posted'
        && (old.content.accountId === id || old.content.destinationAccountId === id)
        && !Object.hasOwn(old.applied_effect, id);
      if (balances.get(body.accountId!) !== null && !skippedBaseline(body.accountId!)) {
        entries.push([body.accountId!, body.kind === 'income' || body.kind === 'refund' ? body.amountCents! : -body.amountCents!]);
      }
      if (body.kind === 'transfer' && balances.get(body.destinationAccountId!) !== null && !skippedBaseline(body.destinationAccountId!)) {
        entries.push([body.destinationAccountId!, body.amountCents!]);
      }
      effect = Object.fromEntries(entries);
    }
    sequence += 1n;
    if (sequence > 9223372036854775807n) throw new LedgerError('同步序号超出范围');
    let delta: Record<string, number>;
    try { delta = replacementDelta(old?.applied_effect ?? {}, effect); }
    catch { throw new LedgerError('余额变化超出允许范围'); }
    for (const [accountId, difference] of Object.entries(delta)) {
      const previous = balances.get(accountId);
      if (previous === undefined || previous === null) throw new LedgerError('余额基准已改变，请先核对账户');
      const next = previous + BigInt(difference);
      histories.push({ sequence: String(sequence), accountId, billId: input.billId, delta: difference, balanceAfter: amount(next), reason: input.action });
      balances.set(accountId, next);
    }
    const next: StoredBill = {
      id: input.billId, legacy_id: old?.legacy_id ?? null, version: input.expectedVersion + 1,
      status, content: body, balance_mode: mode, applied_effect: effect,
      restore_effect: input.action === 'delete' ? old!.applied_effect : effect,
      restore_status: input.action === 'delete' ? old!.status as 'pending' | 'posted' : status as 'pending' | 'posted',
      created_at: old?.created_at ?? String(now), updated_at: String(now), deleted_at: status === 'deleted' ? String(now) : null,
    };
    working.set(next.id, next);
    nextRows.push(next);
    result.push({
      billId: next.id, legacyId: next.legacy_id, version: next.version, status, content: body, balanceMode: mode,
      appliedEffect: next.applied_effect, restoreEffect: next.restore_effect,
      restoreStatus: next.restore_status,
      createdAt: Number(next.created_at), updatedAt: now, deletedAt: next.deleted_at === null ? null : now, changeSequence: String(sequence),
    });
  }

  // Validate the final linked state while the ledger lock excludes concurrent refunds.
  const refundTotals = new Map<string, bigint>();
  for (const bill of working.values()) {
    if (bill.status !== 'posted' || bill.content.kind !== 'refund') continue;
    const originalId = bill.content.refundOfBillId!;
    const expense = working.get(originalId);
    if (!expense || expense.status !== 'posted' || expense.content.kind !== 'expense') throw new LedgerError('原支出不存在或已删除，需先处理关联退款');
    if (bill.content.categoryId !== expense.content.categoryId) throw new LedgerError('退款分类必须与原支出一致');
    refundTotals.set(originalId, (refundTotals.get(originalId) ?? 0n) + BigInt(bill.content.amountCents!));
  }
  for (const [id, total] of refundTotals) {
    if (total > BigInt(working.get(id)!.content.amountCents!)) throw new LedgerError('累计退款不能超过原支出');
  }

  const projections = nextRows.filter(b => b.content.kind !== 'refund' && b.status === 'posted');
  if (projections.length) {
    // Allocate compatibility IDs in bulk, avoiding thousands of remote round trips on import.
    const needIds = projections.filter(b => b.legacy_id === null);
    if (needIds.length) {
      const ids = await client.query<{ id: string }>("SELECT nextval(pg_get_serial_sequence('money_transactions','id'))::text AS id FROM generate_series(1,$1)", [needIds.length]);
      needIds.forEach((b, index) => { b.legacy_id = ids.rows[index].id; });
    }
    await client.query(`INSERT INTO money_transactions(id,type,time,category_id,source_account_id,destination_account_id,source_amount,destination_amount,comment)
      OVERRIDING SYSTEM VALUE SELECT r.id,r.type,r.time,r.category,r.account,r.destination,r.amount,r.destination_amount,r.note
      FROM jsonb_to_recordset($1::jsonb) AS r(id bigint,type integer,time bigint,category bigint,account bigint,destination bigint,amount bigint,destination_amount bigint,note text)
      ON CONFLICT(id) DO UPDATE SET type=excluded.type,time=excluded.time,category_id=excluded.category_id,
      source_account_id=excluded.source_account_id,destination_account_id=excluded.destination_account_id,
      source_amount=excluded.source_amount,destination_amount=excluded.destination_amount,comment=excluded.comment`,
    [JSON.stringify(projections.map(b => ({ id: b.legacy_id, type: b.content.kind === 'income' ? 2 : b.content.kind === 'expense' ? 3 : 4,
      time: Math.floor(b.content.occurredAt / 1000), category: b.content.categoryId, account: b.content.accountId,
      destination: b.content.destinationAccountId ?? null, amount: b.content.amountCents,
      destination_amount: b.content.kind === 'transfer' ? b.content.amountCents : null, note: b.content.note })))]);
  }
  result.forEach((bill, i) => { bill.legacyId = nextRows[i].legacy_id; });
  await client.query(`INSERT INTO money_bills(id,legacy_id,version,status,content,balance_mode,applied_effect,restore_effect,restore_status,created_at,updated_at,deleted_at)
    SELECT r.id,r.legacy_id,r.version,r.status,r.content,r.balance_mode,r.applied_effect,r.restore_effect,r.restore_status,r.created_at,r.updated_at,r.deleted_at
    FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,legacy_id bigint,version integer,status text,content jsonb,balance_mode text,applied_effect jsonb,restore_effect jsonb,restore_status text,created_at bigint,updated_at bigint,deleted_at bigint)
    ON CONFLICT(id) DO UPDATE SET legacy_id=excluded.legacy_id,version=excluded.version,status=excluded.status,content=excluded.content,
    applied_effect=excluded.applied_effect,restore_effect=excluded.restore_effect,restore_status=excluded.restore_status,
    updated_at=excluded.updated_at,deleted_at=excluded.deleted_at`, [JSON.stringify(nextRows)]);
  const sources = changes.flatMap(c => (c.sources ?? []).map(s => ({ ...s, billId: c.billId })));
  if (sources.length) {
    const existingSources = await client.query<{ app: string; key: string; bill_id: string }>(`SELECT s.app,s.key,s.bill_id FROM money_bill_sources s
      JOIN jsonb_to_recordset($1::jsonb) AS r(app text,key text) ON s.app=r.app AND s.key=r.key`, [JSON.stringify(sources)]);
    const owners = new Map(existingSources.rows.map(s => [JSON.stringify([s.app, s.key]), s.bill_id]));
    for (const s of sources) {
      const identity = JSON.stringify([s.app, s.key]);
      if (owners.has(identity) && owners.get(identity) !== s.billId) throw new LedgerError('来源已关联另一笔账单，请核对重复记录', 409, 'SOURCE_CONFLICT');
      owners.set(identity, s.billId);
    }
    await client.query(`INSERT INTO money_bill_sources(app,key,bill_id,captured_at,rule_version)
      SELECT r.app,r.key,r."billId",r."capturedAt",r."ruleVersion" FROM jsonb_to_recordset($1::jsonb)
      AS r(app text,key text,"billId" uuid,"capturedAt" bigint,"ruleVersion" text) ON CONFLICT(app,key) DO NOTHING`, [JSON.stringify(sources)]);
  }
  const storedSources = (await client.query<Source & { billId: string }>(
    `SELECT bill_id AS "billId",app,key,captured_at::float8 AS "capturedAt",rule_version AS "ruleVersion"
     FROM money_bill_sources WHERE bill_id=ANY($1::uuid[]) ORDER BY app,key`,
    [result.map(bill => bill.billId)],
  )).rows;
  for (const bill of result) {
    bill.sources = storedSources.filter(s => s.billId === bill.billId)
      .map(({ app, key, capturedAt, ruleVersion }) => ({ app, key, capturedAt, ruleVersion }));
  }
  const changedAccounts = accounts.filter(a => a.balance !== null && balances.get(a.id) !== BigInt(a.balance));
  if (changedAccounts.length) await client.query(`UPDATE money_accounts a SET balance=r.balance
    FROM jsonb_to_recordset($1::jsonb) AS r(id bigint,balance bigint) WHERE a.id=r.id`,
  [JSON.stringify(changedAccounts.map(a => ({ id: a.id, balance: String(balances.get(a.id)) })))]);
  if (histories.length) await client.query(`INSERT INTO money_balance_history(sequence,account_id,bill_id,delta,balance_after,reason)
    SELECT r.sequence,r."accountId",r."billId",r.delta,r."balanceAfter",r.reason FROM jsonb_to_recordset($1::jsonb)
    AS r(sequence bigint,"accountId" bigint,"billId" uuid,delta bigint,"balanceAfter" bigint,reason text)`, [JSON.stringify(histories)]);
  await client.query(`INSERT INTO money_changes(sequence,bill_id,snapshot)
    SELECT (r.value->>'changeSequence')::bigint,(r.value->>'billId')::uuid,r.value FROM jsonb_array_elements($1::jsonb) AS r(value)`, [JSON.stringify(result)]);
  await client.query('UPDATE money_ledger_state SET sequence=$1 WHERE id=1', [String(sequence)]);
  return result;
}

export async function bookkeeping(pool: Pool, route: string, body: unknown, query: URLSearchParams): Promise<unknown> {
  if (route === 'v2/master/submit') return masterData(pool, body);
  if (route !== 'v2/bills/submit') await cleanupExpired(pool);
  if (route === 'v2/sync/changes') return incrementalChanges(pool, query);
  if (route === 'v2/snapshot') {
    // A single statement gives all collections the same MVCC snapshot.
    return (await pool.query(`SELECT ${masterCollectionsSql},
      (SELECT coalesce(jsonb_agg(row_to_json(b)),'[]'::jsonb) FROM
        (SELECT id AS "billId",legacy_id::text AS "legacyId",version,status,content,balance_mode AS "balanceMode",
         applied_effect AS "appliedEffect",restore_effect AS "restoreEffect",
         restore_status AS "restoreStatus",
         (SELECT coalesce(jsonb_agg(jsonb_build_object('app',s.app,'key',s.key,'capturedAt',s.captured_at,'ruleVersion',s.rule_version)
           ORDER BY s.app,s.key),'[]'::jsonb) FROM money_bill_sources s WHERE s.bill_id=money_bills.id) AS sources,
         created_at AS "createdAt",updated_at AS "updatedAt",deleted_at AS "deletedAt",
         (SELECT max(sequence)::text FROM money_changes WHERE bill_id=money_bills.id) AS "changeSequence"
         FROM money_bills WHERE status<>'deleted' OR deleted_at>$1 ORDER BY id) b) AS bills,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('billId',b.id,'legacyId',b.legacy_id::text,'version',b.version,'status','deleted',
        'deletedAt',b.deleted_at,'expired',true,'changeSequence',
        (SELECT max(sequence)::text FROM money_changes WHERE bill_id=b.id)) ORDER BY b.id),'[]'::jsonb)
        FROM money_bills b WHERE status='deleted' AND deleted_at<=$1) AS tombstones,
      sequence::text AS sequence,$2::float8 AS "fetchedAt" FROM money_ledger_state WHERE id=1`,
    [Date.now() - 30 * 86400000, Date.now()])).rows[0];
  }
  if (route === 'v2/bills/submit') {
    const data = object(body);
    const operationId = uuid(data.operationId);
    const input = change(data);
    return write(pool, `import:bookkeeping:${operationId}`, route, input, async client => (await saveBills(client, [input]))[0]);
  }
  if (route === 'v2/accounts/history') {
    const id = numericId(query.get('accountId'));
    return (await pool.query(`SELECT sequence::text,"bill_id" AS "billId",delta::float8 AS "deltaCents",
      balance_after::float8 AS "balanceAfterCents",reason,note FROM money_balance_history WHERE account_id=$1 ORDER BY money_balance_history.sequence`, [id])).rows;
  }
  if (route === 'v2/bills/detail') {
    const id = uuid(query.get('billId'));
    const rows = (await pool.query(`SELECT id AS "billId",legacy_id::text AS "legacyId",version,status,content,
      applied_effect AS "appliedEffect",restore_effect AS "restoreEffect",
      restore_status AS "restoreStatus",
      (SELECT max(sequence)::text FROM money_changes WHERE bill_id=money_bills.id) AS "changeSequence",
      balance_mode AS "balanceMode",created_at::float8 AS "createdAt",updated_at::float8 AS "updatedAt",deleted_at::float8 AS "deletedAt"
      FROM money_bills WHERE id=$1 AND (status<>'deleted' OR deleted_at>$2)`, [id, Date.now() - 30 * 86400000])).rows;
    if (!rows.length) throw new LedgerError('账单不存在或已超过回收站期限', 404);
    const sources = (await pool.query(`SELECT app,key,captured_at::float8 AS "capturedAt",rule_version AS "ruleVersion"
      FROM money_bill_sources WHERE bill_id=$1 ORDER BY app,key`, [id])).rows;
    return { ...rows[0], sources };
  }
  if (route === 'v2/bills/list') {
    const limit = integer(Number(query.get('count') ?? '50'), 200);
    if (limit < 1) throw new LedgerError('分页数量无效');
    const after = query.has('after') ? uuid(query.get('after')) : null;
    const status = query.get('status') ?? 'posted';
    if (!['pending', 'posted', 'deleted'].includes(status)) throw new LedgerError('账单状态无效');
    const rows = (await pool.query(`SELECT id AS "billId",legacy_id::text AS "legacyId",version,status,content,
      applied_effect AS "appliedEffect",restore_effect AS "restoreEffect",
      restore_status AS "restoreStatus",
      (SELECT max(sequence)::text FROM money_changes WHERE bill_id=money_bills.id) AS "changeSequence",
      balance_mode AS "balanceMode",created_at::float8 AS "createdAt",updated_at::float8 AS "updatedAt",deleted_at::float8 AS "deletedAt"
      FROM money_bills WHERE status=$1 AND ($2::uuid IS NULL OR id>$2::uuid)
      AND (status<>'deleted' OR deleted_at>$3) ORDER BY id LIMIT $4`, [status, after, Date.now() - 30 * 86400000, limit + 1])).rows;
    return { items: rows.slice(0, limit), next: rows.length > limit ? rows[limit - 1].billId : null };
  }
  throw new LedgerError('接口不存在', 404);
}
