package `fun`.huangjiamu.money.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import `fun`.huangjiamu.money.data.*
import kotlinx.coroutines.CancellationException
import org.json.JSONObject

internal val accountKinds = listOf("1" to "现金", "2" to "银行储蓄", "3" to "信用卡", "4" to "电子钱包",
    "5" to "负债", "6" to "应收款", "7" to "其他", "8" to "储蓄", "9" to "存款")

@Composable
internal fun SettingsPage(state: LedgerState, actions: LedgerActions, capture: CaptureUiState, connected: Boolean,
    openLogin: () -> Unit, openBill: (String) -> Unit, viewAccount: (String) -> Unit,
    pendingMasterRequests: List<PendingMasterRequest> = emptyList(), masterRequestError: String = "",
    masterRequestsLoading: Boolean = false) {
    var dialog by rememberSaveable { mutableStateOf<String?>(null) }
    var accountId by rememberSaveable { mutableStateOf<String?>(null) }
    var trash by rememberSaveable { mutableStateOf(false) }
    var logoutConfirm by rememberSaveable { mutableStateOf(false) }
    var recovery by remember { mutableStateOf<PendingMasterRequest?>(null) }
    var masterNotice by rememberSaveable { mutableStateOf("") }
    fun master(type: String, base: JSONObject? = null, action: String = "save") {
        when {
            masterRequestsLoading -> masterNotice = "正在读取本机冻结请求，请稍候"
            masterRequestError.isNotBlank() -> masterNotice = "本机请求状态无法读取，请恢复读取后再操作"
            pendingMasterRequests.isNotEmpty() -> recovery = pendingMasterRequests.first()
            else -> dialog = JSONObject().put("entityType", type).put("base", base ?: JSONObject.NULL).put("action", action).toString()
        }
    }
    LazyColumn(Modifier.fillMaxSize().testTag("settings-list"), contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp)) {
        item {
            Surface(color = MaterialTheme.colorScheme.surface, shape = androidx.compose.foundation.shape.RoundedCornerShape(12.dp)) {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SectionLabel("云端同步")
            FieldLine("登录状态", if (state.authExpired) "会话已过期" else if (connected) "已登录" else "尚未登录")
            FieldLine("待云端确认", "${state.queuedCount} 项")
            FieldLine("最后成功同步（上海）", if (state.lastSuccess > 0) dateLabel(state.lastSuccess) else "尚未成功同步")
            val failed = state.bills.count { it.syncState == "failed" }
            val conflicts = state.bills.count { it.syncState == "conflict" }
            if (failed > 0 || conflicts > 0) Text("失败 $failed 项 · 冲突 $conflicts 项，请打开对应账单处理。",
                color = MaterialTheme.colorScheme.error)
            ErrorNotice(state.syncError)
            if (!connected || state.authExpired) Button(onClick = openLogin) { Text("登录云端账本") }
            else TextButton(colors = ButtonDefaults.textButtonColors(contentColor = actionTextColor()), onClick = { logoutConfirm = true }) { Text("退出云端登录") }
        }
        } }
        item {
            if (masterRequestsLoading) LinearProgressIndicator(Modifier.fillMaxWidth())
            ErrorNotice(masterRequestError)
            if (masterNotice.isNotBlank()) Text(masterNotice)
            if (pendingMasterRequests.isNotEmpty()) {
                SectionLabel("未确认的主数据请求")
                Text("原请求已保存在本机。请先核对并确认原请求，避免重复创建。",
                    style = MaterialTheme.typography.bodySmall)
            }
        }
        pendingMasterRequests.forEach { request ->
            item(key = "master-request:${request.operationId}") {
                ListItem(headlineContent = { Text(masterRequestTitle(request)) },
                    supportingContent = { Text(if (request.readError.isNotBlank()) request.readError
                        else if (request.lastStatus in listOf(401, 403)) "需要登录 · 原请求保留"
                        else request.lastError.ifBlank { "结果尚未确认 · 原请求保留" }) },
                    trailingContent = { Icon(Icons.Default.ChevronRight, null) },
                    modifier = Modifier.testTag("recover-master:${request.operationId}").clickable { recovery = request })
            }
        }
        item {
            if (state.bills.any { it.syncState in listOf("failed", "conflict", "unknown") }) SectionLabel("需处理的同步记录")
        }
        state.bills.filter { it.syncState in listOf("failed", "conflict", "unknown") }.forEach { bill ->
            item(key = "sync:${bill.billId}") { BillRow(bill, state.metadata) { openBill(bill.billId) } }
        }
        item {
            HorizontalDivider()
            SectionHeader("账户", "创建账户") { master("account") }
            Text("账面余额 · 非银行实时余额", style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (state.metadata.accounts.isEmpty()) Text("暂无账户", Modifier.padding(vertical = 16.dp))
        }
        state.metadata.accounts.forEach { account ->
            item(key = "account:${account.id}") {
                Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).clickable { accountId = account.id }.padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Icon(if (account.category == "3") Icons.Default.CreditCard else Icons.Default.AccountBalanceWallet, null)
                    Column(Modifier.weight(1f)) {
                        Text(account.name + if (account.active) "" else "（已停用）", style = MaterialTheme.typography.titleSmall)
                        Text(accountKinds.find { it.first == account.category }?.second ?: account.category,
                            style = MaterialTheme.typography.bodySmall)
                    }
                    Column(horizontalAlignment = Alignment.End, modifier = Modifier.widthIn(max = 160.dp)) {
                        Text(if (account.balanceExact) account.balance?.let { "¥${yuan(it)}" } ?: "未设置" else "余额待核对")
                        if (!account.balanceExact) Text("云端已确认 ${account.confirmedBalance?.let { "¥${yuan(it)}" } ?: "未设置"}",
                            style = MaterialTheme.typography.labelSmall)
                        else if (account.balancePending) Text("本机估算 · 待同步", style = MaterialTheme.typography.labelSmall)
                    }
                    Icon(Icons.Default.ChevronRight, null)
                }
            }
        }
        item { HorizontalDivider(); SectionHeader("分类", "创建分类") { master("category") } }
        state.metadata.categories.forEach { row ->
            item(key = "category:${row.id}") {
                ListItem(headlineContent = { Text(categoryLabel(state.metadata, row.id)) },
                    supportingContent = { Text(when (row.type) { 1 -> "收入"; 3 -> "转账"; else -> "支出" } + " · 排序 ${row.sortOrder}") },
                    trailingContent = { Icon(Icons.Default.Edit, "编辑分类") }, modifier = Modifier.clickable {
                        master("category", JSONObject().put("id", row.id).put("name", row.name).put("version", row.version)
                            .put("active", row.active).put("type", row.type).put("parentId", row.parentId ?: JSONObject.NULL)
                            .put("sortOrder", row.sortOrder))
                    })
            }
        }
        item { HorizontalDivider(); SectionHeader("标签", "创建标签") { master("tag") } }
        state.metadata.tags.forEach { row ->
            item(key = "tag:${row.id}") {
                ListItem(headlineContent = { Text(row.name + if (row.active) "" else "（已停用）") },
                    supportingContent = { Text("排序 ${row.sortOrder}") },
                    trailingContent = { Icon(Icons.Default.Edit, "编辑标签") }, modifier = Modifier.clickable {
                        master("tag", JSONObject().put("id", row.id).put("name", row.name).put("version", row.version)
                            .put("active", row.active).put("sortOrder", row.sortOrder))
                    })
            }
        }
        item {
            HorizontalDivider(); SectionLabel("自动采集与隐私")
            Text("两个权限均为可选，彼此独立。关闭后仍可手动记账。", style = MaterialTheme.typography.bodyMedium)
            PermissionRow("支付通知", capture.notificationPermission, capture.notificationConnected,
                "仅处理已启用应用的交易通知，不读取聊天、验证码或密码。") { actions.permission("notification") }
            PermissionRow("支付页面（无障碍）", capture.accessibilityPermission, capture.accessibilityConnected,
                "只读适配支付页面，不点击、不支付、不持续截图。") { actions.permission("accessibility") }
            ErrorNotice(capture.error)
            capture.sources.forEach { (source, enabled) ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(sourceName(source), style = MaterialTheme.typography.bodyMedium)
                        Text("适配与覆盖以实测结果为准", style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Switch(enabled, onCheckedChange = { actions.toggleSource(source, it) })
                }
            }
        }
        item {
            HorizontalDivider()
            TextButton(colors = ButtonDefaults.textButtonColors(contentColor = actionTextColor()), onClick = { trash = !trash }) {
                Icon(Icons.Default.DeleteOutline, null); Spacer(Modifier.width(8.dp))
                Text("回收站 · ${state.bills.count { it.status == "deleted" }}")
                Icon(if (trash) Icons.Default.ExpandLess else Icons.Default.ExpandMore, null)
            }
            if (trash) Text("删除后 30 天内可恢复。", style = MaterialTheme.typography.bodySmall)
        }
        if (trash) {
            val deleted = state.bills.filter { it.status == "deleted" }.sortedByDescending { it.deletedAt }
            if (deleted.isEmpty()) item { Text("回收站为空") }
            deleted.forEach { bill -> item(key = "trash:${bill.billId}") { BillRow(bill, state.metadata) { openBill(bill.billId) } } }
        }
    }
    accountId?.let { id ->
        state.metadata.accounts.find { it.id == id }?.let { account ->
            AccountPage(account, actions, close = { accountId = null },
                viewBills = { accountId = null; viewAccount(id) }, edit = {
                    accountId = null; master("account", account.json())
                }, balance = {
                    accountId = null; master("account", account.json(), "balance")
                }, openBill = { accountId = null; openBill(it) })
        }
    }
    dialog?.let { payload ->
        MasterForm(JSONObject(payload), state.metadata, actions, close = { dialog = null })
    }
    recovery?.let { request ->
        MasterRequestRecovery(request, actions, state.metadata, close = { recovery = null }, confirmed = {
            recovery = null
            masterNotice = "原请求已获云端确认，正在刷新账户、分类和标签。"
        })
    }
    if (logoutConfirm) AlertDialog(onDismissRequest = { logoutConfirm = false }, title = { Text("退出云端登录？") },
        text = { Text("本机账单和待上传操作会保留。重新登录后可继续同步。") },
        confirmButton = { TextButton(colors = ButtonDefaults.textButtonColors(contentColor = actionTextColor()), onClick = { actions.logout(); logoutConfirm = false }) { Text("退出") } },
        dismissButton = { TextButton(colors = ButtonDefaults.textButtonColors(contentColor = actionTextColor()), onClick = { logoutConfirm = false }) { Text("取消") } })
}

internal fun AccountView.json(): JSONObject = JSONObject().put("id", id).put("name", name).put("version", version)
    .put("category", category).put("currency", currency).put("active", active)
    .put("balance", balance?.toString() ?: JSONObject.NULL)
    .put("confirmedBalance", confirmedBalance?.toString() ?: JSONObject.NULL)
    .put("balancePending", balancePending).put("balanceExact", balanceExact)

@Composable
private fun SectionHeader(title: String, addLabel: String, add: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
        TextButton(colors = ButtonDefaults.textButtonColors(contentColor = actionTextColor()), onClick = add) { Icon(Icons.Default.Add, null); Text(addLabel) }
    }
}

@Composable
private fun PermissionRow(title: String, granted: Boolean, connected: Boolean, explanation: String, settings: () -> Unit) {
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = MaterialTheme.typography.titleSmall)
        Text(explanation, style = MaterialTheme.typography.bodySmall)
        Text("${if (granted) "系统权限已授权" else "系统权限未授权"} · ${if (connected) "服务已连接" else "服务未连接"}",
            style = MaterialTheme.typography.labelMedium)
        OutlinedButton(onClick = settings) { Icon(Icons.Default.Settings, null); Spacer(Modifier.width(8.dp)); Text("前往系统设置") }
    }
}

internal fun sourceName(source: String): String = when (source) {
    "com.tencent.mm" -> "微信"; "com.eg.android.AlipayGphone" -> "支付宝"; "cmb.pb" -> "招商银行"
    "com.cmbchina.ccd.pluto.cmbActivity" -> "掌上生活"; "com.unionpay" -> "云闪付"; "com.taobao.taobao" -> "淘宝"
    "com.jingdong.app.mall" -> "京东"; "com.xunmeng.pinduoduo" -> "拼多多"; "com.sankuai.meituan" -> "美团"
    else -> source
}

@Composable
private fun AccountPage(account: AccountView, actions: LedgerActions, close: () -> Unit, viewBills: () -> Unit,
    edit: () -> Unit, balance: () -> Unit, openBill: (String) -> Unit) {
    var history by remember { mutableStateOf<List<JSONObject>?>(null) }
    var error by remember { mutableStateOf("") }
    var attempt by remember { mutableStateOf(0) }
    LaunchedEffect(account.id, attempt) {
        history = null; error = ""
        try { history = actions.balanceHistory(account.id) }
        catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) { error = failure.message ?: "读取失败，请联网后重试" }
    }
    FormPage(account.name, close = close) {
        Text(if (account.category == "3") "账面余额（负数表示欠款）" else "账面余额", style = MaterialTheme.typography.labelLarge)
        Text(if (account.balanceExact) account.balance?.let { "¥${yuan(it)}" } ?: "未设置" else "余额待核对",
            style = MaterialTheme.typography.headlineMedium)
        if (!account.balanceExact) FieldLine("云端已确认余额",
            account.confirmedBalance?.let { "¥${yuan(it)}" } ?: "未设置")
        else if (account.balancePending) Text("本机估算 · 待同步", style = MaterialTheme.typography.bodyMedium)
        Button(onClick = viewBills, modifier = Modifier.fillMaxWidth()) { Text("查看账户账单") }
        OutlinedButton(onClick = edit, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Default.Edit, null); Text("编辑账户") }
        OutlinedButton(onClick = balance, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Default.Tune, null); Text("余额启停与校准") }
        SectionLabel("余额变动历史")
        if (error.isNotBlank()) { ErrorNotice(error); TextButton(colors = ButtonDefaults.textButtonColors(contentColor = actionTextColor()), onClick = { attempt++ }) { Text("重试读取") } }
        else if (history == null) LinearProgressIndicator(Modifier.fillMaxWidth())
        else if (history!!.isEmpty()) Text("暂无余额变动记录")
        else history!!.reversed().forEach { row ->
            val delta = row.optString("deltaCents").toLongOrNull()
            val after = row.optString("balanceAfterCents").toLongOrNull()
            FieldLine(when (row.optString("reason")) {
                "save" -> "记账 / 修改"; "delete" -> "删除撤销"; "restore" -> "恢复账单"; else -> "余额基准调整"
            }, "${delta?.let { (if (it > 0) "+" else "") + yuan(it) } ?: "基准调整"} · 变动后 ${after?.let { "¥${yuan(it)}" } ?: "未设置"}")
            row.optString("note").takeIf { it.isNotBlank() && it != "null" }?.let { Text(it) }
            row.optString("billId").takeIf { it.isNotBlank() && it != "null" }?.let { id ->
                TextButton(colors = ButtonDefaults.textButtonColors(contentColor = actionTextColor()), onClick = { openBill(id) }) { Text("查看关联账单") }
            }
            HorizontalDivider()
        }
    }
}
