# 见财：个人收支与资产管理

当前版本：React/Vite 前端 + Vercel Node Functions + PostgreSQL，单用户使用。不再依赖 ezBookkeeping 进程。旧 SQLite 数据和研究记录保留，未迁移、未删除。

## 已实现

- 总览、收支、资产、投资四页，月份筛选、分类统计、搜索、CSV 导出。
- 创建人民币账户，负余额表示负债，起始余额不计入收入。
- 收入、支出写入 PostgreSQL；后端支持账户转账，前端转账表单尚未加入。
- 交易与余额原子更新，持久化请求去重，内容不同的重复请求返回冲突。
- 单一所有者账号，关闭注册；HttpOnly / SameSite Cookie，HTTPS 下 Secure；签名会话有效期 12 小时。
- 所有账本接口要求登录，写请求检查同源；登录次数在数据库中限制。

账单文件导入、安卓自动采集、华泰持仓接入尚未实现。历史月份仅切换收支，净资产始终为当前账面余额，不虚构历史资产或投资收益。

## Supabase 与 Vercel 部署

1. 在 Supabase 创建独立 PostgreSQL 项目，检查现有表后，在 SQL Editor 对空数据库执行 `doc/sql/init.sql`。已有安装按 `doc/sql/increment.sql` 的未执行步骤升级；两者不要重复运行。部署方记录已执行步骤。SQL 不创建外键，所有账本表启用 RLS 且不提供匿名访问策略。
2. 从 Supabase Connect 取得 Transaction pooler 的 PostgreSQL 连接字符串。密码中的特殊字符需 URL 编码；使用平台要求的 TLS 参数，不能禁用证书校验。不要把连接字符串贴到聊天或提交 GitHub。
3. 在 Vercel 服务端环境变量中设置 `DATABASE_URL`、`OWNER_USERNAME`、`OWNER_PASSWORD_HASH`、`SESSION_SECRET`。变量名称见 `.env.example`，不可使用 `VITE_` 前缀。Preview 使用独立测试数据库，不能共用生产数据。
4. 所有者密码至少 12 个字符；通过 `npm run password:hash --silent` 从标准输入生成 scrypt 哈希。不要把明文密码放入命令参数或 shell 历史；交互输入时注意终端回显。`SESSION_SECRET` 使用密码管理器生成至少 32 字符的随机值。
5. Vercel 关联 GitHub 仓库，选 Vite，构建 `npm run build`，输出 `dist`，Node 22。`vercel.json` 将 `/api/*` 路由到 Node Function，不需要启动常驻后端。
6. 在 Preview 验证登录、创建账户、收入/支出、刷新后持久化、退出与未授权访问；验证数据库备份与恢复后再切换正式域名。

Vercel 项目链接不等于已部署成功，Supabase MCP 授权也不等于应用已配置 `DATABASE_URL`。2026-10-29 已在指定 Supabase 项目执行初始化：五张表、七个分类，全部表 RLS 已核验开启。不要再次执行初始化脚本。尚未部署生产。

## 本机运行与测试

需要 Node.js 22。本地 `.env.local` 中设置上述四项服务端配置，连接独立测试 PostgreSQL 数据库。Vite 开发插件直接执行同一套后端，不再代理本机 8080。

```sh
npm install
npm run dev
npm test
npm run build
```

没有服务端配置时显示可重试的服务不可用状态，不降级为公开账本或伪造数据。

本地浏览器集成验证使用临时 PGlite（PostgreSQL WASM）数据库，测试中调用真实接口处理器，不使用财务 API mock；不会连接云端或写入真实账本。需要 Playwright 和本机 Chrome。宿主提供 Playwright 时可通过标准 `NODE_PATH` 指定模块目录。

```sh
npx tsx scripts/verify-postgres-browser.ts
```

测试覆盖金额精度、事务回滚、收入/支出/转账、持久去重、分页、RLS、登录限流、CSRF、Cookie 和浏览器记账。截图保存于忽略目录 `.local/postgres-desktop.png` 与 `.local/postgres-mobile.png`。

## 已知边界

- PGlite 是本地真实 PostgreSQL 引擎，但不是云端多连接部署；真实连接池并发竞争、Vercel 路由和 Supabase 网络仍需线上验证。
- 退出会清除当前浏览器 Cookie；已窃取的签名 Cookie 在到期前仍有效。修改所有者密码哈希或会话密钥可使全部旧会话失效。
- 登录限流按可信客户端来源计数，15 分钟最多 10 次尝试（含成功登录），来源以 HMAC 保存；共享同一出口的设备共用额度。正式部署需验证 Vercel 来源头并配合访问保护/防火墙；限流记录清理尚需运营处理。
- 不提供密码找回、账户删除、交易修改或投资估值。记录错误目前需谨慎人工处理，不应立即录入唯一一份真实财务数据。
- `scripts/start-ledger.mjs`、`verify-ledger.mjs`、`verify-browser.cjs`、`verify-product.cjs` 是旧 ezBookkeeping 验证工具，不适用于新后端。
- `.local/`、`.env*`、`.vercel/`、数据库、测试凭据和构建产物不得上传仓库。
