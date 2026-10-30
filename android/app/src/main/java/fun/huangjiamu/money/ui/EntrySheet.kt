package `fun`.huangjiamu.money.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import `fun`.huangjiamu.money.data.LedgerItem
import `fun`.huangjiamu.money.data.UiState
import java.math.BigDecimal

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun EntrySheet(
    state: UiState, entry: LedgerItem?, onDismiss: () -> Unit,
    onSave: (String, String, String, String, String) -> Unit,
) {
    var amount by remember(entry?.id) { mutableStateOf(entry?.amountCents?.takeIf { it > 0 }
        ?.let { BigDecimal.valueOf(it, 2).toPlainString() } ?: "") }
    var type by remember(entry?.id) { mutableStateOf(entry?.type ?: "expense") }
    var merchant by remember(entry?.id) { mutableStateOf(entry?.merchant ?: "") }
    var category by remember(entry?.id) { mutableStateOf(
        entry?.category?.takeIf { it in if (entry?.type == "income") listOf("工资", "其他收入")
            else listOf("餐饮", "购物", "交通", "其他支出") }
            ?: if (entry?.type == "income") "其他收入" else "其他支出") }
    var account by remember(entry?.id) { mutableStateOf(
        state.accounts.firstOrNull { it.first == entry?.account }?.first
            ?: state.accounts.singleOrNull { it.second == entry?.account }?.first ?: "") }
    var error by remember { mutableStateOf("") }
    var submitted by remember { mutableStateOf(false) }
    var savingObserved by remember { mutableStateOf(false) }
    var submittedRevision by remember { mutableLongStateOf(0L) }
    var submittedNotice by remember { mutableStateOf("") }
    val editing = entry?.status == "posted"
    val latestEntry = entry?.let { original -> state.items.firstOrNull { it.id == original.id } }
    val canSave = entry == null || (latestEntry != null && latestEntry.canEdit &&
        latestEntry.status in listOf("pending", "posted"))
    LaunchedEffect(state.busy, state.notice, state.saveRevision, submitted) {
        if (submitted && state.busy) savingObserved = true
        if (submitted && !state.busy) {
            if (state.saveRevision > submittedRevision) onDismiss()
            else if (state.notice.isNotBlank() && (savingObserved || state.notice != submittedNotice)) {
                error = state.notice; submitted = false; savingObserved = false
            }
        }
    }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true,
        confirmValueChange = { !state.busy })
    ModalBottomSheet(onDismissRequest = { if (!state.busy) onDismiss() }, sheetState = sheetState) {
        Column(Modifier.fillMaxWidth().imePadding().verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp).padding(bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(if (entry == null) "记一笔" else if (editing) "编辑本地账单" else "核对并入账", style = MaterialTheme.typography.headlineSmall)
            if (entry != null) Text("来源：${entry.source.ifBlank { "自动采集" }}。请核对金额与账户，避免把同一次支付记两遍。",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            val typeChoices = listOf("expense" to "支出", "income" to "收入") +
                if (type !in listOf("expense", "income")) listOf(type to "${typeLabel(type)} · 暂不能入账") else emptyList()
            ChoiceField("收支类型", type, typeChoices, !state.busy) {
                type = it
                category = when (it) { "income" -> "其他收入"; "transfer" -> "账户互转"; "refund" -> "退款"; else -> "其他支出" }
            }
            OutlinedTextField(amount, { amount = it; error = "" }, label = { Text("金额（元）") },
                prefix = { Text("¥") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                singleLine = true, enabled = !state.busy, modifier = Modifier.fillMaxWidth(), isError = error.isNotEmpty(),
                supportingText = { Text(error.ifBlank { "大于 0，最多两位小数" }) })
            OutlinedTextField(merchant, { merchant = it.take(200) }, label = { Text("商户 / 备注") },
                enabled = !state.busy, modifier = Modifier.fillMaxWidth(), maxLines = 3)
            val categories = when (type) {
                "income" -> listOf("工资", "其他收入")
                "refund" -> listOf("退款")
                "transfer" -> listOf("账户互转", "信用卡还款")
                else -> listOf("餐饮", "购物", "交通", "其他支出")
            }.let { if (category in it) it else it + category }
            ChoiceField("分类", category, categories.map { it to it }, !state.busy) { category = it }
            ChoiceField("记账账户", account, listOf("" to "仅保存本地 · 暂不关联账户") + state.accounts, !state.busy) { account = it }
            if (!canSave) Text("这笔记录的状态已变化，暂不能编辑。请关闭后重新查看。",
                color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            Text(if (account.isBlank()) "未关联云端账户时只保存在这台手机，暂不上传。登录同步后可取得云端账户列表。"
                else "已关联账户。当前只同步已确认的支出和收入。",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (type !in listOf("expense", "income")) Text("本版暂不支持退款与转账入账，请保留待确认。只有确定被误识别时，才将它改为收入或支出。",
                style = MaterialTheme.typography.bodySmall)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(onClick = onDismiss, enabled = !state.busy, modifier = Modifier.weight(1f)) { Text("取消") }
                Button(enabled = !state.busy && !submitted && canSave && type in listOf("expense", "income"), modifier = Modifier.weight(1f), onClick = {
                    val normalized = amount.trim()
                    val valid = normalized.matches(Regex("\\d{1,10}(\\.\\d{1,2})?")) && runCatching {
                        normalized.toBigDecimal().movePointRight(2).longValueExact() in 1..9_007_199_254_740_991L
                    }.getOrDefault(false)
                    if (!valid) error = "请输入有效金额，最多两位小数"
                    else if (account.isNotBlank() && state.accounts.none { it.first == account }) error = "账户列表已变化，请重新选择账户"
                    else { savingObserved = false; submittedRevision = state.saveRevision
                        submittedNotice = state.notice; submitted = true
                        onSave(normalized, type, merchant.trim(), category, account) }
                }) { Text(if (state.busy) "保存中…" else if (editing) "保存修改" else if (entry == null) "保存" else "确认入账") }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ChoiceField(label: String, value: String, choices: List<Pair<String, String>>, enabled: Boolean, onSelect: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = expanded && enabled, onExpandedChange = { if (enabled) expanded = it }) {
        OutlinedTextField(value = choices.firstOrNull { it.first == value }?.second ?: value, onValueChange = {}, readOnly = true,
            label = { Text(label) }, enabled = enabled, trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
            modifier = Modifier.menuAnchor().fillMaxWidth())
        ExposedDropdownMenu(expanded = expanded && enabled, onDismissRequest = { expanded = false }) {
            choices.forEach { (id, name) -> DropdownMenuItem(text = { Text(name) }, onClick = { expanded = false; onSelect(id) }) }
        }
    }
}
