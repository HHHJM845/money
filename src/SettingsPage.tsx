import { useEffect, useState, type FormEvent } from 'react';
import { Check, ChevronRight, CreditCard, Landmark, Moon, Pencil, Plus, SlidersHorizontal, Sun, Trash2, Wallet } from 'lucide-react';
import { request } from './api';
import { cents, money } from './finance';
import { LedgerDialog } from './BillDetail';
import MutationLogin from './MutationLogin';
import {
  categoryLabel, errorText, kindNames, loadLedger, timestampLabel, useFrozenMutation,
  type BalanceHistory, type Bill, type LedgerAccount, type LedgerCategory, type LedgerSnapshot,
  type LedgerTag, type MasterResult, type MasterSubmission, type MasterType,
} from './bookkeeping-api';

const accountKinds: Record<number, string> = { 1: '现金', 2: '银行储蓄', 3: '信用卡', 4: '电子钱包', 5: '负债', 6: '应收款', 7: '其他', 8: '储蓄', 9: '存款' };
type Master = LedgerAccount | LedgerCategory | LedgerTag;

export function balanceInput(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (!/^-?\d{1,14}(\.\d{1,2})?$/.test(value)) throw new Error('余额最多保留两位小数');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return String(cents(String(value.startsWith('-') ? -amount : amount)));
}
const balanceLabel = (balance: string | null) => balance === null ? '未设置' : `¥${money(cents(balance))}`;
const balanceValue = (balance: string | null) => balance === null ? '' : money(cents(balance)).replaceAll(',', '');

function MutationFeedback({ mutation, complete }: {
  mutation: ReturnType<typeof useFrozenMutation<MasterResult>>; complete: (result: MasterResult) => void;
}) {
  return <>
    {mutation.error && <p className="error" role="alert">{mutation.error}</p>}
    {mutation.uncertain && <div className="uncertain-panel" role="status"><p>尚未确认服务器是否保存。内容已锁定，请用原请求重试。</p>
      {mutation.needsLogin ? <MutationLogin busy={mutation.busy} confirm={async (username, password) => {
        const result = await mutation.reauthenticate(username, password); if (result) complete(result);
      }} /> : <button type="button" className="primary full" disabled={mutation.busy} onClick={async () => {
        const result = await mutation.execute(); if (result) complete(result);
      }}>{mutation.busy ? '正在确认…' : '重试确认本次操作'}</button>}
    </div>}
  </>;
}

function MasterDialog({ entityType, entity, data, close, saved }: {
  entityType: MasterType; entity: Master | null; data?: LedgerSnapshot; close: () => void; saved: (result: MasterResult) => void;
}) {
  const [base, setBase] = useState(entity);
  const [type, setType] = useState(entity && 'parentId' in entity ? entity.type : 2);
  const [error, setError] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [reading, setReading] = useState(false);
  const mutation = useFrozenMutation<MasterResult>('v2/master/submit');
  const noun = entityType === 'account' ? '账户' : entityType === 'category' ? '分类' : '标签';
  const account = entity && 'balance' in entity ? entity : null;
  const category = entity && 'parentId' in entity ? entity : null;
  const parents = (data?.categories ?? []).filter(c => c.type === type && c.parentId === null && c.id !== entity?.id && c.active);
  async function review() {
    if (reading) return;
    setReading(true); setError('');
    try {
      const latest = await loadLedger();
      const rows = entityType === 'account' ? latest.accounts : entityType === 'category' ? latest.categories : latest.tags;
      const next = rows.find(row => row.id === entity?.id);
      if (!next) throw new Error('找不到最新记录，请关闭后重新读取');
      setBase(next); setReviewed(true);
    } catch (e) { setError(errorText(e)); }
    finally { setReading(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.locked || reading || (mutation.conflict && !reviewed)) return;
    const values = new FormData(event.currentTarget);
    setError('');
    try {
      const name = String(values.get('name') ?? '').trim();
      if (!name) throw new Error(`请输入${noun}名称`);
      const content: Record<string, unknown> = { name, active: values.get('active') === 'on' };
      if (entityType === 'account') {
        Object.assign(content, { category: Number(values.get('category')), currency: 'CNY' });
        if (!base) content.balance = balanceInput(String(values.get('balance') ?? ''));
      } else {
        const sortOrder = Number(values.get('sortOrder'));
        if (!Number.isSafeInteger(sortOrder) || sortOrder < 0) throw new Error('排序必须是非负整数');
        content.sortOrder = sortOrder;
        if (entityType === 'category') Object.assign(content, { type, parentId: String(values.get('parentId') ?? '') || null });
      }
      const payload: MasterSubmission = {
        operationId: crypto.randomUUID(), entityType, entityId: base?.id ?? null,
        expectedVersion: base?.version ?? 0, action: 'save', content,
      };
      setReviewed(false);
      const result = await mutation.execute(payload); if (result) saved(result);
    } catch (e) { setError(errorText(e)); }
  }
  return <LedgerDialog title={`${entity ? '编辑' : '创建'}${noun}`} close={close} locked={mutation.locked}>
    <form className="dialog-content entry-form" onSubmit={submit}>
      <fieldset disabled={mutation.locked}>
        <label>{noun}名称<input name="name" required autoFocus maxLength={100} defaultValue={entity?.name ?? ''} /></label>
        {entityType === 'account' ? <>
          <label>账户类型<select aria-label="账户类型" name="category" defaultValue={account?.category ?? 2}>{Object.entries(accountKinds).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
          {!entity && <><label>当前余额（人民币元）<input name="balance" inputMode="text" placeholder="未设置" /></label>
            <p className="fine">余额可留空。信用卡欠款填写负数；起始余额不计入收入和支出。</p></>}
        </> : <>
          {entityType === 'category' && <>
            <label>分类类型<select aria-label="分类类型" value={type} onChange={e => setType(Number(e.target.value))}>{[1, 2, 3].map(value => <option key={value} value={value}>{value === 1 ? '收入' : value === 2 ? '支出' : '转账'}</option>)}</select></label>
            <label>上级分类<select aria-label="上级分类" name="parentId" key={type} defaultValue={category?.type === type ? category.parentId ?? '' : ''}>
              <option value="">一级分类</option>
              {category?.parentId && !parents.some(c => c.id === category.parentId) && category.type === type && <option value={category.parentId}>{categoryLabel(data?.categories ?? [], category.parentId)}</option>}
              {parents.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}
            </select></label>
          </>}
          <label>排序<input type="number" name="sortOrder" min="0" step="1" required defaultValue={entity && 'sortOrder' in entity ? entity.sortOrder : 0} /></label>
        </>}
        <label className="check-label"><input type="checkbox" name="active" defaultChecked={entity?.active ?? true} />启用{noun}</label>
      </fieldset>
      {error && <p className="error" role="alert">{error}</p>}
      {mutation.conflict && <section className="conflict-panel" role="alert"><p>服务器记录有更新，当前输入已保留。</p>
        {reviewed ? <p>服务器版本 {base?.version} · {base?.name} · {base?.active ? '已启用' : '已停用'}。核对后可保存当前输入。</p>
          : <button type="button" className="secondary" disabled={reading} onClick={() => void review()}>{reading ? '正在读取…' : '读取最新版本并保留输入'}</button>}
      </section>}
      <MutationFeedback mutation={mutation} complete={saved} />
      {!mutation.uncertain && <button className="primary full" disabled={mutation.locked || reading || (mutation.conflict && !reviewed)}>
        {entity ? <Check size={16} /> : <Plus size={16} />}{mutation.busy ? '保存中…' : `${entity ? '保存' : '创建'}${noun}`}
      </button>}
    </form>
  </LedgerDialog>;
}

export function AccountDialog({ close, saved }: { close: () => void; saved: (result: MasterResult) => void }) {
  return <MasterDialog entityType="account" entity={null} close={close} saved={saved} />;
}

function BalanceDialog({ account, close, saved }: { account: LedgerAccount; close: () => void; saved: () => void }) {
  const [base, setBase] = useState(account);
  const [enabled, setEnabled] = useState(account.balance !== null);
  const [error, setError] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [reading, setReading] = useState(false);
  const mutation = useFrozenMutation<MasterResult>('v2/master/submit');
  async function review() {
    if (reading) return;
    setReading(true); setError('');
    try {
      const next = (await loadLedger()).accounts.find(a => a.id === account.id);
      if (!next) throw new Error('账户不存在，请重新读取');
      setBase(next); setReviewed(true);
    } catch (e) { setError(errorText(e)); }
    finally { setReading(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.locked || reading || (mutation.conflict && !reviewed)) return;
    const values = new FormData(event.currentTarget);
    setError('');
    try {
      const balance = enabled ? balanceInput(String(values.get('balance') ?? '')) : null;
      if (enabled && balance === null) throw new Error('请输入余额，零余额请填 0');
      const reason = String(values.get('reason') ?? '').trim();
      if (!reason) throw new Error('请填写调整原因');
      setReviewed(false);
      if (await mutation.execute({
        operationId: crypto.randomUUID(), entityType: 'account', entityId: account.id,
        expectedVersion: base.version, action: 'balance', content: { balance, expectedBalance: base.balance, reason },
      } satisfies MasterSubmission)) saved();
    } catch (e) { setError(errorText(e)); }
  }
  return <LedgerDialog title={`余额设置 · ${account.name}`} close={close} locked={mutation.locked}>
    <form className="dialog-content entry-form" onSubmit={submit}>
      <p>当前账面余额：{balanceLabel(base.balance)}</p>
      <fieldset disabled={mutation.locked}>
        <label className="check-label"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />启用账面余额</label>
        <label>校准余额（人民币元）<input name="balance" inputMode="text" disabled={!enabled} defaultValue={balanceValue(account.balance)} required={enabled} /></label>
        <label>调整原因<input name="reason" required maxLength={500} /></label>
        <p className="fine">{enabled ? '以填写的金额作为当前余额，不重放旧账。' : '停用后显示未设置，后续账单不累计余额。'}调整会记入余额历史。</p>
      </fieldset>
      {error && <p className="error" role="alert">{error}</p>}
      {mutation.conflict && <section className="conflict-panel" role="alert"><p>账户或实际余额有更新，当前输入已保留。</p>
        {reviewed ? <p>最新余额 {balanceLabel(base.balance)} · 版本 {base.version}。核对后可保存当前输入。</p>
          : <button type="button" className="secondary" disabled={reading} onClick={() => void review()}>{reading ? '正在读取…' : '读取最新余额并保留输入'}</button>}
      </section>}
      <MutationFeedback mutation={mutation} complete={saved} />
      {!mutation.uncertain && <button className="primary full" disabled={mutation.locked || reading || (mutation.conflict && !reviewed)}><Check size={16} />{mutation.busy ? '保存中…' : '保存余额设置'}</button>}
    </form>
  </LedgerDialog>;
}

function AccountHistory({ account, sequence, close, viewBills, edit, balance }: {
  account: LedgerAccount; sequence: string; close: () => void; viewBills: () => void; edit: () => void; balance: () => void;
}) {
  const [history, setHistory] = useState<BalanceHistory[] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(''); setHistory(null);
    request<BalanceHistory[]>(`v2/accounts/history?accountId=${encodeURIComponent(account.id)}`)
      .then(next => { if (active) setHistory(next); }).catch(e => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [account.id, account.version, account.balance, sequence, attempt]);
  const reasons: Record<string, string> = { save: '记账 / 修改', delete: '删除撤销', restore: '恢复账单', balance: '余额基准调整', baseline: '余额基准调整' };
  return <LedgerDialog title={account.name} close={close}><div className="dialog-content">
    <p className="fine">{account.category === 3 ? '账面余额（负数表示欠款）' : '账面余额'} · CNY{account.active ? '' : ' · 账户已停用'}</p>
    <div className="detail-amount">{balanceLabel(account.balance)}</div>
    <div className="dialog-actions"><button className="secondary" onClick={viewBills}>查看账户账单<ChevronRight size={16} /></button>
      <button className="secondary" onClick={edit}><Pencil size={16} />编辑账户</button>
      <button className="secondary" onClick={balance}><SlidersHorizontal size={16} />余额设置</button></div>
    <h3 className="history-heading">余额变动明细</h3>
    {error ? <p className="error" role="alert">{error}<button className="text-button" onClick={() => setAttempt(n => n + 1)}>重试</button></p>
      : !history ? <p role="status">正在读取余额历史…</p>
        : !history.length ? <p className="fine">暂无余额变动明细。</p>
          : <ol className="balance-history">{[...history].reverse().map((row, index) => <li key={`${row.sequence}:${index}`}>
            <div><strong>{reasons[row.reason] ?? row.reason}</strong>{row.note && <small>{row.note}</small>}</div>
            <span className={row.deltaCents !== null && row.deltaCents > 0 ? 'income amount' : 'amount'}>{row.deltaCents === null ? '基准调整' : `${row.deltaCents > 0 ? '+' : ''}${money(row.deltaCents)}`}</span>
            <span className="fine">变动后 {row.balanceAfterCents === null ? '未设置' : `¥${money(row.balanceAfterCents)}`}</span>
          </li>)}</ol>}
  </div></LedgerDialog>;
}

type SettingsDialog = { kind: 'history' | 'balance'; id: string } | { kind: 'master'; entityType: MasterType; entity: Master | null } | null;
export default function SettingsPage({ data, username, createAccount, openBill, viewAccount, theme, setTheme, saved, mutationOpen }: {
  data: LedgerSnapshot; username: string; createAccount: () => void; openBill: (bill: Bill) => void;
  viewAccount: (id: string) => void; theme: 'light' | 'dark'; setTheme: (theme: 'light' | 'dark') => void;
  saved: () => Promise<void>; mutationOpen: (open: boolean) => void;
}) {
  const [dialog, setDialog] = useState<SettingsDialog>(null);
  const [saveError, setSaveError] = useState('');
  useEffect(() => { mutationOpen(dialog !== null); return () => mutationOpen(false); }, [dialog, mutationOpen]);
  function complete() {
    setDialog(null); setSaveError('');
    void saved().catch(e => setSaveError(`设置已保存，刷新未完成：${errorText(e)}`));
  }
  const selectedAccount = dialog && 'id' in dialog ? data.accounts.find(a => a.id === dialog.id) : null;
  const deleted = data.bills.filter(b => b.status === 'deleted').sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  return <div className="settings-page">
    {saveError && <p className="error" role="alert">{saveError}</p>}
    <section className="settings-section"><header className="section-title"><h2>账户 <span className="count">{data.accounts.length}</span></h2><button className="secondary" onClick={createAccount}><Plus size={16} />创建账户</button></header>
      <p className="fine">可选的账面余额，非银行实时余额。未设置余额的账户仍可记账。</p>
      <div className="accounts-list">{data.accounts.map(account => <button className="account-row" key={account.id} onClick={() => setDialog({ kind: 'history', id: account.id })}>
        <span className="account-symbol">{account.category === 3 ? <CreditCard size={21} /> : account.category === 4 ? <Wallet size={21} /> : <Landmark size={21} />}</span>
        <span className="account-name"><strong>{account.name}{account.active ? '' : '（已停用）'}</strong><small>{accountKinds[account.category] ?? '其他账户'} · {account.currency}</small></span>
        <strong className={`account-balance amount ${account.balance === null ? 'muted' : ''}`}>{balanceLabel(account.balance)}</strong><ChevronRight size={16} />
      </button>)}</div>
      {!data.accounts.length && <div className="empty"><Wallet size={24} /><h3>还没有资金账户</h3><p>创建现金、银行卡或钱包账户后即可入账。</p></div>}
    </section>
    <section className="settings-section"><header className="section-title"><h2>分类</h2><button className="secondary" onClick={() => setDialog({ kind: 'master', entityType: 'category', entity: null })}><Plus size={16} />创建分类</button></header>
      <div className="master-category-list">{[1, 2, 3].map(type => <section key={type}><h3>{type === 1 ? '收入' : type === 2 ? '支出' : '转账'}</h3>
        {data.categories.filter(c => c.type === type).sort((a, b) => a.sortOrder - b.sortOrder).map(c => <button className="setting-row master-row" key={c.id} onClick={() => setDialog({ kind: 'master', entityType: 'category', entity: c })}>
          <span>{categoryLabel(data.categories, c.id)}</span><Pencil size={16} />
        </button>)}
        {!data.categories.some(c => c.type === type) && <p className="fine">暂无分类</p>}
      </section>)}</div>
    </section>
    <section className="settings-section"><header className="section-title"><h2>标签</h2><button className="secondary" onClick={() => setDialog({ kind: 'master', entityType: 'tag', entity: null })}><Plus size={16} />创建标签</button></header>
      {data.tags.length ? [...data.tags].sort((a, b) => a.sortOrder - b.sortOrder).map(t => <button className="setting-row master-row" key={t.id} onClick={() => setDialog({ kind: 'master', entityType: 'tag', entity: t })}>
        <span>{t.name}{t.active ? '' : '（已停用）'}</span><Pencil size={16} /></button>) : <p className="empty-inline">暂无标签</p>}
    </section>
    <section className="settings-section"><header className="section-title"><h2>显示</h2><span className="fine">{username}</span></header>
      <div className="setting-row"><span>主题</span><div className="segmented" role="group" aria-label="主题">
        <button className={theme === 'light' ? 'selected' : ''} aria-pressed={theme === 'light'} onClick={() => setTheme('light')}><Sun size={16} />浅色</button>
        <button className={theme === 'dark' ? 'selected' : ''} aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}><Moon size={16} />深色</button>
      </div></div>
    </section>
    <section className="settings-section"><details><summary><Trash2 size={17} />回收站 <span className="count">{deleted.length}</span></summary>
      <p className="fine">删除后保留 30 天，可打开账单恢复。</p>
      {deleted.length ? deleted.map(bill => <button className="setting-row trash-row" key={bill.billId} onClick={() => openBill(bill)}>
        <span><strong>{bill.content.merchant || bill.content.note || kindNames[bill.content.kind]}</strong><small>{bill.deletedAt ? timestampLabel(bill.deletedAt) : ''} 删除</small></span>
        <span className="amount">{bill.content.amountCents == null ? '金额待确认' : `¥${money(bill.content.amountCents)}`}</span><ChevronRight size={16} />
      </button>) : <p className="empty-inline" role="status">回收站为空</p>}
    </details></section>
    {dialog?.kind === 'history' && selectedAccount && <AccountHistory key={selectedAccount.id} account={selectedAccount} sequence={data.sequence} close={() => setDialog(null)}
      viewBills={() => { viewAccount(selectedAccount.id); setDialog(null); }}
      edit={() => setDialog({ kind: 'master', entityType: 'account', entity: selectedAccount })}
      balance={() => setDialog({ kind: 'balance', id: selectedAccount.id })} />}
    {dialog?.kind === 'balance' && selectedAccount && <BalanceDialog account={selectedAccount} close={() => setDialog(null)} saved={complete} />}
    {dialog?.kind === 'master' && <MasterDialog entityType={dialog.entityType} entity={dialog.entity} data={data} close={() => setDialog(null)} saved={complete} />}
  </div>;
}
