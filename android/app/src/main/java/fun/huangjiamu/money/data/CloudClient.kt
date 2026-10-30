package `fun`.huangjiamu.money.data

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** A normal owner login session; no backend secrets or database credentials belong in the app. */
class CloudClient {
    private var cookie: String? = null
    val connected get() = cookie != null
    private val origin = "https://www.huangjiamu.fun"
    fun login(username: String, password: String) {
        call("authorize", JSONObject().put("loginName", username).put("password", password))
    }
    fun logout() { cookie = null }
    fun call(route: String, payload: JSONObject? = null): Any {
        val parts = route.split('?', limit = 2)
        val url = URL("$origin/api/${parts[0]}.json" + if (parts.size > 1) "?${parts[1]}" else "")
        val connection = url.openConnection() as HttpURLConnection
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
            if (status == 401) cookie = null
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val response = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            val data = try { JSONObject(response) } catch (_: Exception) { throw IllegalStateException("云端响应异常，请稍后重试") }
            if (status !in 200..299 || !data.optBoolean("success")) throw IllegalStateException(data.optString("errorMessage", "同步失败，请重试"))
            if (route == "authorize") {
                cookie = connection.getHeaderField("Set-Cookie")?.substringBefore(';')?.takeIf { it.startsWith("money_session=") }
                check(cookie != null) { "未取得登录会话" }
            }
            return data.get("result")
        } finally { connection.disconnect() }
    }
}
