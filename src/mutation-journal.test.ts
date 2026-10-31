import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJournalEntry, journalPrefix, readJournal, removeJournalEntry, saveJournalEntry } from './mutation-journal';

class MemoryStorage implements Storage {
  rows = new Map<string, string>();
  get length() { return this.rows.size; }
  clear() { this.rows.clear(); }
  key(index: number) { return [...this.rows.keys()][index] ?? null; }
  getItem(key: string) { return this.rows.get(key) ?? null; }
  setItem(key: string, value: string) { this.rows.set(key, value); }
  removeItem(key: string) { this.rows.delete(key); }
}
const payload = (id = '00000000-0000-4000-8000-000000000001') => ({
  operationId: id, entityType: 'tag', entityId: null, expectedVersion: 0, action: 'save',
  content: { name: '重载测试', active: true, sortOrder: 0 },
});

test('journal round-trips the exact request and isolates concurrent operations and owners', () => {
  const storage = new MemoryStorage();
  storage.setItem('theme', 'dark');
  const body = payload();
  const first = createJournalEntry('v2/master/submit', 'owner', body);
  saveJournalEntry(first, storage);
  body.content.name = 'later edit';
  const second = createJournalEntry('v2/master/submit', 'owner', payload('00000000-0000-4000-8000-000000000002'));
  const otherOwner = createJournalEntry('v2/master/submit', 'other', payload());
  saveJournalEntry(second, storage);
  saveJournalEntry(otherOwner, storage);
  const recovered = readJournal('owner', storage);
  assert.equal(recovered.length, 2);
  assert.equal(recovered[0].bodyJson, JSON.stringify(payload()));
  assert.equal(recovered[0].path, 'v2/master/submit');
  saveJournalEntry(recovered[0], storage);
  removeJournalEntry(recovered[0], storage);
  assert.deepEqual(readJournal('owner', storage), [second]);
  assert.deepEqual(readJournal('other', storage), [otherOwner]);
  assert.equal(storage.getItem('theme'), 'dark');
});

test('journal preserves bill content, action and operation ID without sharing master keys', () => {
  const storage = new MemoryStorage();
  const body = { operationId: payload().operationId, billId: payload().operationId, expectedVersion: 4, action: 'delete' };
  const bill = createJournalEntry('v2/bills/submit', 'owner', body);
  saveJournalEntry(bill, storage);
  assert.deepEqual(JSON.parse(readJournal('owner', storage)[0].bodyJson), body);
  assert.throws(() => saveJournalEntry({ ...bill, bodyJson: JSON.stringify({ ...body, expectedVersion: 5 }) }, storage), /无法保存/);
  assert.deepEqual(readJournal('owner', storage), [bill]);
});

test('storage write or read-back failure is visible; failed cleanup retains the original operation', () => {
  const entry = createJournalEntry('v2/master/submit', 'owner', payload());
  const denied = new MemoryStorage();
  denied.setItem = () => { throw new Error('quota'); };
  assert.throws(() => saveJournalEntry(entry, denied), /本次未发送/);
  const silent = new MemoryStorage();
  silent.setItem = () => undefined;
  assert.throws(() => saveJournalEntry(entry, silent), /本次未发送/);
  const partial = new MemoryStorage();
  const getItem = partial.getItem.bind(partial);
  partial.getItem = key => {
    if (partial.rows.has(key)) throw new Error('read-back denied after write');
    return null;
  };
  assert.throws(() => saveJournalEntry(entry, partial), /本次未发送/);
  assert.equal(partial.rows.size, 1);
  partial.getItem = getItem;
  assert.deepEqual(readJournal('owner', partial), [entry]);
  const storage = new MemoryStorage();
  saveJournalEntry(entry, storage);
  storage.removeItem = () => { throw new Error('denied'); };
  assert.throws(() => removeJournalEntry(entry, storage), /原请求再次确认/);
  assert.deepEqual(readJournal('owner', storage), [entry]);
});

test('journal refuses authentication paths and credential fields before persisting', () => {
  assert.throws(() => createJournalEntry('authorize', 'owner', { operationId: payload().operationId, password: 'secret' }));
  assert.throws(() => createJournalEntry('v2/master/submit', 'owner', { ...payload(), token: 'secret' }));
  assert.throws(() => createJournalEntry('v2/master/submit', 'owner', {
    ...payload(), content: { ...payload().content, password: 'secret' },
  }));
  assert.throws(() => createJournalEntry('v2/master/submit', '', payload()));
});

test('corrupted recovery records fail closed without clearing any stored operations', () => {
  const storage = new MemoryStorage();
  const entry = createJournalEntry('v2/master/submit', 'owner', payload());
  saveJournalEntry(entry, storage);
  storage.setItem(`${journalPrefix}owner:broken`, '{');
  const before = [...storage.rows];
  assert.throws(() => readJournal('owner', storage), /避免重复提交/);
  assert.deepEqual([...storage.rows], before);
});
