# AP-Hub Live Validation Setup (the external-dependency unblock)

The repository passes its local automated gate, but that is not live-provider certification.
Launch still requires disposable external accounts and a real standard-user Windows reboot:

1. **QBO sandbox OAuth** (no credential exists anywhere on this machine — verified).
2. **Gmail OAuth** for a disposable mailbox (read plus compose-only drafts).
3. **A real reboot under a standard (non-admin) user** for F9.

Do the three things below and the live validation runs itself. **Never paste secrets into a
chat.** Every secret lands in the pilot's DPAPI custody (see §4), never in git.

---

## 1. Google OAuth (Gmail read + compose-only drafts)

1. **Google Cloud project**: create a project (or reuse a dedicated one) — do **not** reuse
   the unrelated `Cato`/Downloads client_secret files; they have the wrong redirect URIs and
   consent screen.
2. **Enable the Gmail API**: APIs & Services → Library → *Gmail API* → Enable.
3. **OAuth consent screen**: User type **External**, publishing status **Testing**. App name
   "AP-Hub Pilot". Add **your test Gmail address as a Test User** (Testing mode allows only
   listed test users — exactly what a 3–5 tester pilot needs).
4. **Scopes** (least privilege — request only these):
   - `https://www.googleapis.com/auth/gmail.readonly` — read accounting email and attachments.
   - `https://www.googleapis.com/auth/gmail.compose` — create, update, inspect, and discard drafts.
   AP Hub's reply-draft product has no send operation. A human sends in Gmail. Do not grant
   `gmail.send` for the reply-draft workflow.
5. **Credentials → Create OAuth client ID → Web application**. Authorized redirect URI:
   `http://localhost:3001/oauth/gmail/callback` (matches `GMAIL_REDIRECT_URI` default).
6. **Env var names** (the pilot reads these; store via §4, not plaintext):
   `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` (redirect URI has a working default).
7. **Connect**: open `http://localhost:3000/onboarding` → *Connect Gmail* → sign in as the
   test user → grant. Token is AES-256-GCM encrypted at rest (`src/auth/tokens.ts`).
8. **Verify refresh + revocation**: Gmail auto-refreshes via googleapis; to prove revoke,
   remove AP-Hub at myaccount.google.com → *Security → Third-party access* and confirm the
   next poll pauses the tenant (`GmailAuthError` → tenant pause in `poll-cycle.ts`).

## 2. Intuit QBO sandbox (default validation target)

1. **Intuit Developer app**: developer.intuit.com → create an app under **QuickBooks Online
   and Payments**. Use the app's **Development** keys (sandbox), never Production.
2. **Scopes**: `com.intuit.quickbooks.accounting`.
3. **Redirect URI** (Development → Keys & OAuth): `http://localhost:3001/oauth/qbo/callback`
   (matches `QBO_SANDBOX_REDIRECT_URI` default).
4. **Sandbox company**: developer dashboard → *Sandbox* → a default US sandbox company already
   exists; note its name (it must match `QBO_SANDBOX_COMPANY_NAME`, used by the F4 wrong-company
   guard) — e.g. `Sandbox Company_US_1`.
5. **Realm ID**: do **not** hand-copy it — it is captured through the supported OAuth callback
   (`src/auth/qbo-oauth.ts` persists `realm` from the connect flow). Just connect (step 7).
6. **Env var names** (store via §4): `QBO_SANDBOX_CLIENT_ID`, `QBO_SANDBOX_CLIENT_SECRET`,
   `QBO_SANDBOX_COMPANY_NAME`. Leave `QBO_ENV=sandbox` for disposable validation.
   Production uses separate credentials and exact realm/company settings and remains
   unavailable unless the owner explicitly enables `QBO_PRODUCTION_WRITE_ENABLED=true`.
7. **Connect**: `http://localhost:3000/onboarding` → *Connect QuickBooks* → Intuit login →
   pick the sandbox company → grant. Realm is stored from the callback.
8. **Verify**: token refresh now exists (`src/auth/qbo-refresh.ts`); company identity is checked
   before every write (F4 wiring); to prove revoke/reconnect, disconnect the app in the Intuit
   dashboard and reconnect through onboarding.

## 3. Installer and secret custody

For the supported guided install, run `deploy\Install-ap-hub.cmd`; it launches
`deploy\install-gui.ps1`, discovers prerequisites and credentials, and delegates to
`deploy\install-core.ps1`. For the portable non-admin pilot, use `pilot\install-pilot.ps1`.
The pilot stores client IDs and other non-secret settings in
`%LOCALAPPDATA%\APHub\.env`; it DPAPI-protects the Gmail, Google SSO, QBO, broker,
encryption, and session secrets under `%LOCALAPPDATA%\APHub\secrets`. The supervisor
already unwraps those secrets into child-process memory. No manual secret-file patch is required.

## 4. One guided sequence — connect, then auto-run the live validation

After the two OAuth apps exist and the four secrets are stored:

```powershell
# 1) fresh install of the corrected build (records commit + hash)
$bundle = .\pilot\New-PilotCredentialBundle.ps1
.\pilot\install-pilot.ps1 -NonInteractive -BrokerBaseUrl <broker-url> `
    -CredentialBundlePath $bundle -GmailClientId <id> -GoogleSsoClientId <id> `
    -QboSandboxClientId <id> `
    -QboSandboxCompanyName <exact-name> -TenantName <pilot-name> -OwnerEmail <owner-email> `
    -RecoveryTarget <removable-or-UNC-path> -NodeZip <node20.zip> -PostgresZip <pg16.zip>
# 2) open the browser onboarding and connect Gmail + QBO sandbox (steps 1.7 / 2.7)
Start-Process http://localhost:3000/onboarding
# 3) enable posting (owner-only) — the F1 control:
node .\node_modules\tsx\dist\cli.mjs .\src\cli.ts set-automation --tenant 1 --level assisted
# 4) run the live sandbox E2E (drops a safe test invoice in the watched label, then asserts)
npm run test:int      # the live-sandbox suite (gated to QBO sandbox + test Gmail only)
```

## 5. F9 clean standard-user + reboot (the one unavoidable reboot)

```powershell
# as a STANDARD (non-admin) Windows user, NOT elevated:
$bundle = .\pilot\New-PilotCredentialBundle.ps1
.\pilot\validate-clean-install.ps1 -Phase pre -BrokerBaseUrl <broker-url> `
    -CredentialBundlePath $bundle -GmailClientId <id> -GoogleSsoClientId <id> `
    -QboSandboxClientId <id> `
    -QboSandboxCompanyName <exact-name> -TenantName <pilot-name> -OwnerEmail <owner-email> `
    -RecoveryTarget <removable-or-UNC-path> -NodeZip <node20.zip> -PostgresZip <pg16.zip>
# expected: f9-report.json with every pre-check pass=true; then:
Restart-Computer
# sign back in as the SAME standard user, open nothing, then:
.\pilot\validate-clean-install.ps1 -Phase post
# The post phase merges the pre-reboot evidence, verifies health, runs the default
# uninstall, and asserts both watchdog removal and data preservation.
```

Retain `%LOCALAPPDATA%\APHub\f9-report.json` and the redacted `test:int` output as evidence,
then re-run `/truth-before-launch` against the live install. Only then can the verdict move
off NO-GO.
