import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const { Pool } = pg;

/**
 * Broker Postgres pool + a minimal, dependency-free migration runner. Modeled on
 * ap-hub's `src/db/migrate.ts` + `src/db/pool.ts`: ordered `migrations/*.sql` files
 * are applied once each, tracked in `_migrations`; a `*.down.sql` sibling rolls back.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

// --- Pool ------------------------------------------------------------------

let pool: pg.Pool | null = null;

export function getPool(connectionString: string = process.env.DATABASE_URL ?? ''): pg.Pool {
  if (!pool) {
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    pool = new Pool({ connectionString, max: 10 });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as any[]);
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
  pool = new Pool({ connectionString, max: 5 });
  return pool;
}

// --- Migrations ------------------------------------------------------------

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
}

export async function ensureMigrationsTable(p: pg.Pool): Promise<void> {
  await p.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function appliedMigrations(p: pg.Pool): Promise<Set<string>> {
  const { rows } = await p.query<{ name: string }>('SELECT name FROM _migrations');
  return new Set(rows.map((r) => r.name));
}

export async function migrateUp(connectionString: string): Promise<string[]> {
  const p = new Pool({ connectionString });
  const applied: string[] = [];
  try {
    await ensureMigrationsTable(p);
    const done = await appliedMigrations(p);
    for (const file of migrationFiles()) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const client = await p.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      } finally {
        client.release();
      }
    }
    return applied;
  } finally {
    await p.end();
  }
}

/** Best-effort DOWN: run each applied migration's `*.down.sql` in reverse order. */
export async function migrateDown(connectionString: string): Promise<string[]> {
  const p = new Pool({ connectionString });
  const rolledBack: string[] = [];
  try {
    await ensureMigrationsTable(p);
    const done = await appliedMigrations(p);
    for (const file of migrationFiles().reverse()) {
      if (!done.has(file)) continue;
      const downFile = file.replace(/\.sql$/, '.down.sql');
      const sql = readFileSync(join(MIGRATIONS_DIR, downFile), 'utf8');
      const client = await p.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('DELETE FROM _migrations WHERE name=$1', [file]);
        await client.query('COMMIT');
        rolledBack.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Down-migration ${downFile} failed: ${(err as Error).message}`);
      } finally {
        client.release();
      }
    }
    return rolledBack;
  } finally {
    await p.end();
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'up';
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  if (cmd === 'up') {
    const applied = await migrateUp(connectionString);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'No pending migrations.');
  } else if (cmd === 'down') {
    const rolled = await migrateDown(connectionString);
    console.log(rolled.length ? `Rolled back: ${rolled.join(', ')}` : 'Nothing to roll back.');
  } else {
    console.error(`Unknown migrate command: ${cmd}`);
    process.exit(1);
  }
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('db.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
