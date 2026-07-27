import { z } from 'zod';
import { runExportBackup, runRestoreBackup } from '../../../src/backup/http.js';
import { defineChannel, entityId, passthrough, strict, type RegistryEntry } from '../registry.js';

/**
 * CHUNK_7_BACKUP — `aphub:backup:restore` and `aphub:backup:export`, both owner only, matching
 * `runRestoreBackup`/`runExportBackup`'s own `readContext(request, 'owner_controller')`
 * (`src/backup/http.ts`) — this file does not gate a second time.
 *
 * `destination` is a plain absolute path the renderer collects from a native "save as" dialog;
 * capped generously (Windows UNC/network-share paths run long) and otherwise unconstrained —
 * `runExportBackup` is the one place that decides whether the path is usable, exactly the same
 * division of labour `confirmedCompanyId`/`confirmation` use on the write-gate channel
 * (`desktop/ipc/action/fields.ts`).
 */
const destinationPath = z.string().trim().min(1).max(4096);

export const backupActionEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:backup:restore',
    role: ['owner_controller'],
    method: 'POST',
    pathTemplate: '/api/backup/:backupId/restore',
    request: strict({ backupId: entityId }),
    response: passthrough({ restored: z.literal(true), rowCounts: z.record(z.string(), z.number()) }),
    validationMessage: 'AP-Hub could not restore that backup. Your current data was not changed.',
    invoke: (request, payload) => runRestoreBackup(request, payload.backupId as number),
  }),
  defineChannel({
    channel: 'aphub:backup:export',
    role: ['owner_controller'],
    method: 'POST',
    pathTemplate: '/api/backup/:backupId/export',
    bodyKeys: ['destination'],
    request: strict({ backupId: entityId, destination: destinationPath }),
    response: passthrough({ exported: z.literal(true) }),
    validationMessage: 'AP-Hub could not export that backup. Choose a location and try again.',
    invoke: (request, payload) => runExportBackup(request, payload.backupId as number, payload.destination as string),
  }),
];
