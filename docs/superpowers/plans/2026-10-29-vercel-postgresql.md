# Vercel / PostgreSQL 重建

目标：保留现有财务页面，以 Vercel Node Functions 和标准 PostgreSQL 替换本机 ezBookkeeping 运行依赖。单用户、无公开注册、服务端鉴权、事务记账。

分工：账本 subagent 负责 server/ledger.ts、集成测试、doc/sql 两份 SQL；前端 subagent 负责登录/会话/账户建立和 API 适配；主 agent 负责 HttpOnly 签名会话、服务端连接、Vercel 路由、本地开发桥接及端到端验证。当前目录无 Git，按互不重叠文件并行，不创建伪 worktree 或擅自提交。

验收：未登录拒绝读写；跨站写请求拒绝；重复请求持久化去重；余额与流水原子更新；失败回滚；精确整数分；前端能创建账户和记账；六条账本 API 兼容现有视图；初始化及增量 SQL 都可执行。

边界：不购买云资源、不部署生产、不迁移旧 SQLite 数据。不将演示数据库当成 Supabase 联通验证。导入解析、证券和安卓采集后续单独实现。SQL 不建外键，表和字段具中文注释。Supabase 公共表启用 RLS 且无匿名读取策略。

本地验收：17 项测试通过，生产构建通过，生产依赖审计无已知漏洞。浏览器通过真实接口处理器和临时 PGlite 执行登录、创建账户、0.29 元支出、刷新会话和余额、手机四页布局、退出及未授权访问验证。PGlite 并发被串行化，不代表已证明生产 PostgreSQL 多连接竞争正确性。

云端状态：已通过 Codex CLI 添加并登录用户指定 Supabase MCP（全局配置，项目范围 URL）。没有执行云端 SQL，没有读取数据库密码，没有写入 Vercel 环境变量或部署。MCP 登录和应用数据库连接是两条独立配置路径。
