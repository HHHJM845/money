package `fun`.huangjiamu.money.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
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
    save: suspend (String?, BillContent, String) -> Unit, close: () -> Unit, refundableCents: Long? = null) {
    val initial = bill?.content ?: refundOriginal?.content?.copy(kind = "refund", amountCents = null,
        refundOfBillId = refundOriginal.billId, occurredAt = System.currentTimeMillis(), note = "", tagIds = emptyList(),
        destinationAccountId = null, excludeFromStatistics = false, excludeFromBudget = false) ?: BillContent()
    var kind by rememberSaveable { mutableStateOf(initial.kind) }
    var amount by rememberSaveable { mutableStateOf(initial.amountCents?.let { yuan(it) }.orEmpty()) }
    var account by rememberSaveable { mutableStateOf(initial.accountId) }
    var destination by rememberSaveable { mutableStateOf(initial.destinationAccountId) }
    var category by rememberSaveable { mutableStateOf(initial.categoryId) }
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
    FormPage(if (refundOriginal != null) "登记退款" else if (bill?.status == "pending") "核对待确认账单" else if (bill != null) "编辑账单" else "记一笔",
        busy, close) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            (if (initial.kind == "refund") listOf("refund") else listOf("expense", "income", "transfer")).forEach { option ->
                FilterChip(selected = kind == option, enabled = !busy, onClick = {
                    if (kind != option) { kind = option; category = null; destination = null }
                }, label = { Text(kindLabel(option)) })
            }
        }
        OutlinedTextField(amount, { amount = it }, label = { Text("金额（元）") }, singleLine = true,
            enabled = !busy, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            textStyle = MaterialTheme.typography.headlineMedium,
            modifier = Modifier.fillMaxWidth().testTag("entry-amount"))
        if (initial.refundOfBillId != null) FieldLine("关联原支出", refundOriginal?.let {
            "${it.content.merchant.ifBlank { "支出" }} · ¥${yuan(it.content.amountCents)}"
        } ?: initial.refundOfBillId)
        if (refundableCents != null) Text("当前可退款 ¥${yuan(refundableCents)}，以保存时校验为准。",
            style = MaterialTheme.typography.bodySmall)
        ChoiceField(if (kind == "transfer") "转出账户" else if (kind == "refund") "退款到账账户" else "资金账户",
            account, accounts, !busy, modifier = Modifier.testTag("entry-account")) { account = it }
        if (kind == "transfer") ChoiceField("转入账户", destination, accounts.filter { it.first != account }, !busy) { destination = it }
        ChoiceField("分类", category, categories, !busy, modifier = Modifier.testTag("entry-category")) { category = it }
        if (metadata.accounts.none { it.active }) Text("暂无可选账户。可先保存待确认，登录后在“我的”创建账户。",
            style = MaterialTheme.typography.bodySmall)
        OutlinedTextField(merchant, { merchant = it }, label = { Text("商户") }, enabled = !busy, singleLine = true,
            modifier = Modifier.fillMaxWidth().testTag("entry-merchant"))
        OutlinedTextField(note, { note = it }, label = { Text("备注") }, enabled = !busy, minLines = 2,
            modifier = Modifier.fillMaxWidth().testTag("entry-note"))
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
        TextButton(onClick = { advanced = !advanced }, enabled = !busy) { Text(if (advanced) "收起高级设置" else "高级设置") }
        if (advanced) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("不计入统计", modifier = Modifier.weight(1f))
            Switch(exclude, { exclude = it }, enabled = !busy)
        }
        ErrorNotice(error)
        Button(onClick = { submit("posted") }, enabled = !busy, modifier = Modifier.fillMaxWidth().testTag("entry-save")) {
            Text(if (busy) "正在保存…" else if (bill?.status == "pending") "确认入账" else "保存到本机")
        }
        if (bill == null || bill.status == "pending") OutlinedButton(onClick = { submit("pending") }, enabled = !busy,
            modifier = Modifier.fillMaxWidth()) { Text("保存待确认") }
        Text("本机保存后进入同步队列；云端确认可在账单详情查看。", style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(12.dp))
    }
}
