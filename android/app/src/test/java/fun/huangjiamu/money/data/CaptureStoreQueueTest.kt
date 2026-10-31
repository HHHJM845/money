package `fun`.huangjiamu.money.data

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = android.app.Application::class)
class CaptureStoreQueueTest {
    @Test fun allowedPackagesUseTheSharedRegistryIncludingOfficialCmbLife() {
        assertEquals(`fun`.huangjiamu.money.capture.CaptureTargetRegistry.packageNames, CaptureStore.packages)
        assertTrue("com.cmbchina.ccd.pluto.cmbActivity" in CaptureStore.packages)
        assertFalse("com.cmbchina.ccd.pluto" in CaptureStore.packages)
    }
    @Test fun capturedCandidateAndPendingOutboxCommitBeforeImmediateScheduling() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "capture-queue-test.db"
        context.deleteDatabase(name)
        val db = Room.databaseBuilder(context, LedgerDatabase::class.java, name).allowMainThreadQueries().build()
        val scheduled = CompletableDeferred<Unit>()
        val store = CaptureStore(context, db) {
            assertFalse(db.inTransaction())
            scheduled.complete(Unit)
        }
        try {
            store.capture("com.tencent.mm", "synthetic-payment", "微信支付成功，支付金额￥25.00，商户：便利店", 1793318400000)
            withTimeout(5000) { scheduled.await() }
            assertEquals(1, db.ledger().all().size)
            val bills = LedgerRepository(db).bills()
            assertEquals(1, bills.size)
            assertEquals("pending", bills.single().status)
            assertEquals("queued", bills.single().syncState)
            assertEquals(1, db.bookkeeping().operations().size)
            assertEquals("pending", org.json.JSONObject(db.bookkeeping().operations().single().draft).getString("status"))
        } finally { db.close(); context.deleteDatabase(name) }
    }
}
