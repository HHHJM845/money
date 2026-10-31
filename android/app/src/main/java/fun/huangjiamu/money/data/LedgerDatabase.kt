package `fun`.huangjiamu.money.data

import androidx.room.*
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import kotlinx.coroutines.flow.Flow

data class UiState(val ledger: LedgerState = LedgerState(), val notice: String = "", val busy: Boolean = false,
    val notificationConnected: Boolean = false, val accessibilityConnected: Boolean = false,
    val cloudConnected: Boolean = false, val syncing: Boolean = false, val loaded: Boolean = false,
    val history: List<BillHistory> = emptyList(), val saveRevision: Long = 0)

@Entity(tableName = "entries", indices = [Index(value = ["eventKey"], unique = true)])
data class Entry(
    @PrimaryKey val id: String, val eventKey: String, val time: Long,
    val amountCents: Long, val type: String, val merchant: String, val category: String,
    val accountId: String, val status: String, val source: String, val reason: String,
    val remoteId: String? = null,
    val uploadPayload: String? = null,
)

@Entity(tableName = "accounts")
data class LocalAccount(@PrimaryKey val id: String, val name: String)

@Dao
interface LedgerDao {
    @Query("SELECT * FROM entries ORDER BY time DESC") suspend fun all(): List<Entry>
    @Query("SELECT * FROM entries WHERE id=:id") suspend fun find(id: String): Entry?
    @Query("SELECT * FROM entries WHERE remoteId=:id LIMIT 1") suspend fun remote(id: String): Entry?
    @Insert(onConflict = OnConflictStrategy.IGNORE) suspend fun capture(entry: Entry): Long
    @Upsert suspend fun save(entry: Entry)
    @Query("DELETE FROM entries WHERE id=:id") suspend fun delete(id: String)
    @Query("SELECT * FROM accounts ORDER BY name") suspend fun accounts(): List<LocalAccount>
    @Upsert suspend fun saveAccounts(accounts: List<LocalAccount>)
    @Query("DELETE FROM accounts") suspend fun clearAccounts()
}

@Entity(tableName = "bill_records")
data class BillRecord(@PrimaryKey val billId: String, val serverJson: String? = null,
    val localJson: String? = null, val sourcesJson: String = "[]", val expired: Boolean = false,
    val restoreStatus: String = "posted")

@Entity(tableName = "outbox", indices = [Index(value = ["operationId"], unique = true), Index("billId")])
data class OutboxOperation(@PrimaryKey(autoGenerate = true) val position: Long = 0,
    val operationId: String, val billId: String, val action: String, val draft: String,
    val request: String? = null, val state: String = "queued", val error: String = "",
    val predecessor: String? = null)

@Entity(tableName = "master_records", primaryKeys = ["kind", "id"])
data class MasterRecord(val kind: String, val id: String, val json: String)

@Entity(tableName = "sync_state")
data class SyncState(@PrimaryKey val id: Int = 1, val cursor: String = "0", val initialized: Boolean = false,
    val stageCursor: String? = null, val lastSuccess: Long = 0, val error: String = "", val authExpired: Boolean = false)

@Entity(tableName = "sync_stage", primaryKeys = ["kind", "entityId"])
data class StagedChange(val kind: String, val entityId: String, val json: String)

@Entity(tableName = "legacy_links")
data class LegacyLink(@PrimaryKey val entryId: String, val billId: String, val waiting: Boolean)

@Entity(tableName = "bill_history", indices = [Index("billId")])
data class BillHistory(@PrimaryKey(autoGenerate = true) val id: Long = 0, val billId: String,
    val at: Long, val action: String, val snapshot: String)

@Dao
interface BookkeepingDao {
    @Query("SELECT (SELECT COUNT(*) FROM bill_records)+(SELECT COUNT(*) FROM outbox)+(SELECT COUNT(*) FROM master_records)+(SELECT COUNT(*) FROM sync_state)+(SELECT COUNT(*) FROM legacy_links)")
    fun observeInvalidations(): Flow<Int>
    @Query("SELECT * FROM bill_records") suspend fun bills(): List<BillRecord>
    @Query("SELECT * FROM bill_records") fun observeBills(): Flow<List<BillRecord>>
    @Query("SELECT * FROM bill_records WHERE billId=:id") suspend fun bill(id: String): BillRecord?
    @Upsert suspend fun saveBill(bill: BillRecord)
    @Query("DELETE FROM bill_records WHERE billId=:id") suspend fun removeBill(id: String)
    @Query("SELECT * FROM outbox ORDER BY position") suspend fun operations(): List<OutboxOperation>
    @Query("SELECT * FROM outbox ORDER BY position") fun observeOperations(): Flow<List<OutboxOperation>>
    @Insert suspend fun enqueue(operation: OutboxOperation): Long
    @Update suspend fun updateOperation(operation: OutboxOperation)
    @Query("DELETE FROM outbox WHERE operationId=:id") suspend fun removeOperation(id: String)
    @Query("DELETE FROM outbox WHERE billId=:id") suspend fun clearOperations(id: String)
    @Query("SELECT * FROM master_records") suspend fun masters(): List<MasterRecord>
    @Query("SELECT * FROM master_records") fun observeMasters(): Flow<List<MasterRecord>>
    @Upsert suspend fun saveMasters(records: List<MasterRecord>)
    @Query("DELETE FROM master_records") suspend fun clearMasters()
    @Query("DELETE FROM master_records WHERE kind IN ('account','category','tag')") suspend fun clearPublishedMasters()
    @Query("DELETE FROM master_records WHERE kind='effect'") suspend fun clearEffectBaselines()
    @Query("DELETE FROM master_records WHERE kind='uncertain'") suspend fun clearAccountingUncertainty()
    @Query("DELETE FROM master_records WHERE kind=:kind AND id=:id") suspend fun removeMaster(kind: String, id: String)
    @Query("SELECT * FROM sync_state WHERE id=1") suspend fun sync(): SyncState?
    @Query("SELECT * FROM sync_state WHERE id=1") fun observeSync(): Flow<SyncState?>
    @Upsert suspend fun saveSync(state: SyncState)
    @Upsert suspend fun stage(changes: List<StagedChange>)
    @Query("SELECT * FROM sync_stage") suspend fun staged(): List<StagedChange>
    @Query("DELETE FROM sync_stage") suspend fun clearStage()
    @Query("DELETE FROM sync_stage WHERE kind='bill' AND entityId=:id") suspend fun clearStagedBill(id: String)
    @Query("SELECT * FROM legacy_links") suspend fun links(): List<LegacyLink>
    @Upsert suspend fun saveLink(link: LegacyLink)
    @Insert suspend fun history(history: BillHistory)
    @Query("SELECT * FROM bill_history WHERE billId=:id ORDER BY id DESC") suspend fun history(id: String): List<BillHistory>
    @Query("DELETE FROM bill_history WHERE billId=:id") suspend fun clearHistory(id: String)
}

@Database(entities = [Entry::class, LocalAccount::class, BillRecord::class, OutboxOperation::class,
    MasterRecord::class, SyncState::class, StagedChange::class, LegacyLink::class, BillHistory::class],
    version = 2, exportSchema = false)
abstract class LedgerDatabase : RoomDatabase() {
    abstract fun ledger(): LedgerDao
    abstract fun bookkeeping(): BookkeepingDao

    companion object {
        // Keep the pilot tables intact; DDL is also documented in doc/sql/android.
        val UPGRADE_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("CREATE TABLE IF NOT EXISTS bill_records (billId TEXT NOT NULL PRIMARY KEY, serverJson TEXT, localJson TEXT, sourcesJson TEXT NOT NULL, expired INTEGER NOT NULL, restoreStatus TEXT NOT NULL)")
                db.execSQL("CREATE TABLE IF NOT EXISTS outbox (position INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, operationId TEXT NOT NULL, billId TEXT NOT NULL, action TEXT NOT NULL, draft TEXT NOT NULL, request TEXT, state TEXT NOT NULL, error TEXT NOT NULL, predecessor TEXT)")
                db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS index_outbox_operationId ON outbox(operationId)")
                db.execSQL("CREATE INDEX IF NOT EXISTS index_outbox_billId ON outbox(billId)")
                db.execSQL("CREATE TABLE IF NOT EXISTS master_records (kind TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(kind,id))")
                db.execSQL("CREATE TABLE IF NOT EXISTS sync_state (id INTEGER NOT NULL PRIMARY KEY, cursor TEXT NOT NULL, initialized INTEGER NOT NULL, stageCursor TEXT, lastSuccess INTEGER NOT NULL, error TEXT NOT NULL, authExpired INTEGER NOT NULL)")
                db.execSQL("CREATE TABLE IF NOT EXISTS sync_stage (kind TEXT NOT NULL, entityId TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(kind,entityId))")
                db.execSQL("CREATE TABLE IF NOT EXISTS legacy_links (entryId TEXT NOT NULL PRIMARY KEY, billId TEXT NOT NULL, waiting INTEGER NOT NULL)")
                db.execSQL("CREATE TABLE IF NOT EXISTS bill_history (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, billId TEXT NOT NULL, at INTEGER NOT NULL, action TEXT NOT NULL, snapshot TEXT NOT NULL)")
                db.execSQL("CREATE INDEX IF NOT EXISTS index_bill_history_billId ON bill_history(billId)")
            }
        }
    }
}
