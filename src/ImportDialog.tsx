import { useEffect, useRef, useState } from 'react';
import { Check, Download, Upload, X } from 'lucide-react';
import { ApiError, request, type Snapshot } from './api';
import { dateOf, leafAccounts, money, sum } from './finance';
import type { ParsedStatement } from './statement-parser';

interface ImportResult { imported: number; duplicates: number; anonymousDuplicates: number; latestTime: number }
const providers = { wechat: '微信', alipay: '支付宝', cmb: '招商银行', generic: '通用账单' };

function downloadTemplate() {
  const content = '\uFEFF日期,类型,金额,备注,交易单号,币种\r\n2026-01-01 12:00:00,支出,20.50,午餐,sample-001,CNY\r\n2026-01-02 09:00:00,收入,100.00,其他收入,sample-002,CNY\r\n';
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = '见财-导入模板.csv'; link.click();
  URL.revokeObjectURL(url);
}

export default function ImportDialog({ data, close, createAccount, saved }: {
  data: Snapshot; close: () => void; createAccount: () => void;
  saved: (result: ImportResult) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef<{ signature: string; key: string } | null>(null);
  const accounts = leafAccounts(data.accounts).filter(a => a.currency === 'CNY');
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [incomeCategoryId, setIncomeCategoryId] = useState(data.categories.find(c => c.type === 1 && c.name === '其他收入')?.id ?? data.categories.find(c => c.type === 1)?.id ?? '');
  const [expenseCategoryId, setExpenseCategoryId] = useState(data.categories.find(c => c.type === 2 && c.name === '其他支出')?.id ?? data.categories.find(c => c.type === 2)?.id ?? '');
  const [balanceMode, setBalanceMode] = useState<'preserve' | 'apply'>('preserve');
  const [keepAnonymous, setKeepAnonymous] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [parsed, setParsed] = useState<ParsedStatement | null>(null);
  const [filename, setFilename] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const dismiss = () => { if (!busy && !uncertain) close(); };

  async function chooseFile(file?: File) {
    if (!file || busy) return;
    setBusy(true); setError(''); setParsed(null); setResult(null); setReviewed(false); setFilename(file.name); setKeepAnonymous(false);
    pending.current = null;
    try {
      const { parseStatement } = await import('./statement-parser');
      const next = await parseStatement(file);
      // Validate totals before presenting any confirmation or sending a write request.
      sum(next.rows.filter(r => r.type === 2).map(r => r.amount));
      sum(next.rows.filter(r => r.type === 3).map(r => r.amount));
      setParsed(next);
    } catch (e) { setError(e instanceof Error ? e.message : '文件读取失败，请重新选择'); }
    finally { setBusy(false); }
  }

  async function submit() {
    if (!parsed?.rows.length || !accountId || !reviewed || busy) return;
    setBusy(true); setError('');
    const body = { provider: parsed.provider, accountId, incomeCategoryId, expenseCategoryId, balanceMode, anonymousMode: keepAnonymous ? 'keep' : 'deduplicate', rows: parsed.rows };
    const signature = JSON.stringify(body);
    if (pending.current?.signature !== signature) pending.current = { signature, key: crypto.randomUUID() };
    try {
      setResult(await request<ImportResult>('v1/transactions/import', '', { ...body, clientSessionId: pending.current.key }));
      setUncertain(false);
    } catch (e) {
      setUncertain(!(e instanceof ApiError && e.status !== undefined && e.status >= 400 && e.status < 500));
      setError(e instanceof Error ? e.message : '导入未完成，请重试');
    }
    finally { setBusy(false); }
  }

  async function viewImported() {
    if (!result || busy) return;
    setBusy(true); setError('');
    try { await saved(result); }
    catch (e) { setError(`流水已保存，但刷新未完成：${e instanceof Error ? e.message : '请重试'}`); }
    finally { setBusy(false); }
  }

  return <dialog ref={dialog} className="import-dialog" aria-labelledby="import-title"
    onCancel={event => { event.preventDefault(); dismiss(); }} onClick={event => { if (event.target === dialog.current) dismiss(); }}>
    <div className="dialog-header"><h2 id="import-title">导入账单</h2><button className="icon-button" aria-label="关闭" disabled={busy || uncertain} onClick={dismiss}><X size={20} /></button></div>
    <div className="dialog-content">
      {result ? <section className="import-result" aria-live="polite">
        <Check size={28} /><h3>导入完成</h3><p>新增 {result.imported} 笔，重复 {result.duplicates} 笔已跳过。</p>
        <p className="fine">{balanceMode === 'preserve' ? '当前账户余额保持不变。' : result.imported ? '已按新增流水更新账户余额。' : '没有新增流水，账户余额未改变。'}查看流水将切换到这份账单的最近月份。</p>
        {result.anonymousDuplicates > 0 && <p className="import-warning">其中 {result.anonymousDuplicates} 笔没有交易单号，仅按内容判断重复。如果它们实际是不同交易，请核对后重新选择文件，在「分类与余额设置」中勾选保留无单号相同记录。</p>}
        <button className="primary full" disabled={busy} onClick={() => void viewImported()}>{busy ? '正在刷新流水…' : '查看导入流水'}</button>
      </section> : <>
        <p>支持微信、支付宝、招商银行及通用账单的 CSV / XLSX 文件。先核对预览，再写入账本。</p>
        <p className="fine">单次最多 5 MB、1,000 笔。暂不支持 XLS、PDF、图片和华泰持仓。</p>
        <button className="text-button" disabled={busy} onClick={downloadTemplate}><Download size={15} />下载通用 CSV 模板</button>
        {!accounts.length ? <div className="import-empty"><p>先创建一个人民币账户，填写已核对的当前余额，再导入历史流水。</p><button className="primary full" onClick={createAccount}>创建账户</button></div> : <>
          <fieldset disabled={busy || uncertain}>
            <label>选择账单文件<input type="file" accept=".csv,.xlsx" onChange={event => void chooseFile(event.target.files?.[0])} /></label>
            <p className="fine">文件仅在浏览器中解析；确认后只发送可导入的流水。</p>
            {filename && <p className="import-filename" role="status">{busy && !parsed ? '正在解析：' : '已选择：'}{filename}</p>}
            {parsed && <>
              <div className="import-summary"><strong>{providers[parsed.provider]} · 可导入 {parsed.rows.length} 笔</strong><span>收入 ¥{money(sum(parsed.rows.filter(r => r.type === 2).map(r => r.amount)))} · 支出 ¥{money(sum(parsed.rows.filter(r => r.type === 3).map(r => r.amount)))}</span><small>以上为文件金额，尚未扣除已导入的重复记录。</small></div>
              <label>记入账户<select value={accountId} onChange={event => setAccountId(event.target.value)}>{accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
              <p className="fine">一份文件对应一个账户。微信 / 支付宝与银行卡可能记录同一笔消费，跨来源请勿重复导入。</p>
              <p className="fine">{balanceMode === 'preserve' ? '仅补录流水，保留当前账户余额。' : '按新增流水更新余额，请确保账户填写的是期初余额。'}</p>
              <details className="import-settings"><summary>分类与余额设置</summary><div className="form-grid">
                <label>收入归类<select value={incomeCategoryId} onChange={event => setIncomeCategoryId(event.target.value)}>{data.categories.filter(c => c.type === 1).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
                <label>支出归类<select value={expenseCategoryId} onChange={event => setExpenseCategoryId(event.target.value)}>{data.categories.filter(c => c.type === 2).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
              </div>
              <label>账户余额处理<select value={balanceMode} onChange={event => setBalanceMode(event.target.value as 'preserve' | 'apply')}><option value="preserve">补录历史流水，保留当前余额（推荐）</option><option value="apply">从期初余额开始，随新增流水更新余额</option></select></label>
              <p className="fine">{balanceMode === 'preserve' ? '适合账户已填写当前余额的情况，避免把历史消费再扣一次。' : '仅在账户余额是这段流水发生前的余额时使用。新增收入加余额、新增支出减余额。'}</p>
              {parsed.rows.some(r => !r.sourceId) && <label className="import-confirm"><input type="checkbox" checked={keepAnonymous} onChange={event => { setKeepAnonymous(event.target.checked); setReviewed(false); }} /><span>无单号的相同记录仍按新流水导入（仅在确认是不同交易时勾选）</span></label>}</details>
              {parsed.rows.some(r => !r.sourceId) && <p className="import-warning">无单号记录默认按时间、收支、金额、备注及出现次数防重。不同文件中同内容的真实交易可能被判重复；修改字段也可能重复入账，请核对结果。{keepAnonymous ? '当前已选择保留无单号相同记录，再次上传会新增。' : ''}</p>}
              {parsed.issues.length > 0 && <details className="import-issues" open><summary>{parsed.issues.length} 行未纳入导入，请核对</summary><ul>{parsed.issues.map((issue, index) => <li key={index}>第 {issue.rowNumber} 行：{issue.message}</li>)}</ul><p className="fine">退款、还款、转账等不确定记录需单独核对和手动处理，统计可能因此不完整。</p></details>}
              {parsed.rows.length > 0 ? <>
                <details className="import-preview" open><summary>流水预览 · {parsed.rows.length} 笔</summary><div className="import-table-wrap" tabIndex={0} role="region" aria-label="待导入流水预览"><table><thead><tr><th>行号 / 日期</th><th>备注</th><th>金额（元）</th></tr></thead><tbody>{parsed.rows.map((row, index) => <tr key={index}><td>{row.rowNumber}<br />{dateOf(row.time)}</td><td>{row.comment || '无备注'}</td><td>{row.type === 2 ? '+' : '−'}{money(row.amount)}</td></tr>)}</tbody></table></div></details>
                <label className="import-confirm"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} /><span>已核对账户、余额处理和预览；如有跳过的记录，我会另行处理。</span></label>
                <button className="primary full" disabled={!reviewed || !incomeCategoryId || !expenseCategoryId} onClick={() => void submit()}><Upload size={16} />{busy ? '正在导入，请稍候…' : `确认导入 ${parsed.rows.length} 笔`}</button>
              </> : <p role="status">没有可导入的收支。请核对上方原因或更换文件。</p>}
            </>}
          </fieldset>
        </>}
      </>}
      {error && <p className="error" role="alert">{error}</p>}
      {uncertain && <div className="import-retry"><p className="fine">尚未确认服务器是否已保存。已锁定本次文件与选项，请用原请求重试确认，避免更换账户后重复入账。</p><button className="primary full" disabled={busy} onClick={() => void submit()}>{busy ? '正在确认…' : '重试确认本次导入'}</button></div>}
    </div>
  </dialog>;
}
