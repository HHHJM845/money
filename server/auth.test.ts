import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authenticated, hashPassword, issueSession, sessionCookie, verifyPassword, type AuthConfig } from './auth';

const config: AuthConfig = { username: 'owner', passwordHash: hashPassword('a-test-password-only'), secret: 'a'.repeat(40) };
test('passwords are salted and verified with scrypt', () => {
  assert(verifyPassword('a-test-password-only', config.passwordHash));
  assert(!verifyPassword('wrong', config.passwordHash));
  assert.notEqual(hashPassword('a-test-password-only'), config.passwordHash);
});
test('sessions reject tampering expiry and secret/password rotation', () => {
  const cookie = `money_session=${issueSession(config, 100000)}`;
  assert(authenticated(cookie, config, 100001));
  assert(!authenticated(cookie + 'bad', config, 100001));
  assert(!authenticated(cookie, config, 100000 + 12 * 3600000));
  assert(!authenticated(cookie, { ...config, secret: 'b'.repeat(40) }, 100001));
  assert(!authenticated(cookie, { ...config, passwordHash: hashPassword('another-password') }, 100001));
  assert(!authenticated('', config));
});
test('production cookies are HttpOnly Secure SameSite and can be cleared', () => {
  assert.match(sessionCookie('value', true), /HttpOnly; SameSite=Strict/);
  assert.match(sessionCookie('value', true), /; Secure$/);
  assert.match(sessionCookie('', true), /Max-Age=0/);
});
