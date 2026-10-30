package `fun`.huangjiamu.money.capture

import org.junit.Assert.*
import org.junit.Test

class PaymentParserTest {
    @Test fun parsesDecimalWithoutFloatingPoint() {
        val payment = PaymentParser.parse("支付成功\n付款金额：¥0.29\n商户：街角便利店")!!
        assertEquals(29L, payment.amountCents)
        assertEquals("expense", payment.type)
        assertEquals("街角便利店", payment.merchant)
    }

    @Test fun recognizesExplicitIncomeRefundAndTransfer() {
        assertEquals("income", PaymentParser.parse("收款成功，收款金额：100.00元")!!.type)
        assertEquals("refund", PaymentParser.parse("退款成功，退款金额：29.90元")!!.type)
        assertEquals("transfer", PaymentParser.parse("转账成功，转账金额：200.00元")!!.type)
        assertEquals("transfer", PaymentParser.parse("还款成功，还款金额：200.00元")!!.type)
    }

    @Test fun doesNotTreatBalanceOrDiscountAsPayment() {
        assertNull(PaymentParser.parse("支付成功\n账户余额：999.00元")!!.amountCents)
        assertNull(PaymentParser.parse("支付成功\n优惠：10.00元")!!.amountCents)
        assertEquals(2900L, PaymentParser.parse("支付成功\n实付金额：29.00元\n余额：999.00元")!!.amountCents)
    }

    @Test fun rejectsMessagesWithoutConfirmedPayment() {
        listOf("验证码123456，支付金额100元", "等待付款 ¥20.00", "支付失败 ¥20.00",
            "支付成功了吗？", "张三：你好", "账户余额999元", "退款处理中，金额10元",
            "支付成功\n验证码1234", "支付成功\n交易已撤销", "支付成功\n付款金额：20美元"
        ).forEach { assertNull(it, PaymentParser.parse(it)) }
    }

    @Test fun ambiguousOrInvalidAmountsStayUnresolved() {
        listOf("支付成功\n付款金额：1.001元", "支付成功\n付款金额：-20元",
            "支付成功\n付款金额：999999999999999999999元",
            "支付成功\n付款金额：10元\n支付金额：20元"
        ).forEach { assertNull(it, PaymentParser.parse(it)!!.amountCents) }
        assertEquals(123456L, PaymentParser.parse("支付成功\n付款金额：1,234.56元")!!.amountCents)
    }

    @Test fun recognizesBankConfirmationButNotCreditLimit() {
        assertEquals(2900L, PaymentParser.parse("您尾号1234账户消费人民币29.00元，余额1000.00元")!!.amountCents)
        assertNull(PaymentParser.parse("您的信用卡可用额度人民币10000.00元"))
    }
}
