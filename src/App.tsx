import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft, ArrowRight, BookOpen,
  ChartNoAxesCombined, Check, ChevronLeft, ChevronRight, CircleAlert, Download,
  LogOut, Plus, RefreshCw, Search, Settings, ShieldCheck, Upload,
} from 'lucide-react';
import { ApiError, login, request } from './api';
import ImportDialog from './ImportDialog';
import BillDetail, { CategoryIcon } from './BillDetail';
import PendingList from './PendingList';
import MutationRecovery from './MutationRecovery';
import SettingsPage, { AccountDialog } from './SettingsPage';
import { refreshLedger } from './ledger-sync';
import { money, previousMonth } from './finance';
import {
  billSummary, categoryLabel, categoryWithin, errorText, importSnapshot, kindNames, MutationOwnerContext,
  shanghaiDate, shanghaiMonth, timestampLabel,
  type Bill, type LedgerSnapshot,
} from './bookkeeping-api';

type View = 'bills' | 'statistics' | 'settings';
type Modal = { kind: 'bill'; bill: Bill | null; refundOf?: Bill; key: number } | { kind: 'account' | 'import' } | null;
interface Session { username: string }
const navigation = [
  { id: 'bills' as const, title: '账单', icon: BookOpen },
  { id: 'statistics' as const, title: '统计', icon: ChartNoAxesCombined },
  { id: 'settings' as const, title: '我的', icon: Settings },
];

function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    try { onLogin(await login(String(form.get('username')), String(form.get('password')))); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  return <main className="login-screen"><a className="login-brand" href="#login"><BookOpen size={27} /><span>见财<span className="brand-dot">.</span></span></a>
    <form className="login-form" onSubmit={submit}><h1>登录账本</h1><p className="muted">我的日常收支</p>
      <label>账号<input name="username" autoComplete="username" required disabled={busy} /></label>
      <label>密码<input name="password" type="password" autoComplete="current-password" required disabled={busy} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary full" disabled={busy}>{busy ? '正在连接账本…' : '登录账本'}<ArrowRight size={17} /></button>
    </form><footer><ShieldCheck size={14} />个人账本</footer>
  </main>;
}

function Summary({ data, month }: { data: LedgerSnapshot; month: string }) {
  try {
    const flow = billSummary(data.bills, month);
    return <section className="cashflow-summary" aria-label="本月收支">
      <div className="summary-primary"><div><span>净支出</span><strong className="amount">¥{money(flow.netExpenseCents)}</strong></div>
        <div><span>收入</span><strong className="income amount">¥{money(flow.incomeCents)}</strong></div>
        <div><span>结余</span><strong className="amount">¥{money(flow.surplusCents)}</strong></div></div>
      <details className="summary-breakdown"><summary>收入、支出与退款</summary><dl>
        <div><dt>原始支出</dt><dd className="amount">¥{money(flow.expenseCents)}</dd></div>
        <div><dt>退款</dt><dd className="refund amount">¥{money(flow.refundCents)}</dd></div>
      </dl></details>
    </section>;
  } catch (e) { return <p className="error" role="alert">统计暂不可用：{errorText(e)}</p>; }
}

function Statistics({ data, month, viewBills }: { data: LedgerSnapshot; month: string; viewBills: (category?: string, day?: string) => void }) {
  try {
    const categories = data.categories.filter(c => c.type === 2 && !c.parentId);
    const rows = categories.map(category => ({
      category,
      summary: billSummary(data.bills.filter(b => categoryWithin(data.categories, b.content.categoryId, category.id)), month),
    })).filter(r => r.summary.expenseCents || r.summary.refundCents).sort((a, b) => b.summary.netExpenseCents - a.summary.netExpenseCents);
    const max = Math.max(1, ...rows.map(r => Math.abs(r.summary.netExpenseCents)));
    const days = [...new Set(data.bills.filter(b => b.status === 'posted' && shanghaiMonth(b.content.occurredAt) === month && b.content.kind !== 'transfer' && !b.content.excludeFromStatistics).map(b => shanghaiDate(b.content.occurredAt)))].sort();
    const daily = days.map(day => ({ day, summary: billSummary(data.bills.filter(b => shanghaiDate(b.content.occurredAt) === day), month) }));
    return <div className="statistics-page"><section className="statistics-section">
      <header className="section-title"><h2>分类净支出</h2><button className="text-button" onClick={() => viewBills()}>查看账单<ArrowRight size={16} /></button></header>
      {rows.length ? <div className="category-list">{rows.map(({ category, summary }, index) => <div className="category-group" key={category.id}>
        <button className="category-row" onClick={() => viewBills(category.id)}><span className="category-rank">{String(index + 1).padStart(2, '0')}</span><strong>{category.name}</strong>
          <span className="category-track" aria-hidden="true"><span style={{ width: `${Math.abs(summary.netExpenseCents) / max * 100}%` }} /></span><span className="amount">¥{money(summary.netExpenseCents)}</span><ChevronRight size={15} /></button>
        <details><summary className="fine">支出 ¥{money(summary.expenseCents)} · 退款 ¥{money(summary.refundCents)}</summary>
          {data.categories.filter(c => c.parentId === category.id).map(child => {
            const sub = billSummary(data.bills.filter(b => categoryWithin(data.categories, b.content.categoryId, child.id)), month);
            return <button className="setting-row" key={child.id} onClick={() => viewBills(child.id)}><span>{child.name}</span><span className="amount">¥{money(sub.netExpenseCents)}</span><ChevronRight size={15} /></button>;
          })}
        </details>
      </div>)}</div> : <div className="empty"><ChartNoAxesCombined size={26} /><h3>本月暂无分类收支</h3><p>已入账的支出与退款会显示在这里。</p></div>}
    </section><section className="statistics-section"><header className="section-title"><h2>每日收支</h2></header>
      {daily.length ? <div className="daily-statistics"><div className="daily-statistics-header"><span>发生日期</span><span>收入</span><span>净支出</span></div>
        {daily.map(({ day, summary }) => <button key={day} onClick={() => viewBills(undefined, day)}><time>{day.slice(5)}</time><span className="income amount">{money(summary.incomeCents)}</span><span className="amount">{money(summary.netExpenseCents)}</span></button>)}
      </div> : <p className="empty-inline">本月暂无统计记录</p>}
    </section><p className="data-footnote">按北京时间归属月份。退款冲减到账月净支出；转账、待确认、已删除及排除统计的记录不计入。结余为收入减净支出。</p></div>;
  } catch (e) { return <p className="error" role="alert">统计暂不可用：{errorText(e)}</p>; }
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authState, setAuthState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [authError, setAuthError] = useState('');
  const [data, setData] = useState<LedgerSnapshot | null>(null);
  const [view, setView] = useState<View>('bills');
  const [month, setMonth] = useState(shanghaiMonth(Date.now()));
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const [pendingView, setPendingView] = useState(false);
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');
  const [account, setAccount] = useState('');
  const [category, setCategory] = useState('');
  const [tag, setTag] = useState('');
  const [day, setDay] = useState('');
  const [limit, setLimit] = useState(50);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const stored = localStorage.getItem('jiancai-theme');
      if (stored === 'light' || stored === 'dark') return stored;
    } catch { /* The selected theme still works when storage is unavailable. */ }
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  const generation = useRef(0);
  const dataRef = useRef<LedgerSnapshot | null>(null);
  const refreshing = useRef<Promise<void> | null>(null);
  const modalKey = useRef(0);
  const modalOpen = useRef(false);
  const settingsModalOpen = useRef(false);
  const recoveryOpen = useRef(false);
  modalOpen.current = modal !== null || settingsModalOpen.current || recoveryOpen.current;
  const trackSettingsModal = useCallback((open: boolean) => {
    settingsModalOpen.current = open;
    modalOpen.current = open || modal !== null || recoveryOpen.current;
  }, [modal]);
  const trackRecovery = useCallback((open: boolean) => {
    recoveryOpen.current = open;
    modalOpen.current = open || modal !== null || settingsModalOpen.current;
  }, [modal]);
  const clearSession = useCallback(() => {
    generation.current++;
    dataRef.current = null;
    settingsModalOpen.current = false;
    setSession(null); setData(null); setModal(null); setError(''); setNotice('');
    setBusy(false);
    setView('bills'); setPendingView(false); setQuery(''); setType('all'); setAccount(''); setCategory(''); setTag(''); setDay('');
  }, []);
  async function checkSession() {
    setAuthState('loading'); setAuthError('');
    try { setSession(await request<Session>('session')); setAuthState('ready'); }
    catch (e) {
      if (e instanceof ApiError && e.unauthorized) { clearSession(); setAuthState('ready'); }
      else { setAuthError(errorText(e)); setAuthState('error'); }
    }
  }
  const refresh = useCallback(async (propagate = false) => {
    if (!session) return;
    while (refreshing.current) {
      if (!propagate) return;
      await refreshing.current.catch(() => undefined);
    }
    const current = generation.current;
    const job = (async () => {
      setBusy(true);
      try {
        const next = await refreshLedger(dataRef.current);
        if (current === generation.current) { dataRef.current = next; setData(next); setError(''); }
      } catch (e) {
        if (current === generation.current) {
          // Do not unmount an unresolved write if a background read loses its session.
          if (e instanceof ApiError && e.unauthorized && !modalOpen.current) clearSession();
          else setError(errorText(e));
        }
        throw e;
      } finally { if (current === generation.current) setBusy(false); }
    })();
    refreshing.current = job;
    try { await job; }
    catch (e) { if (propagate) throw e; }
    finally { if (refreshing.current === job) refreshing.current = null; }
  }, [session, clearSession]);
  useEffect(() => { void checkSession(); }, []);
  useEffect(() => {
    if (!session) return;
    void refresh();
    const visibleRefresh = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', visibleRefresh);
    document.addEventListener('visibilitychange', visibleRefresh);
    const timer = window.setInterval(visibleRefresh, 5000);
    return () => { window.removeEventListener('focus', visibleRefresh); document.removeEventListener('visibilitychange', visibleRefresh); clearInterval(timer); };
  }, [session, refresh]);
  useEffect(() => { setLimit(50); }, [month, query, type, account, category, tag, day]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('jiancai-theme', theme); } catch { /* Theme is applied for this session. */ }
  }, [theme]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true); setLogoutError('');
    try { await request('logout', '', {}); clearSession(); }
    catch (e) { setLogoutError(`退出未完成：${errorText(e)}`); }
    finally { setLoggingOut(false); }
  }
  function openBill(bill: Bill | null, refundOf?: Bill) {
    setModal({ kind: 'bill', bill, refundOf, key: ++modalKey.current });
  }
  function resetFilters() { setQuery(''); setType('all'); setAccount(''); setCategory(''); setTag(''); setDay(''); }
  function navigate(next: View) { setView(next); setPendingView(false); resetFilters(); }
  function viewBills(categoryId = '', date = '', accountId = '') {
    resetFilters(); setView('bills'); setPendingView(false); setCategory(categoryId); setDay(date); setAccount(accountId);
  }
  function savedBill(bill: Bill) {
    generation.current++;
    let latest = bill;
    let alreadyCleared = false;
    if (dataRef.current) {
      const existing = dataRef.current.bills.find(b => b.billId === bill.billId);
      if (existing && BigInt(existing.changeSequence) > BigInt(bill.changeSequence)) latest = existing;
      else if (!existing && BigInt(bill.changeSequence) <= BigInt(dataRef.current.sequence)) alreadyCleared = true;
      else {
        dataRef.current = { ...dataRef.current, bills: [...dataRef.current.bills.filter(b => b.billId !== bill.billId), bill] };
        setData(dataRef.current);
      }
    }
    setModal(null);
    setView('bills');
    setNotice(alreadyCleared ? '原请求已确认，账单已过期清理' : latest !== bill ? '原请求已确认，账单已有其他设备更新' : bill.status === 'deleted' ? '账单已移入回收站' : bill.status === 'pending' ? '已存为待确认' : '账单已保存');
    if (!alreadyCleared && latest.status === 'posted') { setMonth(shanghaiMonth(latest.content.occurredAt)); setPendingView(false); }
    if (!alreadyCleared && latest.status === 'pending') setPendingView(true);
    void refresh(true).catch(() => undefined);
  }
  if (authState !== 'ready') return <main className="login-screen"><div className="login-form"><h1>见财</h1>
    {authState === 'loading' ? <p role="status">正在确认登录状态…</p> : <><p className="error" role="alert">{authError}</p><button className="primary" onClick={() => void checkSession()}><RefreshCw size={16} />重试</button></>}
  </div></main>;
  if (!session) return <Login onLogin={next => { setSession(next); setAuthState('ready'); }} />;
  const accounts = data?.accounts ?? [];
  const bills = data?.bills ?? [];
  const pending = bills.filter(b => b.status === 'pending').sort((a, b) => b.content.occurredAt - a.content.occurredAt);
  const accountName = (id: string | null | undefined) => accounts.find(a => a.id === id)?.name ?? '待确认账户';
  const monthly = bills.filter(b => b.status === 'posted' && shanghaiMonth(b.content.occurredAt) === month);
  const filtered = monthly.filter(b => {
    const c = b.content;
    const searchable = `${c.merchant} ${c.note} ${categoryLabel(data?.categories ?? [], c.categoryId)} ${accountName(c.accountId)}`.toLowerCase();
    return (type === 'all' || c.kind === type)
      && (!account || c.accountId === account || c.destinationAccountId === account)
      && (!category || categoryWithin(data?.categories ?? [], c.categoryId, category))
      && (!tag || c.tagIds.includes(tag))
      && (!day || shanghaiDate(c.occurredAt) === day)
      && searchable.includes(query.trim().toLowerCase());
  }).sort((a, b) => b.content.occurredAt - a.content.occurredAt || b.billId.localeCompare(a.billId));
  const days = new Map<string, Bill[]>();
  for (const bill of filtered.slice(0, limit)) {
    const date = shanghaiDate(bill.content.occurredAt);
    const rows = days.get(date) ?? []; rows.push(bill); days.set(date, rows);
  }
  function exportCsv() {
    const rows = [['日期（北京时间）', '类型', '商户', '账户', '转入账户', '分类', '金额（元）', '备注', '不计统计', '账单编号'], ...filtered.map(b => [
      timestampLabel(b.content.occurredAt), kindNames[b.content.kind], b.content.merchant, accountName(b.content.accountId),
      b.content.destinationAccountId ? accountName(b.content.destinationAccountId) : '', categoryLabel(data?.categories ?? [], b.content.categoryId),
      money(b.content.amountCents ?? 0).replaceAll(',', ''), b.content.note, b.content.excludeFromStatistics ? '是' : '否', b.billId,
    ])];
    const csv = '\uFEFF' + rows.map(row => row.map(cell => {
      const safe = /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell;
      return `"${safe.replaceAll('"', '""')}"`;
    }).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `见财-账单-${month}.csv`; link.click(); URL.revokeObjectURL(url);
    setNotice(`已导出 ${filtered.length} 笔 CSV；CSV 不包含完整备份数据`);
  }
  return <MutationOwnerContext.Provider value={session.username}><div className="app-shell"><aside className="sidebar">
    <a className="brand" href="#" onClick={e => { e.preventDefault(); navigate('bills'); }}><BookOpen size={25} /><span>见财<span className="brand-dot">.</span></span></a>
    <nav aria-label="主导航">{navigation.map(item => <button className={`nav-item ${view === item.id ? 'active' : ''}`} key={item.id} aria-current={view === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><item.icon size={19} />{item.title}</button>)}</nav>
    <div className="sidebar-bottom"><span className="fine">个人账本</span><strong>{session.username}</strong><button className="nav-item" onClick={() => void logout()} disabled={loggingOut}><LogOut size={17} />{loggingOut ? '正在退出…' : '退出登录'}</button></div>
  </aside><div className="main-shell">
    <header className="topbar"><span>个人账本 <span className="muted">/ {navigation.find(n => n.id === view)?.title}</span></span>
      <div className="topbar-right"><span className="refresh-status">{data ? `读取于 ${new Date(data.fetchedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : busy ? '读取中…' : '尚未读取'}</span>
        <button className="icon-button" title="刷新账本" aria-label="刷新账本" disabled={busy} onClick={() => void refresh()}><RefreshCw size={18} className={busy ? 'spinning' : ''} /></button>
        <button className="icon-button mobile-logout" title="退出登录" aria-label="退出登录" disabled={loggingOut} onClick={() => void logout()}><LogOut size={18} /></button>
      </div>
    </header><main className="workspace">
      <header className="page-heading"><div><span className="eyebrow">我的日常账本</span><h1>{view === 'bills' ? pendingView ? '待确认' : '账单' : view === 'statistics' ? '收支统计' : '我的'}</h1></div>
        <div className="heading-actions"><button className="secondary" disabled={!data} onClick={() => setModal({ kind: 'import' })}><Upload size={16} /><span>导入账单</span></button>
          <button className="primary entry-fab" disabled={!data} onClick={() => openBill(null)}><Plus size={17} />记一笔</button></div>
      </header>
      {logoutError && <div className="error-banner" role="alert"><CircleAlert size={18} /><span>{logoutError}</span><button onClick={() => void logout()}>重试退出</button></div>}
      {error && <div className="error-banner" role="alert"><CircleAlert size={18} /><span>{error}{data ? '。正在显示上次读取的数据。' : ''}</span><button onClick={() => void refresh()}>重试</button></div>}
      {!data ? <div className="loading-state" role="status">{busy ? <RefreshCw className="spinning" size={22} /> : <CircleAlert size={22} />}<p>{busy ? '正在读取账单与账户…' : '账本尚未载入'}</p></div> : <>
        {view !== 'settings' && !pendingView && <><div className="period-bar"><div className="month-control">
          <button className="icon-button" aria-label="上个月" title="上个月" onClick={() => { setMonth(previousMonth(month)); setDay(''); }}><ChevronLeft size={18} /></button>
          <label><span className="sr-only">统计月份</span><input type="month" value={month} onChange={e => { if (/^\d{4}-(0[1-9]|1[0-2])$/.test(e.target.value)) { setMonth(e.target.value); setDay(''); } }} /></label>
          <button className="icon-button" aria-label="下个月" title="下个月" onClick={() => { const [y, m] = month.split('-').map(Number); setMonth(new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7)); setDay(''); }}><ChevronRight size={18} /></button>
        </div><span className="fine">人民币 · 北京时间</span></div><Summary data={data} month={month} /></>}
        {view === 'bills' && <>
          {pendingView ? <><button className="text-button back-button" onClick={() => setPendingView(false)}><ArrowLeft size={16} />返回账单</button><PendingList bills={pending} open={openBill} /></> : <>
            <button className={`pending-entry ${pending.length ? 'has-pending' : ''}`} onClick={() => setPendingView(true)}><CircleAlert size={19} /><span><strong>待确认 <span className="count">{pending.length}</span></strong><small>{pending.length ? '补充或核对后入账' : '暂无需要核对的交易'}</small></span><ChevronRight size={18} /></button>
            <div className="ledger-tools"><div className="segmented" role="group" aria-label="流水类型">{[['all', '全部'], ['expense', '支出'], ['income', '收入'], ['refund', '退款'], ['transfer', '转账']].map(([value, title]) => <button key={value} className={type === value ? 'selected' : ''} aria-pressed={type === value} onClick={() => setType(value)}>{title}</button>)}</div>
              <label className="search-field"><Search size={16} /><input aria-label="搜索账单" placeholder="搜索商户、备注" value={query} onChange={e => setQuery(e.target.value)} /></label>
              <button className="icon-button" title="导出 CSV（非完整备份）" aria-label="导出 CSV（非完整备份）" onClick={exportCsv}><Download size={18} /></button>
            </div>
            <div className="account-filter"><select aria-label="账户筛选" value={account} onChange={e => setAccount(e.target.value)}><option value="">所有账户</option>{accounts.map(a => <option value={a.id} key={a.id}>{a.name}</option>)}</select>
              <select aria-label="分类筛选" value={category} onChange={e => setCategory(e.target.value)}><option value="">所有分类</option>{data.categories.map(c => <option value={c.id} key={c.id}>{categoryLabel(data.categories, c.id)}</option>)}</select>
              {data.tags.length > 0 && <select aria-label="标签筛选" value={tag} onChange={e => setTag(e.target.value)}><option value="">所有标签</option>{data.tags.map(t => <option value={t.id} key={t.id}>{t.name}</option>)}</select>}
              <span className="fine">{filtered.length} 笔</span>
              {(query || type !== 'all' || account || category || tag || day) && <button className="text-button" onClick={resetFilters}>清除筛选{day ? ` · ${day}` : ''}</button>}
            </div>
            {filtered.length ? <div className="daily-ledger">{[...days].map(([date, entries]) => <section className="ledger-day" key={date} aria-label={`${date}流水`}>
              <header className="ledger-day-heading"><h2><time dateTime={date}>{date.slice(5).replace('-', '月')}日</time></h2></header>
              {entries.map(b => {
                const c = b.content;

                return <button className="transaction-row" key={b.billId} onClick={() => openBill(b)}>
                  <span className={`transaction-icon ${c.kind}`}><CategoryIcon name={categoryLabel(data.categories, c.categoryId)} /></span>
                  <span className="transaction-description"><strong>{categoryLabel(data.categories, c.categoryId)}</strong>{(c.merchant || c.note) && <small className="merchant-summary">{c.merchant || c.note}</small>}<small>
                    <span className={`kind-label ${c.kind}`}>{kindNames[c.kind]}</span> · {accountName(c.accountId)}{c.kind === 'transfer' ? ` → ${accountName(c.destinationAccountId)}` : ''}{c.excludeFromStatistics ? ' · 不计统计' : ''}
                  </small></span>
                  <span className={`row-amount amount ${c.kind}`}>{c.kind === 'income' || c.kind === 'refund' ? '+' : c.kind === 'expense' ? '−' : ''}¥{money(c.amountCents ?? 0)}</span><ChevronRight size={15} />
                </button>;
              })}
            </section>)}</div> : <div className="empty" role="status"><BookOpen size={26} /><h2>{monthly.length ? '没有符合条件的账单' : '这个月还没有账单'}</h2><p>{monthly.length ? '可以调整筛选条件再查看。' : '记下第一笔日常收支，或导入历史账单。'}</p></div>}
            {filtered.length > limit && <button className="secondary load-more" onClick={() => setLimit(n => n + 50)}>再显示 50 笔</button>}
            <p className="data-footnote">上方为整月汇总，筛选作用于明细与 CSV 导出。待确认不计入统计。</p>
          </>}
        </>}
        {view === 'statistics' && <Statistics data={data} month={month} viewBills={viewBills} />}
        {view === 'settings' && <SettingsPage data={data} username={session.username} createAccount={() => setModal({ kind: 'account' })} openBill={openBill}
          mutationOpen={trackSettingsModal} saved={async () => { generation.current++; await refresh(true); setNotice('设置已保存'); }}
          viewAccount={id => viewBills('', '', id)} theme={theme} setTheme={setTheme} />}
        <footer className="workspace-footer"><span>{busy ? '正在刷新…' : data ? `更新于 ${timestampLabel(data.fetchedAt)}` : ''}</span><span>见财 · 日常收支</span></footer>
      </>}
    </main>
  </div><nav className="mobile-nav" aria-label="手机导航">{navigation.map(item => <button key={item.id} className={view === item.id ? 'active' : ''} aria-current={view === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><item.icon size={20} /><span>{item.title}</span></button>)}</nav>
    {notice && <div className="toast" role="status"><Check size={17} /><span>{notice}</span></div>}
    {modal?.kind === 'bill' && data && <BillDetail key={modal.key} bill={modal.bill} refundOf={modal.refundOf} data={data} close={() => setModal(null)} saved={savedBill} openBill={b => openBill(b)} openRefund={b => openBill(null, b)} />}
    {modal?.kind === 'account' && <AccountDialog close={() => setModal(null)} saved={() => { generation.current++; setModal(null); setNotice('账户已创建'); void refresh(true).catch(() => undefined); }} />}
    {modal?.kind === 'import' && data && <ImportDialog data={importSnapshot(data)} close={() => { setModal(null); void refresh(); }} createAccount={() => setModal({ kind: 'account' })}
      saved={async result => { await refresh(true); setMonth(shanghaiMonth(result.latestTime * 1000)); navigate('bills'); setModal(null); setNotice(`已新增 ${result.imported} 笔，跳过重复 ${result.duplicates} 笔`); }} />}
    <MutationRecovery owner={session.username} openChanged={trackRecovery} refreshed={() => {
      generation.current++;
      void refresh(true).catch(() => undefined);
    }} />
  </div></MutationOwnerContext.Provider>;
}
