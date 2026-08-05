import { z } from 'zod';
import { runListBackups } from '../../../src/backup/http.js';
import { defineChannel, passthrough, persistedId, strict, type RegistryEntry } from '../registry.js';

/**
 * CHUNK_7_BACKUP — `aphub:backup:list` (owner only). `id` and `sizeBytes` use `persistedId`,
 * not `z.number()`: both come straight off `bigint`/`BIGSERIAL` columns
 * (`migrations/015_backups.sql`), which pg hands back as strings.
 *
 * Never returns the encryption key or a credential-store handle — `runListBackups`
 * (`src/backup/http.ts`) selects only the columns named below.
 */
export const backupReadEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:backup:list',
    role: ['owner_controller'],
    method: 'GET',
    pathTemplate: '/api/backup/list',
    request: strict({}),
    response: z.array(
      passthrough({
        id: persistedId,
        kind: z.string(),
        createdAt: z.string(),
        sizeBytes: persistedId,
        verifiedAt: z.string().nullable(),
        externalCopy: z.string().nullable(),
      }),
    ),
    validationMessage: 'BookScout OS could not load your backup history.',
    invoke: (request) => runListBackups(request),
  }),
];
