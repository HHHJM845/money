package `fun`.huangjiamu.money.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun FormPage(title: String, busy: Boolean = false, close: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    Dialog(onDismissRequest = { if (!busy) close() }, properties = DialogProperties(
        usePlatformDefaultWidth = false, dismissOnBackPress = !busy, dismissOnClickOutside = false,
    )) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Scaffold(topBar = {
                TopAppBar(title = { Text(title, style = MaterialTheme.typography.titleLarge) }, navigationIcon = {
                    IconButton(enabled = !busy, onClick = close) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") }
                })
            }) { padding ->
                Column(Modifier.padding(padding).imePadding().fillMaxSize().verticalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(14.dp), content = content)
            }
        }
    }
}

@Composable
internal fun ChoiceField(label: String, value: String?, options: List<Pair<String, String>>,
    enabled: Boolean = true, nullable: Boolean = true, modifier: Modifier = Modifier, choose: (String?) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Column {
        Text(label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Box {
            OutlinedButton(enabled = enabled, modifier = modifier.fillMaxWidth(), onClick = { expanded = true }) {
                Text(options.find { it.first == value }?.second ?: if (value != null) "历史引用 #$value" else "请选择",
                    modifier = Modifier.weight(1f))
                Icon(Icons.Default.ArrowDropDown, null)
            }
            DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }, modifier = Modifier.heightIn(max = 360.dp)) {
                if (nullable) DropdownMenuItem(text = { Text("不选择") }, onClick = { choose(null); expanded = false })
                options.forEach { (id, text) ->
                    DropdownMenuItem(text = { Text(text) }, onClick = { choose(id); expanded = false })
                }
            }
        }
    }
}

@Composable
internal fun ErrorNotice(message: String) {
    if (message.isNotBlank()) Text(message, color = MaterialTheme.colorScheme.error,
        style = MaterialTheme.typography.bodyMedium)
}

@Composable
internal fun SectionLabel(text: String) {
    Text(text, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(top = 12.dp))
}

@Composable
internal fun FieldLine(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value.ifBlank { "未填写" }, style = MaterialTheme.typography.bodyLarge)
    }
}
