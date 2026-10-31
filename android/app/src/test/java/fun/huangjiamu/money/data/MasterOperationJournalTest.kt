package `fun`.huangjiamu.money.data

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.IOException
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = android.app.Application::class)
class MasterOperationJournalTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val name = "master-operation-journal-test.db"
    private lateinit var db: LedgerDatabase

    private fun open() {
        db = Room.databaseBuilder(context, LedgerDatabase::class.java, name)
            .addMigrations(LedgerDatabase.UPGRADE_1_2).allowMainThreadQueries().build()
    }

    @Before fun setup() { context.deleteDatabase(name); open() }
    @After fun cleanup() { db.close(); context.deleteDatabase(name) }

    private fun body(id: String = UUID.randomUUID().toString()) = JSONObject()
        .put("operationId", id).put("entityType", "tag").put("entityId", JSONObject.NULL)
        .put("expectedVersion", 0).put("action", "save")
        .put("content", JSONObject().put("name", "周末").put("active", true).put("sortOrder", 0))

    private suspend fun pending() = MasterOperationJournal.pending(db.bookkeeping().masters())

    @Test fun lostResponseSurvivesDatabaseReopenAndReplaysSameOperationWithoutDuplicateCreation() = runBlocking {
        val original = body().toString()
        val applied = mutableMapOf<String, String>()
        val sent = mutableListOf<String>()
        suspend fun server(payload: JSONObject): JSONObject {
            sent.add(payload.toString())
            // The row must already be committed before the write can reach the server.
            assertEquals(original, pending().single().body)
            val entityId = applied.getOrPut(payload.getString("operationId")) { UUID.randomUUID().toString() }
            if (sent.size == 1) throw IOException("响应丢失")
            return JSONObject().put("id", entityId)
        }
        assertTrue(runCatching { MasterOperationJournal(db).execute(JSONObject(original), ::server) }.exceptionOrNull() is IOException)
        val savedAt = pending().single().createdAt
        db.close(); open()
        val recovered = pending().single()
        assertEquals(original, recovered.body)
        assertEquals(savedAt, recovered.createdAt)
        assertEquals("响应丢失", recovered.lastError)
        val result = MasterOperationJournal(db).execute(JSONObject(recovered.body), ::server)
        assertEquals(applied.values.single(), result.getString("id"))
        assertEquals(listOf(original, original), sent)
        assertEquals(1, applied.size)
        assertTrue(pending().isEmpty())
    }

    @Test fun onlyDefinitiveClientRejectionsRemoveTheFrozenRequest() = runBlocking {
        for (status in listOf(400, 401, 403, 404, 408, 409, 410, 422, 429, 500, 503)) {
            val payload = body()
            val rejected = ApiException(status, "SYNTHETIC", "HTTP $status")
            val failure = runCatching { MasterOperationJournal(db).execute(payload) { throw rejected } }.exceptionOrNull()
            assertSame(rejected, failure)
            if (status in listOf(400, 404, 409, 410, 422)) {
                assertTrue("HTTP $status must be definitive", pending().isEmpty())
            } else {
                db.close(); open()
                val saved = pending().single()
                assertEquals(status, saved.lastStatus)
                assertEquals("HTTP $status", saved.lastError)
                assertEquals(payload.toString(), saved.body)
                MasterOperationJournal(db).execute(JSONObject(saved.body)) { JSONObject() }
                assertTrue(pending().isEmpty())
            }
        }
    }

    @Test fun changedBodyOrNewOperationCannotBypassAnUnconfirmedRequest() = runBlocking {
        val original = body()
        val journal = MasterOperationJournal(db)
        runCatching { journal.execute(original) { throw IOException("断网") } }
        var calls = 0
        val changed = JSONObject(original.toString()).put("content", JSONObject().put("name", "不同内容"))
        assertTrue(runCatching { journal.execute(changed) { calls++; JSONObject() } }.isFailure)
        assertTrue(runCatching { journal.execute(body()) { calls++; JSONObject() } }.isFailure)
        assertEquals(0, calls)
        assertEquals(original.toString(), pending().single().body)
        journal.execute(JSONObject(original.toString())) { calls++; JSONObject() }
        assertEquals(1, calls)
        assertTrue(pending().isEmpty())
    }

    @Test fun failedLocalInsertPreventsAnyCloudWrite() = runBlocking {
        db.openHelper.writableDatabase.execSQL("""
            CREATE TRIGGER reject_master_journal BEFORE INSERT ON master_records
            WHEN NEW.kind='master-request'
            BEGIN SELECT RAISE(ABORT,'synthetic disk rejection'); END
        """.trimIndent())
        var calls = 0
        val failure = runCatching { MasterOperationJournal(db).execute(body()) { calls++; JSONObject() } }.exceptionOrNull()
        assertNotNull(failure)
        assertTrue(failure!!.message!!.contains("未发送到云端"))
        assertEquals(0, calls)
        assertTrue(pending().isEmpty())
    }

    @Test fun successfulCloudWriteWithFailedCleanupStaysRecoverable() = runBlocking {
        db.openHelper.writableDatabase.execSQL("""
            CREATE TRIGGER reject_master_cleanup BEFORE DELETE ON master_records
            WHEN OLD.kind='master-request'
            BEGIN SELECT RAISE(ABORT,'synthetic cleanup rejection'); END
        """.trimIndent())
        val original = body().toString()
        val applied = mutableSetOf<String>()
        var calls = 0
        suspend fun server(payload: JSONObject): JSONObject {
            calls++
            applied.add(payload.getString("operationId"))
            return JSONObject()
        }
        val failure = runCatching { MasterOperationJournal(db).execute(JSONObject(original), ::server) }.exceptionOrNull()
        assertTrue(failure!!.message!!.contains("本机请求日志未能清理"))
        db.close(); open()
        assertEquals(original, pending().single().body)
        db.openHelper.writableDatabase.execSQL("DROP TRIGGER reject_master_cleanup")
        MasterOperationJournal(db).execute(JSONObject(pending().single().body), ::server)
        assertEquals(2, calls)
        assertEquals(1, applied.size)
        assertTrue(pending().isEmpty())
    }

    @Test fun metadataRefreshPreservesJournalAndMalformedRowsAreNotSilentlyDropped() = runBlocking {
        val original = body()
        runCatching { MasterOperationJournal(db).execute(original) { throw IOException("断网") } }
        db.bookkeeping().saveMasters(listOf(MasterRecord("account", "1", "{}"),
            MasterRecord("category", "2", "{}"), MasterRecord("tag", "3", "{}")))
        db.bookkeeping().clearPublishedMasters()
        assertEquals(listOf(MasterOperationJournal.KIND), db.bookkeeping().masters().map { it.kind })
        assertEquals(original.toString(), pending().single().body)
        db.bookkeeping().saveMasters(listOf(MasterRecord(MasterOperationJournal.KIND, "broken", "{broken")))
        db.close(); open()
        val broken = pending().single { it.operationId == "broken" }
        assertTrue(broken.readError.isNotBlank())
        assertEquals("{broken", broken.body)
        var calls = 0
        assertTrue(runCatching { MasterOperationJournal(db).execute(body()) { calls++; JSONObject() } }.isFailure)
        assertEquals(0, calls)
        assertEquals(2, pending().size)
    }
}
