/**
 * CHUNK_3_READ — the read service layer. All logic lives here (gate-covered);
 * `app/api/**` route handlers are thin wrappers over these functions via `runRead`.
 * Every query is tenant-scoped through `src/db/scoped.ts`; nothing here mutates.
 */
export * from './http.js';
export * from './today.js';
export * from './exceptions.js';
export * from './transactions.js';
export * from './evidence.js';
export * from './audit.js';
export * from './notifications.js';
export * from './providerCapabilities.js';
export * from './providerJobs.js';
export { listStatements, getStatement } from '../../statements/review.js';
