# 部署状态：2026-10-29

用户授权执行 SQL、推送 GitHub 并替换现有 Vercel 项目。

## 已执行

- 浏览器 SQL Editor 检查 Supabase 指定项目 public schema：无既有表。
- 执行 doc/sql/init.sql 初始结构及默认分类，事务成功提交。
- 核验五张 money_* 表均开启 RLS；默认分类总数为七。未写入真实财务数据。
- 本地 Git main 已初始化，源码形成提交 8ef13d9；origin 指向用户指定仓库。排除 .local、.env.local、数据库和凭据。

## 后续已执行

- 用户完成 GitHub App 对指定仓库的授权，源码已上传至 `HHHJM845/money` 的 `main`，远程提交 `b63409481631cbe73760f51ea79d47e426a632cf`。本地与远程文件树相同，但提交历史不同；不可强推覆盖历史。
- 通过已登录浏览器，将 Vercel `react-example-project` 的 Git 关联从旧网站切换为 `HHHJM845/money`。
- 确认框架为 Vite、根目录为空、构建及输出无 Dashboard 强制覆盖；Node.js 已选择 22.x 并保存。
- 再次执行 17 项测试及生产构建，全部通过。
- Vercel 无既有环境变量；已准备 Production 变量输入表单，未保存空值或伪造凭据。
- 用户通过本机交互脚本设置数据库连接和账本登录凭据后，四项配置已导入并保存为仅 Production 可用的 Secret。
- 真实 Supabase 连接复现 `SELF_SIGNED_CERT_IN_CHAIN`；下载 Dashboard 指向的官方 `prod-ca-2021.crt`，使用 `DATABASE_CA_CERT` 保留严格 TLS 校验后成功读取七个分类。新增三项证书配置测试，总计二十项测试及构建通过。

## 未完成与原因

- Vercel connector 要求重新认证，已改用浏览器完成项目配置，尚未发布生产版本。
- 生产环境变量已配置，待首次部署及线上接口验证，尚不能确认线上登录与记账可用。

恢复操作：用户配置 DATABASE_URL、OWNER_USERNAME、OWNER_PASSWORD_HASH、SESSION_SECRET 后，先验证部署再覆盖生产。现有域名包含 huangjiamu.fun，覆盖将把其个人网站替换为财务应用。不要重复执行 init.sql 或 increment.sql 中已完成的建表步骤。
