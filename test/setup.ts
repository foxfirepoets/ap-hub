import { migrateUp } from '../src/db/migrate.js';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Test bootstrap. Points at a local throwaway Postgres and ensures migrations are
 * applied. External services (SwarmSync, Gmail, QBO, Telegram, Anthropic) are never
 * contacted — unit tests inject mocks.
 */

process.env.DATABASE_URL ||= 'postgres://aphub:aphub@127.0.0.1:5432/aphub';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.ANTHROPIC_API_KEY ||= 'test-anthropic';
process.env.GMAIL_CLIENT_ID ||= 'test-gmail-id';
process.env.GMAIL_CLIENT_SECRET ||= 'test-gmail-secret';
process.env.XERO_CLIENT_ID ||= 'test-xero-client-id';
process.env.SWARMSYNC_API_KEY ||= 'ssk_live_testkey123';
process.env.QBO_ENV ||= 'sandbox';
process.env.QBO_SANDBOX_COMPANY_NAME ||= 'Sandbox Company_US_1';
process.env.SESSION_COOKIE_SECRET ||= 'test-session-cookie-secret-32-bytes-minimum';
process.env.GOOGLE_SSO_CLIENT_ID ||= 'test-sso-id';
process.env.GOOGLE_SSO_CLIENT_SECRET ||= 'test-sso-secret';
process.env.LOG_LEVEL ||= 'silent';

async function acquireCrossProcessDatabaseLock(): Promise<void> {
  if (process.env.APHUB_TEST_DB_LOCK_HELD === String(process.pid)) return;
  const key = createHash('sha256').update(process.env.DATABASE_URL!).digest('hex').slice(0, 16);
  const lockDir = join(tmpdir(), `aphub-test-db-${key}.lock`);
  const deadline = Date.now() + 180_000;
  while (true) {
    try {
      await mkdir(lockDir);
      await writeFile(join(lockDir, 'owner'), String(process.pid), 'utf8');
      process.env.APHUB_TEST_DB_LOCK_HELD = String(process.pid);
      process.once('exit', () => {
        try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* best effort */ }
      });
      return;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      const owner = Number(await readFile(join(lockDir, 'owner'), 'utf8').catch(() => '0'));
      if (!owner) {
        const ageMs = Date.now() - (await stat(lockDir)).mtimeMs;
        if (ageMs < 10_000) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
      }
      let alive = owner > 0;
      try { if (alive) process.kill(owner, 0); } catch { alive = false; }
      if (!alive) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for BookScout OS test DB lock held by pid ${owner}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

let migrated = false;
export async function ensureMigrated(): Promise<void> {
  if (migrated) return;
  await migrateUp(process.env.DATABASE_URL!);
  migrated = true;
}

// Vitest runs setupFiles before each test file; ensure schema exists.
await acquireCrossProcessDatabaseLock();
await ensureMigrated();
