package `fun`.huangjiamu.money.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** A normal owner login session; no backend secrets or database credentials belong in the app. */
class CloudClient(context: Context? = null,
    private val storage: SessionStorage? = context?.let { SecureSession(it.applicationContext) },
    private val openConnection: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
) : LedgerApi {
    @Volatile private var cookie: String? = storage?.load()
    override val connected get() = cookie != null
    private val origin = "https://www.huangjiamu.fun"
    @Synchronized fun login(username: String, password: String) {
        call("authorize", JSONObject().put("loginName", username).put("password", password))
    }
    @Synchronized fun logout() { cookie = null; storage?.clear() }
    override suspend fun request(route: String, payload: JSONObject?): JSONObject = withContext(Dispatchers.IO) {
        call(route, payload) as? JSONObject ?: throw ApiException(502, "INVALID_RESPONSE", "云端响应格式异常")
    }
    @Synchronized fun call(route: String, payload: JSONObject? = null): Any {
        val parts = route.split('?', limit = 2)
        val url = URL("$origin/api/${parts[0]}.json" + if (parts.size > 1) "?${parts[1]}" else "")
        val connection = openConnection(url)
        connection.connectTimeout = 15000
        connection.readTimeout = 20000
        connection.instanceFollowRedirects = false
        connection.setRequestProperty("Origin", origin)
        cookie?.let { connection.setRequestProperty("Cookie", it) }
        try {
            if (payload != null) {
                connection.requestMethod = "POST"
                connection.setRequestProperty("Content-Type", "application/json")
                connection.doOutput = true
                connection.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            if (status == 401) logout()
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val response = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            val data = try { JSONObject(response) } catch (_: Exception) { throw IllegalStateException("云端响应异常，请稍后重试") }
            if (status !in 200..299 || !data.optBoolean("success")) throw ApiException(status,
                data.optString("errorCode", data.optString("code", "REQUEST_FAILED")), data.optString("errorMessage", "同步失败，请重试"))
            if (route == "authorize") {
                cookie = connection.getHeaderField("Set-Cookie")?.substringBefore(';')?.takeIf { it.startsWith("money_session=") }
                check(cookie != null) { "未取得登录会话" }
                try { storage?.save(cookie!!) }
                catch (error: Exception) { cookie = null; throw error }
            }
            return data.get("result")
        } finally { connection.disconnect() }
    }
}
