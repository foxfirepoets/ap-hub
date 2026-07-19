# AP-Hub Live Validation Setup (the external-dependency unblock)

The corrected build (`b86f764`+) is code-complete for F1/F2/F3/F5/F6/F7/F8/F10 and the F4
wrong-company wiring, all gate-verified (ap-hub 282/282, broker 39/39). The **only** things
that block a launch-clearing `/truth-before-launch` are external and cannot be provisioned
from the build environment:

1. **QBO sandbox OAuth** (no credential exists anywhere on this machine — verified).
2. **Gmail OAuth** (placeholder only).
3. **A real reboot under a standard (non-admin) user** for F9.

Do the three things below and the live validation runs itself. **Never paste secrets into a
chat.** Every secret lands in the pilot's DPAPI custody (see §4), never in git.

---

## 1. Google OAuth (Gmail, read-only + one locked forward)

1. **Google Cloud project**: create a project (or reuse a dedicated one) — do **not** reuse
   the unrelated `Cato`/Downloads client_secret files; they have the wrong redirect URIs and
   consent screen.
2. **Enable the Gmail API**: APIs & Services → Library → *Gmail API* → Enable.
3. **OAuth consent screen**: User type **External**, publishing status **Testing**. App name
   "AP-Hub Pilot". Add **your test Gmail address as a Test User** (Testing mode allows only
   listed test users — exactly what a 3–5 tester pilot needs).
4. **Scopes** (least privilege — request only these):
   - `https://www.googleapis.com/auth/gmail.readonly` — read accounting email + attachments (the pipeline never modifies mail).
   - `https://www.googleapis.com/auth/gmail.send` — **only** the single locked gatekeeper forward (`src/gatekeeper/forwarder.ts`, one hard-wired recipient). Omit if you are not exercising the forward.
5. **Credentials → Create OAuth client ID → Web application**. Authorized redirect URI:
   `http://localhost:3001/oauth/gmail/callback` (matches `GMAIL_REDIRECT_URI` default).
6. **Env var names** (the pilot reads these; store via §4, not plaintext):
   `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` (redirect URI has a working default).
7. **Connect**: open `http://localhost:3000/onboarding` → *Connect Gmail* → sign in as the
   test user → grant. Token is AES-256-GCM encrypted at rest (`src/auth/tokens.ts`).
8. **Verify refresh + revocation**: Gmail auto-refreshes via googleapis; to prove revoke,
   remove AP-Hub at myaccount.google.com → *Security → Third-party access* and confirm the
   next poll pauses the tenant (`GmailAuthError` → tenant pause in `poll-cycle.ts`).

## 2. Intuit QBO sandbox (SANDBOX only — production is hard-refused in code)

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
   `QBO_SANDBOX_COMPANY_NAME`. Leave `QBO_ENV=sandbox` (production is refused at config load
   and at write-client construction — `no_prod_write`).
7. **Connect**: `http://localhost:3000/onboarding` → *Connect QuickBooks* → Intuit login →
   pick the sandbox company → grant. Realm is stored from the callback.
8. **Verify**: token refresh now exists (`src/auth/qbo-refresh.ts`); company identity is checked
   before every write (F4 wiring); to prove revoke/reconnect, disconnect the app in the Intuit
   dashboard and reconnect through onboarding.

## 3. Store the secrets (DPAPI custody — never plaintext, never chat)

The pilot's install writes non-secret config to `%LOCALAPPDATA%\APHub\.env` and DPAPI-wraps
the true secrets to `%LOCALAPPDATA%\APHub\secrets\*.dpapi` (unwrapped into the process env at
supervisor start — `pilot/start-aphub.ps1`). For the OAuth **client** secrets (Google/Intuit
app credentials, which the app needs at runtime), add them the same way. From the pilot user:

```powershell
# Run once, as the pilot user; values are read interactively, never echoed.
$dir = "$env:LOCALAPPDATA\APHub\secrets"; New-Item -ItemType Directory -Force $dir | Out-Null
Add-Type -AssemblyName System.Security
function Protect-Secret([string]$name){ $v = Read-Host "Enter $name" -AsSecureString;
  $bstr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($v);
  $plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr);
  $e=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($plain),$null,'CurrentUser');
  [Convert]::ToBase64String($e) | Set-Content -NoNewline "$dir\$name.dpapi"; }
Protect-Secret 'GMAIL_CLIENT_ID'; Protect-Secret 'GMAIL_CLIENT_SECRET'
Protect-Secret 'QBO_SANDBOX_CLIENT_ID'; Protect-Secret 'QBO_SANDBOX_CLIENT_SECRET'
```
(The supervisor's existing unwrap loop in `start-aphub.ps1` should be extended to inject these
four alongside `ENCRYPTION_KEY`/`BROKER_INSTALL_TOKEN` — a one-line-each addition; tracked as a
follow-up so no OAuth client secret ever sits in the plaintext `.env`.)

## 4. One guided sequence — connect, then auto-run the live validation

After the two OAuth apps exist and the four secrets are stored:

```powershell
# 1) fresh install of the corrected build (records commit + hash)
.\pilot\install-pilot.ps1 -NonInteractive -BrokerBaseUrl https://aphub-broker.onrender.com `
    -InstallToken <token> -NodeZip <node20.zip> -PostgresZip <pg16.zip>
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
.\pilot\validate-clean-install.ps1 -Phase pre  -BrokerBaseUrl https://aphub-broker.onrender.com `
    -InstallToken <token> -NodeZip <node20.zip> -PostgresZip <pg16.zip>
# expected: f9-report.json with every pre-check pass=true; then:
Restart-Computer
# sign back in as the SAME standard user, open nothing, then:
.\pilot\validate-clean-install.ps1 -Phase post
# expected final line: "F9 FINAL: PASS (pre+post)"
```

Retain `%LOCALAPPDATA%\APHub\f9-report.json` and the redacted `test:int` output as evidence,
then re-run `/truth-before-launch` against the live install. Only then can the verdict move
off NO-GO.
