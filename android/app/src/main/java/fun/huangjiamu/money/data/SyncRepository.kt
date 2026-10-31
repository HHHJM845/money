package `fun`.huangjiamu.money.data

import androidx.room.withTransaction
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject

class SyncRepository(private val repo: LedgerRepository, private val api: LedgerApi) {
    private val dao = repo.dao
    private val db = repo.db

    internal data class Outcome(val complete: Boolean, val retryAutomatically: Boolean)

    suspend fun synchronize(): Boolean = synchronizeOutcome().complete

    internal suspend fun synchronizeOutcome(): Outcome = syncMutex.withLock {
        try {
            repo.importLegacy()
            if (!api.connected) {
                stateError("请登录云端账本；本机记录和待上传操作已保留", true)
                return@withLock Outcome(false, false)
            }
            replayLegacy()
            if (dao.sync()?.initialized != true) bootstrap()
            repo.repairLegacyCategories()
            repo.refreshUnsentNewEffects()
            // Resolve unknown outcomes before reading a newer server baseline.
            upload()
            download()
            val state = dao.sync() ?: SyncState()
            val notices = dao.masters().filter { it.kind in listOf("notice", "missing") }
                .map { JSONObject(it.json).getString("error") }.distinct().joinToString("\n")
            dao.saveSync(state.copy(lastSuccess = System.currentTimeMillis(), error = notices, authExpired = false))
            val operations = dao.operations()
            val roots = operations.groupBy { it.billId }.mapValues { it.value.first() }
            Outcome(operations.isEmpty() && dao.masters().none { it.kind == "missing" },
                roots.values.any {
                    val original = JSONObject(it.draft).optJSONObject("content")?.nullableString("refundOfBillId")
                    it.state in listOf("queued", "sending", "unknown") &&
                        roots[original]?.state !in listOf("conflict", "failed")
                })
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            stateError(error.message ?: "同步失败，请稍后重试", error is ApiException && error.status in listOf(401, 403))
            Outcome(false, !(error is ApiException && error.status in listOf(401, 403)))
        }
    }

    private suspend fun stateError(message: String, auth: Boolean = false) {
        dao.saveSync((dao.sync() ?: SyncState()).copy(error = message, authExpired = auth))
    }

    private suspend fun replayLegacy() {
        for (entry in db.ledger().all().filter { it.uploadPayload != null && it.remoteId == null }) {
            // The original v1 idempotency token and complete body must survive upgrades.
            try {
                val result = api.request("v1/transactions/add", JSONObject(entry.uploadPayload!!))
                db.withTransaction { db.ledger().save(entry.copy(remoteId = result.getString("id"), uploadPayload = null)) }
            } catch (error: ApiException) {
                if (error.status != 410) throw error
                db.withTransaction {
                    val link = dao.links().single { it.entryId == entry.id }
                    repo.mergeBill(JSONObject().put("billId", link.billId).put("version", 0)
                        .put("status", "deleted").put("expired", true))
                    dao.saveLink(link.copy(waiting = false))
                    dao.saveMasters(listOf(MasterRecord("notice", link.billId, JSONObject()
                        .put("error", "旧版记录已过期，内容及待上传请求已清理；其他记录继续同步").toString())))
                }
            }
        }
    }

    private suspend fun bootstrap() {
        val snapshot = api.request("v2/snapshot")
        check(validSequence(snapshot.getString("sequence"))) { "云端同步游标无效" }
        db.withTransaction {
            val bills = snapshot.getJSONArray("bills").objects()
            val tombstones = snapshot.optJSONArray("tombstones")?.objects().orEmpty()
            val present = (bills + tombstones).map { it.getString("billId") }.toSet()
            dao.bills().filter { it.billId !in present && !it.expired && it.serverJson != null }.forEach { old ->
                val message = "云端恢复后缺少这笔记录，请核对恢复结果；本机内容已保留，暂停原身份上传"
                dao.saveMasters(listOf(MasterRecord("missing", old.billId, JSONObject().put("error", message).toString())))
                dao.operations().filter { it.billId == old.billId }.forEach {
                    dao.updateOperation(it.copy(state = "conflict", error = message))
                }
            }
            bills.forEach { repo.mergeBill(it) }
            tombstones.forEach { repo.mergeBill(it) }
            dao.clearEffectBaselines()
            bills.filter { dao.bill(it.getString("billId"))?.expired != true }.forEach {
                dao.saveMasters(listOf(effectBaseline(it)))
            }
            dao.bills().filter { it.serverJson == null && !it.expired }.forEach {
                dao.saveMasters(listOf(effectBaseline(JSONObject().put("billId", it.billId).put("appliedEffect", JSONObject()))))
            }
            publishMetadata(snapshot)
            dao.clearStage()
            dao.saveSync((dao.sync() ?: SyncState()).copy(cursor = snapshot.getString("sequence"), stageCursor = null, initialized = true))
        }
    }

    private suspend fun upload() {
        val attempted = mutableSetOf<String>()
        while (true) {
            val operations = dao.operations()
            val first = operations.groupBy { it.billId }.values.map { it.first() }
            val operation = first.firstOrNull { candidate ->
                val original = JSONObject(candidate.draft).optJSONObject("content")?.nullableString("refundOfBillId")
                candidate.operationId !in attempted && candidate.state !in listOf("conflict", "failed") &&
                    (original == null || operations.none { it.billId == original })
            } ?: break
            attempted.add(operation.operationId)
            val frozen = db.withTransaction {
                val current = dao.operations().find { it.operationId == operation.operationId } ?: return@withTransaction null
                val draft = JSONObject(current.draft)
                check(current.request != null || draft.has("expectedVersion")) { "依赖操作尚未确认，不能确定预期版本" }
                val request = current.request ?: draft.put("operationId", current.operationId)
                    .put("billId", current.billId).put("action", current.action).toString()
                current.copy(request = request, state = "sending", error = "").also { dao.updateOperation(it) }
            } ?: continue
            try {
                val result = api.request("v2/bills/submit", JSONObject(frozen.request!!))
                check(result.getString("billId") == frozen.billId) { "云端确认与操作账单不匹配" }
                check(result.getInt("version") == JSONObject(frozen.request).getInt("expectedVersion") + 1) { "云端确认版本与操作不匹配" }
                db.withTransaction {
                    repo.mergeBill(result)
                    dao.removeOperation(frozen.operationId)
                    dao.operations().firstOrNull { it.billId == frozen.billId && it.predecessor == frozen.operationId && it.request == null }?.let { next ->
                        dao.updateOperation(next.copy(draft = JSONObject(next.draft).put("expectedVersion", result.getInt("version")).toString()))
                    }
                    if (dao.operations().none { it.billId == frozen.billId }) {
                        dao.bill(frozen.billId)?.let { if (!it.expired) dao.saveBill(it.copy(localJson = null)) }
                    }
                }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                when {
                    error is ApiException && error.status in listOf(401, 403) -> {
                        dao.updateOperation(frozen.copy(state = "unknown", error = "登录过期，重新登录后确认原操作"))
                        throw error
                    }
                    error is ApiException && error.status == 410 -> db.withTransaction {
                        repo.mergeBill(JSONObject().put("billId", frozen.billId).put("version",
                            dao.bill(frozen.billId)?.serverJson?.let { JSONObject(it).optInt("version") } ?: 0)
                            .put("expired", true).put("status", "deleted"))
                    }
                    error is ApiException && error.status == 409 -> {
                        dao.updateOperation(frozen.copy(state = "conflict", error = error.message.orEmpty()))
                        try {
                            val server = api.request("v2/bills/detail?billId=${frozen.billId}")
                            db.withTransaction { repo.mergeBill(server) }
                        } catch (cancel: CancellationException) { throw cancel }
                        catch (_: Exception) { /* The next change pull can still provide the server candidate. */ }
                    }
                    error is ApiException && error.status in 400..499 && error.status !in listOf(408, 429) ->
                        dao.updateOperation(frozen.copy(state = "failed", error = error.message.orEmpty()))
                    else -> dao.updateOperation(frozen.copy(state = "unknown", error = error.message ?: "结果未知，请重试原操作"))
                }
            }
        }
    }

    private suspend fun download() {
        // Persist partial pages, but keep the published baseline coherent until tail.
        repeat(1000) {
            val state = dao.sync() ?: error("尚未初始化账本")
            val after = state.stageCursor ?: state.cursor
            val page = try { api.request("v2/sync/changes?after=$after&count=200") }
            catch (error: ApiException) {
                if (error.code in listOf("CURSOR_INVALID", "CURSOR_EXPIRED", "INVALID_CURSOR", "SYNC_CURSOR_EXPIRED")) {
                    bootstrap()
                    return
                }
                throw error
            }
            val next = page.getString("nextSequence")
            require(validSequence(next) && next.toBigInteger() >= after.toBigInteger()) { "云端游标未按顺序推进" }
            val more = page.getBoolean("hasMore")
            check(!more || next.toBigInteger() > after.toBigInteger()) { "云端分页没有推进" }
            db.withTransaction {
                dao.stage(page.getJSONArray("changes").objects().mapNotNull {
                    val kind = it.getString("entityType")
                    val id = it.getString("entityId")
                    val snapshot = it.getJSONObject("snapshot")
                    if (kind == "bill" && dao.bill(id)?.expired == true && !snapshot.optBoolean("expired")) null
                    else StagedChange(kind, id, snapshot.toString())
                })
                if (more) dao.saveSync(state.copy(stageCursor = next))
                else {
                    dao.staged().filter { it.kind == "bill" }.forEach {
                        val bill = JSONObject(it.json)
                        repo.mergeBill(bill)
                        if (dao.bill(it.entityId)?.expired != true) dao.saveMasters(listOf(effectBaseline(bill)))
                    }
                    publishMetadata(page)
                    dao.clearStage()
                    dao.saveSync(state.copy(cursor = next, stageCursor = null))
                }
            }
            if (!more) return
        }
        error("账本分页尚未完成，下次同步将继续")
    }

    private suspend fun publishMetadata(json: JSONObject) {
        val records = listOf("account" to "accounts", "category" to "categories", "tag" to "tags").flatMap { (kind, key) ->
            json.getJSONArray(key).objects().map { MasterRecord(kind, it.getString("id"), it.toString()) }
        }
        dao.clearPublishedMasters()
        dao.saveMasters(records)
        dao.clearAccountingUncertainty()
    }

    companion object {
        internal val syncMutex = Mutex()
        private fun validSequence(value: String) = value.matches(Regex("[0-9]+")) && value.toBigInteger() <= Long.MAX_VALUE.toBigInteger()
    }
}
