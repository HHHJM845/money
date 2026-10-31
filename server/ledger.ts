import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { LedgerError, write } from './ledger-write.js';
import { saveBills } from './bookkeeping.js';
import { appendMasterChange } from './sync.js';
export { LedgerError } from './ledger-write.js';

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
function balance(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^-?\d{1,16}$/.test(value)) throw new LedgerError('余额必须为整数分字符串');
  return String(integer(Number(value), -Number.MAX_SAFE_INTEGER));
}
const accountColumns = 'id::text, name, category, 1 AS type, currency, balance::text';
const transactionColumns = `t.id::text, t.id::text AS "timeSequenceId", t.type, t.time::float8 AS time,
 t.source_account_id::text AS "sourceAccountId", t.destination_account_id::text AS "destinationAccountId",
 t.source_amount::float8 AS "sourceAmount", t.destination_amount::float8 AS "destinationAmount",
 t.category_id::text AS "categoryId", t.comment,
 json_build_object('id',c.id::text,'name',c.name,'type',c.type) AS category`;

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function importTransactions(pool: Pool, data: Data, sessionId: string) {
  if (!['wechat', 'alipay', 'cmb', 'generic'].includes(String(data.provider))) throw new LedgerError('账单来源无效');
  const provider = text(data.provider);
  const accountId = id(data.accountId);
  const incomeCategoryId = id(data.incomeCategoryId);
  const expenseCategoryId = id(data.expenseCategoryId);
  const balanceMode = data.balanceMode ?? 'preserve';
  if (balanceMode !== 'preserve' && balanceMode !== 'apply') throw new LedgerError('余额处理方式无效');
  const anonymousMode = data.anonymousMode === undefined ? 'deduplicate' : data.anonymousMode;
  if (anonymousMode !== 'deduplicate' && anonymousMode !== 'keep') throw new LedgerError('无交易单号记录处理方式无效');
  if (!Array.isArray(data.rows) || data.rows.length < 1 || data.rows.length > 1000) throw new LedgerError('每次需导入 1 至 1000 条流水');
  const occurrences = new Map<string, number>();
  const canonicalAliases = new Map<string, string>();
  const rows = data.rows.map(value => {
    const row = object(value);
    const normalized = {
      time: integer(row.time, 0, 253402271999), type: integer(row.type, 2, 3),
      amount: integer(row.amount, 1), comment: row.comment === '' ? '' : text(row.comment, 2000),
    };
    const rowNumber = integer(row.rowNumber, 1);
    const sourceId = row.sourceId === undefined ? undefined : text(row.sourceId, 256);
    const hash = digest(normalized);
    const occurrence = (occurrences.get(hash) ?? 0) + 1;
    // Explicit keep mode distinguishes intentional new anonymous rows by batch; retries retain identity.
    if (sourceId === undefined) occurrences.set(hash, occurrence);
    const identity = sourceId !== undefined ? ['source', sourceId]
      : anonymousMode === 'keep' ? ['fingerprint-batch', sessionId, hash, occurrence] : ['fingerprint', hash, occurrence];
    const key = `import:row:${digest([provider, accountId, identity])}`;
    if (sourceId === undefined && anonymousMode === 'keep') {
      canonicalAliases.set(key, `import:row:${digest([provider, accountId, ['fingerprint', hash, occurrence]])}`);
    }
    return {...normalized, rowNumber, anonymous: sourceId === undefined, key, hash};
  });
  const unique = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    const previous = unique.get(row.key);
    if (previous && previous.hash !== row.hash) throw new LedgerError(`第 ${row.rowNumber} 行交易编号与其他记录内容冲突`, 409);
    unique.set(row.key, row);
  }
  const payload = {provider, accountId, incomeCategoryId, expenseCategoryId, balanceMode, anonymousMode, rows};
  return write(pool, `import:batch:${digest(sessionId)}`, 'v1/transactions/import', payload, async client => {
    const categories = await client.query<{id: string; type: number}>('SELECT id::text,type FROM money_categories WHERE id=ANY($1::bigint[])', [[incomeCategoryId, expenseCategoryId]]);
    if (!categories.rows.some(row => row.id === incomeCategoryId && row.type === 1)
      || !categories.rows.some(row => row.id === expenseCategoryId && row.type === 2)) throw new LedgerError('收入或支出分类不存在或类型不匹配');
    // All import identities include accountId. Locking that account first serializes overlapping
    // batches and follows normal transaction account locking; batch keys have a separate namespace.
    const account = await client.query('SELECT currency FROM money_accounts WHERE id=$1 FOR UPDATE', [accountId]);
    if (account.rows[0]?.currency !== 'CNY') throw new LedgerError('账户不存在或币种不支持');
    const existing = await client.query<{key: string; payload_hash: string}>('SELECT key,payload_hash FROM money_requests WHERE key=ANY($1::text[])', [[...unique.keys()]]);
    const stored = new Map(existing.rows.map(row => [row.key, row.payload_hash]));
    const pending = [...unique.values()].filter(row => {
      const hash = stored.get(row.key);
      if (hash !== undefined && hash !== row.hash) throw new LedgerError(`第 ${row.rowNumber} 行交易编号已存在但内容不同，请核对账单`, 409);
      return hash === undefined;
    });
    if (pending.length) {
      await saveBills(client, pending.map(row => ({
        billId: randomUUID(), expectedVersion: 0, action: 'save' as const, status: 'posted' as const,
        balanceMode,
        content: {
          kind: row.type === 2 ? 'income' as const : 'expense' as const,
          amountCents: row.amount, accountId, categoryId: row.type === 2 ? incomeCategoryId : expenseCategoryId,
          occurredAt: row.time * 1000, merchant: '', note: row.comment, tagIds: [],
          excludeFromStatistics: false, excludeFromBudget: false,
        },
        sources: [{ app: `import:${provider}:${accountId}`, key: row.key, capturedAt: Date.now(), ruleVersion: 'legacy-parser-v1' }],
      })));
      await client.query(`INSERT INTO money_requests(key,payload_hash,response)
        SELECT r.key,r.hash,'{"imported":true}'::jsonb
        FROM jsonb_to_recordset($1::jsonb) AS r(key text,hash text) ORDER BY r.key`, [JSON.stringify(pending)]);
      // Keep rows also satisfy future default reuploads. Aliases never create transactions
      // or contribute to balances; existing canonical occurrences remain unchanged.
      const aliases = pending.flatMap(row => {
        const key = canonicalAliases.get(row.key);
        return key ? [{key, hash: row.hash}] : [];
      });
      if (aliases.length) await client.query(`INSERT INTO money_requests(key,payload_hash,response)
        SELECT r.key,r.hash,'{"imported":true}'::jsonb
        FROM jsonb_to_recordset($1::jsonb) AS r(key text,hash text) ORDER BY r.key
        ON CONFLICT (key) DO NOTHING`, [JSON.stringify(aliases)]);
    }
    return {imported: pending.length, duplicates: rows.length - pending.length,
      anonymousDuplicates: rows.filter(row => row.anonymous && stored.has(row.key)).length,
      latestTime: Math.max(...rows.map(row => row.time))};
  });
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
      JOIN money_bills b ON b.legacy_id=t.id
      WHERE b.status='posted' AND b.content->>'kind'<>'refund'
      AND ($1::bigint IS NULL OR t.id < $1::bigint) ORDER BY t.id DESC LIMIT $2`, [cursor, count + 1]);
    const items = rows.slice(0, count);
    return {items, nextTimeSequenceId: rows.length > count ? String(items[items.length - 1].id) : null};
  }
  if (!['v1/accounts/add','v1/transaction/categories/add','v1/transactions/add','v1/transactions/import'].includes(route)) throw new LedgerError('接口不存在', 404);
  const data = object(body);
  const key = text(data.clientSessionId, 128);
  // Internal import keys must never be addressable by a normal clientSessionId.
  if (key.startsWith('import:')) throw new LedgerError('请求编号使用了保留前缀');
  if (route === 'v1/transactions/import') return importTransactions(pool, data, key);
  if (route === 'v1/accounts/add') {
    if (data.currency !== 'CNY') throw new LedgerError('首版仅支持人民币账户');
    if (data.type !== undefined && data.type !== 1) throw new LedgerError('仅支持独立账户');
    const payload = {name: text(data.name), category: integer(data.category, 1, 9), currency: 'CNY', balance: balance(data.balance)};
    return write(pool, key, route, payload, async client => {
      const saved = (await client.query(
        `INSERT INTO money_accounts(name,category,currency,balance) VALUES($1,$2,$3,$4) RETURNING ${accountColumns},active,version`,
        [payload.name,payload.category,payload.currency,payload.balance])).rows[0];
      await appendMasterChange(client, 'account', saved.id, saved);
      return saved;
    });
  }
  if (route === 'v1/transaction/categories/add') {
    if (data.parentId !== undefined && data.parentId !== '0') throw new LedgerError('首版仅支持平铺分类');
    const payload = {name: text(data.name), type: integer(data.type, 1, 3)};
    return write(pool,key,route,payload,async client => {
      const saved = (await client.query(
        `INSERT INTO money_categories(name,type) VALUES($1,$2)
         RETURNING id::text,name,type,parent_id::text AS "parentId",active,sort_order AS "sortOrder",version`,
        [payload.name,payload.type])).rows[0];
      await appendMasterChange(client, 'category', saved.id, saved);
      return saved;
    });
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
    const [bill] = await saveBills(client, [{
      billId: randomUUID(), expectedVersion: 0, action: 'save', status: 'posted',
      content: { kind: type === 2 ? 'income' : type === 3 ? 'expense' : 'transfer',
        amountCents: payload.sourceAmount, accountId: payload.sourceAccountId, categoryId: payload.categoryId,
        destinationAccountId: payload.destinationAccountId, occurredAt: payload.time * 1000,
        merchant: '', note: payload.comment, tagIds: [], excludeFromStatistics: false, excludeFromBudget: false },
    }]);
    return (await client.query(`SELECT ${transactionColumns} FROM money_transactions t JOIN money_categories c ON c.id=t.category_id WHERE t.id=$1`,[bill.legacyId])).rows[0];
  });
}
