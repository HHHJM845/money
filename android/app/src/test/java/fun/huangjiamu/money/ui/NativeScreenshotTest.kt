package `fun`.huangjiamu.money.ui

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Density
import `fun`.huangjiamu.money.data.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog
import java.io.File

/** Synthetic native View/Compose rendering, never evidence from a OnePlus device. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class, qualifiers = "w412dp-h915dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NativeScreenshotTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val metadata = Metadata(listOf(AccountView("1", "现金", null, "1", "CNY")),
        listOf(CategoryView("2", "餐饮", 2, null, true)))

    private fun actions(save: suspend (String?, BillContent, String) -> Unit) = LedgerActions(
        save = save, delete = {}, restore = {}, resolve = { _, _, _ -> },
        retry = {}, synchronize = { true }, login = { _, _ -> }, logout = {},
        request = { _, _ -> JSONObject() }, balanceHistory = { emptyList() }, billHistory = { emptyList() },
        permission = {}, toggleSource = { _, _ -> })

    @Test fun nativeEntrySaveFeedbackAndThreeTabs() {
        val state = mutableStateOf(LedgerState(metadata = metadata))
        var saves = 0
        compose.setContent {
            MoneyTheme {
                Column {
                    Text("合成界面截图 · 非一加 13 真机证据")
                    MoneyApp(state.value, actions { _, content, status ->
                        saves++
                        state.value = state.value.copy(bills = listOf(BillView("synthetic", 0, status, content,
                            "apply", "queued", "", emptyList(), null, content.occurredAt, content.occurredAt, null)),
                            queuedCount = 1)
                    })
                }
            }
        }
        compose.onNodeWithTag("new-entry").performClick()
        compose.onNodeWithTag("entry-amount").performTextInput("25.00")
        compose.onNodeWithTag("entry-merchant").performScrollTo().performTextInput("合成商户")
        compose.onNodeWithTag("entry-account").performScrollTo().performClick()
        compose.onNodeWithText("现金").performClick()
        compose.onNodeWithTag("entry-category").performScrollTo().performClick()
        compose.onNodeWithText("餐饮").performClick()
        compose.onNodeWithTag("entry-save").performScrollTo().performClick()
        compose.onNodeWithText("已保存到本机，等待云端确认").assertIsDisplayed()
        compose.runOnIdle { assertEquals(1, saves); assertEquals("posted", state.value.bills.single().status) }
        compose.onNodeWithTag("nav-1").performClick().assertIsSelected()
        compose.onNodeWithText("退款（到账月）").assertExists()
        compose.onNodeWithTag("nav-2").performClick().assertIsSelected()
        compose.onNodeWithText("云端同步").assertExists()
        compose.onNodeWithTag("nav-0").performClick().assertIsSelected()
        compose.onNodeWithTag("bill-list").performScrollToNode(hasText("合成商户"))
        compose.onNodeWithText("合成商户").assertIsDisplayed()
        captureNativeWindow("synthetic-entry-workflow-not-oneplus")
    }

    @Test
    @Config(qualifiers = "w360dp-h800dp-night")
    fun dark360LargeFontPendingDetailRequiresExplicitValidConfirmation() {
        val content = BillContent(amountCents = 99900, merchant = "合成待确认", accountId = null, categoryId = null)
        val pending = BillView("pending", 0, "pending", content, "apply", "queued", "", emptyList(), null,
            content.occurredAt, content.occurredAt, null)
        var saves = 0
        var dark = false
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale = 1.3f)) {
                MoneyTheme {
                    dark = MaterialTheme.colorScheme.background.luminance() < .2f
                    Column {
                        Text("合成 · 360dp / 1.3 / 深色 · 非真机")
                        MoneyApp(LedgerState(listOf(pending), metadata), actions { _, _, _ -> saves++ })
                    }
                }
            }
        }
        compose.runOnIdle { assertTrue("Night configuration must select the dark palette", dark) }
        compose.onNodeWithText("待确认 1").performScrollTo().performClick()
        compose.onNodeWithTag("bill-list").performScrollToNode(hasText("合成待确认"))
        compose.onNodeWithText("合成待确认").performClick()
        compose.onNodeWithText("待确认 · 不计统计，不改变余额").assertExists()
        compose.onNodeWithText("登记部分 / 全部退款").assertDoesNotExist()
        compose.onNodeWithText("补充并确认").performScrollTo().assertIsDisplayed()
        captureNativeWindow("synthetic-pending-dark360-font130-not-oneplus")
        compose.onNodeWithText("补充并确认").performClick()
        compose.onNodeWithTag("entry-amount").assertTextContains("999.00")
        compose.onNodeWithTag("entry-save").performScrollTo().performClick()
        compose.onNodeWithText("入账前请补齐金额和资金账户").assertExists()
        compose.onNodeWithTag("entry-amount").assertTextContains("999.00")
        compose.runOnIdle { assertEquals(0, saves) }
    }

    private fun captureNativeWindow(name: String) {
        compose.waitForIdle()
        // Window-redraw callbacks used by captureToImage time out in this Robolectric
        // host. Draw the real native view tree instead; screenshots are never skipped.
        val image = compose.runOnIdle {
            val view = ShadowDialog.getLatestDialog()?.takeIf { it.isShowing }?.window?.decorView
                ?: compose.activity.window.decorView
            assertTrue(view.width > 0 && view.height > 0)
            Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888).also { view.draw(Canvas(it)) }
        }
        val colors = mutableSetOf<Int>()
        for (x in 0 until image.width step 12) for (y in 0 until image.height step 12) colors.add(image.getPixel(x, y))
        assertTrue("Native frame must contain rendered content", colors.size > 8)
        val labeled = Bitmap.createBitmap(image.width, image.height + 40, Bitmap.Config.ARGB_8888)
        Canvas(labeled).apply {
            drawColor(Color.WHITE)
            drawBitmap(image, 0f, 0f, null)
            drawText("SYNTHETIC / NOT ONEPLUS DEVICE EVIDENCE", 8f, image.height + 26f,
                Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.BLACK; textSize = 14f })
        }
        val folder = File("build/outputs/ui-screenshots")
        assertTrue(folder.isDirectory || folder.mkdirs())
        File(folder, "$name.png").outputStream().use { assertTrue(labeled.compress(Bitmap.CompressFormat.PNG, 100, it)) }
    }
}
