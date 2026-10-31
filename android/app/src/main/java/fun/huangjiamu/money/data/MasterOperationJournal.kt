package `fun`.huangjiamu.money.data

import androidx.room.withTransaction
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject

data class PendingMasterRequest(
    val operationId: String,
    val body: String,
    val createdAt: Long,
    val lastStatus: Int? = null,
    val lastError: String = "",
    val readError: String = "",
)

/** A write-ahead journal in the existing master table, separate from published metadata. */
class MasterOperationJournal(private val db: LedgerDatabase) {
    private val dao = db.bookkeeping()
    private val gate = Mutex()

    suspend fun execute(payload: JSONObject, send: suspend (JSONObject) -> JSONObject): JSONObject {
        val body = payload.toString()
        val operationId = JSONObject(body).getString("operationId")
        require(operationId.isNotBlank()) { "主数据请求缺少操作编号" }
        return gate.withLock {
            val frozen = storage("准备主数据请求失败，未发送到云端") {
                db.withTransaction {
                    val rows = dao.masters().filter { it.kind == KIND }
                    val existing = rows.find { it.id == operationId }
                    if (existing != null) {
                        val saved = decode(existing)
                        check(saved.readError.isBlank()) { saved.readError }
                        check(saved.body == body) { "同一操作编号的请求内容已冻结，不能修改" }
                        saved
                    } else {
                        check(rows.isEmpty()) { "请先在‘我的’恢复尚未确认的主数据请求，避免重复创建" }
                        PendingMasterRequest(operationId, body, System.currentTimeMillis()).also {
                            dao.saveMasters(listOf(encode(it)))
                        }
                    }
                }
            }
            // No database transaction spans the HTTP call. A crash here leaves the original body replayable.
            val response = try {
                send(JSONObject(frozen.body))
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (failure: Exception) {
                if (isDefinitive(failure)) {
                    storage("云端已拒绝，但本机请求日志未能清理，请重试原请求确认") {
                        dao.removeMaster(KIND, operationId)
                    }
                } else {
                    storage("请求结果未确认，错误状态保存失败；原请求仍保留，请重试") {
                        dao.saveMasters(listOf(encode(frozen.copy(
                            lastStatus = (failure as? ApiException)?.status,
                            lastError = failure.message ?: "网络不可用",
                        ))))
                    }
                }
                throw failure
            }
            storage("云端已确认，但本机请求日志未能清理，请重试原请求确认") {
                dao.removeMaster(KIND, operationId)
            }
            response
        }
    }

    private suspend fun <T> storage(message: String, action: suspend () -> T): T = try {
        action()
    } catch (cancel: CancellationException) {
        throw cancel
    } catch (failure: Exception) {
        throw IllegalStateException("$message：${failure.message}", failure)
    }

    companion object {
        const val KIND = "master-request"

        fun pending(records: List<MasterRecord>): List<PendingMasterRequest> =
            records.filter { it.kind == KIND }.map { decode(it) }.sortedWith(
                compareBy<PendingMasterRequest> { it.createdAt }.thenBy { it.operationId })

        fun isDefinitive(failure: Exception): Boolean = failure is ApiException &&
            failure.status in 400..499 && failure.status !in listOf(401, 403, 408, 429)

        private fun encode(request: PendingMasterRequest): MasterRecord = MasterRecord(KIND, request.operationId,
            JSONObject().put("body", request.body).put("createdAt", request.createdAt)
                .put("lastStatus", request.lastStatus ?: JSONObject.NULL).put("lastError", request.lastError).toString())

        private fun decode(record: MasterRecord): PendingMasterRequest = try {
            val saved = JSONObject(record.json)
            val body = saved.getString("body")
            check(JSONObject(body).getString("operationId") == record.id) { "操作编号不一致" }
            PendingMasterRequest(record.id, body, saved.getLong("createdAt"),
                if (saved.isNull("lastStatus")) null else saved.getInt("lastStatus"), saved.optString("lastError"))
        } catch (failure: Exception) {
            // Keep malformed rows visible and block new writes; silently dropping one could duplicate a cloud write.
            PendingMasterRequest(record.id, record.json, 0, readError = "本机冻结请求无法读取：${failure.message}")
        }
    }
}
