import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStatement, parseStatementRows } from './statement-parser';

const generic = ['日期', '类型', '金额', '备注', '交易单号', '币种'];
const wx = ['交易时间', '交易类型', '交易对方', '商品', '收/支', '金额(元)', '支付方式', '当前状态', '交易单号', '商户单号', '备注'];
test('generic exact cents, China time and stable string ID', () => {
  const result = parseStatementRows([generic, ['2026-10-01 08:09:10', '支出', '0.29', '早餐', '00012345678901234567890', 'CNY']]);
  assert.equal(result.provider, 'generic');
  assert.equal(result.rows[0].amount, 29);
  assert.equal(result.rows[0].time, Date.parse('2026-10-01T08:09:10+08:00') / 1000);
  assert.equal(result.rows[0].sourceId, '00012345678901234567890');
});
test('wechat preamble, failed, refund and transfer rows are never expenses', () => {
  const row = (kind:string,status:string,id:string) => ['2026-10-01 12:00:00',kind,'商店','食品','支出','¥12.30','零钱',status,id,'',''];
  const result = parseStatementRows([['微信支付账单明细'], [], wx, row('商户消费','支付成功','001'),row('商户消费','支付失败','002'),row('商户消费','已全额退款','003'),row('转账','支付成功','004'),wx,['共4笔记录']]);
  assert.equal(result.provider,'wechat');
  assert.equal(result.rows.length,1);
  assert.equal(result.rows[0].rowNumber,4);
  assert.equal(result.issues.length,3);
});
test('alipay transaction ID, successful income and pending rows', () => {
  const result = parseStatementRows([['支付宝交易记录明细查询'],['交易号','创建时间','交易对方','商品名称','金额（元）','收/支','交易状态'],['2026100000000000001','2026/10/01 10:00:00','公司','工资','1,234.56','收入','交易成功'],['2','2026/10/01','店','衣服','10','支出','等待付款']]);
  assert.equal(result.provider,'alipay');
  assert.equal(result.rows[0].type,2);
  assert.equal(result.rows[0].amount,123456);
  assert.equal(result.issues.length,1);
});
test('CMB debit signed transaction amount and credit dual columns', () => {
  const debit = parseStatementRows([['招商银行交易流水'],['交易日期','交易时间','收入','支出','交易摘要','流水号'],['20261001','12:34:56','','29.01','消费','0001']]);
  assert.equal(debit.provider,'cmb'); assert.equal(debit.rows[0].amount,2901);
  const signed = parseStatementRows([['招商银行'],['交易日期','交易金额','交易摘要'],['2026-10-01','-20.30','消费'],['2026-10-02','100','工资']]);
  assert.deepEqual(signed.rows.map(r=>r.type),[3,2]);
  const credit = parseStatementRows([['招商银行信用卡'],['交易日','记账日','交易摘要','人民币金额'],['2026-10-01','2026-10-02','商户消费','80'],['2026-10-02','2026-10-03','还款','-80']]);
  assert.equal(credit.rows[0].type,3);assert.equal(credit.issues.length,1);
});
test('unknown or ambiguous credit templates rejected; invalid rows are reported', () => {
  assert.throws(()=>parseStatementRows([['foo','bar'],['x',1]]),/表头/);
  const result = parseStatementRows([generic,['2026-02-30','支出','1','','','CNY'],['2026-10-01','支出','1.001','','','CNY'],['2026-10-01','支出','2','','','USD'],['2026-10-01','转账','2','','','CNY'],['2026-10-01','支出','-2','','','CNY']]);
  assert.equal(result.rows.length,0);assert.equal(result.issues.length,5);
});
test('Excel serial dates and date cells are wall clock China time; unsafe numeric IDs rejected', () => {
  const result = parseStatementRows([generic,[46296.5,'支出',0.29,'', '001','CNY'],[new Date('2026-10-01T00:00:00Z'),'收入','10','','002','CNY'],['2026-10-01','支出','1','',12345678901234567890,'CNY']]);
  assert.equal(result.rows[0].time,Date.parse('2026-10-01T12:00:00+08:00')/1000);
  assert.equal(result.rows[1].time,Date.parse('2026-10-01T00:00:00+08:00')/1000);
  assert.equal(result.issues.length,1);
});
test('app exported header round trips and preserves repeated equal purchases', () => {
  const header=['日期（北京时间）','类型','账户','分类','金额','币种','备注'];
  const row=['2026-10-01','支出','银行卡','餐饮','1.23','CNY','早餐'];
  assert.equal(parseStatementRows([header,row,row]).rows.length,2);
});
test('CSV BOM, quoted multiline comments and escaped quotes', async () => {
  const file = new File(['\ufeff日期,类型,金额,备注\r\n2026-10-01,支出,0.29,"早餐\n""很好"""\r\n'], 'test.csv');
  const parsed = await parseStatement(file);
  assert.equal(parsed.rows[0].comment,'早餐\n"很好"');
  await assert.rejects(parseStatement(new File(['日期,类型,金额\n"unterminated'], 'bad.csv')),/CSV/);
});
test('GB18030 fallback and unsupported file feedback', async () => {
  const bytes = Uint8Array.from([0xc8,0xd5,0xc6,0xda,0x2c,0xc0,0xe0,0xd0,0xcd,0x2c,0xbd,0xf0,0xb6,0xee,0x0a,...Buffer.from('2026-10-01,'),0xd6,0xa7,0xb3,0xf6,...Buffer.from(',12.30')]);
  assert.equal((await parseStatement(new File([bytes], 'gbk.csv'))).rows[0].amount,1230);
  await assert.rejects(parseStatement(new File([''], 'file.xls')),/xlsx|XLSX/);
  await assert.rejects(parseStatement(new File([''], 'file.pdf')),/PDF/);
  await assert.rejects(parseStatement(new File([new Uint8Array(5*1024*1024+1)], 'large.csv')),/5 MB/);
});
test('more than 1000 valid rows explicitly rejected', () => {
  assert.throws(()=>parseStatementRows([generic,...Array.from({length:1001},()=>['2026-10-01','支出','1','','','CNY'])]),/1000/);
});
test('CMB workbook fixture headers and source ID match browser contract', () => {
  const result = parseStatementRows([['招商银行交易流水'],['交易日期','支出','收入','摘要','交易流水号','币种'],['2025-03-15','8.20','','公交消费','cmb-001','人民币']]);
  assert.equal(result.provider,'cmb');
  assert.deepEqual(result.rows, [{rowNumber:3,sourceId:'cmb-001',time:Date.parse('2025-03-15T00:00:00+08:00')/1000,type:3,amount:820,comment:'公交消费'}]);
  assert.deepEqual(result.issues,[]);
});
test('ambiguous credit headers and unsafe financial values cannot become valid rows', () => {
  assert.throws(()=>parseStatementRows([['招商银行信用卡'],['交易日期','交易金额'],['2026-10-01','12']]),/模板暂不支持/);
  const result = parseStatementRows([generic,...['1,23.45','1e3','90071992547409.92','0','NaN'].map(amount=>['2026-10-01','支出',amount,'','','CNY'])]);
  assert.equal(result.rows.length,0);
  assert.equal(result.issues.length,5);
});
