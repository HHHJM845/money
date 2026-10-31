package `fun`.huangjiamu.money.data

import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import androidx.test.core.app.ApplicationProvider
import java.net.HttpURLConnection
import java.net.URL
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = android.app.Application::class)
class CloudSessionTest {
    @Test fun secureSessionChecksClearCommitResult() {
        val base = ApplicationProvider.getApplicationContext<Context>()
        val real = base.getSharedPreferences("clear-failure-test", Context.MODE_PRIVATE)
        val context = object : ContextWrapper(base) {
            override fun getSharedPreferences(name: String, mode: Int): SharedPreferences = object : SharedPreferences by real {
                override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor by real.edit() {
                    override fun clear(): SharedPreferences.Editor = this
                    override fun commit() = false
                }
            }
        }
        assertThrows(IllegalStateException::class.java) { SecureSession(context).clear() }
    }
    @Test fun logoutSurfacesDurableClearFailure() {
        val storage = object : SessionStorage {
            override fun load(): String = "money_session=synthetic"
            override fun save(cookie: String) = Unit
            override fun clear() { error("安全会话清除失败") }
        }
        val client = CloudClient(storage = storage)
        assertThrows(IllegalStateException::class.java) { client.logout() }
        assertFalse(client.connected)
    }

    @Test fun inFlightLoginCannotPersistSessionAfterLogoutReturns() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val loggedOut = CountDownLatch(1)
        var persisted: String? = null
        val storage = object : SessionStorage {
            override fun load(): String? = null
            override fun save(cookie: String) { persisted = cookie }
            override fun clear() { persisted = null }
        }
        val client = CloudClient(storage = storage, openConnection = { url ->
            object : HttpURLConnection(url) {
                override fun disconnect() = Unit
                override fun usingProxy() = false
                override fun connect() = Unit
                override fun getOutputStream() = ByteArrayOutputStream()
                override fun getResponseCode(): Int { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)); return 200 }
                override fun getInputStream() = ByteArrayInputStream("""{"success":true,"result":{}}""".toByteArray())
                override fun getHeaderField(name: String): String? = if (name == "Set-Cookie") "money_session=synthetic; HttpOnly" else null
            }
        })
        val login = thread { client.login("synthetic", "synthetic") }
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        val logout = thread { client.logout(); loggedOut.countDown() }
        assertFalse(loggedOut.await(100, TimeUnit.MILLISECONDS))
        release.countDown()
        login.join(5000); logout.join(5000)
        assertFalse(login.isAlive || logout.isAlive)
        assertFalse(client.connected)
        assertNull(persisted)
    }
}
