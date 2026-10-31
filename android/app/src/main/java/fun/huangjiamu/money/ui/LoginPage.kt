package `fun`.huangjiamu.money.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
internal fun LoginFields(busy: Boolean, login: (String, String) -> Unit) {
    var username by rememberSaveable { mutableStateOf("") }
    // Password remains in memory only.
    var password by remember { mutableStateOf("") }
    OutlinedTextField(username, { username = it }, enabled = !busy, label = { Text("用户名") },
        singleLine = true, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(password, { password = it }, enabled = !busy, label = { Text("密码") }, singleLine = true,
        visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        modifier = Modifier.fillMaxWidth())
    Button(onClick = { login(username.trim(), password) }, enabled = !busy && username.isNotBlank() && password.isNotBlank(),
        modifier = Modifier.fillMaxWidth()) { Text(if (busy) "正在登录…" else "登录") }
}

@Composable
internal fun LoginPage(login: suspend (String, String) -> Unit, close: () -> Unit) {
    var busy by remember { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf("") }
    val gate = remember { SubmissionGate() }
    val scope = rememberCoroutineScope()
    FormPage("登录云端账本", busy, close) {
        Text("本机账单和待上传操作会保留。", style = MaterialTheme.typography.bodyMedium)
        LoginFields(busy) { username, password ->
            if (gate.acquire()) {
                busy = true; error = ""
                scope.launch {
                    try { login(username, password); close() }
                    catch (cancel: CancellationException) { throw cancel }
                    catch (failure: Exception) { error = failure.message ?: "登录失败，请重试" }
                    finally { busy = false; gate.release() }
                }
            }
        }
        ErrorNotice(error)
    }
}
