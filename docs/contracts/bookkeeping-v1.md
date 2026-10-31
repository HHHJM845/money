# 收支账务契约 v1

1. 一个账本、CNY。金额为整数分；所有端拒绝超出 JavaScript 安全整数范围的金额、余额和汇总。
2. 新操作和新账单由客户端生成稳定 UUID；旧服务端 bigint ID 保留，通过唯一映射兼容，不改变原流水身份。
3. domain `occurredAt`、`createdAt`、`updatedAt` 使用 Unix 毫秒；旧 v1 秒字段只在适配边界转换。统计按上海时区的发生月份；退款按到账月份。
4. 账单状态 `pending/posted/deleted` 与同步状态 `queued/sending/synced/failed/conflict` 分离。
5. 来源可多条：来源应用、来源范围内交易标识或摘要、采集时刻、适配规则版本；不发送整段页面原文。不同来源的相同编号不是自动关联依据。
6. 保存已实际应用的余额影响；`preserve` 模式历史导入影响为空。`replacementDelta` 只撤销实际旧影响。旧版手动账若成功响应可完整匹配流水身份与金额，则迁移其确定影响；无法证明的旧账以升级时余额为基准保留。启用余额不重算旧流水，未知余额不补零。
7. 提交包含 `operationId`、`billId`、`expectedVersion` 和内容；同操作同内容返回原结果，不重复修改余额；同操作不同内容返回错误。
8. 服务端确认返回 `billId`、`version`、`changeSequence`；无效输入、未登录、版本冲突、服务不可用分别返回可辨识错误。
9. `changeSequence` 由服务端提交顺序产生，以整数串传输；不能用 `occurredAt` 作增量游标。客户端成功持久化一页后才推进游标。
10. 删除和恢复均形成新版本；回收站 30 天后不可恢复完整记录，删除版本标记仍可阻止旧设备复活记录。过期完整内容从账单、兼容流水、变更快照及幂等响应中清理，过期操作重放返回 `410 / RECORD_EXPIRED`，来源身份与余额历史保留。
11. AI 和采集输入只生成候选，能否 `posted` 由已批准确认规则和完整校验决定，不由模型输出字段直接控制。
12. v1 兼容路由和新版路由共享账务事务入口，不得保留两套独立写余额实现。

合成样例为 `test/fixtures/bookkeeping-v1.json`，TypeScript 与 Kotlin 应读取同一文件回放。纯函数不负责幂等、存储、退款关联上限或恢复期限；这些约束由事务存储验证。

## P1 增量读取与主数据

- 初次读取 `GET v2/snapshot` 得到 `{accounts,categories,tags,bills,tombstones,sequence,fetchedAt}`；数据与序号属于同一 MVCC 语句视图。`tombstones` 只保留已过期删除的身份/版本/删除时间/变更序号及 `expired:true`，不包含完整内容。
- 恢复快照时用明确的过期标记清理旧设备上的正文、历史及分页暂存；不能只清理本机已是删除状态的记录。快照中的普通缺席不等于过期证明，本机未确认的新记录仍保留；恢复后的历史队列须经过恢复协议核对。
- 后续读取 `GET v2/sync/changes?after=<整数串>&count=200`；数量为 1–200，游标在 PostgreSQL 非负 bigint 范围内，不能转成 JavaScript number。
- 增量结果为 `{changes,nextSequence,hasMore,accounts,categories,tags,fetchedAt}`。每条变化为 `{sequence,entityType,entityId,snapshot}`，类型是 `bill/account/category/tag`。业务发生时间不决定顺序。
- `hasMore=true` 时 `nextSequence` 为本页最后事件；尾页为一致性视图的当前提交序号。主数据集合与该次响应的视图一致；客户端先暂存中间页，尾页才一起发布账单与主数据，失败不能发布半份账本。
- 本地账单及出站队列是用户操作覆盖层；云端确认某个操作不能覆盖其后的本地编辑。页数据、可恢复进度和游标必须事务持久化，不能只存在 Activity 内存。
- 游标高于服务端当前提交序号返回 `409 / CURSOR_INVALID`，客户端重新拉取快照，不能继续沿旧游标跳过变化。完整恢复的旧队列失效另由备份恢复协议处理。
- 过期删除追加新的变化，快照仅含 `{billId,legacyId,version,status:'deleted',deletedAt,changeSequence,expired:true}`；客户端清除完整内容，保留身份防止旧记录复活。过期不改变账务版本或余额。
- 账户增加 `active/version`，分类和标签增加 `version`；停用保留历史。余额随账单变化不递增账户设置版本，显式校正同时校验预期余额。
- `POST v2/master/submit` 接收 `{operationId,entityType,entityId,expectedVersion,action,content}`；新增 `entityId=null/expectedVersion=0`，修改要求匹配版本。返回 `{entityType,entityId,snapshot,changeSequence}`，与账单写入使用同一锁、序列及幂等事务。
- `save` 账户内容为 `{name,category,currency:'CNY',active}`，仅新增可附 `balance`；分类为 `{name,type,parentId,active,sortOrder}`；标签为 `{name,active,sortOrder}`。
- 账户 `balance` 动作为 `{balance,expectedBalance,reason}`，金额使用整数分字符串或 null，说明必填。预期余额不同返回 `409 / BALANCE_CONFLICT`，避免覆盖打开表单后发生的交易。
- 已知余额校正保留历史实际影响，不重算流水；停用余额清除该账户旧账的当前/恢复影响，并为受影响账单增加版本与同步事件。之后重新启用不重放旧账。
- 账单的最新快照和提交结果包含 `appliedEffect/restoreEffect`（账户编号到整数分的映射）及最小 `sources`。离线纠错必须撤销实际影响，不能仅根据 `balanceMode` 与金额猜测旧账曾扣款。早期历史变化可能缺这些字段，首次完整快照作为可靠基线。
- 账单携带 `restoreStatus:'pending'|'posted'`，明确删除前业务状态；其他设备离线恢复待确认账单时仍是待确认，不能默认成为正式账单。
- 过期删除标记携带 `legacyId:string|null`，仅用于识别旧试验库记录并清理对应正文；快照与增量均保留该最小身份，不包含金额、商户或备注。
- 余额历史中的 `billId` 可空；`reason='balance'` 时带 `note`。未知余额转换时 `deltaCents` 可空；停用后 `balanceAfterCents` 为空，不能补成零。

## 结果未知时的恢复

- 账单及主数据请求在发送前保存原操作编号和完整请求；结果未知时只能重放原请求，不能为同一次重试生成新编号。持久保存失败时不发送网络请求，并显示可恢复的错误。
- Android 账单使用持久出站队列，主数据请求使用现有 `master_records` 的独立 `master-request` 类型。快照发布只替换账户、分类和标签，不清空请求日志；重启后在“我的”继续确认。
- Web 按登录账号及操作编号分别保存请求，刷新后显示原请求恢复入口；不同请求不能互相覆盖。不保存登录密码或会话凭据。
- 成功确认或明确的终态拒绝才清理请求日志；未登录、权限错误、超时、限流及网络异常均保留原请求。日志清理失败时仍可按原操作安全重放。
- 本机余额无法证明与已确认基线一致时显示待核对，保留已确认余额；不能把缺少实际影响或结果未知的推测显示为精确余额。
