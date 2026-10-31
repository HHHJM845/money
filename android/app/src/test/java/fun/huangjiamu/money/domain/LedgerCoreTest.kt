package `fun`.huangjiamu.money.domain

import java.io.File
import java.math.BigInteger
import java.time.Instant
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

class LedgerCoreTest {
    private val limit = 9_007_199_254_740_991L

    @Test fun centsUseLongAndRejectNonPositiveOrUnsafeAmounts() {
        assertEquals(1234L, LedgerCore.positiveCents(1234L))
        assertEquals(limit, LedgerCore.positiveCents(limit))
        assertEquals(-limit, LedgerCore.signedCents(-limit))
        assertEquals(0L, LedgerCore.signedCents(0L))
        listOf(0L, -1L, limit + 1, Long.MAX_VALUE, Long.MIN_VALUE).forEach { value ->
            assertThrows(IllegalArgumentException::class.java) { LedgerCore.positiveCents(value) }
        }
        listOf(limit + 1, -limit - 1, Long.MAX_VALUE, Long.MIN_VALUE).forEach { value ->
            assertThrows(IllegalArgumentException::class.java) { LedgerCore.signedCents(value) }
        }
    }

    @Test fun exactCentsRejectsBigIntegerOverflowInBothDirections() {
        assertEquals(limit, LedgerCore.exactCents(BigInteger.valueOf(limit)))
        assertEquals(-limit, LedgerCore.exactCents(BigInteger.valueOf(-limit)))
        listOf(
            BigInteger.valueOf(limit).add(BigInteger.ONE),
            BigInteger.valueOf(-limit).subtract(BigInteger.ONE),
            BigInteger.valueOf(Long.MAX_VALUE).pow(2),
        ).forEach { value ->
            assertThrows(IllegalArgumentException::class.java) { LedgerCore.exactCents(value) }
        }
    }

    @Test fun editMoveDeleteAndRestoreReverseActualAppliedEffects() {
        assertEquals(mapOf("cash" to -500L),
            LedgerCore.replacementDelta(mapOf("cash" to -2500L), mapOf("cash" to -3000L)))
        assertEquals(mapOf("cash" to 3000L, "bank" to -3000L),
            LedgerCore.replacementDelta(mapOf("cash" to -3000L), mapOf("bank" to -3000L)))
        assertEquals(mapOf("bank" to 3000L),
            LedgerCore.replacementDelta(mapOf("bank" to -3000L), emptyMap()))
        assertEquals(mapOf("bank" to -3000L),
            LedgerCore.replacementDelta(emptyMap(), mapOf("bank" to -3000L)))
        assertEquals(emptyMap<String, Long>(),
            LedgerCore.replacementDelta(mapOf("cash" to -2500L), mapOf("cash" to -2500L)))
    }

    @Test fun preservedHistoricalImportDoesNotInventABalanceEffect() {
        assertTrue(LedgerCore.replacementDelta(emptyMap(), emptyMap()).isEmpty())
    }

    @Test fun replacementRejectsUnsafeInputsAndOverflowingDifferences() {
        val cases = listOf(
            mapOf("cash" to (limit + 1)) to emptyMap(),
            emptyMap<String, Long>() to mapOf("cash" to Long.MIN_VALUE),
            mapOf("cash" to -limit) to mapOf("cash" to 1L),
            mapOf("cash" to limit) to mapOf("cash" to -1L),
        )
        cases.forEach { (before, after) ->
            assertThrows(IllegalArgumentException::class.java) {
                LedgerCore.replacementDelta(before, after)
            }
        }
        assertEquals(mapOf("__proto__" to 42L),
            LedgerCore.replacementDelta(emptyMap(), mapOf("__proto__" to 42L)))
    }

    @Test fun replacementDoesNotMutateItsInputs() {
        val before = linkedMapOf("cash" to -2500L)
        val after = linkedMapOf("bank" to -3000L)
        LedgerCore.replacementDelta(before, after)
        assertEquals(mapOf("cash" to -2500L), before)
        assertEquals(mapOf("bank" to -3000L), after)
    }

    @Test fun statisticsSeparateIncomeExpenseRefundAndOmitNonStatisticalRows() {
        val rows = listOf(
            row(), row(kind = "income", amountCents = 10000L),
            row(kind = "refund", amountCents = 500L), row(kind = "transfer"),
            row(status = "pending"), row(status = "deleted"), row(excludeFromStatistics = true),
        )
        assertEquals(SummaryTotals(10000L, 2500L, 500L, 2000L, 8000L),
            LedgerCore.summarize(rows, "2026-10"))
    }

    @Test fun refundUsesArrivalMonthAtShanghaiBoundary() {
        val rows = listOf(row(), row(
            kind = "refund", amountCents = 500L,
            occurredAt = Instant.parse("2026-10-31T16:00:00Z").toEpochMilli(),
        ))
        assertEquals(2500L, LedgerCore.summarize(rows, "2026-10").netExpenseCents)
        assertEquals(-500L, LedgerCore.summarize(rows, "2026-11").netExpenseCents)
        val lastMillisecond = row(
            occurredAt = Instant.parse("2026-10-31T15:59:59.999Z").toEpochMilli(),
        )
        assertEquals(2500L,
            LedgerCore.summarize(listOf(lastMillisecond), "2026-10").expenseCents)
    }

    @Test fun monthValidationMatchesFourDigitYearAndTwoDigitMonthContract() {
        listOf("2026-13", "2026-1", "2026-00", "October", "2026-10\n", "10000-10").forEach { month ->
            assertThrows(IllegalArgumentException::class.java) {
                LedgerCore.summarize(emptyList(), month)
            }
        }
        assertEquals(SummaryTotals(0, 0, 0, 0, 0), LedgerCore.summarize(emptyList(), "0000-01"))
    }

    @Test fun invalidDatesFailInsteadOfReturningEmptyStatistics() {
        listOf(limit, -limit, Long.MIN_VALUE, Long.MAX_VALUE,
            8_640_000_000_000_000L - 28_800_000L + 1).forEach { occurredAt ->
            assertThrows(IllegalArgumentException::class.java) {
                LedgerCore.summarize(listOf(row(occurredAt = occurredAt)), "2026-10")
            }
        }
    }

    @Test fun dateRangeMatchesJavaScriptAfterFixedShanghaiOffset() {
        val earliest = -8_640_000_000_000_000L - 28_800_000L
        val latest = 8_640_000_000_000_000L - 28_800_000L
        assertEquals(SummaryTotals(0, 0, 0, 0, 0),
            LedgerCore.summarize(listOf(row(occurredAt = earliest), row(occurredAt = latest)), "2026-10"))
        assertThrows(IllegalArgumentException::class.java) {
            LedgerCore.summarize(listOf(row(occurredAt = earliest - 1)), "2026-10")
        }
    }

    @Test fun skippedRowsDoNotValidateIrrelevantAmountsOrDates() {
        val invalid = row(amountCents = Long.MIN_VALUE, occurredAt = Long.MAX_VALUE)
        val rows = listOf(
            invalid.copy(status = "pending"), invalid.copy(status = "deleted"),
            invalid.copy(kind = "transfer"), invalid.copy(excludeFromStatistics = true),
        )
        assertEquals(SummaryTotals(0, 0, 0, 0, 0), LedgerCore.summarize(rows, "2026-10"))
        val otherMonth = row(amountCents = 0,
            occurredAt = Instant.parse("2026-09-01T00:00:00Z").toEpochMilli())
        assertEquals(SummaryTotals(0, 0, 0, 0, 0),
            LedgerCore.summarize(listOf(otherMonth), "2026-10"))
    }

    @Test fun summaryRejectsInvalidAmountsAndOverflowingIndividualTotals() {
        listOf(0L, -1L, limit + 1).forEach { amount ->
            assertThrows(IllegalArgumentException::class.java) {
                LedgerCore.summarize(listOf(row(amountCents = amount)), "2026-10")
            }
        }
        listOf("income", "expense", "refund").forEach { kind ->
            assertThrows(IllegalArgumentException::class.java) {
                LedgerCore.summarize(listOf(row(kind = kind, amountCents = limit), row(kind = kind)), "2026-10")
            }
        }
    }

    @Test fun summaryRejectsSurplusOverflowEvenWhenIndividualTotalsAreSafe() {
        val rows = listOf(row(kind = "income", amountCents = limit), row(kind = "refund", amountCents = 1))
        assertThrows(IllegalArgumentException::class.java) {
            LedgerCore.summarize(rows, "2026-10")
        }
    }

    @Test fun bigIntegerAccumulationDoesNotWrapAroundLong() {
        val rows = List(1025) { row(amountCents = limit) }
        assertThrows(IllegalArgumentException::class.java) { LedgerCore.summarize(rows, "2026-10") }
    }

    @Test fun emptyMonthReturnsZeroTotals() {
        assertEquals(SummaryTotals(0, 0, 0, 0, 0), LedgerCore.summarize(emptyList(), "2026-10"))
    }

    private fun row(
        kind: String = "expense",
        status: String = "posted",
        amountCents: Long = 2500L,
        occurredAt: Long = Instant.parse("2026-10-29T04:00:00Z").toEpochMilli(),
        excludeFromStatistics: Boolean = false,
    ) = SummaryRow(kind, status, amountCents, occurredAt, excludeFromStatistics)
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE, application = android.app.Application::class)
class LedgerCoreFixtureTest {
    @Test fun sharedFixtureReplaysEveryBalanceReplacement() {
        val fixtureFile = generateSequence(File(checkNotNull(System.getProperty("user.dir"))).canonicalFile) { it.parentFile }
            .map { File(it, "test/fixtures/bookkeeping-v1.json") }
            .firstOrNull { it.isFile }
            ?: error("Shared bookkeeping-v1.json fixture was not found")
        val fixture = JSONObject(fixtureFile.readText())
        assertEquals(1, fixture.getInt("version"))
        assertEquals("CNY", fixture.getString("currency"))
        assertEquals("Asia/Shanghai", fixture.getString("timeZone"))
        val balances = longMap(fixture.getJSONObject("initialBalances")).toMutableMap()
        val operations = fixture.getJSONArray("operations")
        for (index in 0 until operations.length()) {
            val operation = operations.getJSONObject(index)
            val delta = LedgerCore.replacementDelta(
                longMap(operation.getJSONObject("before")),
                longMap(operation.getJSONObject("after")),
            )
            delta.forEach { (id, amount) ->
                balances[id] = LedgerCore.exactCents(BigInteger.valueOf(balances.getValue(id))
                    .add(BigInteger.valueOf(amount)))
            }
            assertEquals("Fixture operation $index", longMap(operation.getJSONObject("balances")), balances)
        }
    }

    private fun longMap(json: JSONObject): Map<String, Long> =
        json.keys().asSequence().associateWith { json.getLong(it) }
}
