import type { Account, Category, Transaction } from './finance';

export class ApiError extends Error {
  constructor(message: string, public unauthorized = false, public status?: number, public code?: string) {
    super(message);
  }
}

export async function request<T>(path: string, _token = '', body?: unknown): Promise<T> {
  const [route, query] = path.split('?');
  let response: Response;
  try {
    response = await fetch(`/api/${route}.json${query ? `?${query}` : ''}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Timezone-Name': 'Asia/Shanghai',
        'X-Timezone-Offset': '480',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new ApiError('无法连接账本，请检查账本服务后重试');
  }
  let data: { success: boolean; result: T; errorMessage?: string; errorCode?: string; error?: { message?: string; code?: string } };
  try { data = await response.json(); } catch {
    throw new ApiError('账本服务返回异常，请稍后重试');
  }
  if (!response.ok || !data.success) {
    throw new ApiError(data.error?.message || data.errorMessage || `请求未完成（${response.status}）`, response.status === 401, response.status, data.errorCode ?? data.error?.code);
  }
  return data.result;
}

export interface Snapshot {
  accounts: Account[];
  transactions: Transaction[];
  categories: Category[];
  fetchedAt: Date;
}

export async function loadSnapshot(token = ''): Promise<Snapshot> {
  const [accounts, categoryMap, transactions] = await Promise.all([
    request<Account[]>('v1/accounts/list', token),
    request<Record<string, Category[]>>('v1/transaction/categories/list', token),
    allTransactions(token),
  ]);
  return {
    accounts, transactions, categories: Object.values(categoryMap).flatMap(
      parents => parents.flatMap(parent => parent.subCategories?.length ? parent.subCategories : [parent]),
    ), fetchedAt: new Date(),
  };
}

async function allTransactions(token: string) {
  const transactions: Transaction[] = [];
  let cursor: string | null = null;
  // Fetch every page before publishing totals; a partial history must never look complete.
  for (let page = 0; page < 2000; page++) {
    const params = new URLSearchParams({ count: '50', page: '1' });
    if (cursor) params.set('max_time', cursor);
    const result = await request<{ items: Transaction[]; nextTimeSequenceId: string | null }>(
      `v1/transactions/list?${params}`, token,
    );
    transactions.push(...result.items);
    if (!result.nextTimeSequenceId) {
      return [...new Map(transactions.map(t => [t.id, t])).values()].sort((a, b) => {
        if (a.time !== b.time) return b.time - a.time;
        const aId = BigInt(a.id);
        const bId = BigInt(b.id);
        return aId === bId ? 0 : aId > bId ? -1 : 1;
      });
    }
    if (cursor === result.nextTimeSequenceId) throw new ApiError('账单分页异常，未显示不完整统计');
    cursor = result.nextTimeSequenceId;
  }
  throw new ApiError('账单超过当前读取上限，未显示不完整统计');
}

export async function login(username: string, password: string) {
  return request<{ username: string }>('authorize', '', { loginName: username, password });
}

