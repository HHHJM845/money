package `fun`.huangjiamu.money.data

import androidx.room.withTransaction
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

class LedgerRepository(val db: LedgerDatabase) {
    val dao = db.bookkeeping()

    fun observe(): Flow<LedgerState> = dao.observeInvalidations().map {
        // Read all observable tables in one snapshot; independent flows can expose torn transactions.
        db.withTransaction {
            val operations = dao.operations()
            val sync = dao.sync()
            val records = dao.bills()
            val masters = dao.masters()
            LedgerState(views(records, operations, masters, dao.links()), projectBalances(metadata(masters), records, masters, operations),
                operations.size, sync?.lastSuccess ?: 0,
                sync?.error.orEmpty(), sync?.authExpired ?: false)
        }
    }

    suspend fun bills(): List<BillView> = db.withTransaction { views(dao.bills(), dao.operations(), dao.masters(), dao.links()) }
    suspend fun metadata(): Metadata = db.withTransaction {
        val masters = dao.masters()
        projectBalances(metadata(masters), dao.bills(), masters, dao.operations())
    }

    private fun metadata(records: List<MasterRecord>): Metadata = Metadata(
        accounts = records.filter { it.kind == "account" }.map { JSONObject(it.json) }.filter { it.optString("currency", "CNY") == "CNY" }
            .map { AccountView(it.getString("id"), it.getString("name"), it.nullableString("balance")?.toLong(),
                it.optString("category"), it.optString("currency", "CNY"), it.optBoolean("active", true), it.optInt("version", 1)) },
        categories = records.filter { it.kind == "category" }.map { JSONObject(it.json) }.map {
            CategoryView(it.getString("id"), it.getString("name"), it.getInt("type"), it.nullableString("parentId"), it.optBoolean("active", true),
                it.optInt("version", 1), it.optInt("sortOrder")) }.sortedBy { it.sortOrder },
        tags = records.filter { it.kind == "tag" }.map { JSONObject(it.json) }.map {
            TagView(it.getString("id"), it.getString("name"), it.optBoolean("active", true), it.optInt("version", 1), it.optInt("sortOrder")) }.sortedBy { it.sortOrder },
    )

    private fun views(records: List<BillRecord>, operations: List<OutboxOperation>, masters: List<MasterRecord>,
        links: List<LegacyLink>): List<BillView> = records.filter { !it.expired }.map { record ->
        val json = JSONObject(record.localJson ?: record.serverJson ?: error("本地账单内容缺失"))
        val pending = operations.filter { it.billId == record.billId }
        val missing = masters.find { it.kind == "missing" && it.id == record.billId }
        val waiting = links.any { it.billId == record.billId && it.waiting }
        val state = if (missing != null) "conflict" else pending.firstOrNull()?.state ?: if (waiting) "legacy" else if (record.serverJson == null) "local" else "synced"
        BillView(record.billId, record.serverJson?.let { JSONObject(it).optInt("version") } ?: 0,
            json.getString("status"), BillContent.parse(json.getJSONObject("content")), json.optString("balanceMode", "apply"),
            state, missing?.let { JSONObject(it.json).getString("error") } ?: pending.firstOrNull()?.error.orEmpty(), JSONArray(record.sourcesJson).objects(),
            record.serverJson?.let { JSONObject(it) }, json.optLong("createdAt"), json.optLong("updatedAt"),
            if (json.isNull("deletedAt")) null else json.getLong("deletedAt"), waiting,
            BalanceEffects.read(json, "appliedEffect"), BalanceEffects.read(json, "restoreEffect"))
    }

    suspend fun save(id: String? = null, content: BillContent, status: String = "posted",
        balanceMode: String? = null, sources: List<JSONObject>? = null): String = db.withTransaction {
        content.validate(status)
        val key = id ?: UUID.randomUUID().toString()
        val old = dao.bill(key)
        require(id == null || old != null) { "账单不存在" }
        require(old?.expired != true) { "账单内容已过期清理，不能重新编辑或恢复" }
        require(dao.masters().none { it.kind == "missing" && it.id == key }) { "云端恢复后缺少这笔记录，请先核对恢复，原输入已保留" }
        require(!dao.links().any { it.billId == key && it.waiting }) { "旧版上传结果尚未确认，请先同步" }
        val before = old?.let { JSONObject(it.localJson ?: it.serverJson!!) }
        require(before?.optString("status") != "deleted") { "请先恢复回收站中的账单" }
        val mode = before?.optString("balanceMode") ?: balanceMode ?: "apply"
        require(balanceMode == null || balanceMode == mode) { "已有账单不能切换余额模式" }
        validateReferences(key, content, status, before)
        val sourceArray = sources?.let { JSONArray(it) } ?: JSONArray(old?.sourcesJson ?: "[]")
        val now = System.currentTimeMillis()
        val local = JSONObject().put("billId", key).put("status", status).put("content", content.json())
            .put("balanceMode", mode).put("createdAt", before?.optLong("createdAt") ?: now).put("updatedAt", now)
        val effect = BalanceEffects.save(before, content, status, mode,
            if (dao.sync()?.initialized == true) metadata().accounts else emptyList())
        local.put("appliedEffect", effect?.let { JSONObject(it) } ?: JSONObject.NULL)
            .put("restoreEffect", effect?.let { JSONObject(it) } ?: JSONObject.NULL)
        if (old == null) dao.saveMasters(listOf(MasterRecord("effect", key, JSONObject().put("appliedEffect", JSONObject()).toString())))
        val draft = JSONObject().put("status", status).put("content", content.json()).put("balanceMode", mode).put("sources", sourceArray)
        val rejected = dao.operations().firstOrNull { it.billId == key && it.state == "failed" }
        if (rejected != null) {
            // A definitive rejection did not commit. A corrected save is a new logical operation.
            val baseline = JSONObject(rejected.request ?: rejected.draft).getInt("expectedVersion")
            dao.clearOperations(key)
            draft.put("expectedVersion", baseline)
        }
        queue(key, "save", draft, local, old, sourceArray.toString())
        key
    }

    private suspend fun validateReferences(id: String, content: BillContent, status: String, before: JSONObject?) {
        val metadata = metadata()
        val initialized = dao.sync()?.initialized == true
        val retained = before?.optString("status") == "posted"
        val previous = before?.optJSONObject("content")?.let { BillContent.parse(it) }
        val original = if (content.kind == "refund") bills().find { it.billId == content.refundOfBillId } else null
        if (initialized) {
            listOfNotNull(content.accountId, content.destinationAccountId).forEach { accountId ->
                require(metadata.accounts.any { it.id == accountId && (it.active || retained &&
                    (previous?.accountId == accountId || previous?.destinationAccountId == accountId)) }) { "账户已失效，请重新选择" }
            }
            content.categoryId?.let { categoryId ->
                require(metadata.categories.any { it.id == categoryId && (it.active || retained && previous?.categoryId == categoryId ||
                    original?.content?.categoryId == categoryId) && it.type == when (content.kind) { "income" -> 1; "transfer" -> 3; else -> 2 } }) {
                    "分类已停用或类型不匹配，请重新选择"
                }
            }
            require(content.tagIds.all { tagId -> metadata.tags.any { it.id == tagId && (it.active || retained && tagId in previous?.tagIds.orEmpty()) } }) { "标签已停用，请重新选择" }
        }
        if (status == "posted" && content.kind == "refund") {
            require(original != null && original.status == "posted" && original.content.kind == "expense") { "退款需关联有效的已入账支出" }
            val refunded = bills().filter { it.billId != id && it.status == "posted" && it.content.refundOfBillId == content.refundOfBillId }
                .fold(java.math.BigInteger.ZERO) { total, bill -> total + (bill.content.amountCents ?: 0).toBigInteger() }
            require(refunded + content.amountCents!!.toBigInteger() <= original.content.amountCents!!.toBigInteger()) { "累计退款不能超过原支出" }
        }
        val refunds = bills().filter { it.billId != id && it.status == "posted" && it.content.refundOfBillId == id }
        if (refunds.isNotEmpty()) {
            require(status == "posted" && content.kind == "expense") { "请先处理关联退款再改变原账类型或状态" }
            val total = refunds.fold(java.math.BigInteger.ZERO) { acc, bill -> acc + bill.content.amountCents!!.toBigInteger() }
            require(content.amountCents!!.toBigInteger() >= total) { "原支出不能低于累计退款" }
        }
    }

    private suspend fun queue(id: String, action: String, draft: JSONObject, local: JSONObject, old: BillRecord?, sources: String) {
        val predecessor = dao.operations().lastOrNull { it.billId == id }?.operationId
        if (predecessor == null && !draft.has("expectedVersion")) draft.put("expectedVersion", old?.serverJson?.let { JSONObject(it).getInt("version") } ?: 0)
        dao.saveBill((old ?: BillRecord(id)).copy(localJson = local.toString(), sourcesJson = sources))
        dao.enqueue(OutboxOperation(operationId = UUID.randomUUID().toString(), billId = id, action = action,
            draft = draft.toString(), predecessor = predecessor))
        dao.history(BillHistory(billId = id, at = System.currentTimeMillis(), action = action, snapshot = local.toString()))
    }

    suspend fun delete(id: String) = changeStatus(id, "delete")
    suspend fun restore(id: String) = changeStatus(id, "restore")
    private suspend fun changeStatus(id: String, action: String) = db.withTransaction {
        val old = dao.bill(id) ?: error("账单不存在")
        require(!old.expired) { "已超过恢复期限，不能恢复" }
        require(dao.masters().none { it.kind == "missing" && it.id == id }) { "云端缺少这笔记录，请先核对恢复" }
        require(!dao.links().any { it.billId == id && it.waiting }) { "请先确认旧版上传结果" }
        val local = JSONObject(old.localJson ?: old.serverJson!!)
        val status = local.getString("status")
        require((action == "delete" && status != "deleted") || (action == "restore" && status == "deleted")) { "账单状态已变化，请刷新" }
        if (action == "restore") require(System.currentTimeMillis() - local.optLong("deletedAt") < 30L * 86400000) { "已超过三十天恢复期限" }
        if (action == "delete") {
            require(bills().none { it.status == "posted" && it.content.refundOfBillId == id }) { "请先处理关联退款再删除原账" }
            dao.saveBill(old.copy(restoreStatus = status))
        }
        if (action == "delete") {
            local.put("restoreEffect", local.optJSONObject("appliedEffect") ?: JSONObject.NULL).put("appliedEffect", JSONObject())
        } else {
            local.put("appliedEffect", local.optJSONObject("restoreEffect") ?: JSONObject.NULL)
        }
        local.put("status", if (action == "delete") "deleted" else old.restoreStatus)
            .put("deletedAt", if (action == "delete") System.currentTimeMillis() else JSONObject.NULL)
            .put("updatedAt", System.currentTimeMillis())
        val restoreLocalOnly = action == "restore" && old.serverJson == null && dao.operations().none { it.billId == id }
        val draft = if (restoreLocalOnly) JSONObject().put("status", local.getString("status"))
            .put("content", local.getJSONObject("content")).put("balanceMode", local.optString("balanceMode", "apply"))
            .put("sources", JSONArray(old.sourcesJson)) else JSONObject()
        queue(id, if (restoreLocalOnly) "save" else action, draft, local, dao.bill(id), old.sourcesJson)
    }

    suspend fun refund(id: String, amountCents: Long, accountId: String): String {
        val original = bills().find { it.billId == id } ?: error("原账不存在")
        return save(content = original.content.copy(kind = "refund", amountCents = amountCents, accountId = accountId,
            destinationAccountId = null, refundOfBillId = id, occurredAt = System.currentTimeMillis(), note = "退款",
            tagIds = emptyList()), sources = emptyList())
    }

    suspend fun resolveConflict(id: String, keepLocal: Boolean, reviewedServerVersion: Int) = db.withTransaction {
        val record = dao.bill(id) ?: error("账单不存在")
        require(!record.expired) { "已过期记录不能恢复" }
        require(dao.masters().none { it.kind == "missing" && it.id == id }) { "云端缺少这笔记录，请先核对恢复，不能覆盖或重新创建原身份" }
        require(dao.operations().firstOrNull { it.billId == id }?.state == "conflict") { "账单当前没有待处理冲突" }
        val server = record.serverJson?.let { JSONObject(it) } ?: error("尚未取得云端版本，请重新同步")
        require(server.getInt("version") == reviewedServerVersion) { "云端版本在查看后已变化，请重新核对；本机输入已保留" }
        val local = JSONObject(record.localJson!!)
        dao.clearOperations(id)
        dao.saveBill(record.copy(localJson = null))
        if (keepLocal) {
            require(server.getString("status") != "deleted" || local.getString("status") == "deleted") { "云端已删除，请先采用云端版本并明确恢复" }
            if (local.getString("status") == "deleted") {
                if (server.getString("status") != "deleted") delete(id)
            } else save(id, BillContent.parse(local.getJSONObject("content")), local.getString("status"))
        }
    }

    suspend fun retry(id: String) = db.withTransaction {
        val first = dao.operations().firstOrNull { it.billId == id } ?: return@withTransaction
        require(first.state != "conflict") { "请先选择冲突处理方式" }
        require(dao.masters().none { it.kind == "missing" && it.id == id }) { "请先核对云端恢复结果" }
        dao.updateOperation(first.copy(state = "queued", error = ""))
    }

    suspend fun importLegacy() = db.withTransaction {
        val linked = dao.links().map { it.entryId }.toSet()
        val accounts = db.ledger().accounts()
        for (entry in db.ledger().all().filter { it.id !in linked }) {
            val id = runCatching { UUID.fromString(entry.id).toString() }.getOrElse {
                UUID.nameUUIDFromBytes("pilot:${entry.id}".toByteArray()).toString()
            }
            val waiting = entry.remoteId != null || entry.uploadPayload != null
            val category = metadata().categories.singleOrNull { it.name == entry.category }?.id
            val content = BillContent(kind = entry.type.takeIf { it in listOf("income", "expense", "transfer", "refund") } ?: "expense",
                amountCents = entry.amountCents.takeIf { it > 0 }, accountId = entry.accountId.takeIf { it.isNotBlank() }, categoryId = category,
                occurredAt = entry.time, merchant = entry.merchant, note = entry.reason)
            val status = if (entry.status == "ignored") "deleted" else entry.status
            val source = JSONObject().put("app", entry.source.take(100).ifBlank { "pilot" }).put("key", entry.eventKey.take(256))
                .put("capturedAt", entry.time).put("ruleVersion", "pilot-v1")
            val json = JSONObject().put("billId", id).put("status", status).put("content", content.json())
                .put("createdAt", entry.time).put("updatedAt", entry.time).put("balanceMode", "apply")
            if (!waiting && status != "posted") json.put("appliedEffect", JSONObject()).put("restoreEffect", JSONObject())
            if (status == "deleted") json.put("deletedAt", System.currentTimeMillis())
            val record = BillRecord(id, localJson = json.toString(), sourcesJson = JSONArray().put(source).toString(),
                restoreStatus = if (entry.status == "ignored") "pending" else entry.status)
            dao.saveBill(record)
            if (!waiting) dao.saveMasters(listOf(effectBaseline(JSONObject().put("billId", id).put("appliedEffect", JSONObject()))))
            dao.saveLink(LegacyLink(entry.id, id, waiting))
            if (!waiting && status != "deleted") queue(id, "save", JSONObject().put("status", status).put("content", content.json())
                .put("balanceMode", "apply").put("sources", JSONArray().put(source)), json, record, record.sourcesJson)
        }
        if (dao.masters().none { it.kind == "account" } && dao.sync()?.initialized != true) dao.saveMasters(accounts.map {
            MasterRecord("account", it.id, JSONObject().put("id", it.id).put("name", it.name).put("currency", "CNY").toString())
        })
    }

    internal suspend fun repairLegacyCategories() = db.withTransaction {
        val metadata = metadata()
        for (link in dao.links().filter { !it.waiting }) {
            val entry = db.ledger().find(link.entryId) ?: continue
            val root = dao.operations().firstOrNull { it.billId == link.billId } ?: continue
            if (root.request != null || root.predecessor != null || root.action != "save") continue
            val draft = JSONObject(root.draft)
            val content = draft.optJSONObject("content") ?: continue
            if (!content.isNull("categoryId")) continue
            val kind = content.getString("kind")
            val category = metadata.categories.singleOrNull {
                it.active && it.name == entry.category && it.type == when (kind) { "income" -> 1; "transfer" -> 3; else -> 2 }
            } ?: continue
            content.put("categoryId", category.id)
            dao.updateOperation(root.copy(draft = draft.toString()))
            // Later user edits are independent intents; only update the original imported overlay.
            if (dao.operations().count { it.billId == link.billId } == 1) {
                val record = dao.bill(link.billId) ?: continue
                val local = JSONObject(record.localJson ?: continue)
                if (local.getJSONObject("content").isNull("categoryId")) {
                    local.getJSONObject("content").put("categoryId", category.id)
                    dao.saveBill(record.copy(localJson = local.toString()))
                }
            }
        }
    }

    internal suspend fun refreshUnsentNewEffects() = db.withTransaction {
        val accounts = metadata().accounts
        for (record in dao.bills().filter { it.serverJson == null && !it.expired && it.localJson != null }) {
            val operations = dao.operations().filter { it.billId == record.billId }
            if (operations.isEmpty() || operations.any { it.request != null } ||
                dao.links().any { it.billId == record.billId && it.waiting }) continue
            val local = JSONObject(record.localJson!!)
            val status = local.getString("status")
            val effect = BalanceEffects.save(null, BillContent.parse(local.getJSONObject("content")),
                if (status == "deleted") record.restoreStatus else status, local.getString("balanceMode"), accounts)
            local.put("restoreEffect", effect?.let { JSONObject(it) } ?: JSONObject.NULL)
                .put("appliedEffect", if (status == "deleted") JSONObject() else effect?.let { JSONObject(it) } ?: JSONObject.NULL)
            dao.saveBill(record.copy(localJson = local.toString()))
        }
    }

    internal suspend fun mergeBill(json: JSONObject) {
        val id = json.getString("billId")
        val old = dao.bill(id)
        if (old?.expired == true && !json.optBoolean("expired")) return
        if (json.optBoolean("expired")) {
            json.nullableString("legacyId")?.let { legacyId ->
                for (entry in db.ledger().all().filter { it.remoteId == legacyId }) {
                    val link = dao.links().find { it.entryId == entry.id } ?: continue
                    if (link.billId != id) {
                        expireBill(link.billId, json)
                        dao.removeBill(link.billId)
                    }
                    dao.saveLink(link.copy(billId = id, waiting = false))
                }
            }
            expireBill(id, json)
            return
        }
        if (old?.serverJson != null && JSONObject(old.serverJson).getInt("version") > json.getInt("version")) return
        dao.removeMaster("missing", id)
        var sources = old?.sourcesJson ?: "[]"
        json.optJSONArray("sources")?.let { remote ->
            sources = if (old?.localJson != null) JSONArray((remote.objects() + JSONArray(old.sourcesJson).objects())
                .distinctBy { it.optString("app") to it.optString("key") }).toString() else remote.toString()
        }
        val restoreStatus = json.optString("restoreStatus").takeIf { it in listOf("pending", "posted") } ?: old?.restoreStatus ?: "posted"
        dao.saveBill((old ?: BillRecord(id)).copy(serverJson = json.toString(), sourcesJson = sources, restoreStatus = restoreStatus))
        if (old?.serverJson == null || JSONObject(old.serverJson).getInt("version") < json.getInt("version")) {
            dao.history(BillHistory(billId = id, at = json.optLong("updatedAt", System.currentTimeMillis()),
                action = "云端确认 v${json.getInt("version")}", snapshot = json.toString()))
        }
        val legacyId = json.nullableString("legacyId")
        if (legacyId != null) {
            for (entry in db.ledger().all().filter { it.remoteId == legacyId }) {
                val link = dao.links().find { it.entryId == entry.id }
                if (link != null && link.billId != id) {
                    val provisional = dao.bill(link.billId)
                    if (sources == "[]" && provisional != null) dao.saveBill(dao.bill(id)!!.copy(sourcesJson = provisional.sourcesJson))
                    dao.removeBill(link.billId)
                    dao.clearOperations(link.billId)
                    dao.clearHistory(link.billId)
                }
                dao.saveLink(LegacyLink(entry.id, id, false))
            }
        }
    }

    private suspend fun expireBill(id: String, tombstone: JSONObject) {
        val old = dao.bill(id)
        val masters = dao.masters()
        val baseline = masters.find { it.kind == "effect" && it.id == id }?.let { JSONObject(it.json) }
        val previousUncertainty = masters.find { it.kind == "uncertain" && it.id == id }?.let { JSONObject(it.json) }
        val accountIds = (listOfNotNull(old?.localJson, old?.serverJson).map { JSONObject(it) }.flatMap { bill ->
            val content = bill.optJSONObject("content")
            listOfNotNull(content?.nullableString("accountId"), content?.nullableString("destinationAccountId")) +
                BalanceEffects.read(bill, "appliedEffect").orEmpty().keys +
                BalanceEffects.read(bill, "restoreEffect").orEmpty().keys
        } + baseline?.optJSONArray("accountIds")?.strings().orEmpty() +
            baseline?.let { BalanceEffects.read(it, "appliedEffect") }.orEmpty().keys +
            previousUncertainty?.optJSONArray("accountIds")?.strings().orEmpty()).distinct()
        // Cached account totals may still include this bill until the next coherent tail.
        dao.saveMasters(listOf(MasterRecord("uncertain", id, JSONObject().put("accountIds", JSONArray(accountIds)).toString())))
        dao.clearOperations(id)
        dao.clearHistory(id)
        dao.clearStagedBill(id)
        dao.removeMaster("effect", id)
        dao.removeMaster("missing", id)
        val version = maxOf(tombstone.getInt("version"), old?.serverJson?.let { JSONObject(it).optInt("version") } ?: 0)
        val clean = JSONObject().put("billId", id).put("version", version).put("status", "deleted")
            .put("legacyId", tombstone.nullableString("legacyId") ?: JSONObject.NULL)
            .put("deletedAt", tombstone.optLong("deletedAt")).put("changeSequence", tombstone.optString("changeSequence")).put("expired", true)
        dao.saveBill(BillRecord(id, serverJson = clean.toString(), expired = true))
        dao.links().filter { it.billId == id }.forEach { link ->
            db.ledger().find(link.entryId)?.let { db.ledger().save(it.copy(merchant = "", category = "", amountCents = 0,
                time = 0, type = "unknown", accountId = "", reason = "", source = "", uploadPayload = null, status = "ignored")) }
        }
    }
}
