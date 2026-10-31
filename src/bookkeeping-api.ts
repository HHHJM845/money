import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { ApiError, login, request, type Snapshot } from './api';
import { createJournalEntry, removeJournalEntry, saveJournalEntry, type JournalEntry } from './mutation-journal';
import { exactCents, positiveCents, summarize } from '../shared/ledger-core';
import type { Bill, BillContent, Source } from '../server/bookkeeping';

export type { Bill, BillContent, Source };
export interface LedgerAccount {
  id: string; name: string; category: number; type: number;
  currency: string; balance: string | null;
  active: boolean; version: number;
}
export interface LedgerCategory {
  id: string; name: string; type: number; parentId: string | null; active: boolean; sortOrder: number; version: number;
}
export interface LedgerTag { id: string; name: string; active: boolean; sortOrder: number; version: number }
export interface LedgerSnapshot {
  accounts: LedgerAccount[];
  categories: LedgerCategory[];
  tags: LedgerTag[];
  bills: Bill[];
  sequence: string;
  fetchedAt: number;
}
export interface BillSubmission {
  operationId: string;
  billId: string;
  expectedVersion: number;
  action: 'save' | 'delete' | 'restore';
  status?: 'posted' | 'pending';
  content?: BillContent;
  balanceMode?: 'apply' | 'preserve';
}
export interface BillDetailResult extends Bill { sources: Source[] }
export interface BalanceHistory {
  sequence: string; billId: string | null; deltaCents: number | null; balanceAfterCents: number | null; reason: string; note: string;
}
export type MasterType = 'account' | 'category' | 'tag';
export interface MasterSubmission {
  operationId: string; entityType: MasterType; entityId: string | null; expectedVersion: number;
  action: 'save' | 'balance'; content: Record<string, unknown>;
}
export interface MasterResult {
  entityType: MasterType; entityId: string; snapshot: LedgerAccount | LedgerCategory | LedgerTag; changeSequence: string;
}

export const kindNames: Record<BillContent['kind'], string> = {
  expense: '支出', income: '收入', transfer: '转账 / 还款', refund: '退款',
};
export const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试';
export const shanghaiDate = (ms: number) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
export const shanghaiMonth = (ms: number) => shanghaiDate(ms).slice(0, 7);
export const localDateTime = (ms: number) => new Date(ms + 8 * 3600000).toISOString().slice(0, 16);
export const timestampLabel = (ms: number) => new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
export const loadLedger = () => request<LedgerSnapshot>('v2/snapshot');
export const loadBillDetail = (id: string) => request<BillDetailResult>(`v2/bills/detail?billId=${encodeURIComponent(id)}`);

export function parseLedgerAmount(raw: string): number {
  if (!/^\d{1,14}(\.\d{1,2})?$/.test(raw.trim())) throw new Error('请输入有效金额，最多保留两位小数');
  const [whole, fraction = ''] = raw.trim().split('.');
  return positiveCents(exactCents(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))));
}

export function billSummary(bills: readonly Bill[], month: string) {
  return summarize(bills.map(b => ({
    ...b.content, status: b.status, amountCents: b.content.amountCents ?? 0,
  })), month);
}

export function categoryWithin(categories: LedgerCategory[], id: string | null, parentId: string) {
  const seen = new Set<string>();
  let current = id;
  while (current && !seen.has(current)) {
    if (current === parentId) return true;
    seen.add(current);
    current = categories.find(c => c.id === current)?.parentId ?? null;
  }
  return false;
}

export function categoryLabel(categories: LedgerCategory[], id: string | null): string {
  const item = categories.find(c => c.id === id);
  if (!item) return '待选分类';
  const parent = categories.find(c => c.id === item.parentId);
  return `${parent ? `${parent.name} / ` : ''}${item.name}${item.active ? '' : '（已停用）'}`;
}

export function pendingReasons(bill: Bill) {
  const c = bill.content;
  const reasons: string[] = [];
  if (!c.amountCents) reasons.push('金额待补充');
  if (!c.accountId) reasons.push('资金账户待确认');
  if (!c.categoryId) reasons.push('分类待补充');
  if (c.kind === 'transfer' && !c.destinationAccountId) reasons.push('转入账户待确认');
  if (c.kind === 'refund' && !c.refundOfBillId) reasons.push('原支出待关联');
  if (!reasons.length) reasons.push('交易信息待核对');
  return reasons;
}

export function importSnapshot(data: LedgerSnapshot): Snapshot {
  return {
    accounts: data.accounts.filter(a => a.active),
    categories: data.categories.filter(c => c.active),
    transactions: [],
    fetchedAt: new Date(data.fetchedAt),
  };
}

// A lost response is not a rejected operation. Keep its exact payload until its result is known.
export const MutationOwnerContext = createContext<string | null>(null);
export function useFrozenMutation<T>(path: string, recovered?: JournalEntry) {
  const owner = useContext(MutationOwnerContext);
  const frozen = useRef<JournalEntry | null>(recovered ?? null);
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(Boolean(recovered));
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const locked = busy || uncertain;
  useEffect(() => {
    if (!locked) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [locked]);
  async function execute(body?: unknown): Promise<T | null> {
    if (running.current) return null;
    if (frozen.current === null && body === undefined) return null;
    running.current = true; setBusy(true); setError(''); setConflict(false); setNeedsLogin(false);
    try {
      if (!owner || (frozen.current && frozen.current.owner !== owner)) throw new Error('登录身份不匹配，请使用原账号确认请求');
      const entry = frozen.current ?? createJournalEntry(path, owner, body);
      frozen.current = entry;
      saveJournalEntry(entry);
      const result = await request<T>(entry.path, '', JSON.parse(entry.bodyJson));
      removeJournalEntry(entry);
      frozen.current = null; setUncertain(false);
      return result;
    } catch (e) {
      const unauthorized = e instanceof ApiError && e.unauthorized;
      const rejected = e instanceof ApiError && e.status !== undefined && e.status >= 400 && e.status < 500
        && ![401, 403, 408, 429].includes(e.status);
      let message = errorText(e);
      if (rejected && frozen.current) {
        try { removeJournalEntry(frozen.current); frozen.current = null; }
        catch (storageError) { message = `${message}。${errorText(storageError)}`; }
      }
      setUncertain(frozen.current !== null);
      setConflict(e instanceof ApiError && e.status === 409);
      setNeedsLogin(unauthorized);
      setError(message);
      return null;
    } finally { running.current = false; setBusy(false); }
  }
  async function reauthenticate(username: string, password: string) {
    if (username !== owner) throw new Error('请使用原账号重新登录');
    const session = await login(username, password);
    if (session.username !== owner) throw new Error('登录身份不匹配，原请求仍待确认');
    return execute();
  }
  return { execute, reauthenticate, busy, uncertain, locked, error, conflict, needsLogin };
}
