package `fun`.huangjiamu.money

import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.*
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import `fun`.huangjiamu.money.data.*
import `fun`.huangjiamu.money.ui.MoneyApp
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.*

class MainActivity : ComponentActivity() {
    private lateinit var store: CaptureStore
    private val cloud = CloudClient()
    private val lock = Mutex()
    private var state by mutableStateOf(UiState())
    private var lastSync = "尚未同步"
    private var saveRevision = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = CaptureStore(this)
        setContent {
            MoneyApp(state,
                onAdd = { amount, type, merchant, category, account -> save(null, amount, type, merchant, category, account) },
                onConfirm = { id, amount, type, merchant, category, account -> save(id, amount, type, merchant, category, account) },
                onIgnore = { id -> action { store.dao.find(id)?.let { store.dao.save(it.copy(status = "ignored")) }; "已忽略，不计入收支" } },
                onDelete = { id -> action {
                    val entry = store.dao.find(id) ?: error("记录不存在")
                    check(entry.remoteId == null && entry.uploadPayload == null) { "已上传或上传结果待确认的账单不能删除，请先完成同步" }
                    store.dao.delete(id); "已删除本机记录"
                } },
                onNotificationSettings = { openSettings(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS) },
                onAccessibilitySettings = { openSettings(Settings.ACTION_ACCESSIBILITY_SETTINGS) },
                onSync = { action { synchronize(); "同步完成" } },
                onLogin = { username, password -> action { cloud.login(username.trim(), password); synchronize(); "已连接云端账本" } },
                onLogout = { action { cloud.logout(); lastSync = "已退出云同步"; "已退出，保留本机账单" } },
            )
        }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                var ticks = 0
                while (isActive) {
                    if (cloud.connected && ticks++ % 5 == 0 && !lock.isLocked) {
                        lock.withLock {
                            try { withContext(Dispatchers.IO) { synchronize() } }
                            catch (error: CancellationException) { throw error }
                            catch (error: Exception) { lastSync = "同步未完成：${error.message ?: "连接失败"}" }
                        }
                    }
                    refresh()
                    delay(1000)
                }
            }
        }
    }

    private fun openSettings(action: String) {
        try { startActivity(Intent(action)) }
        catch (_: Exception) { state = state.copy(notice = "无法打开系统设置，请从系统设置中手动授权") }
    }

    private fun action(work: suspend () -> String) {
        if (state.busy) return
        state = state.copy(busy = true, notice = "")
        lifecycleScope.launch {
            try {
                val message = lock.withLock { withContext(Dispatchers.IO) { work() } }
                state = state.copy(notice = message)
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { state = state.copy(notice = error.message ?: "操作未完成，请重试") }
            finally { state = state.copy(busy = false); refresh() }
        }
    }

    private fun save(id: String?, amount: String, type: String, merchant: String, category: String, account: String) = action {
        check(type in setOf("expense", "income")) { "验证版仅确认收入/支出；退款和转账请保留待核对" }
        check(Regex("\\d{1,10}(\\.\\d{1,2})?").matches(amount.trim())) { "金额需为最多两位小数的正数" }
        val cents = amount.trim().toBigDecimal().movePointRight(2).longValueExact()
        check(cents > 0) { "金额必须大于零" }
        val previous = id?.let { store.dao.find(it) }
        check(id == null || previous != null) { "记录不存在，请刷新后重试" }
        check(previous?.remoteId == null && previous?.uploadPayload == null) { "已上传或上传结果待确认的账单不能修改，请先完成同步" }
        val key = previous?.id ?: UUID.randomUUID().toString()
        store.dao.save(Entry(key, previous?.eventKey ?: "manual:$key", previous?.time ?: System.currentTimeMillis(),
            cents, type, merchant.trim().take(200), category.trim().ifBlank { "其他" }, account,
            "posted", previous?.source ?: "手动记账", "", null))
        saveRevision++
        if (cloud.connected && account.isNotBlank()) {
            try { synchronize(); "已保存并同步" }
            catch (error: CancellationException) { throw error }
            catch (error: Exception) { "已在本机保存；同步失败：${error.message ?: "连接失败，请重试"}" }
        } else "已在本机保存；登录并选择云端账户后可同步"
    }

    private suspend fun refresh() {
        try {
            val (entries, accounts) = withContext(Dispatchers.IO) { store.dao.all() to store.dao.accounts() }
            state = state.copy(items = entries.filter { it.status != "ignored" }.map { entry ->
                LedgerItem(entry.id, entry.time, entry.amountCents, entry.type, entry.merchant, entry.category,
                    accounts.find { it.id == entry.accountId }?.name ?: "未指定账户", entry.status, entry.source,
                    entry.reason.ifBlank { when {
                        entry.remoteId != null -> "已同步"
                        entry.uploadPayload != null -> "上传结果待确认，请重试同步"
                        else -> "仅本机 / 待同步"
                    } }, entry.remoteId == null && entry.uploadPayload == null)
            }, accounts = accounts.map { it.id to it.name }, notificationConnected = store.connected("notification"),
                accessibilityConnected = store.connected("accessibility"), cloudConnected = cloud.connected, lastSync = lastSync,
                notice = store.captureError().ifBlank { state.notice }, saveRevision = saveRevision)
        } catch (_: Exception) { state = state.copy(notice = "本机账本读取失败，请检查存储空间") }
    }

    private suspend fun synchronize() {
        check(cloud.connected) { "请先登录云端账本" }
        val accountJson = cloud.call("v1/accounts/list") as JSONArray
        val accounts = (0 until accountJson.length()).map { accountJson.getJSONObject(it) }.filter { it.getString("currency") == "CNY" }
        store.dao.saveAccounts(accounts.map { LocalAccount(it.getString("id"), it.getString("name")) })
        val categories = cloud.call("v1/transaction/categories/list") as JSONObject
        for (entry in store.dao.all().filter { it.status == "posted" && it.remoteId == null && it.accountId.isNotBlank() }) {
            check(accounts.any { it.getString("id") == entry.accountId }) { "账单账户不存在，请核对后重试" }
            val body = entry.uploadPayload?.let { JSONObject(it) } ?: run {
                val kind = if (entry.type == "income") 2 else 3
                val list = categories.getJSONArray((kind - 1).toString())
                val expected = if (entry.category == "其他") if (kind == 2) "其他收入" else "其他支出" else entry.category
                val category = (0 until list.length()).map { list.getJSONObject(it) }.find { it.getString("name") == expected }
                    ?: error("云端没有分类「$expected」，请在账单中选择现有分类")
                JSONObject().put("clientSessionId", "pilot:${entry.id}").put("type", kind)
                    .put("categoryId", category.getString("id")).put("sourceAccountId", entry.accountId)
                    .put("sourceAmount", entry.amountCents).put("time", entry.time / 1000).put("comment", entry.merchant)
                    .also { store.dao.save(entry.copy(uploadPayload = it.toString())) }
            }
            val saved = cloud.call("v1/transactions/add", body) as JSONObject
            store.dao.save(entry.copy(remoteId = saved.getString("id"), uploadPayload = null))
        }
        val remote = mutableListOf<JSONObject>()
        var cursor: String? = null
        var complete = false
        for (page in 0 until 2000) {
            val result = cloud.call("v1/transactions/list?count=200" + (cursor?.let { "&max_time=$it" } ?: "")) as JSONObject
            val items = result.getJSONArray("items")
            for (i in 0 until items.length()) remote.add(items.getJSONObject(i))
            val next = if (result.isNull("nextTimeSequenceId")) null else result.getString("nextTimeSequenceId")
            if (next == null) { complete = true; break }
            check(next != cursor) { "云端分页异常" }; cursor = next
        }
        check(complete) { "账本超过验证版读取上限" }
        for (item in remote) {
            val remoteId = item.getString("id")
            val previous = store.dao.remote(remoteId)
            val kind = when (item.getInt("type")) { 2 -> "income"; 3 -> "expense"; else -> "transfer" }
            store.dao.save(Entry(previous?.id ?: "cloud:$remoteId", previous?.eventKey ?: "cloud:$remoteId",
                item.getLong("time") * 1000, item.getLong("sourceAmount"), kind, item.optString("comment"),
                item.optJSONObject("category")?.optString("name") ?: "其他", item.getString("sourceAccountId"),
                "posted", previous?.source ?: "云端账本", "", remoteId))
        }
        lastSync = "同步于 " + SimpleDateFormat("HH:mm:ss", Locale.CHINA).format(Date())
    }
}
