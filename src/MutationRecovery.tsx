import { useEffect, useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { LedgerDialog } from './BillDetail';
import MutationLogin from './MutationLogin';
import { errorText, useFrozenMutation } from './bookkeeping-api';
import { readJournal, type JournalEntry } from './mutation-journal';

function RecoveryItem({ entry, settled }: { entry: JournalEntry; settled: () => void }) {
  const mutation = useFrozenMutation<unknown>(entry.path, entry);
  const body = JSON.parse(entry.bodyJson) as { entityType?: string; content?: { name?: string; merchant?: string; note?: string } };
  const noun = entry.path === 'v2/bills/submit' ? '账单' : body.entityType === 'account' ? '账户' : body.entityType === 'category' ? '分类' : '标签';
  async function confirm() {
    if (await mutation.execute()) settled();
  }
  return <section className="uncertain-panel" aria-label={`待确认${noun}`}>
    <h3>{noun} · {body.content?.name || body.content?.merchant || body.content?.note || '原操作'}</h3>
    {mutation.error && <p className="error" role="alert">{mutation.error}</p>}
    {mutation.needsLogin ? <MutationLogin busy={mutation.busy} confirm={async (username, password) => {
      if (await mutation.reauthenticate(username, password)) settled();
    }} /> : mutation.locked ? <button className="primary full" disabled={mutation.busy} onClick={() => void confirm()}>
      <RefreshCw size={16} />{mutation.busy ? '正在确认…' : '确认原请求'}
    </button> : <><p>服务器已明确拒绝本次请求，请核对账本后重新操作。</p>
      <button className="secondary" onClick={settled}><Check size={16} />已知晓</button></>}
  </section>;
}

export default function MutationRecovery({ owner, openChanged, refreshed }: {
  owner: string; openChanged: (open: boolean) => void; refreshed: () => void;
}) {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    try { setEntries(readJournal(owner)); setError(''); }
    catch (e) { setError(errorText(e)); }
  }, [owner, attempt]);
  const open = entries.length > 0 || Boolean(error);
  useEffect(() => { openChanged(open); return () => openChanged(false); }, [open, openChanged]);
  if (!open) return null;
  return <LedgerDialog title="待确认的操作" close={() => undefined} locked>
    <div className="dialog-content">
      <p>上次操作尚未确认结果。请先确认原请求，再继续记账。</p>
      {error && <><p className="error" role="alert">{error}</p>
        <button className="secondary" onClick={() => setAttempt(n => n + 1)}><RefreshCw size={16} />重新读取</button></>}
      {entries.map(entry => <RecoveryItem key={entry.operationId} entry={entry} settled={() => {
        setEntries(current => current.filter(row => row.operationId !== entry.operationId));
        refreshed();
      }} />)}
    </div>
  </LedgerDialog>;
}
