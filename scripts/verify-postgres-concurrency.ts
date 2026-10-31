import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Pool, type PoolConfig } from 'pg';
import { bookkeeping, saveBills, type Bill, type BillChange, type BillContent } from '../server/bookkeeping.js';
import { ledger } from '../server/ledger.js';
import { LedgerError, write } from '../server/ledger-write.js';
import { handle } from '../server/http.js';
import { hashPassword, issueSession } from '../server/auth.js';

// Run: node_modules/.bin/tsx scripts/verify-postgres-concurrency.ts
// Optional: BOOKKEEPING_TEST_DATABASE_URL must explicitly name a loopback
// bookkeeping_test_* database. DATABASE_URL and application configuration are never read.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runId = randomUUID().replaceAll('-', '');
const schema = `bookkeeping_concurrency_${runId}`;
const application = `bookkeeping-sidecar-${runId}`;
const local = join(root, '.local');
const exec = promisify(execFile);
const subprocessEnv = Object.fromEntries(['PATH', 'TMPDIR', 'HOME', 'USER', 'LOGNAME', 'SYSTEMROOT'].flatMap(key =>
  process.env[key] === undefined ? [] : [[key, process.env[key]]]));
const quoted = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
let phase = 'setup';

async function command(file: string, args: string[]): Promise<void> {
  try {
    const result = await exec(file, args, { env: { ...subprocessEnv, LC_ALL: 'C' }, timeout: 60_000, maxBuffer: 1024 * 1024 });
    await appendFile(join(local, `pg-setup-${runId}.log`), result.stdout + result.stderr);
  } catch (error) {
    const output = error as { stdout?: string; stderr?: string };
    await appendFile(join(local, `pg-setup-${runId}.log`), (output.stdout ?? '') + (output.stderr ?? ''));
    throw error;
  }
}

async function postgresBin(): Promise<string> {
  const candidates: string[] = [];
  for (const base of ['/opt/homebrew/opt', '/usr/local/opt']) {
    for (const name of await readdir(base).catch(() => [])) {
      if (/^postgresql(?:@\d+)?$/.test(name)) candidates.push(join(base, name, 'bin'));
    }
  }
  for (const name of await readdir(local).catch(() => [])) {
    if (!name.startsWith('pg-')) continue;
    candidates.push(join(local, name, 'bin'));
    for (const version of ['18', '17', '16', '15', '14']) {
      candidates.push(join(local, name, 'Postgres.app', 'Contents', 'Versions', version, 'bin'));
    }
  }
  for (const candidate of candidates) {
    try {
      await Promise.all(['postgres', 'initdb', 'pg_ctl'].map(name => access(join(candidate, name))));
      return candidate;
    } catch { /* Try the next known local installation. */ }
  }
  throw new Error('No local PostgreSQL binaries found; install into ignored .local/pg-tooling/bin.');
}

function testUrl(value: string): PoolConfig {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid explicit test database URL.'); }
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'Test URL must use PostgreSQL.');
  assert.ok(['127.0.0.1', '[::1]'].includes(url.hostname), 'Test URL must use a literal loopback address.');
  const database = decodeURIComponent(url.pathname.slice(1));
  assert.match(database, /^bookkeeping_test_[a-z0-9_]+$/, 'Refusing a database without the bookkeeping_test_ prefix.');
  assert.ok(Number(url.port) >= 1024 && Number(url.port) <= 65535, 'An explicit unprivileged test port is required.');
  assert.ok(url.username && !url.search && !url.hash, 'Explicit user required; URL options are forbidden.');
  const password = decodeURIComponent(url.password);
  return {
    host: url.hostname === '[::1]' ? '::1' : url.hostname,
    port: Number(url.port), database, user: decodeURIComponent(url.username),
    password: async () => password, ssl: false,
  };
}

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolveListen, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolveListen);
  });
  const address = socket.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done, reject) => socket.close(error => error ? reject(error) : done()));
  return address.port;
}

async function database(): Promise<{ config: PoolConfig; stop: () => Promise<void> }> {
  const explicit = process.env.BOOKKEEPING_TEST_DATABASE_URL;
  if (explicit !== undefined) return { config: testUrl(explicit), stop: async () => {} };
  phase = 'locate local PostgreSQL binaries';
  const bin = await postgresBin();
  const data = join(local, `pg-cluster-${runId}`);
  const log = join(local, `pg-server-${runId}.log`);
  const port = await freePort();
  await mkdir(local, { recursive: true });
  phase = 'initialize isolated PostgreSQL cluster (diagnostics: .local/pg-setup-*.log)';
  await command(join(bin, 'initdb'), ['-D', data, '-U', 'bookkeeping_sidecar', '-A', 'trust', '--no-locale', '-E', 'UTF8']);
  const stop = () => command(join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop']);
  try {
    phase = 'start isolated PostgreSQL cluster (diagnostics: .local/pg-server-*.log)';
    await command(join(bin, 'pg_ctl'), ['-D', data, '-l', log, '-w', '-t', '20', '-o',
      `-h 127.0.0.1 -p ${port} -k '' -c max_connections=16 -c fsync=on -c log_statement=none`, 'start']);
    const config: PoolConfig = {
      host: '127.0.0.1', port, database: `bookkeeping_test_${runId}`,
      user: 'bookkeeping_sidecar', password: async () => '', ssl: false,
    };
    const admin = new Pool({ ...config, database: 'postgres', options: '-c search_path=pg_catalog', connectionTimeoutMillis: 5000 });
    try { await admin.query(`CREATE DATABASE ${quoted(String(config.database))}`); }
    finally { await admin.end(); }
    process.stdout.write(`Local PostgreSQL cluster started on loopback port ${port}; data/logs: .local/pg-*.\n`);
    return { config, stop };
  } catch (error) {
    // A partially started owned cluster must also be stopped.
    await stop().catch(() => {});
    throw error;
  }
}

async function until(predicate: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 7000;
  do {
    if (await predicate()) return;
    await delay(15);
  } while (Date.now() < deadline);
  assert.fail(message);
}

function deferred() {
  let resolvePromise!: () => void;
  const promise = new Promise<void>(done => { resolvePromise = done; });
  return { promise, resolve: resolvePromise };
}

interface Snapshot {
  accounts: { id: string; balance: string | null }[];
  bills: Bill[];
  sequence: string;
}
interface ChangeRow { sequence: string; billId: string; snapshot: Bill }
interface BalanceHistoryRow {
  sequence: string;
  billId: string | null;
  deltaCents: number | null;
  balanceAfterCents: number | null;
  reason: string;
  note: string;
}
interface SyncPage {
  changes: { sequence: string; entityType: string; entityId: string; snapshot: Record<string, unknown> }[];
  nextSequence: string;
  hasMore: boolean;
  accounts: Snapshot['accounts'];
  categories: unknown[];
  tags: unknown[];
  fetchedAt: number;
}

async function verify(pool: Pool): Promise<void> {
  const q = new URLSearchParams();
  const call = (route: string, body?: unknown, query = q) => bookkeeping(pool, `v2/${route}`, body, query);
  const auth = { username: 'concurrency-sidecar', passwordHash: hashPassword(randomUUID()), secret: randomUUID().repeat(2) };
  const cookie = `money_session=${issueSession(auth)}`;
  const syncResponse = (after: string, count = 2) => handle(new Request(
    `http://127.0.0.1/api/v2/sync/changes.json?${new URLSearchParams({ after, count: String(count) })}`,
    { headers: { cookie } },
  ), { pool, auth });
  const syncPage = async (after: string, count = 2): Promise<SyncPage> => {
    const response = await syncResponse(after, count);
    assert.equal(response.status, 200, 'Sync GET must return HTTP 200.');
    const envelope = await response.json() as { success: boolean; result: SyncPage };
    assert.equal(envelope.success, true, 'Sync must use the normal success envelope.');
    assert.ok(envelope.result && Array.isArray(envelope.result.changes));
    return envelope.result;
  };
  const account = await ledger(pool, 'v1/accounts/add', {
    name: 'Concurrency sidecar', category: 2, currency: 'CNY', balance: '1000000', clientSessionId: randomUUID(),
  }, q) as { id: string };
  const category = (await pool.query<{ id: string }>('SELECT id::text FROM money_categories WHERE type=2 AND active ORDER BY id LIMIT 1')).rows[0];
  assert.ok(category, 'Expense fixture category must exist.');
  const content: BillContent = {
    kind: 'expense', amountCents: 100, accountId: account.id, categoryId: category.id,
    occurredAt: Date.parse('2026-10-29T04:00:00Z'), merchant: 'Synthetic concurrency fixture',
    note: '', tagIds: [], excludeFromStatistics: false, excludeFromBudget: false,
  };
  const payload = (patch: Partial<BillChange> = {}) => ({
    operationId: randomUUID(), billId: randomUUID(), expectedVersion: 0,
    action: 'save' as const, status: 'posted' as const, content: { ...content }, ...patch,
  });
  const submit = (body: ReturnType<typeof payload>) => call('bills/submit', body) as Promise<Bill>;
  const balance = async () => BigInt((await pool.query<{ balance: string }>(
    'SELECT balance::text FROM money_accounts WHERE id=$1', [account.id])).rows[0].balance);
  const sequence = async () => (await pool.query<{ sequence: string }>(
    'SELECT sequence::text FROM money_ledger_state WHERE id=1')).rows[0].sequence;
  const footprint = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM money_bills) AS bills,
    (SELECT count(*)::int FROM money_transactions) AS projections,
    (SELECT count(*)::int FROM money_balance_history) AS histories,
    (SELECT count(*)::int FROM money_changes) AS changes,
    (SELECT count(*)::int FROM money_requests) AS requests,
    (SELECT count(*)::int FROM money_bill_sources) AS sources`)).rows[0] as Record<string, number>;
  const blocked = async (count: number, advisory = false) => until(async () => {
    const rows = (await pool.query<{ count: number }>(`SELECT count(DISTINCT pid)::int AS count
      FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1
      AND state='active' AND wait_event_type='Lock'
      AND ${advisory ? "wait_event='advisory'" : "query LIKE 'SELECT sequence FROM money_ledger_state%' AND cardinality(pg_blocking_pids(pid))>0"}`,
    [application])).rows;
    return rows[0].count >= count;
  }, `Expected ${count} independently blocked PostgreSQL backend(s).`);

  // Hold the real ledger row until both production calls have reached PostgreSQL.
  async function race<T>(actions: (() => Promise<T>)[]): Promise<PromiseSettledResult<T>[]> {
    const gate = await pool.connect();
    let results: Promise<PromiseSettledResult<T>[]> | undefined;
    try {
      await gate.query('BEGIN');
      await gate.query('SELECT sequence FROM money_ledger_state WHERE id=1 FOR UPDATE');
      results = Promise.allSettled(actions.map(action => action()));
      await blocked(actions.length);
    } finally {
      await gate.query('ROLLBACK');
      gate.release();
      // Drain all launched work even if the overlap assertion fails.
      if (results) await results;
    }
    assert.ok(results);
    return results;
  }
  function winner(results: PromiseSettledResult<Bill>[], status: number, code?: string): Bill {
    const successful = results.filter((result): result is PromiseFulfilledResult<Bill> => result.status === 'fulfilled');
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.equal(successful.length, 1, 'Exactly one contender must commit.');
    assert.equal(rejected.length, 1, 'Exactly one contender must fail.');
    assert.ok(rejected[0].reason instanceof LedgerError, 'Loser must be a domain error, not a broken connection.');
    assert.equal(rejected[0].reason.status, status);
    if (code) assert.equal(rejected[0].reason.code, code);
    return successful[0].value;
  }
  const passed = (name: string) => process.stdout.write(`PASS ${name}\n`);

  phase = 'independent pool clients';
  const clients = await Promise.all([pool.connect(), pool.connect()]);
  try {
    const identities = await Promise.all(clients.map(client => client.query(`SELECT pg_backend_pid() AS pid,
      current_database() AS database,current_schema() AS schema,inet_server_addr()::text AS address`)));
    assert.notEqual(identities[0].rows[0].pid, identities[1].rows[0].pid, 'Pool must use independent server sessions.');
    for (const identity of identities) {
      assert.equal(identity.rows[0].schema, schema, 'Every connection must use the isolated schema.');
      assert.equal(identity.rows[0].database, pool.options.database);
      assert.ok(['127.0.0.1/32', '127.0.0.1', '::1/128', '::1'].includes(identity.rows[0].address));
    }
  } finally { clients.forEach(client => client.release()); }
  passed(phase);

  phase = 'duplicate operation: one result, balance mutation, projection, history and change';
  {
    const before = await footprint();
    const startingBalance = await balance();
    const body = payload();
    const results = await race([() => submit(body), () => submit(body)]);
    assert.ok(results.every(result => result.status === 'fulfilled'), 'Identical concurrent retries must both succeed.');
    const bills = results.map(result => (result as PromiseFulfilledResult<Bill>).value);
    assert.deepEqual(bills[0], bills[1], 'Retries must return the exact committed result.');
    assert.equal(bills[0].version, 1);
    assert.deepEqual(bills[0].appliedEffect, { [account.id]: -100 });
    assert.deepEqual(bills[0].restoreEffect, bills[0].appliedEffect);
    assert.equal(await balance(), startingBalance - 100n);
    assert.deepEqual(await footprint(), {
      ...before, bills: before.bills + 1, projections: before.projections + 1,
      histories: before.histories + 1, changes: before.changes + 1, requests: before.requests + 1,
    });
    await assert.rejects(submit({ ...body, content: { ...content, amountCents: 101 } }),
      (error: unknown) => error instanceof LedgerError && error.status === 409);
    assert.deepEqual(await submit(body), bills[0], 'A rejected changed-payload replay must preserve the original result.');
  }
  passed(phase);

  phase = 'same expectedVersion, different operations: one success and one 409';
  {
    const original = await submit(payload());
    const before = await footprint();
    const startingBalance = await balance();
    const bodies = [200, 300].map(amountCents => payload({
      billId: original.billId, expectedVersion: original.version, content: { ...content, amountCents },
    }));
    const committed = winner(await race(bodies.map(body => () => submit(body))), 409, 'VERSION_CONFLICT');
    assert.equal(committed.version, original.version + 1);
    assert.equal(await balance(), startingBalance + 100n - BigInt(committed.content.amountCents!));
    assert.deepEqual(await footprint(), {
      ...before, histories: before.histories + 1, changes: before.changes + 1, requests: before.requests + 1,
    });
    const loser = bodies.find(body => body.content.amountCents !== committed.content.amountCents)!;
    assert.equal((await pool.query('SELECT 1 FROM money_requests WHERE key=$1',
      [`import:bookkeeping:${loser.operationId}`])).rowCount, 0, 'Failed optimistic edit must leave no idempotency reservation.');
  }
  passed(phase);

  phase = 'source identity conflict: loser rolls back bill, projection, history and request';
  {
    const before = await footprint();
    const startingBalance = await balance();
    const sources = [{ app: 'sidecar', key: randomUUID(), capturedAt: content.occurredAt, ruleVersion: '1' }];
    const bodies = [payload({ sources }), payload({ sources })];
    const committed = winner(await race(bodies.map(body => () => submit(body))), 409, 'SOURCE_CONFLICT');
    const loser = bodies.find(body => body.billId !== committed.billId)!;
    assert.equal(await balance(), startingBalance - 100n);
    assert.deepEqual(await footprint(), Object.fromEntries(Object.entries(before).map(([key, value]) => [key, value + 1])));
    for (const [sql, params] of [
      ['SELECT 1 FROM money_bills WHERE id=$1', [loser.billId]],
      ['SELECT 1 FROM money_changes WHERE bill_id=$1', [loser.billId]],
      ['SELECT 1 FROM money_balance_history WHERE bill_id=$1', [loser.billId]],
      ['SELECT 1 FROM money_requests WHERE key=$1', [`import:bookkeeping:${loser.operationId}`]],
    ] as const) assert.equal((await pool.query(sql, [...params])).rowCount, 0, 'Source loser left transactional residue.');
    assert.equal((await pool.query('SELECT bill_id FROM money_bill_sources WHERE app=$1 AND key=$2',
      [sources[0].app, sources[0].key])).rows[0].bill_id, committed.billId);
    assert.equal((await submit({ ...loser, sources: [{ ...sources[0], key: randomUUID() }] })).version, 1,
      'Rolled-back bill and operation IDs must remain usable.');
  }
  passed(phase);

  phase = 'refund race: total never exceeds the original expense';
  {
    const expense = await submit(payload({ content: { ...content, amountCents: 1000 } }));
    const before = await footprint();
    const startingBalance = await balance();
    const refunds = [600, 700].map(amountCents => payload({
      content: { ...content, kind: 'refund', amountCents, refundOfBillId: expense.billId },
    }));
    const committed = winner(await race(refunds.map(body => () => submit(body))), 400);
    const total = (await pool.query<{ total: string; count: number }>(`SELECT
      coalesce(sum((content->>'amountCents')::bigint),0)::text AS total,count(*)::int AS count
      FROM money_bills WHERE status='posted' AND content->>'refundOfBillId'=$1`, [expense.billId])).rows[0];
    assert.equal(total.count, 1);
    assert.equal(BigInt(total.total), BigInt(committed.content.amountCents!));
    assert.ok(BigInt(total.total) <= 1000n);
    assert.equal(await balance(), startingBalance + BigInt(total.total));
    assert.deepEqual(await footprint(), {
      ...before, bills: before.bills + 1, histories: before.histories + 1,
      changes: before.changes + 1, requests: before.requests + 1,
    });
    await submit(payload({ content: {
      ...content, kind: 'refund', amountCents: 1000 - Number(total.total), refundOfBillId: expense.billId,
    } }));
    await assert.rejects(submit(payload({ content: {
      ...content, kind: 'refund', amountCents: 1, refundOfBillId: expense.billId,
    } })), (error: unknown) => error instanceof LedgerError && error.status === 400);
    assert.equal(await balance(), startingBalance + 1000n, 'Refund boundary must be exact.');
  }
  passed(phase);

  const page = async (after: string, count = 2): Promise<ChangeRow[]> => (await pool.query<ChangeRow>(
    'SELECT c.sequence::text,c.bill_id AS "billId",c.snapshot FROM money_changes c WHERE c.sequence>$1 ORDER BY c.sequence LIMIT $2',
    [after, count])).rows;
  phase = 'commit sequence: paused older write cannot be skipped by paged catch-up';
  {
    const start = await sequence();
    const entered = deferred();
    const release = deferred();
    const body = payload();
    const first = write(pool, `sidecar:${randomUUID()}`, 'sidecar/commit-order', body, async client => {
      const bill = (await saveBills(client, [body]))[0];
      entered.resolve();
      await release.promise;
      return bill;
    }) as Promise<Bill>;
    const firstResult = Promise.allSettled([first]);
    let secondResult: Promise<PromiseSettledResult<Bill>[]> | undefined;
    try {
      await Promise.race([entered.promise, first.then(() => assert.fail('Writer did not pause.'))]);
      secondResult = Promise.allSettled([submit(payload())]);
      await blocked(1);
      assert.deepEqual(await page(start), [], 'Uncommitted changes must not leak into catch-up.');
      assert.equal(await sequence(), start, 'Cursor must not advance past an uncommitted writer.');
    } finally {
      release.resolve();
      await firstResult;
      if (secondResult) await secondResult;
    }
    const [older] = await firstResult;
    assert.equal(older.status, 'fulfilled');
    assert.ok(secondResult);
    const [newer] = await secondResult;
    assert.equal(newer.status, 'fulfilled');
    if (older.status !== 'fulfilled' || newer.status !== 'fulfilled') assert.fail('Commit contenders failed.');
    assert.ok(BigInt(older.value.changeSequence) < BigInt(newer.value.changeSequence));
    const bodies = Array.from({ length: 12 }, () => payload());
    const pending = Promise.all(bodies.map(body => submit(body)));
    const pendingResult = Promise.allSettled([pending]);
    const seen: ChangeRow[] = [];
    let cursor = start;
    try {
      // Start paging while additional independent writers are still active.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const rows = await page(cursor);
        for (const row of rows) {
          assert.equal(BigInt(row.sequence), BigInt(cursor) + 1n, 'A committed change was skipped.');
          assert.equal(row.snapshot.changeSequence, row.sequence);
          seen.push(row);
          cursor = row.sequence;
        }
        if (seen.length === bodies.length + 2) break;
        await delay(5);
      }
    } finally { await pendingResult; }
    const written = await pending;
    assert.equal(seen.length, bodies.length + 2, 'Paged catch-up must include every successful operation.');
    assert.equal(new Set(seen.map(row => row.sequence)).size, seen.length, 'Catch-up repeated a sequence.');
    assert.deepEqual(new Set(seen.map(row => row.billId)), new Set([
      older.value.billId, newer.value.billId, ...written.map(bill => bill.billId),
    ]));
    assert.deepEqual(seen, await page(start, 100), 'Paged results must equal the committed change log.');
    assert.equal(cursor, await sequence());
    assert.deepEqual(await page(cursor), [], 'Catch-up at the final cursor must be empty.');
  }
  passed(phase);

  phase = 'balance history: more than nine rows use numeric sequence order';
  {
    const expected = (await pool.query<BalanceHistoryRow>(`SELECT h.sequence::text,
      h.bill_id AS "billId",h.delta::float8 AS "deltaCents",h.balance_after::float8 AS "balanceAfterCents",
      h.reason,h.note FROM money_balance_history h WHERE h.account_id=$1 ORDER BY h.sequence`, [account.id])).rows;
    assert.ok(expected.length > 9, 'History ordering regression requires more than nine actual ledger mutations.');
    const numeric = expected.map(row => row.sequence);
    const lexical = (await pool.query<{ sequence: string }>(`SELECT h.sequence::text AS sequence
      FROM money_balance_history h WHERE h.account_id=$1 ORDER BY sequence`, [account.id])).rows.map(row => row.sequence);
    assert.notDeepEqual(lexical, numeric, 'History fixture must expose the text-alias ordering trap.');
    process.stdout.write(`History ordering negative control: ${expected.length} rows distinguish text and bigint order.\n`);
    const response = await handle(new Request(
      `http://127.0.0.1/api/v2/accounts/history.json?${new URLSearchParams({ accountId: account.id })}`,
      { headers: { cookie } },
    ), { pool, auth });
    assert.equal(response.status, 200, 'Account history GET must return HTTP 200.');
    const envelope = await response.json() as { success: boolean; result: BalanceHistoryRow[] };
    assert.equal(envelope.success, true);
    assert.deepEqual(envelope.result.map(row => row.sequence), numeric,
      'Account history GET must order sequences numerically across digit boundaries.');
    assert.deepEqual(envelope.result, expected, 'History endpoint must preserve every committed mutation and its balance.');
    for (let index = 1; index < envelope.result.length; index += 1) {
      assert.ok(BigInt(envelope.result[index - 1].sequence) < BigInt(envelope.result[index].sequence),
        'History sequences must increase strictly as bigints.');
    }
    assert.equal(envelope.result.at(-1)!.balanceAfterCents, Number(await balance()),
      'The final history entry must report the current account balance.');
  }
  passed(phase);

  async function verifySync() {
    phase = 'sync GET envelope: paged catch-up includes master events and every committed bill';
    const expected = (await pool.query<{ sequence: string; entityType: string; entityId: string }>(`SELECT c.sequence::text,
      c.entity_type AS "entityType",coalesce(c.entity_id,c.bill_id::text) AS "entityId" FROM money_changes c ORDER BY c.sequence`)).rows;
    const received: typeof expected = [];
    let cursor = '0';
    let pages = 0;
    while (pages < expected.length + 1) {
      const response = await syncPage(cursor);
      pages += 1;
      assert.ok(response.changes.length <= 2);
      assert.ok(Number.isFinite(response.fetchedAt));
      assert.ok(Array.isArray(response.categories) && Array.isArray(response.tags));
      assert.equal(response.accounts.find(item => item.id === account.id)?.balance, String(await balance()));
      for (const event of response.changes) {
        assert.ok(BigInt(event.sequence) > BigInt(cursor), 'Sync events must advance the cursor.');
        received.push({ sequence: event.sequence, entityType: event.entityType, entityId: event.entityId });
        cursor = event.sequence;
      }
      assert.equal(response.nextSequence, cursor, 'Sync cursor must end at the last returned committed event.');
      if (!response.hasMore) break;
      assert.equal(response.changes.length, 2, 'Non-tail pages must be full.');
    }
    assert.ok(pages > 1, 'The HTTP verification must actually page.');
    assert.deepEqual(received, expected, 'Sync GET omitted or duplicated a committed entity change.');
    assert.ok(received.some(event => event.entityType === 'account' && event.entityId === account.id),
      'Account creation must publish a master-data event.');
    assert.equal(cursor, await sequence());
    const tail = await syncPage(cursor);
    assert.deepEqual(tail.changes, []);
    assert.equal(tail.hasMore, false);
    assert.equal(tail.nextSequence, cursor, 'Empty polling must retain the tail cursor.');
    assert.equal((await syncResponse('-1')).status, 400);
    assert.equal((await syncResponse(cursor, 0)).status, 400);
    const invalid = await syncResponse(String(BigInt(cursor) + 1n));
    assert.equal(invalid.status, 409);
    assert.equal((await invalid.json() as { errorCode: string }).errorCode, 'CURSOR_INVALID');
    passed(phase);
  }

  phase = 'pool MVCC: snapshot stays coherent across a concurrent commit';
  {
    const before = await call('snapshot') as Snapshot;
    const gate = await pool.connect();
    const lockId = String(BigInt(`0x${runId.slice(0, 12)}`));
    const body = payload({ content: { ...content, amountCents: 123 } });
    let snapshotResult: Promise<PromiseSettledResult<Snapshot>[]> | undefined;
    let syncResult: Promise<PromiseSettledResult<SyncPage>[]> | undefined;
    let viewCreated = false;
    try {
      // Gate only collection reads: PostgreSQL may evaluate view expressions
      // during writes even when the writer does not request the name column.
      await pool.query(`CREATE FUNCTION sidecar_snapshot_name(value text) RETURNS text LANGUAGE plpgsql VOLATILE AS $$
        BEGIN
          IF position(' AS accounts' IN current_query())>0 THEN
            PERFORM pg_advisory_xact_lock(${lockId}::bigint);
          END IF;
          RETURN value;
        END $$`);
      await pool.query('ALTER TABLE money_accounts RENAME TO sidecar_accounts_base');
      const columns = (await pool.query<{ attname: string }>(`SELECT attname FROM pg_attribute
        WHERE attrelid='sidecar_accounts_base'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`)).rows;
      await pool.query(`CREATE VIEW money_accounts AS SELECT ${columns.map(column => column.attname === 'name'
        ? 'sidecar_snapshot_name(name) AS name' : quoted(column.attname)).join(',')} FROM sidecar_accounts_base`);
      viewCreated = true;
      await gate.query('SELECT pg_advisory_lock($1::bigint)', [lockId]);
      snapshotResult = Promise.allSettled([call('snapshot') as Promise<Snapshot>]);
      syncResult = Promise.allSettled([syncPage(before.sequence)]);
      await blocked(2, true);
      const saved = await submit(body);
      assert.ok(BigInt(saved.changeSequence) > BigInt(before.sequence), 'Writer must commit while snapshot is paused.');
      await gate.query('SELECT pg_advisory_unlock($1::bigint)', [lockId]);
      const [result] = await snapshotResult;
      assert.equal(result.status, 'fulfilled');
      if (result.status !== 'fulfilled') assert.fail('Snapshot query failed.');
      assert.equal(result.value.sequence, before.sequence, 'Snapshot cursor mixed commit generations.');
      assert.deepEqual(result.value.accounts, before.accounts, 'Snapshot balances mixed commit generations.');
      assert.deepEqual(result.value.bills, before.bills, 'Snapshot bills mixed commit generations.');
      assert.equal(result.value.bills.some(bill => bill.billId === body.billId), false);
      const [sync] = await syncResult;
      assert.equal(sync.status, 'fulfilled');
      if (sync.status !== 'fulfilled') assert.fail('Sync MVCC query failed.');
      assert.deepEqual(sync.value.changes, [], 'Sync page included a post-snapshot write.');
      assert.equal(sync.value.nextSequence, before.sequence, 'Sync page cursor mixed commit generations.');
      assert.deepEqual(sync.value.accounts, before.accounts, 'Sync metadata mixed commit generations.');
      assert.equal(sync.value.hasMore, false);
      const after = await call('snapshot') as Snapshot;
      assert.equal(after.sequence, saved.changeSequence);
      assert.equal(after.bills.find(bill => bill.billId === body.billId)?.version, 1);
      assert.equal(BigInt(after.accounts.find(item => item.id === account.id)!.balance!),
        BigInt(before.accounts.find(item => item.id === account.id)!.balance!) - 123n);
    } finally {
      await gate.query('SELECT pg_advisory_unlock_all()');
      gate.release();
      if (snapshotResult) await snapshotResult;
      if (syncResult) await syncResult;
      if (viewCreated) await pool.query('DROP VIEW money_accounts');
      if (viewCreated) await pool.query('ALTER TABLE sidecar_accounts_base RENAME TO money_accounts');
      await pool.query('DROP FUNCTION IF EXISTS sidecar_snapshot_name(text)');
    }
  }
  passed(phase);
  await verifySync();
}

async function main(): Promise<void> {
  const db = await database();
  const pool = new Pool({
    ...db.config, min: 2, max: 8, connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000,
    application_name: application,
    options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=20000`,
  });
  let idleError: Error | undefined;
  pool.on('error', error => { idleError = error; });
  let schemaCreated = false;
  try {
    const identity = (await pool.query(`SELECT current_database() AS database,inet_server_addr()::text AS address,
      current_setting('server_version_num')::int AS version`)).rows[0];
    assert.equal(identity.database, db.config.database, 'Unexpected database identity.');
    assert.match(identity.database, /^bookkeeping_test_[a-z0-9_]+$/);
    assert.ok(['127.0.0.1', '127.0.0.1/32', '::1', '::1/128'].includes(identity.address), 'Server must actually be loopback.');
    assert.ok(identity.version >= 140000, 'Real PostgreSQL 14+ is required.');
    phase = 'initialize random test schema from current init.sql';
    await pool.query(`CREATE SCHEMA ${quoted(schema)}`);
    schemaCreated = true;
    const initializer = await pool.connect();
    try { await initializer.query(await readFile(join(root, 'doc/sql/init.sql'), 'utf8')); }
    catch (error) {
      await initializer.query('ROLLBACK');
      throw error;
    } finally { initializer.release(); }
    await verify(pool);
    if (idleError) throw idleError;
  } finally {
    try {
      if (schemaCreated) {
        await pool.query(`DROP SCHEMA ${quoted(schema)} CASCADE`);
        assert.equal((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount, 0);
        process.stdout.write('Isolated test schema dropped.\n');
      }
    } finally {
      try { await pool.end(); }
      finally { await db.stop(); }
    }
  }
  process.stdout.write(`PostgreSQL concurrency verification passed${process.env.BOOKKEEPING_TEST_DATABASE_URL === undefined
    ? '; owned cluster stopped' : '; explicit test database left running'}.\n`);
}

main().catch(error => {
  // Never print driver messages, URLs, SQL parameters, or credentials.
  const code = error instanceof LedgerError ? error.code
    : error && typeof error === 'object' && 'code' in error ? String(error.code) : error instanceof Error ? error.name : 'UNKNOWN';
  const assertion = error instanceof assert.AssertionError ? `: ${error.message}` : '';
  process.stderr.write(`FAIL ${phase} [${code}]${assertion}\n`);
  process.exitCode = 1;
});
