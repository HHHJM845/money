import type { Pool, PoolClient } from 'pg';
import { LedgerError } from './ledger-write.js';

export const masterCollectionsSql = `
  (SELECT coalesce(jsonb_agg(row_to_json(a)),'[]'::jsonb) FROM
    (SELECT id::text,name,category,1 AS type,currency,balance::text,active,version
     FROM money_accounts ORDER BY id) a) AS accounts,
  (SELECT coalesce(jsonb_agg(row_to_json(c)),'[]'::jsonb) FROM
    (SELECT id::text,name,type,parent_id::text AS "parentId",active,sort_order AS "sortOrder",version
     FROM money_categories ORDER BY sort_order,id) c) AS categories,
  (SELECT coalesce(jsonb_agg(row_to_json(t)),'[]'::jsonb) FROM
    (SELECT id::text,name,active,sort_order AS "sortOrder",version
     FROM money_tags ORDER BY sort_order,id) t) AS tags`;

export async function appendMasterChange(
  client: PoolClient, type: 'account' | 'category' | 'tag', id: string, snapshot: unknown,
): Promise<string> {
  // The caller holds the ledger lock until the entire business operation commits.
  const state = await client.query<{ sequence: string }>(
    'UPDATE money_ledger_state SET sequence=sequence+1 WHERE id=1 RETURNING sequence::text',
  );
  const sequence = state.rows[0].sequence;
  await client.query(
    'INSERT INTO money_changes(sequence,entity_type,entity_id,snapshot) VALUES($1,$2,$3,$4::jsonb)',
    [sequence, type, id, JSON.stringify(snapshot)],
  );
  return sequence;
}

interface Change {
  sequence: string;
  entityType: 'bill' | 'account' | 'category' | 'tag';
  entityId: string;
  snapshot: Record<string, unknown>;
}
interface ReadResult {
  changes: Change[];
  accounts: unknown[];
  categories: unknown[];
  tags: unknown[];
  highWater: string;
  fetchedAt: number;
}

export async function incrementalChanges(pool: Pool, query: URLSearchParams) {
  const after = query.get('after');
  if (after === null || !/^(0|[1-9]\d{0,18})$/.test(after) || BigInt(after) > 9223372036854775807n) {
    throw new LedgerError('同步游标必须为非负整数串');
  }
  const rawCount = query.get('count') ?? '200';
  if (!/^[1-9]\d{0,2}$/.test(rawCount) || Number(rawCount) > 200) throw new LedgerError('同步分页数量需为一至二百');
  const count = Number(rawCount);
  // Metadata and the high-water mark share the same MVCC statement as the event page.
  // Clients stage intermediate pages and publish the metadata only after reaching the tail.
  const row = (await pool.query<ReadResult>(`SELECT ${masterCollectionsSql},
    (SELECT coalesce(jsonb_agg(row_to_json(c) ORDER BY c.ordering),'[]'::jsonb) FROM
      (SELECT sequence AS ordering,sequence::text AS sequence,entity_type AS "entityType",
       coalesce(entity_id,bill_id::text) AS "entityId",snapshot
       FROM money_changes WHERE sequence>$1::bigint ORDER BY money_changes.sequence LIMIT $2) c) AS changes,
    sequence::text AS "highWater",$3::float8 AS "fetchedAt" FROM money_ledger_state WHERE id=1`,
  [after, count + 1, Date.now()])).rows[0];
  if (BigInt(after) > BigInt(row.highWater)) {
    throw new LedgerError('云端账本已恢复或同步游标失效，请重新获取快照', 409, 'CURSOR_INVALID');
  }
  const hasMore = row.changes.length > count;
  const changes = row.changes.slice(0, count).map(({ sequence, entityType, entityId, snapshot }) =>
    ({ sequence, entityType, entityId, snapshot }));
  return {
    changes,
    nextSequence: hasMore ? changes[changes.length - 1].sequence : row.highWater,
    hasMore, accounts: row.accounts, categories: row.categories, tags: row.tags, fetchedAt: row.fetchedAt,
  };
}
