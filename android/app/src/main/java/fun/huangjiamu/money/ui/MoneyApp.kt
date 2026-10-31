package `fun`.huangjiamu.money.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import `fun`.huangjiamu.money.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.time.YearMonth

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun MoneyApp(state: LedgerState, actions: LedgerActions, capture: CaptureUiState = CaptureUiState(),
    connected: Boolean = false, loading: Boolean = false, loadError: String = "", syncing: Boolean = false,
    pendingMasterRequests: List<PendingMasterRequest> = emptyList(), masterRequestError: String = "",
    masterRequestsLoading: Boolean = false) {
    var page by rememberSaveable { mutableStateOf(0) }
    var month by rememberSaveable { mutableStateOf(currentMonth()) }
    var query by rememberSaveable { mutableStateOf("") }
    var account by rememberSaveable { mutableStateOf<String?>(null) }
    var category by rememberSaveable { mutableStateOf<String?>(null) }
    var tag by rememberSaveable { mutableStateOf<String?>(null) }
    var source by rememberSaveable { mutableStateOf<String?>(null) }
    var kind by rememberSaveable { mutableStateOf<String?>(null) }
    var from by rememberSaveable { mutableStateOf("") }
    var until by rememberSaveable { mutableStateOf("") }
    var filtersOpen by rememberSaveable { mutableStateOf(false) }
    var listMode by rememberSaveable { mutableStateOf("posted") }
    var detailId by rememberSaveable { mutableStateOf<String?>(null) }
    var entry by rememberSaveable { mutableStateOf<String?>(null) }
    var loginOpen by rememberSaveable { mutableStateOf(false) }
    var message by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    val filter = BillFilter(query, account, category, tag, source, kind, from, until)
    val totals = remember(state.bills, month) { runCatching { summarizeBills(state.bills, month) } }
    val pendingCount = state.bills.count { it.status == "pending" }
    fun resetFilters() { query = ""; account = null; category = null; tag = null; source = null; kind = null; from = ""; until = "" }
    Scaffold(topBar = {
        TopAppBar(title = {
            Text(listOf("见财 · 账单", "统计", "我的")[page], fontWeight = FontWeight.SemiBold)
        }, actions = {
            IconButton(enabled = !syncing, onClick = {
                scope.launch {
                    try { message = if (actions.synchronize()) "同步完成，请留意账单独立状态" else "同步未完成，请检查登录或失败记录" }
                    catch (cancel: CancellationException) { throw cancel }
                    catch (failure: Exception) { message = failure.message ?: "同步失败" }
                }
            }) { Icon(Icons.Default.Sync, if (syncing) "正在同步" else "立即同步") }
        })
    }, bottomBar = {
        NavigationBar {
            listOf("账单" to Icons.Default.ReceiptLong, "统计" to Icons.Default.BarChart, "我的" to Icons.Default.PersonOutline)
                .forEachIndexed { index, item ->
                    NavigationBarItem(page == index, onClick = { page = index },
                        icon = { Icon(item.second, null) }, label = { Text(item.first) },
                        modifier = Modifier.testTag("nav-$index"))
                }
        }
    }, floatingActionButton = {
        if (page == 0) ExtendedFloatingActionButton(onClick = { entry = "new" },
            icon = { Icon(Icons.Default.Add, null) }, text = { Text("记一笔") }, modifier = Modifier.testTag("new-entry"))
    }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            if (loading) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            if (loadError.isNotBlank()) ErrorNotice(loadError)
            if (state.authExpired || state.syncError.isNotBlank() || state.queuedCount > 0 || syncing) {
                Surface(color = if (state.authExpired || state.syncError.isNotBlank()) MaterialTheme.colorScheme.errorContainer
                    else MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(when { state.authExpired -> "需要重新登录"; syncing -> "正在同步"
                                else -> "${state.queuedCount} 项待云端确认" }, style = MaterialTheme.typography.labelLarge)
                            if (state.syncError.isNotBlank()) Text(state.syncError, style = MaterialTheme.typography.bodySmall,
                                maxLines = 3, overflow = TextOverflow.Ellipsis)
                        }
                        if (state.authExpired) TextButton(colors = ButtonDefaults.textButtonColors(contentColor = actionTextColor()), onClick = { loginOpen = true }) { Text("登录") }
                    }
                }
            }
            if (message.isNotBlank()) Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Text(message, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                IconButton(onClick = { message = "" }) { Icon(Icons.Default.Close, "关闭提示") }
            }
            when (page) {
                0 -> {
                    val shown = state.bills.filter { it.status == listMode &&
                        (listMode == "pending" || dateLabel(it.content.occurredAt, "yyyy-MM") == month) &&
                        filter.matches(it, state.metadata, state.bills) }.sortedByDescending { it.content.occurredAt }
                    BillList(shown, state.metadata, pending = listMode == "pending", open = { detailId = it.billId }, header = {
                        MonthSelector(month) { month = it }
                        totals.fold(onSuccess = { MonthlySummary(it) }, onFailure = { ErrorNotice(it.message ?: "统计金额超出范围") })
                        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically) {
                            FilterChip(listMode == "posted", onClick = { listMode = "posted" }, label = { Text("流水") })
                            FilterChip(listMode == "pending", onClick = { listMode = "pending" }, label = { Text("待确认 $pendingCount") })
                            Spacer(Modifier.weight(1f))
                            IconButton(onClick = { filtersOpen = !filtersOpen }) { Icon(Icons.Default.FilterList, "筛选账单") }
                        }
                        OutlinedTextField(query, { query = it }, placeholder = { Text("搜索商户、备注、分类") },
                            leadingIcon = { Icon(Icons.Default.Search, null) }, singleLine = true,
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("bill-search"))
                    })
                    if (filtersOpen) {
                        Filters(metadata = state.metadata, bills = state.bills, filter = filter, close = { filtersOpen = false },
                            chooseAccount = { account = it }, chooseCategory = { category = it }, chooseTag = { tag = it },
                            chooseSource = { source = it }, chooseKind = { kind = it }, chooseFrom = { from = it },
                            chooseUntil = { until = it }, reset = { resetFilters() })
                    }
                }
                1 -> {
                    MonthSelector(month) { month = it }
                    StatisticsPage(state, month, openCategory = {
                        resetFilters(); category = it ?: ""; listMode = "posted"; page = 0
                    }, openDay = {
                        resetFilters(); from = it; until = it; listMode = "posted"; page = 0
                    })
                }
                2 -> SettingsPage(state, actions, capture, connected, openLogin = { loginOpen = true },
                    openBill = { detailId = it }, viewAccount = {
                        resetFilters(); account = it; listMode = "posted"; page = 0
                    }, pendingMasterRequests = pendingMasterRequests, masterRequestError = masterRequestError,
                    masterRequestsLoading = masterRequestsLoading)
            }
        }
    }
    detailId?.let { id ->
        val bill = state.bills.find { it.billId == id }
        if (bill != null) BillDetail(bill, state, actions, close = { detailId = null },
            edit = { detailId = null; entry = id }, refund = { detailId = null; entry = "refund:$id" },
            linked = { detailId = it })
        else FormPage("账单详情", close = { detailId = null }) { Text("此记录已过期清理或不再可用。") }
    }
    entry?.let { key ->
        val bill = state.bills.find { it.billId == key }
        val original = key.takeIf { it.startsWith("refund:") }?.substringAfter(':')?.let { id -> state.bills.find { it.billId == id } }
        if (key != "new" && bill == null && original == null) {
            FormPage("账单不可用", close = { entry = null }) { Text("此记录已过期清理或不再可用，请返回重新选择。") }
        } else {
            val refundable = original?.let { sourceBill ->
                runCatching {
                    val used = state.bills.filter { it.status == "posted" && it.content.refundOfBillId == sourceBill.billId }
                        .fold(java.math.BigInteger.ZERO) { sum, refund -> sum + (refund.content.amountCents ?: 0).toBigInteger() }
                    `fun`.huangjiamu.money.domain.LedgerCore.exactCents((sourceBill.content.amountCents ?: 0).toBigInteger() - used)
                }.getOrNull()
            }
            EntrySheet(state.metadata, bill, original, save = { id, content, status ->
                actions.save(id, content, status)
                message = "已保存到本机，等待云端确认"
            }, close = { entry = null }, refundableCents = refundable, actions = actions,
                pendingMasterRequests = pendingMasterRequests, masterRequestError = masterRequestError,
                masterRequestsLoading = masterRequestsLoading)
        }
    }
    if (loginOpen) LoginPage(actions.login, close = { loginOpen = false })
}

@Composable
internal fun MonthSelector(month: String, choose: (String) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = { choose(YearMonth.parse(month).minusMonths(1).toString()) }) {
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, "上个月")
        }
        Text("${month.substring(0, 4)} 年 ${month.substring(5).toInt()} 月", style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.weight(1f))
        TextButton(colors = ButtonDefaults.textButtonColors(contentColor = actionTextColor()), onClick = { choose(currentMonth()) }) { Text("本月") }
        IconButton(onClick = { choose(YearMonth.parse(month).plusMonths(1).toString()) }) {
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, "下个月")
        }
    }
}

@Composable
internal fun MonthlySummary(totals: `fun`.huangjiamu.money.domain.SummaryTotals) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp)) {
        Text("净支出", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text("¥${yuan(totals.netExpenseCents)}", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.testTag("net-expense"))
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("收入 ¥${yuan(totals.incomeCents)}    月结余  ¥${yuan(totals.surplusCents)}", modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
            IconButton(onClick = { expanded = !expanded }) {
                Icon(if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore, "展开收支明细")
            }
        }
        if (expanded) {
            Text("收入 ¥${yuan(totals.incomeCents)}   原始支出 ¥${yuan(totals.expenseCents)}",
                style = MaterialTheme.typography.bodySmall)
            Text("退款 ¥${yuan(totals.refundCents)}", style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
internal fun BillList(bills: List<BillView>, metadata: Metadata, pending: Boolean = false,
    header: @Composable () -> Unit = {}, open: (BillView) -> Unit) {
    LazyColumn(modifier = Modifier.fillMaxSize().testTag("bill-list"), contentPadding = PaddingValues(bottom = 96.dp)) {
        item(key = "header") { Column { header() } }
        if (pending) item {
            Text("待确认项不计入正式统计，不改变账面余额。", Modifier.padding(16.dp),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (bills.isEmpty()) item {
            Column(Modifier.fillMaxWidth().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(Icons.Default.ReceiptLong, null, Modifier.size(32.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(if (pending) "没有待确认账单" else "没有符合条件的账单", Modifier.padding(top = 12.dp))
            }
        }
        bills.groupBy { dateLabel(it.content.occurredAt, "yyyy-MM-dd") }.forEach { (day, rows) ->
            item(key = "day:$day") {
                Surface(color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = .45f), modifier = Modifier.fillMaxWidth()) {
                    Text(day, Modifier.padding(horizontal = 20.dp, vertical = 8.dp), style = MaterialTheme.typography.labelLarge)
                }
            }
            items(rows, key = { it.billId }) { BillRow(it, metadata) { open(it) } }
        }
    }
}

@Composable
internal fun BillRow(bill: BillView, metadata: Metadata, open: () -> Unit) {
    val c = bill.content
    Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).clickable(onClick = open).padding(horizontal = 20.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Surface(shape = androidx.compose.foundation.shape.CircleShape, color = MaterialTheme.colorScheme.background) {
            Icon(categoryIcon(categoryLabel(metadata, c.categoryId)), null, Modifier.padding(10.dp).size(22.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(categoryLabel(metadata, c.categoryId), maxLines = 2, overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
            Text("${dateLabel(c.occurredAt, "HH:mm")} · ${accountLabel(metadata, c.accountId)}",
                maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (c.merchant.isNotBlank() || c.note.isNotBlank()) Text(c.merchant.ifBlank { c.note },
                maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall)
            if (bill.syncState != "synced") Text(syncLabel(bill.syncState), style = MaterialTheme.typography.labelSmall,
                color = if (bill.syncState in listOf("failed", "conflict")) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Column(horizontalAlignment = Alignment.End, modifier = Modifier.widthIn(max = 140.dp)) {
            Text((when (c.kind) { "income", "refund" -> "+"; "expense" -> "−"; else -> "" }) + yuan(c.amountCents),
                style = MaterialTheme.typography.titleMedium,
                color = if (c.kind == "expense") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
        }
    }
    HorizontalDivider(Modifier.padding(start = 56.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .5f))
}

@Composable
private fun Filters(metadata: Metadata, bills: List<BillView>, filter: BillFilter, close: () -> Unit,
    chooseAccount: (String?) -> Unit, chooseCategory: (String?) -> Unit, chooseTag: (String?) -> Unit,
    chooseSource: (String?) -> Unit, chooseKind: (String?) -> Unit, chooseFrom: (String) -> Unit,
    chooseUntil: (String) -> Unit, reset: () -> Unit) {
    FormPage("筛选账单", close = close) {
        ChoiceField("账户", filter.account, metadata.accounts.map { it.id to accountLabel(metadata, it.id) }, choose = chooseAccount)
        ChoiceField("分类（包含子分类）", filter.category, listOf("" to "未分类") + metadata.categories.map { it.id to categoryLabel(metadata, it.id) },
            choose = chooseCategory)
        ChoiceField("标签", filter.tag, metadata.tags.map { it.id to it.name }, choose = chooseTag)
        ChoiceField("来源", filter.source, bills.flatMap { it.sources }.map { it.optString("app") }.distinct().map { it to sourceName(it) }, choose = chooseSource)
        ChoiceField("类型", filter.kind, listOf("expense", "income", "refund", "transfer").map { it to kindLabel(it) }, choose = chooseKind)
        OutlinedTextField(filter.from, chooseFrom, label = { Text("开始日期 yyyy-MM-dd") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(filter.until, chooseUntil, label = { Text("结束日期 yyyy-MM-dd") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        val datesValid = listOf(filter.from, filter.until).all { it.isBlank() || runCatching { java.time.LocalDate.parse(it) }.isSuccess } &&
            (filter.from.isBlank() || filter.until.isBlank() || filter.from <= filter.until)
        if (!datesValid) ErrorNotice("请输入有效日期，结束日期不能早于开始日期")
        Button(onClick = close, enabled = datesValid, modifier = Modifier.fillMaxWidth()) { Text("查看结果") }
        TextButton(colors = ButtonDefaults.textButtonColors(contentColor = actionTextColor()), onClick = reset) { Text("清除筛选") }
    }
}
