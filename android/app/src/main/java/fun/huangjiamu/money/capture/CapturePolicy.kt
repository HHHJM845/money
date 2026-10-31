package `fun`.huangjiamu.money.capture

import java.security.MessageDigest

internal object CapturePolicy {
    const val MAX_TEXT = 8192
    val packages: Set<String> = CaptureTargetRegistry.packageNames
    private val transactionId = Regex("(?:交易单号|交易号|订单号|流水号)[：:\\s]+([A-Za-z0-9_-]{8,80})(?=\\s|$)")

    fun allowed(source: String?): Boolean = source in packages
    fun digest(text: String): String = MessageDigest.getInstance("SHA-256")
        .digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    fun notificationKey(key: String, postTime: Long, text: String): String =
        "notification:${digest(key)}:$postTime:${digest(text)}"

    fun transactionId(text: String): String? = transactionId.find(text)?.groupValues?.get(1)

    // The service supplies a page-visit sequence, never the changing callback time.
    fun accessibilityKey(text: String, visitSequence: Long, session: String): String {
        val id = transactionId(text)
        return if (id != null) "accessibility:transaction:${digest(id)}"
        else "accessibility:$session:$visitSequence:${digest(text)}"
    }

    fun paymentPage(text: String): Boolean =
        Regex("(?:^|\\n)(?:支付成功|付款成功|收款成功|转账成功|退款成功|还款成功|交易详情|账单详情|支付详情|付款详情)(?:\\s|$)").containsMatchIn(text) && PaymentParser.parse(text) != null

    /** Unknown/hybrid host activities are intentionally unsupported until verified on device. */
    fun paymentWindow(source: String, className: String?): Boolean {
        if (!allowed(source) || className == null || messageView(className, null)) return false
        return when (source) {
            "com.tencent.mm" -> className in setOf(
                "com.tencent.mm.plugin.wallet.pay.ui.WalletPayUI",
                "com.tencent.mm.plugin.wallet_core.ui.WalletOrderInfoUI",
                "com.tencent.mm.plugin.wallet_core.ui.WalletOrderInfoNewUI",
                "com.tencent.mm.plugin.remittance.ui.RemittanceDetailUI"
            )
            "com.eg.android.AlipayGphone" -> className == "com.alipay.android.app.flybird.ui.window.FlyBirdWindowActivity"
            else -> false // Bank activity names require real-device evidence; notifications still work.
        }
    }

    fun messageView(className: String?, viewId: String?): Boolean =
        Regex("chatting|chat[_./]|messagebubble|message[_./]|conversation|msg_content", RegexOption.IGNORE_CASE)
            .containsMatchIn("${className.orEmpty()} ${viewId.orEmpty()}")

    fun childWindowEvent(className: String?): Boolean = className == null ||
        className.startsWith("android.widget.") || className.startsWith("android.view.") ||
        className.startsWith("android.webkit.") || className.startsWith("androidx.")
}

/** One candidate per visible visit without an ID, even when counters/layout text change. */
internal class PaymentPageVisit(private val session: String) {
    private var window: String? = null
    private var sequence = 0L
    private var captured = false
    private val transactionIds = HashSet<String>()

    fun window(source: String, windowId: Int, className: String) {
        val identity = "$source:$windowId:$className"
        if (window != identity) {
            leave()
            window = identity
        }
    }

    fun leave() {
        window = null
        sequence++
        captured = false
        transactionIds.clear()
    }

    fun candidate(text: String): String? {
        if (window == null || !CapturePolicy.paymentPage(text)) return null
        val id = CapturePolicy.transactionId(text)
        if (id == null && captured) return null
        if (id != null) {
            val firstId = transactionIds.isEmpty()
            if (!transactionIds.add(id)) return null
            // An ID appearing after the first render enriches that payment, not a new one.
            if (firstId && captured) return null
        }
        captured = true
        return CapturePolicy.accessibilityKey(text, sequence, session)
    }
}
