package `fun`.huangjiamu.money.ui

import android.app.Application
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import `fun`.huangjiamu.money.data.*
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.*
import org.json.JSONObject
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class, qualifiers = "w412dp-h915dp")
class LedgerUiTest {
    @get:Rule val compose = createComposeRule()

    private val metadata = Metadata(
        accounts = listOf(AccountView("1", "现金", null, "1", "CNY")),
        categories = listOf(CategoryView("2", "餐饮", 2, null, true)),
        tags = listOf(TagView("3", "午餐", true)),
    )

    private fun bill(id: String = "a", status: String = "posted", amount: Long = 2500, kind: String = "expense") =
        BillView(id, 1, status, BillContent(kind = kind, amountCents = amount, accountId = "1", categoryId = "2",
            merchant = "午餐店", occurredAt = parseDateTime("2026-10-30 12:30")), "apply", "synced", "",
            emptyList(), null, parseDateTime("2026-10-30 12:31"), parseDateTime("2026-10-30 12:31"), null)

    private fun actions() = LedgerActions(
        save = { _, _, _ -> }, delete = {}, restore = {}, resolve = { _, _, _ -> }, retry = {},
        synchronize = { true }, login = { _, _ -> }, logout = {},
        request = { _, _ -> org.json.JSONObject() }, balanceHistory = { emptyList() }, billHistory = { emptyList() },
        permission = {}, toggleSource = { _, _ -> },
    )

    @Test fun bottomNavigationOpensThreeNativePages() {
        compose.setContent { MoneyTheme { MoneyApp(LedgerState(listOf(bill()), metadata), actions()) } }
        compose.onNodeWithTag("nav-0").assertIsSelected()
        compose.onNodeWithTag("nav-1").performClick().assertIsSelected()
        compose.onNodeWithText("退款（到账月）").assertExists()
        compose.onNodeWithTag("nav-2").performClick().assertIsSelected()
        compose.onNodeWithText("云端同步").assertExists()
        compose.onNodeWithTag("nav-0").performClick().assertIsSelected()
        compose.onNodeWithTag("bill-search").assertExists()
    }

    @Test fun accountCreationKeepsDraftAndSelectsConfirmedAccount() {
        var saved: BillContent? = null
        val liveMetadata = mutableStateOf(metadata.copy(accounts = emptyList()))
        val creation = actions().copy(synchronize = {
            liveMetadata.value = metadata.copy(accounts = listOf(AccountView("77", "新账户", null, "2", "CNY")))
            true
        }, request = { _, body ->
            assertTrue(body!!.getJSONObject("content").isNull("balance"))
            JSONObject().put("entityId", "77").put("snapshot",
                JSONObject().put("id", "77").put("name", "新账户").put("active", true))
        })
        compose.setContent { MoneyTheme {
            EntrySheet(liveMetadata.value, null, save = { _, content, _ -> saved = content },
                close = {}, actions = creation)
        } }
        compose.onNodeWithText("餐饮").performClick()
        compose.onNodeWithTag("key-8").performClick()
        compose.onNodeWithTag("entry-note").performTextInput("保留草稿")
        compose.onNodeWithText("创建账户").performClick()
        compose.onNodeWithTag("master-name").performTextInput("新账户")
        compose.onNodeWithTag("master-save").performScrollTo().performClick()
        compose.onNodeWithTag("entry-amount").assertTextContains("8")
        compose.onNodeWithTag("entry-note").assertTextContains("保留草稿")
        compose.onNodeWithTag("entry-save").performClick()
        compose.runOnIdle {
            assertTrue(liveMetadata.value.accounts.any { it.id == saved?.accountId })
            assertEquals("77", saved?.accountId)
            assertEquals(800L, saved?.amountCents)
        }
    }

    @Test fun inlineCreationHonorsJournalGateAndRecoversWithoutLosingDraft() {
        val loading = mutableStateOf(true)
        val error = mutableStateOf("")
        val body = JSONObject().put("operationId", "prior").put("entityType", "tag")
            .put("entityId", JSONObject.NULL).put("action", "save")
            .put("content", JSONObject().put("name", "旧标签")).toString()
        val pending = mutableStateOf(listOf(PendingMasterRequest("prior", body, 1)))
        var calls = 0
        val callbacks = actions().copy(request = { _, payload ->
            calls++
            assertEquals("prior", payload!!.getString("operationId"))
            pending.value = emptyList()
            JSONObject()
        })
        compose.setContent { MoneyTheme {
            EntrySheet(metadata, null, save = { _, _, _ -> }, close = {}, actions = callbacks,
                pendingMasterRequests = pending.value, masterRequestsLoading = loading.value,
                masterRequestError = error.value)
        } }
        compose.onNodeWithTag("key-8").performClick()
        compose.onNodeWithTag("entry-note").performTextInput("未丢失")
        compose.onNodeWithText("创建账户").assertIsNotEnabled()
        compose.runOnIdle { loading.value = false; error.value = "日志读取失败" }
        compose.onNodeWithText("创建账户").assertIsNotEnabled()
        compose.runOnIdle { assertEquals(0, calls); error.value = "" }
        compose.onNodeWithText("创建账户").performClick()
        compose.onNodeWithTag("master-name").assertDoesNotExist()
        compose.onNodeWithTag("master-recovery-retry").performScrollTo().performClick()
        compose.onNodeWithTag("entry-amount").assertTextContains("8")
        compose.onNodeWithTag("entry-note").assertTextContains("未丢失")
        compose.onNodeWithText("创建账户").performClick()
        compose.onNodeWithTag("master-name").assertExists()
        compose.runOnIdle { assertEquals(1, calls) }
    }

    @Test fun failedSaveRetainsFormAndDoesNotDismiss() {
        var dismissed = false
        val backgroundBill = mutableStateOf(bill())
        compose.setContent {
            MoneyTheme {
                EntrySheet(metadata, backgroundBill.value, save = { _, _, _ ->
                    backgroundBill.value = bill().copy(updatedAt = System.currentTimeMillis())
                    throw IllegalStateException("磁盘空间不足")
                },
                    close = { dismissed = true })
            }
        }
        compose.onNodeWithText("时间 / 商户 / 标签 / 更多").performClick()
        compose.onNodeWithTag("entry-merchant").performScrollTo().performTextReplacement("修改后商户")
        compose.onNodeWithTag("entry-note").performTextReplacement("失败后不能丢失的备注")
        compose.onNodeWithTag("entry-save").performClick()
        compose.onNodeWithText("磁盘空间不足").assertExists()
        compose.onNodeWithTag("entry-merchant").assertTextContains("修改后商户")
        compose.onNodeWithTag("entry-note").assertTextContains("失败后不能丢失的备注")
        compose.runOnIdle { assertFalse(dismissed) }
    }

    @Test fun saveCannotBeSubmittedTwiceWhileInFlight() {
        val calls = AtomicInteger()
        val result = CompletableDeferred<Unit>()
        compose.setContent {
            MoneyTheme {
                EntrySheet(metadata, bill(), save = { _, _, _ -> calls.incrementAndGet(); result.await() }, close = {})
            }
        }
        compose.onNodeWithTag("entry-save").performClick()
        compose.onNodeWithTag("entry-save").assertIsNotEnabled()
        compose.runOnIdle { assertEquals(1, calls.get()); result.complete(Unit) }
    }

    @Test fun pendingDeletedTransfersAndExcludedRowsDoNotChangeTotals() {
        val rows = listOf(bill(), bill("pending", "pending", 99900), bill("deleted", "deleted", 55500),
            bill("transfer", amount = 20000, kind = "transfer"), bill("income", amount = 5000, kind = "income"),
            bill("refund", amount = 500, kind = "refund"), bill("excluded", amount = 12345).let {
                it.copy(content = it.content.copy(excludeFromStatistics = true))
            })
        val summary = summarizeBills(rows, "2026-10")
        assertEquals(2500L, summary.expenseCents)
        assertEquals(500L, summary.refundCents)
        assertEquals(2000L, summary.netExpenseCents)
        assertEquals(5000L, summary.incomeCents)
        assertEquals(3000L, summary.surplusCents)
    }

    @Test fun pendingListIsSeparateAndExplainsItsEffect() {
        compose.setContent {
            MoneyTheme { MoneyApp(LedgerState(listOf(bill("posted"), bill("pending", "pending", 99900)), metadata), actions()) }
        }
        compose.onNodeWithText("待确认 1").performScrollTo().performClick()
        compose.onNodeWithText("待确认项不计入正式统计，不改变账面余额。").assertExists()
        compose.onNodeWithTag("bill-list").performScrollToNode(hasText("999.00", substring = true))
        compose.onNodeWithText("999.00", substring = true).assertIsDisplayed()
        compose.onNodeWithText("−25.00").assertDoesNotExist()
    }

    @Test fun retainedInactiveReferencesAreShownWithoutOfferingOtherInactiveChoices() {
        val historical = metadata.copy(accounts = metadata.accounts.map { it.copy(active = false) } +
            AccountView("8", "无关停用账户", null, "1", "CNY", active = false))
        compose.setContent { MoneyTheme { EntrySheet(historical, bill(), save = { _, _, _ -> }, close = {}) } }
        compose.onNodeWithText("现金（已停用）").assertExists()
        compose.onNodeWithText("现金（已停用）").performClick()
        compose.onNodeWithText("无关停用账户", substring = true).assertDoesNotExist()
    }

    @Test fun conflictCandidateAndVersionStayFrozenUntilExplicitReview() {
        fun remote(version: Int, merchant: String) = org.json.JSONObject().put("version", version).put("status", "posted")
            .put("content", bill().content.copy(merchant = merchant).json())
        val current = mutableStateOf(bill().copy(syncState = "conflict", server = remote(2, "云端二")))
        val reviewed = AtomicInteger()
        val callbacks = actions().copy(resolve = { _, _, version ->
            reviewed.set(version)
            throw IllegalStateException("云端候选已更新，请重新核对")
        })
        compose.setContent {
            MoneyTheme { BillDetail(current.value, LedgerState(listOf(current.value), metadata), callbacks,
                close = {}, edit = {}, refund = {}, linked = {}) }
        }
        compose.onNodeWithText("保留本机内容并重新提交").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(2, reviewed.get()); current.value = current.value.copy(server = remote(3, "云端三")) }
        compose.onNodeWithText("云端版本 2").assertExists()
        compose.onNodeWithText("云端三", substring = true).assertDoesNotExist()
        compose.onNodeWithText("保留本机内容并重新提交").assertIsNotEnabled()
        compose.onNodeWithText("刷新云端候选并重新核对").performScrollTo().performClick()
        compose.onNodeWithText("云端版本 3").assertExists()
        compose.onNodeWithText("保留本机内容并重新提交").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(3, reviewed.get()) }
    }

    @Test fun exactMoneyParsingAndShanghaiTimeAreUsed() {
        assertEquals(12345L, amountInput("123.45"))
        assertEquals(-12345L, amountInput("-123.45", signed = true))
        assertEquals("2026-10-30 12:30", dateLabel(parseDateTime("2026-10-30 12:30")))
        assertTrue(runCatching { amountInput("1.001") }.isFailure)
        assertTrue(runCatching { parseDateTime("2026-02-30 12:30") }.isFailure)
    }

    @Test fun uncertainMasterRequestKeepsSameOperationAndPayloadForRetry() {
        val requests = mutableListOf<String>()
        var dismissed = false
        val callbacks = actions().copy(request = { _, payload ->
            requests.add(payload!!.toString())
            if (requests.size == 1) throw java.io.IOException("响应丢失")
            org.json.JSONObject()
        })
        compose.setContent {
            MoneyTheme { MasterForm(org.json.JSONObject().put("entityType", "tag").put("action", "save"), metadata,
                callbacks, close = { dismissed = true }) }
        }
        compose.onNodeWithTag("master-name").performTextInput("周末")
        compose.onNodeWithTag("master-save").performScrollTo().performClick()
        compose.onNodeWithTag("master-name").assertTextContains("周末").assertIsNotEnabled()
        compose.runOnIdle { assertFalse(dismissed) }
        compose.onNodeWithTag("master-save").performScrollTo().performClick()
        compose.runOnIdle { assertTrue(dismissed); assertEquals(2, requests.size); assertEquals(requests[0], requests[1]) }
    }

    @Test fun gateRejectsSecondAcquisitionUntilReleased() {
        val gate = SubmissionGate()
        assertTrue(gate.acquire()); assertFalse(gate.acquire())
        gate.release(); assertTrue(gate.acquire())
    }

    @Test fun balanceCalibrationUsesConfirmedCloudBaselineInsteadOfProjection() {
        val account = AccountView("1", "现金", 7500, "1", "CNY",
            confirmedBalance = 10000, balancePending = true)
        var request: org.json.JSONObject? = null
        compose.setContent {
            MoneyTheme {
                MasterForm(org.json.JSONObject().put("entityType", "account").put("action", "balance")
                    .put("base", account.json()), metadata, actions().copy(request = { _, payload ->
                        request = payload
                        org.json.JSONObject()
                    }), close = {})
            }
        }
        compose.onNodeWithTag("master-balance").assertTextContains("100.00")
        compose.onNodeWithTag("master-balance").performTextReplacement("90.00")
        compose.onNodeWithTag("master-reason").performTextInput("核对银行余额")
        compose.onNodeWithTag("master-save").performScrollTo().performClick()
        compose.runOnIdle {
            assertEquals("10000", request!!.getJSONObject("content").getString("expectedBalance"))
            assertEquals("9000", request!!.getJSONObject("content").getString("balance"))
        }
    }

    @Test fun accountsDistinguishProjectedAndUncertainBalances() {
        val accounts = listOf(
            AccountView("1", "现金估算", 7500, "1", "CNY", confirmedBalance = 10000, balancePending = true),
            AccountView("4", "银行卡待核对", 6000, "2", "CNY", confirmedBalance = 8000, balancePending = true, balanceExact = false))
        compose.setContent {
            MoneyTheme { SettingsPage(LedgerState(metadata = metadata.copy(accounts = accounts)), actions(),
                CaptureUiState(), true, openLogin = {}, openBill = {}, viewAccount = {}) }
        }
        compose.onNodeWithTag("settings-list").performScrollToNode(hasText("本机估算 · 待同步"))
        compose.onNodeWithText("本机估算 · 待同步").assertIsDisplayed()
        compose.onNodeWithTag("settings-list").performScrollToNode(hasText("余额待核对"))
        compose.onNodeWithText("余额待核对").assertExists()
        compose.onNodeWithText("云端已确认 ¥80.00").assertExists()
    }

    @Test fun recoveredMasterRequestRetainsBodyThroughReauthenticationAndGuardsRetry() {
        val original = org.json.JSONObject().put("operationId", "recovered-operation")
            .put("entityType", "tag").put("entityId", org.json.JSONObject.NULL).put("expectedVersion", 0)
            .put("action", "save").put("content", org.json.JSONObject().put("name", "重启前标签")
                .put("active", true).put("sortOrder", 0)).toString()
        // These props represent records loaded from Room by a fresh Activity, with no original form state.
        val recovered = mutableStateOf(listOf(PendingMasterRequest("recovered-operation", original, 1,
            lastError = "响应丢失")))
        val requests = mutableListOf<String>()
        val loginCalls = AtomicInteger()
        val response = CompletableDeferred<Unit>()
        val callbacks = actions().copy(login = { username, password ->
            assertEquals("owner", username); assertEquals("password", password); loginCalls.incrementAndGet()
        }, request = { route, payload ->
            assertEquals("v2/master/submit", route)
            requests.add(payload!!.toString())
            if (requests.size == 1) throw ApiException(401, "AUTH_REQUIRED", "请重新登录")
            response.await()
            recovered.value = emptyList()
            org.json.JSONObject()
        })
        compose.setContent {
            MoneyTheme { MoneyApp(LedgerState(metadata = metadata), callbacks, pendingMasterRequests = recovered.value) }
        }
        compose.onNodeWithTag("nav-2").performClick()
        compose.onNodeWithTag("settings-list").performScrollToNode(hasTestTag("recover-master:recovered-operation"))
        compose.onNodeWithTag("recover-master:recovered-operation").performClick()
        compose.onNodeWithText("重启前标签").assertExists()
        compose.onNodeWithTag("master-name").assertDoesNotExist()
        compose.onNodeWithTag("master-recovery-retry").performScrollTo().performClick()
        compose.onNodeWithTag("master-recovery-retry").assertIsNotEnabled()
        compose.onNodeWithText("用户名").performScrollTo().performTextInput("owner")
        compose.onNodeWithText("密码").performScrollTo().performTextInput("password")
        compose.onNodeWithText("登录", substring = false).performScrollTo().performClick()
        compose.onNodeWithTag("master-recovery-retry").assertIsNotEnabled()
        compose.runOnIdle {
            assertEquals(1, loginCalls.get())
            assertEquals(listOf(original, original), requests)
            response.complete(Unit)
        }
        compose.onNodeWithText("原请求已获云端确认，正在刷新账户、分类和标签。").assertExists()
        compose.onNodeWithTag("master-recovery-retry").assertDoesNotExist()
    }

    @Test fun unreadableMasterRequestIsVisibleAndPreventsAccidentalNewCreation() {
        val calls = AtomicInteger()
        val broken = PendingMasterRequest("broken", "{broken", 0, readError = "本机冻结请求无法读取")
        compose.setContent {
            MoneyTheme { SettingsPage(LedgerState(metadata = metadata),
                actions().copy(request = { _, _ -> calls.incrementAndGet(); org.json.JSONObject() }),
                CaptureUiState(), true, openLogin = {}, openBill = {}, viewAccount = {},
                pendingMasterRequests = listOf(broken)) }
        }
        compose.onNodeWithTag("settings-list").performScrollToNode(hasText("创建账户"))
        compose.onNodeWithText("创建账户").performClick()
        compose.onNode(hasText("本机冻结请求无法读取") and hasAnyAncestor(isDialog()))
            .performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("master-recovery-retry").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithTag("master-name").assertDoesNotExist()
        compose.runOnIdle { assertEquals(0, calls.get()) }
    }

    @Test fun recoveryUsesHumanTypeNamesAndRevealsRecordIdsOnlyOnRequest() {
        fun request(id: String, entityType: String, content: org.json.JSONObject) = PendingMasterRequest(id,
            org.json.JSONObject().put("operationId", id).put("entityType", entityType)
                .put("entityId", org.json.JSONObject.NULL).put("expectedVersion", 0).put("action", "save")
                .put("content", content).toString(), 1)
        val current = mutableStateOf(request("saved-account-operation", "account",
            org.json.JSONObject().put("name", "日常信用卡").put("category", 3)))
        compose.setContent {
            MoneyTheme { MasterRequestRecovery(current.value, actions(), metadata, close = {}, confirmed = {}) }
        }
        compose.onNodeWithText("账户类型").assertExists()
        compose.onNodeWithText("信用卡").assertExists()
        compose.onNodeWithText("操作编号").assertDoesNotExist()
        compose.onNodeWithText("核对版本").assertDoesNotExist()
        compose.onNodeWithText("记录信息").performScrollTo().performClick()
        compose.onNodeWithText("saved-account-operation").assertExists()
        compose.onNodeWithText("核对版本").assertExists()
        compose.onNodeWithText("记录信息").performScrollTo().performClick()
        compose.onNodeWithText("saved-account-operation").assertDoesNotExist()
        compose.runOnIdle {
            current.value = request("saved-category-operation", "category",
                org.json.JSONObject().put("name", "早餐").put("type", 2).put("parentId", "2"))
        }
        compose.onNodeWithText("支出").assertExists()
        compose.onNodeWithText("餐饮").assertExists()
        compose.onNodeWithText("上级分类编号").assertDoesNotExist()
        compose.onNodeWithText("saved-category-operation").assertDoesNotExist()
    }
}
