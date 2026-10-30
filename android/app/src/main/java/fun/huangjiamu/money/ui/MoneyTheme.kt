package `fun`.huangjiamu.money.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

@Composable
internal fun MoneyTheme(content: @Composable () -> Unit) {
    val colors = if (isSystemInDarkTheme()) darkColorScheme(
        primary = Color(0xFFA6D5BF), secondary = Color(0xFFBCCBC2),
        surface = Color(0xFF141916), background = Color(0xFF141916),
    ) else lightColorScheme(
        primary = Color(0xFF24634B), onPrimary = Color.White,
        primaryContainer = Color(0xFFDCEDE3), onPrimaryContainer = Color(0xFF143E2E),
        secondary = Color(0xFF53645A), surface = Color(0xFFFAFBF8),
        background = Color(0xFFFAFBF8),
    )
    MaterialTheme(colorScheme = colors, content = content)
}
