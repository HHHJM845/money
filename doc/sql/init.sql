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
-- 仅服务端表所有者访问；不创建公开策略，拒绝 Data API 的 anon/authenticated 行访问。
-- 不使用 FORCE ROW LEVEL SECURITY，保留表所有者的服务端访问能力。
ALTER TABLE money_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_login_limits ENABLE ROW LEVEL SECURITY;
COMMIT;
