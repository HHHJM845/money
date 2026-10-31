export const journalPrefix = 'jiancai-mutation-v1:';
export type MutationPath = 'v2/bills/submit' | 'v2/master/submit';
export interface JournalEntry {
  version: 1;
  owner: string;
  path: MutationPath;
  operationId: string;
  bodyJson: string;
  createdAt: number;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const billFields = ['operationId', 'billId', 'expectedVersion', 'action', 'status', 'content', 'balanceMode'];
const masterFields = ['operationId', 'entityType', 'entityId', 'expectedVersion', 'action', 'content'];
const billContentFields = ['kind', 'amountCents', 'accountId', 'categoryId', 'destinationAccountId',
  'refundOfBillId', 'occurredAt', 'merchant', 'note', 'tagIds', 'excludeFromBudget', 'excludeFromStatistics'];
const masterContentFields = {
  account: ['name', 'category', 'currency', 'active', 'balance', 'expectedBalance', 'reason'],
  category: ['name', 'type', 'parentId', 'active', 'sortOrder'],
  tag: ['name', 'active', 'sortOrder'],
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('待确认请求格式无效');
  return value as Record<string, unknown>;
}
function allowed(value: Record<string, unknown>, fields: string[]) {
  if (Object.keys(value).some(key => !fields.includes(key))) throw new Error('请求包含不支持持久化的字段');
}
function validateBody(path: string, value: unknown): string {
  const body = object(value);
  if (typeof body.operationId !== 'string' || !uuid.test(body.operationId)) throw new Error('请求编号无效');
  // Only ledger payloads may enter storage. Authentication routes and credentials are excluded.
  if (path === 'v2/bills/submit') {
    allowed(body, billFields);
    if (body.content !== undefined) allowed(object(body.content), billContentFields);
  } else if (path === 'v2/master/submit') {
    allowed(body, masterFields);
    const type = body.entityType;
    if (type !== 'account' && type !== 'category' && type !== 'tag') throw new Error('主数据类型无效');
    allowed(object(body.content), masterContentFields[type]);
  } else throw new Error('该接口不支持持久化重试');
  return body.operationId;
}
function ownerPrefix(owner: string) {
  if (!owner.trim()) throw new Error('缺少登录身份，无法保存待确认请求');
  return `${journalPrefix}${encodeURIComponent(owner)}:`;
}
function key(entry: JournalEntry) { return `${ownerPrefix(entry.owner)}${entry.operationId}`; }

export function createJournalEntry(path: string, owner: string, body: unknown): JournalEntry {
  ownerPrefix(owner);
  const bodyJson = JSON.stringify(body);
  const operationId = validateBody(path, JSON.parse(bodyJson));
  return { version: 1, owner, path: path as MutationPath, operationId, bodyJson, createdAt: Date.now() };
}

export function saveJournalEntry(entry: JournalEntry, storage?: Storage): void {
  try {
    const store = storage ?? window.localStorage;
    const serialized = JSON.stringify(entry);
    const previous = store.getItem(key(entry));
    if (previous !== null && previous !== serialized) throw new Error('请求编号已用于其他内容');
    store.setItem(key(entry), serialized);
    if (store.getItem(key(entry)) !== serialized) throw new Error('写入未完成');
  } catch {
    throw new Error('无法保存待确认请求，本次未发送。请允许浏览器本地存储后重试。');
  }
}

export function removeJournalEntry(entry: JournalEntry, storage?: Storage): void {
  try {
    const store = storage ?? window.localStorage;
    const previous = store.getItem(key(entry));
    if (previous !== null && previous !== JSON.stringify(entry)) throw new Error('请求记录不匹配');
    store.removeItem(key(entry));
    if (store.getItem(key(entry)) !== null) throw new Error('清理未完成');
  } catch {
    throw new Error('无法清理待确认请求。请恢复本地存储后，用原请求再次确认。');
  }
}

export function readJournal(owner: string, storage?: Storage): JournalEntry[] {
  try {
    const store = storage ?? window.localStorage;
    const prefix = ownerPrefix(owner);
    const entries: JournalEntry[] = [];
    for (let index = 0; index < store.length; index++) {
      const storageKey = store.key(index);
      if (!storageKey?.startsWith(prefix)) continue;
      const raw = store.getItem(storageKey);
      if (raw === null) continue;
      const entry = object(JSON.parse(raw));
      if (entry.version !== 1 || entry.owner !== owner || typeof entry.bodyJson !== 'string'
        || typeof entry.createdAt !== 'number' || !Number.isSafeInteger(entry.createdAt)) throw new Error('记录格式无效');
      const operationId = validateBody(String(entry.path), JSON.parse(entry.bodyJson));
      if (entry.operationId !== operationId || storageKey !== `${prefix}${operationId}`) throw new Error('请求编号不匹配');
      entries.push(entry as unknown as JournalEntry);
    }
    return entries.sort((a, b) => a.createdAt - b.createdAt || a.operationId.localeCompare(b.operationId));
  } catch {
    throw new Error('无法读取待确认请求。请恢复浏览器本地存储后重试，避免重复提交。');
  }
}
