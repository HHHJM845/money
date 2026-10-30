package `fun`.huangjiamu.money.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import `fun`.huangjiamu.money.data.UiState

@Composable
internal fun SettingsPage(
    state: UiState, onNotificationSettings: () -> Unit, onAccessibilitySettings: () -> Unit,
    onSync: () -> Unit, onLogin: (String, String) -> Unit, onLogout: () -> Unit,
) {
    // Credentials intentionally remain only in composition memory, never saved instance state.
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var consent by remember { mutableStateOf<String?>(null) }
    var logoutPrompt by remember { mutableStateOf(false) }
    LaunchedEffect(state.cloudConnected) { if (state.cloudConnected) { username = ""; password = "" } }
    LazyColumn(contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        item { Text("自动采集", style = MaterialTheme.typography.titleLarge)
            Text("开启后先进入待确认，由你核对后入账。真机验证阶段不承诺覆盖所有支付。",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        item { PermissionSection("支付通知", state.notificationConnected,
            "只处理选定支付应用的交易通知；无通知或内容隐藏时可能无法识别。", !state.busy) { consent = "notification" } }
        item { PermissionSection("支付页面识别（可选）", state.accessibilityConnected,
            "通过无障碍服务识别选定应用的支付结果页面，提高覆盖率；不读取其他页面。", !state.busy) { consent = "accessibility" } }
        item { HorizontalDivider(); Text("云同步", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(top = 24.dp))
            Text(if (state.cloudConnected) "已登录云端账本" else "尚未连接云端账本", style = MaterialTheme.typography.bodyLarge)
            Text("最近同步：${state.lastSync}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        item { Text("当前同步范围：有云端账户的已确认支出、收入上传，以及云端账单读取。待确认、未关联账户、转账和退款暂只留在手机。跨端编辑冲突处理尚未实现。",
            style = MaterialTheme.typography.bodyMedium)
            Text("联网不代表已同步成功，请查看同步结果。", style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp)) }
        if (state.cloudConnected) {
            item { Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Button(onClick = onSync, enabled = !state.busy) { Text(if (state.busy) "处理中…" else "立即同步") }
                TextButton(onClick = { logoutPrompt = true }, enabled = !state.busy) { Text("退出登录") }
            } }
            item { Text("可关联的云端账户", style = MaterialTheme.typography.titleMedium)
                if (state.accounts.isEmpty()) Text("暂无账户。请先在网页端创建账户，再同步到手机。", modifier = Modifier.padding(top = 8.dp))
                else state.accounts.forEach { (_, name) -> Text(name, modifier = Modifier.padding(vertical = 8.dp)) }
        } else {
            item { Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(username, { username = it }, label = { Text("账本用户名") },
                    singleLine = true, enabled = !state.busy, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(password, { password = it }, label = { Text("账本密码") }, singleLine = true,
                    visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    enabled = !state.busy, modifier = Modifier.fillMaxWidth())
                Button(onClick = { onLogin(username.trim(), password); password = "" }, enabled = !state.busy && username.isNotBlank() && password.isNotEmpty(),
                    modifier = Modifier.fillMaxWidth()) { Text(if (state.busy) "连接中…" else "登录云端账本") }
            } }
        }
        item { HorizontalDivider(); Text("真机验证版", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 16.dp))
            Text("通知权限和无障碍权限均由你在系统设置中开启，也可随时关闭。系统限制后台、应用更新或支付页面变化都可能造成漏记，请定期核对原始账单。",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 8.dp, bottom = 24.dp)) }
    }
    consent?.let { kind ->
        val notification = kind == "notification"
        AlertDialog(onDismissRequest = { consent = null }, title = { Text(if (notification) "支付通知读取说明" else "可选支付页面识别") },
            text = { Text(if (notification) "系统会授予通知访问权限。本产品仅处理选定支付应用的交易通知，用于提取金额、商户和时间并生成待确认记录。请在下一步系统设置中自行决定是否开启。"
                else "无障碍权限具有读取屏幕内容的能力。本产品仅用于选定支付应用的支付结果页面，不进行自动点击或支付操作。识别结果先进入待确认；你可随时在系统设置关闭。") },
            confirmButton = { TextButton(onClick = { consent = null; if (notification) onNotificationSettings() else onAccessibilitySettings() }) { Text("前往系统设置") } },
            dismissButton = { TextButton(onClick = { consent = null }) { Text("暂不开启") } })
    }
    if (logoutPrompt) AlertDialog(onDismissRequest = { logoutPrompt = false }, title = { Text("退出云端账本？") },
        text = { Text("退出后停止与云端同步。请先确认需要上传的记录已同步完成。") },
        confirmButton = { TextButton(enabled = !state.busy, onClick = { logoutPrompt = false; password = ""; username = ""; onLogout() }) { Text("退出登录") } },
        dismissButton = { TextButton(onClick = { logoutPrompt = false }) { Text("取消") } })
}

@Composable
private fun PermissionSection(title: String, connected: Boolean, description: String, enabled: Boolean, onSettings: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text(if (connected) "服务已连接" else "服务未连接", style = MaterialTheme.typography.labelLarge,
            color = if (connected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
        Text(description, style = MaterialTheme.typography.bodyMedium)
        OutlinedButton(onClick = onSettings, enabled = enabled) { Text(if (connected) "管理权限" else "了解并设置") }
    }
}
