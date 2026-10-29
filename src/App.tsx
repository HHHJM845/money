import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowDownLeft, ArrowRight, ArrowUpRight, ArrowLeftRight, Bell,
  ChartNoAxesCombined, Check, ChevronLeft, ChevronRight, CircleAlert,
  CreditCard, Download, Eye, EyeOff, Landmark, LayoutDashboard,
  ListFilter, LogOut, Plus, RefreshCw, Search, ShieldCheck, Upload, Wallet, X,
} from 'lucide-react';
import { ApiError, loadSnapshot, login, request, type Snapshot } from './api';
import {
  assetTotals, cashflow, cents, dateOf, expenseGroups, leafAccounts, money,
  monthOf, monthTransactions, parseAmount, previousMonth, sum, type Transaction,
} from './finance';

type View = 'overview' | 'cashflow' | 'assets' | 'investments';
type Modal = 'entry' | 'account' | 'import' | 'actions' | null;
interface Session { username: string }
const nav = [
  { id: 'overview' as const, title: '总览', icon: LayoutDashboard },
  { id: 'cashflow' as const, title: '收支', icon: ArrowLeftRight },
  { id: 'assets' as const, title: '资产', icon: Wallet },
  { id: 'investments' as const, title: '投资', icon: ChartNoAxesCombined },
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
  return <dialog ref={dialog} onCancel={close} onClick={e => { if (e.target === dialog.current) close(); }}>
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
      <span className="eyebrow">个人财务工作台</span><h1>看清每一笔，<br />心里更有数。</h1>
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
  const [view, setView] = useState<View>('overview');
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
    setBusy(false); setNotice(''); setView('overview'); setQuery('');
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
  const investmentAccounts = accounts.filter(a => a.category === 7);
  const cards = accounts.filter(a => a.category === 3);
  const cashCategories = new Set([1, 2, 4, 8, 9]);
  const allocations = [
    { name: '现金与存款', color: 'green', amount: sum(accounts.filter(a => a.currency === 'CNY' && cashCategories.has(a.category) && cents(a.balance) > 0).map(a => cents(a.balance))) },
    { name: '投资资产', color: 'blue', amount: sum(investmentAccounts.filter(a => a.currency === 'CNY' && cents(a.balance) > 0).map(a => cents(a.balance))) },
    { name: '其他资产', color: 'gray', amount: sum(accounts.filter(a => a.currency === 'CNY' && !cashCategories.has(a.category) && a.category !== 7 && cents(a.balance) > 0).map(a => cents(a.balance))) },
  ];
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
  const display = (value: number, signed = false) => privateMode ? <span className="amount">••••</span> : <Amount value={value} signed={signed} />;

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); navigate('overview'); }}>
        <span className="brand-mark"><ChartNoAxesCombined size={22} /></span><span>见财<span className="brand-dot">.</span></span>
      </a>
      <span className="sidebar-label">个人财务</span>
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
      <header className="topbar"><span>我的财务<span className="breadcrumb"> / {nav.find(n => n.id === view)?.title}</span></span>
        <div className="topbar-right">
          <span className="refresh-status">{busy ? '正在读取账本…' : data ? `账本读取于 ${data.fetchedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '尚未读取'}</span>
          <IconButton label={privateMode ? '显示金额' : '隐藏金额'} onClick={() => setPrivateMode(!privateMode)}>{privateMode ? <EyeOff size={18} /> : <Eye size={18} />}</IconButton>
          <IconButton label="刷新账本" onClick={() => void refresh()} disabled={busy}><RefreshCw size={17} className={busy ? 'spinning' : ''} /></IconButton>
          <IconButton label="待处理事项" onClick={() => setModal('actions')}><Bell size={18} /></IconButton>
          <IconButton label="退出账本" onClick={() => void logout()} disabled={loggingOut}><LogOut size={17} /></IconButton>
        </div>
      </header>
      <main className="workspace">
        <div className="page-heading"><div><span className="eyebrow">{view === 'overview' ? '财务全貌，一目了然' : view === 'cashflow' ? '每一笔流动，都有来处' : view === 'assets' ? '分清资产，也看清负债' : '看长期，也看数据来源'}</span>
          <h1>{view === 'overview' ? '财务总览' : nav.find(n => n.id === view)?.title}</h1></div>
          <div className="heading-actions"><button className="secondary import-button" onClick={() => setModal('import')}><Upload size={16} />导入账单</button><button className="primary" onClick={() => setModal(accounts.length ? 'entry' : 'account')} disabled={!data}><Plus size={17} />{accounts.length ? '记一笔' : '创建账户'}</button></div>
        </div>
        {logoutError && <div className="error-banner" role="alert"><CircleAlert size={18} /><span>{logoutError}</span><button onClick={() => void logout()} disabled={loggingOut}>重试退出</button></div>}
        {error && <div className="error-banner" role="alert"><CircleAlert size={18} /><span>{error}{data ? '。以下为上次成功读取的数据。' : ''}</span><button onClick={() => void refresh()}>重试</button></div>}
        {!data ? <div className="loading-state" role="status">{busy ? <><RefreshCw className="spinning" />正在读取账户和账单…</> : <><CircleAlert />账本尚未载入</>}</div> : <>
          {!accounts.length && <div className="info-band"><Wallet size={19} /><p>还没有账户。先创建银行、钱包或信用卡账户，再开始记账。</p><button className="text-button" onClick={() => setModal('account')}>创建账户<Plus size={16} /></button></div>}
          {otherCurrencies && <p className="currency-note"><CircleAlert size={14} />人民币汇总不含外币账户，外币余额请在资产页查看。</p>}
          {(view === 'overview' || view === 'cashflow') && <div className="period-bar">
            <div className="month-control"><IconButton label="上个月" onClick={() => setMonth(previousMonth(month))}><ChevronLeft size={17} /></IconButton>
              <label><span className="sr-only">统计月份</span><input type="month" value={month} max={currentMonth} onChange={e => { if (e.target.value && e.target.value <= currentMonth) setMonth(e.target.value); }} /></label>
              <IconButton label="下个月" disabled={month >= currentMonth} onClick={() => {
                const [y, m] = month.split('-').map(Number); setMonth(new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7));
              }}><ChevronRight size={17} /></IconButton>
            </div><span className="fine">收支按月统计 · 资产为当前账面余额</span>
          </div>}

          {view === 'overview' && <>
            <section className="wealth-section">
              <div className="wealth-primary"><span className="metric-label">当前净资产 <span className="tag">CNY</span></span>
                <button className="wealth-value" onClick={() => setView('assets')} aria-label="查看净资产构成">{display(totals.net)}<ArrowUpRight size={25} /></button>
                <p className="fine">总资产减去负债 · {accounts.length} 个账本账户</p>
                <div className="wealth-secondary"><button onClick={() => setView('assets')}><span>总资产</span>{display(totals.assets)}</button><span className="vertical-divider" /><button onClick={() => setView('assets')}><span>总负债</span>{display(totals.liabilities)}</button></div>
              </div>
              <div className="allocation"><div className="section-title"><h2>资产构成</h2><button className="text-button" onClick={() => setView('assets')}>查看账户<ArrowRight size={15} /></button></div>
                <div className="allocation-bar" role="img" aria-label={privateMode ? '金额已隐藏' : allocations.map(a => `${a.name} ${money(a.amount)}元`).join('，')}>
                  {totals.assets ? allocations.filter(a => a.amount > 0).map(a => <span key={a.name} className={a.color} style={{ width: `${a.amount / totals.assets * 100}%` }} />) : <span className="neutral-bar" />}
                </div>
                {allocations.filter(a => a.name !== '其他资产' || a.amount > 0).map(a => <div className="allocation-row" key={a.name}><span><i className={`legend-dot ${a.color}`} />{a.name}</span><strong>{display(a.amount)}</strong></div>)}
                <p className="fine allocation-note">账面资产 ≠ 可自由支配的钱</p>
              </div>
            </section>
            <section className="flow-metrics" aria-label="月度收支">
              <button className="metric" onClick={() => openTransactions('2')}><span><ArrowDownLeft size={17} />{month === currentMonth ? '本月' : '当月'}收入<ArrowUpRight size={14} /></span><strong>{display(flow.income)}</strong><small>工资及其他已记收入</small></button>
              <button className="metric" onClick={() => openTransactions('3')}><span><ArrowUpRight size={17} />{month === currentMonth ? '本月' : '当月'}支出<ArrowUpRight size={14} /></span><strong>{display(flow.expense)}</strong><small>不含账户转账与信用卡还款</small></button>
              <button className="metric surplus" onClick={() => openTransactions()}><span><Wallet size={17} />收支结余<ArrowUpRight size={14} /></span><strong>{display(flow.surplus, true)}</strong><small>收入 − 支出，不等于资产增值</small></button>
            </section>
            <div className="overview-grid">
              <section className="spending-section"><div className="section-title"><h2>钱花在哪里</h2><button className="text-button" onClick={() => openTransactions('3')}>支出明细<ArrowRight size={15} /></button></div>
                <div className="spending-summary"><strong>{display(flow.expense)}</strong><span className="fine">{previous.length ? '上月同期账本支出' : '上月同期暂无账单，暂不比较'}{previous.length && !privateMode ? ` ¥${money(priorFlow.expense)}` : ''}</span></div>
                {groups.length ? <div className="category-list">{groups.slice(0, 5).map((group, index) => <button key={group.id} className="category-row" onClick={() => openTransactions('3', '', group.id)}>
                  <span className="category-label"><span className="category-rank">{String(index + 1).padStart(2, '0')}</span>{group.name}<small>{group.count} 笔</small></span>
                  <div className="category-track"><span style={{ width: `${group.amount / Math.max(flow.expense, 1) * 100}%` }} /></div>
                  <strong>{display(group.amount)}</strong><span className="fine">{(group.amount / Math.max(flow.expense, 1) * 100).toFixed(0)}%</span>
                </button>)}</div> : <Empty title="这个月还没有支出">记录第一笔支出后查看统计。</Empty>}
                <div className="data-footnote"><ShieldCheck size={14} />统计仅覆盖已录入账单，未核验完整性</div>
              </section>
              <section className="attention-section"><div className="section-title"><h2>需要留意</h2><span className="tag">数据状态</span></div>
                <button className="attention-item" onClick={() => setView('investments')}><span className="attention-icon blue"><ChartNoAxesCombined size={18} /></span><span><strong>华泰证券尚未接入</strong><small>持仓、盈亏和市值更新时间未知</small></span><ChevronRight size={16} /></button>
                <button className="attention-item" onClick={() => setModal('import')}><span className="attention-icon amber"><RefreshCw size={18} /></span><span><strong>自动采集尚未启用</strong><small>当前仅支持手动记账，导入暂不可用</small></span><ChevronRight size={16} /></button>
                {cards.length > 0 && <button className="attention-item" onClick={() => setModal('actions')}><span className="attention-icon neutral"><CreditCard size={18} /></span><span><strong>信用卡还款日待核实</strong><small>账面负债不代表银行本期应还</small></span><ChevronRight size={16} /></button>}
                <div className="growth-note"><span className="eyebrow">本月资产增长</span><strong>暂不可计算</strong><p>还缺月初资产快照和完整投资估值。</p></div>
              </section>
              <section className="recent-section"><div className="section-title"><h2>最近流水 <span className="count">{monthly.length}</span></h2><button className="text-button" onClick={() => openTransactions()}>全部流水<ArrowRight size={15} /></button></div>
                {monthly.length ? transactionRows(monthly.slice(0, 5)) : <Empty title="本月暂无流水">可以切换月份，或开始记账。</Empty>}
              </section>
            </div>
          </>}

          {view === 'cashflow' && <>
            <section className="cashflow-summary"><div><span>收入</span><strong className="positive">{display(flow.income)}</strong></div><div><span>支出</span><strong>{display(flow.expense)}</strong></div><div><span>结余</span><strong>{display(flow.surplus, true)}</strong></div></section>
            <div className="ledger-tools"><div className="segmented" aria-label="流水类型">{[['all', '全部'], ['3', '支出'], ['2', '收入'], ['4', '转账']].map(([id, name]) => <button key={id} aria-pressed={type === id} className={type === id ? 'selected' : ''} onClick={() => setType(id)}>{name}</button>)}</div>
              <div className="filter-tools"><label className="search-field"><Search size={16} /><input aria-label="搜索账单" placeholder="搜索备注、分类或账户" value={query} onChange={e => setQuery(e.target.value)} /></label><IconButton label="导出当前筛选账单" onClick={exportTransactions}><Download size={18} /></IconButton></div>
            </div>
            <div className="account-filter"><ListFilter size={15} /><select aria-label="账户筛选" value={accountFilter} onChange={e => setAccountFilter(e.target.value)}><option value="">所有账户</option>{accounts.map(a => <option value={a.id} key={a.id}>{a.name}</option>)}</select>
              <select aria-label="分类筛选" value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}><option value="">所有分类</option>{data.categories.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}</select><span className="fine">{filtered.length} 笔</span>
            </div>
            {filtered.length ? transactionRows(filtered.slice(0, limit)) : <Empty title="没有符合条件的流水">试试其他月份或筛选条件。</Empty>}
            {filtered.length > limit && <button className="secondary load-more" onClick={() => setLimit(limit + 50)}>再显示 50 笔</button>}
            <p className="data-footnote">上方收支为整月人民币汇总；下方列表可包含转账、余额调整及外币。</p>
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

          {view === 'investments' && <>
            <section className="investment-heading"><span className="eyebrow">投资账户</span><h2>先看清持仓，再看收益。</h2><p>华泰证券 · A 股</p><span className="connection-tag"><span className="status-dot amber-dot" />尚未接入</span></section>
            <div className="investment-metrics">{['持仓市值', '本月投资收益', '累计收益率'].map(label => <div key={label}><span>{label}</span><strong>—</strong><small>缺少持仓与成交数据</small></div>)}</div>
            <section className="investment-body"><div className="section-title"><h2>{investmentAccounts.length ? '账本中的投资账户' : '暂无证券持仓数据'}</h2><button className="text-button" onClick={() => setModal('import')}>数据导入<Upload size={15} /></button></div>
              {investmentAccounts.length ? investmentAccounts.map(a => <button className="account-row" key={a.id} onClick={() => openTransactions('all', a.id)}><span className="account-name"><strong>{a.name}</strong><small>账本余额，不代表实时持仓市值</small></span><strong>{privateMode ? '••••' : `${a.currency} ${money(cents(a.balance))}`}</strong><ChevronRight size={16} /></button>) : <Empty title="等待接入华泰持仓与成交记录">仅凭银行卡转入金额，无法准确计算证券收益。</Empty>}
              <div className="info-band"><CircleAlert size={18} /><p>账单及华泰持仓、成交文件导入尚未实现。投资账户余额不代表实时证券估值。</p></div>
            </section>
          </>}
          <footer className="workspace-footer"><span><span className="status-dot" />{latestTransaction ? `账本最近流水：${dateOf(latestTransaction)}` : '账本暂无流水'}</span><span>见财 · 个人财务</span></footer>
        </>}
      </main>
    </div>
    <nav className="mobile-nav" aria-label="手机导航">{nav.map(item => <button key={item.id} onClick={() => navigate(item.id)} className={view === item.id ? 'active' : ''} aria-current={view === item.id ? 'page' : undefined}><item.icon size={20} /><span>{item.title}</span></button>)}</nav>
    {notice && <div className="toast" role="status"><Check size={17} />{notice}</div>}
    {modal === 'entry' && data && <EntryDialog data={data} close={() => setModal(null)} createAccount={() => setModal('account')} saved={() => { setModal(null); setNotice('已保存到账本'); void refresh(); }} />}
    {modal === 'account' && <AccountDialog close={() => setModal(null)} saved={() => { setModal(null); setNotice('账户已创建'); void refresh(); }} />}
    {modal === 'import' && <Dialog title="账单导入与账户管理" close={() => setModal(null)}>
      <div className="dialog-content"><p role="status">账单导入暂不可用。微信、支付宝、招商银行与华泰证券文件解析尚未接入，当前可手动记录收支。</p>
        <button className="primary full" onClick={() => setModal('account')}><Plus size={16} />创建账户</button>
        <button className="secondary full" onClick={() => { setModal(null); navigate('assets'); }}>查看我的账户<Wallet size={16} /></button>
      </div>
    </Dialog>}
    {modal === 'actions' && <Dialog title="需要处理的事项" close={() => setModal(null)}><div className="dialog-content"><div className="status-entry"><CircleAlert size={20} /><div><h3>数据完整性待核验</h3><p>还未核对微信、支付宝和银行的完整账单，当前统计仅反映已录入记录。</p></div></div>
      <div className="status-entry"><CreditCard size={20} /><div><h3>信用卡还款信息待核实</h3><p>当前没有银行账单日、到期还款日与本期应还数据。请以招商银行账单为准。</p></div></div>
      <button className="primary full" onClick={() => setModal('import')}>导入和核对账单<ArrowRight size={16} /></button></div></Dialog>}
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
  data: Snapshot; close: () => void; saved: () => void; createAccount: () => void;
}) {
  const [type, setType] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<{ key: string; body: unknown } | null>(null);
  const eligible = leafAccounts(data.accounts).filter(a => a.currency === 'CNY' && !a.hidden);
  const categories = data.categories.filter(c => c.type === (type === 3 ? 2 : 1));
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
      const content = {
        type, categoryId: String(form.get('category')), sourceAccountId: String(form.get('account')),
        sourceAmount, time, utcOffset: 480, comment: String(form.get('comment')),
      };
      const key = JSON.stringify(content);
      if (pending.current?.key !== key) pending.current = { key, body: { ...content, clientSessionId: crypto.randomUUID() } };
      setBusy(true);
      await request('v1/transactions/add', '', pending.current.body);
      saved();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <Dialog title="记一笔" close={() => { if (!busy) close(); }}><form className="dialog-content entry-form" onSubmit={submit}>
    <fieldset disabled={busy}><div className="segmented"><button type="button" className={type === 3 ? 'selected' : ''} aria-pressed={type === 3} onClick={() => setType(3)}>支出</button><button type="button" className={type === 2 ? 'selected' : ''} aria-pressed={type === 2} onClick={() => setType(2)}>收入</button></div>
      <label>金额（元）<input name="amount" inputMode="decimal" autoFocus placeholder="0.00" required /></label>
      <div className="form-grid"><label>账户<select name="account" required>{eligible.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label>分类<select name="category" key={type} required>{categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label></div>
      <label>时间（北京时间）<input type="datetime-local" name="date" defaultValue={new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 16)} required /></label>
      <label>备注<input name="comment" placeholder="记下这笔钱的用途" maxLength={255} /></label>
    </fieldset>
    {!eligible.length && <button className="secondary full" type="button" onClick={createAccount}>先创建人民币账户<Plus size={16} /></button>}
    {!categories.length && <p className="error" role="alert">记账分类未加载，请关闭后刷新账本重试。</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <button className="primary full" disabled={busy || !eligible.length || !categories.length}>{busy ? '保存中…' : '保存到账本'}<Check size={17} /></button>
  </form></Dialog>;
}
