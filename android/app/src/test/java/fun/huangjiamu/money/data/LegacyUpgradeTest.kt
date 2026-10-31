package `fun`.huangjiamu.money.data

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.room.Room
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.IOException
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = android.app.Application::class)
class LegacyUpgradeTest {
    @Test fun upgradeFailureRollsBackDdlAndPreservesOldRows() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "rollback-upgrade.db"
        context.deleteDatabase(name)
        val path = context.getDatabasePath(name)
        path.parentFile!!.mkdirs()
        SQLiteDatabase.openOrCreateDatabase(path, null).use {
            it.execSQL("CREATE TABLE entries(id TEXT PRIMARY KEY,uploadPayload TEXT)")
            it.execSQL("INSERT INTO entries VALUES ('old','frozen')")
            it.version = 1
        }
        val failing = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                LedgerDatabase.UPGRADE_1_2.migrate(db)
                error("模拟升级中断")
            }
        }
        val room = Room.databaseBuilder(context, LedgerDatabase::class.java, name).addMigrations(failing).allowMainThreadQueries().build()
        try {
            assertThrows(IllegalStateException::class.java) { room.openHelper.writableDatabase }
            SQLiteDatabase.openDatabase(path.absolutePath, null, SQLiteDatabase.OPEN_READONLY).use { old ->
                assertEquals(1, old.version)
                old.rawQuery("SELECT uploadPayload FROM entries", null).use { row -> assertTrue(row.moveToFirst()); assertEquals("frozen", row.getString(0)) }
                old.rawQuery("SELECT name FROM sqlite_master WHERE name='outbox'", null).use { assertEquals(0, it.count) }
            }
        } finally { room.close(); context.deleteDatabase(name) }
    }
    @Test fun oldEntriesAndFrozenV1BodySurviveMigrationAndLostResponseReplay() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "old-entry.db"
        context.deleteDatabase(name)
        val path = context.getDatabasePath(name)
        path.parentFile!!.mkdirs()
        val frozen = """{"clientSessionId":"pilot:old","type":3,"categoryId":"1","sourceAccountId":"1","sourceAmount":2500,"time":1793318400,"comment":"午餐"}"""
        SQLiteDatabase.openOrCreateDatabase(path, null).use { old ->
            old.execSQL("CREATE TABLE entries(id TEXT NOT NULL PRIMARY KEY,eventKey TEXT NOT NULL,time INTEGER NOT NULL,amountCents INTEGER NOT NULL,type TEXT NOT NULL,merchant TEXT NOT NULL,category TEXT NOT NULL,accountId TEXT NOT NULL,status TEXT NOT NULL,source TEXT NOT NULL,reason TEXT NOT NULL,remoteId TEXT,uploadPayload TEXT)")
            old.execSQL("CREATE UNIQUE INDEX index_entries_eventKey ON entries(eventKey)")
            old.execSQL("CREATE TABLE accounts(id TEXT NOT NULL PRIMARY KEY,name TEXT NOT NULL)")
            old.execSQL("INSERT INTO accounts VALUES ('1','现金')")
            old.execSQL("INSERT INTO entries VALUES ('old','event',1793318400000,2500,'expense','午餐','餐饮','1','posted','手动','',NULL,?)", arrayOf(frozen))
            old.execSQL("INSERT INTO entries VALUES ('candidate','candidate-event',1793318400000,0,'unknown','','其他','','pending','com.tencent.mm','金额待核对',NULL,NULL)")
            old.version = 1
        }
        fun open() = Room.databaseBuilder(context, LedgerDatabase::class.java, name)
            .addMigrations(LedgerDatabase.UPGRADE_1_2).allowMainThreadQueries().build()
        val bodies = mutableListOf<String>()
        var fail = true
        val remoteId = UUID.randomUUID().toString()
        val api = object : LedgerApi {
            override val connected = true
            override suspend fun request(route: String, payload: JSONObject?): JSONObject {
                if (route == "v1/transactions/add") {
                    bodies.add(payload.toString())
                    if (fail) { fail = false; throw IOException("响应丢失") }
                    return JSONObject().put("id", "91")
                }
                if (route == "v2/bills/submit") throw ApiException(400, "INVALID_INPUT", "候选尚未补齐")
                val bill = JSONObject().put("billId", remoteId).put("legacyId", "91").put("version", 1).put("status", "posted")
                    .put("balanceMode", "apply").put("content", BillContent(amountCents = 2500, accountId = "1", categoryId = "1", merchant = "午餐").json())
                    .put("createdAt", 1).put("updatedAt", 1).put("changeSequence", "1")
                return JSONObject().put("bills", JSONArray().put(bill)).put("sequence", "1").put("changes", JSONArray())
                    .put("nextSequence", "1").put("hasMore", false).put("accounts", JSONArray()).put("categories", JSONArray()).put("tags", JSONArray())
            }
        }
        var db = open()
        try {
            var repository = LedgerRepository(db)
            repository.importLegacy()
            assertEquals(2, repository.bills().size)
            assertEquals(frozen, db.ledger().find("old")!!.uploadPayload)
            assertFalse(SyncRepository(repository, api).synchronize())
            db.close(); db = open(); repository = LedgerRepository(db)
            SyncRepository(repository, api).synchronize()
            assertEquals(listOf(JSONObject(frozen).toString(), JSONObject(frozen).toString()), bodies)
            assertEquals("91", db.ledger().find("old")!!.remoteId)
            assertNull(db.ledger().find("old")!!.uploadPayload)
            assertEquals(2, repository.bills().size)
            assertEquals(remoteId, repository.bills().single { it.content.merchant == "午餐" }.billId)
            assertEquals("金额待核对", db.ledger().find("candidate")!!.reason)
        } finally { db.close(); context.deleteDatabase(name) }
    }
}
