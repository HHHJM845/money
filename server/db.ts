import { Pool } from 'pg';
import { attachDatabasePool } from '@vercel/functions';

let pool: Pool | undefined;
export function database(): Pool {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3,
      idleTimeoutMillis: 10000, connectionTimeoutMillis: 8000,
      statement_timeout: 15000 });
    if (process.env.VERCEL) attachDatabasePool(pool);
    pool.on('error', () => process.stderr.write('Database pool connection error\n'));
  }
  return pool;
}
