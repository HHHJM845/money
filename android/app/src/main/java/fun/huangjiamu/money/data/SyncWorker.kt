package `fun`.huangjiamu.money.data

import android.content.Context
import androidx.work.*
import `fun`.huangjiamu.money.MoneyApplication
import kotlinx.coroutines.CancellationException
import java.util.concurrent.TimeUnit

class SyncWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        return try {
            val app = applicationContext as MoneyApplication
            val outcome = app.sync.synchronizeOutcome()
            if (outcome.retryAutomatically) Result.retry() else Result.success()
        } catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { Result.retry() }
    }

    companion object {
        private val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        fun enqueue(context: Context) {
            WorkManager.getInstance(context).enqueueUniqueWork("ledger-sync-now", ExistingWorkPolicy.APPEND_OR_REPLACE,
                OneTimeWorkRequestBuilder<SyncWorker>().setConstraints(constraints)
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build())
        }
        fun periodic(context: Context) {
            WorkManager.getInstance(context).enqueueUniquePeriodicWork("ledger-sync-periodic", ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES).setConstraints(constraints)
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build())
        }
    }
}
