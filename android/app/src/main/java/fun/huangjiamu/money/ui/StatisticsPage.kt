package `fun`.huangjiamu.money.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import `fun`.huangjiamu.money.data.LedgerState

@Composable
internal fun StatisticsPage(state: LedgerState, month: String, openCategory: (String?) -> Unit, openDay: (String) -> Unit) {
    val totals = remember(state.bills, month) { runCatching { summarizeBills(state.bills, month) } }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        item {
            totals.fold(onSuccess = {
                Surface(color = MaterialTheme.colorScheme.surface) { MonthlySummary(it) }
                FieldLine("原始支出", "¥${yuan(it.expenseCents)}")
                FieldLine("退款（到账月）", "¥${yuan(it.refundCents)}")
                FieldLine("月结余", "¥${yuan(it.surplusCents)}")
            }, onFailure = { ErrorNotice(it.message ?: "金额超出统计范围") })
        }
        item { SectionLabel("分类净支出"); Text("退款归属原消费分类", style = MaterialTheme.typography.bodySmall) }
        val included = state.bills.filter { it.status == "posted" && !it.content.excludeFromStatistics &&
            it.content.kind in listOf("expense", "refund") && dateLabel(it.content.occurredAt, "yyyy-MM") == month }
        val groups = included.groupBy { bill ->
            val categoryId = if (bill.content.kind == "refund") state.bills.find { it.billId == bill.content.refundOfBillId }?.content?.categoryId
                ?: bill.content.categoryId else bill.content.categoryId
            state.metadata.categories.find { it.id == categoryId }?.parentId ?: categoryId
        }.map { (id, bills) -> id to runCatching { summarizeBills(bills, month).netExpenseCents } }
            .sortedByDescending { it.second.getOrNull() ?: Long.MIN_VALUE }
        if (groups.isEmpty()) item { Text("本月暂无消费", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        groups.forEach { (id, amount) ->
            item {
                Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).clickable { openCategory(id) }.padding(12.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(categoryLabel(state.metadata, id), Modifier.weight(1f))
                        Text(amount.getOrNull()?.let { "¥${yuan(it)}" } ?: "金额超出范围")
                    }
                    val max = groups.mapNotNull { it.second.getOrNull() }.maxOrNull()?.coerceAtLeast(1) ?: 1
                    LinearProgressIndicator(progress = {
                        ((amount.getOrNull() ?: 0).coerceAtLeast(0).toDouble() / max.toDouble()).toFloat().coerceIn(0f, 1f)
                    }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                }
            }
        }
        item { SectionLabel("每日收支") }
        state.bills.filter { it.status == "posted" && !it.content.excludeFromStatistics &&
            it.content.kind != "transfer" && dateLabel(it.content.occurredAt, "yyyy-MM") == month }
            .groupBy { dateLabel(it.content.occurredAt, "yyyy-MM-dd") }.toSortedMap(reverseOrder()).forEach { (day, bills) ->
                item {
                    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).clickable { openDay(day) }.padding(12.dp)) {
                        Text(day, style = MaterialTheme.typography.labelLarge)
                        runCatching { summarizeBills(bills, month) }.fold(onSuccess = {
                            Text("净支出 ¥${yuan(it.netExpenseCents)} · 收入 ¥${yuan(it.incomeCents)}",
                                style = MaterialTheme.typography.bodyMedium)
                        }, onFailure = { ErrorNotice(it.message ?: "无法汇总") })
                    }
                    HorizontalDivider()
                }
            }
    }
}
