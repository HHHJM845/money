import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Check, ChevronRight, Pencil, RotateCcw, Trash2, Undo2, X, Utensils, ShoppingBag, Car, Home, HeartPulse, GraduationCap, Gift, Wallet, Briefcase, Smartphone, PawPrint, Shirt, CircleHelp } from 'lucide-react';
import { money } from './finance';
import { amountKey } from './amount-keypad';
import { AccountDialog } from './SettingsPage';
import MutationLogin from './MutationLogin';
import {
  categoryLabel, errorText, kindNames, loadBillDetail, localDateTime, parseLedgerAmount, pendingReasons,
  timestampLabel, useFrozenMutation,
  type LedgerAccount, type Bill, type BillContent, type BillDetailResult, type BillSubmission, type LedgerSnapshot,
} from './bookkeeping-api';

export function CategoryIcon({ name }: { name: string }) {
  const Icon = /餐|食|饮|饭/.test(name) ? Utensils : /购物|消费|超市/.test(name) ? ShoppingBag
    : /交通|出行|车/.test(name) ? Car : /居|房|物业/.test(name) ? Home
    : /医|健康/.test(name) ? HeartPulse : /学|教育|书/.test(name) ? GraduationCap
    : /礼|人情/.test(name) ? Gift : /工资|工作|办公/.test(name) ? Briefcase
    : /手机|数码|通讯/.test(name) ? Smartphone : /宠物/.test(name) ? PawPrint
    : /衣|服|装/.test(name) ? Shirt : /收入|薪|转账|还款|理财/.test(name) ? Wallet : CircleHelp;
  return <Icon size={22} strokeWidth={1.5} aria-hidden="true" />;
}

export function LedgerDialog({ title, close, locked = false, children }: {
  title: string; close: () => void; locked?: boolean; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} aria-labelledby={titleId}
    onCancel={e => { e.preventDefault(); e.stopPropagation(); if (!locked) close(); }}
    onClick={e => { if (e.target === dialog.current && !locked) close(); }}>
    <header className="dialog-header"><h2 id={titleId}>{title}</h2>
      <button type="button" className="icon-button" title="关闭" aria-label="关闭" disabled={locked} onClick={close}><X size={20} /></button>
    </header>{children}
  </dialog>;
}

export default function BillDetail({ bill, refundOf, data, close, saved, openBill, openRefund }: {
  bill: Bill | null; refundOf?: Bill; data: LedgerSnapshot; close: () => void;
  saved: (bill: Bill) => void; openBill: (bill: Bill) => void; openRefund: (bill: Bill) => void;
}) {
  const [base, setBase] = useState(bill);
  const [editing, setEditing] = useState(!bill || bill.status === 'pending');
  const [kind, setKind] = useState<BillContent['kind']>(bill?.content.kind ?? (refundOf ? 'refund' : 'expense'));
  const [categoryOverride, setCategoryOverride] = useState<string | null>(null);
  const [details, setDetails] = useState<BillDetailResult | null>(null);
  const [detailError, setDetailError] = useState('');
  const [loading, setLoading] = useState(Boolean(bill));
  const [candidate, setCandidate] = useState<BillDetailResult | null>(null);
  const [formError, setFormError] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [tagIds, setTagIds] = useState<string[]>(bill?.content.tagIds ?? []);
  const [refundId, setRefundId] = useState(bill?.content.refundOfBillId ?? refundOf?.billId ?? '');
  const mutation = useFrozenMutation<Bill>('v2/bills/submit');
  const newId = useRef(crypto.randomUUID());
  const initial = bill?.content;
  const [amount, setAmount] = useState(initial?.amountCents == null ? '' : money(initial.amountCents).replaceAll(',', ''));
  const [creatingAccount, setCreatingAccount] = useState(false);
  const [createdAccounts, setCreatedAccounts] = useState<LedgerAccount[]>([]);
  const allAccounts = [...data.accounts, ...createdAccounts.filter(a => !data.accounts.some(b => b.id === a.id))];
  const [accountId, setAccountId] = useState(initial ? initial.accountId ?? '' : refundOf?.content.accountId ?? data.accounts.find(a => a.type === 1 && a.currency === 'CNY' && a.active)?.id ?? '');
  const accounts = allAccounts.filter(a => a.type === 1 && a.currency === 'CNY' && a.active);
  const accountOptions = (id: string | null | undefined) => allAccounts.filter(a => accounts.some(active => active.id === a.id) || a.id === id);
  const original = data.bills.find(b => b.billId === refundId) ?? (refundId === refundOf?.billId ? refundOf : undefined);
  const eligibleCategories = data.categories.filter(c => c.active && c.type === (kind === 'income' ? 1 : kind === 'transfer' ? 3 : 2))
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const refunds = original ? data.bills.filter(b => b.status === 'posted' && b.content.refundOfBillId === original.billId && b.billId !== bill?.billId) : [];
  const remaining = original ? (original.content.amountCents ?? 0) - refunds.reduce((total, b) => total + (b.content.amountCents ?? 0), 0) : 0;
  const related = bill ? data.bills.filter(b => b.status !== 'deleted' && (b.content.refundOfBillId === bill.billId || b.billId === bill.content.refundOfBillId)) : [];
  const accountLabel = (id: string | null | undefined) => {
    const item = allAccounts.find(a => a.id === id);
    return item ? `${item.name}${item.active ? '' : '（已停用）'}` : '待确认';
  };
  async function readDetails() {
    if (!bill) return;
    setLoading(true); setDetailError('');
    try { setDetails(await loadBillDetail(bill.billId)); }
    catch (e) { setDetailError(errorText(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    let active = true;
    if (bill) loadBillDetail(bill.billId).then(next => { if (active) setDetails(next); })
      .catch(e => { if (active) setDetailError(errorText(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [bill?.billId]);
  async function send(payload?: BillSubmission) {
    setFormError('');
    const result = await mutation.execute(payload);
    if (result) { saved(result); return; }
  }
  useEffect(() => {
    if (!mutation.conflict || !base) return;
    let active = true;
    loadBillDetail(base.billId).then(next => { if (active) setCandidate(next); })
      .catch(e => { if (active) setDetailError(`最新版本读取失败：${errorText(e)}`); });
    return () => { active = false; };
  }, [mutation.conflict, base?.billId]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.locked || candidate) return;
    const values = new FormData(event.currentTarget, (event.nativeEvent as SubmitEvent).submitter);
    try {
      const status = values.get('intent') === 'pending' ? 'pending' : 'posted';
      const amount = String(values.get('amount') ?? '').trim();
      const dateInput = String(values.get('date'));
      const occurredAt = initial && dateInput === localDateTime(initial.occurredAt) ? initial.occurredAt : new Date(`${dateInput}+08:00`).getTime();
      if (!Number.isSafeInteger(occurredAt) || occurredAt < 0 || occurredAt > Date.now() + 60000) throw new Error('请选择有效时间，不能晚于现在');
      const content: BillContent = {
        kind, amountCents: amount ? parseLedgerAmount(amount) : null,
        accountId: String(values.get('account') ?? '') || null,
        categoryId: kind === 'refund' ? original?.content.categoryId ?? null : String(values.get('category') ?? '') || null,
        destinationAccountId: kind === 'transfer' ? String(values.get('destination') ?? '') || null : null,
        refundOfBillId: kind === 'refund' ? original?.billId ?? null : null,
        occurredAt, merchant: String(values.get('merchant') ?? '').trim(), note: String(values.get('comment') ?? '').trim(),
        tagIds, excludeFromStatistics: values.get('excludeStatistics') === 'on', excludeFromBudget: values.get('excludeBudget') === 'on',
      };
      if (status === 'posted') {
        if (!content.amountCents || !content.accountId || !content.categoryId) throw new Error('正式入账需要金额、资金账户和分类；也可以先存为待确认');
        if (kind === 'transfer' && (!content.destinationAccountId || content.destinationAccountId === content.accountId)) throw new Error('请选择不同的转出和转入账户');
        if (kind === 'refund' && (!original || content.amountCents > remaining)) throw new Error(`退款需关联原支出，金额最多 ¥${money(remaining)}`);
      }
      const payload: BillSubmission = {
        operationId: crypto.randomUUID(), billId: base?.billId ?? newId.current,
        expectedVersion: base?.version ?? 0, action: 'save', status, content,
        ...(!base ? { balanceMode: 'apply' as const } : {}),
      };
      void send(payload);
    } catch (e) { setFormError(errorText(e)); }
  }
  function action(action: 'delete' | 'restore') {
    if (!base || mutation.locked || candidate) return;
    void send({ operationId: crypto.randomUUID(), billId: base.billId, expectedVersion: base.version, action });
  }
  const content = base?.content;
  const title = bill?.status === 'deleted' ? '已删除账单' : editing ? bill?.status === 'pending' ? '确认账单' : bill ? '修改账单' : refundOf ? '登记退款' : '记一笔' : '账单详情';
  return <><LedgerDialog title={title} close={close} locked={mutation.locked}>
    <div className="dialog-content">
      {bill?.status === 'pending' && <div className="pending-note"><strong>待确认</strong><p>{pendingReasons(bill).join(' · ')}</p><small>尚未计入统计或账面余额</small></div>}
      {editing ? <form className="entry-form" onSubmit={submit}>
        <fieldset disabled={mutation.locked}>
          {!refundOf && initial?.kind !== 'refund' ? <div className="segmented" role="group" aria-label="账单类型">
            {(['expense', 'income', 'transfer'] as const).map(k => <button key={k} type="button" className={kind === k ? 'selected' : ''} aria-pressed={kind === k} onClick={() => { if (k !== kind) { setKind(k); setCategoryOverride(null); } }}>{kindNames[k]}</button>)}
          </div> : <p className="refund">退款 · {original?.content.merchant || '关联原支出'}</p>}

          {kind !== 'refund' && <fieldset className="category-picker" key={kind}><legend>分类</legend>
            <div className="entry-categories">
              {[...eligibleCategories, ...(initial?.kind === kind && initial.categoryId && !eligibleCategories.some(c => c.id === initial.categoryId) ? [{ id: initial.categoryId, name: categoryLabel(data.categories, initial.categoryId) }] : [])].map(c =>
                <label className="category-choice" key={c.id}><input type="radio" name="category" value={c.id}
                  checked={c.id === (categoryOverride ?? (initial?.kind === kind ? initial.categoryId ?? '' : eligibleCategories[0]?.id ?? ''))} onChange={() => setCategoryOverride(c.id)} />
                  <span className="category-glyph" aria-hidden="true"><CategoryIcon name={c.name} /></span><span>{c.name}</span></label>)}
            </div>
          </fieldset>}
          <div className="entry-input-dock">
          <div className="entry-dock-fields">
            <div className="entry-note-amount">
              <label><span className="entry-field-caption">备注</span><textarea aria-label="备注" name="comment" rows={1} maxLength={2000} defaultValue={initial?.note ?? ''} placeholder="写点备注…" /></label>
              <label><span className="entry-field-caption">金额（元）</span><input name="amount" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" /></label>
            </div>

          {kind === 'refund' && <label>关联原支出<select aria-label="关联原支出" value={refundId} onChange={e => setRefundId(e.target.value)}><option value="">请选择原支出</option>
            {data.bills.filter(b => b.status === 'posted' && b.content.kind === 'expense').map(b => <option value={b.billId} key={b.billId}>{localDateTime(b.content.occurredAt).replace('T', ' ')} · {b.content.merchant || b.content.note || '支出'} · ¥{money(b.content.amountCents ?? 0)}</option>)}
          </select></label>}
          {kind === 'refund' && <p className="fine">原支出 ¥{money(original?.content.amountCents ?? 0)}，剩余可退 ¥{money(remaining)}。退款计入实际到账月份。</p>}
          <div className="form-grid entry-toolbar">
            <button type="button" className="create-account-shortcut" aria-label="创建账户" title="创建账户" onClick={() => setCreatingAccount(true)}>＋</button>
          <label><span className="entry-field-caption">时间（北京时间）</span><input type="datetime-local" name="date" defaultValue={localDateTime(initial?.occurredAt ?? Date.now())} required /></label>
            <label><span className="entry-field-caption">{kind === 'transfer' ? '转出账户' : kind === 'refund' ? '退款到账账户' : '账户'}</span><select aria-label={kind === 'transfer' ? '转出账户' : kind === 'refund' ? '退款到账账户' : '账户'} name="account" value={accountId} onChange={e => setAccountId(e.target.value)}>
              <option value="">暂不选择</option>{accountOptions(initial?.accountId).map(a => <option value={a.id} key={a.id}>{accountLabel(a.id)}</option>)}
            </select></label>
            {kind === 'transfer' ? <label>转入账户<select aria-label="转入账户" name="destination" defaultValue={initial?.destinationAccountId ?? accounts[1]?.id ?? ''}>
              <option value="">暂不选择</option>{accountOptions(initial?.destinationAccountId).map(a => <option value={a.id} key={a.id}>{accountLabel(a.id)}</option>)}
            </select></label> : kind === 'refund' ? <div className="field-static"><span>分类</span><strong>{categoryLabel(data.categories, original?.content.categoryId ?? null)}</strong></div> : null}
          </div>

          {kind === 'transfer' && <p className="fine">转账与信用卡还款不计入普通收入和支出。</p>}

          {!accounts.length && <p className="fine" role="status">暂无人民币账户。创建账户后可入账，余额可留空；也可先存为待确认。</p>}
          <details className="entry-optional"><summary>更多详情（商户、标签、统计与预算）</summary>
          {kind !== 'refund' && <button type="button" className="text-button" onClick={() => setCategoryOverride('')}>清除分类</button>}
          <label>商户 / 摘要<input name="merchant" maxLength={200} defaultValue={initial?.merchant ?? refundOf?.content.merchant ?? ''} /></label>

          {data.tags.some(t => t.active || initial?.tagIds.includes(t.id)) && <fieldset className="tag-options"><legend>标签</legend>{data.tags.filter(t => t.active || initial?.tagIds.includes(t.id)).map(t => <label className="check-label" key={t.id}>
            <input type="checkbox" checked={tagIds.includes(t.id)} onChange={e => setTagIds(ids => e.target.checked ? [...ids, t.id] : ids.filter(id => id !== t.id))} />{t.name}{t.active ? '' : '（已停用）'}
          </label>)}</fieldset>}
          <details className="advanced-options"><summary>统计与预算</summary>
            <label className="check-label"><input name="excludeStatistics" type="checkbox" defaultChecked={initial?.excludeFromStatistics} />不计入统计</label>
            <label className="check-label"><input name="excludeBudget" type="checkbox" defaultChecked={initial?.excludeFromBudget} />不计入预算</label>
          </details>
          </details>
          </div>
          <div className="amount-keypad" role="group" aria-label="金额键盘">
            {['1','2','3','4','5','6','7','8','9','.','0','delete'].map(key => <button type="button" key={key} aria-label={key === 'delete' ? '删除一位' : key === '.' ? '小数点' : key} onClick={() => setAmount(value => amountKey(value, key))}>{key === 'delete' ? '⌫' : key}</button>)}
          </div>
          </div>
        </fieldset>
        {formError && <p className="error" role="alert">{formError}</p>}

        <div className="dialog-actions">
          {bill?.status === 'pending' && <button type="button" className="danger text-button" disabled={mutation.locked} onClick={() => setDeleteConfirm(true)}><Trash2 size={16} />删除待确认</button>}
          <button className="primary" name="intent" value="posted" disabled={mutation.locked || Boolean(candidate)}><Check size={16} />{mutation.busy ? '保存中…' : bill?.status === 'pending' ? '确认入账' : '保存到账本'}</button>
          <button className="secondary" name="intent" value="pending" disabled={mutation.locked || Boolean(candidate)}>存为待确认</button>
        </div>
      </form> : content && <>
        <div className={`detail-amount ${content.kind}`}>{content.amountCents == null ? '金额待确认' : `¥${money(content.amountCents)}`}</div>
        <p className="detail-kind">{kindNames[content.kind]} · {base?.status === 'deleted' ? '已删除' : '已入账'}</p>
        <dl className="detail-list">
          <dt>商户 / 摘要</dt><dd>{content.merchant || '未填写'}</dd>
          <dt>发生时间</dt><dd>{timestampLabel(content.occurredAt)}（北京时间）</dd>
          <dt>资金账户</dt><dd>{accountLabel(content.accountId)}</dd>
          {content.kind === 'transfer' && <><dt>转入账户</dt><dd>{accountLabel(content.destinationAccountId)}</dd></>}
          <dt>分类</dt><dd>{categoryLabel(data.categories, content.categoryId)}</dd>
          <dt>备注</dt><dd className="preserve-lines">{content.note || '无'}</dd>
          <dt>标签</dt><dd>{content.tagIds.map(id => data.tags.find(t => t.id === id)?.name ?? id).join('、') || '无'}</dd>
          <dt>统计</dt><dd>{content.excludeFromStatistics ? '不计入统计' : content.kind === 'transfer' ? '转账不计收支' : '计入统计'}</dd>
          <dt>预算</dt><dd>{content.excludeFromBudget ? '不计入预算' : '按账单类型纳入预算口径'}</dd>
          <dt>余额处理</dt><dd>{base?.balanceMode === 'preserve' ? '补录历史，不改变余额' : '影响已设置余额的账户'}</dd>
        </dl>
        {related.length > 0 && <section className="related-bills"><h3>关联记录</h3>{related.map(item => <button className="setting-row" key={item.billId} disabled={mutation.locked} onClick={() => openBill(item)}>
          <span>{kindNames[item.content.kind]} · {item.content.merchant || '无摘要'}</span><strong>¥{money(item.content.amountCents ?? 0)}</strong><ChevronRight size={16} />
        </button>)}</section>}
        <div className="dialog-actions">
          {base?.status === 'deleted' ? <button className="primary" disabled={mutation.locked || Boolean(candidate)} onClick={() => action('restore')}><RotateCcw size={16} />恢复账单</button> : <>
            <button className="secondary" disabled={mutation.locked} onClick={() => setEditing(true)}><Pencil size={16} />修改账单</button>
            {content.kind === 'expense' && <button className="secondary" disabled={mutation.locked} onClick={() => openRefund(base!)}><Undo2 size={16} />登记退款</button>}
            <button className="danger text-button" disabled={mutation.locked} onClick={() => setDeleteConfirm(true)}><Trash2 size={16} />删除账单</button>
          </>}
        </div>
      </>}
      {deleteConfirm && <div className="delete-confirm" role="group" aria-label="删除确认"><p>移入回收站，30 天内可恢复。已应用的余额影响将撤销。</p>
        <button className="secondary" disabled={mutation.locked} onClick={() => setDeleteConfirm(false)}>取消删除</button>
        <button className="danger-button" disabled={mutation.locked || Boolean(candidate)} onClick={() => action('delete')}>确认删除</button>
      </div>}
      {mutation.error && <p className="error" role="alert">{mutation.error}</p>}
      {candidate && <section className="conflict-panel" role="alert"><h3>账单有更新，当前输入已保留</h3>
        <p>服务器版本 {candidate.version} · {candidate.status === 'deleted' ? '已删除' : kindNames[candidate.content.kind]} · {candidate.content.merchant || '无摘要'} · {candidate.content.amountCents == null ? '金额未知' : `¥${money(candidate.content.amountCents)}`}</p>
        <details><summary>查看服务器内容</summary><dl className="detail-list"><dt>账户</dt><dd>{accountLabel(candidate.content.accountId)}</dd><dt>分类</dt><dd>{categoryLabel(data.categories, candidate.content.categoryId)}</dd>
          <dt>发生时间</dt><dd>{timestampLabel(candidate.content.occurredAt)}</dd><dt>备注</dt><dd>{candidate.content.note || '无'}</dd></dl></details>
        {candidate.status !== 'deleted' && editing && <button className="secondary" onClick={() => { setBase(candidate); setCandidate(null); }}>已核对，保留输入继续编辑</button>}
        <button className="text-button" onClick={() => openBill(candidate)}>采用服务器内容</button>
      </section>}
      {mutation.uncertain && <div className="uncertain-panel" role="status"><p>尚未确认服务器是否保存。已锁定本次内容；重试会使用同一操作编号，不会重复记账。</p>
        {mutation.needsLogin ? <MutationLogin busy={mutation.busy} confirm={async (username, password) => {
          const result = await mutation.reauthenticate(username, password);
          if (result) saved(result);
        }} /> : <button className="primary full" disabled={mutation.busy} onClick={() => void send()}>{mutation.busy ? '正在确认…' : '重试确认本次操作'}</button>}
      </div>}
      {bill && <details className="source-details"><summary>来源与记录信息</summary>
        {loading ? <p role="status">正在读取来源…</p> : detailError ? <p role="alert" className="error">{detailError}<button className="text-button" onClick={() => void readDetails()}>重试读取</button></p> : details?.sources.length ? <ul className="source-list">{details.sources.map(s => <li key={`${s.app}:${s.key}`}><strong>{s.app}</strong><span>{s.key}</span><small>{timestampLabel(s.capturedAt)} · 规则 {s.ruleVersion}</small></li>)}</ul> : <p className="fine">此账单没有关联的采集来源。</p>}
        <dl className="detail-list fine"><dt>录入时间</dt><dd>{timestampLabel(bill.createdAt)}</dd><dt>修改时间</dt><dd>{timestampLabel(bill.updatedAt)}</dd>
          <dt>服务端版本</dt><dd>{base?.version}</dd><dt>账单编号</dt><dd>{bill.billId}</dd>{bill.deletedAt && <><dt>删除时间</dt><dd>{timestampLabel(bill.deletedAt)}</dd></>}
        </dl>
      </details>}
    </div>
  </LedgerDialog>{creatingAccount && <AccountDialog close={() => setCreatingAccount(false)} saved={result => {
    const account = result.snapshot;
    if (result.entityType === 'account' && 'balance' in account) {
      setCreatedAccounts(rows => [...rows, account]);
      setAccountId(result.entityId);
    }
    setCreatingAccount(false);
  }} />}</>;
}
