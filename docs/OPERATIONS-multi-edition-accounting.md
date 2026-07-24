# AP Hub multi-edition operations

This runbook covers the local Windows topology. QBO automation is sandbox-only.
QBD is disabled by default and Gmail draft creation is disabled by default. AP Hub
has no reply-send endpoint; a human sends from Gmail.

## Safe configuration

Keep these values until disposable certification has passed:

```dotenv
QBO_ENV=sandbox
GMAIL_DRAFTS_ENABLED=false
QB_DESKTOP_ENABLED=false
QB_DESKTOP_WRITE_ENABLED=false
PROVIDER_JOB_LEASE_SECONDS=300
```

To test QBD, use a disposable QuickBooks company. Set `QB_DESKTOP_ENABLED=true`,
the expected `QB_DESKTOP_COMPANY_ID`, a unique `QBWC_PASSWORD`, and import the
generated QWC file. Enabling `QB_DESKTOP_WRITE_ENABLED=true` is an owner decision
after backup/restore and lost-response adoption evidence is reviewed. The process
refuses write enablement without an enabled connection and expected company ID.

`GMAIL_DRAFTS_ENABLED=true` permits only draft create/update/discard in the source
thread. Use a disposable mailbox. Sending remains a human action in Gmail.

## Health and alerts

`GET http://127.0.0.1:3001/health` returns database liveness plus count-only
operational signals:

- provider jobs queued and oldest queued age;
- expired leases, unknown results, failed jobs, and held jobs;
- held/unbalanced statements;
- proposed drafts carrying a failure reason.

The response and structured `operational health snapshot` log never contain job
payloads, statement contents, email addresses, OAuth tokens, or provider secrets.
Alert through the existing operator channel when oldest queued age exceeds 1,800
seconds, an unknown result exceeds 900 seconds, statement failure exceeds 20% of a
20-document window, or compose scope fails three consecutive attempts.

## Backup, restore, and migration rollback

Before migration or any owner-approved real-company write, take an operator-owned
PostgreSQL backup and verify restoration in a separate database. The repository
script deliberately accepts only database names prefixed `aphub_disposable_`:

```powershell
$secure = Read-Host "Disposable DB password" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
try {
.\scripts\disposable-db-recovery.ps1 -Action Rehearse `
  -Database aphub_disposable_recovery_01 -Username aphub
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  Remove-Item Env:\PGPASSWORD
}
```

Expected output contains `RECOVERY_REHEARSAL_PASS`. Do not place passwords in
command history or artifacts.

Migration DOWN is permitted only when all five additive intake tables are empty.
Run `npm run migrate:down`; migration 008 refuses retained rows. If any customer
row exists, leave the additive tables in place, deploy the previous application
commit, and preserve the data. Restore an operator backup only after isolating the
failed database and recording its reference; never overwrite the only copy.

## Disposable external certification

No live command is part of `npm run verify`. With explicit owner approval:

1. Use a disposable Gmail mailbox, QBO sandbox, and QBD test company.
2. Run `npm run verify` and the recovery rehearsal first.
3. Enable Gmail drafts and verify a draft appears unsent; inspect that no send
   endpoint or application-send log exists.
4. Post one unique test bill to QBO sandbox and QBD test company. Capture company
   identity, provider reference, read-back, reconciliation, and audit records.
5. Inject a lost response and confirm adoption of the same provider transaction.
6. Restore all safe defaults after certification.

Until those observations are captured, label external Gmail/QBO/QBD evidence
`NOT VERIFIED`; local and simulated tests do not prove deployed behavior.
