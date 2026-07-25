import pg from 'pg';

const { Pool } = pg;

/**
 * Single shared pg Pool. Prisma Decimal-style gotchas don't apply (no ORM) but we
 * keep money as NUMERIC and read it as string in JS, comparing with care.
 */

let pool: pg.Pool | null = null;

export function normalizePostgresConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    const sslMode = url.searchParams.get('sslmode');
    if (sslMode === 'require' || sslMode === 'prefer' || sslMode === 'verify-ca') {
      url.searchParams.set('sslmode', 'verify-full');
      return url.toString();
    }
  } catch {
    // Let pg report malformed/non-URL connection strings with its native error.
  }
  return connectionString;
}

export function getPool(connectionString: string = process.env.DATABASE_URL ?? ''): pg.Pool {
  if (!pool) {
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    pool = new Pool({ connectionString: normalizePostgresConnectionString(connectionString), max: 10 });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as any[]);
}

/**
 * Run a set of statements inside a single transaction. pg-boss/pgbouncer note:
 * this uses a dedicated client checkout, which is safe on a direct Postgres
 * connection (the local/dev and sandbox targets here).
 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Test helper: point the pool at a specific connection string, closing any prior pool. */
export async function resetPoolForTest(connectionString: string): Promise<pg.Pool> {
  if (pool) await pool.end();
  pool = new Pool({ connectionString: normalizePostgresConnectionString(connectionString), max: 5 });
  return pool;
}
