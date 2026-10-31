package `fun`.huangjiamu.money

import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import `fun`.huangjiamu.money.capture.PaymentAccessibilityService
import `fun`.huangjiamu.money.capture.PaymentNotificationListener
import `fun`.huangjiamu.money.data.*
import `fun`.huangjiamu.money.ui.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

class MainActivity : ComponentActivity() {
    private val app get() = application as MoneyApplication
    private val store by lazy { CaptureStore(this) }
    private val masterJournal by lazy { MasterOperationJournal(app.repository.db) }
    private var ledger by mutableStateOf(LedgerState())
    private var pendingMasterRequests by mutableStateOf<List<PendingMasterRequest>>(emptyList())
    private var masterRequestsLoaded by mutableStateOf(false)
    private var masterRequestError by mutableStateOf("")
    private var capture by mutableStateOf(CaptureUiState())
    private var loaded by mutableStateOf(false)
    private var readError by mutableStateOf("")
    private var syncing by mutableStateOf(false)
    private var connected by mutableStateOf(false)
    private val syncGate = AtomicBoolean(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        refreshConnection()
        val actions = LedgerActions(
            save = { id, content, status ->
                withContext(Dispatchers.IO) { app.repository.save(id, content, status) }
                scheduleSync()
            },
            delete = { id -> withContext(Dispatchers.IO) { app.repository.delete(id) }; scheduleSync() },
            restore = { id -> withContext(Dispatchers.IO) { app.repository.restore(id) }; scheduleSync() },
            resolve = { id, local, reviewedVersion ->
                withContext(Dispatchers.IO) { app.repository.resolveConflict(id, local, reviewedVersion) }
                scheduleSync()
            },
            retry = { id -> withContext(Dispatchers.IO) { app.repository.retry(id) }; scheduleSync() },
            synchronize = { synchronize() },
            login = { username, password ->
                withContext(Dispatchers.IO) { app.cloud.login(username, password) }
                connected = app.cloud.connected
                scheduleSync()
            },
            logout = {
                lifecycleScope.launch {
                    try {
                        withContext(Dispatchers.IO) { app.cloud.logout() }
                        connected = false
                    } catch (cancel: CancellationException) { throw cancel }
                    catch (failure: Exception) { readError = "退出登录失败：${failure.message}" }
                }
            },
            request = { route, payload ->
                withContext(Dispatchers.IO) {
                    if (route == "v2/master/submit") {
                        masterJournal.execute(requireNotNull(payload) { "主数据请求内容不能为空" }) {
                            app.cloud.request(route, it)
                        }
                    } else app.cloud.request(route, payload)
                }.also { if (payload != null) scheduleSync() }
            },
            balanceHistory = { accountId ->
                withContext(Dispatchers.IO) {
                    val rows = app.cloud.call("v2/accounts/history?accountId=$accountId") as? JSONArray
                        ?: error("余额历史响应格式异常")
                    (0 until rows.length()).map { rows.getJSONObject(it) }
                }
            },
            billHistory = { id ->
                withContext(Dispatchers.IO) {
                    app.repository.dao.history(id).map {
                        val content = JSONObject(it.snapshot).optJSONObject("content")
                        "${dateLabel(it.at)} · ${historyLabel(it.action)}" + (content?.let { c ->
                            "\n${c.optString("merchant")} · ${kindLabel(c.optString("kind"))} ¥${yuan(c.optString("amountCents").toLongOrNull())}"
                        } ?: "")
                    }
                }
            },
            permission = { service ->
                try {
                    startActivity(Intent(if (service == "notification") Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS
                        else Settings.ACTION_ACCESSIBILITY_SETTINGS))
                } catch (_: Exception) { readError = "无法打开系统设置，请在手机设置中手动管理见财权限。" }
            },
            toggleSource = { source, enabled ->
                if (source in CaptureStore.packages) {
                    getSharedPreferences("capture", MODE_PRIVATE).edit().putBoolean("enabled:$source", enabled).apply()
                    refreshCapture()
                }
            },
        )
        setContent {
            MoneyTheme {
                MoneyApp(ledger, actions, capture, connected, loading = !loaded, loadError = readError, syncing = syncing,
                    pendingMasterRequests = pendingMasterRequests, masterRequestError = masterRequestError,
                    masterRequestsLoading = !masterRequestsLoaded)
            }
        }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch {
                    try {
                        app.repository.observe().flowOn(Dispatchers.IO).collect {
                            ledger = it; loaded = true; readError = ""; refreshConnection()
                        }
                    } catch (cancel: CancellationException) { throw cancel }
                    catch (failure: Exception) { loaded = true; readError = "本机账本读取失败：${failure.message}" }
                }
                launch {
                    try {
                        app.repository.dao.observeMasters().map { MasterOperationJournal.pending(it) }
                            .flowOn(Dispatchers.IO).collect {
                                pendingMasterRequests = it
                                masterRequestsLoaded = true
                                masterRequestError = ""
                            }
                    } catch (cancel: CancellationException) { throw cancel }
                    catch (failure: Exception) {
                        masterRequestsLoaded = true
                        masterRequestError = "主数据请求恢复失败：${failure.message}"
                    }
                }
                launch {
                    while (isActive) {
                        synchronize()
                        delay(20_000)
                    }
                }
                launch {
                    while (isActive) { refreshCapture(); delay(5_000) }
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        refreshConnection()
        refreshCapture()
    }

    private fun scheduleSync() {
        try { SyncWorker.enqueue(this) }
        catch (failure: Exception) { readError = "本机操作已保存，但后台同步调度失败：${failure.message}" }
        lifecycleScope.launch { synchronize() }
    }

    private suspend fun synchronize(): Boolean {
        if (!syncGate.compareAndSet(false, true)) return false
        syncing = true
        return try {
            withContext(Dispatchers.IO) { app.sync.synchronize() }
        } catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) { readError = "同步失败：${failure.message}"; false }
        finally { syncing = false; refreshConnection(); syncGate.set(false) }
    }

    private fun refreshConnection() {
        lifecycleScope.launch {
            try { connected = withContext(Dispatchers.IO) { app.cloud.connected } }
            catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) { readError = "登录状态读取失败：${failure.message}" }
        }
    }

    private fun refreshCapture() {
        fun granted(setting: String, service: Class<*>): Boolean {
            val expected = ComponentName(this, service)
            return Settings.Secure.getString(contentResolver, setting).orEmpty().split(':')
                .mapNotNull { ComponentName.unflattenFromString(it) }.any { it == expected }
        }
        capture = CaptureUiState(
            notificationPermission = granted("enabled_notification_listeners", PaymentNotificationListener::class.java),
            accessibilityPermission = granted(Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, PaymentAccessibilityService::class.java),
            notificationConnected = store.connected("notification"), accessibilityConnected = store.connected("accessibility"),
            sources = CaptureStore.packages.map { it to store.enabled(it) }, error = store.captureError(),
        )
    }

    private fun historyLabel(action: String): String = when (action) {
        "save" -> "记账 / 修改"; "delete" -> "移入回收站"; "restore" -> "恢复"; else -> action
    }
}
