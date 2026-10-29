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

## 首次生产部署结果

- 生产源码提交：`17b09dd68e76a0c2533858fd286ce383a4071fb8`，Vercel 部署 `E21eA3G2ZtDGcXrfZbuHazNFD65M`，GitHub Vercel 状态 success。
- 正式地址：`https://www.huangjiamu.fun`；裸域名自动重定向。旧个人网站已替换为见财。
- 首次云端函数调用暴露原生 ESM 无扩展名导入错误。已为四处服务端导入补上 `.js`，并把 NodeNext 检查加入生产构建，防止同类回归。
- 首页 HTTP 200；未登录 session/accounts 返回 401；一分钟有效的测试签名会话读取 session、账户、分类及交易接口均返回 200；错误密码返回 401；退出接口返回 200，并核验 HttpOnly/Secure/SameSite=Strict/Max-Age=0。未写入财务记录。
- 用户实际密码未由代理读取，正确密码的交互式登录待用户亲自完成。上述测试会话未保存在浏览器。
- 本机默认 vercel.app 域名请求超时，自定义域名访问正常。

不要重复执行 init.sql 或 increment.sql 中已完成的建表步骤。凭据仅保存在被 Git 忽略的本机文件与 Vercel Production Secret 中，Preview 未配置生产凭据。

## 记账主线调整与导入

- 用户确认保留 Vercel，按成熟账本的流程整理产品。首页改为按日期分组的收支明细，主导航只保留账本、统计、账户；未接入投资功能退出主界面。
- 记一笔支持支出、收入、转账/信用卡还款，保存历史流水后切换至相应月份。
- 接入微信、支付宝、招商银行和通用 CSV / XLSX 预览及入账；不支持的格式、状态或不确定交易明确列出原因。默认补录历史流水保留当前余额。
- 服务端采用单事务批量写入和持久化防重；网络结果不明时锁定原参数重试；无单号的疑似重复单独提示，可确认后显式保留。沿用现有五张表，没有结构 SQL 变更。
- 使用临时 PGlite 验证事务、去重、回滚、1000 行批次；Chrome 桌面与 360px 手机验证文件预览、CSV/XLSX 导入、月份跳转、重传、模拟响应丢失重试、无单号保留、转账、刷新及退出。未将测试流水写入生产数据库。
- 发布沿用 `HHHJM845/money` 的 main → 既有 Vercel Production 自动部署，不调整域名、数据库连接或登录配置。
