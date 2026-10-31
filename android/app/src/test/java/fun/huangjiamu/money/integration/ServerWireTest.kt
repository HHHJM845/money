package `fun`.huangjiamu.money.integration

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import `fun`.huangjiamu.money.data.BillContent
import `fun`.huangjiamu.money.data.CloudClient
import `fun`.huangjiamu.money.data.LedgerDatabase
import `fun`.huangjiamu.money.data.LedgerRepository
import `fun`.huangjiamu.money.data.MasterOperationJournal
import `fun`.huangjiamu.money.data.SessionStorage
import `fun`.huangjiamu.money.data.SyncRepository
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

/** Runs only against serve-android-wire-test.ts, never the configured real ledger. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = android.app.Application::class)
class ServerWireTest {
    private class TestSession : SessionStorage {
        private var cookie: String? = null
        override fun load() = cookie
        override fun save(cookie: String) { this.cookie = cookie }
        override fun clear() { cookie = null }
    }

    @Test fun nativeRepositoryRoundTripsRealServerWithoutDuplicateDebitOrSilentConflict() = runBlocking {
        val path = System.getenv("BOOKKEEPING_ANDROID_WIRE_FIXTURE")
        assumeTrue("Start the isolated Android wire fixture to run this integration test", !path.isNullOrBlank())
        val fixture = JSONObject(File(path!!).readText())
        val origin = URL(fixture.getString("origin"))
        require(origin.protocol == "http" && origin.host == "127.0.0.1" && origin.port > 1023) {
            "Wire tests require a literal loopback fixture"
        }
        var dropResponse = false
        var dropMasterResponse = false
        fun client(session: TestSession = TestSession()) = CloudClient(storage = session, openConnection = { source ->
            val connection = URL(origin.toString() + source.file).openConnection() as HttpURLConnection
            if (dropResponse && source.path.endsWith("/v2/bills/submit.json")) connection.setRequestProperty("X-Android-Wire-Drop", "yes")
            if (dropMasterResponse && source.path.endsWith("/v2/master/submit.json")) connection.setRequestProperty("X-Android-Wire-Drop", "yes")
            connection
        })
        val session = TestSession()
        var native = client(session)
        native.login(fixture.getString("username"), fixture.getString("password"))
        val desktop = client()
        desktop.login(fixture.getString("username"), fixture.getString("password"))
        val context = ApplicationProvider.getApplicationContext<Context>()
        val databaseName = "wire-${UUID.randomUUID()}.db"
        fun open() = Room.databaseBuilder(context, LedgerDatabase::class.java, databaseName).allowMainThreadQueries().build()
        var db = open()
        var repo = LedgerRepository(db)
        suspend fun synchronize() = SyncRepository(repo, native).synchronize()
        suspend fun snapshot() = desktop.request("v2/snapshot")
        fun findBill(snapshot: JSONObject, id: String): JSONObject {
            val bills = snapshot.getJSONArray("bills")
            return (0 until bills.length()).map { bills.getJSONObject(it) }.single { it.getString("billId") == id }
        }
        fun balance(snapshot: JSONObject, id: String): Long {
            val accounts = snapshot.getJSONArray("accounts")
            return (0 until accounts.length()).map { accounts.getJSONObject(it) }
                .single { it.getString("id") == id }.getString("balance").toLong()
        }
        try {
            assertTrue(synchronize())
            val content = BillContent(kind = "expense", amountCents = 2500, accountId = "1", categoryId = "3",
                merchant = "安卓真实接口合成消费", note = "离线保存及丢响应回放")
            val id = repo.save(content = content)
            val operationId = repo.dao.operations().single().operationId
            assertEquals(97500L, repo.metadata().accounts.single { it.id == "1" }.balance)
            db.close()
            db = open()
            repo = LedgerRepository(db)
            assertEquals(operationId, repo.dao.operations().single().operationId)
            dropResponse = true
            assertFalse(synchronize())
            assertEquals(97500L, balance(snapshot(), "1"))
            assertEquals(97500L, repo.metadata().accounts.single { it.id == "1" }.balance)
            val frozen = repo.dao.operations().single().request
            assertNotNull(frozen)
            assertEquals("unknown", repo.dao.operations().single().state)
            repo.save(id, content.copy(amountCents = 3000))
            assertEquals(97000L, repo.metadata().accounts.single { it.id == "1" }.balance)
            db.close()
            db = open()
            repo = LedgerRepository(db)
            dropResponse = false
            native = client(session)
            assertTrue(synchronize())
            assertEquals(97000L, balance(snapshot(), "1"))
            assertEquals(97000L, repo.metadata().accounts.single { it.id == "1" }.balance)
            assertEquals(2, findBill(snapshot(), id).getInt("version"))
            assertTrue(repo.dao.operations().isEmpty())
            val server = findBill(snapshot(), id)
            val external = JSONObject().put("operationId", UUID.randomUUID().toString()).put("billId", id)
                .put("expectedVersion", server.getInt("version")).put("action", "save").put("status", "posted")
                .put("content", JSONObject(server.getJSONObject("content").toString()).put("amountCents", 3500))
            repo.save(id, content.copy(amountCents = 4000))
            desktop.request("v2/bills/submit", external)
            assertFalse(synchronize())
            assertEquals("conflict", repo.bills().single { it.billId == id }.syncState)
            assertFalse(repo.metadata().accounts.single { it.id == "1" }.balanceExact)
            assertEquals(96500L, balance(snapshot(), "1"))
            assertEquals(4000L, repo.bills().single { it.billId == id }.content.amountCents)
            repo.resolveConflict(id, keepLocal = true, reviewedServerVersion = 3)
            assertTrue(synchronize())
            assertEquals(96000L, balance(snapshot(), "1"))
            assertTrue(repo.metadata().accounts.single { it.id == "1" }.balanceExact)
            repo.delete(id)
            assertTrue(synchronize())
            assertEquals(100000L, balance(snapshot(), "1"))
            repo.restore(id)
            assertTrue(synchronize())
            assertEquals(96000L, balance(snapshot(), "1"))
            val refundId = repo.refund(id, 500, "2")
            assertTrue(synchronize())
            assertEquals(200500L, balance(snapshot(), "2"))
            assertEquals(id, findBill(snapshot(), refundId).getJSONObject("content").getString("refundOfBillId"))
            val pending = repo.save(content = BillContent(amountCents = null), status = "pending")
            assertTrue(synchronize())
            assertEquals("pending", findBill(snapshot(), pending).getString("status"))
            assertEquals(96000L, balance(snapshot(), "1"))
            assertEquals(200500L, balance(snapshot(), "2"))
            val masterBody = JSONObject().put("operationId", UUID.randomUUID().toString()).put("entityType", "tag")
                .put("entityId", JSONObject.NULL).put("expectedVersion", 0).put("action", "save")
                .put("content", JSONObject().put("name", "安卓重启恢复合成标签").put("active", true).put("sortOrder", 0)).toString()
            dropMasterResponse = true
            assertTrue(runCatching {
                MasterOperationJournal(db).execute(JSONObject(masterBody)) { native.request("v2/master/submit", it) }
            }.isFailure)
            assertEquals(masterBody, MasterOperationJournal.pending(repo.dao.masters()).single().body)
            db.close()
            db = open()
            repo = LedgerRepository(db)
            native = client(session)
            dropMasterResponse = false
            val recovered = MasterOperationJournal.pending(repo.dao.masters()).single()
            val result = MasterOperationJournal(db).execute(JSONObject(recovered.body)) { native.request("v2/master/submit", it) }
            assertEquals(1, result.getJSONObject("snapshot").getInt("version"))
            assertTrue(MasterOperationJournal.pending(repo.dao.masters()).isEmpty())
            val tags = snapshot().getJSONArray("tags")
            assertEquals(1, (0 until tags.length()).count { tags.getJSONObject(it).getString("name") == "安卓重启恢复合成标签" })
            assertTrue(synchronize())
            assertEquals(96000L, repo.metadata().accounts.single { it.id == "1" }.balance)
            assertEquals(200500L, repo.metadata().accounts.single { it.id == "2" }.balance)
        } finally {
            db.close()
            context.deleteDatabase(databaseName)
        }
    }
}
