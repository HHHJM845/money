package `fun`.huangjiamu.money.capture

import org.junit.Assert.*
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId

/** Invented local schemas, never recordings from these apps. */
class PaymentAdaptersTest {
    private val receivedAt = 1793347200000L
    private val packages = listOf(
        "com.tencent.mm", "com.eg.android.AlipayGphone", "cmb.pb", "com.cmbchina.ccd.pluto.cmbActivity",
        "com.unionpay", "com.taobao.taobao", "com.jingdong.app.mall",
        "com.xunmeng.pinduoduo", "com.sankuai.meituan"
    )
    private fun fixture(amount: String = "29.90", id: String = "SYNTHETIC0001") =
        "支付成功\n实付金额：${amount}元\n交易时间：2026-10-30 12:00:00\n" +
            "付款账户：招商银行尾号1234\n商户：合成测试店\n交易单号：$id"

    @Test fun registryContainsNineTargetsButNoVerifiedRules() {
        assertEquals(packages.toSet(), CaptureTargetRegistry.packageNames)
        assertEquals(9, CaptureTargetRegistry.targets.size)
        assertEquals("掌上生活", CaptureTargetRegistry.find("com.cmbchina.ccd.pluto.cmbActivity")!!.displayName)
        assertNull(CaptureTargetRegistry.find("com.cmbchina.ccd.pluto"))
        assertFalse(CapturePolicy.allowed("com.cmbchina.ccd.pluto"))
        assertNull(PaymentParser.parse("com.cmbchina.ccd.pluto", fixture(), receivedAt))
        CaptureTargetRegistry.targets.forEach {
            assertFalse(it.ruleVerified)
            assertTrue(CapturePolicy.allowed(it.packageName))
        }
    }

    @Test fun nineLabeledFixturesProduceStructuredPendingCandidates() {
        packages.forEach { source ->
            val result = PaymentParser.parse(source, fixture(), receivedAt)!!
            assertEquals(source, result.sourcePackage)
            assertEquals(2990L, result.amountCents)
            assertEquals("expense", result.type)
            assertEquals("合成测试店", result.merchant)
            assertEquals("招商银行:1234", result.accountHint)
            assertEquals(receivedAt, result.receivedAt)
            assertEquals(LocalDateTime.of(2026, 10, 30, 12, 0)
                .atZone(ZoneId.of("Asia/Shanghai")).toInstant().toEpochMilli(), result.occurredAt)
            assertTrue(result.ruleVersion.startsWith("synthetic-"))
            assertTrue(result.uncertainReasons.contains("unverified_rule"))
            assertTrue(result.uncertainReasons.contains("account_mapping_required"))
            assertFalse(result.canAutoPost)
            assertFalse(result.sourceIdentityCertain)
            assertNotNull(result.sourceTransactionId)
            assertFalse(result.sourceTransactionId!!.contains("SYNTHETIC0001"))
        }
    }

    @Test fun nineTargetsRejectFailureCancellationCredentialsForeignAndChat() {
        packages.forEach { source ->
            listOf("支付失败", "交易已取消", "已撤销", "待付款", "验证码123456",
                "OTP 123456", "请输入支付密码", "USD 20", "JPY 20", "£20", "聊天记录").forEach {
                assertNull("$source / $it", PaymentParser.parse(source, fixture() + "\n$it", receivedAt))
            }
            assertNull(PaymentParser.parse(source, "张三：支付成功\n付款金额10元", receivedAt))
            assertNull(PaymentParser.parse(source, "支付成功\n" + "x".repeat(CapturePolicy.MAX_TEXT), receivedAt))
        }
        assertNull(PaymentParser.parse("com.tencent.mm.fake", fixture(), receivedAt))
    }

    @Test fun actualPaidWinsOnlyForExplicitSyntheticLabelAndOriginalAloneIsUnresolved() {
        packages.forEach { source ->
            assertEquals(2990L, PaymentParser.parse(source,
                fixture() + "\n订单金额：59.90元\n原价：69.90元", receivedAt)!!.amountCents)
            assertNull(PaymentParser.parse(source, "支付成功\n订单金额：59.90元", receivedAt)!!.amountCents)
            assertNull(PaymentParser.parse(source,
                fixture() + "\n实际支付：30.00元", receivedAt)!!.amountCents)
            assertNull(PaymentParser.parse(source,
                "支付成功\n付款金额：59.90元\n原价：69.90元", receivedAt)!!.amountCents)
        }
    }

    @Test fun absentAmbiguousInvalidOrFutureTimeNeverBecomesReceivedTime() {
        listOf("", "交易时间：今天12:00", "交易时间：2026-02-30 12:00:00",
            "交易时间：2099-10-30 12:00:00", "交易时间：2026-10-30 12:00:00\n支付时间：2026-10-29 12:00:00"
        ).forEach {
            val result = PaymentParser.parse(packages.first(), "支付成功\n实付金额：10元\n$it", receivedAt)!!
            assertNull(it, result.occurredAt)
            assertTrue(result.uncertainReasons.contains("missing_or_ambiguous_occurred_at"))
            assertEquals(receivedAt, result.receivedAt)
        }
    }

    @Test fun fundingHintIsOnlyExplicitBankTailNeverChannelOrFullCard() {
        listOf("支付方式：微信支付", "支付方式：支付宝", "付款账户：招商银行",
            "付款账户：招商银行6225888888881234", "付款账户：尾号1234",
            "收款账户：招商银行尾号1234", "付款账户：招商银行尾号12345",
            "付款账户：招商银行尾号1234\n付款账户：建设银行尾号5678").forEach {
            val result = PaymentParser.parse(packages.first(), "支付成功\n实付金额：10元\n$it", receivedAt)!!
            assertNull(it, result.accountHint)
            assertTrue(result.uncertainReasons.contains("missing_or_ambiguous_account_hint"))
        }
    }

    @Test fun notificationAndPageIdsAreUnverifiedAndPackageScoped() {
        val text = fixture()
        val notification = PaymentParser.parse(packages.first(), text, receivedAt)!!
        val page = PaymentParser.parse(packages.first(), text, receivedAt + 1)!!
        assertEquals(notification.sourceTransactionId, page.sourceTransactionId)
        assertEquals(notification.sourceTransactionNamespace, page.sourceTransactionNamespace)
        assertFalse(notification.sourceIdentityCertain)
        assertNotEquals(notification.sourceTransactionNamespace,
            PaymentParser.parse(packages[1], text, receivedAt)!!.sourceTransactionNamespace)
        assertNull(PaymentParser.parse(packages.first(),
            text.replace("交易单号", "订单号"), receivedAt)!!.sourceTransactionId)
        assertNull(PaymentParser.parse(packages.first(),
            text + "\n交易单号：SYNTHETIC0002", receivedAt)!!.sourceTransactionId)
    }

    @Test fun sameAmountAndTimeTwoTradesHaveDifferentIdsAndNoIdIsNotDuplicateProof() {
        val first = PaymentParser.parse(packages.first(), fixture(), receivedAt)!!
        val second = PaymentParser.parse(packages.first(), fixture(id = "SYNTHETIC0002"), receivedAt)!!
        assertNotEquals(first.sourceTransactionId, second.sourceTransactionId)
        val noId = PaymentParser.parse(packages.first(), "支付成功\n实付金额：29.90元", receivedAt)!!
        assertNull(noId.sourceTransactionId)
        assertFalse(noId.sourceIdentityCertain)
    }

    @Test fun refundsStayPendingWithoutOriginalLinkAndDoNotReuseExpenseAccount() {
        packages.forEach { source ->
            val result = PaymentParser.parse(source,
                fixture().replace("支付成功", "退款成功").replace("实付金额", "退款金额"), receivedAt)!!
            assertEquals("refund", result.type)
            assertEquals(2990L, result.amountCents)
            assertNull(result.accountHint)
            assertTrue(result.uncertainReasons.contains("refund_link_required"))
            assertFalse(result.canAutoPost)
        }
    }

    @Test fun explicitIncomeAndTransferAreStructuredButNeverPosted() {
        packages.forEach { source ->
            val income = PaymentParser.parse(source,
                "收款成功\n到账金额：10.29元\n到账账户：招商银行尾号1234", receivedAt)!!
            assertEquals("income", income.type)
            assertEquals(1029L, income.amountCents)
            assertEquals("招商银行:1234", income.accountHint)
            val transfer = PaymentParser.parse(source, "还款成功\n还款金额：10元", receivedAt)!!
            assertEquals("transfer", transfer.type)
            assertTrue(transfer.uncertainReasons.contains("transfer_accounts_required"))
            assertNull(transfer.accountHint)
            assertFalse(transfer.canAutoPost)
        }
    }

    @Test fun bankSentenceRemainsPendingAndDoesNotGuessSourceAppAsFundingAccount() {
        listOf("cmb.pb", "com.cmbchina.ccd.pluto.cmbActivity").forEach { source ->
            val bank = PaymentParser.parse(source,
                "您尾号1234账户消费人民币29.00元，余额1000.00元", receivedAt)!!
            assertEquals(2900L, bank.amountCents)
            assertNull(bank.accountHint)
            assertNull(bank.occurredAt)
            assertFalse(bank.canAutoPost)
        }
        assertNull(PaymentParser.parse(packages.first(),
            "您尾号1234账户消费人民币29.00元，余额1000.00元", receivedAt))
    }

    @Test fun centsRespectPrecisionAndJavascriptSafeIntegerBoundary() {
        packages.forEach { source ->
            assertEquals(9007199254740991L, PaymentParser.parse(source,
                fixture(amount = "90071992547409.91"), receivedAt)!!.amountCents)
            listOf("90071992547409.92", "1.001", "-1.00", "0", "+10", "1,23.00",
                "9999999999999999999999999999", "29.90abc", "1e3").forEach {
                assertNull("$source/$it", PaymentParser.parse(source, fixture(amount = it), receivedAt)!!.amountCents)
            }
        }
        assertNull(PaymentParser.parse("支付成功\n付款金额90071992547409.92元")!!.amountCents)
    }

    @Test fun legacyConstructorAndParseRemainAvailableAndPending() {
        val legacy = ParsedPayment(100L, "expense", null, "待核对")
        assertNull(legacy.occurredAt)
        assertFalse(legacy.canAutoPost)
        assertEquals(100L, PaymentParser.parse("支付成功\n付款金额1元")!!.amountCents)
        assertNull(PaymentParser.parse("支付成功\n请输入支付密码\n付款金额1元"))
    }
}
