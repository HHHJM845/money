package `fun`.huangjiamu.money.capture

import org.junit.Assert.*
import org.junit.Test

class CapturePolicyTest {
    @Test fun acceptsOnlyNamedSources() {
        assertTrue(CapturePolicy.allowed("cmb.pb"))
        assertFalse(CapturePolicy.allowed("com.tencent.mm.fake"))
        assertFalse(CapturePolicy.allowed(null))
    }

    @Test fun notificationIdentityIncludesTimeAndContents() {
        val first = CapturePolicy.notificationKey("key", 1, "支付成功10元")
        assertEquals(first, CapturePolicy.notificationKey("key", 1, "支付成功10元"))
        assertNotEquals(first, CapturePolicy.notificationKey("key", 2, "支付成功10元"))
        assertNotEquals(first, CapturePolicy.notificationKey("key", 1, "支付成功20元"))
    }

    @Test fun accessibilityIdentityUsesVisitSequenceOrTransactionId() {
        val text = "支付成功\n付款金额10元"
        assertNotEquals(CapturePolicy.accessibilityKey(text, 1, "session"), CapturePolicy.accessibilityKey(text, 2, "session"))
        assertEquals(CapturePolicy.accessibilityKey(text, 1, "session"), CapturePolicy.accessibilityKey(text, 1, "session"))
        assertEquals(CapturePolicy.accessibilityKey("$text\n交易单号：20261029000123456789", 1, "session"),
            CapturePolicy.accessibilityKey("$text\n交易单号：20261029000123456789", 2, "other-session"))
    }

    @Test fun gatesAccessibilityPages() {
        assertFalse(CapturePolicy.paymentPage("聊天\n付款金额10元"))
        assertTrue(CapturePolicy.paymentPage("支付成功\n付款金额10元"))
        assertFalse(CapturePolicy.paymentPage("交易详情\n等待支付"))
    }

    @Test fun rejectsChatAndUnverifiedGenericWindows() {
        assertFalse(CapturePolicy.paymentWindow("com.tencent.mm", "com.tencent.mm.ui.chatting.ChattingUI"))
        assertFalse(CapturePolicy.paymentWindow("com.tencent.mm", "com.tencent.mm.ui.LauncherUI"))
        assertFalse(CapturePolicy.paymentWindow("com.eg.android.AlipayGphone", "com.alipay.mobile.nebulax.integration.mpaas.activity.H5Activity"))
        assertTrue(CapturePolicy.paymentWindow("com.tencent.mm", "com.tencent.mm.plugin.wallet.pay.ui.WalletPayUI"))
        assertTrue(CapturePolicy.messageView("android.widget.TextView", "com.tencent.mm:id/chatting_content_itv"))
        assertTrue(CapturePolicy.messageView("com.example.MessageBubble", null))
        assertFalse(CapturePolicy.messageView("android.widget.TextView", "com.tencent.mm:id/pay_amount"))
        assertTrue(CapturePolicy.childWindowEvent("android.widget.FrameLayout"))
        assertFalse(CapturePolicy.childWindowEvent("com.tencent.mm.ui.chatting.ChattingUI"))
        val pasted = "支付成功\n付款金额10元"
        assertTrue(CapturePolicy.paymentPage(pasted))
        assertFalse(CapturePolicy.paymentWindow("com.tencent.mm", "com.tencent.mm.ui.chatting.ChattingUI") && CapturePolicy.paymentPage(pasted))
    }

    @Test fun samePageOnlyCapturesOnceRegardlessOfCallbackTimeOrTextNoise() {
        val visit = PaymentPageVisit("test")
        visit.window("com.tencent.mm", 42, "wallet")
        assertNotNull(visit.candidate("支付成功\n付款金额10元"))
        repeat(100) { assertNull(visit.candidate("支付成功\n付款金额10元\n倒计时$it")) }
        visit.window("com.tencent.mm", 42, "wallet")
        assertNull(visit.candidate("支付成功\n付款金额10元"))
    }

    @Test fun identicalPaymentAfterLeavingIsASeparateCandidate() {
        val visit = PaymentPageVisit("test")
        visit.window("com.tencent.mm", 42, "wallet")
        val first = visit.candidate("支付成功\n付款金额10元")
        visit.leave()
        visit.window("com.tencent.mm", 42, "wallet")
        assertNotEquals(first, visit.candidate("支付成功\n付款金额10元"))
    }

    @Test fun actualWindowChangeAndNewTransactionIdCanStartNewPayment() {
        val visit = PaymentPageVisit("test")
        visit.window("com.tencent.mm", 42, "wallet")
        val first = visit.candidate("支付成功\n付款金额10元")
        visit.window("com.tencent.mm", 43, "wallet")
        assertNotEquals(first, visit.candidate("支付成功\n付款金额10元"))
        val withId = "支付成功\n付款金额10元\n交易单号：202610290001"
        assertNull(visit.candidate(withId))
        assertNull(visit.candidate(withId))
        assertNotNull(visit.candidate(withId.replace("0001", "0002")))
    }

    @Test fun incompleteRenderDoesNotConsumeVisitAndKnownIdStaysStableOnRevisit() {
        val visit = PaymentPageVisit("test")
        val text = "支付成功\n付款金额10元\n交易单号：202610290001"
        assertNull(visit.candidate(text))
        visit.window("com.tencent.mm", 42, "wallet")
        assertNull(visit.candidate("加载中"))
        val first = visit.candidate(text)
        assertNotNull(first)
        assertNull(visit.candidate("加载中"))
        assertNull(visit.candidate(text))
        visit.leave()
        visit.window("com.tencent.mm", 42, "wallet")
        assertEquals(first, visit.candidate(text))
    }
}
