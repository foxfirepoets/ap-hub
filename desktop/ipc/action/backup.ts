import { z } from 'zod';
import {
  runCreateBackup,
  runExportBackup,
  runRepairBackup,
  runRestoreBackup,
  runRestoreExternalBackup,
} from '../../../src/backup/http.js';
import { defineChannel, entityId, passthrough, persistedId, strict, type RegistryEntry } from '../registry.js';

/**
 * CHUNK_7_BACKUP — `aphub:backup:create`, `aphub:backup:restore`, `aphub:backup:restore-external`,
 * and `aphub:backup:export`, all owner only, matching each `run*` wrapper's own
 * `readContext(request, 'owner_controller')` (`src/backup/http.ts`) — this file does not gate a
 * second time.
 *
 * `destination` / `path` are plain absolute paths the renderer collects from the user;
 * capped generously (Windows UNC/network-share paths run long) and otherwise unconstrained —
 * `runExportBackup` / `runRestoreExternalBackup` decide whether the path is usable.
 */
const destinationPath = z.string().trim().min(1).max(4096);

export const backupActionEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:backup:create',
    role: ['owner_controller'],
    method: 'POST',
    pathTemplate: '/api/backup/create',
    request: strict({}),
    response: passthrough({
      id: persistedId,
      verified: z.literal(true),
      sizeBytes: persistedId,
    }),
    validationMessage: 'BookScout OS could not create a backup. Try again in a moment.',
    invoke: (request) => runCreateBackup(request),
  }),
  defineChannel({
    channel: 'aphub:backup:restore',
    role: ['owner_controller'],
    method: 'POST',
    pathTemplate: '/api/backup/:backupId/restore',
    request: strict({ backupId: entityId }),
    response: passthrough({ restored: z.literal(true), rowCounts: z.record(z.string(), z.number()) }),
    validationMessage: 'BookScout OS could not restore that backup. Your current data was not changed.',
    invoke: (request, payload) => runRestoreBackup(request, payload.backupId as number),
  }),
  defineChannel({
    channel: 'aphub:backup:restore-external',
    role: ['owner_controller'],
    method: 'POST',
    pathTemplate: '/api/backup/restore-external',
    bodyKeys: ['path'],
    request: strict({ path: destinationPath }),
    response: passthrough({ restored: z.literal(true), rowCounts: z.record(z.string(), z.number()) }),
    validationMessage: 'BookScout OS could not restore from that exported backup. Your current data was not changed.',
    invoke: (request, payload) => runRestoreExternalBackup(request, payload.path as string),
  }),
  defineChannel({
    channel: 'aphub:backup:export',
    role: ['owner_controller'],
    method: 'POST',
    pathTemplate: '/api/backup/:backupId/export',
    bodyKeys: ['destination'],
    request: strict({ backupId: entityId, destination: destinationPath }),
    response: passthrough({ exported: z.literal(true), path: z.string().optional() }),
    validationMessage: 'BookScout OS could not export that backup. Choose a location and try again.',
    invoke: (request, payload) => runExportBackup(request, payload.backupId as number, payload.destination as string),
  }),
  defineChannel({
    channel: 'aphub:backup:repair',
    role: ['owner_controller'],
    method: 'POST',
    pathTemplate: '/api/backup/repair',
    request: strict({}),
    response: passthrough({
      repaired: z.literal(true),
      migrationsApplied: z.number(),
      backupKeyPresent: z.boolean(),
    }),
    validationMessage: 'BookScout OS could not complete repair. Try again in a moment.',
    invoke: (request) => runRepairBackup(request),
  }),
];
