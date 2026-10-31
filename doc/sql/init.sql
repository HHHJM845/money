BEGIN;
CREATE TABLE money_accounts (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 category integer NOT NULL CHECK(category BETWEEN 1 AND 9),
 currency text NOT NULL DEFAULT 'CNY' CHECK(currency = 'CNY'),
 balance bigint CHECK(balance BETWEEN -9007199254740991 AND 9007199254740991),
 active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version>0)
);
COMMENT ON TABLE money_accounts IS '个人账本账户';
COMMENT ON COLUMN money_accounts.id IS '账户编号';
COMMENT ON COLUMN money_accounts.name IS '账户名称';
COMMENT ON COLUMN money_accounts.category IS '账户类别';
COMMENT ON COLUMN money_accounts.currency IS '币种，首版仅人民币';
COMMENT ON COLUMN money_accounts.balance IS '可选账面余额，单位分，空值表示未设置，负数表示负债';
COMMENT ON COLUMN money_accounts.active IS '账户是否启用，停用后历史账单仍保留';
COMMENT ON COLUMN money_accounts.version IS '账户设置版本，余额交易不单独递增此版本';
CREATE TABLE money_categories (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 type integer NOT NULL CHECK(type BETWEEN 1 AND 3),
 parent_id bigint,
 active boolean NOT NULL DEFAULT true,
 sort_order integer NOT NULL DEFAULT 0,
 version integer NOT NULL DEFAULT 1 CHECK(version>0)
);
COMMENT ON TABLE money_categories IS '支持两级的交易分类';
COMMENT ON COLUMN money_categories.id IS '分类编号';
COMMENT ON COLUMN money_categories.name IS '分类名称';
COMMENT ON COLUMN money_categories.type IS '分类类型：一收入、二支出、三转账';
COMMENT ON COLUMN money_categories.parent_id IS '一级分类编号，空值表示一级分类，由应用层校验层级';
COMMENT ON COLUMN money_categories.active IS '分类是否启用，历史分类停用而不删除';
COMMENT ON COLUMN money_categories.sort_order IS '显示排序';
COMMENT ON COLUMN money_categories.version IS '分类设置版本，修改需匹配预期版本';
INSERT INTO money_categories(name,type) VALUES ('工资',1),('其他收入',1),('餐饮',2),('购物',2),('交通',2),('其他支出',2),('账户互转',3);
CREATE TABLE money_transactions (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 type integer NOT NULL CHECK(type IN (2,3,4)),
 time bigint NOT NULL CHECK(time BETWEEN 0 AND 253402271999),
 category_id bigint NOT NULL,
 source_account_id bigint NOT NULL,
 destination_account_id bigint,
 source_amount bigint NOT NULL CHECK(source_amount BETWEEN 1 AND 9007199254740991),
 destination_amount bigint,
 comment text NOT NULL DEFAULT '' CHECK(length(comment) <= 2000),
 CHECK((type = 4 AND destination_account_id IS NOT NULL AND destination_account_id <> source_account_id AND destination_amount IS NOT NULL AND destination_amount = source_amount)
 OR (type IN (2,3) AND destination_account_id IS NULL AND destination_amount IS NULL))
);
COMMENT ON TABLE money_transactions IS '交易流水，余额与流水在同一事务写入';
COMMENT ON COLUMN money_transactions.id IS '交易编号及分页序号';
COMMENT ON COLUMN money_transactions.type IS '交易类型：二收入、三支出、四转账';
COMMENT ON COLUMN money_transactions.time IS '交易时间，Unix秒';
COMMENT ON COLUMN money_transactions.category_id IS '分类编号，应用层校验';
COMMENT ON COLUMN money_transactions.source_account_id IS '记账账户编号';
COMMENT ON COLUMN money_transactions.destination_account_id IS '转入账户编号';
COMMENT ON COLUMN money_transactions.source_amount IS '交易金额，单位分';
COMMENT ON COLUMN money_transactions.destination_amount IS '转入金额，单位分';
COMMENT ON COLUMN money_transactions.comment IS '交易备注';
CREATE TABLE money_requests (
 key text PRIMARY KEY CHECK(length(key) BETWEEN 1 AND 128),
 payload_hash text NOT NULL,
 response jsonb
);
COMMENT ON TABLE money_requests IS '持久化幂等请求，随业务事务一起提交';
COMMENT ON COLUMN money_requests.key IS '客户端请求唯一编号';
COMMENT ON COLUMN money_requests.payload_hash IS '规范化请求及路由摘要，防止编号重复用于不同请求';
COMMENT ON COLUMN money_requests.response IS '原始成功响应，事务完成前为空';
CREATE TABLE money_login_limits (
 key text PRIMARY KEY,
 window_start timestamptz NOT NULL,
 attempts integer NOT NULL CHECK(attempts >= 0)
);
COMMENT ON TABLE money_login_limits IS '单用户登录固定窗口限流记录';
COMMENT ON COLUMN money_login_limits.key IS '限流键，认证层使用owner';
COMMENT ON COLUMN money_login_limits.window_start IS '当前十五分钟窗口开始时间';
COMMENT ON COLUMN money_login_limits.attempts IS '窗口内尝试次数，认证层限制十次';
-- 仅服务端表所有者访问；不创建公开策略，拒绝 Data API 的 anon/authenticated 行访问。
-- 不使用 FORCE ROW LEVEL SECURITY，保留表所有者的服务端访问能力。
ALTER TABLE money_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_login_limits ENABLE ROW LEVEL SECURITY;
CREATE TABLE money_tags (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 active boolean NOT NULL DEFAULT true,
 sort_order integer NOT NULL DEFAULT 0,
 version integer NOT NULL DEFAULT 1 CHECK(version>0)
);
COMMENT ON TABLE money_tags IS '账单可选标签';
COMMENT ON COLUMN money_tags.id IS '标签编号';
COMMENT ON COLUMN money_tags.name IS '标签名称';
COMMENT ON COLUMN money_tags.active IS '标签是否启用';
COMMENT ON COLUMN money_tags.sort_order IS '显示排序';
COMMENT ON COLUMN money_tags.version IS '标签设置版本，修改需匹配预期版本';
CREATE TABLE money_ledger_state (
 id smallint PRIMARY KEY CHECK(id=1),
 sequence bigint NOT NULL DEFAULT 0 CHECK(sequence>=0)
);
INSERT INTO money_ledger_state(id) VALUES(1);
COMMENT ON TABLE money_ledger_state IS '单用户账本写锁及按提交顺序递增的变更游标';
COMMENT ON COLUMN money_ledger_state.id IS '固定为一的账本编号';
COMMENT ON COLUMN money_ledger_state.sequence IS '最后提交的变更序号，接口使用整数串';
CREATE TABLE money_bills (
 id uuid PRIMARY KEY,
 legacy_id bigint UNIQUE,
 version integer NOT NULL CHECK(version>0),
 status text NOT NULL CHECK(status IN ('pending','posted','deleted')),
 content jsonb NOT NULL CHECK(jsonb_typeof(content)='object'),
 balance_mode text NOT NULL CHECK(balance_mode IN ('apply','preserve')),
 applied_effect jsonb NOT NULL CHECK(jsonb_typeof(applied_effect)='object'),
 restore_effect jsonb NOT NULL CHECK(jsonb_typeof(restore_effect)='object'),
 restore_status text NOT NULL CHECK(restore_status IN ('pending','posted')),
 created_at bigint NOT NULL,
 updated_at bigint NOT NULL,
 deleted_at bigint,
 CHECK((status='deleted')=(deleted_at IS NOT NULL))
);
CREATE INDEX money_bills_refund_idx ON money_bills((content->>'refundOfBillId'));
COMMENT ON TABLE money_bills IS '权威账单，旧流水表为兼容投影';
COMMENT ON COLUMN money_bills.id IS '客户端稳定账单标识，旧流水使用确定性映射';
COMMENT ON COLUMN money_bills.legacy_id IS '保留的旧流水编号，待确认或退款可为空';
COMMENT ON COLUMN money_bills.version IS '实体版本，修改需匹配预期版本';
COMMENT ON COLUMN money_bills.status IS '业务状态：待确认、已入账、已删除';
COMMENT ON COLUMN money_bills.content IS '结构化账单：类型、整数分金额、发生毫秒、账户、分类、商户、备注、标签、统计和预算开关、退款原账';
COMMENT ON COLUMN money_bills.balance_mode IS '余额模式：实际应用或保留现有余额';
COMMENT ON COLUMN money_bills.applied_effect IS '当前实际已应用的各账户余额影响，单位分';
COMMENT ON COLUMN money_bills.restore_effect IS '删除前实际影响，恢复只重放一次';
COMMENT ON COLUMN money_bills.restore_status IS '删除前业务状态';
COMMENT ON COLUMN money_bills.created_at IS '录入时间，Unix毫秒';
COMMENT ON COLUMN money_bills.updated_at IS '最后修改时间，Unix毫秒';
COMMENT ON COLUMN money_bills.deleted_at IS '删除时间，Unix毫秒，空值表示未删除';
CREATE TABLE money_bill_sources (
 app text NOT NULL CHECK(length(app) BETWEEN 1 AND 100),
 key text NOT NULL CHECK(length(key) BETWEEN 1 AND 256),
 bill_id uuid NOT NULL,
 captured_at bigint NOT NULL,
 rule_version text NOT NULL CHECK(length(rule_version) BETWEEN 1 AND 100),
 PRIMARY KEY(app,key)
);
CREATE INDEX money_bill_sources_bill_idx ON money_bill_sources(bill_id);
COMMENT ON TABLE money_bill_sources IS '账单最小来源证据，同一来源标识只关联一笔账';
COMMENT ON COLUMN money_bill_sources.app IS '来源应用或导入范围';
COMMENT ON COLUMN money_bill_sources.key IS '来源范围内交易标识或摘要，不保存页面原文';
COMMENT ON COLUMN money_bill_sources.bill_id IS '关联账单标识，由应用层校验';
COMMENT ON COLUMN money_bill_sources.captured_at IS '采集时间，Unix毫秒';
COMMENT ON COLUMN money_bill_sources.rule_version IS '识别规则版本';
CREATE TABLE money_changes (
 sequence bigint PRIMARY KEY,
 bill_id uuid,
 snapshot jsonb NOT NULL,
 entity_type text NOT NULL DEFAULT 'bill' CHECK(entity_type IN ('bill','account','category','tag')),
 entity_id text,
 CONSTRAINT money_changes_identity_check CHECK(
  (entity_type='bill' AND bill_id IS NOT NULL AND entity_id IS NULL)
  OR (entity_type<>'bill' AND bill_id IS NULL AND entity_id IS NOT NULL))
);
CREATE INDEX money_changes_bill_idx ON money_changes(bill_id,sequence DESC);
COMMENT ON TABLE money_changes IS '按提交顺序的账单与主数据变更，保留删除版本';
COMMENT ON COLUMN money_changes.sequence IS '服务端变更序号，不能使用业务发生时间替代';
COMMENT ON COLUMN money_changes.bill_id IS '账单变更的稳定标识，主数据变更为空';
COMMENT ON COLUMN money_changes.snapshot IS '提交时的版本快照，过期删除需清理完整内容';
COMMENT ON COLUMN money_changes.entity_type IS '变更实体类型：账单、账户、分类或标签';
COMMENT ON COLUMN money_changes.entity_id IS '主数据实体编号，账单使用独立的稳定标识列';
CREATE TABLE money_balance_history (
 sequence bigint NOT NULL,
 account_id bigint NOT NULL,
 bill_id uuid,
 delta bigint CHECK(delta BETWEEN -9007199254740991 AND 9007199254740991),
 balance_after bigint CHECK(balance_after BETWEEN -9007199254740991 AND 9007199254740991),
 reason text NOT NULL CHECK(reason IN ('save','delete','restore','balance')),
 note text NOT NULL DEFAULT '',
 PRIMARY KEY(sequence,account_id)
);
COMMENT ON TABLE money_balance_history IS '每次账单操作或显式余额校正的实际变化';
COMMENT ON COLUMN money_balance_history.sequence IS '引起变化的提交序号';
COMMENT ON COLUMN money_balance_history.account_id IS '账户编号';
COMMENT ON COLUMN money_balance_history.bill_id IS '关联账单标识，显式余额操作为空';
COMMENT ON COLUMN money_balance_history.delta IS '本次实际增减，整数分，未知余额转换为空';
COMMENT ON COLUMN money_balance_history.balance_after IS '本次操作后的账面余额，整数分，停用余额为空';
COMMENT ON COLUMN money_balance_history.reason IS '新增修改、删除、恢复或显式余额操作';
COMMENT ON COLUMN money_balance_history.note IS '显式余额操作的用户说明';
ALTER TABLE money_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_ledger_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_bill_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_balance_history ENABLE ROW LEVEL SECURITY;
COMMIT;
