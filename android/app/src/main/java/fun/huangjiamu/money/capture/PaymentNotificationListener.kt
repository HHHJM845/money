package `fun`.huangjiamu.money.capture

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import `fun`.huangjiamu.money.data.CaptureStore

class PaymentNotificationListener : NotificationListenerService() {
    private val store by lazy { CaptureStore(applicationContext) }

    override fun onListenerConnected() {
        super.onListenerConnected()
        store.setServiceState("notification", true)
    }

    override fun onListenerDisconnected() {
        store.setServiceState("notification", false)
        super.onListenerDisconnected()
    }

    override fun onDestroy() {
        store.setServiceState("notification", false)
        super.onDestroy()
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        val source = sbn?.packageName ?: return
        if (!CapturePolicy.allowed(source) || !store.enabled(source)) return
        val notification = sbn.notification
        // Never inspect chat messages, message bundles, or notification actions.
        if (notification.category == Notification.CATEGORY_MESSAGE ||
            notification.flags and Notification.FLAG_GROUP_SUMMARY != 0 ||
            notification.extras.containsKey(Notification.EXTRA_MESSAGES)) return
        val parts = listOf(Notification.EXTRA_TITLE, Notification.EXTRA_TEXT, Notification.EXTRA_BIG_TEXT)
            .mapNotNull { notification.extras.getCharSequence(it) }
        // Reject oversized fields rather than parsing a prefix that may omit a failure.
        if (parts.any { it.length > CapturePolicy.MAX_TEXT }) return
        val text = parts.map { it.toString() }.distinct().joinToString("\n")
        val receivedAt = System.currentTimeMillis()
        if (text.length > CapturePolicy.MAX_TEXT || PaymentParser.parse(source, text, receivedAt) == null) return
        if (!store.enabled(source)) return
        store.capture(source, CapturePolicy.notificationKey(sbn.key, sbn.postTime, text), text, receivedAt)
    }
}
