package `fun`.huangjiamu.money.data

import `fun`.huangjiamu.money.domain.LedgerCore
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

internal fun JSONObject.nullableString(key: String): String? = if (isNull(key)) null else optString(key).takeIf { it.isNotBlank() }
internal fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }
internal fun JSONArray.strings(): List<String> = (0 until length()).map { getString(it) }

data class BillContent(
    val kind: String = "expense", val amountCents: Long? = null,
    val accountId: String? = null, val categoryId: String? = null,
    val destinationAccountId: String? = null, val refundOfBillId: String? = null,
    val occurredAt: Long = System.currentTimeMillis(), val merchant: String = "", val note: String = "",
    val tagIds: List<String> = emptyList(), val excludeFromStatistics: Boolean = false,
    val excludeFromBudget: Boolean = false,
) {
    fun json(): JSONObject = JSONObject().put("kind", kind).put("amountCents", amountCents ?: JSONObject.NULL)
        .put("accountId", accountId ?: JSONObject.NULL).put("categoryId", categoryId ?: JSONObject.NULL)
        .put("destinationAccountId", destinationAccountId ?: JSONObject.NULL).put("refundOfBillId", refundOfBillId ?: JSONObject.NULL)
        .put("occurredAt", occurredAt).put("merchant", merchant).put("note", note).put("tagIds", JSONArray(tagIds.sorted()))
        .put("excludeFromStatistics", excludeFromStatistics).put("excludeFromBudget", excludeFromBudget)

    fun validate(status: String) {
        require(kind in listOf("expense", "income", "transfer", "refund")) { "请选择有效账单类型" }
        require(status in listOf("pending", "posted")) { "账单状态无效" }
        amountCents?.let { LedgerCore.positiveCents(it) }
        require(occurredAt in 0..253402271999999L) { "交易日期无效" }
        require(merchant.length <= 200 && note.length <= 2000 && tagIds.distinct().size <= 30) { "商户、备注或标签超长" }
        (listOfNotNull(accountId, categoryId, destinationAccountId) + tagIds).forEach {
            require(it.matches(Regex("[1-9][0-9]{0,18}")) && it.toBigInteger() <= Long.MAX_VALUE.toBigInteger()) { "账户、分类或标签编号无效" }
        }
        require(kind == "transfer" || destinationAccountId == null) { "只有转账可指定转入账户" }
        require(kind == "refund" || refundOfBillId == null) { "只有退款可关联原账" }
        refundOfBillId?.let { UUID.fromString(it) }
        if (status == "posted") {
            require(amountCents != null && accountId != null) { "入账前请补齐金额和资金账户" }
            require(categoryId != null) { "入账前请选择分类" }
            if (kind == "transfer") require(destinationAccountId != null && destinationAccountId != accountId) { "请选择不同的转出和转入账户" }
            if (kind == "refund") require(refundOfBillId != null) { "退款需关联原支出" }
        }
    }

    companion object {
        fun parse(json: JSONObject): BillContent = BillContent(
            kind = json.getString("kind"), amountCents = if (json.isNull("amountCents")) null else json.getLong("amountCents"),
            accountId = json.nullableString("accountId"), categoryId = json.nullableString("categoryId"),
            destinationAccountId = json.nullableString("destinationAccountId"), refundOfBillId = json.nullableString("refundOfBillId"),
            occurredAt = json.getLong("occurredAt"), merchant = json.optString("merchant"), note = json.optString("note"),
            tagIds = json.optJSONArray("tagIds")?.strings().orEmpty(), excludeFromStatistics = json.optBoolean("excludeFromStatistics"),
            excludeFromBudget = json.optBoolean("excludeFromBudget"),
        )
    }
}

data class BillView(
    val billId: String, val version: Int, val status: String, val content: BillContent,
    val balanceMode: String, val syncState: String, val syncError: String,
    val sources: List<JSONObject>, val server: JSONObject?, val createdAt: Long, val updatedAt: Long,
    val deletedAt: Long?, val legacyWaiting: Boolean = false,
    val appliedEffect: Map<String, Long>? = null, val restoreEffect: Map<String, Long>? = null,
)

data class AccountView(val id: String, val name: String, val balance: Long?, val category: String, val currency: String,
    val active: Boolean = true, val version: Int = 1, val confirmedBalance: Long? = balance,
    val balancePending: Boolean = false, val balanceExact: Boolean = true)
data class CategoryView(val id: String, val name: String, val type: Int, val parentId: String?, val active: Boolean,
    val version: Int = 1, val sortOrder: Int = 0)
data class TagView(val id: String, val name: String, val active: Boolean, val version: Int = 1, val sortOrder: Int = 0)
data class Metadata(val accounts: List<AccountView> = emptyList(), val categories: List<CategoryView> = emptyList(), val tags: List<TagView> = emptyList())
data class LedgerState(val bills: List<BillView> = emptyList(), val metadata: Metadata = Metadata(),
    val queuedCount: Int = 0, val lastSuccess: Long = 0, val syncError: String = "", val authExpired: Boolean = false)

interface LedgerApi {
    val connected: Boolean
    suspend fun request(route: String, payload: JSONObject? = null): JSONObject
}

class ApiException(val status: Int, val code: String, message: String) : Exception(message)
