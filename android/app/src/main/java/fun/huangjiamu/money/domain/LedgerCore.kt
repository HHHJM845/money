package `fun`.huangjiamu.money.domain

import java.math.BigInteger
import java.time.Instant
import java.time.ZoneOffset

data class SummaryRow(
    val kind: String,
    val status: String,
    val amountCents: Long,
    val occurredAt: Long,
    val excludeFromStatistics: Boolean,
)

data class SummaryTotals(
    val incomeCents: Long,
    val expenseCents: Long,
    val refundCents: Long,
    val netExpenseCents: Long,
    val surplusCents: Long,
)

object LedgerCore {
    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
    private const val MAX_DATE_MILLIS = 8_640_000_000_000_000L
    private const val SHANGHAI_OFFSET_MILLIS = 28_800_000L
    private val maxSafeInteger = BigInteger.valueOf(MAX_SAFE_INTEGER)
    private val monthPattern = Regex("[0-9]{4}-(0[1-9]|1[0-2])")

    fun signedCents(value: Long): Long {
        require(value in -MAX_SAFE_INTEGER..MAX_SAFE_INTEGER) { "Amount exceeds the safe integer range" }
        return value
    }

    fun positiveCents(value: Long): Long {
        require(signedCents(value) > 0) { "Amount must be positive" }
        return value
    }

    fun exactCents(value: BigInteger): Long {
        require(value.abs() <= maxSafeInteger) { "Amount total exceeds the safe integer range" }
        return value.toLong()
    }

    fun replacementDelta(before: Map<String, Long>, after: Map<String, Long>): Map<String, Long> {
        val result = linkedMapOf<String, Long>()
        for (id in before.keys + after.keys) {
            val previous = BigInteger.valueOf(signedCents(before[id] ?: 0L))
            val next = BigInteger.valueOf(signedCents(after[id] ?: 0L))
            val delta = exactCents(next.subtract(previous))
            if (delta != 0L) result[id] = delta
        }
        return result
    }

    fun summarize(rows: List<SummaryRow>, month: String): SummaryTotals {
        require(monthPattern.matches(month)) { "Invalid month" }
        val year = month.substring(0, 4).toInt()
        val monthNumber = month.substring(5, 7).toInt()
        var income = BigInteger.ZERO
        var expense = BigInteger.ZERO
        var refund = BigInteger.ZERO
        for (row in rows) {
            if (row.status != "posted" || row.excludeFromStatistics || row.kind == "transfer") continue
            require(row.occurredAt in -MAX_SAFE_INTEGER..MAX_SAFE_INTEGER) { "Invalid transaction time" }
            // Match the shared core's fixed UTC+8 offset and JavaScript Date range.
            val shiftedMillis = row.occurredAt + SHANGHAI_OFFSET_MILLIS
            require(shiftedMillis in -MAX_DATE_MILLIS..MAX_DATE_MILLIS) { "Invalid transaction time" }
            val date = Instant.ofEpochMilli(shiftedMillis).atOffset(ZoneOffset.UTC)
            if (date.year != year || date.monthValue != monthNumber) continue
            val amount = BigInteger.valueOf(positiveCents(row.amountCents))
            when (row.kind) {
                "income" -> income = income.add(amount)
                "expense" -> expense = expense.add(amount)
                "refund" -> refund = refund.add(amount)
            }
        }
        return SummaryTotals(
            incomeCents = exactCents(income),
            expenseCents = exactCents(expense),
            refundCents = exactCents(refund),
            netExpenseCents = exactCents(expense.subtract(refund)),
            surplusCents = exactCents(income.subtract(expense).add(refund)),
        )
    }
}
