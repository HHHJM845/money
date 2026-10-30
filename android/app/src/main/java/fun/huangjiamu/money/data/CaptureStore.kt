package `fun`.huangjiamu.money.data

import android.content.Context
import androidx.room.Room
import `fun`.huangjiamu.money.capture.PaymentParser
import kotlinx.coroutines.*
import java.security.MessageDigest
import java.util.UUID

class CaptureStore(context: Context) {
    private val app = context.applicationContext
    private val preferences = app.getSharedPreferences("capture", Context.MODE_PRIVATE)
    val dao = database(app).ledger()
    fun enabled(source: String): Boolean = source in packages && preferences.getBoolean("enabled:$source", true)
    fun setServiceState(source: String, connected: Boolean) {
        preferences.edit().putBoolean(source, connected).apply()
    }
    fun connected(source: String) = preferences.getBoolean(source, false)
    fun capture(source: String, eventKey: String, text: String, receivedAt: Long) {
        if (!enabled(source)) return
        val parsed = PaymentParser.parse(text) ?: return
        scope.launch {
            try {
                val hash = MessageDigest.getInstance("SHA-256").digest("$source:$eventKey".toByteArray()).joinToString("") { "%02x".format(it) }
                dao.capture(Entry(UUID.randomUUID().toString(), hash, receivedAt, parsed.amountCents ?: 0,
                    parsed.type, parsed.merchant.orEmpty(), "其他", "", "pending", source,
                    parsed.reason.ifBlank { "自动识别结果，请核对金额、收支方向与支付账户" }))
                preferences.edit().putLong("lastCapture", receivedAt).remove("captureError").apply()
            } catch (_: Exception) {
                preferences.edit().putString("captureError", "识别结果保存失败，请打开应用检查存储空间").apply()
            }
        }
    }
    fun captureError(): String = preferences.getString("captureError", "").orEmpty()
    companion object {
        val packages = setOf("com.tencent.mm", "com.eg.android.AlipayGphone", "cmb.pb", "com.cmbchina.ccd.pluto")
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        @Volatile private var instance: LedgerDatabase? = null
        private fun database(context: Context): LedgerDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(context, LedgerDatabase::class.java, "money-pilot.db").build().also { instance = it }
        }
    }
}
