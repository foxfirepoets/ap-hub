<#
  install-pilot.ps1 - AP-Hub pilot installer (CHUNK_7). NON-elevated; requests NO UAC.

  Installs a self-contained pilot into %LOCALAPPDATA%\APHub:
    - consent screen (must type "I AGREE"; lists exactly what telemetry is collected)
    - portable Node 20 + portable PostgreSQL 16 (zip binaries, no installer, no admin)
    - initdb of a PRIVATE cluster on port 55432 (never collides with a system Postgres)
    - runs the existing + broker migrations
    - writes .env (broker URL + non-secret config only; NO API keys, NO secrets ever)
    - probes ports 3000/3001/55432 and FAILS LOUDLY with the occupying PID + name
    - checks >=2 GB free disk; checks pg_isready and prints a Defender-exclusion message on failure
    - registers the non-elevated Task Scheduler watchdog and starts the supervisor

  All secrets that must exist locally (ENCRYPTION_KEY, install token) are DPAPI-protected
  (CurrentUser) at rest in secrets\*.dpapi and NEVER written to the plaintext .env - they
  are unwrapped into the process env only at supervisor start (start-aphub.ps1). API keys
  live ONLY in the broker (Render env).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$BrokerBaseUrl,
  [string]$InstallToken,
  [Parameter(Mandatory = $true)][string]$GmailClientId,
  [string]$GmailClientSecret,
  [Parameter(Mandatory = $true)][string]$GoogleSsoClientId,
  [string]$GoogleSsoClientSecret,
  [Parameter(Mandatory = $true)][string]$QboSandboxClientId,
  [string]$QboSandboxClientSecret,
  [Parameter(Mandatory = $true)][string]$QboSandboxCompanyName,
  [Parameter(Mandatory = $true)][string]$TenantName,
  [Parameter(Mandatory = $true)][string]$OwnerEmail,
  # Portable runtimes: local zip paths (preferred for an offline install) or https URLs.
  [string]$NodeZip = $env:APHUB_NODE_ZIP,
  [string]$PostgresZip = $env:APHUB_PG_ZIP,
  [string]$CredentialBundlePath,
  [string]$RecoveryTarget,
  [string]$AppSource = (Split-Path -Parent $PSScriptRoot),  # the ap-hub repo/app to copy
  [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($CredentialBundlePath) {
  Add-Type -AssemblyName System.Security
  $encrypted = [Convert]::FromBase64String((Get-Content -Raw -LiteralPath $CredentialBundlePath).Trim())
  $json = [Text.Encoding]::UTF8.GetString(
    [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, 'CurrentUser')
  ) | ConvertFrom-Json
  $InstallToken = [string]$json.InstallToken
  $GmailClientSecret = [string]$json.GmailClientSecret
  $GoogleSsoClientSecret = [string]$json.GoogleSsoClientSecret
  $QboSandboxClientSecret = [string]$json.QboSandboxClientSecret
  Remove-Item -LiteralPath $CredentialBundlePath -Force
}
if (-not $InstallToken -or -not $GmailClientSecret -or -not $GoogleSsoClientSecret -or -not $QboSandboxClientSecret) {
  throw 'Secret credentials are required. Use New-PilotCredentialBundle.ps1 and -CredentialBundlePath.'
}

$AppDir  = Join-Path $env:LOCALAPPDATA 'APHub'
$BinDir  = Join-Path $AppDir 'bin'
$AppCode = Join-Path $AppDir 'app'
$PgData  = Join-Path $AppDir 'data\pg'
$RunDir  = Join-Path $AppDir 'run'
$LogDir  = Join-Path $AppDir 'logs'
$EnvFile = Join-Path $AppDir '.env'
$PgPort = 55432; $BackendPort = 3001; $UiPort = 3000

function Fail($msg) { Write-Host "INSTALL FAILED: $msg" -ForegroundColor Red; exit 1 }

# --- 0. Non-elevation sanity: we never want to be running as admin for a pilot install ---
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Warning 'Running elevated. The pilot is designed to install WITHOUT admin rights; a real tester run should be a standard user.'
}

# --- 1. Consent screen (explicit; lists telemetry) ---
$telemetry = @'
AP-Hub pilot collects LIVENESS TELEMETRY ONLY, sent to the key broker:
  - event: one of alive | watchdog_restart | pg_health | shutdown
  - pg_ok: whether the local database answered a health check
  - detail: a short status code (e.g. "backend_exit_1") - never invoice content
  - tz_offset_minutes: your timezone offset, to compute business-hours uptime
It NEVER collects invoice content, vendor names, amounts, emails, or API keys.
No accounting API keys are ever stored on this machine.
'@
Write-Host $telemetry -ForegroundColor Cyan
if (-not $NonInteractive) {
  $answer = Read-Host 'Type I AGREE to continue'
  if ($answer -ne 'I AGREE') { Fail 'consent not given' }
}

# --- 2. Disk check (>=2 GB free on the target drive) ---
$drive = (Get-Item $env:LOCALAPPDATA).PSDrive
if ($drive.Free -lt 2GB) { Fail ("need >=2 GB free on {0}: (have {1:N1} GB)" -f $drive.Name, ($drive.Free / 1GB)) }

# --- 3. Port probes: fail loudly with occupying PID + name (never silently reassign) ---
foreach ($port in @($PgPort, $BackendPort, $UiPort)) {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) {
    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    Fail ("port {0} is already in use by PID {1} ({2}). Free it and re-run - the pilot will not silently move ports (it would break the OAuth redirect URI)." -f $port, $c.OwningProcess, $p.ProcessName)
  }
}

New-Item -ItemType Directory -Force -Path $AppDir, $BinDir, $RunDir, $LogDir, (Split-Path $PgData) | Out-Null

# --- 4. Lock the data dir to the current user (ACL) ---
& icacls "$AppDir" /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null

# --- 5. Portable Node + Postgres ---
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Install-Portable([string]$src, [string]$destName) {
  if (-not $src) { Fail "missing runtime source for $destName (pass -NodeZip/-PostgresZip or set APHUB_NODE_ZIP/APHUB_PG_ZIP)" }
  $zip = $src
  if ($src -match '^https?://') {
    $zip = Join-Path $env:TEMP ("aphub-{0}.zip" -f $destName)
    Invoke-WebRequest -Uri $src -OutFile $zip -UseBasicParsing
  }
  $dest = Join-Path $BinDir $destName
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  # ZipFile::ExtractToDirectory is far faster than Expand-Archive on large archives
  # (the PostgreSQL binaries zip is ~300 MB).
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $dest)
}
Install-Portable $NodeZip 'node'
Install-Portable $PostgresZip 'pgsql'

# Flatten single-root zips so the expected executables are at a stable path:
#   bin\node\node.exe        (node zip roots at node-v20.x-win-x64\node.exe)
#   bin\pgsql\bin\postgres.exe (EDB pg zip roots at pgsql\bin\postgres.exe)
$markers = @{ node = 'node.exe'; pgsql = 'bin\postgres.exe' }
foreach ($d in @('node','pgsql')) {
  $root = Join-Path $BinDir $d
  if (-not (Test-Path (Join-Path $root $markers[$d]))) {
    $inner = Get-ChildItem $root -Directory | Select-Object -First 1
    if ($inner) {
      Get-ChildItem $inner.FullName -Force | Move-Item -Destination $root -Force
      Remove-Item $inner.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

# --- 6. Copy the app code (excluding local data AND any .env) ---
# CRITICAL: never copy a source .env into the pilot - a developer/source .env can carry
# real API keys, and the pilot must hold NO API keys on disk. The pilot's own keyless
# .env is generated fresh at $AppDir\.env below (loaded by the supervisor into the
# child env; the app's dotenv.config() then finds no .env in $AppCode and no-ops).
if (Test-Path $AppCode) { Remove-Item -Recurse -Force $AppCode }
New-Item -ItemType Directory -Force -Path $AppCode | Out-Null
# Exclude dev-only trees: node_modules (reinstalled), .git, local data, and the test
# suites (a pilot never runs them, and their fixtures contain literal key-shaped strings
# like "ssk_live_testkey123" that would otherwise show up in a key-custody scan).
robocopy $AppSource $AppCode /E /XD node_modules .git data test e2e coverage playwright-report (Join-Path $AppSource 'pilot\data') /XF .env .env.* *.local /NFL /NDL /NJH /NJS /NC /NS | Out-Null

# --- 7. initdb the private cluster ---
$initdb = Join-Path $BinDir 'pgsql\bin\initdb.exe'
if (-not (Test-Path $PgData)) {
  $pwFile = Join-Path $env:TEMP 'aphub_pgpw.txt'
  'aphub' | Set-Content -NoNewline $pwFile
  & $initdb -D $PgData -U aphub -A md5 --pwfile=$pwFile -E UTF8 | Out-Null
  Remove-Item $pwFile -Force
  if ($LASTEXITCODE -ne 0) { Fail 'initdb failed (see output). If antivirus/Controlled Folder Access blocked it, add a Defender exclusion for %LOCALAPPDATA%\APHub and re-run.' }
}
# Bind the private cluster to the private port + loopback only.
Add-Content (Join-Path $PgData 'postgresql.conf') "`nport = $PgPort`nlisten_addresses = '127.0.0.1'"

# --- 8. Start Postgres and verify with pg_isready (Defender message on failure) ---
$pgctl = Join-Path $BinDir 'pgsql\bin\pg_ctl.exe'
& $pgctl -D $PgData -l (Join-Path $LogDir 'pg.init.log') -w start | Out-Null
$isready = Join-Path $BinDir 'pgsql\bin\pg_isready.exe'
& $isready -h '127.0.0.1' -p $PgPort | Out-Null
if ($LASTEXITCODE -ne 0) {
  Fail "pg_isready failed on port $PgPort. Most often antivirus / Controlled Folder Access blocked Postgres. Add a Windows Defender exclusion:`n  Add-MpPreference -ExclusionPath '$AppDir'`nthen re-run this installer."
}

# Create the aphub database if absent.
$psql = Join-Path $BinDir 'pgsql\bin\psql.exe'
$env:PGPASSWORD = 'aphub'
& $psql -h 127.0.0.1 -p $PgPort -U aphub -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='aphub'" | ForEach-Object {
  if ($_ -ne '1') { & $psql -h 127.0.0.1 -p $PgPort -U aphub -d postgres -c 'CREATE DATABASE aphub' | Out-Null }
}

# --- 9. Write .env - public/non-secret config only.
# ENCRYPTION_KEY and BROKER_INSTALL_TOKEN are NOT written here in plaintext - they are
# DPAPI-wrapped below (secrets\*.dpapi) and injected into the process env at supervisor
# start (start-aphub.ps1), so they never touch disk unencrypted.
function New-CryptoHex([int]$Bytes = 32) {
  $buffer = New-Object byte[] $Bytes
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
  return -join ($buffer | ForEach-Object { $_.ToString('x2') })
}
$encKey = New-CryptoHex
$sessionSecret = New-CryptoHex
@"
# AP-Hub pilot .env - generated by install-pilot.ps1. NO API keys live here.
# ENCRYPTION_KEY and BROKER_INSTALL_TOKEN are injected at runtime from DPAPI-wrapped
# files in secrets\ (see start-aphub.ps1) - they are intentionally absent from this file.
DATABASE_URL=postgres://aphub:aphub@127.0.0.1:$PgPort/aphub
BROKER_BASE_URL=$BrokerBaseUrl
GMAIL_CLIENT_ID=$GmailClientId
GOOGLE_SSO_CLIENT_ID=$GoogleSsoClientId
QBO_SANDBOX_CLIENT_ID=$QboSandboxClientId
QBO_SANDBOX_COMPANY_NAME=$QboSandboxCompanyName
GMAIL_REDIRECT_URI=http://localhost:$BackendPort/oauth/gmail/callback
QBO_SANDBOX_REDIRECT_URI=http://localhost:$BackendPort/oauth/qbo/callback
WEB_BASE_URL=http://localhost:$UiPort
PORT=$BackendPort
QBO_ENV=sandbox
LOG_LEVEL=info
"@ | Set-Content -Encoding utf8 $EnvFile

# Protect ENCRYPTION_KEY + install token at rest via DPAPI (CurrentUser).
$secDir = Join-Path $AppDir 'secrets'; New-Item -ItemType Directory -Force -Path $secDir | Out-Null
Add-Type -AssemblyName System.Security
function Protect-Secret([string]$name, [string]$value) {
  $b = [Text.Encoding]::UTF8.GetBytes($value)
  $e = [Security.Cryptography.ProtectedData]::Protect($b, $null, 'CurrentUser')
  [Convert]::ToBase64String($e) | Set-Content -NoNewline (Join-Path $secDir "$name.dpapi")
}
Protect-Secret 'encryption_key' $encKey
Protect-Secret 'broker_install_token' $InstallToken
Protect-Secret 'session_cookie_secret' $sessionSecret
Protect-Secret 'gmail_client_secret' $GmailClientSecret
Protect-Secret 'google_sso_client_secret' $GoogleSsoClientSecret
Protect-Secret 'qbo_sandbox_client_secret' $QboSandboxClientSecret

# Recovery is not certified by leaving another plaintext key on the same disk.
# Require a removable drive or UNC/network target, copy the DPAPI artifacts, and
# prove the copied encryption key can be restored by this Windows user.
if (-not $RecoveryTarget) { throw 'RecoveryTarget is required (removable drive or UNC/network path).' }
$isNetwork = $RecoveryTarget -match '^[\\]{2}'
$isRemovable = $false
if (-not $isNetwork) {
  try {
    $root = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($RecoveryTarget))
    $isRemovable = ([IO.DriveInfo]::new($root)).DriveType -eq [IO.DriveType]::Removable
  } catch { $isRemovable = $false }
}
if (-not ($isNetwork -or $isRemovable)) {
  throw 'RecoveryTarget must be a UNC/network location or removable drive, not the application disk.'
}
$recoveryDir = Join-Path $RecoveryTarget ("APHub-Recovery-{0}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $recoveryDir | Out-Null
Copy-Item -Path (Join-Path $secDir '*.dpapi') -Destination $recoveryDir
$copiedKey = Join-Path $recoveryDir 'encryption_key.dpapi'
$restoredEncrypted = [Convert]::FromBase64String((Get-Content -Raw -LiteralPath $copiedKey).Trim())
$restoredKey = [Text.Encoding]::UTF8.GetString(
  [Security.Cryptography.ProtectedData]::Unprotect($restoredEncrypted, $null, 'CurrentUser')
)
$restorePassed = $restoredKey -eq $encKey
if (-not $restorePassed) { throw 'Recovery restore proof failed.' }
$sha = [Security.Cryptography.SHA256]::Create()
try { $restoredHash = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($restoredKey)) | ForEach-Object { $_.ToString('x2') }) }
finally { $sha.Dispose() }
@{
  createdAt = (Get-Date).ToString('o')
  target = $recoveryDir
  restorePassed = $true
  encryptionKeySha256 = $restoredHash
} | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $recoveryDir 'recovery-proof.json')
# The install-time migrate/bootstrap child processes need the same values. They
# remain in process memory only; the supervisor later reloads them from DPAPI.
$env:ENCRYPTION_KEY = $encKey
$env:BROKER_INSTALL_TOKEN = $InstallToken
$env:SESSION_COOKIE_SECRET = $sessionSecret
$env:GMAIL_CLIENT_SECRET = $GmailClientSecret
$env:GOOGLE_SSO_CLIENT_SECRET = $GoogleSsoClientSecret
$env:QBO_SANDBOX_CLIENT_SECRET = $QboSandboxClientSecret
$env:GOOGLE_SSO_CLIENT_ID = $GoogleSsoClientId
$env:GMAIL_CLIENT_ID = $GmailClientId

# --- 10. Install deps, build the UI, run migrations ---
# devDependencies ARE needed at runtime: the backend runs via tsx (src/index.ts) and
# the UI is served by `next start`, which requires a production build first. Playwright
# browsers are not needed by the pilot, so skip that heavy postinstall download.
$node = Join-Path $BinDir 'node\node.exe'
$npm  = Join-Path $BinDir 'node\npm.cmd'
Push-Location $AppCode
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
$env:DATABASE_URL = "postgres://aphub:aphub@127.0.0.1:$PgPort/aphub"
& $npm install --no-audit --no-fund | Out-Null
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail 'npm install failed.' }
& $npm run web:build | Out-Null
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail 'web:build (next build) failed - UI cannot start without it.' }
& $npm run migrate:up | Out-Null
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail 'migrations failed - install aborted (no half-migrated state left running).' }
$tenantCount = (& $psql -h 127.0.0.1 -p $PgPort -U aphub -d aphub -tAc 'SELECT count(*) FROM tenants').Trim()
if ($tenantCount -eq '0') {
  & $npm run cli -- bootstrap-tenant --name $TenantName --owner-email $OwnerEmail | Out-Null
  if ($LASTEXITCODE -ne 0) { Pop-Location; Fail 'first-owner provisioning failed.' }
}
Pop-Location

# --- 11. Register the non-elevated watchdog + start the supervisor ---
$taskXml = Join-Path $AppCode 'pilot\aphub-watchdog.xml'
$supervisor = Join-Path $AppCode 'pilot\start-aphub.ps1'
# Materialise the task XML with the concrete supervisor path.
(Get-Content $taskXml -Raw).Replace('__SUPERVISOR_PATH__', $supervisor).Replace('__WORKDIR__', $AppDir) |
  Set-Content -Encoding Unicode (Join-Path $RunDir 'aphub-watchdog.xml')
& schtasks /Create /TN 'APHubWatchdog' /XML (Join-Path $RunDir 'aphub-watchdog.xml') /F | Out-Null

Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File', $supervisor) | Out-Null

Write-Host "AP-Hub pilot installed to $AppDir." -ForegroundColor Green
Write-Host "Open http://localhost:$UiPort/onboarding to finish Gmail + QBO sandbox setup." -ForegroundColor Green
