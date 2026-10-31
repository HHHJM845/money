package `fun`.huangjiamu.money.data

import android.content.Context
import androidx.room.Room
import androidx.room.withTransaction
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.IOException

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = android.app.Application::class)
class LedgerRepositoryTest {
    private lateinit var db: LedgerDatabase
    private lateinit var repo: LedgerRepository
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val api = FakeLedgerApi()

    private fun open() {
        db = Room.databaseBuilder(context, LedgerDatabase::class.java, "restart-test.db")
            .addMigrations(LedgerDatabase.UPGRADE_1_2).allowMainThreadQueries().build()
        repo = LedgerRepository(db)
    }

    @Before fun setup() { context.deleteDatabase("restart-test.db"); open() }
    @After fun close() { db.close(); context.deleteDatabase("restart-test.db") }
    private suspend fun sync() = SyncRepository(repo, api).synchronize()
    private fun draft(amount: Long = 2500) = BillContent(amountCents = amount, accountId = "1", categoryId = "1", merchant = "午餐")

    @Test fun offlineSaveAndOutboxSurviveRoomRestart() = runBlocking {
        val id = repo.save(content = draft())
        val operation = db.bookkeeping().operations().single()
        db.close(); open()
        assertEquals(2500L, repo.bills().single().content.amountCents)
        assertEquals(operation.operationId, db.bookkeeping().operations().single().operationId)
        sync()
        assertEquals("synced", repo.bills().single { it.billId == id }.syncState)
        assertEquals(1, api.applied)
    }

    @Test fun lostResponseReplaysFrozenOperationAfterRestartWithoutDoubleApply() = runBlocking {
        val id = repo.save(content = draft())
        api.loseResponse = true
        sync()
        val frozen = db.bookkeeping().operations().single().request
        repo.save(id, draft(3000))
        db.close(); open()
        sync()
        assertEquals(frozen, api.requests[1].toString())
        assertEquals(2, api.applied)
        assertEquals(listOf(0, 0, 1), api.requests.map { it.getInt("expectedVersion") })
        assertEquals(3000L, repo.bills().single().content.amountCents)
    }

    @Test fun sameBillAcknowledgementDoesNotOverwriteLaterLocalEdit() = runBlocking {
        val id = repo.save(content = draft())
        api.onSubmit = { repo.save(id, draft(4200)); api.onSubmit = null }
        sync()
        assertEquals(4200L, repo.bills().single().content.amountCents)
        sync()
        assertEquals(4200L, api.remote[id]!!.getJSONObject("content").getLong("amountCents"))
        assertEquals(listOf(0, 1), api.requests.map { it.getInt("expectedVersion") })
    }

    @Test fun conflictPausesOnlyItsBillAndKeepsBothCandidates() = runBlocking {
        val first = repo.save(content = draft())
        sync()
        repo.save(first, draft(3000))
        repo.save(first, draft(3500))
        api.remote[first] = api.remote[first]!!.let { JSONObject(it.toString()).put("version", 2) }
        val second = repo.save(content = draft(800))
        sync()
        val conflicted = repo.bills().single { it.billId == first }
        assertEquals("conflict", conflicted.syncState)
        assertEquals(3500L, conflicted.content.amountCents)
        assertEquals(2, conflicted.server!!.getInt("version"))
        assertEquals("synced", repo.bills().single { it.billId == second }.syncState)
        repo.resolveConflict(first, keepLocal = true, reviewedServerVersion = 2)
        sync()
        assertEquals(3500L, api.remote[first]!!.getJSONObject("content").getLong("amountCents"))
        assertTrue(db.bookkeeping().operations().isEmpty())
    }

    @Test fun stagedPagesDoNotPublishMetadataOrCursorUntilTailAndResumeAfterRestart() = runBlocking {
        sync()
        api.pages = mutableListOf(
            api.page("1", true, JSONArray().put(api.event(api.bill("remote-one", 1, draft()))), "中途账户"),
        )
        sync()
        assertEquals("0", db.bookkeeping().sync()?.cursor)
        assertEquals("现金", repo.metadata().accounts.single().name)
        assertFalse(repo.bills().any { it.billId == "remote-one" })
        db.close(); open()
        api.pages = mutableListOf(api.page("2", false, JSONArray(), "尾页账户"))
        sync()
        assertEquals("1", api.after.last())
        assertEquals("2", db.bookkeeping().sync()?.cursor)
        assertEquals("尾页账户", repo.metadata().accounts.single().name)
        assertTrue(repo.bills().any { it.billId == "remote-one" })
    }

    @Test fun expiredTombstonePurgesOverlayAndRejectsStaleEdit() = runBlocking {
        val id = repo.save(content = draft())
        sync()
        repo.save(id, draft(3333))
        db.bookkeeping().stage(listOf(StagedChange("bill", id, JSONObject(db.bookkeeping().bill(id)!!.localJson!!).toString())))
        api.rejectExpired = true
        api.pages = mutableListOf(api.page("3", false, JSONArray().put(api.event(
            JSONObject().put("billId", id).put("version", 3).put("status", "deleted")
                .put("deletedAt", 1).put("changeSequence", "3").put("expired", true)))))
        sync()
        val record = db.bookkeeping().bill(id)!!
        assertNull(record.localJson)
        assertFalse(record.serverJson.orEmpty().contains("午餐"))
        assertTrue(db.bookkeeping().operations().none { it.billId == id })
        assertTrue(db.bookkeeping().history(id).isEmpty())
        assertTrue(db.bookkeeping().staged().none { it.entityId == id })
        assertTrue(runCatching { repo.save(id, draft()) }.isFailure)
    }

    @Test fun pendingDeleteRestoreAndRefundUseSameDurableQueue() = runBlocking {
        val pending = repo.save(content = BillContent(amountCents = null), status = "pending")
        repo.save(pending, draft(), "posted")
        repo.delete(pending)
        repo.restore(pending)
        val refund = repo.refund(pending, 500, "1")
        sync()
        assertEquals("posted", repo.bills().single { it.billId == pending }.status)
        assertEquals(pending, repo.bills().single { it.billId == refund }.content.refundOfBillId)
        assertEquals(listOf("save", "save", "delete", "restore", "save"), api.requests.map { it.getString("action") })
    }

    @Test fun newlyEnabledBalanceDoesNotReplayOldBillAndDeleteUsesActualEffect() = runBlocking {
        sync()
        val id = repo.save(content = draft())
        sync()
        db.bookkeeping().bill(id)!!.let {
            db.bookkeeping().saveBill(it.copy(serverJson = JSONObject(it.serverJson!!).put("appliedEffect", JSONObject())
                .put("restoreEffect", JSONObject()).toString()))
        }
        repo.save(id, draft().copy(note = "只改备注"))
        assertEquals("{}", JSONObject(db.bookkeeping().bill(id)!!.localJson!!).getJSONObject("appliedEffect").toString())
        repo.delete(id)
        assertEquals("{}", JSONObject(db.bookkeeping().bill(id)!!.localJson!!).getJSONObject("restoreEffect").toString())
    }

    @Test fun missingWireEffectsStayUnknownInsteadOfInferringFromAmount() = runBlocking {
        sync()
        val id = repo.save(content = draft())
        sync()
        repo.delete(id)
        val local = JSONObject(db.bookkeeping().bill(id)!!.localJson!!)
        assertTrue(local.isNull("restoreEffect"))
    }

    @Test fun cumulativeRefundCannotExceedOriginalAndInactiveHistoryRemainsEditable() = runBlocking {
        sync()
        val id = repo.save(content = draft())
        repo.refund(id, 2000, "1")
        assertTrue(runCatching { repo.refund(id, 501, "1") }.isFailure)
        sync()
        val category = db.bookkeeping().masters().single { it.kind == "category" }
        db.bookkeeping().saveMasters(listOf(category.copy(json = JSONObject(category.json).put("active", false).toString())))
        assertTrue(runCatching { repo.save(id, draft().copy(note = "历史分类保留")) }.isSuccess)
    }

    @Test fun oldReplayAcknowledgementCannotRebaseDependentEditOverKnownRemoteVersion() = runBlocking {
        val id = repo.save(content = draft())
        api.loseResponse = true
        sync()
        val newer = JSONObject(api.remote[id]!!.toString()).put("version", 3)
            .put("content", draft(9999).json()).put("changeSequence", "3")
        api.remote[id] = newer
        db.withTransactionForTest(repo, newer)
        repo.save(id, draft(3333))
        sync()
        assertEquals("conflict", repo.bills().single().syncState)
        assertEquals(3, repo.bills().single().version)
        assertEquals(3333L, repo.bills().single().content.amountCents)
        assertEquals(1, api.requests.last().getInt("expectedVersion"))
        assertEquals(9999L, api.remote[id]!!.getJSONObject("content").getLong("amountCents"))
    }

    @Test fun downloadRacingEnqueueAndSendCannotSilentlyRebaseRootEdit() = runBlocking {
        val id = repo.save(content = draft())
        sync()
        repo.save(id, draft(3500))
        val newer = JSONObject(api.remote[id]!!.toString()).put("version", 2).put("content", draft(9999).json())
        api.remote[id] = newer
        db.withTransactionForTest(repo, newer)
        sync()
        assertEquals(1, api.requests.last().getInt("expectedVersion"))
        assertEquals("conflict", repo.bills().single().syncState)
        assertEquals(9999L, api.remote[id]!!.getJSONObject("content").getLong("amountCents"))
    }

    @Test fun forbiddenTimeoutAndThrottleRetainFrozenRequestAcrossReconnect() = runBlocking {
        for (status in listOf(401, 403, 408, 429)) {
            val id = repo.save(content = draft(status.toLong()))
            api.failStatus = status
            sync()
            val failed = db.bookkeeping().operations().single { it.billId == id }
            assertEquals("unknown", failed.state)
            assertNotNull(failed.request)
            sync()
            val sent = api.requests.filter { it.getString("billId") == id }
            assertEquals(2, sent.size)
            assertEquals(sent[0].toString(), sent[1].toString())
            assertEquals("synced", repo.bills().single { it.billId == id }.syncState)
        }
    }

    @Test fun cursorInvalidBootstrapsWithoutDroppingQueuedOverlay() = runBlocking {
        val id = repo.save(content = draft())
        sync()
        repo.save(id, draft(3500))
        api.failStatus = 408
        api.cursorInvalid = true
        sync()
        assertEquals(2, api.snapshots)
        assertEquals(3500L, repo.bills().single().content.amountCents)
        assertEquals(1, db.bookkeeping().operations().size)
        sync()
        assertEquals(3500L, api.remote[id]!!.getJSONObject("content").getLong("amountCents"))
    }

    @Test fun rejectedSaveCanBeCorrectedWithNewOperationAndOriginalVersionBaseline() = runBlocking {
        val id = repo.save(content = draft())
        api.failStatus = 400
        sync()
        val rejected = db.bookkeeping().operations().single()
        assertEquals("failed", rejected.state)
        repo.save(id, draft(1200))
        sync()
        assertEquals("synced", repo.bills().single().syncState)
        assertEquals(1200L, api.remote[id]!!.getJSONObject("content").getLong("amountCents"))
        assertNotEquals(rejected.operationId, api.requests.last().getString("operationId"))
        assertEquals(0, api.requests.last().getInt("expectedVersion"))
    }

    @Test fun killedSendingProcessReplaysItsOriginalRequestOnRestart() = runBlocking {
        repo.save(content = draft())
        api.onSubmit = { throw kotlinx.coroutines.CancellationException("模拟杀进程") }
        assertTrue(runCatching { sync() }.exceptionOrNull() is kotlinx.coroutines.CancellationException)
        val operation = db.bookkeeping().operations().single()
        assertEquals("sending", operation.state)
        db.close(); open()
        api.onSubmit = null
        sync()
        assertEquals(operation.request, api.requests.last().toString())
        assertEquals(1, api.applied)
        assertEquals("synced", repo.bills().single().syncState)
    }

    @Test fun unknownOutcomeDoesNotBlockDifferentBillProgress() = runBlocking {
        val first = repo.save(content = draft())
        val second = repo.save(content = draft(200))
        api.failStatus = 408
        sync()
        assertEquals("unknown", repo.bills().single { it.billId == first }.syncState)
        assertEquals("synced", repo.bills().single { it.billId == second }.syncState)
    }

    @Test fun deleteAndRestoreUseExactActualMapRatherThanOriginalAmount() = runBlocking {
        val id = repo.save(content = draft())
        sync()
        db.bookkeeping().bill(id)!!.let {
            db.bookkeeping().saveBill(it.copy(serverJson = JSONObject(it.serverJson!!)
                .put("appliedEffect", JSONObject().put("1", -1200)).put("restoreEffect", JSONObject().put("1", -1200)).toString()))
        }
        repo.delete(id)
        var local = JSONObject(db.bookkeeping().bill(id)!!.localJson!!)
        assertEquals(-1200L, local.getJSONObject("restoreEffect").getLong("1"))
        assertEquals("{}", local.getJSONObject("appliedEffect").toString())
        repo.restore(id)
        local = JSONObject(db.bookkeeping().bill(id)!!.localJson!!)
        assertEquals(-1200L, local.getJSONObject("appliedEffect").getLong("1"))
    }

    @Test fun decimalCursorBeyondJavascriptPrecisionRemainsExactAfterRestart() = runBlocking {
        sync()
        val high = "9007199254740993"
        api.pages = mutableListOf(api.page(high, true), api.page("9007199254740994"))
        sync()
        assertEquals(high, api.after.last())
        assertEquals("9007199254740994", db.bookkeeping().sync()?.cursor)
        db.close(); open()
        assertEquals("9007199254740994", db.bookkeeping().sync()?.cursor)
    }

    @Test fun queueFailureRollsBackBillAndLocalHistoryTogether() = runBlocking {
        db.openHelper.writableDatabase.execSQL("CREATE TRIGGER fail_enqueue BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'synthetic disk rejection'); END")
        assertTrue(runCatching { repo.save(content = draft()) }.isFailure)
        assertTrue(db.bookkeeping().bills().isEmpty())
        assertTrue(db.bookkeeping().operations().isEmpty())
        db.openHelper.writableDatabase.query("SELECT COUNT(*) FROM bill_history").use {
            assertTrue(it.moveToFirst()); assertEquals(0, it.getInt(0))
        }
    }

    @Test fun remotePendingDeletionRestoresAsPendingWhenWireCarriesRestoreStatus() = runBlocking {
        sync()
        val id = java.util.UUID.randomUUID().toString()
        val deleted = api.bill(id, 2, draft()).put("status", "deleted").put("restoreStatus", "pending")
            .put("deletedAt", System.currentTimeMillis()).put("appliedEffect", JSONObject()).put("restoreEffect", JSONObject())
        db.withTransactionForTest(repo, deleted)
        repo.restore(id)
        assertEquals("pending", repo.bills().single().status)
        assertEquals(emptyMap<String, Long>(), repo.bills().single().appliedEffect)
    }

    @Test fun restoringIgnoredPilotCandidateCreatesPendingBillRatherThanRestoringMissingRemote() = runBlocking {
        db.ledger().save(Entry("ignored-pilot", "ignored-event", 1793318400000, 0, "unknown", "", "其他", "", "ignored", "com.tencent.mm", "待核对"))
        repo.importLegacy()
        val old = repo.bills().single()
        repo.restore(old.billId)
        val restored = repo.bills().single()
        assertEquals("pending", restored.status)
        assertEquals("save", db.bookkeeping().operations().single().action)
        assertEquals(0, JSONObject(db.bookkeeping().operations().single().draft).getInt("expectedVersion"))
    }

    @Test fun conflictResolutionRejectsAnUnreviewedNewerServerVersion() = runBlocking {
        val id = repo.save(content = draft())
        sync()
        repo.save(id, draft(3500))
        api.remote[id] = JSONObject(api.remote[id]!!.toString()).put("version", 2)
        sync()
        val newer = JSONObject(api.remote[id]!!.toString()).put("version", 3).put("content", draft(9000).json())
        db.withTransactionForTest(repo, newer)
        val failure = runCatching { repo.resolveConflict(id, true, reviewedServerVersion = 2) }
        assertTrue(failure.isFailure)
        assertEquals("conflict", repo.bills().single().syncState)
        assertEquals(3500L, repo.bills().single().content.amountCents)
    }

    @Test fun offlineBalanceProjectionReplacesExactEffectsOnceAcrossEditMoveDeleteRestore() = runBlocking {
        api.cashBalance = "100000"
        api.bank = true
        sync()
        val id = repo.save(content = draft())
        fun balances(metadata: Metadata) = metadata.accounts.associate { it.id to it.balance }
        assertEquals(mapOf("1" to 97500L, "2" to 200000L), balances(repo.metadata()))
        repo.save(id, draft(3000))
        assertEquals(mapOf("1" to 97000L, "2" to 200000L), balances(repo.metadata()))
        repo.save(id, draft(3000).copy(accountId = "2"))
        assertEquals(mapOf("1" to 100000L, "2" to 197000L), balances(repo.metadata()))
        repo.delete(id)
        assertEquals(mapOf("1" to 100000L, "2" to 200000L), balances(repo.metadata()))
        repo.restore(id)
        assertEquals(mapOf("1" to 100000L, "2" to 197000L), balances(repo.metadata()))
        db.close(); open()
        assertEquals(mapOf("1" to 100000L, "2" to 197000L), balances(repo.metadata()))
    }

    @Test fun acknowledgementBeforeMetadataPullDoesNotLoseOrDoubleApplyProjection() = runBlocking {
        api.cashBalance = "100000"
        api.includeEffects = true
        val id = repo.save(content = draft())
        api.onSubmit = { api.cashBalance = "97500"; api.failDownload = true; api.onSubmit = null }
        sync()
        assertEquals(97500L, repo.metadata().accounts.single().balance)
        repo.save(id, draft(3000))
        assertEquals(97000L, repo.metadata().accounts.single().balance)
        api.onSubmit = { api.cashBalance = "97000"; api.onSubmit = null }
        sync()
        assertEquals(97000L, repo.metadata().accounts.single().balance)
        assertEquals(97000L, repo.metadata().accounts.single().confirmedBalance)
    }

    @Test fun bootstrapTombstonesPurgePreviouslyPostedContentAndUnsentLocalNewRemains() = runBlocking {
        val old = repo.save(content = draft())
        sync()
        val local = repo.save(content = draft(800))
        api.failStatus = 408
        api.snapshotTombstones.put(JSONObject().put("billId", old).put("version", 3).put("status", "deleted")
            .put("deletedAt", 1).put("changeSequence", "3").put("expired", true))
        api.remote.remove(old)
        api.cursorInvalid = true
        sync()
        assertTrue(db.bookkeeping().bill(old)!!.expired)
        assertNull(db.bookkeeping().bill(old)!!.localJson)
        assertTrue(db.bookkeeping().history(old).isEmpty())
        assertEquals(800L, repo.bills().single { it.billId == local }.content.amountCents)
        assertTrue(db.bookkeeping().operations().any { it.billId == local })
    }

    @Test fun authoritativeAbsenceWithoutTombstoneFlagsRecoveryAndDoesNotRecreateKnownRemote() = runBlocking {
        val id = repo.save(content = draft())
        sync()
        api.remote.remove(id)
        api.cursorInvalid = true
        sync()
        val view = repo.bills().single()
        assertEquals("conflict", view.syncState)
        assertTrue(view.syncError.contains("恢复"))
        assertEquals(2500L, view.content.amountCents)
        assertTrue(db.bookkeeping().operations().isEmpty())
        assertTrue(runCatching { repo.save(id, draft(800)) }.isFailure)
    }

    @Test fun legacyCategoryMappingIsCorrectedBeforeFirstFreezeButFrozenPayloadNeverChanges() = runBlocking {
        db.ledger().save(Entry("legacy-unsent", "legacy-event", 1793318400000, 2500, "expense", "午餐", "餐饮", "1", "posted", "手动", ""))
        repo.importLegacy()
        assertTrue(JSONObject(db.bookkeeping().operations().single().draft).getJSONObject("content").isNull("categoryId"))
        api.loseResponse = true
        sync()
        val frozen = db.bookkeeping().operations().single().request!!
        assertEquals("1", JSONObject(frozen).getJSONObject("content").getString("categoryId"))
        val category = db.bookkeeping().masters().single { it.kind == "category" }
        db.bookkeeping().saveMasters(listOf(category.copy(json = JSONObject(category.json).put("id", "99").toString())))
        sync()
        assertEquals(frozen, api.requests.last().toString())
    }

    @Test fun permanentConflictBlocksSuccessorsWithoutAutomaticWorkerRetry() = runBlocking {
        val id = repo.save(content = draft())
        sync()
        repo.save(id, draft(3000))
        repo.save(id, draft(3500))
        api.remote[id]!!.put("version", 3)
        val outcome = SyncRepository(repo, api).synchronizeOutcome()
        assertFalse(outcome.complete)
        assertFalse(outcome.retryAutomatically)
        assertEquals(listOf("conflict", "queued"), repo.dao.operations().map { it.state })
        assertFalse(sync())
    }

    @Test fun unknownOutcomeRetriesButLoginExpiryWaitsForReconnect() = runBlocking {
        repo.save(content = draft())
        api.failStatus = 429
        val transient = SyncRepository(repo, api).synchronizeOutcome()
        assertFalse(transient.complete)
        assertTrue(transient.retryAutomatically)
        val frozen = repo.dao.operations().single().request
        api.failStatus = 403
        val expired = SyncRepository(repo, api).synchronizeOutcome()
        assertFalse(expired.complete)
        assertFalse(expired.retryAutomatically)
        assertEquals(frozen, repo.dao.operations().single().request)
    }

    @Test fun olderStagedEffectsPublishWithTheirMetadataWithoutReplacingNewerAck() = runBlocking {
        api.includeEffects = true
        api.cashBalance = "97500"
        api.remote["existing"] = api.bill("existing", 1, draft())
        sync()
        repo.save("existing", draft(3500))
        api.onSubmit = {
            val staged = api.bill("existing", 1, draft(3000))
            api.cashBalance = "97000"
            api.pages = mutableListOf(api.page("1", true, JSONArray().put(api.event(staged))))
            api.onSubmit = null
        }
        assertFalse(sync())
        assertEquals(2, repo.bills().single().version)
        assertEquals(96500L, repo.metadata().accounts.single().balance)
        db.close(); open()
        api.pages = mutableListOf(api.page("2", false))
        assertTrue(sync())
        assertEquals(3500L, repo.bills().single().content.amountCents)
        assertEquals(97000L, repo.metadata().accounts.single().confirmedBalance)
        assertEquals(96500L, repo.metadata().accounts.single().balance)
    }

    @Test fun expiredLegacyReplayScrubsContentAndPayloadAndContinuesOtherBills() = runBlocking {
        db.ledger().save(Entry("expired-pilot", "stable-event", 1793318400000, 2500, "expense",
            "private merchant", "餐饮", "1", "posted", "手动", "private note",
            uploadPayload = """{"clientSessionId":"old-stable","comment":"private note"}"""))
        repo.importLegacy()
        val link = repo.dao.links().single()
        repo.dao.stage(listOf(StagedChange("bill", link.billId, repo.dao.bill(link.billId)!!.localJson!!)))
        val other = repo.save(content = draft(800))
        api.expiredLegacy = true
        assertTrue(sync())
        assertEquals("synced", repo.bills().single { it.billId == other }.syncState)
        assertTrue(repo.dao.bill(link.billId)!!.expired)
        assertFalse(repo.dao.bill(link.billId)!!.serverJson!!.contains("private"))
        assertTrue(repo.dao.history(link.billId).isEmpty())
        assertTrue(repo.dao.staged().isEmpty())
        assertTrue(repo.dao.operations().isEmpty())
        val scrubbed = db.ledger().find(link.entryId)!!
        assertEquals("stable-event", scrubbed.eventKey)
        assertEquals("", scrubbed.merchant)
        assertEquals("", scrubbed.reason)
        assertEquals(0L, scrubbed.amountCents)
        assertNull(scrubbed.uploadPayload)
        assertTrue(repo.dao.sync()!!.error.contains("过期"))
        db.close(); open()
        assertTrue(sync())
        assertEquals(1, api.legacyRequests)
        assertTrue(repo.dao.sync()!!.error.contains("过期"))
    }

    @Test fun anOldChangePageCannotRestageContentForAnAlreadyExpiredBill() = runBlocking {
        val id = repo.save(content = draft())
        sync()
        val oldSnapshot = JSONObject(api.remote[id]!!.toString())
        db.withTransactionForTest(repo, JSONObject().put("billId", id).put("version", 3).put("expired", true))
        api.pages = mutableListOf(api.page("1", true, JSONArray().put(api.event(oldSnapshot))))
        assertFalse(sync())
        assertTrue(repo.dao.bill(id)!!.expired)
        assertTrue(repo.dao.staged().none { it.entityId == id })
    }

    @Test fun importingLocalPendingEntriesRetainsPilotAccountChoicesBeforeBootstrap() = runBlocking {
        db.ledger().saveAccounts(listOf(LocalAccount("1", "旧版现金")))
        db.ledger().save(Entry("old-pending", "old-pending-key", 1793318400000, 0, "unknown",
            "", "其他", "", "pending", "com.tencent.mm", "金额待核对"))
        repo.importLegacy()
        assertEquals(listOf("旧版现金"), repo.metadata().accounts.map { it.name })
        assertNull(repo.metadata().accounts.single().balance)
    }

    @Test fun snapshotLegacyTombstonePurgesUnmappedPilotIdentityAndAllPrivateCopies() = runBlocking {
        db.ledger().save(Entry("old-remote", "legacy-id-only", 1793318400000, 2500, "expense",
            "private legacy merchant", "餐饮", "1", "posted", "手动", "private legacy note", remoteId = "91"))
        repo.importLegacy()
        val provisional = repo.dao.links().single().billId
        repo.dao.history(BillHistory(billId = provisional, at = 1, action = "old",
            snapshot = repo.dao.bill(provisional)!!.localJson!!))
        repo.dao.stage(listOf(StagedChange("bill", provisional, repo.dao.bill(provisional)!!.localJson!!)))
        api.snapshotTombstones.put(JSONObject().put("billId", "expired-server-id").put("legacyId", "91")
            .put("version", 3).put("status", "deleted").put("expired", true))
        assertTrue(sync())
        assertTrue(repo.bills().isEmpty())
        assertNull(repo.dao.bill(provisional))
        assertTrue(repo.dao.bill("expired-server-id")!!.expired)
        assertEquals("expired-server-id", repo.dao.links().single().billId)
        assertTrue(repo.dao.history(provisional).isEmpty())
        assertTrue(repo.dao.staged().isEmpty())
        assertTrue(repo.dao.operations().isEmpty())
        assertEquals("", db.ledger().find("old-remote")!!.merchant)
        assertEquals("", db.ledger().find("old-remote")!!.reason)
        assertTrue(api.requests.isEmpty())
        db.close(); open()
        assertTrue(sync())
        assertTrue(repo.bills().isEmpty())
    }

    @Test fun preBootstrapSaveAndLostResponseDoNotInventAZeroEffectAfterPull() = runBlocking {
        api.cashBalance = "100000"
        api.includeEffects = true
        repo.save(content = draft())
        api.onSubmit = { api.cashBalance = "97500"; api.onSubmit = null }
        api.loseResponse = true
        assertFalse(sync())
        val balance = repo.metadata().accounts.single()
        assertEquals(97500L, balance.confirmedBalance)
        assertEquals(97500L, balance.balance)
        assertEquals("unknown", repo.dao.operations().single().state)
        db.close(); open()
        assertEquals(97500L, repo.metadata().accounts.single().balance)
    }

    @Test fun terminalExpiryKeepsBalanceUncertainUntilCoherentMetadataRefresh() = runBlocking {
        api.includeEffects = true
        api.cashBalance = "97500"
        api.remote["expires"] = api.bill("expires", 1, draft())
        sync()
        repo.delete("expires")
        assertEquals(100000L, repo.metadata().accounts.single().balance)
        api.rejectExpired = true
        api.failDownload = true
        assertFalse(sync())
        assertTrue(repo.dao.bill("expires")!!.expired)
        assertFalse(repo.metadata().accounts.single().balanceExact)
        db.close(); open()
        assertFalse(repo.metadata().accounts.single().balanceExact)
        api.remote.clear()
        api.cashBalance = "100000"
        assertTrue(sync())
        assertEquals(100000L, repo.metadata().accounts.single().balance)
        assertTrue(repo.metadata().accounts.single().balanceExact)
    }

    @Test fun balanceEnabledRemotelyAfterLocalPredictionStaysUncertainOnLostResponse() = runBlocking {
        api.includeEffects = true
        api.cashBalance = null
        assertTrue(sync())
        val id = repo.save(content = draft())
        assertEquals(emptyMap<String, Long>(), repo.bills().single().appliedEffect)
        api.cashBalance = "100000"
        api.onSubmit = { api.cashBalance = "97500"; api.onSubmit = null }
        api.loseResponse = true
        assertFalse(sync())
        val frozen = repo.dao.operations().single().request
        val account = repo.metadata().accounts.single()
        assertEquals(97500L, account.confirmedBalance)
        assertFalse(account.balanceExact)
        assertTrue(account.balancePending)
        assertEquals(97500L, account.balance)
        db.close(); open()
        assertFalse(repo.metadata().accounts.single().balanceExact)
        repo.save(id, draft(3000))
        api.onSubmit = { api.cashBalance = "97000"; api.onSubmit = null }
        assertTrue(sync())
        assertEquals(frozen, api.requests[1].toString())
        assertEquals(2, api.applied)
        assertEquals(97000L, repo.metadata().accounts.single().balance)
        assertTrue(repo.metadata().accounts.single().balanceExact)
    }

    @Test fun enabledAccountLostResponseStillProjectsQueuedSuccessorExactly() = runBlocking {
        api.includeEffects = true
        api.cashBalance = "100000"
        assertTrue(sync())
        val id = repo.save(content = draft())
        api.onSubmit = { api.cashBalance = "97500"; api.onSubmit = null }
        api.loseResponse = true
        assertFalse(sync())
        assertEquals(97500L, repo.metadata().accounts.single().balance)
        assertTrue(repo.metadata().accounts.single().balanceExact)
        repo.save(id, draft(3000))
        assertEquals(97000L, repo.metadata().accounts.single().balance)
        assertTrue(repo.metadata().accounts.single().balanceExact)
        db.close(); open()
        assertEquals(97000L, repo.metadata().accounts.single().balance)
        assertTrue(repo.metadata().accounts.single().balanceExact)
        api.onSubmit = { api.cashBalance = "97000"; api.onSubmit = null }
        assertTrue(sync())
        assertEquals(2, api.applied)
        assertEquals(97000L, repo.metadata().accounts.single().balance)
    }

    @Test fun predictionMismatchSurvivesRestartBetweenOwnAckAndSuccessorFreeze() = runBlocking {
        api.includeEffects = true
        api.cashBalance = null
        sync()
        val id = repo.save(content = draft())
        api.cashBalance = "100000"
        api.onSubmit = { api.cashBalance = "97500"; api.onSubmit = null }
        api.loseResponse = true
        assertFalse(sync())
        repo.save(id, draft(3000))
        db.openHelper.writableDatabase.execSQL("""CREATE TRIGGER stop_successor BEFORE UPDATE OF request ON outbox
            WHEN OLD.predecessor IS NOT NULL AND NEW.request IS NOT NULL
            BEGIN SELECT RAISE(ABORT,'stop successor freeze'); END""")
        assertFalse(sync())
        assertEquals(1, repo.dao.operations().size)
        assertNull(repo.dao.operations().single().request)
        assertFalse(repo.metadata().accounts.single().balanceExact)
        db.close(); open()
        assertFalse(repo.metadata().accounts.single().balanceExact)
        assertEquals(97500L, repo.metadata().accounts.single().balance)
        db.openHelper.writableDatabase.execSQL("DROP TRIGGER stop_successor")
        api.onSubmit = { api.cashBalance = "97000"; api.onSubmit = null }
        assertTrue(sync())
        assertEquals(2, api.applied)
        assertEquals(97000L, repo.metadata().accounts.single().balance)
        assertTrue(repo.metadata().accounts.single().balanceExact)
    }
}

private suspend fun LedgerDatabase.withTransactionForTest(repo: LedgerRepository, json: JSONObject) {
    withTransaction { repo.mergeBill(json) }
}

private class FakeLedgerApi : LedgerApi {
    override val connected = true
    val remote = linkedMapOf<String, JSONObject>()
    private val results = mutableMapOf<String, JSONObject>()
    val requests = mutableListOf<JSONObject>()
    val after = mutableListOf<String>()
    var loseResponse = false
    var rejectExpired = false
    var applied = 0
    var failStatus: Int? = null
    var cursorInvalid = false
    var snapshots = 0
    var cashBalance: String? = "10000"
    var bank = false
    var includeEffects = false
    var failDownload = false
    var expiredLegacy = false
    var legacyRequests = 0
    val snapshotTombstones = JSONArray()
    var onSubmit: (suspend () -> Unit)? = null
    var pages = mutableListOf<JSONObject>()
    fun bill(id: String, version: Int, content: BillContent) = JSONObject()
        .put("billId", id).put("version", version).put("status", "posted").put("content", content.json())
        .put("balanceMode", "apply").put("createdAt", 1).put("updatedAt", 1).put("changeSequence", "$version")
        .also { if (includeEffects) it.put("appliedEffect", JSONObject().put(content.accountId ?: "1", -(content.amountCents ?: 0)))
            .put("restoreEffect", JSONObject().put(content.accountId ?: "1", -(content.amountCents ?: 0))) }
    fun event(bill: JSONObject) = JSONObject().put("entityType", "bill")
        .put("entityId", bill.getString("billId")).put("sequence", bill.getString("changeSequence")).put("snapshot", bill)
    fun page(sequence: String = "0", more: Boolean = false, changes: JSONArray = JSONArray(), name: String = "现金") =
        JSONObject().put("changes", changes).put("nextSequence", sequence).put("hasMore", more)
            .put("accounts", JSONArray().put(JSONObject().put("id", "1").put("name", name).put("balance", cashBalance ?: JSONObject.NULL).put("currency", "CNY"))
                .also { if (bank) it.put(JSONObject().put("id", "2").put("name", "银行卡").put("balance", "200000").put("currency", "CNY")) })
            .put("categories", JSONArray().put(JSONObject().put("id", "1").put("name", "餐饮").put("type", 2).put("active", true)))
            .put("tags", JSONArray()).put("fetchedAt", 1)
    override suspend fun request(route: String, payload: JSONObject?): JSONObject {
        if (route == "v1/transactions/add") {
            legacyRequests++
            if (expiredLegacy) throw ApiException(410, "RECORD_EXPIRED", "过期")
            return JSONObject().put("id", "91")
        }
        if (route == "v2/snapshot") { snapshots++; return page().put("bills", JSONArray(remote.values.toList())).put("sequence", "0").put("tombstones", snapshotTombstones) }
        if (route.startsWith("v2/sync/changes")) {
            if (failDownload) { failDownload = false; throw IOException("分页断网") }
            if (cursorInvalid) { cursorInvalid = false; throw ApiException(409, "CURSOR_INVALID", "游标失效") }
            after.add(route.substringAfter("after=").substringBefore('&'))
            if (pages.isNotEmpty()) return pages.removeAt(0)
            if (after.last() != "0") throw IOException("断网")
            return page(changes = JSONArray(remote.values.map { event(it) }))
        }
        if (route.startsWith("v2/bills/detail")) return remote[route.substringAfter("billId=")] ?: throw ApiException(404, "NOT_FOUND", "不存在")
        check(route == "v2/bills/submit")
        val body = JSONObject(payload!!.toString())
        requests.add(body)
        failStatus?.let { failStatus = null; throw ApiException(it, "SYNTHETIC", "测试失败 $it") }
        if (rejectExpired) throw ApiException(410, "RECORD_EXPIRED", "过期")
        results[body.getString("operationId")]?.let { return JSONObject(it.toString()) }
        val id = body.getString("billId")
        val old = remote[id]
        if (body.getInt("expectedVersion") != (old?.getInt("version") ?: 0)) throw ApiException(409, "VERSION_CONFLICT", "冲突")
        val result = bill(id, (old?.getInt("version") ?: 0) + 1,
            if (body.getString("action") == "save") BillContent.parse(body.getJSONObject("content")) else BillContent.parse(old!!.getJSONObject("content")))
            .put("status", when (body.getString("action")) { "delete" -> "deleted"; "restore" -> "posted"; else -> body.getString("status") })
        remote[id] = result
        results[body.getString("operationId")] = result
        applied++
        onSubmit?.invoke()
        if (loseResponse) { loseResponse = false; throw IOException("响应丢失") }
        return result
    }
}
