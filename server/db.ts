import { Pool, type PoolConfig } from 'pg';
import { attachDatabasePool } from '@vercel/functions';

export function databaseOptions(connectionString: string, ca?: string): PoolConfig {
  if (!ca) return { connectionString };
  const url = new URL(connectionString);
  // pg parses URL SSL settings after the explicit ssl object. Avoid overriding
  // the supplied CA, while retaining certificate and hostname verification.
  if (['sslrootcert', 'sslcert', 'sslkey'].some(key => url.searchParams.has(key))) {
    throw new Error('Use DATABASE_CA_CERT without SSL certificate paths in DATABASE_URL');
  }
  url.searchParams.delete('sslmode');
  url.searchParams.delete('ssl');
  return { connectionString: url.toString(), ssl: { ca, rejectUnauthorized: true } };
}

let pool: Pool | undefined;
export function database(): Pool {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
  if (!pool) {
    pool = new Pool({ ...databaseOptions(process.env.DATABASE_URL, process.env.DATABASE_CA_CERT), max: 3,
      idleTimeoutMillis: 10000, connectionTimeoutMillis: 8000,
      statement_timeout: 15000 });
    if (process.env.VERCEL) attachDatabasePool(pool);
    pool.on('error', () => process.stderr.write('Database pool connection error\n'));
  }
  return pool;
}
