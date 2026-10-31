package `fun`.huangjiamu.money.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import `fun`.huangjiamu.money.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONObject

@Composable
internal fun BillDetail(bill: BillView, state: LedgerState, actions: LedgerActions, close: () -> Unit,
    edit: () -> Unit, refund: () -> Unit, linked: (String) -> Unit) {
    var busy by remember { mutableStateOf(false) }
    var error by rememberSaveable(bill.billId) { mutableStateOf("") }
    var confirming by rememberSaveable(bill.billId) { mutableStateOf(false) }
    var reviewedServer by rememberSaveable(bill.billId) { mutableStateOf(bill.server?.toString()) }
    var history by remember { mutableStateOf<List<String>?>(null) }
    val gate = remember { SubmissionGate() }
    val scope = rememberCoroutineScope()
    fun runAction(action: suspend () -> Unit) {
        if (!gate.acquire()) return
        busy = true; error = ""
        scope.launch {
            try { action() }
            catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) { error = failure.message ?: "操作失败，请重试" }
            finally { busy = false; gate.release() }
        }
    }
    LaunchedEffect(bill.billId, bill.updatedAt) {
        try { history = actions.billHistory(bill.billId) }
        catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) { error = "历史读取失败：${failure.message}" }
    }
    val c = bill.content
    val refunds = state.bills.filter { it.content.refundOfBillId == bill.billId }
    FormPage(if (bill.status == "pending") "待确认详情" else if (bill.status == "deleted") "回收站账单" else "账单详情", busy, close) {
        Text("${kindLabel(c.kind)}  ¥${yuan(c.amountCents)}", style = MaterialTheme.typography.headlineMedium)
        Text(when (bill.status) { "pending" -> "待确认 · 不计统计，不改变余额"
            "deleted" -> "已删除 · 删除后 30 天内可恢复"; else -> "已入账" }, style = MaterialTheme.typography.bodyMedium)
        FieldLine("商户", c.merchant)
        FieldLine("备注", c.note)
        FieldLine("发生时间（上海）", dateLabel(c.occurredAt))
        FieldLine(if (c.kind == "transfer") "转出账户" else "资金账户", accountLabel(state.metadata, c.accountId))
        if (c.destinationAccountId != null) FieldLine("转入账户", accountLabel(state.metadata, c.destinationAccountId))
        FieldLine("分类", categoryLabel(state.metadata, c.categoryId))
        FieldLine("标签", c.tagIds.joinToString(" · ") { id -> state.metadata.tags.find { it.id == id }?.name ?: "历史标签 #$id" })
        if (c.excludeFromStatistics) Text("此账单不计入统计")
        FieldLine("同步状态", syncLabel(bill.syncState))
        ErrorNotice(bill.syncError)
        if (bill.syncState == "conflict") {
            SectionLabel("选择冲突处理方式")
            Text("本机版本", style = MaterialTheme.typography.labelLarge)
            Text("${c.merchant} · ${kindLabel(c.kind)} ¥${yuan(c.amountCents)} · ${dateLabel(c.occurredAt)}")
            val server = reviewedServer?.let { JSONObject(it) }
            val remote = server?.optJSONObject("content")?.let { runCatching { BillContent.parse(it) }.getOrNull() }
            val reviewedVersion = server?.optInt("version") ?: 0
            val candidateChanged = bill.server?.optInt("version") != reviewedVersion
            Text("云端版本 ${server?.optInt("version") ?: "未取得"}", style = MaterialTheme.typography.labelLarge)
            if (remote != null) {
                Text("${remote.merchant} · ${kindLabel(remote.kind)} ¥${yuan(remote.amountCents)} · ${dateLabel(remote.occurredAt)}")
                FieldLine("云端状态", server?.optString("status").orEmpty())
                FieldLine("云端账户 / 分类", "${accountLabel(state.metadata, remote.accountId)} / ${categoryLabel(state.metadata, remote.categoryId)}")
                FieldLine("云端备注", remote.note)
                FieldLine("云端标签", remote.tagIds.joinToString(" · ") { id -> state.metadata.tags.find { it.id == id }?.name ?: id })
            } else Text("尚未取得云端内容，请先重新同步。")
            if (candidateChanged) ErrorNotice("云端候选已有更新。请刷新并核对后再处理冲突。")
            TextButton(colors = ButtonDefaults.textButtonColors(contentColor = actionTextColor()), onClick = {
                runAction { if (!actions.synchronize()) error = "获取云端状态未完成，请检查网络和登录后重试。" }
            }, enabled = !busy) { Text("重新获取云端状态") }
            OutlinedButton(onClick = {
                reviewedServer = bill.server?.toString()
                error = ""
            }, enabled = !busy && candidateChanged, modifier = Modifier.fillMaxWidth()) { Text("刷新云端候选并重新核对") }
            OutlinedButton(enabled = !busy && remote != null && !candidateChanged, onClick = {
                runAction { actions.resolve(bill.billId, false, reviewedVersion) }
            },
                modifier = Modifier.fillMaxWidth()) { Text("采用云端版本") }
            Button(enabled = !busy && remote != null && !candidateChanged, onClick = {
                runAction { actions.resolve(bill.billId, true, reviewedVersion) }
            },
                modifier = Modifier.fillMaxWidth()) { Text("保留本机内容并重新提交") }
        } else if (bill.syncState in listOf("failed", "unknown")) {
            OutlinedButton(onClick = { runAction { actions.retry(bill.billId) } }, enabled = !busy) {
                Icon(Icons.Default.Refresh, null); Spacer(Modifier.width(8.dp)); Text("重试原操作")
            }
        }
        if (bill.status == "deleted") {
            val remaining = bill.deletedAt?.let { 30L - (System.currentTimeMillis() - it) / 86400000L } ?: 0L
            Text(if (remaining > 0) "约剩 $remaining 天可恢复" else "恢复期限已到")
            Button(onClick = { runAction { actions.restore(bill.billId); close() } },
                enabled = !busy && remaining > 0, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Default.Restore, null); Spacer(Modifier.width(8.dp)); Text("恢复账单")
            }
        } else if (bill.syncState != "conflict") {
            Button(onClick = edit, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Default.Edit, null); Spacer(Modifier.width(8.dp)); Text(if (bill.status == "pending") "补充并确认" else "编辑账单")
            }
            if (bill.status == "posted" && c.kind == "expense") OutlinedButton(onClick = refund, enabled = !busy,
                modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Default.Undo, null); Spacer(Modifier.width(8.dp)); Text("登记部分 / 全部退款")
            }
            TextButton(colors = ButtonDefaults.textButtonColors(contentColor = actionTextColor()), onClick = { confirming = true }, enabled = !busy) {
                Icon(Icons.Default.DeleteOutline, null); Spacer(Modifier.width(8.dp)); Text("移入回收站")
            }
        }
        if (c.refundOfBillId != null) TextButton(colors = ButtonDefaults.textButtonColors(contentColor = actionTextColor()), onClick = { linked(c.refundOfBillId) }, enabled = !busy) { Text("查看关联原支出") }
        if (refunds.isNotEmpty()) {
            SectionLabel("关联退款")
            refunds.forEach { row ->
                TextButton(colors = ButtonDefaults.textButtonColors(contentColor = actionTextColor()), onClick = { linked(row.billId) }, enabled = !busy) {
                    Text("${dateLabel(row.content.occurredAt)} · ¥${yuan(row.content.amountCents)} · ${if (row.status == "deleted") "已删除" else if (row.status == "pending") "待确认" else "已入账"}")
                }
            }
        }
        SectionLabel("来源证据")
        if (bill.sources.isEmpty()) Text("手动录入 / 无附加来源", style = MaterialTheme.typography.bodySmall)
        bill.sources.forEach { source ->
            FieldLine(source.optString("app", "来源"), listOf(
                source.optString("key"), source.optString("ruleVersion"),
                source.optLong("capturedAt").takeIf { it > 0 }?.let { "采集于 ${dateLabel(it)}" }.orEmpty(),
                source.optString("reason"),
            ).filter { it.isNotBlank() }.joinToString("\n"))
        }
        SectionLabel("记录信息")
        FieldLine("录入时间（上海）", dateLabel(bill.createdAt))
        FieldLine("修改时间（上海）", dateLabel(bill.updatedAt))
        bill.deletedAt?.let { FieldLine("删除时间（上海）", dateLabel(it)) }
        FieldLine("账单 ID / 云端版本", "${bill.billId}\nv${bill.version}")
        FieldLine("余额影响模式", if (bill.balanceMode == "preserve") "保留原余额" else "按实际记录的影响处理")
        SectionLabel("修改记录")
        if (history == null) Text("正在读取…")
        else if (history!!.isEmpty()) Text("暂无本机历史记录")
        else history!!.forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
        ErrorNotice(error)
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    }
    if (confirming) AlertDialog(onDismissRequest = { confirming = false },
        title = { Text("移入回收站？") }, text = { Text("删除将撤销此账单实际应用的余额影响，30 天内可恢复。有关联退款时需先处理退款。") },
        confirmButton = { TextButton(colors = ButtonDefaults.textButtonColors(contentColor = actionTextColor()), onClick = {
            confirming = false; runAction { actions.delete(bill.billId); close() }
        }, enabled = !busy) { Text("删除") } },
        dismissButton = { TextButton(colors = ButtonDefaults.textButtonColors(contentColor = actionTextColor()), onClick = { confirming = false }) { Text("取消") } })
}
