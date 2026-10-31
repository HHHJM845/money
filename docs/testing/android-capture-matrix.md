# Android P2 受限采集基础与验证矩阵

2026-10-30。这里只交付目标注册表、受限本机解析和合成测试源码，不能称为九应用已支持、P2 完成或真机覆盖。批准依据为 `../superpowers/specs/2026-10-30-auto-bookkeeping-design.md`、逐项决策 I02–I06 / E02 / D07 和剩余计划 P2。

## 包名事实与目标范围

注册表是 `CaptureTargetRegistry.targets` / `packageNames` / `find(packageName)`。包名精确匹配，不按前缀匹配。包名证据与支付规则验证独立；未获取一加 13 的安装版本、页面或通知证据。

| 应用 | 注册表主目标包名 | 2026-10-30 核实的公开证据 | 包名结论 |
|---|---|---|---|
| 微信 | `com.tencent.mm` | [小米应用商店](https://app.mi.com/details?id=com.tencent.mm)，微信、广州腾讯科技有限公司 | 商店身份可核对；非支付场景证据 |
| 支付宝 | `com.eg.android.AlipayGphone` | [小米应用商店](https://app.mi.com/details?id=com.eg.android.AlipayGphone)，支付宝（杭州）数字服务技术有限公司 | 商店身份可核对；非支付场景证据 |
| 招商银行 | `cmb.pb` | [小米应用商店](https://app.mi.com/details?id=cmb.pb)，招商银行股份有限公司 | 商店身份可核对；非支付场景证据 |
| 掌上生活 | `com.cmbchina.ccd.pluto.cmbActivity` | [招行官网](https://cc.cmbchina.com/)→[官方下载页](https://market.cmbchina.com/MPage/online/220526171323778/download/index.html)；见下方 APK 事实 | 当前官方 APK manifest 包名已核实；非支付场景证据 |
| 云闪付 | `com.unionpay` | [银联官网云闪付页](https://cn.unionpay.com/upowhtml/cn/templates/quickPass/quickPass.html)→[官方下载页](https://youhui.95516.com/hybrid_v4/html/help/download.html)→[官方下载安装脚本](https://youhui.95516.com/hybrid_v4/js/help/download.js?v=202403150304)，另有[小米商店](https://app.mi.com/details?id=com.unionpay) | 官方脚本明确 `market://details?id=com.unionpay`、小米/OPPO/vivo/Samsung 同包名；不据此推断活动类 |
| 淘宝 | `com.taobao.taobao` | [腾讯应用宝](https://sj.qq.com/appdetail/com.taobao.taobao)，详情数据 `pkg_name`、`name` 和开发者浙江淘宝网络有限公司 | 商店详情可核对；非支付场景证据 |
| 京东 | `com.jingdong.app.mall` | [腾讯应用宝](https://sj.qq.com/appdetail/com.jingdong.app.mall)，详情数据 `pkg_name`、`name` 和开发者北京京东叁佰陆拾度电子商务有限公司 | 商店详情可核对；非支付场景证据 |
| 拼多多 | `com.xunmeng.pinduoduo` | [小米应用商店](https://app.mi.com/details?id=com.xunmeng.pinduoduo)，上海寻梦信息技术有限公司 | 商店包名字段可核对；非支付场景证据 |
| 美团 | `com.sankuai.meituan` | [小米应用商店](https://app.mi.com/details?id=com.sankuai.meituan)，北京三快在线科技有限公司 | 商店包名字段可核对；非支付场景证据 |

掌上生活包名核实：官方下载页链接的 [32 位 APK](https://download.cc.cmbimg.com/client/cmblife_website.apk) 和 [64 位 APK](https://download.cc.cmbimg.com/client/cmblife64_website.apk) 在本次读取时，`AndroidManifest.xml` 的 `manifest/package` 均为 **`com.cmbchina.ccd.pluto.cmbActivity`**。仅用 HTTP Range 读取 ZIP 目录与压缩 manifest（23,809 字节），本机解压并读取 binary XML 的 `package` 属性；未安装、运行或复制应用代码。此为当前下载内容事实，未校验 APK 签名，不宣称所有历史版本相同。按用户明确授权，将核实后的官方包名设为主目标；旧字符串 `com.cmbchina.ccd.pluto` 未经独立核实，不作为别名注册，也不参与来源允许列表或解析。仍需主代理记录一加实际安装包及版本，包名已核实不等于支付规则已验证。

交接 Goodall / 主代理：公开接口保持 `CaptureTargetRegistry.packageNames: Set<String>`，仍为九个精确包名；掌上生活条目现为 `com.cmbchina.ccd.pluto.cmbActivity`。`targets` 和 `find(packageName)` 使用同一主包名，`CapturePolicy.packages` 自动派生自 `packageNames`。无旧包名前缀或别名匹配，`canAutoPost=false`，现有支付窗口门禁不扩充。

## CaptureStore 集成接口

保留 `PaymentParser.parse(text)` 和 `ParsedPayment(amountCents, type, merchant, reason)`。新增：

```kotlin
val target = CaptureTargetRegistry.find(packageName)
val parsed = PaymentParser.parse(packageName, boundedText, receivedAtMillis)
```

`ParsedPayment` 的默认字段向旧调用兼容：

- `amountCents: Long?`、`type`（expense / income / refund / transfer / unknown）、`merchant` 和 `reason` 保持原字段。
- `occurredAt: Long?`：仅完整、严格有效且不晚于接收时间的上海时区标签时间，毫秒。缺失、模糊、冲突或未来时间返回 null，带 `missing_or_ambiguous_occurred_at`。绝不能将 `receivedAt` 回填为发生时间。
- `receivedAt: Long?`：调用方传入的接收时间，毫秒；通知 postTime 只是来源的发布元数据，不能用作发生时间。旧 parse(text) 无时间上下文，默认 null。
- `accountHint: String?`：仅显式方向对应账户字段中的银行名和四位尾号，如 `招商银行:1234`。整串匹配，完整卡号、多账户、仅支付渠道、只有银行名/尾号均不提取。微信/支付宝/来源银行本身不是实际资金账户。需要确认账户映射，不能用该字符串直接创建或选择账本账户。
- `sourcePackage`、`sourceTransactionId`（SHA-256 摘要）、`sourceTransactionNamespace`、`ruleVersion`、`uncertainReasons`：仅结构化本机结果；不携带页面或通知原文。
- `sourceIdentityCertain` 恒为 false，`canAutoPost` 恒为 false。所有 `ruleVerified` 均为 false，规则版本为各目标的 `synthetic-…-labeled-v1`。不得删掉 `unverified_rule` 后将合成规则自动入账。

每个目标绑定独立版本，当前共用 `LabeledPaymentAdapter` 的**人为定义标签协议**，不是按真实 App 页面臆造不同布局。微信、支付宝、电商等仅接受独立完成状态行和明确字段行；招商两应用额外保留旧的“您…消费人民币…”通知句式，仍不推断账户和时间。

金额用 BigDecimal 转整数分，允许 1 到 9,007,199,254,740,991 分；超过两位小数、非法分组、负数、零、指数和混杂后缀均保持 null。合成协议中明确的 `实付金额` / `实际支付` / `实付` 优先于原价、订单金额；多个实际金额冲突保持 null。只有原价或“付款金额 + 原价/订单金额”时不猜实际付款。余额、优惠和授信额度不作为付款金额。退款要求退款金额并提示关联原账；不会把原付款账户当退款到账账户。还款/转账提示双账户关联，不计作普通消费。

本次**未编辑 CaptureStore / data / UI / build.gradle / manifest / resources**。主代理先完成 P1，再推进 P2 的 Store 集成与结构化元数据持久化；届时使用公开注册表及来源重载，保存这些字段和待确认原因。通知预过滤已切到来源重载，正式账务事务仍由主代理完成。发生时间缺失必须保留为待确认，不能用接收时间伪装已知发生时间；金额缺失同样不能将 0 当成已知金额。包名修正不要求提前完成 P2 持久化。

## 身份与隐私边界

| 信号 | 作用范围 | 可以证明什么 |
|---|---|---|
| notificationKey | Store 外层必须加来源包；通知 key 摘要 + postTime + 文本摘要 | 同一原始回调的传输重试。相同通知更新、重发、同一消费多通知仍不是可靠交易身份 |
| accessibilityKey，无 ID | 来源包 + 进程 session + 可见访问序号 + 文本摘要 | 同一可见访问仅一次候选；离开后同额再来必须容许另一候选 |
| accessibilityKey，有 ID（旧行为） | 来源包内的旧标签 ID 摘要；单次访问回调抑制 | 保留旧回调/重访行为，但它不是正式账单的确定重复判据，不能代替新身份验证 |
| sourceTransactionId + namespace | 包名 + 合成规则版本 + 精确标签类型；ID 只存摘要 | 目前仅未验证线索；不保证同登录用户、商户、通知/页面或时间跨度内唯一 |
| 同金额 / 同时间 / 同商户 | 无可靠交易身份 | 只能疑似重复；两笔同额交易不得自动合并 |

仅独立 `交易单号` / `交易号` / `流水号` 字段可提供摘要线索，`订单号`、`商户订单号`、`原交易单号` 不当成本次付款身份。多 ID 冲突不输出身份。不同包名、标签类型和版本不自动互认；相同原文 ID 在不同平台也不能关联。当前即使通知和页面线索一致，`sourceIdentityCertain=false`，仍须核对；未来必须拿通知/页面、账户作用域与真实交易 ID 证据后再定义可靠关联规则。

`PaymentPageVisit` 原有语义保留：同一无 ID 页面访问即使计数/布局变化也只发一次；ID 后出现只视为补充，不发第二次；已见 ID 的反复回调被抑制；离开再访问允许候选，同 ID key 可稳定，但不能据此直接复活已删除或忽略的账单。忽略/删除状态及关联纠错由持久层负责，本次不实现确定去重或自动入账。

通知 CATEGORY_MESSAGE、EXTRA_MESSAGES、分组摘要及单字段/总文本 8192 上限均保留；拒绝验证码、密码、失败/取消/撤销、处理中及外币文本。只处理启用来源，二次检查启用状态。无障碍仍限制节点数量、深度、可见性、密码/编辑节点、聊天 class/viewId，超限整体拒绝，不截前缀解析。服务只读取本机受限文本，不截图、不点击、不支付，新代码无网络上传。

`paymentWindow` **没有扩充任何活动类**。微信原四个钱包/转账详情类与支付宝原 FlyBirdWindowActivity 门禁原样保留；其存在不表示已经真机验证。其他七包的所有窗口继续拒绝；聊天、Launcher、通用 WebView、H5、hybrid host 和猜测的 PaymentSuccessActivity 均未开放。包名 allowlist 不等于支付页 allowlist，更不等于支持率。

## 真机矩阵

所有单元格都等待 **一加 13 + 系统版本 + App 版本/精确包名 + 通知/页面类型 + 脱敏观察结果**。当前没有实机截图、交易或可访问性树证据。

| 应用 | App/系统版本 | 通知成功 | 支付页成功 | 失败/取消/密码/OTP/聊天 | 退款/缺原账 | 重访/同额两笔/跨来源 | 锁屏/后台/重启 |
|---|---|---|---|---|---|---|---|
| 微信 | 未提供 | 未测试 | 未测试 | 未测试 | 未测试 | 未测试 | 未测试 |
| 支付宝 | 未提供 | 未测试 | 未测试 | 未测试 | 未测试 | 未测试 | 未测试 |
| 招商银行 | 未提供 | 未测试 | 未测试 | 未测试 | 未测试 | 未测试 | 未测试 |
| 掌上生活 | 官方主包名已核实，设备版本未提供 | 未测试 | 未测试 | 未测试 | 未测试 | 未测试 | 未测试 |
| 云闪付 | 未提供 | 未测试 | 未测试 | 未测试 | 未测试 | 未测试 | 未测试 |
| 淘宝 | 未提供 | 未测试 | 未测试 | 未测试 | 未测试 | 未测试 | 未测试 |
| 京东 | 未提供 | 未测试 | 未测试 | 未测试 | 未测试 | 未测试 | 未测试 |
| 拼多多 | 未提供 | 未测试 | 未测试 | 未测试 | 未测试 | 未测试 | 未测试 |
| 美团 | 未提供 | 未测试 | 未测试 | 未测试 | 未测试 | 未测试 | 未测试 |

每场景另测：拒绝/撤回权限、两个采集开关独立、通知未到达可诊断、内容超限整体拒绝、漏掉账户/发生日期进待确认、同额两笔不合并、通知/页面/订单/银行多入口不重复扣账、已删除或忽略来源不复活、断网候选重启保留、失败重试不改余额。不向账户和统计自动写入合成规则结果。实际付款由用户主动执行。

## 测试源码与执行边界

- `PaymentParserTest.kt`：原整数分、方向、完成/拒绝、余额/优惠/额度、歧义兼容测试。
- `CapturePolicyTest.kt`：原 PaymentPageVisit 回调与重访测试；新增七包窗口拒绝和稳定 ID 重访后重复回调抑制。
- `PaymentAdaptersTest.kt`：九包标签成功、取消/失败/OTP/密码/外币/聊天、超长拒绝、实际付款与原价、缺失/冲突/未来/非法日期、银行尾号与渠道/完整卡号拒绝、ID 作用域与订单 ID 拒绝、同额两笔、退款缺关联、收入/转账、银行旧句式、MAX_SAFE 分边界/精度和旧 API 兼容。所有内容均为本地编造数据，不能作为真实 App 样本。

测试先于新实现写入，适配器任务等待统一 Gradle 时隙，没有并行启动 Kotlin 编译。主代理已在最终 `testDebugUnitTest lintDebug assembleDebug` 中实际执行三个 capture 测试类，**30 项全部通过，0 失败/跳过**，同时完整 Android 编译和 lint 通过。整体 118 项记录见 `2026-10-30-bookkeeping-execution.md`，旧历史“32 项通过”不再作为本轮证据。

已执行所属文件的行尾空白和最终换行检查；静态查看确认适配器没有新增网络上传或活动类。集成时 `CaptureStore.packages` 已改用九应用注册表，结构化解析结果及未知发生时间仍未完成 Store 持久化接入，不能因此把 P2 或真实自动识别标为完成。所有通过的解析样例仍是合成数据，所有规则继续 `canAutoPost=false`。
