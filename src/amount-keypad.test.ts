import test from 'node:test';
import assert from 'node:assert/strict';
import { amountKey } from './amount-keypad';
const enter = (keys: string[]) => keys.reduce(amountKey, '');
test('decimal entry, repeated separator and cents limit', () => {
  assert.equal(enter(['.', '0', '.', '5', '9']), '0.05');
  assert.equal(enter(['0', '0', '2', '.', '3', '0']), '2.30');
});
test('delete and clear allow correcting amount without numeric rounding', () => {
  assert.equal(amountKey('12.30', 'delete'), '12.3');
  assert.equal(amountKey('', 'delete'), '');
  assert.equal(amountKey('12.30', 'clear'), '');
  assert.equal(enter(['1', '.', 'delete', '2']), '12');
});
test('whole part is bounded and unsupported keys cannot enter expressions', () => {
  assert.equal(amountKey('12345678901234', '5'), '12345678901234');
  assert.equal(amountKey('12345678901234.', '5'), '12345678901234.5');
  assert.equal(amountKey('12', '-'), '12');
});
