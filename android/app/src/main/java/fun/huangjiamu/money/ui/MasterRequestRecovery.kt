package `fun`.huangjiamu.money.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import `fun`.huangjiamu.money.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONObject

internal fun masterRequestTitle(request: PendingMasterRequest): String = runCatching {
    val body = JSONObject(request.body)
    val noun = when (body.getString("entityType")) { "account" -> "账户"; "category" -> "分类"; else -> "标签" }
    val action = if (body.optString("action") == "balance") "余额设置" else if (body.isNull("entityId")) "创建$noun" else "编辑$noun"
    val name = body.optJSONObject("content")?.optString("name").orEmpty()
    if (name.isBlank()) action else "$action · $name"
}.getOrDefault("主数据请求 · 无法读取")

@Composable
internal fun MasterRequestRecovery(request: PendingMasterRequest, actions: LedgerActions, metadata: Metadata, close: () -> Unit,
    confirmed: () -> Unit) {
    val frozen = remember(request.operationId) { request }
    val body = remember(frozen.body) { runCatching { JSONObject(frozen.body) }.getOrNull() }
    var error by rememberSaveable(frozen.operationId) { mutableStateOf(frozen.lastError) }
    var needsLogin by rememberSaveable(frozen.operationId) { mutableStateOf(frozen.lastStatus in listOf(401, 403)) }
    var rejected by rememberSaveable(frozen.operationId) { mutableStateOf(false) }
    var recordInfoExpanded by rememberSaveable(frozen.operationId) { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    val gate = remember { SubmissionGate() }
    val scope = rememberCoroutineScope()
    suspend fun retry() {
        try {
            check(frozen.readError.isBlank() && body != null) { "本机冻结请求无法读取，未发送到云端" }
            actions.request("v2/master/submit", JSONObject(frozen.body))
            confirmed()
        } catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) {
            needsLogin = failure is ApiException && failure.status in listOf(401, 403)
            rejected = MasterOperationJournal.isDefinitive(failure)
            error = (failure.message ?: "请求失败") + if (rejected)
                "。云端已拒绝，本次请求已结束。请返回核对最新资料后再操作。"
            else "。原请求保留，请重试确认。"
        }
    }
    FormPage("恢复主数据请求", busy = busy, close = close) {
        Text(masterRequestTitle(frozen), style = MaterialTheme.typography.titleMedium)
        Text("以下为已冻结的原请求，重试将使用同一操作编号和内容。", style = MaterialTheme.typography.bodySmall)
        ErrorNotice(frozen.readError)
        body?.let { payload ->
            payload.optJSONObject("content")?.let { content ->
                content.keys().asSequence().forEach { key ->
                    val raw = content.opt(key)
                    val value = when {
                        raw == null || raw == JSONObject.NULL -> "未设置"
                        key in listOf("balance", "expectedBalance") -> raw.toString().toLongOrNull()?.let { "¥${yuan(it)}" } ?: raw.toString()
                        key == "active" -> if (raw == true) "启用" else "停用"
                        key == "category" -> accountKinds.find { it.first == raw.toString() }?.second ?: "未知类型（见记录信息）"
                        key == "type" -> when (raw.toString()) {
                            "1" -> "收入"; "2" -> "支出"; "3" -> "转账"; else -> "未知类型（见记录信息）"
                        }
                        key == "parentId" -> if (metadata.categories.any { it.id == raw.toString() })
                            categoryLabel(metadata, raw.toString()) else "历史分类（见记录信息）"
                        else -> raw.toString()
                    }
                    FieldLine(when (key) {
                        "name" -> "名称"; "balance" -> "设置余额"; "expectedBalance" -> "云端已确认余额基准"
                        "reason" -> "调整原因"; "active" -> "启用状态"; "currency" -> "币种"
                        "category" -> "账户类型"; "type" -> "分类类型"; "parentId" -> "上级分类"
                        "sortOrder" -> "排序"; else -> key
                    }, value)
                }
            }
        }
        ErrorNotice(error)
        if (needsLogin && !rejected) LoginFields(busy) { username, password ->
            if (gate.acquire()) {
                busy = true; error = ""
                scope.launch {
                    try {
                        actions.login(username, password)
                        needsLogin = false
                        retry()
                    } catch (cancel: CancellationException) { throw cancel }
                    catch (failure: Exception) { error = failure.message ?: "登录失败，原请求保留" }
                    finally { busy = false; gate.release() }
                }
            }
        }
        Button(onClick = {
            if (gate.acquire()) {
                busy = true; error = ""
                scope.launch {
                    try { retry() }
                    finally { busy = false; gate.release() }
                }
            }
        }, enabled = !busy && !needsLogin && !rejected && frozen.readError.isBlank() && body != null,
            modifier = Modifier.fillMaxWidth().testTag("master-recovery-retry")) {
            Icon(Icons.Default.Refresh, null)
            Text(if (busy) "正在确认…" else "重试原请求")
        }
        TextButton(colors = ButtonDefaults.textButtonColors(contentColor = actionTextColor()), onClick = { recordInfoExpanded = !recordInfoExpanded }, modifier = Modifier.fillMaxWidth()) {
            Text("记录信息")
            Icon(if (recordInfoExpanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore, null)
        }
        if (recordInfoExpanded) {
            FieldLine("操作编号", frozen.operationId)
            if (frozen.createdAt > 0) FieldLine("本机保存时间（上海）", dateLabel(frozen.createdAt))
            body?.let { payload ->
                FieldLine("记录编号", if (payload.isNull("entityId")) "新建记录" else payload.optString("entityId"))
                FieldLine("核对版本", payload.optString("expectedVersion"))
                payload.optJSONObject("content")?.let { content ->
                    if (!content.isNull("parentId")) FieldLine("上级分类编号", content.optString("parentId"))
                    val accountType = content.optString("category")
                    if (content.has("category") && accountKinds.none { it.first == accountType })
                        FieldLine("账户类型原值", accountType)
                    val categoryType = content.optString("type")
                    if (content.has("type") && categoryType !in listOf("1", "2", "3"))
                        FieldLine("分类类型原值", categoryType)
                }
            }
        }
    }
}
