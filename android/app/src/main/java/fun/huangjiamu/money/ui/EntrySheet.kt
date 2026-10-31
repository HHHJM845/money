package `fun`.huangjiamu.money.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import org.json.JSONObject
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import `fun`.huangjiamu.money.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun EntrySheet(metadata: Metadata, bill: BillView?, refundOriginal: BillView? = null,
    save: suspend (String?, BillContent, String) -> Unit, close: () -> Unit, refundableCents: Long? = null, actions: LedgerActions? = null,
    pendingMasterRequests: List<PendingMasterRequest> = emptyList(), masterRequestError: String = "",
    masterRequestsLoading: Boolean = false) {
    var recovery by remember { mutableStateOf<PendingMasterRequest?>(null) }
    var creatingAccount by rememberSaveable { mutableStateOf(false) }
    var createdAccount by rememberSaveable { mutableStateOf<String?>(null) }
    var syncingAccount by remember { mutableStateOf(false) }
    val initial = bill?.content ?: refundOriginal?.content?.copy(kind = "refund", amountCents = null,
        refundOfBillId = refundOriginal.billId, occurredAt = System.currentTimeMillis(), note = "", tagIds = emptyList(),
        destinationAccountId = null, excludeFromStatistics = false, excludeFromBudget = false) ?: BillContent()
    var kind by rememberSaveable { mutableStateOf(initial.kind) }
    var amount by rememberSaveable { mutableStateOf(initial.amountCents?.let { yuan(it) }.orEmpty()) }
    var account by rememberSaveable { mutableStateOf(initial.accountId ?: if (bill == null && refundOriginal == null)
        metadata.accounts.firstOrNull { it.active && it.currency == "CNY" }?.id else null) }
    var destination by rememberSaveable { mutableStateOf(initial.destinationAccountId) }
    var category by rememberSaveable { mutableStateOf(initial.categoryId) }
    var parentCategory by rememberSaveable { mutableStateOf(metadata.categories.find { it.id == initial.categoryId }?.parentId) }
    var merchant by rememberSaveable { mutableStateOf(initial.merchant) }
    var note by rememberSaveable { mutableStateOf(initial.note) }
    var time by rememberSaveable { mutableStateOf(dateLabel(initial.occurredAt)) }
    var tags by rememberSaveable { mutableStateOf(initial.tagIds.toTypedArray()) }
    var exclude by rememberSaveable { mutableStateOf(initial.excludeFromStatistics) }
    var advanced by rememberSaveable { mutableStateOf(initial.excludeFromStatistics) }
    var error by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val gate = remember { SubmissionGate() }
    val scope = rememberCoroutineScope()
    val historical = bill?.takeIf { it.status == "posted" }?.content
    val accounts = metadata.accounts.filter { it.active || it.id == historical?.accountId || it.id == historical?.destinationAccountId }
        .map { it.id to (it.name + if (it.active) "" else "（已停用）") }
    val categoryType = when (kind) { "income" -> 1; "transfer" -> 3; else -> 2 }
    val categories = metadata.categories.filter { it.type == categoryType && (it.active ||
        it.id == historical?.categoryId || it.id == refundOriginal?.content?.categoryId) }
        .map { it.id to categoryLabel(metadata, it.id) }
    LaunchedEffect(createdAccount, metadata.accounts) {
        val confirmed = metadata.accounts.find { it.id == createdAccount && it.active }
        if (confirmed != null) { account = confirmed.id; createdAccount = null }
    }
    fun refreshAccount() {
        if (syncingAccount || actions == null) return
        syncingAccount = true
        scope.launch {
            try {
                if (!actions.synchronize()) error = "账户已创建，刷新尚未完成，请重试刷新账户"
            } catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) { error = "账户已创建，刷新失败：" + (failure.message ?: "网络不可用") }
            finally { syncingAccount = false }
        }
    }
    fun submit(status: String) {
        if (!gate.acquire()) return
        busy = true
        scope.launch {
            try {
                val content = BillContent(kind = kind,
                    amountCents = if (status == "pending" && amount.isBlank()) null else amountInput(amount),
                    accountId = account, categoryId = category, destinationAccountId = if (kind == "transfer") destination else null,
                    refundOfBillId = if (kind == "refund") initial.refundOfBillId else null,
                    occurredAt = parseDateTime(time), merchant = merchant.trim(), note = note.trim(),
                    tagIds = tags.toList(), excludeFromStatistics = exclude, excludeFromBudget = initial.excludeFromBudget)
                content.validate(status)
                save(bill?.billId, content, status)
                close()
            } catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) { error = failure.message ?: "保存失败，输入已保留" }
            finally { busy = false; gate.release() }
        }
    }

    Dialog(onDismissRequest = { if (!busy) close() }, properties = DialogProperties(
        usePlatformDefaultWidth = false, dismissOnBackPress = !busy, dismissOnClickOutside = false)) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxSize().systemBarsPadding().imePadding().padding(horizontal = 8.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    TextButton(colors = ButtonDefaults.textButtonColors(contentColor = actionTextColor()), onClick = close, enabled = !busy) { Text("返回") }
                    (if (initial.kind == "refund") listOf("refund") else listOf("expense", "income", "transfer")).forEach { option ->
                        FilterChip(selected = kind == option, enabled = !busy, onClick = {
                            if (kind != option) { kind = option; category = null; parentCategory = null; destination = null }
                        }, label = { Text(kindLabel(option)) })
                    }
                }
                Surface(Modifier.weight(1f).fillMaxWidth(), color = MaterialTheme.colorScheme.surface) {
                    Column(Modifier.verticalScroll(rememberScrollState()).padding(8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        val available = metadata.categories.filter { row -> categories.any { it.first == row.id } }
                        val roots = available.filter { row -> row.parentId == null || available.none { it.id == row.parentId } }
                        CategoryGrid(roots, category, parentCategory, !busy) { row ->
                            category = row.id
                            parentCategory = if (available.any { it.parentId == row.id }) row.id else null
                        }
                        val children = available.filter { it.parentId == parentCategory && parentCategory != null }
                        if (children.isNotEmpty()) {
                            HorizontalDivider()
                            CategoryGrid(children, category, null, !busy) { category = it.id }
                        }
                        if (categories.isEmpty()) Text("暂无此类型分类，可在“我的”管理分类")
                        if (initial.refundOfBillId != null) Text("关联原支出："+initial.refundOfBillId)
                        if (refundableCents != null) Text("当前可退款 ¥" + yuan(refundableCents) + "，以保存时校验为准")
                        if (metadata.accounts.none { it.active } && createdAccount == null)
                            Text("暂无可选账户，请创建账户后入账；也可先保存待确认。")
                        if (createdAccount != null) TextButton(colors = ButtonDefaults.textButtonColors(contentColor = actionTextColor()), onClick = { refreshAccount() }, enabled = !syncingAccount) { Text(if (syncingAccount) "正在刷新账户…" else "账户已创建 · 刷新账户后可用") }
                        if (masterRequestsLoading) Text("正在读取本机冻结请求，请稍候")
                        ErrorNotice(masterRequestError)
                        if (pendingMasterRequests.isNotEmpty()) Text("存在未确认请求，请先恢复原请求；当前账单输入会保留。")
                        if (actions != null && createdAccount == null) TextButton(colors = ButtonDefaults.textButtonColors(contentColor = actionTextColor()), onClick = {
                            if (pendingMasterRequests.isNotEmpty()) recovery = pendingMasterRequests.first()
                            else creatingAccount = true
                        }, enabled = !busy && !masterRequestsLoading && masterRequestError.isBlank()) { Text("创建账户") }
                        TextButton(colors = ButtonDefaults.textButtonColors(contentColor = actionTextColor()), onClick = { advanced = !advanced }, enabled = !busy) { Text(if (advanced) "收起更多" else "时间 / 商户 / 标签 / 更多") }
                        if (advanced) {
        OutlinedTextField(merchant, { merchant = it }, label = { Text("商户") }, enabled = !busy, singleLine = true,
            modifier = Modifier.fillMaxWidth().testTag("entry-merchant"))
        OutlinedTextField(time, { time = it }, label = { Text("发生时间（上海）") },
            placeholder = { Text("2026-10-30 14:30") }, singleLine = true, enabled = !busy, modifier = Modifier.fillMaxWidth())
        if (metadata.tags.isNotEmpty()) {
            SectionLabel("标签")
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                metadata.tags.filter { it.active || it.id in historical?.tagIds.orEmpty() }.forEach { tag ->
                    FilterChip(selected = tag.id in tags, enabled = !busy, label = {
                        Text(tag.name + if (tag.active) "" else "（已停用）")
                    }, onClick = { tags = if (tag.id in tags) tags.filter { it != tag.id }.toTypedArray() else tags + tag.id })
                }
            }
        }
        if (advanced) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("不计入统计", modifier = Modifier.weight(1f))
            Switch(exclude, { exclude = it }, enabled = !busy)
        }

                        }
                    }
                }
                Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    BasicTextField(note, { note = it }, singleLine = true, enabled = !busy,
                        textStyle = MaterialTheme.typography.bodyMedium.copy(color = MaterialTheme.colorScheme.onSurface),
                        decorationBox = { inner -> if (note.isEmpty()) Text("添加备注", color = MaterialTheme.colorScheme.onSurfaceVariant); inner() },
                        modifier = Modifier.weight(1f).testTag("entry-note"))
                    Text(amount.ifEmpty { "0.00" }, color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.headlineMedium, textAlign = TextAlign.End,
                        modifier = Modifier.weight(1f).testTag("entry-amount"))
                }
                Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface),
                    verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f)) {
                        CompactChoice(if (kind == "transfer") "转出账户" else "资金账户", account, accounts, !busy,
                            Modifier.testTag("entry-account")) { account = it }
                    }
                    if (kind == "transfer") Box(Modifier.weight(1f)) {
                        CompactChoice("转入账户", destination, accounts.filter { it.first != account }, !busy) { destination = it }
                    } else TextButton(colors = ButtonDefaults.textButtonColors(contentColor = actionTextColor()), onClick = { advanced = true }, enabled = !busy, modifier = Modifier.weight(1f)) {
                        Text(time.substringBefore(' '), maxLines = 1)
                    }
                }
                ErrorNotice(error)
                Row(Modifier.fillMaxWidth()) {
                    Column(Modifier.weight(3f).padding(end = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        listOf(listOf("1","2","3"), listOf("4","5","6"), listOf("7","8","9"), listOf(".","0","⌫")).forEach { row ->
                            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                row.forEach { key ->
                                    TextButton(onClick = { amount = keypadAmount(amount, key) }, enabled = !busy,
                                        shape = androidx.compose.foundation.shape.RoundedCornerShape(4.dp),
                                        colors = ButtonDefaults.textButtonColors(containerColor = MaterialTheme.colorScheme.surface, contentColor = MaterialTheme.colorScheme.onSurface),
                                        modifier = Modifier.weight(1f).height(52.dp).testTag("key-" + key)) {
                                        Text(key, style = MaterialTheme.typography.titleLarge)
                                    }
                                }
                            }
                        }
                    }
                    Column(Modifier.weight(1f)) {
                        Button(onClick = { submit("posted") }, enabled = !busy, shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp),
                            modifier = Modifier.fillMaxWidth().height(110.dp).testTag("entry-save")) {
                            Text(if (busy) "保存中…" else if (bill?.status == "pending") "确认入账" else "保存")
                        }
                        if (bill == null || bill.status == "pending") TextButton(colors = ButtonDefaults.textButtonColors(contentColor = actionTextColor()), onClick = { submit("pending") },
                            enabled = !busy, modifier = Modifier.fillMaxWidth().height(110.dp)) { Text("保存待确认") }
                    }
                }
            }
        }
    }
    if (actions != null) recovery?.let { request ->
        MasterRequestRecovery(request, actions, metadata, close = { recovery = null }, confirmed = {
            recovery = null
            error = "原请求已确认，请核对刷新后的账户资料。"
        })
    }
    if (creatingAccount && actions != null) MasterForm(JSONObject().put("entityType", "account"), metadata, actions,
        close = { creatingAccount = false }, onSaved = { result ->
            val snapshot = result.optJSONObject("snapshot")
            val id = result.optString("entityId")
            if (id.isNotBlank() && snapshot?.optBoolean("active", false) == true) {
                createdAccount = id
                refreshAccount()
            }
        })
}

internal fun keypadAmount(current: String, key: String): String {
    if (key == "⌫") return current.dropLast(1)
    if (key == ".") return if ("." in current) current else current.ifEmpty { "0" } + "."
    if (key.length != 1 || key[0] !in '0'..'9') return current
    if (current.substringAfter('.', "").length >= 2 && "." in current) return current
    if (current.count { it.isDigit() } >= 18) return current
    return if (current == "0") key else current + key
}
