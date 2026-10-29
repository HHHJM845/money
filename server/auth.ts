import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const COOKIE = 'money_session';
export const SESSION_SECONDS = 12 * 60 * 60;
export interface AuthConfig { username: string; passwordHash: string; secret: string }

export function authConfig(): AuthConfig {
  const username = process.env.OWNER_USERNAME;
  const passwordHash = process.env.OWNER_PASSWORD_HASH;
  const secret = process.env.SESSION_SECRET;
  if (!username || !passwordHash || !secret || secret.length < 32) throw new Error('Owner authentication is not configured');
  if (!/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(passwordHash)) throw new Error('Invalid password hash configuration');
  return { username, passwordHash, secret };
}

export function hashPassword(password: string): string {
  if (password.length < 12 || password.length > 256) throw new Error('密码长度需为 12–256 个字符');
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
}

export function verifyPassword(password: string, hash: string): boolean {
  if (password.length > 256) return false;
  const [, salt, digest] = hash.split('$');
  if (!salt || !digest || !/^[0-9a-f]{128}$/.test(digest)) return false;
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(digest, 'hex'));
}

function signature(payload: string, config: AuthConfig) {
  // Rotating either the owner's password or signing secret invalidates existing sessions.
  return createHmac('sha256', config.secret).update(`${config.passwordHash}:${payload}`).digest('base64url');
}
export function issueSession(config: AuthConfig, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ username: config.username, expires: Math.floor(now / 1000) + SESSION_SECONDS })).toString('base64url');
  return `${payload}.${signature(payload, config)}`;
}
export function authenticated(cookie: string, config: AuthConfig, now = Date.now()): boolean {
  const token = cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!token || token.length > 2048) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const expected = Buffer.from(signature(parts[0], config));
  const actual = Buffer.from(parts[1]);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    return payload.username === config.username && Number.isSafeInteger(payload.expires) && payload.expires > Math.floor(now / 1000);
  } catch { return false; }
}
export function sessionCookie(value: string, secure: boolean): string {
  return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${value ? SESSION_SECONDS : 0}${secure ? '; Secure' : ''}`;
}
