package `fun`.huangjiamu.money.data

import androidx.room.*

data class LedgerItem(val id: String, val time: Long, val amountCents: Long, val type: String,
    val merchant: String, val category: String, val account: String, val status: String,
    val source: String, val reason: String, val canEdit: Boolean = true)

data class UiState(val items: List<LedgerItem> = emptyList(), val notice: String = "", val busy: Boolean = false,
    val notificationConnected: Boolean = false, val accessibilityConnected: Boolean = false,
    val cloudConnected: Boolean = false, val lastSync: String = "尚未同步",
    val accounts: List<Pair<String, String>> = emptyList(), val saveRevision: Long = 0)

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

@Database(entities = [Entry::class, LocalAccount::class], version = 1, exportSchema = false)
abstract class LedgerDatabase : RoomDatabase() { abstract fun ledger(): LedgerDao }
