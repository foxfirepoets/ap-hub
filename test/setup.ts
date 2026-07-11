import { migrateUp } from '../src/db/migrate.js';

/**
 * Test bootstrap. Points at a local throwaway Postgres and ensures migrations are
 * applied. External services (SwarmSync, Gmail, QBO, Telegram, Anthropic) are never
 * contacted — unit tests inject mocks.
 */

process.env.DATABASE_URL ||= 'postgres://aphub:aphub@127.0.0.1:5433/aphub';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.ANTHROPIC_API_KEY ||= 'test-anthropic';
process.env.GMAIL_CLIENT_ID ||= 'test-gmail-id';
process.env.GMAIL_CLIENT_SECRET ||= 'test-gmail-secret';
process.env.SWARMSYNC_API_KEY ||= 'ssk_live_testkey123';
process.env.QBO_ENV ||= 'sandbox';
process.env.QBO_SANDBOX_COMPANY_NAME ||= 'Sandbox Company_US_1';
process.env.LOG_LEVEL ||= 'silent';

let migrated = false;
export async function ensureMigrated(): Promise<void> {
  if (migrated) return;
  await migrateUp(process.env.DATABASE_URL!);
  migrated = true;
}

// Vitest runs setupFiles before each test file; ensure schema exists.
await ensureMigrated();
