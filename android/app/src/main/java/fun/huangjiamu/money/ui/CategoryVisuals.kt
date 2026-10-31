package `fun`.huangjiamu.money.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import `fun`.huangjiamu.money.data.CategoryView

internal fun categoryIcon(name: String): ImageVector = when {
    listOf("餐", "食", "饭").any { it in name } -> Icons.Default.Restaurant
    listOf("交通", "车", "出行").any { it in name } -> Icons.Default.DirectionsBus
    listOf("购物", "衣", "服").any { it in name } -> Icons.Default.ShoppingBag
    listOf("家", "住", "房").any { it in name } -> Icons.Default.Home
    listOf("医", "健康").any { it in name } -> Icons.Default.LocalHospital
    listOf("娱乐", "游戏").any { it in name } -> Icons.Default.SportsEsports
    listOf("工资", "收入").any { it in name } -> Icons.Default.AccountBalanceWallet
    else -> Icons.Default.Category
}

@Composable
internal fun CategoryGrid(rows: List<CategoryView>, selected: String?, expanded: String?, enabled: Boolean,
    choose: (CategoryView) -> Unit) {
    rows.chunked(6).forEach { group ->
        Row(Modifier.fillMaxWidth()) {
            group.forEach { row ->
                Column(Modifier.weight(1f).clickable(enabled = enabled) { choose(row) }.padding(vertical = 8.dp),
                    horizontalAlignment = Alignment.CenterHorizontally) {
                    Box(Modifier.size(38.dp).background(
                        if (row.id == selected || row.id == expanded) MaterialTheme.colorScheme.primaryContainer
                        else MaterialTheme.colorScheme.background, CircleShape), contentAlignment = Alignment.Center) {
                        Icon(categoryIcon(row.name), null, Modifier.size(22.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text(row.name, style = MaterialTheme.typography.labelSmall, textAlign = TextAlign.Center,
                        modifier = Modifier.padding(top = 6.dp), maxLines = 2)
                }
            }
            repeat(6 - group.size) { Spacer(Modifier.weight(1f)) }
        }
    }
}

@Composable
internal fun CompactChoice(label: String, value: String?, options: List<Pair<String, String>>, enabled: Boolean,
    modifier: Modifier = Modifier, choose: (String?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        TextButton(colors = ButtonDefaults.textButtonColors(contentColor = actionTextColor()), onClick = { open = true }, enabled = enabled, modifier = modifier.fillMaxWidth()) {
            Icon(Icons.Default.AccountBalanceWallet, null, Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
            Text(options.find { it.first == value }?.second ?: label, maxLines = 1)
        }
        DropdownMenu(open, onDismissRequest = { open = false }) {
            DropdownMenuItem(text = { Text("不选择") }, onClick = { choose(null); open = false })
            options.forEach { (id, title) ->
                DropdownMenuItem(text = { Text(title) }, onClick = { choose(id); open = false })
            }
        }
    }
}
