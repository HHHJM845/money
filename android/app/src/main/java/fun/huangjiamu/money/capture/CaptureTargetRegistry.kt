package `fun`.huangjiamu.money.capture

data class CaptureTarget(
    val packageName: String,
    val displayName: String,
    val ruleVersion: String,
    val ruleVerified: Boolean = false
)

/** Target scope only. Neither package membership nor synthetic parsing proves app support. */
object CaptureTargetRegistry {
    val targets: List<CaptureTarget> = listOf(
        CaptureTarget("com.tencent.mm", "微信", "synthetic-wechat-labeled-v1"),
        CaptureTarget("com.eg.android.AlipayGphone", "支付宝", "synthetic-alipay-labeled-v1"),
        CaptureTarget("cmb.pb", "招商银行", "synthetic-cmb-labeled-v1"),
        CaptureTarget("com.cmbchina.ccd.pluto.cmbActivity", "掌上生活", "synthetic-cmb-life-labeled-v1"),
        CaptureTarget("com.unionpay", "云闪付", "synthetic-unionpay-labeled-v1"),
        CaptureTarget("com.taobao.taobao", "淘宝", "synthetic-taobao-labeled-v1"),
        CaptureTarget("com.jingdong.app.mall", "京东", "synthetic-jd-labeled-v1"),
        CaptureTarget("com.xunmeng.pinduoduo", "拼多多", "synthetic-pdd-labeled-v1"),
        CaptureTarget("com.sankuai.meituan", "美团", "synthetic-meituan-labeled-v1")
    )
    val packageNames: Set<String> = targets.map { it.packageName }.toSet()
    private val byPackage = targets.associateBy { it.packageName }

    fun find(packageName: String): CaptureTarget? = byPackage[packageName]
}
