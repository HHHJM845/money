-- 2026-10-29 Vercel PostgreSQL 单用户账本初始结构；仅执行一次，由部署方记录执行状态。
BEGIN;
CREATE TABLE money_accounts (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 category integer NOT NULL CHECK(category BETWEEN 1 AND 9),
 currency text NOT NULL DEFAULT 'CNY' CHECK(currency = 'CNY'),
 balance bigint NOT NULL CHECK(balance BETWEEN -9007199254740991 AND 9007199254740991)
);
COMMENT ON TABLE money_accounts IS '个人账本账户';
COMMENT ON COLUMN money_accounts.id IS '账户编号';
COMMENT ON COLUMN money_accounts.name IS '账户名称';
COMMENT ON COLUMN money_accounts.category IS '账户类别';
COMMENT ON COLUMN money_accounts.currency IS '币种，首版仅人民币';
COMMENT ON COLUMN money_accounts.balance IS '当前余额，单位分，负数表示负债';
CREATE TABLE money_categories (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 type integer NOT NULL CHECK(type BETWEEN 1 AND 3)
);
COMMENT ON TABLE money_categories IS '平铺交易分类';
COMMENT ON COLUMN money_categories.id IS '分类编号';
COMMENT ON COLUMN money_categories.name IS '分类名称';
COMMENT ON COLUMN money_categories.type IS '分类类型：一收入、二支出、三转账';
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
COMMIT;

-- 2026-10-29 Supabase Data API 隔离：已有部署仅执行本新增段，保留初始建表历史。
BEGIN;
-- 不创建公开策略且不使用 FORCE，服务端表所有者可访问，普通 API 角色默认拒绝。
ALTER TABLE money_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_login_limits ENABLE ROW LEVEL SECURITY;
COMMIT;

-- 2026-10-30 自动收支记账结构基线：升级既有五表并新增标签/来源/操作/余额历史/变更/删除标记六表。
-- 依据 docs/superpowers/specs/2026-10-30-auto-bookkeeping-design.md；随 M2 代码一起在隔离库验证后执行，结果与当日 init.sql 空库结构等价。
-- 商户规则、账户线索映射、模板、周期规则、预算等表随所属交付阶段（M4/M5/M6）追加，不在本段发明。
BEGIN;
-- 账户：区分启用/未启用余额；已有部署的余额一直由流水维护，迁移视为已启用，新账户默认未启用。
ALTER TABLE money_accounts ADD COLUMN balance_enabled boolean NOT NULL DEFAULT false;
UPDATE money_accounts SET balance_enabled = true;
ALTER TABLE money_accounts ALTER COLUMN balance DROP NOT NULL;
COMMENT ON COLUMN money_accounts.balance IS '账面余额，单位分，负数表示负债；未启用余额时为空，不能补零';
COMMENT ON COLUMN money_accounts.balance_enabled IS '是否启用账面余额；未启用时余额未知，交易仍可入账';
-- 分类：一级/二级层级、排序与停用；旧分类保持一级且不停用，子分类类型与父一致由应用层校验。
ALTER TABLE money_categories ADD COLUMN parent_id bigint;
ALTER TABLE money_categories ADD COLUMN sort_order integer NOT NULL DEFAULT 0;
ALTER TABLE money_categories ADD COLUMN deactivated boolean NOT NULL DEFAULT false;
ALTER TABLE money_categories ADD CONSTRAINT money_categories_check CHECK(parent_id IS NULL OR parent_id <> id);
COMMENT ON TABLE money_categories IS '层级交易分类，一级/二级';
COMMENT ON COLUMN money_categories.type IS '分类类型：一收入、二支出、三转账；子分类须与父一致，应用层校验';
COMMENT ON COLUMN money_categories.parent_id IS '父分类编号，空为一级分类，不创建外键';
COMMENT ON COLUMN money_categories.sort_order IS '同层显示排序';
COMMENT ON COLUMN money_categories.deactivated IS '停用标志；历史分类停用不删除，停用分类不得用于新账单';
-- 账单：稳定标识、版本、状态与三时间；待确认允许字段不全，退款关联原账，已应用余额影响单独保存。
ALTER TABLE money_transactions ADD COLUMN stable_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE money_transactions ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK(version >= 1);
ALTER TABLE money_transactions ADD COLUMN status text NOT NULL DEFAULT 'posted' CHECK(status IN ('pending','posted','deleted'));
ALTER TABLE money_transactions ADD COLUMN occurred_at bigint CHECK(occurred_at BETWEEN 0 AND 253402271999999);
ALTER TABLE money_transactions ADD COLUMN created_at bigint CHECK(created_at BETWEEN 0 AND 253402271999999);
ALTER TABLE money_transactions ADD COLUMN updated_at bigint CHECK(updated_at BETWEEN 0 AND 253402271999999);
ALTER TABLE money_transactions ADD COLUMN merchant text NOT NULL DEFAULT '' CHECK(length(merchant) <= 100);
ALTER TABLE money_transactions ADD COLUMN original_bill_id bigint;
ALTER TABLE money_transactions ADD COLUMN applied_source_delta bigint CHECK(applied_source_delta BETWEEN -9007199254740991 AND 9007199254740991);
ALTER TABLE money_transactions ADD COLUMN applied_destination_delta bigint CHECK(applied_destination_delta BETWEEN -9007199254740991 AND 9007199254740991);
ALTER TABLE money_transactions ADD COLUMN exclude_statistics boolean NOT NULL DEFAULT false;
ALTER TABLE money_transactions ADD COLUMN exclude_budget boolean NOT NULL DEFAULT false;
ALTER TABLE money_transactions ADD COLUMN deleted_at bigint CHECK(deleted_at BETWEEN 0 AND 253402271999999);
ALTER TABLE money_transactions ALTER COLUMN source_account_id DROP NOT NULL;
ALTER TABLE money_transactions DROP CONSTRAINT money_transactions_type_check;
ALTER TABLE money_transactions ADD CONSTRAINT money_transactions_type_check CHECK(type BETWEEN 1 AND 5);
ALTER TABLE money_transactions DROP CONSTRAINT money_transactions_source_amount_check;
ALTER TABLE money_transactions ADD CONSTRAINT money_transactions_source_amount_check CHECK(source_amount BETWEEN 0 AND 9007199254740991);
ALTER TABLE money_transactions DROP CONSTRAINT money_transactions_check;
ALTER TABLE money_transactions ADD CONSTRAINT money_transactions_check CHECK((status <> 'posted')
 OR (source_amount >= 1
  AND (type = 5 OR original_bill_id IS NULL)
  AND ((type = 4 AND destination_account_id IS NOT NULL AND destination_account_id <> source_account_id AND destination_amount IS NOT NULL AND destination_amount = source_amount)
   OR (type IN (2,3,5) AND destination_account_id IS NULL AND destination_amount IS NULL AND (type <> 5 OR original_bill_id IS NOT NULL)))));
ALTER TABLE money_transactions ADD CONSTRAINT money_transactions_stable_id_key UNIQUE(stable_id);
-- 旧流水回填：秒转毫秒、按 v1 规则重建已应用余额影响；商户不猜测保持为空。
UPDATE money_transactions SET
 occurred_at = time * 1000,
 created_at = time * 1000,
 updated_at = time * 1000,
 applied_source_delta = CASE WHEN type = 2 THEN source_amount ELSE -source_amount END,
 applied_destination_delta = CASE WHEN type = 4 THEN destination_amount ELSE NULL END;
COMMENT ON TABLE money_transactions IS '账单，余额与流水在同一事务写入；待确认不计入统计、不改余额';
COMMENT ON COLUMN money_transactions.id IS '账单编号及分页序号，旧 bigint 编号保留';
COMMENT ON COLUMN money_transactions.stable_id IS '账单稳定标识，客户端生成 UUID；旧流水由迁移生成，此后不再改变';
COMMENT ON COLUMN money_transactions.version IS '账单版本，每次修改/删除/恢复递增；冲突用预期版本判断';
COMMENT ON COLUMN money_transactions.type IS '账单类型：一未知（仅待确认或已删除）、二收入、三支出、四转账、五退款';
COMMENT ON COLUMN money_transactions.status IS '账单状态：待确认/正式/已删除（回收站）；与同步状态分离';
COMMENT ON COLUMN money_transactions.time IS '交易时间，Unix秒；旧 v1 字段，由统一事务入口同步维护';
COMMENT ON COLUMN money_transactions.occurred_at IS '交易时间，Unix毫秒；新路由必填，跨端统一口径';
COMMENT ON COLUMN money_transactions.created_at IS '录入时间，Unix毫秒';
COMMENT ON COLUMN money_transactions.updated_at IS '最后修改时间，Unix毫秒';
COMMENT ON COLUMN money_transactions.category_id IS '分类编号，应用层校验停用状态';
COMMENT ON COLUMN money_transactions.source_account_id IS '记账账户编号，待确认可暂缺';
COMMENT ON COLUMN money_transactions.destination_account_id IS '转入账户编号，仅转账';
COMMENT ON COLUMN money_transactions.source_amount IS '账单金额，单位分；待确认未知金额为零';
COMMENT ON COLUMN money_transactions.destination_amount IS '转入金额，单位分，仅转账且与源金额相等';
COMMENT ON COLUMN money_transactions.merchant IS '商户名称，与备注分离；旧数据不猜测，保持为空';
COMMENT ON COLUMN money_transactions.comment IS '账单备注';
COMMENT ON COLUMN money_transactions.original_bill_id IS '退款关联的原账单编号；退款累计不超过原支出由事务校验';
COMMENT ON COLUMN money_transactions.applied_source_delta IS '已实际应用的转出账户余额影响，单位分；保留模式历史导入为空';
COMMENT ON COLUMN money_transactions.applied_destination_delta IS '已实际应用的转入账户余额影响，单位分，仅转账';
COMMENT ON COLUMN money_transactions.exclude_statistics IS '排除统计开关；实际余额变化不受影响';
COMMENT ON COLUMN money_transactions.exclude_budget IS '排除预算开关；实际余额变化不受影响';
COMMENT ON COLUMN money_transactions.deleted_at IS '进入回收站时间，Unix毫秒；空为未删除，三十天后到期清理';
CREATE TABLE money_tags (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 50),
 UNIQUE(name)
);
COMMENT ON TABLE money_tags IS '标签，跨分类查看开销，账单可多选且不强制';
COMMENT ON COLUMN money_tags.id IS '标签编号';
COMMENT ON COLUMN money_tags.name IS '标签名称，唯一';
CREATE TABLE money_transaction_tags (
 transaction_id bigint NOT NULL,
 tag_id bigint NOT NULL,
 PRIMARY KEY(transaction_id, tag_id)
);
COMMENT ON TABLE money_transaction_tags IS '账单与标签多对多关联';
COMMENT ON COLUMN money_transaction_tags.transaction_id IS '账单编号';
COMMENT ON COLUMN money_transaction_tags.tag_id IS '标签编号';
CREATE TABLE money_transaction_sources (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 transaction_id bigint NOT NULL,
 app text NOT NULL CHECK(length(app) BETWEEN 1 AND 128),
 scope text NOT NULL CHECK(length(scope) BETWEEN 1 AND 128),
 source_key text NOT NULL CHECK(length(source_key) BETWEEN 1 AND 256),
 captured_at bigint CHECK(captured_at BETWEEN 0 AND 253402271999999),
 rule_version text NOT NULL DEFAULT '' CHECK(length(rule_version) <= 64),
 CONSTRAINT money_transaction_sources_unique UNIQUE(app, scope, source_key)
);
COMMENT ON TABLE money_transaction_sources IS '来源证据，同笔交易的多个来源关联同一账单；不保存页面原文';
COMMENT ON COLUMN money_transaction_sources.id IS '来源编号';
COMMENT ON COLUMN money_transaction_sources.transaction_id IS '关联账单编号';
COMMENT ON COLUMN money_transaction_sources.app IS '来源应用包名；手动、导入、云端同步用固定标识';
COMMENT ON COLUMN money_transaction_sources.scope IS '来源范围，如应用内账号，界定交易标识命名空间';
COMMENT ON COLUMN money_transaction_sources.source_key IS '来源范围内的交易标识或摘要，仅结构化字段';
COMMENT ON COLUMN money_transaction_sources.captured_at IS '采集时刻，Unix毫秒；手动来源为空';
COMMENT ON COLUMN money_transaction_sources.rule_version IS '采集/解析规则版本；规则变更不静默重写历史账单';
CREATE TABLE money_operations (
 operation_id uuid PRIMARY KEY,
 transaction_id bigint,
 payload jsonb NOT NULL,
 expected_version bigint,
 result jsonb,
 status text NOT NULL CHECK(status IN ('received','applied','rejected')),
 created_at bigint NOT NULL CHECK(created_at BETWEEN 0 AND 253402271999999),
 applied_at bigint CHECK(applied_at BETWEEN 0 AND 253402271999999)
);
COMMENT ON TABLE money_operations IS '账务操作记录，与业务同事务写入；同操作号同内容返回原结果，请求级幂等仍由 money_requests 承担';
COMMENT ON COLUMN money_operations.operation_id IS '客户端生成的稳定操作号，唯一';
COMMENT ON COLUMN money_operations.transaction_id IS '目标账单编号；非账单操作为空';
COMMENT ON COLUMN money_operations.payload IS '冻结的提交内容，重试不得改变';
COMMENT ON COLUMN money_operations.expected_version IS '提交时的预期版本，冲突判断用；新建账单为空';
COMMENT ON COLUMN money_operations.result IS '确认结果，含账单编号、版本与变更序号';
COMMENT ON COLUMN money_operations.status IS 'received 已接收未落账/applied 已应用/rejected 已拒绝';
COMMENT ON COLUMN money_operations.created_at IS '接收时间，Unix毫秒';
COMMENT ON COLUMN money_operations.applied_at IS '落账时间，Unix毫秒';
CREATE TABLE money_balance_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 account_id bigint NOT NULL,
 recorded_at bigint NOT NULL CHECK(recorded_at BETWEEN 0 AND 253402271999999),
 balance_after bigint CHECK(balance_after BETWEEN -9007199254740991 AND 9007199254740991),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 200),
 transaction_id bigint,
 operation_id uuid
);
COMMENT ON TABLE money_balance_history IS '账户余额变动明细；启用/校正余额记录基准和原因，不凭流水倒推银行余额';
COMMENT ON COLUMN money_balance_history.id IS '记录编号';
COMMENT ON COLUMN money_balance_history.account_id IS '账户编号';
COMMENT ON COLUMN money_balance_history.recorded_at IS '记录时间，Unix毫秒';
COMMENT ON COLUMN money_balance_history.balance_after IS '记录后的账面余额，单位分；停用余额的记录为空';
COMMENT ON COLUMN money_balance_history.reason IS '变动原因：启用基准、校正、交易、导入等';
COMMENT ON COLUMN money_balance_history.transaction_id IS '关联账单编号，非账单变动为空';
COMMENT ON COLUMN money_balance_history.operation_id IS '关联操作号';
CREATE TABLE money_change_log (
 change_sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 entity text NOT NULL CHECK(entity IN ('account','category','tag','transaction')),
 entity_id text NOT NULL CHECK(length(entity_id) BETWEEN 1 AND 64),
 version bigint NOT NULL CHECK(version >= 1),
 change_kind text NOT NULL CHECK(change_kind IN ('upsert','delete')),
 committed_at bigint NOT NULL CHECK(committed_at BETWEEN 0 AND 253402271999999)
);
COMMENT ON TABLE money_change_log IS '变更记录，按服务端提交顺序产生增量同步游标；不用交易时间作游标';
COMMENT ON COLUMN money_change_log.change_sequence IS '变更序号，提交顺序整数，跨端以字符串传输';
COMMENT ON COLUMN money_change_log.entity IS '实体类型：账户/分类/标签/账单；来源随账单同步';
COMMENT ON COLUMN money_change_log.entity_id IS '实体标识，账单用稳定 UUID，其余用编号文本';
COMMENT ON COLUMN money_change_log.version IS '该实体变更后的版本';
COMMENT ON COLUMN money_change_log.change_kind IS 'upsert 新增或修改/delete 删除或到期清理';
COMMENT ON COLUMN money_change_log.committed_at IS '提交时间，Unix毫秒';
CREATE TABLE money_deletion_markers (
 stable_id uuid PRIMARY KEY,
 transaction_id bigint NOT NULL,
 last_version bigint NOT NULL CHECK(last_version >= 1),
 deleted_at bigint NOT NULL CHECK(deleted_at BETWEEN 0 AND 253402271999999),
 purged_at bigint CHECK(purged_at BETWEEN 0 AND 253402271999999)
);
COMMENT ON TABLE money_deletion_markers IS '删除版本标记，回收站到期清理后仍保留，阻止旧设备复活账单';
COMMENT ON COLUMN money_deletion_markers.stable_id IS '账单稳定标识，唯一';
COMMENT ON COLUMN money_deletion_markers.transaction_id IS '原账单编号，仅记录不引用';
COMMENT ON COLUMN money_deletion_markers.last_version IS '删除时的最终版本';
COMMENT ON COLUMN money_deletion_markers.deleted_at IS '进入回收站时间，Unix毫秒';
COMMENT ON COLUMN money_deletion_markers.purged_at IS '回收站到期清理时间，Unix毫秒，未清理为空';
-- 新表同样仅服务端表所有者访问。
ALTER TABLE money_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_transaction_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_transaction_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_balance_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_change_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_deletion_markers ENABLE ROW LEVEL SECURITY;
-- 存量数据纳入增量同步：按账户、分类、账单顺序写入变更记录。
INSERT INTO money_change_log(entity, entity_id, version, change_kind, committed_at)
 SELECT 'account', id::text, 1, 'upsert', (extract(epoch from now()) * 1000)::bigint FROM money_accounts ORDER BY id;
INSERT INTO money_change_log(entity, entity_id, version, change_kind, committed_at)
 SELECT 'category', id::text, 1, 'upsert', (extract(epoch from now()) * 1000)::bigint FROM money_categories ORDER BY id;
INSERT INTO money_change_log(entity, entity_id, version, change_kind, committed_at)
 SELECT 'transaction', stable_id::text, version, 'upsert', updated_at FROM money_transactions ORDER BY id;
COMMIT;

-- 2026-10-31 compatibility bridge：将未发布的 2026-10-30 基线接到 M2/P1。
-- 暂停写入后仅执行一次；不跳过、不改写上方历史。复杂旧数据须另行设计迁移，本段拒绝并回滚。
BEGIN;
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM money_operations)
 OR EXISTS (SELECT 1 FROM money_transaction_tags)
 OR EXISTS (SELECT 1 FROM money_transaction_sources)
 OR EXISTS (SELECT 1 FROM money_deletion_markers)
 OR EXISTS (SELECT 1 FROM money_transactions WHERE status <> 'posted' OR type NOT IN (2,3,4)
  OR source_account_id IS NULL OR source_amount < 1 OR merchant <> '' OR original_bill_id IS NOT NULL
  OR exclude_statistics OR exclude_budget OR deleted_at IS NOT NULL OR version <> 1
  OR occurred_at IS DISTINCT FROM time*1000 OR created_at IS DISTINCT FROM time*1000
  OR updated_at IS DISTINCT FROM time*1000)
 OR EXISTS (SELECT 1 FROM money_accounts WHERE NOT balance_enabled AND balance IS NOT NULL) THEN
  RAISE EXCEPTION 'Unsupported populated 2026-10-30 baseline; compatibility bridge refused without changing data';
 END IF;
END $$;
-- 旧基线的余额开关与停用列仅作历史保留；P1 以 balance IS NOT NULL 和 active 为准。
COMMENT ON COLUMN money_accounts.balance_enabled IS '历史基线余额开关，仅保留；当前以 balance 是否为空判断余额是否启用';
COMMENT ON COLUMN money_categories.deactivated IS '历史基线停用标志，仅保留；迁移后以 active 为准';
-- 保留整张旧余额历史及其标识序列，释放当前表名和主键索引名。
ALTER TABLE money_balance_history RENAME TO money_balance_history_legacy_20261030;
ALTER TABLE money_balance_history_legacy_20261030 RENAME CONSTRAINT money_balance_history_pkey TO money_balance_history_legacy_20261030_pkey;
ALTER SEQUENCE money_balance_history_id_seq RENAME TO money_balance_history_legacy_20261030_id_seq;
ALTER TABLE money_balance_history_legacy_20261030 RENAME CONSTRAINT money_balance_history_recorded_at_check TO money_balance_history_legacy_20261030_recorded_at_check;
ALTER TABLE money_balance_history_legacy_20261030 RENAME CONSTRAINT money_balance_history_balance_after_check TO money_balance_history_legacy_20261030_balance_after_check;
ALTER TABLE money_balance_history_legacy_20261030 RENAME CONSTRAINT money_balance_history_reason_check TO money_balance_history_legacy_20261030_reason_check;
-- 恢复 v1 投影的约束；额外列及原始内容全部保留，默认值允许当前写入器继续写 v1 列。
ALTER TABLE money_transactions ALTER COLUMN source_account_id SET NOT NULL;
ALTER TABLE money_transactions DROP CONSTRAINT money_transactions_type_check;
ALTER TABLE money_transactions ADD CONSTRAINT money_transactions_type_check CHECK(type IN (2,3,4));
ALTER TABLE money_transactions DROP CONSTRAINT money_transactions_source_amount_check;
ALTER TABLE money_transactions ADD CONSTRAINT money_transactions_source_amount_check CHECK(source_amount BETWEEN 1 AND 9007199254740991);
ALTER TABLE money_transactions DROP CONSTRAINT money_transactions_check;
ALTER TABLE money_transactions ADD CONSTRAINT money_transactions_check CHECK(
 (type = 4 AND destination_account_id IS NOT NULL AND destination_account_id <> source_account_id AND destination_amount IS NOT NULL AND destination_amount = source_amount)
 OR (type IN (2,3) AND destination_account_id IS NULL AND destination_amount IS NULL));
-- 标签按当前模型扩展；移除旧长度/唯一约束不删除任何内容。
ALTER TABLE money_tags DROP CONSTRAINT money_tags_name_check;
ALTER TABLE money_tags ADD CONSTRAINT money_tags_name_check CHECK(length(name) BETWEEN 1 AND 100);
ALTER TABLE money_tags DROP CONSTRAINT money_tags_name_key;
ALTER TABLE money_tags ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE money_tags ADD COLUMN sort_order integer NOT NULL DEFAULT 0;
COMMENT ON TABLE money_tags IS '账单可选标签';
COMMENT ON COLUMN money_tags.name IS '标签名称';
COMMENT ON COLUMN money_tags.active IS '标签是否启用';
COMMENT ON COLUMN money_tags.sort_order IS '显示排序';
COMMIT;

-- 2026-10-30 M2 可纠错账本：在既有五表后执行，保留旧流水身份和余额。
BEGIN;
ALTER TABLE money_accounts ALTER COLUMN balance DROP NOT NULL;
COMMENT ON COLUMN money_accounts.balance IS '可选账面余额，单位分，空值表示未设置，负数表示负债';
ALTER TABLE money_categories ADD COLUMN IF NOT EXISTS parent_id bigint;
ALTER TABLE money_categories ADD COLUMN active boolean NOT NULL DEFAULT true;
UPDATE money_categories SET active = NOT deactivated;
ALTER TABLE money_categories ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
COMMENT ON TABLE money_categories IS '支持两级的交易分类';
COMMENT ON COLUMN money_categories.parent_id IS '一级分类编号，空值表示一级分类，由应用层校验层级';
COMMENT ON COLUMN money_categories.active IS '分类是否启用，历史分类停用而不删除';
COMMENT ON COLUMN money_categories.sort_order IS '显示排序';
CREATE TABLE IF NOT EXISTS money_tags (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 active boolean NOT NULL DEFAULT true,
 sort_order integer NOT NULL DEFAULT 0
);
COMMENT ON TABLE money_tags IS '账单可选标签';
COMMENT ON COLUMN money_tags.id IS '标签编号';
COMMENT ON COLUMN money_tags.name IS '标签名称';
COMMENT ON COLUMN money_tags.active IS '标签是否启用';
COMMENT ON COLUMN money_tags.sort_order IS '显示排序';
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
 bill_id uuid NOT NULL,
 snapshot jsonb NOT NULL
);
COMMENT ON TABLE money_changes IS '按提交顺序的账单变更，保留删除版本';
COMMENT ON COLUMN money_changes.sequence IS '服务端变更序号，不能使用业务发生时间替代';
COMMENT ON COLUMN money_changes.bill_id IS '账单标识';
COMMENT ON COLUMN money_changes.snapshot IS '提交时的版本快照，过期删除需清理完整内容';
CREATE TABLE money_balance_history (
 sequence bigint NOT NULL,
 account_id bigint NOT NULL,
 bill_id uuid NOT NULL,
 delta bigint NOT NULL CHECK(delta BETWEEN -9007199254740991 AND 9007199254740991),
 balance_after bigint NOT NULL CHECK(balance_after BETWEEN -9007199254740991 AND 9007199254740991),
 reason text NOT NULL CHECK(reason IN ('save','delete','restore')),
 PRIMARY KEY(sequence,account_id)
);
COMMENT ON TABLE money_balance_history IS '每次账单操作实际余额变化';
COMMENT ON COLUMN money_balance_history.sequence IS '引起变化的提交序号';
COMMENT ON COLUMN money_balance_history.account_id IS '账户编号';
COMMENT ON COLUMN money_balance_history.bill_id IS '账单标识';
COMMENT ON COLUMN money_balance_history.delta IS '本次实际增减，整数分';
COMMENT ON COLUMN money_balance_history.balance_after IS '本次操作后的账面余额，整数分';
COMMENT ON COLUMN money_balance_history.reason IS '新增修改、删除或恢复原因';
ALTER TABLE money_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_ledger_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_bill_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_balance_history ENABLE ROW LEVEL SECURITY;

-- 旧结构不含每笔实际余额影响，无法区分历史导入的保留/应用模式。
-- 以升级时余额为基准保留，不猜测曾扣款；后续调整应显式校正余额。
INSERT INTO money_bills(id,legacy_id,version,status,content,balance_mode,applied_effect,restore_effect,restore_status,created_at,updated_at)
SELECT md5('money-legacy:'||id::text)::uuid,id,1,'posted',
 jsonb_build_object('kind',CASE type WHEN 2 THEN 'income' WHEN 3 THEN 'expense' ELSE 'transfer' END,
 'amountCents',source_amount,'accountId',source_account_id::text,'categoryId',category_id::text,
 'destinationAccountId',destination_account_id::text,'occurredAt',time*1000,'merchant','','note',comment,
 'tagIds','[]'::jsonb,'excludeFromStatistics',false,'excludeFromBudget',false),
 'preserve','{}'::jsonb,'{}'::jsonb,'posted',
 (extract(epoch FROM transaction_timestamp())*1000)::bigint,(extract(epoch FROM transaction_timestamp())*1000)::bigint
FROM money_transactions;
INSERT INTO money_changes(sequence,bill_id,snapshot)
SELECT row_number() OVER(ORDER BY legacy_id),id,
 jsonb_build_object('billId',id,'legacyId',legacy_id::text,'version',version,'status',status,'content',content,
 'balanceMode',balance_mode,'createdAt',created_at,'updatedAt',updated_at,'deletedAt',deleted_at,
 'changeSequence',(row_number() OVER(ORDER BY legacy_id))::text)
FROM money_bills;
UPDATE money_ledger_state SET sequence=(SELECT coalesce(max(sequence),0) FROM money_changes) WHERE id=1;
COMMIT;

-- 2026-10-30 M2a 追溯旧版手动记账的成功响应，恢复有确切证据的余额影响。
-- 导入响应不含流水身份，仍保留余额；不猜测无法追溯的记录。
BEGIN;
WITH known_manual AS (
 SELECT t.id,
  jsonb_build_object(t.source_account_id::text,CASE t.type WHEN 2 THEN t.source_amount ELSE -t.source_amount END)
  || CASE WHEN t.type=4 THEN jsonb_build_object(t.destination_account_id::text,t.destination_amount) ELSE '{}'::jsonb END AS effect
 FROM money_transactions t WHERE EXISTS (
  SELECT 1 FROM money_requests r WHERE r.response->>'id'=t.id::text
   AND r.response->>'timeSequenceId'=t.id::text AND r.response->>'type'=t.type::text
   AND r.response->>'sourceAccountId'=t.source_account_id::text
   AND r.response->>'sourceAmount'=t.source_amount::text
   AND r.response->>'time'=t.time::text
   AND r.response->>'categoryId'=t.category_id::text
   AND coalesce(r.response->>'destinationAccountId','')=coalesce(t.destination_account_id::text,'')
   AND coalesce(r.response->>'destinationAmount','')=coalesce(t.destination_amount::text,'')
   AND r.response->>'comment'=t.comment
 )
)
UPDATE money_bills b SET balance_mode='apply',applied_effect=k.effect,restore_effect=k.effect,
 version=version+1,updated_at=(extract(epoch FROM transaction_timestamp())*1000)::bigint
FROM known_manual k WHERE b.legacy_id=k.id AND b.version=1 AND b.balance_mode='preserve' AND b.status='posted';
INSERT INTO money_changes(sequence,bill_id,snapshot)
SELECT (SELECT sequence FROM money_ledger_state WHERE id=1)+row_number() OVER(ORDER BY legacy_id),id,
 jsonb_build_object('billId',id,'legacyId',legacy_id::text,'version',version,'status',status,'content',content,
 'balanceMode',balance_mode,'createdAt',created_at,'updatedAt',updated_at,'deletedAt',deleted_at,
 'changeSequence',((SELECT sequence FROM money_ledger_state WHERE id=1)+row_number() OVER(ORDER BY legacy_id))::text)
FROM money_bills WHERE id=md5('money-legacy:'||legacy_id::text)::uuid AND version=2 AND balance_mode='apply';
UPDATE money_ledger_state SET sequence=(SELECT coalesce(max(sequence),0) FROM money_changes) WHERE id=1;
COMMIT;

-- 2026-10-30 M2b 账单快照按身份查找最新变更，避免每笔全表扫描。
BEGIN;
CREATE INDEX money_changes_bill_idx ON money_changes(bill_id,sequence DESC);
COMMIT;

-- 2026-10-30 P1 双端增量同步、主数据版本与显式余额校正历史。
-- 升级时暂停旧版写入；保留现有账户、分类、标签及全部账务记录。
BEGIN;
ALTER TABLE money_accounts ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE money_accounts ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
COMMENT ON COLUMN money_accounts.active IS '账户是否启用，停用后历史账单仍保留';
COMMENT ON COLUMN money_accounts.version IS '账户设置版本，余额交易不单独递增此版本';
ALTER TABLE money_categories ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
COMMENT ON COLUMN money_categories.version IS '分类设置版本，修改需匹配预期版本';
ALTER TABLE money_tags ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
COMMENT ON COLUMN money_tags.version IS '标签设置版本，修改需匹配预期版本';
ALTER TABLE money_changes ALTER COLUMN bill_id DROP NOT NULL;
ALTER TABLE money_changes ADD COLUMN entity_type text NOT NULL DEFAULT 'bill' CHECK(entity_type IN ('bill','account','category','tag'));
ALTER TABLE money_changes ADD COLUMN entity_id text;
ALTER TABLE money_changes ADD CONSTRAINT money_changes_identity_check CHECK(
 (entity_type='bill' AND bill_id IS NOT NULL AND entity_id IS NULL)
 OR (entity_type<>'bill' AND bill_id IS NULL AND entity_id IS NOT NULL));
COMMENT ON TABLE money_changes IS '按提交顺序的账单与主数据变更，保留删除版本';
COMMENT ON COLUMN money_changes.bill_id IS '账单变更的稳定标识，主数据变更为空';
COMMENT ON COLUMN money_changes.entity_type IS '变更实体类型：账单、账户、分类或标签';
COMMENT ON COLUMN money_changes.entity_id IS '主数据实体编号，账单使用独立的稳定标识列';
ALTER TABLE money_balance_history ALTER COLUMN bill_id DROP NOT NULL;
ALTER TABLE money_balance_history ALTER COLUMN delta DROP NOT NULL;
ALTER TABLE money_balance_history ALTER COLUMN balance_after DROP NOT NULL;
ALTER TABLE money_balance_history DROP CONSTRAINT money_balance_history_reason_check;
ALTER TABLE money_balance_history ADD CONSTRAINT money_balance_history_reason_check CHECK(reason IN ('save','delete','restore','balance'));
ALTER TABLE money_balance_history ADD COLUMN note text NOT NULL DEFAULT '';
COMMENT ON TABLE money_balance_history IS '每次账单操作或显式余额校正的实际变化';
COMMENT ON COLUMN money_balance_history.bill_id IS '关联账单标识，显式余额操作为空';
COMMENT ON COLUMN money_balance_history.delta IS '本次实际增减，整数分，未知余额转换为空';
COMMENT ON COLUMN money_balance_history.balance_after IS '本次操作后的账面余额，整数分，停用余额为空';
COMMENT ON COLUMN money_balance_history.reason IS '新增修改、删除、恢复或显式余额操作';
COMMENT ON COLUMN money_balance_history.note IS '显式余额操作的用户说明';
COMMIT;
