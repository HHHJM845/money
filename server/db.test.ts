import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from 'pg';
import { databaseOptions } from './db';

test('custom database CA survives pg URL parsing and enforces certificate verification', () => {
  const options = databaseOptions('postgresql://owner:p%40ss@example.com:6543/postgres?sslmode=verify-full&application_name=money', 'test-ca');
  const client = new Client(options);
  assert.deepEqual(client.ssl, { ca: 'test-ca', rejectUnauthorized: true });
  const url = new URL(options.connectionString!);
  assert.equal(decodeURIComponent(url.password), 'p@ss');
  assert.equal(url.hostname, 'example.com');
  assert.equal(url.searchParams.get('application_name'), 'money');
});

test('connections without a custom CA preserve existing configuration', () => {
  const connectionString = 'postgresql://localhost/money';
  assert.deepEqual(databaseOptions(connectionString), { connectionString });
});

test('custom CA rejects conflicting URL certificate paths', () => {
  assert.throws(() => databaseOptions('postgresql://localhost/money?sslrootcert=other.crt', 'test-ca'), /certificate paths/);
});
