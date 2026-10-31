import { ApiError, request } from './api';
import type { Bill, LedgerAccount, LedgerCategory, LedgerSnapshot, LedgerTag } from './bookkeeping-api';

export interface ExpiredBill {
  billId: string; version: number; status: 'deleted'; deletedAt: number; changeSequence: string; expired: true;
}
export type LedgerChange =
  | { sequence: string; entityType: 'bill'; entityId: string; snapshot: Bill | ExpiredBill }
  | { sequence: string; entityType: 'account'; entityId: string; snapshot: LedgerAccount }
  | { sequence: string; entityType: 'category'; entityId: string; snapshot: LedgerCategory }
  | { sequence: string; entityType: 'tag'; entityId: string; snapshot: LedgerTag };
export interface ChangesPage {
  changes: LedgerChange[]; nextSequence: string; hasMore: boolean;
  accounts: LedgerAccount[]; categories: LedgerCategory[]; tags: LedgerTag[]; fetchedAt: number;
}
function sequence(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error('同步序号无效，请重试');
  return BigInt(value);
}

// Work on private copies. Neither rows, metadata nor cursor escape before the tail succeeds.
export async function pageLedgerChanges(
  original: LedgerSnapshot,
  read: (after: string) => Promise<ChangesPage>,
): Promise<LedgerSnapshot> {
  let cursor = original.sequence;
  sequence(cursor);
  const bills = new Map(original.bills.map(b => [b.billId, b]));
  const purged = new Set<string>();
  for (let pageIndex = 0; pageIndex < 2000; pageIndex++) {
    const page = await read(cursor);
    const before = sequence(cursor);
    const next = sequence(page.nextSequence);
    if (next < before || (page.hasMore && next === before)) throw new Error('同步分页未前进，请重试');
    const changes = [...page.changes].sort((a, b) => sequence(a.sequence) < sequence(b.sequence) ? -1 : sequence(a.sequence) > sequence(b.sequence) ? 1 : 0);
    for (const change of changes) {
      const commit = sequence(change.sequence);
      if (commit > next) throw new Error('同步分页序号不一致，请重试');
      if (commit <= before || change.entityType !== 'bill') continue;
      const bill = change.snapshot;
      if ('expired' in bill && bill.expired) {
        bills.delete(change.entityId);
        purged.add(change.entityId);
      } else if (!purged.has(change.entityId)) {
        const existing = bills.get(change.entityId);
        if (!existing || sequence(existing.changeSequence) <= commit) bills.set(change.entityId, bill as Bill);
      }
    }
    cursor = page.nextSequence;
    if (!page.hasMore) return {
      ...original, bills: [...bills.values()], sequence: cursor,
      accounts: page.accounts, categories: page.categories, tags: page.tags, fetchedAt: page.fetchedAt,
    };
  }
  throw new Error('同步超过当前读取上限，请重试');
}

export async function refreshLedger(original: LedgerSnapshot | null): Promise<LedgerSnapshot> {
  if (!original) return request<LedgerSnapshot>('v2/snapshot');
  try {
    return await pageLedgerChanges(original, after => request<ChangesPage>(`v2/sync/changes?after=${encodeURIComponent(after)}&count=200`));
  } catch (error) {
    if (error instanceof ApiError && error.status === 409 && error.code === 'CURSOR_INVALID') {
      return request<LedgerSnapshot>('v2/snapshot');
    }
    throw error;
  }
}
