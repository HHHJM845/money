package `fun`.huangjiamu.money.capture

import java.math.BigDecimal

data class ParsedPayment(
    val amountCents: Long?,
    val type: String,
    val merchant: String?,
    val reason: String,
    val occurredAt: Long? = null,
    val receivedAt: Long? = null,
    val accountHint: String? = null,
    val sourcePackage: String? = null,
    val sourceTransactionId: String? = null,
    val sourceTransactionNamespace: String? = null,
    val ruleVersion: String = "synthetic-legacy-v1",
    val uncertainReasons: List<String> = listOf("unverified_rule", "missing_or_ambiguous_occurred_at",
        "missing_or_ambiguous_account_hint", "missing_or_ambiguous_source_identity"),
    val sourceIdentityCertain: Boolean = false
) {
    /** No real-device verified rules exist yet, including when all fields are populated. */
    val canAutoPost: Boolean get() = false
}

/** Only explicit completed transactions become candidates; this never creates ledger entries. */
object PaymentParser {
    private val rejected = Regex("验证码|动态口令|密码|口令|OTP|PASSWORD|聊天|待支付|待付款|等待|处理中|申请中|未成功|不成功|失败|取消|撤销|关闭|美元|美金|港币|港元|日元|欧元|英镑|外币|USD|HKD|EUR|JPY|GBP|SGD|AUD|CAD|KRW|[?？$€£₹₩฿]", RegexOption.IGNORE_CASE)
    private val bankExpense = Regex("(?:您|您的).*?(?:账户|卡|尾号).*?(?:消费|支出|扣款)(?:人民币|CNY|金额|[：:\\s])*[0-9]", RegexOption.IGNORE_CASE)
    private val amount = Regex("(?:实付金额|实际支付|付款金额|支付金额|消费金额|支出金额|扣款金额|收款金额|到账金额|退款金额|转账金额|还款金额|实付|消费|支出|扣款|收款|到账|退款|转账|还款|支付|付款)(?:成功)?[：:\\s]*(?:人民币|CNY)?[：:\\s]*[¥￥]?[\\s]*([+-]?[0-9][0-9,]*(?:\\.[0-9]+)?)(?:[\\s]*(?:元|人民币))?", RegexOption.IGNORE_CASE)
    private val merchant = Regex("(?:^|\\n)(?:商户|商家|收款方|交易对方)[：:]\\s*([^\\n]{1,80})")

    /** Local-only bounded adapters; callers retain transport identity separately. */
    fun parse(source: String, text: String, receivedAt: Long): ParsedPayment? =
        CaptureTargetRegistry.find(source)?.let { target ->
            if (!eligible(text)) null else LabeledPaymentAdapter.parse(target, text, receivedAt)
        }

    internal fun eligible(text: String): Boolean =
        text.isNotBlank() && text.length <= CapturePolicy.MAX_TEXT && !rejected.containsMatchIn(text)

    fun parse(text: String): ParsedPayment? {
        if (!eligible(text)) return null
        val refund = text.contains("退款成功") || text.contains("退款到账") || text.contains("已退款")
        val transfer = text.contains("转账成功") || text.contains("还款成功")
        val income = text.contains("收款成功") || text.contains("收款到账") || text.contains("收入到账")
        val expense = text.contains("支付成功") || text.contains("付款成功") || text.contains("消费成功") || bankExpense.containsMatchIn(text)
        if (!refund && !transfer && !income && !expense) return null
        val type = when {
            refund -> "refund"
            transfer -> "transfer"
            income && expense -> "unknown"
            income -> "income"
            expense -> "expense"
            else -> "unknown"
        }
        val matches = amount.findAll(text).map { cents(it.groupValues[1]) }.toList()
        val values = matches.filterNotNull().distinct()
        val value = if (matches.isNotEmpty() && matches.none { it == null } && values.size == 1) values.single() else null
        return ParsedPayment(value, type, merchant.find(text)?.groupValues?.get(1)?.trim(), when {
            type == "unknown" -> "收支方向不明确，请核对"
            value == null -> "已识别完成提示，交易金额缺失或有歧义，请核对"
            type == "transfer" || type == "refund" -> "转账、还款或退款需关联原记录，请核对"
            else -> "识别到完成提示，待核对账户及分类"
        })
    }

    private fun cents(raw: String): Long? {
        if (!Regex("(?:[0-9]+|[1-9][0-9]{0,2}(?:,[0-9]{3})+)(?:\\.[0-9]{1,2})?").matches(raw)) return null
        return try {
            BigDecimal(raw.replace(",", "")).movePointRight(2).longValueExact()
                .takeIf { it in 1..MAX_SAFE_CENTS }
        } catch (_: ArithmeticException) { null } catch (_: NumberFormatException) { null }
    }

    internal const val MAX_SAFE_CENTS = 9007199254740991L

    internal fun labeledCents(raw: String): Long? {
        val value = Regex("(?:人民币|CNY)?\\s*[¥￥]?\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*(?:元|人民币)?",
            RegexOption.IGNORE_CASE).matchEntire(raw)?.groupValues?.get(1) ?: return null
        return cents(value)
    }
}
