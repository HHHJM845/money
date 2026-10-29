# 部署状态：2026-10-29

用户授权执行 SQL、推送 GitHub 并替换现有 Vercel 项目。

## 已执行

- 浏览器 SQL Editor 检查 Supabase 指定项目 public schema：无既有表。
- 执行 doc/sql/init.sql 初始结构及默认分类，事务成功提交。
- 核验五张 money_* 表均开启 RLS；默认分类总数为七。未写入真实财务数据。
- 本地 Git main 已初始化，源码形成提交 8ef13d9；origin 指向用户指定仓库。排除 .local、.env.local、数据库和凭据。

## 未完成与原因

- GitHub connector 写文件返回 403 Resource not accessible by integration。仓库元数据所示用户 push 权限不代表 connector 拥有 contents 写权限。
- 本机 HTTPS git push 无可用凭据，未上传远程。
- Vercel connector 要求重新认证，生产站点未覆盖。
- 数据库连接与所有者登录环境变量未配置，不能确认线上登录与记账可用。

恢复操作：重新授权 GitHub 对 HHHJM845/money 的内容写入、重新连接 Vercel，并在服务端配置数据库连接及所有者登录。先验证预览再覆盖生产。不要重复执行 init.sql 或 increment.sql 中已完成的建表步骤。
