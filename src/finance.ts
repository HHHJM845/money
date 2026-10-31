export interface Account {
  id: string;
  name: string;
  category: number;
  type: number;
  currency: string;
  balance: string | null;
  hidden?: boolean;
  isAsset?: boolean;
  isLiability?: boolean;
}

export interface Category {
  id: string;
  name: string;
  type: number;
  subCategories?: Category[];
}

export interface Transaction {
  id: string;
  timeSequenceId: string;
  type: number;
  time: number;
  sourceAccountId: string;
  destinationAccountId?: string;
  sourceAmount: number;
  destinationAmount?: number;
  categoryId: string;
  category?: Category;
  comment: string;
  hideAmount?: boolean;
}

export function cents(value: string | number): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (!Number.isSafeInteger(parsed)) throw new Error('金额超出可精确计算的范围');
  return parsed;
}

export function sum(values: number[]): number {
  return values.reduce((total, value) => cents(total + cents(value)), 0);
}

export function parseAmount(value: string): number {
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(value.trim())) {
    throw new Error('请输入有效金额，最多保留两位小数');
  }
  const [whole, fraction = ''] = value.trim().split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (amount <= 0) throw new Error('金额需要大于 0');
  return cents(amount);
}

export function money(value: number): string {
  const exact = BigInt(cents(value));
  const absolute = exact < 0n ? -exact : exact;
  return `${exact < 0n ? '-' : ''}${(absolute / 100n).toLocaleString('zh-CN')}.${String(absolute % 100n).padStart(2, '0')}`;
}

export function monthOf(seconds: number): string {
  return new Date(seconds * 1000 + 8 * 3600000).toISOString().slice(0, 7);
}

export function dateOf(seconds: number): string {
  return new Date(seconds * 1000 + 8 * 3600000).toISOString().slice(0, 10);
}

export function previousMonth(month: string): string {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m - 2, 1)).toISOString().slice(0, 7);
}

export function leafAccounts(accounts: Account[]): Account[] {
  return accounts.filter(account => account.type === 1);
}

export function assetTotals(accounts: Account[]) {
  const balances = leafAccounts(accounts).filter((a): a is Account & { balance: string } => a.currency === 'CNY' && a.balance !== null).map(a => cents(a.balance));
  const assets = sum(balances.filter(b => b > 0));
  const liabilities = -sum(balances.filter(b => b < 0));
  return { assets, liabilities, net: cents(assets - liabilities) };
}

export function monthTransactions(transactions: Transaction[], month: string) {
  return transactions.filter(t => monthOf(t.time) === month);
}

export function cashflow(transactions: Transaction[], accounts: Account[]) {
  const cnyIds = new Set(leafAccounts(accounts).filter(a => a.currency === 'CNY').map(a => a.id));
  const eligible = transactions.filter(t => cnyIds.has(t.sourceAccountId));
  const income = sum(eligible.filter(t => t.type === 2).map(t => t.sourceAmount));
  const expense = sum(eligible.filter(t => t.type === 3).map(t => t.sourceAmount));
  return { income, expense, surplus: cents(income - expense) };
}

export function expenseGroups(transactions: Transaction[], accounts: Account[]) {
  const cnyIds = new Set(accounts.filter(a => a.currency === 'CNY').map(a => a.id));
  const groups = new Map<string, { id: string; name: string; amount: number; count: number }>();
  for (const t of transactions.filter(t => t.type === 3 && cnyIds.has(t.sourceAccountId))) {
    const group = groups.get(t.categoryId) ?? {
      id: t.categoryId, name: t.category?.name ?? '未分类', amount: 0, count: 0,
    };
    group.amount = cents(group.amount + t.sourceAmount);
    group.count++;
    groups.set(group.id, group);
  }
  return [...groups.values()].sort((a, b) => b.amount - a.amount);
}
