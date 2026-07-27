import { accountingDocumentsEntries } from './accounting-documents.js';
import { auditEntries } from './audit.js';
import { backupReadEntries } from './backup.js';
import { connectionsReadEntries } from './connections.js';
import { dimensionMappingsEntries } from './dimension-mappings.js';
import { evidenceEntries } from './evidence.js';
import { exceptionsEntries } from './exceptions.js';
import { meEntries } from './me.js';
import { notificationsEntries } from './notifications.js';
import { onboardingEntries } from './onboarding.js';
import { providerCapabilitiesEntries } from './provider-capabilities.js';
import { providerJobsEntries } from './provider-jobs.js';
import { replyDraftsEntries } from './reply-drafts.js';
import { statementsEntries } from './statements.js';
import { taxMappingsEntries } from './tax-mappings.js';
import { todayEntries } from './today.js';
import { transactionsEntries } from './transactions.js';
import type { RegistryEntry } from '../registry.js';

/**
 * B3 — the read-domain barrel. `desktop/ipc/read/channels.ts` (zero-import) declares the
 * names; this file declares the entries. The integration lead assembles
 * `{ channels: READ_CHANNELS, entries: READ_ENTRIES }` as a contribution to
 * `registerProductHandlers` in `desktop/main.ts` — this module does not wire itself in.
 */
export const READ_ENTRIES: readonly RegistryEntry[] = [
  ...todayEntries,
  ...transactionsEntries,
  ...exceptionsEntries,
  ...evidenceEntries,
  ...auditEntries,
  ...notificationsEntries,
  ...meEntries,
  ...accountingDocumentsEntries,
  ...statementsEntries,
  ...replyDraftsEntries,
  ...providerCapabilitiesEntries,
  ...providerJobsEntries,
  ...dimensionMappingsEntries,
  ...taxMappingsEntries,
  ...onboardingEntries,
  ...connectionsReadEntries,
  ...backupReadEntries,
];
