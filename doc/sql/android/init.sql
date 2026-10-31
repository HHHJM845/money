-- Android 本机 SQLite 账本；不在 Supabase 执行。Room version 2 最终结构，无外键。
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
  remoteId TEXT, -- 云端流水标识，未上传为空
  uploadPayload TEXT -- 首次上传前冻结的请求，用于结果未知时安全重试
);
CREATE UNIQUE INDEX IF NOT EXISTS index_entries_eventKey ON entries(eventKey);
-- accounts：云端人民币账户缓存。
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT NOT NULL PRIMARY KEY, -- 云端账户标识
  name TEXT NOT NULL -- 账户名称
);

-- bill_records：云端基准与本机覆盖分开，确认旧操作不会覆盖后续编辑。
CREATE TABLE IF NOT EXISTS bill_records (
  billId TEXT NOT NULL PRIMARY KEY, -- 稳定账单 UUID
  serverJson TEXT, -- 云端已确认版本，含余额模式及变更序号
  localJson TEXT, -- 本机最新业务状态；云端确认前保留
  sourcesJson TEXT NOT NULL, -- 结构化来源证据，不保存通知或页面原文
  expired INTEGER NOT NULL, -- 内容过期墓碑，禁止旧请求复活
  restoreStatus TEXT NOT NULL -- 删除前入账状态
);
-- outbox：本机操作队列；request 一旦发送永久冻结。
CREATE TABLE IF NOT EXISTS outbox (
  position INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, -- 本机提交顺序
  operationId TEXT NOT NULL, -- 稳定幂等 UUID
  billId TEXT NOT NULL, -- 账单 UUID
  action TEXT NOT NULL, -- 保存、删除或恢复
  draft TEXT NOT NULL, -- 尚未发送的操作内容
  request TEXT, -- 首次发送前冻结的完整请求和预期版本
  state TEXT NOT NULL, -- queued/sending/unknown/failed/conflict
  error TEXT NOT NULL, -- 可诊断失败原因
  predecessor TEXT -- 同账单前一操作 UUID
);
CREATE UNIQUE INDEX IF NOT EXISTS index_outbox_operationId ON outbox(operationId);
CREATE INDEX IF NOT EXISTS index_outbox_billId ON outbox(billId);
-- master_records：账户、分类、标签及同一高水位的实际余额影响基线缓存。
CREATE TABLE IF NOT EXISTS master_records (
  kind TEXT NOT NULL, -- account/category/tag/effect/uncertain/missing/notice
  id TEXT NOT NULL, -- 主数据标识字符串
  json TEXT NOT NULL, -- 云端快照、实际影响或恢复诊断；未知余额保持空值
  PRIMARY KEY(kind,id)
);
-- sync_state：发布游标与分页暂存游标；尾页统一发布。
CREATE TABLE IF NOT EXISTS sync_state (
  id INTEGER NOT NULL PRIMARY KEY, -- 单账本固定为 1
  cursor TEXT NOT NULL, -- 已完整发布的十进制序号
  initialized INTEGER NOT NULL, -- 初次一致性快照是否成功
  stageCursor TEXT, -- 已持久暂存但未发布的分页位置
  lastSuccess INTEGER NOT NULL, -- 最近完整同步成功毫秒
  error TEXT NOT NULL, -- 同步错误
  authExpired INTEGER NOT NULL -- 独立登录过期状态
);
-- sync_stage：分页中断时保留事件，不混合发布不同高水位的主数据。
CREATE TABLE IF NOT EXISTS sync_stage (
  kind TEXT NOT NULL, -- 实体类型
  entityId TEXT NOT NULL, -- 实体标识
  json TEXT NOT NULL, -- 最新暂存快照
  PRIMARY KEY(kind,entityId)
);
-- legacy_links：保留旧流水身份与新版账单映射。
CREATE TABLE IF NOT EXISTS legacy_links (
  entryId TEXT NOT NULL PRIMARY KEY, -- 原 entries 标识
  billId TEXT NOT NULL, -- 新版账单 UUID
  waiting INTEGER NOT NULL -- 旧版请求尚待确认时禁止编辑
);
-- bill_history：本机业务变更历史；内容过期时清除。
CREATE TABLE IF NOT EXISTS bill_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, -- 历史顺序
  billId TEXT NOT NULL, -- 账单 UUID
  at INTEGER NOT NULL, -- 操作时间毫秒
  action TEXT NOT NULL, -- 本机操作
  snapshot TEXT NOT NULL -- 操作后本机状态
);
CREATE INDEX IF NOT EXISTS index_bill_history_billId ON bill_history(billId);
