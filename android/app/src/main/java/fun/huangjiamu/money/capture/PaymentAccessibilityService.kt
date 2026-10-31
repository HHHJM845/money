package `fun`.huangjiamu.money.capture

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import `fun`.huangjiamu.money.data.CaptureStore
import java.util.UUID

class PaymentAccessibilityService : AccessibilityService() {
    private val store by lazy { CaptureStore(applicationContext) }
    private val visit = PaymentPageVisit(UUID.randomUUID().toString())
    private var activeSource: String? = null
    private var activeClass: String? = null
    private var activeWindow = -1

    override fun onServiceConnected() {
        super.onServiceConnected()
        serviceInfo = serviceInfo.apply {
            // Outside-app window metadata lets us detect leaving a payment. No node
            // content is accessed unless the package, opt-in and activity gates pass.
            packageNames = null
            eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
            feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
            notificationTimeout = 0 // No time bucketing that could swallow genuine payments.
            flags = flags or AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
        }
        store.setServiceState("accessibility", true)
    }

    override fun onInterrupt() { leavePage(); store.setServiceState("accessibility", false) }

    override fun onDestroy() {
        leavePage()
        store.setServiceState("accessibility", false)
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val source = event?.packageName?.toString() ?: return
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            event.eventType != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) return
        if (!CapturePolicy.allowed(source) || !store.enabled(source)) {
            if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) leavePage()
            return
        }
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            val className = event.className?.toString()
            // Widgets may emit WINDOW_STATE_CHANGED without any activity navigation.
            // Do not reset a captured visit for those callbacks in the same window.
            if (activeSource == source && activeWindow == event.windowId &&
                CapturePolicy.childWindowEvent(className)) return
            if (!CapturePolicy.paymentWindow(source, className)) { leavePage(); return }
            activeSource = source
            activeClass = className
            activeWindow = event.windowId
            visit.window(source, activeWindow, className!!)
        }
        if (activeSource != source || activeWindow != event.windowId ||
            !CapturePolicy.paymentWindow(source, activeClass)) return
        val root = rootInActiveWindow ?: return
        val text = try {
            if (root.packageName?.toString() != source || root.windowId != activeWindow) return
            readBoundedText(root) ?: return
        } finally { recycle(root) }
        // Inspect only bounded visible text to identify an eligible page. Never retain
        // or forward anything from non-payment pages; no screenshots or UI actions.
        if (!CapturePolicy.paymentPage(text) || !store.enabled(source)) return
        val key = visit.candidate(text) ?: return
        store.capture(source, key, text, System.currentTimeMillis())
        store.setServiceState("accessibility", true)
    }

    private fun leavePage() {
        visit.leave()
        activeSource = null
        activeClass = null
        activeWindow = -1
    }

    private fun readBoundedText(root: AccessibilityNodeInfo): String? {
        val result = StringBuilder()
        var visited = 0
        var incomplete = false
        fun visit(node: AccessibilityNodeInfo, depth: Int) {
            if (++visited > 160 || depth > 16 || result.length >= CapturePolicy.MAX_TEXT) {
                incomplete = true
                return
            }
            if (!node.isVisibleToUser) return
            // Chat and credential-entry screens must never become payment candidates.
            if (node.isPassword || node.isEditable ||
                CapturePolicy.messageView(node.className?.toString(), node.viewIdResourceName)) {
                incomplete = true
                return
            }
            node.text?.let { text ->
                val remaining = CapturePolicy.MAX_TEXT - result.length - 1
                if (text.length > remaining) incomplete = true
                else result.append(text).append('\n')
            }
            if (node.childCount > 80) incomplete = true
            for (index in 0 until minOf(node.childCount, 80)) {
                if (visited >= 160 || result.length >= CapturePolicy.MAX_TEXT) { incomplete = true; break }
                val child = node.getChild(index) ?: continue
                try { visit(child, depth + 1) } finally { recycle(child) }
            }
        }
        visit(root, 0)
        return if (incomplete) null else result.toString().trim()
    }

    @Suppress("DEPRECATION")
    private fun recycle(node: AccessibilityNodeInfo) { node.recycle() }
}
