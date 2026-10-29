# 开源复用可行性核实

日期：2026-10-29  
方式：GitHub 官方仓库源码和许可证静态检查。

后续运行进展：已增加独立的[账本运行验证报告](2026-10-29-ledger-runtime-validation.md)。本文件下文保留首次静态核实的历史状态，实际运行结果以该报告为准。

## 结论

继续评估“ezBookkeeping 账本 + 安卓采集适配”的路线有源码依据。微信和支付宝文件导入比此前预期更成熟；两个项目尚未经过运行集成，安卓端也未经过一加 13 实测。

不将通知访问权限描述为读取微信、支付宝内部账本的能力。支持通知监听和实际支付产生可读通知，是两项不同条件。

## 核实版本

| 项目 | 本次核实的提交 |
| --- | --- |
| ezBookkeeping | `aae6285089e4f4758695ca5a509e8d22308a8a86`，main |
| AutoAccounting | `ed5c2ad94b152f7351d76fcd33f9099a5f7532eb`，master |

GitHub 最新发布接口在本轮返回 ezBookkeeping `v2.1.1`，包含 macOS ARM64 安装包。该发布版与所查 main 提交没有做一致性验证；下面的源码结论限定于表内提交，不能自动套用到该发布版。

## 已核实证据

### ezBookkeeping：账本与文件导入

- [导入器注册](https://github.com/mayswind/ezbookkeeping/blob/aae6285089e4f4758695ca5a509e8d22308a8a86/pkg/converters/transaction_data_converters.go#L78)明确注册 `alipay_app_csv`、`alipay_web_csv`、`wechat_pay_app_xlsx` 和 `wechat_pay_app_csv`。因此这些格式应优先验证复用，不先重写解析器。
- [创建交易请求](https://github.com/mayswind/ezbookkeeping/blob/aae6285089e4f4758695ca5a509e8d22308a8a86/pkg/models/transaction.go#L164)包含类型、账户、分类、时间、金额和 `clientSessionId`。账户 ID 使用 JSON 字符串，金额使用整数；适配前仍需核实货币精度和交易类型枚举。
- [创建交易处理](https://github.com/mayswind/ezbookkeeping/blob/aae6285089e4f4758695ca5a509e8d22308a8a86/pkg/api/transactions.go#L1245)具备真实写入路径；[重复提交逻辑](https://github.com/mayswind/ezbookkeeping/blob/aae6285089e4f4758695ca5a509e8d22308a8a86/pkg/api/transactions.go#L1351)受 `EnableDuplicateSubmissionsCheck` 和非空会话 ID 控制。
- 重复提交记录的写入发生在交易创建之后，不能仅凭这段逻辑承诺并发、进程崩溃或长期重放下的严格一次入账。重复检查的存储方式、有效期和部署配置需继续核实。
- [文件入账处理](https://github.com/mayswind/ezbookkeeping/blob/aae6285089e4f4758695ca5a509e8d22308a8a86/pkg/api/transactions.go#L3038)逐条创建交易，失败时返回已导入数量。因此产品层必须正确表达部分完成，并按记录恢复，不能假定整个文件具有原子性。
- [API Token 生成处理](https://github.com/mayswind/ezbookkeeping/blob/aae6285089e4f4758695ca5a509e8d22308a8a86/pkg/api/tokens.go#L86)已实现，但受配置和用户权限限制，并校验密码。现阶段未修改任何鉴权配置，也没有生成令牌。
- [MIT 许可证](https://github.com/mayswind/ezbookkeeping/blob/aae6285089e4f4758695ca5a509e8d22308a8a86/LICENSE)允许修改和再分发，要求保留版权及许可声明。

### AutoAccounting：通知采集与适配接口

- [NotificationService](https://github.com/AutoAccountingOrg/AutoAccounting/blob/ed5c2ad94b152f7351d76fcd33f9099a5f7532eb/app/src/main/java/net/ankio/auto/service/NotificationService.kt)继承 Android `NotificationListenerService`，读取通知标题、大文本或普通文本。
- 实现包含应用白名单、关键词白名单和黑名单，然后把数据交给本地分析入口。可复用的是采集与规则处理思路，不代表已实现本产品的服务器上传队列。
- 通知处理使用包名、标题和文本组合做内存哈希检查。相同文本的两次真实交易可能受此策略影响，必须实测缓存行为，不能直接把该键复用为产品永久去重键。
- [IAppAdapter](https://github.com/AutoAccountingOrg/AutoAccounting/blob/ed5c2ad94b152f7351d76fcd33f9099a5f7532eb/app/src/main/java/net/ankio/auto/adapter/IAppAdapter.kt)定义 `syncBill(BillInfoModel)`、`syncAssets()` 等接口，证明存在向记账软件适配的扩展点。
- 接口偏向目标安卓应用，包括包名、应用信息和同步特性。增加自有服务端目标前，仍须查看管理器如何选择、调用适配器；不能只加一个 HTTP 请求就宣布完成集成。
- [仓库根许可证](https://github.com/AutoAccountingOrg/AutoAccounting/blob/ed5c2ad94b152f7351d76fcd33f9099a5f7532eb/LICENSE)是 GPL-3.0。本次查看的两个 Kotlin 文件头包含不同的许可描述；采用或分发代码前需要核对相关文件与依赖的许可证范围，不因文件头不同就推定整个项目采用宽松许可。

## 还需要验证的边界

| 项目 | 验证方法 | 当前状态 |
| --- | --- | --- |
| 程序写入账本 | 虚构账号与交易调用实际接口，核对网页与数据库结果 | 未运行 |
| 鉴权与会话 | 核对路由、中间件、API Token 限制及时区要求 | 已见处理函数，未联调 |
| 断网与重复提交 | 模拟重试、并发、响应丢失、服务重启 | 未运行 |
| 原生导入格式 | 用实际导出文件或同格式脱敏样本验证编码、列名、退款和转账 | 未取得样本 |
| 招商银行卡与信用卡 | 分别采集实际通知与导出文件，不能当成同一种格式 | 未实测 |
| 华泰证券 | 确认客户端可导出的持仓、成交、资金文件 | 未取得样本 |
| 一加 13 后台 | 锁屏、切后台、重启、离线恢复后与账单对账 | 未连接设备 |
| 图片与屏幕识别 | 验证权限、触发方式、识别结果和数据去向 | 未启用 |
| 行情与收益 | 确认可靠数据源、价格时间与计算所需历史完整度 | 未接入 |

## 本机环境

本次命令检查结果：

- macOS ARM64。
- `node`、`npm` 命令可用。
- 未在 PATH 检测到 `docker`、`go`、`adb`。
- 存在 `/usr/bin/java` 启动器；尚未执行版本检查，不能据此断言已安装可用 JDK。
- 工作目录没有现有项目文件，也不是 Git 仓库；本轮未初始化、提交或推送。

部分 raw.githubusercontent.com 请求超时，改用 GitHub Contents API 成功读取关键源码。没有因此改写任何网络、域名、鉴权或环境配置。

## 下一阶段执行清单

### 1. 账本运行验证

- 固定运行版本，同时核对其与本次源码结论的差异；保留上游许可证。
- 使用原生 ARM64 安装包或补齐构建环境，不为预览要求先部署公网服务器。
- 使用虚构数据验证账户、收支、转账和余额调整，核实接口路由、时区、金额单位及错误结构。
- 测试关闭和开启重复提交检查时的行为；若涉及用户环境或鉴权配置修改，先说明影响并取得确认。
- 交付可访问的本地账本、命令记录和运行验证报告。

### 2. 接入与导入闭环

- 先定义稳定的事件 ID、来源、金额、账户、时间、源记录 ID、批次和处理状态。
- 验证事件持久化、重复上传、写入超时后的核对与恢复，再接真实采集端。
- 优先复用上游微信、支付宝导入器，补齐跨来源匹配和导入批次管理。
- 以同商户同金额两笔消费、跨渠道重复、退款和部分失败作为主要回归样例。
- 若新增数据库结构，按用户规则同时维护 `doc/sql/init.sql` 和 `doc/sql/increment.sql`，使用表字段中文注释，不建立外键，也不创建框架迁移文件。

### 3. 安卓实机验证

- 先核对 AutoAccounting 适配器调用链、规则来源和本地网络行为，再选择直接扩展或制作最小独立采集端。
- 仅使用用户已授权的通知访问与后台运行范围。
- 对微信、支付宝、招商银行和信用卡分别记录：有无系统通知、字段完整度、漏记、误记和重复。
- 分别测试同金额连续交易、通知更新、断网、重启和锁屏。
- 输出实测覆盖率，再决定是否需要短信或屏幕识别权限；不预设要求 Root。

### 4. 资产与证券扩展

- 校验信用卡负债、还款与手续费的表示方式。
- 根据招商和华泰实际文件建立独立适配，先持仓和余额，再完整成交与资金流。
- 区分资金流入、投资收益及估值变动，缺少历史时不展示无依据的年化收益。

## 技术选型判定条件

如果账本无法在合理改动内表达信用卡、退款、来源关联与可靠恢复，则重新比较底座；如果采集候选在通知模式下依赖过多非必需模块或无法避免误去重，则采用最小独立安卓采集端。两者都以验证结果决定，不因已有候选就强行复用。
