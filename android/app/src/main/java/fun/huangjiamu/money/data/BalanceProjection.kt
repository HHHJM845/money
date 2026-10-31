package `fun`.huangjiamu.money.data

import `fun`.huangjiamu.money.domain.LedgerCore
import org.json.JSONArray
import org.json.JSONObject
import java.math.BigInteger

internal fun effectBaseline(bill: JSONObject): MasterRecord {
    val content = bill.optJSONObject("content")
    val accounts = listOfNotNull(content?.nullableString("accountId"), content?.nullableString("destinationAccountId"))
    return MasterRecord("effect", bill.getString("billId"), JSONObject()
        .put("appliedEffect", bill.optJSONObject("appliedEffect") ?: JSONObject.NULL)
        .put("accountIds", JSONArray(accounts)).toString())
}

internal fun projectBalances(metadata: Metadata, records: List<BillRecord>, masters: List<MasterRecord>,
    operations: List<OutboxOperation>): Metadata {
    val baseline = masters.filter { it.kind == "effect" }.associate { it.id to JSONObject(it.json) }
    val missing = masters.filter { it.kind == "missing" }.map { it.id }.toSet()
    val conflicts = operations.filter { it.state == "conflict" }.map { it.billId }.toSet()
    val operationIds = operations.map { it.operationId }.toSet()
    // An acknowledged predecessor can disappear before its successor freezes; the prediction still needs confirmation.
    val unconfirmed = operations.filter { it.request != null || it.predecessor != null && it.predecessor !in operationIds }
        .map { it.billId }.toSet()
    val deltas = mutableMapOf<String, BigInteger>()
    val uncertain = mutableSetOf<String>()
    masters.filter { it.kind == "uncertain" }.forEach {
        val ids = JSONObject(it.json).getJSONArray("accountIds").strings()
        uncertain.addAll(ids.ifEmpty { metadata.accounts.map { account -> account.id } })
    }
    for (record in records.filter { !it.expired }) {
        val current = JSONObject(record.localJson ?: record.serverJson ?: continue)
        val base = baseline[record.billId]
        val before = base?.let { BalanceEffects.read(it, "appliedEffect") }
        val after = BalanceEffects.read(current, "appliedEffect")
        // Balance enablement can change while a frozen request commits; amounts cannot repair a mismatched prediction.
        val membershipChanged = record.localJson != null && record.billId in unconfirmed && before?.keys != after?.keys
        if (before == null || after == null || membershipChanged || record.billId in missing || record.billId in conflicts) {
            val refs = listOfNotNull(current.optJSONObject("content"),
                record.serverJson?.let { JSONObject(it).optJSONObject("content") }).flatMap {
                listOfNotNull(it.nullableString("accountId"), it.nullableString("destinationAccountId"))
            } + base?.optJSONArray("accountIds")?.strings().orEmpty() + before.orEmpty().keys + after.orEmpty().keys
            uncertain.addAll(refs.ifEmpty { metadata.accounts.map { it.id } })
            continue
        }
        LedgerCore.replacementDelta(before, after).forEach { (id, delta) ->
            deltas[id] = (deltas[id] ?: BigInteger.ZERO) + delta.toBigInteger()
        }
    }
    return metadata.copy(accounts = metadata.accounts.map { account ->
        val delta = deltas[account.id] ?: BigInteger.ZERO
        val exact = account.id !in uncertain
        val projected = account.balance?.let { if (exact) LedgerCore.exactCents(it.toBigInteger() + delta) else it }
        account.copy(balance = projected, confirmedBalance = account.balance,
            balancePending = delta != BigInteger.ZERO || !exact, balanceExact = exact)
    })
}
