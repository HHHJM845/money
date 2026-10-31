-- 2026-10-29 / Android采集验证版：首次创建本机 SQLite 数据结构。
-- 仅记录 Android 本机结构历史，不在 Supabase 执行；不创建外键。
-- entries：本机识别候选与已确认流水。
CREATE TABLE IF NOT EXISTS entries (
  id TEXT NOT NULL PRIMARY KEY, -- 本机流水标识
  eventKey TEXT NOT NULL, -- 来源事件幂等标识（不保存原文）
  time INTEGER NOT NULL, -- 记录时间，毫秒
  amountCents INTEGER NOT NULL, -- 整数分；待确认未知金额为零
  type TEXT NOT NULL, -- 收入、支出、转账、退款或未知
  merchant TEXT NOT NULL, -- 商户或备注
  category TEXT NOT NULL, -- 分类名
  accountId TEXT NOT NULL, -- 云端账户标识，未指定为空串
  status TEXT NOT NULL, -- 待确认、正式或已忽略
  source TEXT NOT NULL, -- 来源包名或手动/云端
  reason TEXT NOT NULL, -- 待核对原因
  remoteId TEXT -- 云端流水标识，未上传为空
);
CREATE UNIQUE INDEX IF NOT EXISTS index_entries_eventKey ON entries(eventKey);
-- accounts：云端人民币账户缓存。
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT NOT NULL PRIMARY KEY, -- 云端账户标识
  name TEXT NOT NULL -- 账户名称
);

-- 2026-10-29 / Android采集验证版：冻结上传请求，防止响应丢失后修改导致重复入账。
ALTER TABLE entries ADD COLUMN uploadPayload TEXT; -- 首次上传前冻结的请求，成功后清空

-- 2026-10-30 / P1 Android offline-first / Room 1→2：保留 entries/accounts 及旧请求，无外键。
-- bill_records：云端基准与本机覆盖分开保存。
CREATE TABLE IF NOT EXISTS bill_records (
  billId TEXT NOT NULL PRIMARY KEY, -- 稳定账单 UUID
  serverJson TEXT, -- 云端已确认版本
  localJson TEXT, -- 本机尚未确认的最新输入
  sourcesJson TEXT NOT NULL, -- 结构化来源，无整段原文
  expired INTEGER NOT NULL, -- 不可复活的过期标记
  restoreStatus TEXT NOT NULL -- 删除前入账状态
);
-- outbox：请求发送前冻结，重启或丢响应后重放原文。
CREATE TABLE IF NOT EXISTS outbox (
  position INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, -- 提交顺序
  operationId TEXT NOT NULL, -- 幂等 UUID
  billId TEXT NOT NULL, -- 账单 UUID
  action TEXT NOT NULL, -- 保存、删除、恢复
  draft TEXT NOT NULL, -- 待发送内容
  request TEXT, -- 完整冻结请求
  state TEXT NOT NULL, -- 队列状态
  error TEXT NOT NULL, -- 失败原因
  predecessor TEXT -- 同账单前一操作 UUID
);
CREATE UNIQUE INDEX IF NOT EXISTS index_outbox_operationId ON outbox(operationId);
CREATE INDEX IF NOT EXISTS index_outbox_billId ON outbox(billId);
-- master_records：同一高水位的主数据快照。
CREATE TABLE IF NOT EXISTS master_records (
  kind TEXT NOT NULL, -- 主数据类型
  id TEXT NOT NULL, -- 主数据标识
  json TEXT NOT NULL, -- 完整缓存
  PRIMARY KEY(kind,id)
);
-- sync_state：完整发布与暂存位置分别保存。
CREATE TABLE IF NOT EXISTS sync_state (
  id INTEGER NOT NULL PRIMARY KEY, -- 固定单账本
  cursor TEXT NOT NULL, -- 已发布序号
  initialized INTEGER NOT NULL, -- 完成初始化
  stageCursor TEXT, -- 已暂存分页位置
  lastSuccess INTEGER NOT NULL, -- 最近成功毫秒
  error TEXT NOT NULL, -- 同步错误
  authExpired INTEGER NOT NULL -- 登录过期
);
-- sync_stage：尾页之前仅暂存。
CREATE TABLE IF NOT EXISTS sync_stage (
  kind TEXT NOT NULL, -- 实体类型
  entityId TEXT NOT NULL, -- 实体标识
  json TEXT NOT NULL, -- 最新事件快照
  PRIMARY KEY(kind,entityId)
);
-- legacy_links：旧版 ID 与新版 ID 映射。
CREATE TABLE IF NOT EXISTS legacy_links (
  entryId TEXT NOT NULL PRIMARY KEY, -- 旧流水标识
  billId TEXT NOT NULL, -- 新账单 UUID
  waiting INTEGER NOT NULL -- 等待旧请求确认
);
-- bill_history：本机历史与账单/队列在同一事务记录。
CREATE TABLE IF NOT EXISTS bill_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, -- 历史顺序
  billId TEXT NOT NULL, -- 账单 UUID
  at INTEGER NOT NULL, -- 操作毫秒
  action TEXT NOT NULL, -- 操作类型
  snapshot TEXT NOT NULL -- 本机操作后状态
);
CREATE INDEX IF NOT EXISTS index_bill_history_billId ON bill_history(billId);

-- 2026-10-30 P1 同步一致性：复用 master_records，不改变表结构。
-- effect 保存与账户元数据同一游标的 appliedEffect；提交确认不得提前替换该基线。
-- missing 保留恢复后缺失云端身份的诊断；notice 保留旧版过期请求清理提示。
-- 2026-10-30 P1 过期余额保护：uncertain 只保存受影响账户标识，不保存账单内容；
-- 在终止过期请求和尾页主数据更新之间明确标记余额待核对，同步发布后清除。
