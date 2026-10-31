package `fun`.huangjiamu.money.data

import `fun`.huangjiamu.money.domain.LedgerCore
import org.json.JSONObject

/** Missing old wire maps mean unknown; never reconstruct a historical debit from its amount. */
object BalanceEffects {
    fun read(json: JSONObject, field: String): Map<String, Long>? {
        val value = json.optJSONObject(field) ?: return null
        return value.keys().asSequence().associateWith { LedgerCore.signedCents(value.getLong(it)) }
    }

    fun save(before: JSONObject?, content: BillContent, status: String, mode: String, accounts: List<AccountView>): Map<String, Long>? {
        if (status != "posted" || mode == "preserve") return emptyMap()
        if (listOfNotNull(content.accountId, content.destinationAccountId).any { id -> accounts.none { it.id == id } }) return null
        val oldEffect = before?.let { read(it, "appliedEffect") }
        if (before != null && oldEffect == null) return null
        val oldContent = before?.optJSONObject("content")?.let { BillContent.parse(it) }
        fun permitted(id: String): Boolean {
            if (accounts.find { it.id == id }?.balance == null) return false
            return !(before?.optString("status") == "posted" && (oldContent?.accountId == id || oldContent?.destinationAccountId == id)
                && oldEffect?.containsKey(id) == false)
        }
        val result = linkedMapOf<String, Long>()
        content.accountId?.takeIf { permitted(it) }?.let {
            result[it] = if (content.kind in listOf("income", "refund")) content.amountCents!! else -content.amountCents!!
        }
        if (content.kind == "transfer") content.destinationAccountId?.takeIf { permitted(it) }?.let { result[it] = content.amountCents!! }
        return result
    }
}
