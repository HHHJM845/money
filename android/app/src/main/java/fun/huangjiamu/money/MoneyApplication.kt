package `fun`.huangjiamu.money

import android.app.Application

class MoneyApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // Connection evidence is valid only for this process, never inherited from a killed service.
        getSharedPreferences("capture", MODE_PRIVATE).edit()
            .putBoolean("notification", false).putBoolean("accessibility", false).apply()
    }
}
