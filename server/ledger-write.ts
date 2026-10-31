import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export class LedgerError extends Error {
  constructor(
    message: string, public readonly status = 400,
    public readonly code = status === 409 ? 'CONFLICT' : status === 404 ? 'NOT_FOUND' : 'INVALID_INPUT',
  ) { super(message); }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .filter(([, item]) => item !== undefined).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export async function expireDeleted(client: PoolClient, now = Date.now()): Promise<void> {
  const expired = await client.query<{ id: string; legacyId: string | null; version: number; deletedAt: number }>(`WITH expired AS MATERIALIZED (
    SELECT id,legacy_id,version,deleted_at FROM money_bills
    WHERE status='deleted' AND deleted_at<=$1 AND content<>'{}'::jsonb
  ), scrub_requests AS (
    UPDATE money_requests r SET response=jsonb_build_object('billId',b.id,'legacyId',b.legacy_id::text,
      'version',b.version,'status','deleted','deletedAt',b.deleted_at,'expired',true)
    FROM expired b WHERE r.response->>'billId'=b.id::text OR
      (r.response->>'timeSequenceId'=b.legacy_id::text AND r.response ? 'sourceAccountId')
    RETURNING r.key
  ), scrub_changes AS (
    UPDATE money_changes c SET snapshot=jsonb_build_object('billId',b.id,'legacyId',b.legacy_id::text,'version',b.version,
      'status','deleted','deletedAt',b.deleted_at,'changeSequence',c.sequence::text,'expired',true)
    FROM expired b WHERE c.bill_id=b.id RETURNING c.sequence
  ), scrub_projection AS (
    DELETE FROM money_transactions t USING expired b WHERE t.id=b.legacy_id RETURNING t.id
  )
  UPDATE money_bills b SET content='{}',applied_effect='{}',restore_effect='{}'
  FROM expired e WHERE b.id=e.id
  RETURNING b.id,b.legacy_id::text AS "legacyId",b.version,b.deleted_at::float8 AS "deletedAt"`, [now - 30 * 86400000]);
  if (!expired.rows.length) return;
  const end = (await client.query<{ sequence: string }>(
    'UPDATE money_ledger_state SET sequence=sequence+$1 WHERE id=1 RETURNING sequence::text',
    [expired.rows.length],
  )).rows[0].sequence;
  const start = BigInt(end) - BigInt(expired.rows.length);
  const tombstones = expired.rows.map((bill, i) => ({
    billId: bill.id, legacyId: bill.legacyId, version: bill.version, status: 'deleted', deletedAt: bill.deletedAt,
    changeSequence: String(start + BigInt(i) + 1n), expired: true,
  }));
  await client.query(`INSERT INTO money_changes(sequence,bill_id,snapshot)
    SELECT (r.value->>'changeSequence')::bigint,(r.value->>'billId')::uuid,r.value
    FROM jsonb_array_elements($1::jsonb) AS r(value)`, [JSON.stringify(tombstones)]);
}

export async function cleanupExpired(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT sequence FROM money_ledger_state WHERE id=1 FOR UPDATE');
    await expireDeleted(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function write(
  pool: Pool, key: string, route: string, payload: unknown,
  action: (client: PoolClient) => Promise<unknown>,
) {
  // Keep the v1 digest stable so requests committed before the upgrade remain retryable.
  const hash = createHash('sha256').update(JSON.stringify(route.startsWith('v1/') ? [route, payload] : canonical([route, payload]))).digest('hex');
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    // The single ledger lock also makes allocated change sequences follow commit order.
    await client.query('SELECT sequence FROM money_ledger_state WHERE id=1 FOR UPDATE');
    await expireDeleted(client);
    await client.query('INSERT INTO money_requests(key,payload_hash) VALUES($1,$2) ON CONFLICT DO NOTHING', [key, hash]);
    const { rows } = await client.query<{ payload_hash: string; response: unknown }>('SELECT payload_hash,response FROM money_requests WHERE key=$1 FOR UPDATE', [key]);
    if (rows[0].payload_hash !== hash) throw new LedgerError('请求编号已用于其他内容', 409);
    let response = rows[0].response;
    if (response === null) {
      response = await action(client);
      await client.query('UPDATE money_requests SET response=$2::jsonb WHERE key=$1', [key, JSON.stringify(response)]);
    }
    await client.query('COMMIT');
    committed = true;
    if (response && typeof response === 'object' && 'expired' in response && response.expired === true) {
      throw new LedgerError('账单已删除且超过恢复期限', 410, 'RECORD_EXPIRED');
    }
    return response;
  } catch (error) {
    if (!committed) await client.query('ROLLBACK');
    if (error && typeof error === 'object' && 'code' in error && ['23514', '22003'].includes(String(error.code))) {
      throw new LedgerError('金额或数据超出允许范围');
    }
    if (error && typeof error === 'object' && 'code' in error && String(error.code) === '23505') {
      throw new LedgerError('记录标识已存在，请刷新后核对', 409);
    }
    throw error;
  } finally { client.release(); }
}
