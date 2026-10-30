-- Android 本机 SQLite 账本；不在 Supabase 执行。Room version 1 初始结构，无迁移文件或外键。
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
