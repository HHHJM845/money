package `fun`.huangjiamu.money.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import `fun`.huangjiamu.money.data.LedgerItem
import `fun`.huangjiamu.money.data.UiState
import java.math.BigDecimal
import java.time.Instant
import java.time.YearMonth
import java.time.ZoneId
import java.time.format.DateTimeFormatter

internal val ledgerZone: ZoneId = ZoneId.of("Asia/Shanghai")
internal fun ledgerDate(item: LedgerItem) = Instant.ofEpochMilli(item.time).atZone(ledgerZone)
internal fun money(cents: Long): String = money(BigDecimal.valueOf(cents))
internal fun money(cents: BigDecimal): String = "¥" + cents.movePointLeft(2).setScale(2).toPlainString()
internal fun typeLabel(type: String) = when (type) {
    "expense" -> "支出"; "income" -> "收入"; "transfer" -> "转账"
    "refund" -> "退款"; else -> "待识别"
}
private fun total(items: List<LedgerItem>, type: String): BigDecimal = items.filter { it.type == type }
    .fold(BigDecimal.ZERO) { sum, item -> sum + BigDecimal.valueOf(item.amountCents) }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MoneyApp(
    state: UiState,
    onAdd: (amount: String, type: String, merchant: String, category: String, accountId: String) -> Unit,
    onConfirm: (id: String, amount: String, type: String, merchant: String, category: String, accountId: String) -> Unit,
    onIgnore: (String) -> Unit, onDelete: (String) -> Unit,
    onNotificationSettings: () -> Unit, onAccessibilitySettings: () -> Unit,
    onSync: () -> Unit, onLogin: (username: String, password: String) -> Unit, onLogout: () -> Unit,
) {
    MoneyTheme {
        var tab by rememberSaveable { mutableIntStateOf(0) }
        var monthText by rememberSaveable { mutableStateOf(YearMonth.now(ledgerZone).toString()) }
        val month = YearMonth.parse(monthText)
        var adding by remember { mutableStateOf(false) }
        var confirming by remember { mutableStateOf<LedgerItem?>(null) }
        var detail by remember { mutableStateOf<LedgerItem?>(null) }
        var deleting by remember { mutableStateOf<LedgerItem?>(null) }
        var ignoring by remember { mutableStateOf<LedgerItem?>(null) }
        val snackbar = remember { SnackbarHostState() }
        LaunchedEffect(state.notice) { if (state.notice.isNotBlank()) snackbar.showSnackbar(state.notice) }
        val posted = state.items.filter { it.status == "posted" && YearMonth.from(ledgerDate(it)) == month }
            .sortedByDescending { it.time }
        val pending = state.items.filter { it.status == "pending" }.sortedByDescending { it.time }
        val titles = listOf("账单", "待确认", "统计", "我的")
        val icons = listOf(Icons.Outlined.ReceiptLong, Icons.Outlined.Inbox, Icons.Outlined.BarChart, Icons.Outlined.PersonOutline)
        Scaffold(
            topBar = { TopAppBar(title = { Column {
                Text(titles[tab], fontWeight = FontWeight.SemiBold)
                Text("见财 · 真机验证版", style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            } }, actions = {
                if (state.cloudConnected) IconButton(onClick = onSync, enabled = !state.busy) {
                    Icon(Icons.Outlined.Sync, "立即同步")
                }
            }) },
            bottomBar = { NavigationBar { titles.forEachIndexed { index, title ->
                NavigationBarItem(selected = tab == index, onClick = { tab = index }, icon = {
                    BadgedBox(badge = { if (index == 1 && pending.isNotEmpty()) Badge { Text(pending.size.toString()) } }) {
                        Icon(icons[index], contentDescription = null)
                    }
                }, label = { Text(title) })
            } } },
            floatingActionButton = { if (tab == 0) ExtendedFloatingActionButton(
                onClick = { if (!state.busy) adding = true }, icon = { Icon(Icons.Outlined.Add, null) }, text = { Text("记一笔") }) },
            snackbarHost = { SnackbarHost(snackbar) },
        ) { padding ->
            Column(Modifier.padding(padding).fillMaxSize()) {
                if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                when (tab) {
                    0 -> LazyColumn(contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 100.dp)) {
                        item { MonthSelector(month, { monthText = it.toString() }) }
                        item { Summary(posted) }
                        if (pending.isNotEmpty()) item {
                            TextButton(onClick = { tab = 1 }, modifier = Modifier.fillMaxWidth()) {
                                Text("${pending.size} 笔待核对，确认后计入收支")
                                Spacer(Modifier.weight(1f)); Icon(Icons.Outlined.ChevronRight, null)
                            }
                        }
                        if (posted.isEmpty()) item { EmptyMessage("这个月还没有账单", "记下第一笔收支，或在「我的」开启自动采集。") }
                        posted.groupBy { ledgerDate(it).toLocalDate() }.forEach { (day, entries) ->
                            item(key = "day-$day") { Text(day.format(DateTimeFormatter.ofPattern("M月d日 EEEE")),
                                modifier = Modifier.padding(top = 24.dp, bottom = 8.dp), style = MaterialTheme.typography.labelLarge,
                                color = MaterialTheme.colorScheme.onSurfaceVariant) }
                            items(entries, key = { it.id }) { entry -> EntryRow(entry, state.accounts) { detail = entry } }
                        }
                    }
                    1 -> LazyColumn(contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        item { Text("先核对，再入账", style = MaterialTheme.typography.titleMedium)
                            Text("自动识别可能遗漏或重复。请检查金额、收支类型与付款账户；这里的记录尚未计入统计。",
                                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        if (pending.isEmpty()) item { EmptyMessage("没有待确认的账单", "新的采集记录会出现在这里。是否采集成功取决于通知内容与支付页面。") }
                        items(pending, key = { it.id }) { entry ->
                            Column {
                                EntryRow(entry, state.accounts) { confirming = entry }
                                if (entry.reason.isNotBlank()) Text(entry.reason, style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 8.dp))
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                                    TextButton(onClick = { ignoring = entry }, enabled = !state.busy) { Text("忽略") }
                                    FilledTonalButton(onClick = { confirming = entry }, enabled = !state.busy) { Text("核对入账") }
                                }
                            }
                        }
                    }
                    2 -> LazyColumn(contentPadding = PaddingValues(20.dp)) {
                        item { MonthSelector(month, { monthText = it.toString() }); Summary(posted) }
                        item { Text("支出分类", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(vertical = 24.dp)) }
                        val expenses = posted.filter { it.type == "expense" }
                        if (expenses.isEmpty()) item { EmptyMessage("暂无支出统计", "已确认的支出会按分类汇总在这里。") }
                        val groups = expenses.groupBy { it.category.ifBlank { "其他支出" } }
                            .map { (name, entries) -> name to total(entries, "expense") }.sortedByDescending { it.second }
                        items(groups) { (category, amount) ->
                            Row(Modifier.fillMaxWidth().padding(vertical = 14.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text(category, modifier = Modifier.weight(1f)); Text(money(amount), fontWeight = FontWeight.Medium)
                            }; HorizontalDivider()
                        }
                        item { Text("仅统计已入账记录；转账不计收支。退款单列展示，分类排行显示原始支出金额。",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(vertical = 24.dp)) }
                    }
                    else -> SettingsPage(state, onNotificationSettings, onAccessibilitySettings, onSync, onLogin, onLogout)
                }
            }
        }
        if (adding || confirming != null) {
            val entry = confirming
            EntrySheet(state, entry, onDismiss = { if (!state.busy) { adding = false; confirming = null } }) { amount, type, merchant, category, account ->
                if (entry == null) onAdd(amount, type, merchant, category, account)
                else {
                    val current = state.items.firstOrNull { it.id == entry.id }
                    if (current != null && current.canEdit && current.status in listOf("pending", "posted")) {
                        onConfirm(entry.id, amount, type, merchant, category, account)
                    } else confirming = null
                }
            }
        }
        detail?.let { selected -> state.items.firstOrNull { it.id == selected.id }?.let { entry ->
            AlertDialog(onDismissRequest = { detail = null }, title = { Text(entry.merchant.ifBlank { typeLabel(entry.type) }) },
            text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("${typeLabel(entry.type)} ${money(entry.amountCents)}", style = MaterialTheme.typography.headlineSmall)
                Text(ledgerDate(entry).format(DateTimeFormatter.ofPattern("yyyy年M月d日 HH:mm")))
                Text("分类：${entry.category.ifBlank { "未分类" }}")
                Text("账户：${accountLabel(entry.account, state.accounts)}")
                Text("来源：${entry.source.ifBlank { "手动" }} · 已入账")
                if (entry.reason.isNotBlank()) Text(entry.reason)
                Text(if (editableLocalEntry(entry)) "可编辑本地记录并选择云端账户。登录后保存会尝试上传，结果以同步状态为准。"
                    else "已同步或上传结果待确认的账单暂不能编辑、删除，请先核对同步结果。", style = MaterialTheme.typography.bodySmall)
                if (editableLocalEntry(entry)) OutlinedButton(enabled = !state.busy, onClick = { detail = null; confirming = entry }) {
                    Text("编辑 / 关联云端账户")
                }
            } }, confirmButton = { TextButton(onClick = { detail = null }) { Text("关闭") } },
            dismissButton = { if (editableLocalEntry(entry)) TextButton(enabled = !state.busy,
                onClick = { detail = null; deleting = entry }) { Text("删除本地记录") } }) } }
        deleting?.let { entry -> AlertDialog(onDismissRequest = { deleting = null }, title = { Text("删除这笔本地记录？") },
            text = { Text("${entry.merchant.ifBlank { typeLabel(entry.type) }} ${money(entry.amountCents)}。删除不可撤销；已同步云端的账单不支持在此删除。") },
            confirmButton = { TextButton(enabled = !state.busy && state.items.any { it.id == entry.id && editableLocalEntry(it) },
                onClick = { if (state.items.any { it.id == entry.id && editableLocalEntry(it) }) onDelete(entry.id); deleting = null }) { Text("删除") } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("取消") } }) }
        ignoring?.let { entry -> AlertDialog(onDismissRequest = { ignoring = null }, title = { Text("忽略这条采集记录？") },
            text = { Text("它将从待确认列表移除，不计入收支。") },
            confirmButton = { TextButton(enabled = !state.busy, onClick = { onIgnore(entry.id); ignoring = null }) { Text("忽略") } },
            dismissButton = { TextButton(onClick = { ignoring = null }) { Text("取消") } }) }
    }
}

internal fun editableLocalEntry(entry: LedgerItem): Boolean =
    entry.status == "posted" && entry.canEdit

internal fun accountLabel(id: String, accounts: List<Pair<String, String>>): String =
    accounts.firstOrNull { it.first == id }?.second
        ?: accounts.firstOrNull { it.second == id }?.second
        ?: if (id.isBlank() || id == "未指定账户") "本地记录 · 未关联账户" else id

@Composable
private fun MonthSelector(month: YearMonth, onMonth: (YearMonth) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = { onMonth(month.minusMonths(1)) }) { Icon(Icons.Outlined.ChevronLeft, "上个月") }
        Text("${month.year}年${month.monthValue}月", style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.weight(1f))
        if (month != YearMonth.now(ledgerZone)) TextButton(onClick = { onMonth(YearMonth.now(ledgerZone)) }) { Text("本月") }
        IconButton(onClick = { onMonth(month.plusMonths(1)) }) { Icon(Icons.Outlined.ChevronRight, "下个月") }
    }
}

@Composable
private fun Summary(items: List<LedgerItem>) {
    Column(Modifier.padding(vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("本月支出", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(money(total(items, "expense")), style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.SemiBold)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
            Column(Modifier.weight(1f)) { Text("收入", style = MaterialTheme.typography.labelMedium); Text(money(total(items, "income"))) }
            Column(Modifier.weight(1f)) { Text("退款", style = MaterialTheme.typography.labelMedium); Text(money(total(items, "refund"))) }
        }
        HorizontalDivider(Modifier.padding(top = 12.dp))
    }
}

@Composable
private fun EntryRow(entry: LedgerItem, accounts: List<Pair<String, String>>, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 14.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(entry.merchant.ifBlank { entry.category.ifBlank { typeLabel(entry.type) } }, maxLines = 2, overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
                Text("${typeLabel(entry.type)} · ${entry.category.ifBlank { "未分类" }}", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(if (entry.type == "unknown" && entry.amountCents == 0L) "待核对" else money(entry.amountCents),
                style = MaterialTheme.typography.titleMedium,
                color = if (entry.type == "income") MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
        }
        Text("${ledgerDate(entry).format(DateTimeFormatter.ofPattern("MM-dd HH:mm"))} · ${entry.source.ifBlank { "手动" }} · ${accountLabel(entry.account, accounts)}",
            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 6.dp), maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
internal fun EmptyMessage(title: String, description: String) {
    Column(Modifier.fillMaxWidth().padding(vertical = 40.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text(description, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
