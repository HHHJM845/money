export interface SummaryRow {
  kind: 'income' | 'expense' | 'transfer' | 'refund';
  status: 'pending' | 'posted' | 'deleted';
  amountCents: number;
  occurredAt: number;
  excludeFromStatistics: boolean;
}

export function signedCents(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error('金额超出可精确计算的范围');
  return value;
}

export function positiveCents(value: number): number {
  if (signedCents(value) <= 0) throw new Error('金额必须大于零');
  return value;
}

export function exactCents(value: bigint): number {
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  if (value > limit || value < -limit) throw new Error('金额汇总超出范围');
  return Number(value);
}

export function replacementDelta(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
): Record<string, number> {
  const entries: Array<[string, number]> = [];
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const previous = Object.hasOwn(before, id) ? signedCents(before[id]) : 0;
    const next = Object.hasOwn(after, id) ? signedCents(after[id]) : 0;
    const delta = exactCents(BigInt(next) - BigInt(previous));
    if (delta !== 0) entries.push([id, delta]);
  }
  return Object.fromEntries(entries);
}

export function summarize(rows: readonly SummaryRow[], month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('月份无效');
  let income = 0n;
  let expense = 0n;
  let refund = 0n;
  for (const row of rows) {
    if (row.status !== 'posted' || row.excludeFromStatistics || row.kind === 'transfer') continue;
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
    incomeCents: exactCents(income),
    expenseCents: exactCents(expense),
    refundCents: exactCents(refund),
    netExpenseCents: exactCents(expense - refund),
    surplusCents: exactCents(income - expense + refund),
  };
}
