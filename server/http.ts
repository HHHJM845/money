import type { Pool } from 'pg';
import { createHmac } from 'node:crypto';
import { authenticated, authConfig, issueSession, sessionCookie, verifyPassword, type AuthConfig } from './auth';
import { database } from './db';
import { ledger, LedgerError } from './ledger';

function result(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(status < 400 ? { success: true, result: value } : { success: false, errorMessage: value }, {
    status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  });
}
const reads = new Set(['v1/accounts/list', 'v1/transaction/categories/list', 'v1/transactions/list']);
const writes = new Set(['v1/accounts/add', 'v1/transaction/categories/add', 'v1/transactions/add']);

export async function handle(request: Request, dependencies: { pool?: Pool; auth?: AuthConfig; sourceIp?: string } = {}): Promise<Response> {
  const url = new URL(request.url);
  const route = (url.searchParams.get('route') ?? url.pathname.replace(/^\/api\//, '')).replace(/\.json$/, '');
  if (!['GET', 'POST'].includes(request.method)) return result('请求方法不支持', 405);
  if (request.method === 'POST') {
    const origin = request.headers.get('origin');
    if (!origin || origin !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site') return result('请求来源不允许', 403);
    if (!request.headers.get('content-type')?.startsWith('application/json')) return result('请求必须为 JSON', 415);
  }
  try {
    const config = dependencies.auth ?? authConfig();
    const secure = url.protocol === 'https:';
    if (route === 'authorize') {
      if (request.method !== 'POST') return result('请求方法不支持', 405);
      const body = await readBody(request);
      const pool = dependencies.pool ?? database();
      // Vercel overwrites this header; local adapters supply the socket address directly.
      const sourceIp = dependencies.sourceIp ?? (process.env.VERCEL ? request.headers.get('x-vercel-forwarded-for') : null) ?? 'local';
      const limitKey = createHmac('sha256', config.secret).update(sourceIp.split(',')[0].trim()).digest('hex');
      const attempt = await pool.query<{ attempts: number }>(`INSERT INTO money_login_limits(key, window_start, attempts)
        VALUES ($1, now(), 1) ON CONFLICT (key) DO UPDATE SET
        attempts = CASE WHEN money_login_limits.window_start < now() - interval '15 minutes' THEN 1 ELSE money_login_limits.attempts + 1 END,
        window_start = CASE WHEN money_login_limits.window_start < now() - interval '15 minutes' THEN now() ELSE money_login_limits.window_start END
        RETURNING attempts`, [limitKey]);
      if (attempt.rows[0].attempts > 10) return result('尝试次数过多，请在 15 分钟后重试', 429, { 'Retry-After': '900' });
      const valid = verifyPassword(typeof body.password === 'string' ? body.password : '', config.passwordHash);
      if (body.loginName !== config.username || !valid) return result('账号或密码不正确', 401);
      return result({ username: config.username }, 200, { 'Set-Cookie': sessionCookie(issueSession(config), secure) });
    }
    if (!authenticated(request.headers.get('cookie') ?? '', config)) return result('请先登录', 401);
    if (route === 'session' && request.method === 'GET') return result({ username: config.username });
    if (route === 'logout' && request.method === 'POST') return result({}, 200, { 'Set-Cookie': sessionCookie('', secure) });
    if (!reads.has(route) && !writes.has(route)) return result('接口不存在', 404);
    if ((reads.has(route) && request.method !== 'GET') || (writes.has(route) && request.method !== 'POST')) return result('请求方法不支持', 405);
    const body = request.method === 'POST' ? await readBody(request) : undefined;
    return result(await ledger(dependencies.pool ?? database(), route, body, url.searchParams));
  } catch (error) {
    if (error instanceof LedgerError) return result(error.message, error.status);
    if (error instanceof SyntaxError) return result('JSON 请求格式无效', 400);
    if (error instanceof BodyError) return result(error.message, 413);
    // Never return SQL errors, credentials or connection strings to the browser.
    process.stderr.write('Finance API failed; check server configuration and database schema\n');
    return result('服务暂不可用，请检查数据库和服务端配置后重试', 503);
  }
}
class BodyError extends Error {}
async function readBody(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 16384) { await reader.cancel(); throw new BodyError('请求内容过大'); }
    chunks.push(value);
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SyntaxError();
  return body as Record<string, unknown>;
}
