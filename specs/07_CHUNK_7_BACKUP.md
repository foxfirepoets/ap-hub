# CHUNK_7_BACKUP: Prove the user's AP history survives losing the computer.

## Summary

Builds encrypted automatic backup, verification-by-re-reading, rotation that never prunes the last
verified copy, one-click restore, repair mode and an optional user-nominated external folder. It
comes after the data paths exist and after CHUNK_3 has landed the authorization replay, so backup
work cannot hide a permissions regression. It hands the final chunks a product that can be destroyed
and restored.

**This is P0.** A local-only product without a proven restore is one drive failure from destroying
the user's entire AP history. The failure mode this chunk exists to prevent is a backup that appears
to work and turns out to be unrestorable.

## Acceptance Criteria

- [ ] Scheduled (nightly), pre-migration and pre-update backups run: a consistent PostgreSQL dump plus the document store, taken **without stopping the engine**.
- [ ] Every backup is encrypted with a key held **only** in the OS credential store. The key is not recoverable from disk and is never returned across the IPC bridge.
- [ ] Every backup is verified immediately after creation by **re-reading it** and checking a manifest hash and row counts. An unverified backup is reported as failed and **never counted**.
- [ ] Rotation keeps 7 daily / 4 weekly / 3 monthly plus every pre-update snapshot, prunes only after a newer backup verifies, and **never prunes down to zero verified copies**.
- [ ] A corrupted backup is reported as failed with a **visible** plain-language warning plus a native notification — silent backup failure is a defect.
- [ ] **Destroy-and-restore drill**: back up → delete the entire data directory → restore from the AP-Hub UI in one confirmation → document counts, audit rows and postings all match the pre-destruction state exactly.
- [ ] Restore works from a user-nominated external folder (OneDrive, Drive, Dropbox, network share, external drive). The external copy is **user-selected, never automatic**, and never targets an AP-Hub-operated location.
- [ ] Repair mode reinstalls program components and rebuilds derived state **without altering user data** — proven by a row-level before/after comparison.
- [ ] An exportable single encrypted file is offered, and the export copy states plainly that the key lives in this computer's secure storage (**Open Question 3** — ship the limitation documented, not hidden).
- [ ] `aphub:backup:list` and `aphub:backup:restore` are owner-only and never return the key or a credential-store handle.
- [ ] Settings shows the most recent verified backup in plain language ("Yesterday, 2:15 AM — checked and readable").
- [ ] All tests pass with zero failures (`npm run verify` exits 0).

## Endpoints / Interfaces

| Channel | Auth | Request | Response |
|---|---|---|---|
| `aphub:backup:list` | owner only | `{}` | `{ ok: true, data: Array<{ id, kind, createdAt, sizeBytes, verifiedAt, externalCopy }> }` |
| `aphub:backup:restore` | owner only | `{ backupId: number }` | `{ ok: true, data: { restored: true, rowCounts: Record<string, number> } }` |
| `aphub:backup:export` | owner only | `{ backupId: number, destination: string }` | `{ ok: true, data: { exported: true } }` |

Errors: `FORBIDDEN` | `NOT_FOUND` | `RESTORE_FAILED` | `BACKUP_KEY_MISSING` | `BACKUP_FAILED` | `DISK_FULL`.

Neither `list` nor `restore` ever returns the encryption key or a credential-store handle.

## Database Changes

- `backups`: **populated** by this chunk (created in CHUNK_2). `verified_at IS NULL` means never counted as a usable backup.

Rotation queries `verified_at IS NOT NULL` and must never delete the newest verified row.
No secret, key or credential is stored in this table.

## Test Scenarios

- **Happy path**: nightly backup runs → is re-read and verified → `verified_at` is set → Settings shows it in plain language.
- **Edge case**: rotation with exactly one verified copy remaining prunes **nothing**; a pre-update snapshot is retained until the next successful update; the disk fills mid-backup and surfaces `DISK_FULL` with the pause message.
- **Failure case**: a backup whose manifest hash does not match on re-read is marked failed, left uncounted, raises a visible warning, and does **not** trigger pruning of an older good copy. A restore from a corrupt source leaves current data **untouched** and offers other verified backups.
- **Integration**: `test/backup-restore.int.test.ts` proves the full drill — back up, drop the schema, restore, and assert document counts, audit rows and postings match exactly.

## Dependencies

- **Requires**: CHUNK_2_DATABASE (`backups` table), CHUNK_3_IPC (**the cross-tenant/RBAC replay must be green before this chunk starts**), CHUNK_4_IDENTITY (credential store for the key).
- **Blocks**: CHUNK_9_PACKAGE.

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_7_BACKUP</promise>
