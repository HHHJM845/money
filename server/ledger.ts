import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export class LedgerError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

type Data = Record<string, unknown>;
function object(value: unknown): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LedgerError('请求必须为对象');
  return value as Data;
}
function text(value: unknown, max = 100): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new LedgerError('文本内容无效');
  return value.trim();
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new LedgerError('整数或金额超出允许范围');
  return value;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) throw new LedgerError('编号无效');
  return value;
}
function balance(value: unknown): string {
  if (typeof value !== 'string' || !/^-?\d{1,16}$/.test(value)) throw new LedgerError('余额必须为整数分字符串');
  return String(integer(Number(value), -Number.MAX_SAFE_INTEGER));
}
const accountColumns = 'id::text, name, category, 1 AS type, currency, balance::text';
const transactionColumns = `t.id::text, t.id::text AS "timeSequenceId", t.type, t.time::float8 AS time,
 t.source_account_id::text AS "sourceAccountId", t.destination_account_id::text AS "destinationAccountId",
 t.source_amount::float8 AS "sourceAmount", t.destination_amount::float8 AS "destinationAmount",
 t.category_id::text AS "categoryId", t.comment,
 json_build_object('id',c.id::text,'name',c.name,'type',c.type) AS category`;

async function write(pool: Pool, key: string, route: string, payload: Data, action: (client: PoolClient) => Promise<unknown>) {
  const hash = createHash('sha256').update(JSON.stringify([route, payload])).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // A concurrent retry waits for the winning transaction, then reads its committed response.
    await client.query('INSERT INTO money_requests(key,payload_hash) VALUES($1,$2) ON CONFLICT DO NOTHING', [key, hash]);
    const { rows } = await client.query<{payload_hash: string; response: unknown}>('SELECT payload_hash,response FROM money_requests WHERE key=$1 FOR UPDATE', [key]);
    if (rows[0].payload_hash !== hash) throw new LedgerError('请求编号已用于其他内容', 409);
    let result = rows[0].response;
    if (result === null) {
      result = await action(client);
      await client.query('UPDATE money_requests SET response=$2::jsonb WHERE key=$1', [key, JSON.stringify(result)]);
    }
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    if (error && typeof error === 'object' && 'code' in error && ['23514', '22003'].includes(String(error.code))) {
      throw new LedgerError('金额或数据超出允许范围');
    }
    throw error;
  } finally { client.release(); }
}

export async function ledger(pool: Pool, route: string, body: unknown, query: URLSearchParams): Promise<unknown> {
  if (route === 'v1/accounts/list') return (await pool.query(`SELECT ${accountColumns} FROM money_accounts ORDER BY id`)).rows;
  if (route === 'v1/transaction/categories/list') {
    const {rows} = await pool.query<{id: string; name: string; type: number}>('SELECT id::text,name,type FROM money_categories ORDER BY id');
    const groups: Record<string, typeof rows> = {'1': [], '2': [], '3': []};
    for (const row of rows) groups[String(row.type)].push(row);
    return groups;
  }
  if (route === 'v1/transactions/list') {
    const countText = query.get('count') ?? '50';
    if (!/^\d{1,3}$/.test(countText)) throw new LedgerError('分页数量无效');
    const count = integer(Number(countText), 1, 200);
    if (query.has('page') && query.get('page') !== '1') throw new LedgerError('请使用游标分页');
    const cursor = query.has('max_time') ? id(query.get('max_time')) : null;
    const {rows} = await pool.query(`SELECT ${transactionColumns} FROM money_transactions t
      JOIN money_categories c ON c.id=t.category_id
      WHERE ($1::bigint IS NULL OR t.id < $1::bigint) ORDER BY t.id DESC LIMIT $2`, [cursor, count + 1]);
    const items = rows.slice(0, count);
    return {items, nextTimeSequenceId: rows.length > count ? String(items[items.length - 1].id) : null};
  }
  if (!['v1/accounts/add','v1/transaction/categories/add','v1/transactions/add'].includes(route)) throw new LedgerError('接口不存在', 404);
  const data = object(body);
  const key = text(data.clientSessionId, 128);
  if (route === 'v1/accounts/add') {
    if (data.currency !== 'CNY') throw new LedgerError('首版仅支持人民币账户');
    if (data.type !== undefined && data.type !== 1) throw new LedgerError('仅支持独立账户');
    const payload = {name: text(data.name), category: integer(data.category, 1, 9), currency: 'CNY', balance: balance(data.balance)};
    return write(pool, key, route, payload, async client => (await client.query(
      `INSERT INTO money_accounts(name,category,currency,balance) VALUES($1,$2,$3,$4) RETURNING ${accountColumns}`,
      [payload.name,payload.category,payload.currency,payload.balance])).rows[0]);
  }
  if (route === 'v1/transaction/categories/add') {
    if (data.parentId !== undefined && data.parentId !== '0') throw new LedgerError('首版仅支持平铺分类');
    const payload = {name: text(data.name), type: integer(data.type, 1, 3)};
    return write(pool,key,route,payload,async client => (await client.query(
      'INSERT INTO money_categories(name,type) VALUES($1,$2) RETURNING id::text,name,type',[payload.name,payload.type])).rows[0]);
  }
  const type = integer(data.type, 2, 4);
  if (data.currency !== undefined && data.currency !== 'CNY') throw new LedgerError('首版仅支持人民币');
  const payload = {
    type, categoryId: id(data.categoryId), sourceAccountId: id(data.sourceAccountId),
    sourceAmount: integer(data.sourceAmount, 1), time: integer(data.time, 0, 253402271999),
    destinationAccountId: type === 4 ? id(data.destinationAccountId) : null,
    destinationAmount: type === 4 ? integer(data.destinationAmount, 1) : null,
    comment: data.comment === undefined || data.comment === '' ? '' : text(data.comment, 2000),
  };
  if (type !== 4 && (data.destinationAccountId != null || data.destinationAmount != null)) throw new LedgerError('收支不能指定转入账户');
  if (type === 4 && (payload.sourceAccountId === payload.destinationAccountId || payload.sourceAmount !== payload.destinationAmount)) throw new LedgerError('转账账户必须不同且人民币转入转出金额相等');
  return write(pool,key,route,payload,async client => {
    const category = await client.query('SELECT type FROM money_categories WHERE id=$1',[payload.categoryId]);
    if (category.rows[0]?.type !== type - 1) throw new LedgerError('分类不存在或与交易类型不匹配');
    const ids = [payload.sourceAccountId, ...(payload.destinationAccountId ? [payload.destinationAccountId] : [])];
    // Lock accounts in numeric ID order for all transfers to avoid opposite-direction deadlocks.
    const accounts = await client.query('SELECT id,currency FROM money_accounts WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE',[ids]);
    if (accounts.rows.length !== ids.length || accounts.rows.some(a => a.currency !== 'CNY')) throw new LedgerError('账户不存在或币种不支持');
    await client.query('UPDATE money_accounts SET balance=balance+$2::bigint WHERE id=$1',[payload.sourceAccountId,type === 2 ? payload.sourceAmount : -payload.sourceAmount]);
    if (type === 4) await client.query('UPDATE money_accounts SET balance=balance+$2::bigint WHERE id=$1',[payload.destinationAccountId,payload.destinationAmount]);
    const saved = await client.query('INSERT INTO money_transactions(type,time,category_id,source_account_id,destination_account_id,source_amount,destination_amount,comment) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [type,payload.time,payload.categoryId,payload.sourceAccountId,payload.destinationAccountId,payload.sourceAmount,payload.destinationAmount,payload.comment]);
    return (await client.query(`SELECT ${transactionColumns} FROM money_transactions t JOIN money_categories c ON c.id=t.category_id WHERE t.id=$1`,[saved.rows[0].id])).rows[0];
  });
}
