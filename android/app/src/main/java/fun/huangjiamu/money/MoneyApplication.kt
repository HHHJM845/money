package `fun`.huangjiamu.money

import android.app.Application
import `fun`.huangjiamu.money.data.*

class MoneyApplication : Application() {
    val repository by lazy { LedgerRepository(CaptureStore.database(this)) }
    val cloud by lazy { CloudClient(this) }
    val sync by lazy { SyncRepository(repository, cloud) }
    override fun onCreate() {
        super.onCreate()
        // Connection evidence is valid only for this process, never inherited from a killed service.
        getSharedPreferences("capture", MODE_PRIVATE).edit()
            .putBoolean("notification", false).putBoolean("accessibility", false).apply()
        SyncWorker.periodic(this)
    }
}
