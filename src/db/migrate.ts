import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const { Pool } = pg;

/**
 * Minimal, dependency-free SQL migration runner. Ordered `migrations/*.sql` files
 * are applied once each; applied names are tracked in `_migrations`. This gives
 * `migrate:up`, `migrate:down` (best-effort via *.down.sql), and `reset`.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Where migrations live when this module runs from the source tree.
 *
 * The desktop shell overrides it. Once `desktop/main.ts` is bundled to `dist-desktop/`,
 * `import.meta.url` no longer sits two levels below the repository root, so a path derived
 * from it points somewhere that does not exist. The directory is therefore a parameter with
 * a source-tree default rather than a constant — the CLI keeps working untouched and the
 * packaged app passes the location it actually shipped the files to.
 */
export const DEFAULT_MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

export function migrationFiles(dir: string = DEFAULT_MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
}

export async function ensureMigrationsTable(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function appliedMigrations(pool: pg.Pool): Promise<Set<string>> {
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM _migrations');
  return new Set(rows.map((r) => r.name));
}

export interface MigrateUpOptions {
  /**
   * Fired once, before the first pending file is applied, but ONLY when `_migrations` already
   * held rows — i.e. this is a pre-existing install being upgraded, not the empty cluster a
   * fresh `initdb` produces on first launch (nothing to protect there yet). Best-effort: a
   * throwing hook is logged by the caller and never blocks the migration itself, since leaving
   * the user stuck on a broken app version is worse than a schema change proceeding without its
   * safety-net backup.
   */
  onBeforeMigrating?: (pending: readonly string[]) => Promise<void>;
}

export async function migrateUp(
  connectionString: string,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
  opts: MigrateUpOptions = {},
): Promise<string[]> {
  const pool = new Pool({ connectionString });
  const applied: string[] = [];
  try {
    await ensureMigrationsTable(pool);
    const done = await appliedMigrations(pool);
    const pending = migrationFiles(migrationsDir).filter((f) => !done.has(f));
    if (pending.length > 0 && done.size > 0 && opts.onBeforeMigrating) {
      try {
        await opts.onBeforeMigrating(pending);
      } catch (err) {
        console.error('pre-migration backup hook failed; continuing with migration', err);
      }
    }
    for (const file of migrationFiles(migrationsDir)) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      const client = await pool.connect();
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
    await pool.end();
  }
}

/** Revert exactly the most recently applied migration.
 *
 * DOWN runs in the same transaction as removal from `_migrations`, so a
 * migration-level safety refusal leaves both schema and history unchanged.
 */
export async function migrateDown(
  connectionString: string,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<string | null> {
  const pool = new Pool({ connectionString });
  try {
    await ensureMigrationsTable(pool);
    const { rows } = await pool.query<{ name: string }>(
      'SELECT name FROM _migrations ORDER BY applied_at DESC, name DESC LIMIT 1',
    );
    const name = rows[0]?.name;
    if (!name) return null;

    if (name === '013_local_runtime_credentials.sql') {
      const retained = await pool.query<{ rollback_blocked: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM credential_refs)
             OR EXISTS (SELECT 1 FROM connections WHERE transport_mode IS NOT NULL)
             AS rollback_blocked`,
      );
      if (retained.rows[0]?.rollback_blocked) {
        throw new Error(
          'DOWN migration 013_local_runtime_credentials.sql failed: ' +
          'refusing DOWN for 013_local_runtime_credentials: retained rows exist',
        );
      }
    }

    const downFile = name.replace(/\.sql$/, '.down.sql');
    const downPath = join(migrationsDir, downFile);
    if (!readdirSync(migrationsDir).includes(downFile)) {
      throw new Error(`Migration ${name} has no DOWN file (${downFile})`);
    }

    const sql = readFileSync(downPath, 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('DELETE FROM _migrations WHERE name = $1', [name]);
      await client.query('COMMIT');
      return name;
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`DOWN migration ${name} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

export async function resetDb(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString });
  try {
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    // pg-boss keeps its own schema; drop it too so reset is total.
    await pool.query('DROP SCHEMA IF EXISTS pgboss CASCADE;');
  } finally {
    await pool.end();
  }
  await migrateUp(connectionString);
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
    const reverted = await migrateDown(connectionString);
    console.log(reverted ? `Reverted: ${reverted}` : 'No applied migrations.');
  } else if (cmd === 'reset') {
    await resetDb(connectionString);
    console.log('Database reset and re-migrated.');
  } else {
    console.error(`Unknown migrate command: ${cmd}`);
    process.exit(1);
  }
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('migrate.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
