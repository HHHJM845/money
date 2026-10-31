package `fun`.huangjiamu.money.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import `fun`.huangjiamu.money.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.UUID

@Composable
internal fun MasterForm(target: JSONObject, metadata: Metadata, actions: LedgerActions, close: () -> Unit) {
    val entityType = target.getString("entityType")
    val balanceAction = target.optString("action") == "balance"
    val noun = when (entityType) { "account" -> "账户"; "category" -> "分类"; else -> "标签" }
    var baseline by rememberSaveable { mutableStateOf(target.optJSONObject("base")?.toString()) }
    val base = baseline?.let { JSONObject(it) }
    val confirmedBalance = base?.let { if (it.has("confirmedBalance")) it.optString("confirmedBalance") else it.optString("balance") }
        ?.toLongOrNull()
    var name by rememberSaveable { mutableStateOf(base?.optString("name").orEmpty()) }
    var type by rememberSaveable { mutableStateOf(base?.optString("type")?.takeIf { it in listOf("1", "2", "3") } ?: "2") }
    var accountKind by rememberSaveable { mutableStateOf(base?.optString("category")?.takeIf { it.isNotBlank() } ?: "2") }
    var parent by rememberSaveable { mutableStateOf(base?.optString("parentId")?.takeIf { it.isNotBlank() && it != "null" }) }
    var sort by rememberSaveable { mutableStateOf(base?.optInt("sortOrder")?.toString() ?: "0") }
    var active by rememberSaveable { mutableStateOf(base?.optBoolean("active", true) ?: true) }
    var balanceEnabled by rememberSaveable { mutableStateOf(confirmedBalance != null) }
    var balance by rememberSaveable { mutableStateOf(confirmedBalance?.let { yuan(it) }.orEmpty()) }
    var reason by rememberSaveable { mutableStateOf("") }
    // The request wrapper journals this exact body before HTTP; this copy also retains the open form.
    var frozen by rememberSaveable { mutableStateOf<String?>(null) }
    var error by rememberSaveable { mutableStateOf("") }
    var conflict by rememberSaveable { mutableStateOf(false) }
    var needsLogin by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    val gate = remember { SubmissionGate() }
    val scope = rememberCoroutineScope()
    val locked = frozen != null || busy
    suspend fun execute(body: String) {
        try {
            actions.request("v2/master/submit", JSONObject(body))
            frozen = null
            close()
        } catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) {
            val definitive = MasterOperationJournal.isDefinitive(failure)
            if (definitive) frozen = null
            conflict = failure is ApiException && failure.status == 409
            needsLogin = failure is ApiException && failure.status in listOf(401, 403)
            error = (failure.message ?: "网络不可用") + if (definitive) "。输入已保留。" else "。结果尚未确认，内容已锁定，请重试同一操作。"
        }
    }
    fun submit() {
        if (conflict || !gate.acquire()) return
        busy = true; error = ""
        scope.launch {
            try {
                val body = frozen ?: run {
                    val content = JSONObject()
                    if (balanceAction) {
                        require(reason.isNotBlank()) { "请填写调整原因" }
                        val cents = if (balanceEnabled) amountInput(balance, signed = true).toString() else null
                        content.put("balance", cents ?: JSONObject.NULL).put("expectedBalance",
                            confirmedBalance?.toString() ?: JSONObject.NULL)
                            .put("reason", reason.trim())
                    } else {
                        require(name.isNotBlank() && name.trim().length <= 100) { "请输入名称，最多 100 字" }
                        content.put("name", name.trim()).put("active", active)
                        when (entityType) {
                            "account" -> {
                                content.put("category", accountKind.toInt()).put("currency", "CNY")
                                if (base == null) content.put("balance", if (balance.isBlank()) JSONObject.NULL else amountInput(balance, true).toString())
                            }
                            else -> {
                                val order = sort.toIntOrNull()
                                require(order != null && order >= 0) { "排序必须为非负整数" }
                                content.put("sortOrder", order)
                                if (entityType == "category") content.put("type", type.toInt()).put("parentId", parent ?: JSONObject.NULL)
                            }
                        }
                    }
                    JSONObject().put("operationId", UUID.randomUUID().toString()).put("entityType", entityType)
                        .put("entityId", base?.getString("id") ?: JSONObject.NULL).put("expectedVersion", base?.getInt("version") ?: 0)
                        .put("action", if (balanceAction) "balance" else "save").put("content", content).toString().also { frozen = it }
                }
                execute(body)
            } catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) { error = failure.message ?: "请核对输入" }
            finally { busy = false; gate.release() }
        }
    }
    FormPage(if (balanceAction) "余额设置 · ${base?.optString("name")}" else "${if (base == null) "创建" else "编辑"}$noun",
        busy = busy, close = close) {
        Text("此设置需要联网，云端确认后生效。", style = MaterialTheme.typography.bodySmall)
        if (balanceAction) {
            FieldLine("打开表单时的云端已确认余额", confirmedBalance?.let { "¥${yuan(it)}" } ?: "未设置")
            if (base?.optBoolean("balancePending") == true) Text("本机仍有待同步账单，校准前请核对同步状态。",
                style = MaterialTheme.typography.bodySmall)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("启用账面余额", Modifier.weight(1f))
                Switch(balanceEnabled, { balanceEnabled = it }, enabled = !locked)
            }
            OutlinedTextField(balance, { balance = it }, enabled = !locked && balanceEnabled,
                label = { Text("校准余额（元，欠款为负数）") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                modifier = Modifier.fillMaxWidth().testTag("master-balance"))
            OutlinedTextField(reason, { reason = it }, enabled = !locked, label = { Text("调整原因") },
                modifier = Modifier.fillMaxWidth().testTag("master-reason"))
            Text("以填写值作为当前账面余额，不重放旧流水。调整会记入余额历史。", style = MaterialTheme.typography.bodySmall)
        } else {
            OutlinedTextField(name, { name = it }, enabled = !locked, label = { Text("${noun}名称") },
                modifier = Modifier.fillMaxWidth().testTag("master-name"))
            if (entityType == "account") {
                ChoiceField("账户类型", accountKind, accountKinds, !locked, nullable = false) { accountKind = it ?: "2" }
                if (base == null) {
                    OutlinedTextField(balance, { balance = it }, enabled = !locked, label = { Text("初始余额（元，可留空）") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
                    Text("留空保持未设置；信用卡欠款填写负数。", style = MaterialTheme.typography.bodySmall)
                }
            } else {
                if (entityType == "category") {
                    ChoiceField("分类类型", type, listOf("1" to "收入", "2" to "支出", "3" to "转账"), !locked, false) {
                        if (type != it) { type = it ?: "2"; parent = null }
                    }
                    ChoiceField("上级分类（不选为一级）", parent, metadata.categories.filter {
                        it.type.toString() == type && it.parentId == null && it.id != base?.optString("id") && (it.active || it.id == parent)
                    }.map { it.id to categoryLabel(metadata, it.id) }, !locked) { parent = it }
                }
                OutlinedTextField(sort, { sort = it }, enabled = !locked, label = { Text("排序") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("启用$noun", Modifier.weight(1f)); Switch(active, { active = it }, enabled = !locked)
            }
        }
        ErrorNotice(error)
        if (frozen != null) Text("请重试确认本次操作。已保存的未确认请求可在‘我的’中恢复，避免创建重复记录。",
            style = MaterialTheme.typography.bodySmall)
        if (needsLogin) LoginFields(busy) { username, password ->
            if (gate.acquire()) {
                busy = true
                scope.launch {
                    try {
                        actions.login(username, password)
                        needsLogin = false
                        frozen?.let { execute(it) }
                    } catch (cancel: CancellationException) { throw cancel }
                    catch (failure: Exception) { error = failure.message ?: "登录失败" }
                    finally { busy = false; gate.release() }
                }
            }
        }
        if (conflict) OutlinedButton(onClick = {
            if (gate.acquire()) {
                busy = true
                scope.launch {
                    try {
                        val snapshot = actions.request("v2/snapshot", null)
                        val rows = snapshot.getJSONArray(when (entityType) { "account" -> "accounts"; "category" -> "categories"; else -> "tags" })
                        val next = (0 until rows.length()).map { rows.getJSONObject(it) }.find { it.getString("id") == base?.getString("id") }
                            ?: throw IllegalStateException("记录不存在，请关闭后重新读取")
                        baseline = next.toString(); conflict = false
                        error = "已读取云端 v${next.getInt("version")} · ${next.getString("name")}。当前输入保留，请核对后再保存。"
                    } catch (cancel: CancellationException) { throw cancel }
                    catch (failure: Exception) { error = failure.message ?: "读取失败" }
                    finally { busy = false; gate.release() }
                }
            }
        }, enabled = !busy) { Text("读取最新版本并保留输入") }
        Button(onClick = { submit() }, enabled = !busy && !needsLogin && !conflict,
            modifier = Modifier.fillMaxWidth().testTag("master-save")) {
            Text(if (busy) "正在确认…" else if (frozen != null) "重试确认本次操作" else "保存到云端")
        }
    }
}
