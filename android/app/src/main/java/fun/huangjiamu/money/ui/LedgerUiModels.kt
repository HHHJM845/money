package `fun`.huangjiamu.money.ui

import `fun`.huangjiamu.money.data.*
import `fun`.huangjiamu.money.domain.LedgerCore
import `fun`.huangjiamu.money.domain.SummaryRow
import `fun`.huangjiamu.money.domain.SummaryTotals
import org.json.JSONObject
import java.math.BigDecimal
import java.time.Instant
import java.time.LocalDateTime
import java.time.YearMonth
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.ResolverStyle
import java.util.concurrent.atomic.AtomicBoolean

internal val shanghai: ZoneId = ZoneId.of("Asia/Shanghai")
internal fun currentMonth(): String = YearMonth.now(shanghai).toString()
internal fun dateLabel(time: Long, pattern: String = "yyyy-MM-dd HH:mm"): String =
    Instant.ofEpochMilli(time).atZone(shanghai).format(DateTimeFormatter.ofPattern(pattern))
internal fun yuan(cents: Long?): String = cents?.let { BigDecimal.valueOf(it, 2).toPlainString() } ?: "待确认"
internal fun amountInput(raw: String, signed: Boolean = false): Long {
    require(Regex(if (signed) "-?[0-9]{1,14}(\\.[0-9]{1,2})?" else "[0-9]{1,14}(\\.[0-9]{1,2})?").matches(raw.trim())) {
        "请输入金额，最多两位小数"
    }
    val value = BigDecimal(raw.trim()).movePointRight(2).longValueExact()
    return if (signed) LedgerCore.signedCents(value) else LedgerCore.positiveCents(value)
}
internal fun parseDateTime(raw: String): Long = LocalDateTime.parse(raw.trim(),
    DateTimeFormatter.ofPattern("uuuu-MM-dd HH:mm").withResolverStyle(ResolverStyle.STRICT))
    .atZone(shanghai).toInstant().toEpochMilli()
internal fun kindLabel(kind: String): String = when (kind) {
    "income" -> "收入"; "transfer" -> "转账"; "refund" -> "退款"; else -> "支出"
}
internal fun syncLabel(state: String): String = when (state) {
    "synced" -> "云端已确认"; "sending" -> "正在上传"; "failed" -> "上传失败"
    "conflict" -> "版本冲突"; "unknown" -> "结果未知，待确认"; "legacy" -> "旧记录待迁移"; else -> "本机已保存 · 待同步"
}
internal fun categoryLabel(metadata: Metadata, id: String?): String {
    val row = metadata.categories.find { it.id == id } ?: return "未分类"
    val parent = metadata.categories.find { it.id == row.parentId }
    return (parent?.let { "${it.name} / " } ?: "") + row.name + if (row.active) "" else "（已停用）"
}
internal fun accountLabel(metadata: Metadata, id: String?): String =
    metadata.accounts.find { it.id == id }?.let { it.name + if (it.active) "" else "（已停用）" } ?: "账户待选择"

internal fun summarizeBills(bills: List<BillView>, month: String): SummaryTotals = LedgerCore.summarize(bills.map {
    SummaryRow(it.content.kind, it.status, it.content.amountCents ?: 0, it.content.occurredAt, it.content.excludeFromStatistics)
}, month)

internal data class BillFilter(
    val query: String = "", val account: String? = null, val category: String? = null,
    val tag: String? = null, val source: String? = null, val kind: String? = null,
    val from: String = "", val until: String = "",
) {
    fun matches(bill: BillView, metadata: Metadata, bills: List<BillView> = emptyList()): Boolean {
        val c = bill.content
        val categoryId = if (c.kind == "refund") bills.find { it.billId == c.refundOfBillId }?.content?.categoryId ?: c.categoryId else c.categoryId
        val day = dateLabel(c.occurredAt, "yyyy-MM-dd")
        return (query.isBlank() || listOf(c.merchant, c.note, categoryLabel(metadata, c.categoryId),
            accountLabel(metadata, c.accountId)).any { it.contains(query, ignoreCase = true) }) &&
            (account == null || account == c.accountId || account == c.destinationAccountId) &&
            (category == null || category == "" && categoryId == null || category == categoryId ||
                metadata.categories.any { it.id == categoryId && it.parentId == category }) &&
            (tag == null || tag in c.tagIds) && (kind == null || kind == c.kind) &&
            (source == null || bill.sources.any { it.optString("app") == source }) &&
            (from.isBlank() || day >= from) && (until.isBlank() || day <= until)
    }
}

/** Acquired synchronously before launching, so two taps in one frame cannot enqueue two operations. */
internal class SubmissionGate {
    private val locked = AtomicBoolean(false)
    fun acquire(): Boolean = locked.compareAndSet(false, true)
    fun release() { locked.set(false) }
}

internal data class CaptureUiState(
    val notificationPermission: Boolean = false, val accessibilityPermission: Boolean = false,
    val notificationConnected: Boolean = false, val accessibilityConnected: Boolean = false,
    val sources: List<Pair<String, Boolean>> = emptyList(), val error: String = "",
)

internal data class LedgerActions(
    val save: suspend (String?, BillContent, String) -> Unit,
    val delete: suspend (String) -> Unit,
    val restore: suspend (String) -> Unit,
    val resolve: suspend (String, Boolean, Int) -> Unit,
    val retry: suspend (String) -> Unit,
    val synchronize: suspend () -> Boolean,
    val login: suspend (String, String) -> Unit,
    val logout: () -> Unit,
    val request: suspend (String, JSONObject?) -> JSONObject,
    val balanceHistory: suspend (String) -> List<JSONObject>,
    val billHistory: suspend (String) -> List<String>,
    val permission: (String) -> Unit,
    val toggleSource: (String, Boolean) -> Unit,
)
