export interface StatementRow { rowNumber: number; sourceId?: string; time: number; type: 2 | 3; amount: number; comment: string }
export interface ParsedStatement { provider: 'wechat' | 'alipay' | 'cmb' | 'generic'; rows: StatementRow[]; issues: { rowNumber: number; message: string }[] }

const value = (cell: unknown): string => cell == null ? '' : String(cell).trim().replace(/^\uFEFF/, '');
const header = (cell: unknown): string => value(cell).replace(/[\s（）]/g, c => c === '（' ? '(' : c === '）' ? ')' : '');
const ambiguous = /退款|退货|退回|冲正|撤销|转账|转入|转出|还款|信用卡还|充值|提现|理财|基金|证券|股票|投资|赎回|申购|红包|借款|贷款/;

function cents(input: unknown, signed = false): number {
  const text = value(input).replace(/^[¥￥]\s*/, '');
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) throw new Error('金额格式无效（最多两位小数）');
  const clean = text.replace(/,/g, '');
  const [whole, fraction = ''] = clean.replace(/^[+-]/, '').split('.');
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (amount === 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('金额必须大于零且在安全范围内');
  if (!signed && clean.startsWith('-')) throw new Error('负金额可能是退款，需人工核对');
  return Number(amount) * (clean.startsWith('-') ? -1 : 1);
}

function chinaTime(input: unknown, clock?: unknown): number {
  let text: string;
  if (input instanceof Date) {
    if (!Number.isFinite(input.getTime())) throw new Error('日期无效');
    text = input.toISOString().slice(0, 19).replace('T', ' ');
  } else if (typeof input === 'number' && input > 1 && input < 100000) {
    // Excel's 1900 date system: date cells describe local wall-clock time.
    text = new Date(Date.UTC(1899, 11, 30) + Math.round(input * 86400) * 1000).toISOString().slice(0, 19).replace('T', ' ');
  } else {
    text = value(input).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(text) && value(clock)) text += ` ${value(clock)}`;
  }
  const match = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (!match) throw new Error('日期需包含完整年月日，可附时分秒');
  const [, y, m, d, h = '0', min = '0', s = '0'] = match;
  const parts = [y, m, d, h, min, s].map(Number);
  const [year, month, day, hour, minute, second] = parts;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (year < 1970 || year > 2100 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) throw new Error('日期或时间无效');
  return date.getTime() / 1000 - 8 * 3600;
}

export function parseStatementRows(matrix: unknown[][]): ParsedStatement {
  const dateNames = ['日期', '日期(北京时间)', '交易时间', '交易日期', '交易日', '创建时间', '交易创建时间'];
  const amountNames = ['金额', '金额(元)', '交易金额', '交易金额(元)', '人民币金额'];
  const directionNames = ['收/支', '收支', '收支类型', '类型', '借贷标志'];
  const incomeNames = ['收入', '收入金额', '收入金额(元)', '贷方发生额'];
  const expenseNames = ['支出', '支出金额', '支出金额(元)', '借方发生额'];
  const index = matrix.findIndex(row => {
    const keys = row.map(header);
    return keys.some(k => dateNames.includes(k)) && (keys.some(k => amountNames.includes(k)) || (keys.some(k => incomeNames.includes(k)) && keys.some(k => expenseNames.includes(k))));
  });
  if (index < 0) throw new Error('无法识别账单表头，请使用微信、支付宝、招商银行已支持的 CSV/XLSX 或通用模板');
  const keys = matrix[index].map(header);
  const find = (names: string[]) => keys.findIndex(k => names.includes(k));
  const preamble = matrix.slice(0, index).flat().map(value).join(' ');
  const provider: ParsedStatement['provider'] = /微信/.test(preamble) || keys.includes('当前状态') && keys.includes('商品') ? 'wechat' : /支付宝/.test(preamble) || keys.includes('交易号') || keys.includes('交易订单号') ? 'alipay' : /招商/.test(preamble) ? 'cmb' : 'generic';
  const dateIndex = find(['交易日期', '交易日', ...dateNames]);
  const amountIndex = find(amountNames);
  const directionIndex = find(directionNames);
  const incomeIndex = find(incomeNames), expenseIndex = find(expenseNames);
  const statusIndex = find(['当前状态', '交易状态', '状态']);
  const idIndex = find(['交易单号', '交易号', '交易订单号', '交易流水号', '流水号']);
  const currencyIndex = find(['币种', '交易币种', '货币']);
  const clockIndex = keys.indexOf('交易时间');
  const descriptionIndices = keys.flatMap((k,i) => ['交易类型','交易摘要','摘要','商品','商品名称','商品说明','交易对方','备注','说明'].includes(k) ? [i] : []);
  const credit = provider === 'cmb' && /信用卡/.test(preamble) && keys.includes('人民币金额');
  const bankSigned = provider === 'cmb' && !/信用卡/.test(preamble) && keys.includes('交易金额');
  if (directionIndex < 0 && !(incomeIndex >= 0 && expenseIndex >= 0) && !credit && !bankSigned) throw new Error('表头缺少明确收支方向，此账单模板暂不支持');
  const result: ParsedStatement = { provider, rows: [], issues: [] };
  for (let i = index + 1; i < matrix.length; i++) {
    const row = matrix[i];
    if (row.every(cell => !value(cell))) continue;
    if (row.map(header).join('|') === keys.join('|')) continue;
    const first = value(row.find(cell => value(cell)));
    if (/^(?:[-=]{3,}|共\s*\d+\s*笔|合计|总计|统计|收入合计|支出合计|导出时间|温馨提示)/.test(first)) continue;
    try {
      const descriptions = descriptionIndices.map(j => value(row[j])).filter(Boolean);
      const status = statusIndex >= 0 ? value(row[statusIndex]) : '';
      if (ambiguous.test([...descriptions, status, directionIndex >= 0 ? value(row[directionIndex]) : ''].join(' '))) throw new Error('涉及退款、转账、还款或投资等，需人工核对后记账');
      if (statusIndex >= 0 && !['支付成功', '交易成功', '已收款', '已支付', '已完成', '成功', '完成'].includes(status)) throw new Error('交易未成功或状态不明确，已跳过');
      if (currencyIndex >= 0 && !['', 'CNY', 'RMB', '人民币', '人民币元', '156'].includes(value(row[currencyIndex]).toUpperCase())) throw new Error('仅支持人民币交易');
      let type: 2 | 3;
      let amount: number;
      if (incomeIndex >= 0 && expenseIndex >= 0) {
        const income = value(row[incomeIndex]), expense = value(row[expenseIndex]);
        const present = (text:string) => text !== '' && text !== '-' && !/^0(?:\.0{1,2})?$/.test(text);
        if (present(income) === present(expense)) throw new Error('收入支出列无法确定唯一方向');
        type = present(income) ? 2 : 3;
        amount = cents(type === 2 ? income : expense);
      } else if (directionIndex >= 0) {
        const direction = value(row[directionIndex]);
        if (!['收入', '支出'].includes(direction)) throw new Error('收支方向不明确，已跳过');
        type = direction === '收入' ? 2 : 3;
        amount = cents(row[amountIndex]);
      } else {
        const signed = cents(row[amountIndex], true);
        if (credit && signed < 0) throw new Error('信用卡负金额可能为退款或还款，需人工核对');
        type = credit || signed < 0 ? 3 : 2;
        amount = Math.abs(signed);
      }
      const time = chinaTime(row[dateIndex], clockIndex !== dateIndex ? row[clockIndex] : undefined);
      const id = idIndex < 0 ? undefined : row[idIndex];
      if (typeof id === 'number' && !Number.isSafeInteger(id)) throw new Error('交易单号已丢失精度，请以文本格式重新导出');
      const sourceId = value(id).replace(/^'/, '');
      if (/^\d+(?:\.\d+)?[eE][+-]?\d+$/.test(sourceId)) throw new Error('交易单号为科学计数法，请以文本格式重新导出');
      const comment = [...new Set(descriptions)].join(' · ');
      if (comment.length > 2000 || sourceId.length > 200) throw new Error('备注或交易单号过长，请核对原始行');
      result.rows.push({rowNumber: i + 1, ...(sourceId && sourceId !== '/' && sourceId !== '-' ? {sourceId} : {}), time, type, amount, comment});
    } catch (error) {
      result.issues.push({rowNumber: i + 1, message: error instanceof Error ? error.message : '无法解析此行'});
    }
    if (result.rows.length > 1000) throw new Error('每次最多导入 1000 条有效流水，请按日期拆分账单后重试');
  }
  return result;
}

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === ',' || c === '\n' || c === '\r') {
      row.push(cell); cell = ''; closed = false;
      if (c !== ',') { rows.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++; }
    } else if (c === '"' && cell === '' && !closed) quoted = true;
    else if (closed) { if (c !== ' ' && c !== '\t') throw new Error('CSV 引号后的内容无效'); }
    else if (c === '"') throw new Error('CSV 引号格式无效');
    else cell += c;
  }
  if (quoted) throw new Error('CSV 引号未闭合，请重新导出文件');
  if (cell || row.length || closed) { row.push(cell); rows.push(row); }
  return rows;
}

export async function parseStatement(file: File): Promise<ParsedStatement> {
  if (file.size > 5 * 1024 * 1024) throw new Error('文件不能超过 5 MB，请按日期拆分后重试');
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension === 'xls') throw new Error('暂不支持旧版 .xls，请另存为 .xlsx 或 CSV');
  if (extension === 'pdf') throw new Error('暂不支持 PDF 账单，请导出 CSV 或 XLSX');
  if (extension !== 'csv' && extension !== 'xlsx') throw new Error('请选择 CSV 或 XLSX 账单');
  const bytes = await file.arrayBuffer();
  if (extension === 'xlsx') {
    try {
      const { default: read } = await import('read-excel-file/browser');
      const sheets = await read(bytes);
      if (sheets.length !== 1) throw new Error('请将需要导入的账单单独保存为一个工作表');
      return parseStatementRows(sheets[0].data);
    } catch (error) {
      throw new Error(`XLSX 读取失败：${error instanceof Error ? error.message : '请检查文件是否加密或损坏'}`);
    }
  }
  let text: string;
  try { text = new TextDecoder('utf-8', {fatal:true}).decode(bytes); }
  catch { try { text = new TextDecoder('gb18030', {fatal:true}).decode(bytes); } catch { throw new Error('CSV 编码无法识别，请另存为 UTF-8 CSV'); } }
  return parseStatementRows(csvRows(text.replace(/^\uFEFF/, '')));
}
