package `fun`.huangjiamu.money.capture

import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.time.format.ResolverStyle

/**
 * Shared invented label schema bound to a distinct rule version for each target.
 * It is intentionally narrower than real app screens; no activity IDs come from this schema.
 */
internal object LabeledPaymentAdapter {
    private val field = Regex("^([^：:\\n]{1,24})[：:]\\s*(.*)$")
    private val completed = Regex("^(支付成功|付款成功|消费成功|收款成功|收款到账|收入到账|退款成功|退款到账|已退款|转账成功|还款成功)[，,。]?$")
    private val actual = setOf("实付金额", "实际支付", "实付")
    private val expense = setOf("付款金额", "支付金额", "消费金额", "支出金额", "扣款金额")
    private val original = setOf("原价", "原金额", "订单金额", "商品金额", "交易金额", "应付金额")
    private val transactionLabels = setOf("交易单号", "交易号", "流水号")
    private val dateFormat = DateTimeFormatter.ofPattern("uuuu-MM-dd HH:mm:ss")
        .withResolverStyle(ResolverStyle.STRICT)
    private val bankTail = Regex(
        "(中国工商银行|中国农业银行|中国银行|中国建设银行|交通银行|招商银行|中信银行|中国光大银行|" +
            "华夏银行|中国民生银行|广发银行|平安银行|兴业银行|浦发银行|中国邮政储蓄银行|建设银行)" +
            "(?:储蓄卡|借记卡|信用卡)?\\s*[（(]?尾号\\s*([0-9]{4})[）)]?"
    )

    fun parse(target: CaptureTarget, text: String, receivedAt: Long): ParsedPayment? {
        val lines = text.lines().map { it.trim() }.filter { it.isNotEmpty() }
        val statuses = lines.filter { completed.matches(it) }.map { it.trimEnd('，', ',', '。') }
        // No unanchored "success" substring in a chat, order description or advertisement.
        if (statuses.isEmpty()) return bankNotice(target, text, receivedAt)
        val fields = lines.mapNotNull { line ->
            field.matchEntire(line)?.let { it.groupValues[1].trim() to it.groupValues[2].trim() }
        }
        val types = statuses.map {
            when (it) {
                "收款成功", "收款到账", "收入到账" -> "income"
                "退款成功", "退款到账", "已退款" -> "refund"
                "转账成功", "还款成功" -> "transfer"
                else -> "expense"
            }
        }.distinct()
        val type = types.singleOrNull() ?: "unknown"
        val amountLabels = when (type) {
            "income" -> setOf("收款金额", "到账金额", "收入金额")
            "refund" -> setOf("退款金额", "退款到账金额")
            "transfer" -> setOf("转账金额", "还款金额")
            else -> expense
        }
        val actualFields = fields.filter { it.first in actual }
        val amountFields = when {
            type == "expense" && actualFields.isNotEmpty() -> actualFields
            type == "expense" && fields.any { it.first in original } -> emptyList()
            else -> fields.filter { it.first in amountLabels }
        }
        val amounts = amountFields.map { PaymentParser.labeledCents(it.second) }
        val amount = amounts.takeIf { it.isNotEmpty() && it.none { value -> value == null } }
            ?.distinct()?.singleOrNull()
        val occurredAt = occurrence(fields, receivedAt)
        val hint = fundingHint(fields, type)
        val identities = fields.filter { it.first in transactionLabels }
        // A merchant order ID or an original-refund reference is not a payment identity.
        val identity = identities.distinct().singleOrNull()?.takeIf {
            Regex("[A-Za-z0-9_-]{8,80}").matches(it.second)
        }
        val merchantValues = fields.filter { it.first in setOf("商户", "商家", "收款方", "交易对方") }
            .map { it.second }.distinct()
        val merchant = merchantValues.singleOrNull()?.takeIf {
            it.length in 1..80 && !Regex("[0-9]{12,}").containsMatchIn(it)
        }
        val reasons = mutableListOf("unverified_rule")
        if (amount == null) reasons += "missing_or_ambiguous_amount"
        if (type == "unknown") reasons += "ambiguous_direction"
        if (occurredAt == null) reasons += "missing_or_ambiguous_occurred_at"
        reasons += if (hint == null) "missing_or_ambiguous_account_hint" else "account_mapping_required"
        reasons += if (identity == null) "missing_or_ambiguous_source_identity" else "unverified_source_identity"
        if (type == "refund") reasons += "refund_link_required"
        if (type == "transfer") reasons += "transfer_accounts_required"
        return ParsedPayment(
            amount, type, merchant, "合成规则尚未经真机验证，请核对金额、日期、实际账户和来源",
            occurredAt = occurredAt, receivedAt = receivedAt, accountHint = hint,
            sourcePackage = target.packageName,
            sourceTransactionId = identity?.let { CapturePolicy.digest(it.second) },
            sourceTransactionNamespace = identity?.let { "${target.packageName}:${target.ruleVersion}:${it.first}" },
            ruleVersion = target.ruleVersion, uncertainReasons = reasons
        )
    }

    private fun occurrence(fields: List<Pair<String, String>>, receivedAt: Long): Long? {
        val times = fields.filter { it.first in setOf("交易时间", "支付时间", "付款时间", "到账时间") }
            .map { it.second }.distinct()
        val raw = times.singleOrNull() ?: return null
        if (!Regex("[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}").matches(raw)) return null
        return try {
            LocalDateTime.parse(raw, dateFormat).atZone(ZoneId.of("Asia/Shanghai"))
                .toInstant().toEpochMilli().takeIf { it > 0 && it <= receivedAt }
        } catch (_: DateTimeParseException) { null }
    }

    private fun fundingHint(fields: List<Pair<String, String>>, type: String): String? {
        val labels = when (type) {
            "expense" -> setOf("付款账户", "扣款账户", "支付方式", "付款方式")
            "income" -> setOf("收款账户", "到账账户")
            "refund" -> setOf("退款到账账户", "退款账户", "退回账户")
            else -> emptySet()
        }
        val values = fields.filter { it.first in labels }.map { it.second }.distinct()
        val value = values.singleOrNull() ?: return null
        val match = bankTail.matchEntire(value) ?: return null
        return "${match.groupValues[1]}:${match.groupValues[2]}"
    }

    private fun bankNotice(target: CaptureTarget, text: String, receivedAt: Long): ParsedPayment? {
        if (target.packageName !in setOf("cmb.pb", "com.cmbchina.ccd.pluto.cmbActivity")) return null
        // Legacy bank sentence remains pending: no inferred bank, occurrence or transaction ID.
        if (!Regex("^您(?:的)?(?:尾号|账户|卡)").containsMatchIn(text)) return null
        val legacy = PaymentParser.parse(text) ?: return null
        val reasons = mutableListOf("unverified_rule", "missing_or_ambiguous_occurred_at",
            "missing_or_ambiguous_account_hint", "missing_or_ambiguous_source_identity")
        if (legacy.amountCents == null) reasons += "missing_or_ambiguous_amount"
        if (legacy.type == "unknown") reasons += "ambiguous_direction"
        if (legacy.type == "refund") reasons += "refund_link_required"
        if (legacy.type == "transfer") reasons += "transfer_accounts_required"
        return legacy.copy(
            receivedAt = receivedAt, sourcePackage = target.packageName, ruleVersion = target.ruleVersion,
            uncertainReasons = reasons
        )
    }
}
