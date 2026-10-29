import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowDownLeft, ArrowRight, ArrowUpRight, ArrowLeftRight, BookOpen,
  ChartNoAxesCombined, Check, ChevronLeft, ChevronRight, CircleAlert,
  CreditCard, Download, Eye, EyeOff, Landmark,
  ListFilter, LogOut, Plus, RefreshCw, Search, ShieldCheck, Upload, Wallet, X,
} from 'lucide-react';
import { ApiError, loadSnapshot, login, request, type Snapshot } from './api';
import ImportDialog from './ImportDialog';
import {
  assetTotals, cashflow, cents, dateOf, expenseGroups, leafAccounts, money,
  monthOf, monthTransactions, parseAmount, previousMonth, type Transaction,
} from './finance';

type View = 'overview' | 'cashflow' | 'assets';
type Modal = 'entry' | 'account' | 'import' | null;
interface Session { username: string }
const nav = [
  { id: 'cashflow' as const, title: '账本', icon: BookOpen },
  { id: 'overview' as const, title: '统计', icon: ChartNoAxesCombined },
  { id: 'assets' as const, title: '账户', icon: Wallet },
];
const typeNames: Record<number, string> = { 1: '余额调整', 2: '收入', 3: '支出', 4: '转账' };
const accountNames: Record<number, string> = {
  1: '现金', 2: '银行储蓄', 3: '信用卡', 4: '电子钱包', 5: '负债',
  6: '应收款', 7: '投资账户', 8: '储蓄', 9: '存款',
};
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试';

function IconButton({ label, onClick, children, disabled = false }: {
  label: string; onClick: () => void; children: ReactNode; disabled?: boolean;
}) {
  return <button className="icon-button" title={label} aria-label={label} onClick={onClick} disabled={disabled}>{children}</button>;
}
function Amount({ value, signed = false }: { value: number; signed?: boolean }) {
  return <span className="amount">{signed && value > 0 ? '+' : ''}{value < 0 ? '−' : ''}¥{money(Math.abs(value))}</span>;
}
function Dialog({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} onCancel={event => { event.preventDefault(); close(); }} onClick={e => { if (e.target === dialog.current) close(); }}>
    <div className="dialog-header"><h2>{title}</h2><IconButton label="关闭" onClick={close}><X size={20} /></IconButton></div>
    {children}
  </dialog>;
}
function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <div className="empty"><ChartNoAxesCombined size={28} strokeWidth={1.4} /><h3>{title}</h3><p>{children}</p></div>;
}

function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    try {
      const username = String(form.get('username'));
      const result = await login(username, String(form.get('password')));
      onLogin(result);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <main className="login-screen">
    <div className="login-brand"><div className="brand-mark"><ChartNoAxesCombined size={24} /></div><span>见财<span className="brand-dot">.</span></span></div>
    <form className="login-form" onSubmit={submit}>
      <span className="eyebrow">我的日常账本</span><h1>看清每一笔，<br />心里更有数。</h1>
      <p className="muted">登录你的个人账本</p>
      <label>账号<input name="username" autoComplete="username" required disabled={busy} /></label>
      <label>密码<input name="password" type="password" autoComplete="current-password" required disabled={busy} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary full" disabled={busy}>{busy ? '正在连接账本…' : '登录账本'}<ArrowRight size={17} /></button>
    </form>
    <footer><ShieldCheck size={14} /> 数据存储在当前账本服务中</footer>
  </main>;
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authState, setAuthState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [authError, setAuthError] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const [data, setData] = useState<Snapshot | null>(null);
  const [view, setView] = useState<View>('cashflow');
  const [month, setMonth] = useState(monthOf(Date.now() / 1000));
  const [modal, setModal] = useState<Modal>(null);
  const [selected, setSelected] = useState<Transaction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [privateMode, setPrivateMode] = useState(false);
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');
  const [accountFilter, setAccountFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [limit, setLimit] = useState(50);
  const requestVersion = useRef(0);

  function enter(next: Session) {
    setSession(next); setAuthState('ready'); setError('');
  }
  function clearSession() {
    requestVersion.current++;
    setSession(null); setData(null); setModal(null); setSelected(null); setError('');
    setBusy(false); setNotice(''); setView('cashflow'); setQuery('');
    setLogoutError('');
    setAccountFilter(''); setCategoryFilter(''); setType('all');
  }
  async function checkSession() {
    setAuthState('loading'); setAuthError('');
    try { setSession(await request<Session>('session')); setAuthState('ready'); }
    catch (e) {
      if (e instanceof ApiError && e.unauthorized) { clearSession(); setAuthState('ready'); }
      else { setAuthError(errorText(e)); setAuthState('error'); }
    }
  }
  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true); setLogoutError('');
    try { await request('logout', '', {}); clearSession(); }
    catch (e) { setLogoutError(`退出未完成：${errorText(e)}`); }
    finally { setLoggingOut(false); }
  }
  async function refresh() {
    if (!session) return;
    const version = ++requestVersion.current;
    setBusy(true); setError('');
    try {
      const next = await loadSnapshot();
      if (version === requestVersion.current) setData(next);
    } catch (e) {
      if (version === requestVersion.current) {
        if (e instanceof ApiError && e.unauthorized) { clearSession(); return; }
        setError(errorText(e));
      }
    } finally { if (version === requestVersion.current) setBusy(false); }
  }
  useEffect(() => { void checkSession(); }, []);
  useEffect(() => { if (session) void refresh(); }, [session]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => { setLimit(50); }, [month, query, type, accountFilter, categoryFilter]);

  if (authState !== 'ready') return <main className="login-screen"><div className="login-form">
    <h1>见财</h1>{authState === 'loading' ? <p role="status">正在确认登录状态…</p> : <>
      <p className="error" role="alert">{authError}</p><button className="primary" onClick={() => void checkSession()}><RefreshCw size={16} />重试</button>
    </>}</div></main>;
  if (!session) return <Login onLogin={enter} />;
  const accounts = data ? leafAccounts(data.accounts) : [];
  const totals = assetTotals(accounts);
  const monthly = monthTransactions(data?.transactions ?? [], month);
  const flow = cashflow(monthly, accounts);
  const groups = expenseGroups(monthly, accounts);
  const otherCurrencies = accounts.some(a => a.currency !== 'CNY');
  const currentMonth = monthOf(Date.now() / 1000);
  const daysInMonth = new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate();
  const periodDay = month === currentMonth ? Number(dateOf(Date.now() / 1000).slice(8)) : daysInMonth;
  const previous = monthTransactions(data?.transactions ?? [], previousMonth(month))
    .filter(t => Number(dateOf(t.time).slice(8)) <= periodDay);
  const priorFlow = cashflow(previous, accounts);
  const latestTransaction = (data?.transactions ?? []).reduce((max, t) => Math.max(max, t.time), 0);
  const filtered = monthly.filter(t => {
    const accountName = accounts.find(a => a.id === t.sourceAccountId)?.name ?? '';
    return (type === 'all' || t.type === Number(type))
      && (!accountFilter || t.sourceAccountId === accountFilter || t.destinationAccountId === accountFilter)
      && (!categoryFilter || t.categoryId === categoryFilter)
      && `${t.comment} ${t.category?.name ?? ''} ${accountName}`.toLowerCase().includes(query.toLowerCase());
  });
  function openTransactions(filterType = 'all', account = '', category = '') {
    setView('cashflow'); setType(filterType); setAccountFilter(account); setCategoryFilter(category); setQuery('');
  }
  function navigate(next: View) {
    setView(next); setAccountFilter(''); setCategoryFilter(''); setType('all'); setQuery('');
  }
  function exportTransactions() {
    const rows = [['日期（北京时间）', '类型', '账户', '分类', '金额', '币种', '备注'], ...filtered.map(t => [
      dateOf(t.time), typeNames[t.type], accounts.find(a => a.id === t.sourceAccountId)?.name ?? '',
      t.category?.name ?? '', (t.sourceAmount / 100).toFixed(2),
      accounts.find(a => a.id === t.sourceAccountId)?.currency ?? '', t.comment,
    ])];
    const csv = '\uFEFF' + rows.map(row => row.map(cell => {
      const safe = /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell;
      return `"${safe.replaceAll('"', '""')}"`;
    }).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `账单-${month}.csv`; link.click();
    URL.revokeObjectURL(url); setNotice(`已导出 ${filtered.length} 笔账单`);
  }
  const accountLabel = (id: string) => accounts.find(a => a.id === id)?.name ?? '未知账户';
  function transactionRows(items: Transaction[]) {
    return <div className="transaction-list">{items.map(t => <button className="transaction-row" key={t.id} onClick={() => setSelected(t)}>
      <span className={`transaction-icon ${t.type === 3 ? 'expense' : t.type === 2 ? 'income' : 'neutral'}`}>
        {t.type === 3 ? <ArrowUpRight size={17} /> : t.type === 2 ? <ArrowDownLeft size={17} /> : <ArrowLeftRight size={17} />}
      </span>
      <span className="transaction-description"><strong>{t.comment || t.category?.name || typeNames[t.type]}</strong>
        <small>{accountLabel(t.sourceAccountId)}{t.type === 4 ? ` → ${accountLabel(t.destinationAccountId ?? '')}` : ` · ${t.category?.name ?? typeNames[t.type]}`}</small>
      </span>
      <time>{dateOf(t.time).slice(5).replace('-', '/')}</time>
      <span className={`row-amount ${t.type === 2 ? 'positive' : ''}`}>
        {privateMode || t.hideAmount ? '••••' : `${t.type === 3 ? '−' : t.type === 2 ? '+' : ''}${accounts.find(a => a.id === t.sourceAccountId)?.currency === 'CNY' ? '¥' : `${accounts.find(a => a.id === t.sourceAccountId)?.currency ?? ''} `}${money(Math.abs(t.sourceAmount))}`}
      </span><ChevronRight size={15} className="muted" />
    </button>)}</div>;
  }

  function groupedTransactions(items: Transaction[]) {
    const days = new Map<string, Transaction[]>();
    for (const item of items) {
      const day = dateOf(item.time);
      days.set(day, [...(days.get(day) ?? []), item]);
    }
    return <div className="daily-ledger">{[...days].map(([day, entries]) => {
      const matching = filtered.filter(item => dateOf(item.time) === day);
      const daily = cashflow(matching, accounts);
      return <section className="ledger-day" key={day} aria-label={day + '流水'}>
        <header className="ledger-day-heading"><h2><time dateTime={day}>{day.slice(5).replace('-', '月')}日</time><span className="count">{matching.length} 笔</span></h2>
          <span className="fine">收入 {display(daily.income)}<span className="day-divider"> / </span>支出 {display(daily.expense)}</span>
        </header>{transactionRows(entries)}
      </section>;
    })}</div>;
  }

  const display = (value: number, signed = false) => privateMode ? <span className="amount">••••</span> : <Amount value={value} signed={signed} />;

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); navigate('cashflow'); }}>
        <span className="brand-mark"><ChartNoAxesCombined size={22} /></span><span>见财<span className="brand-dot">.</span></span>
      </a>
      <span className="sidebar-label">日常记账</span>
      <nav aria-label="主导航">{nav.map(item => <button key={item.id} className={view === item.id ? 'nav-item active' : 'nav-item'} aria-current={view === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}>
        <item.icon size={19} /><span>{item.title}</span>{view === item.id && <span className="active-dot" />}
      </button>)}</nav>
      <div className="sidebar-bottom">
        <button className="nav-item" onClick={() => setModal('import')}><Upload size={18} /><span>账单导入</span></button>
        <div className="ledger-status"><span className="status-dot" /><span>个人账本<span className="fine">{session.username}</span></span></div>
        <div className="profile"><span className="avatar">{session.username.slice(0, 1).toUpperCase()}</span><span className="profile-name">{session.username}<small>个人空间</small></span>
          <IconButton label={loggingOut ? '正在退出' : '退出登录'} onClick={() => void logout()} disabled={loggingOut}><LogOut size={17} /></IconButton>
        </div>
      </div>
    </aside>

    <div className="main-shell">
      <header className="topbar"><span>个人账本<span className="breadcrumb"> / {nav.find(n => n.id === view)?.title}</span></span>
        <div className="topbar-right">
          <span className="refresh-status">{busy ? '正在读取账本…' : data ? `账本读取于 ${data.fetchedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '尚未读取'}</span>
          <IconButton label={privateMode ? '显示金额' : '隐藏金额'} onClick={() => setPrivateMode(!privateMode)}>{privateMode ? <EyeOff size={18} /> : <Eye size={18} />}</IconButton>
          <IconButton label="刷新账本" onClick={() => void refresh()} disabled={busy}><RefreshCw size={17} className={busy ? 'spinning' : ''} /></IconButton>
          <IconButton label="退出账本" onClick={() => void logout()} disabled={loggingOut}><LogOut size={17} /></IconButton>
        </div>
      </header>
      <main className="workspace">
        <div className="page-heading"><div><span className="eyebrow">我的账本</span>
          <h1>{view === 'cashflow' ? '收支明细' : view === 'overview' ? '收支统计' : '我的账户'}</h1></div>
          <div className="heading-actions"><button className="secondary import-button" onClick={() => setModal('import')} disabled={!data}><Upload size={16} />导入账单</button><button className="primary" onClick={() => setModal(accounts.length ? 'entry' : 'account')} disabled={!data}><Plus size={17} />{accounts.length ? '记一笔' : '创建账户'}</button></div>
        </div>
        {logoutError && <div className="error-banner" role="alert"><CircleAlert size={18} /><span>{logoutError}</span><button onClick={() => void logout()} disabled={loggingOut}>重试退出</button></div>}
        {error && <div className="error-banner" role="alert"><CircleAlert size={18} /><span>{error}{data ? '。以下为上次成功读取的数据。' : ''}</span><button onClick={() => void refresh()}>重试</button></div>}
        {!data ? <div className="loading-state" role="status">{busy ? <><RefreshCw className="spinning" />正在读取账户和账单…</> : <><CircleAlert />账本尚未载入</>}</div> : <>
          {!accounts.length && <div className="info-band"><Wallet size={19} /><p>还没有账户。先创建银行、钱包或信用卡账户，再开始记账。</p><button className="text-button" onClick={() => setModal('account')}>创建账户<Plus size={16} /></button></div>}
          {otherCurrencies && <p className="currency-note"><CircleAlert size={14} />人民币汇总不含外币账户，外币余额请在账户页查看。</p>}
          {(view === 'overview' || view === 'cashflow') && <div className="period-bar">
            <div className="month-control"><IconButton label="上个月" onClick={() => setMonth(previousMonth(month))}><ChevronLeft size={17} /></IconButton>
              <label><span className="sr-only">统计月份</span><input type="month" value={month} max={currentMonth} onChange={e => { if (e.target.value && e.target.value <= currentMonth) setMonth(e.target.value); }} /></label>
              <IconButton label="下个月" disabled={month >= currentMonth} onClick={() => {
                const [y, m] = month.split('-').map(Number); setMonth(new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7));
              }}><ChevronRight size={17} /></IconButton>
            </div><span className="fine">人民币 · 按北京时间统计</span>
          </div>}

          {view === 'overview' && <>
            <section className="cashflow-summary" aria-label="月度收支统计">
              <div><span>当月支出</span><strong>{display(flow.expense)}</strong></div>
              <div><span>当月收入</span><strong className="positive">{display(flow.income)}</strong></div>
              <div><span>收支结余</span><strong>{display(flow.surplus, true)}</strong></div>
            </section>
            <section className="book-statistics"><div className="section-title"><h2>支出分类</h2><button className="text-button" onClick={() => openTransactions('3')}>查看明细<ArrowRight size={15} /></button></div>
              <p className="fine">{previous.length ? `上月同期支出 ${privateMode ? '••••' : '¥' + money(priorFlow.expense)}；仅比较已记账记录` : '上月同期暂无流水，记账后可在这里比较。'}</p>
              {groups.length ? <div className="category-list">{groups.map((group, index) => <button key={group.id} className="category-row" onClick={() => openTransactions('3', '', group.id)}>
                <span className="category-label"><span className="category-rank">{String(index + 1).padStart(2, '0')}</span>{group.name}<small>{group.count} 笔</small></span>
                <div className="category-track"><span style={{ width: `${group.amount / Math.max(flow.expense, 1) * 100}%` }} /></div>
                <strong>{display(group.amount)}</strong><span className="fine">{(group.amount / Math.max(flow.expense, 1) * 100).toFixed(0)}%</span>
              </button>)}</div> : <Empty title="这个月还没有支出">记一笔或导入账单后，分类统计会自动生成。</Empty>}
              <p className="data-footnote">转账不计入收支。结余是收入减支出，不是账户余额。</p>
            </section>
          </>}

          {view === 'cashflow' && <>
            <section className="cashflow-summary" aria-label="本月收支"><div><span>当月支出</span><strong>{display(flow.expense)}</strong></div><div><span>当月收入</span><strong className="positive">{display(flow.income)}</strong></div><div><span>结余</span><strong>{display(flow.surplus, true)}</strong></div></section>
            <div className="ledger-tools"><div className="segmented" aria-label="流水类型">{[['all', '全部'], ['3', '支出'], ['2', '收入'], ['4', '转账']].map(([id, name]) => <button key={id} aria-pressed={type === id} className={type === id ? 'selected' : ''} onClick={() => setType(id)}>{name}</button>)}</div>
              <div className="filter-tools"><label className="search-field"><Search size={16} /><input aria-label="搜索账单" placeholder="搜索备注、分类或账户" value={query} onChange={e => setQuery(e.target.value)} /></label><IconButton label="导出当前筛选账单" onClick={exportTransactions}><Download size={18} /></IconButton></div>
            </div>
            <div className="account-filter"><ListFilter size={15} /><select aria-label="账户筛选" value={accountFilter} onChange={e => setAccountFilter(e.target.value)}><option value="">所有账户</option>{accounts.map(a => <option value={a.id} key={a.id}>{a.name}</option>)}</select>
              <select aria-label="分类筛选" value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}><option value="">所有分类</option>{data.categories.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}</select><span className="fine">{filtered.length} 笔</span>
            </div>
            {filtered.length ? groupedTransactions(filtered.slice(0, limit)) : <Empty title={monthly.length ? '没有符合条件的流水' : '这个月还没有流水'}>{monthly.length ? '试试其他筛选条件。' : '点击「记一笔」，或导入微信、支付宝、银行卡账单。'}<span className="empty-actions"><button className="primary" onClick={() => setModal(accounts.length ? 'entry' : 'account')}>{accounts.length ? '开始记账' : '创建第一个账户'}</button><button className="secondary" onClick={() => setModal('import')}>导入历史账单</button></span></Empty>}
            {filtered.length > limit && <button className="secondary load-more" onClick={() => setLimit(limit + 50)}>再显示 50 笔</button>}
            <p className="data-footnote">上方显示整月收支，筛选仅作用于明细列表。</p>
          </>}

          {view === 'assets' && <>
            <section className="asset-heading"><div><span className="metric-label">当前净资产 · CNY</span><strong>{display(totals.net)}</strong></div><div><span className="metric-label">总资产</span>{display(totals.assets)}</div><div><span className="metric-label">总负债</span>{display(totals.liabilities)}</div></section>
            <div className="section-title accounts-title"><h2>我的账户 <span className="count">{accounts.length}</span></h2><button className="text-button" onClick={() => setModal('account')}>创建账户<Plus size={14} /></button></div>
            <p className="fine">以下为账本余额，非银行实时余额。账户余额最近核对时间未知。</p>
            <div className="accounts-list">{accounts.map(account => <button key={account.id} className="account-row" onClick={() => openTransactions('all', account.id)}>
              <span className={`account-symbol ${account.category === 3 ? 'red' : account.category === 7 ? 'blue' : 'green'}`}>{account.category === 3 ? <CreditCard size={22} /> : account.category === 4 ? <Wallet size={22} /> : <Landmark size={22} />}</span>
              <span className="account-name"><strong>{account.name}</strong><small>{accountNames[account.category] ?? '其他账户'} · {account.currency}{account.hidden ? ' · 已隐藏账户' : ''}</small></span>
              <span className="account-balance"><strong>{privateMode ? '••••' : `${account.currency === 'CNY' ? '¥' : `${account.currency} `}${money(cents(account.balance))}`}</strong><small>查看本月流水</small></span><ChevronRight size={17} />
            </button>)}</div>
            {!accounts.length && <Empty title="还没有账户">创建账户并填写当前余额。</Empty>}
            <div className="info-band"><ShieldCheck size={19} /><p>信用卡消费计入支出，还款属于账户转账。负余额计入总负债，避免重复统计。</p></div>
          </>}

          <footer className="workspace-footer"><span><span className="status-dot" />{latestTransaction ? `账本最近流水：${dateOf(latestTransaction)}` : '账本暂无流水'}</span><span>见财 · 个人财务</span></footer>
        </>}
      </main>
    </div>
    <nav className="mobile-nav" aria-label="手机导航">{nav.map(item => <button key={item.id} onClick={() => navigate(item.id)} className={view === item.id ? 'active' : ''} aria-current={view === item.id ? 'page' : undefined}><item.icon size={20} /><span>{item.title}</span></button>)}</nav>
    {notice && <div className="toast" role="status"><Check size={17} />{notice}</div>}
    {modal === 'entry' && data && <EntryDialog data={data} close={() => setModal(null)} createAccount={() => setModal('account')} saved={time => { setModal(null); setMonth(monthOf(time)); navigate('cashflow'); setNotice('已保存到账本'); void refresh(); }} />}
    {modal === 'account' && <AccountDialog close={() => setModal(null)} saved={() => { setModal(null); setNotice('账户已创建'); void refresh(); }} />}
    {modal === 'import' && data && <ImportDialog data={data} close={() => { setModal(null); void refresh(); }} createAccount={() => setModal('account')} saved={async result => {
      const version = ++requestVersion.current;
      const next = await loadSnapshot();
      if (version !== requestVersion.current) return;
      setData(next); setError(''); setBusy(false); setMonth(monthOf(result.latestTime));
      navigate('cashflow'); setModal(null); setNotice(`已新增 ${result.imported} 笔，跳过重复 ${result.duplicates} 笔`);
    }} />}
    {selected && <Dialog title="流水详情" close={() => setSelected(null)}><div className="dialog-content"><div className="detail-amount">{privateMode || selected.hideAmount ? '••••' : `${accounts.find(a => a.id === selected.sourceAccountId)?.currency ?? 'CNY'} ${money(selected.sourceAmount)}`}</div>
      <dl className="detail-list"><dt>类型</dt><dd>{typeNames[selected.type]}</dd><dt>时间</dt><dd>{new Date(selected.time * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（北京时间）</dd><dt>账户</dt><dd>{accountLabel(selected.sourceAccountId)}</dd>
        {selected.type === 4 && <><dt>转入账户</dt><dd>{accountLabel(selected.destinationAccountId ?? '')}</dd></>}
        <dt>分类</dt><dd>{selected.category?.name ?? '未分类'}</dd><dt>备注</dt><dd>{selected.comment || '无'}</dd><dt>记录 ID</dt><dd className="fine">{selected.id}</dd></dl>
      <p className="fine">{selected.type === 4 ? '账户间转账不计入收入和支出。' : '数据来自当前账本记录。'}</p></div></Dialog>}
  </div>;
}

function AccountDialog({ close, saved }: { close: () => void; saved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<{ key: string; body: unknown } | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      const name = String(form.get('name')).trim();
      if (!name) throw new Error('请输入账户名称');
      const raw = String(form.get('balance')).trim();
      if (!/^-?\d{1,10}(\.\d{1,2})?$/.test(raw)) throw new Error('请输入有效余额，最多保留两位小数');
      const [whole, fraction = ''] = raw.replace(/^-/, '').split('.');
      const balance = cents((Number(whole) * 100 + Number(fraction.padEnd(2, '0'))) * (raw.startsWith('-') ? -1 : 1));
      const content = { name, category: Number(form.get('category')), type: 1, currency: 'CNY', balance: String(balance) };
      const key = JSON.stringify(content);
      if (pending.current?.key !== key) pending.current = { key, body: { ...content, clientSessionId: crypto.randomUUID() } };
      setBusy(true);
      await request('v1/accounts/add', '', pending.current.body);
      saved();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <Dialog title="创建账户" close={() => { if (!busy) close(); }}>
    <form className="dialog-content entry-form" onSubmit={submit}>
      <fieldset disabled={busy}>
        <label>账户名称<input name="name" required maxLength={100} autoFocus placeholder="例如：招商银行储蓄卡" /></label>
        <label>账户类型<select name="category" defaultValue="2">{Object.entries(accountNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        <label>当前余额（人民币元）<input name="balance" inputMode="text" defaultValue="0" required aria-describedby="balance-hint" /></label>
        <p className="fine" id="balance-hint">负债填写负数，例如信用卡欠款 500 元填 -500。起始余额不计入收入或支出。</p>
      </fieldset>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary full" disabled={busy}>{busy ? '创建中…' : '创建账户'}<Check size={17} /></button>
    </form>
  </Dialog>;
}

function EntryDialog({ data, close, saved, createAccount }: {
  data: Snapshot; close: () => void; saved: (time: number) => void; createAccount: () => void;
}) {
  const [type, setType] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<{ key: string; body: unknown } | null>(null);
  const eligible = leafAccounts(data.accounts).filter(a => a.currency === 'CNY' && !a.hidden);
  const categories = data.categories.filter(c => c.type === type - 1);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setError('');
    try {
      const sourceAmount = parseAmount(String(form.get('amount')));
      const timeString = String(form.get('date'));
      const time = Math.floor(new Date(`${timeString}+08:00`).getTime() / 1000);
      if (!Number.isFinite(time) || time > Math.floor(Date.now() / 1000) + 60) throw new Error('请选择有效的记账时间，不能晚于现在');
      const sourceAccountId = String(form.get('account'));
      const destinationAccountId = String(form.get('destination'));
      if (type === 4 && sourceAccountId === destinationAccountId) throw new Error('转出账户和转入账户不能相同');
      const content = {
        type, categoryId: String(form.get('category')), sourceAccountId,
        sourceAmount, time, utcOffset: 480, comment: String(form.get('comment')),
        ...(type === 4 ? { destinationAccountId, destinationAmount: sourceAmount } : {}),
      };
      const key = JSON.stringify(content);
      if (pending.current?.key !== key) pending.current = { key, body: { ...content, clientSessionId: crypto.randomUUID() } };
      setBusy(true);
      await request('v1/transactions/add', '', pending.current.body);
      saved(time);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <Dialog title="记一笔" close={() => { if (!busy) close(); }}><form className="dialog-content entry-form" onSubmit={submit}>
    <fieldset disabled={busy}><div className="segmented"><button type="button" className={type === 3 ? 'selected' : ''} aria-pressed={type === 3} onClick={() => setType(3)}>支出</button><button type="button" className={type === 2 ? 'selected' : ''} aria-pressed={type === 2} onClick={() => setType(2)}>收入</button><button type="button" className={type === 4 ? 'selected' : ''} aria-pressed={type === 4} onClick={() => setType(4)}>转账 / 还款</button></div>
      <label>金额（元）<input name="amount" inputMode="decimal" autoFocus placeholder="0.00" required /></label>
      <div className="form-grid"><label>{type === 4 ? '转出账户' : '账户'}<select name="account" required>{eligible.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        {type === 4 ? <label>转入账户<select name="destination" required defaultValue={eligible[1]?.id}>{eligible.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label> : <label>分类<select name="category" key={type} required>{categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
      </div>
      {type === 4 && <><input type="hidden" name="category" value={categories[0]?.id ?? ''} /><p className="fine transfer-hint">信用卡还款：从付款账户转入信用卡账户，不计入收入或支出。{eligible.length < 2 ? '请先在账户页创建另一个账户。' : ''}</p></>}
      <label>时间（北京时间）<input type="datetime-local" name="date" defaultValue={new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 16)} required /></label>
      <label>备注<input name="comment" placeholder="记下这笔钱的用途" maxLength={255} /></label>
    </fieldset>
    {!eligible.length && <button className="secondary full" type="button" onClick={createAccount}>先创建人民币账户<Plus size={16} /></button>}
    {!categories.length && <p className="error" role="alert">记账分类未加载，请关闭后刷新账本重试。</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <button className="primary full" disabled={busy || !eligible.length || !categories.length || (type === 4 && eligible.length < 2)}>{busy ? '保存中…' : '保存到账本'}<Check size={17} /></button>
  </form></Dialog>;
}
