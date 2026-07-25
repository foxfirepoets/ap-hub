import { migrateUp } from '../src/db.js';

/**
 * Broker test bootstrap. Points at a throwaway `aphub_broker` Postgres (separate
 * from ap-hub's `aphub` db) and applies migrations once. No external service
 * (Anthropic, SwarmSync) is contacted in this chunk.
 */

process.env.DATABASE_URL ||= 'postgres://aphub:aphub@127.0.0.1:5432/aphub_broker';
process.env.LOG_LEVEL ||= 'silent';
process.env.BROKER_TEST_AUTH_ROUTE ||= '1'; // enable the guarded /__authcheck route

let migrated = false;
export async function ensureMigrated(): Promise<void> {
  if (migrated) return;
  await migrateUp(process.env.DATABASE_URL!);
  migrated = true;
}

await ensureMigrated();
