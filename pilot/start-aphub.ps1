<#
  start-aphub.ps1 - AP-Hub pilot supervisor (CHUNK_7). NON-elevated.

  Supervises the three pilot processes and keeps them alive:
    - postgres.exe  -D <data\pg>  -p 55432   (portable Postgres, private port)
    - node app\src\index.ts        :3001     (pipeline + OAuth callbacks)
    - node next start              :3000     (UI)

  - Takes an exclusive lock on run\supervisor.lock; a second instance exits 0 silently
    (Task Scheduler's MultipleInstancesPolicy=IgnoreNew is belt-and-braces).
  - Emits an `alive` heartbeat every 60s and a `watchdog_restart` on any restart
    (reason=cold_start when it launches everything from a cold machine).
  - Heartbeat sends are FAIL-SAFE: a broker error or outage is logged and dropped and
    NEVER stops supervision. No API keys are ever read or sent - telemetry is liveness only.
#>
[CmdletBinding()]
param(
  [string]$AppDir = (Join-Path $env:LOCALAPPDATA 'APHub')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Windows PowerShell 5.1 defaults to TLS 1.0/1.1; the broker (and any modern HTTPS host)
# requires TLS 1.2+. Without this, Invoke-RestMethod to https://...onrender.com times out.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$RunDir   = Join-Path $AppDir 'run'
$LogDir   = Join-Path $AppDir 'logs'
$BinDir   = Join-Path $AppDir 'bin'
$AppCode  = Join-Path $AppDir 'app'
$PgData   = Join-Path $AppDir 'data\pg'
$EnvFile  = Join-Path $AppDir '.env'
$SecDir   = Join-Path $AppDir 'secrets'

$PgPort      = 55432
$BackendPort = 3001
$UiPort      = 3000
$HeartbeatIntervalSec = 60
$PollSec = 5

New-Item -ItemType Directory -Force -Path $RunDir, $LogDir | Out-Null

# --- Load .env (KEY=VALUE lines) into the process environment. No secrets are logged. ---
# .env holds only non-secret config (DATABASE_URL, BROKER_BASE_URL, Gmail client id/secret,
# PORT, QBO_ENV, LOG_LEVEL). ENCRYPTION_KEY and BROKER_INSTALL_TOKEN are never written there.
$script:BrokerBaseUrl = $null
if (Test-Path $EnvFile) {
  Get-Content $EnvFile | ForEach-Object {
    if ($_ -match '^\s*#') { return }
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
      $k = $Matches[1]; $v = $Matches[2].Trim('"')
      [Environment]::SetEnvironmentVariable($k, $v)
      if ($k -eq 'BROKER_BASE_URL') { $script:BrokerBaseUrl = $v }
    }
  }
}

# --- Unwrap DPAPI-protected secrets (CurrentUser) and inject into the process env so
# child processes (backend, UI) inherit them. The plaintext never touches disk - it lives
# only in this process's memory and the memory of the children it spawns. ---
Add-Type -AssemblyName System.Security
function Unprotect-Secret {
  param([string]$Name)
  $f = Join-Path $SecDir "$Name.dpapi"
  if (-not (Test-Path $f)) { return $null }
  $e = [Convert]::FromBase64String((Get-Content $f -Raw).Trim())
  $d = [Security.Cryptography.ProtectedData]::Unprotect($e, $null, 'CurrentUser')
  return [Text.Encoding]::UTF8.GetString($d)
}
$script:BrokerToken = Unprotect-Secret 'broker_install_token'
$protectedEnv = @{
  BROKER_INSTALL_TOKEN = 'broker_install_token'
  ENCRYPTION_KEY = 'encryption_key'
  SESSION_COOKIE_SECRET = 'session_cookie_secret'
  GMAIL_CLIENT_SECRET = 'gmail_client_secret'
  GOOGLE_SSO_CLIENT_SECRET = 'google_sso_client_secret'
  QBO_SANDBOX_CLIENT_SECRET = 'qbo_sandbox_client_secret'
}
foreach ($envName in $protectedEnv.Keys) {
  $secret = Unprotect-Secret $protectedEnv[$envName]
  if ($secret) { [Environment]::SetEnvironmentVariable($envName, $secret) }
}

function Send-Heartbeat {
  param(
    [ValidateSet('alive','watchdog_restart','pg_health','shutdown')][string]$Event,
    [Nullable[bool]]$PgOk = $null,
    [string]$Detail = $null
  )
  # FAIL-SAFE: telemetry must never stop supervision.
  if (-not $script:BrokerBaseUrl -or -not $script:BrokerToken) { return }
  try {
    $body = @{ event = $Event; tz_offset_minutes = ([int]([TimeZoneInfo]::Local).GetUtcOffset([DateTime]::Now).TotalMinutes) }
    if ($null -ne $PgOk) { $body.pg_ok = [bool]$PgOk }
    if ($Detail) { $body.detail = $Detail }
    Invoke-RestMethod -Method Post -Uri ("{0}/v1/heartbeat" -f $script:BrokerBaseUrl.TrimEnd('/')) `
      -Headers @{ Authorization = "Bearer $script:BrokerToken" } `
      -ContentType 'application/json' -Body ($body | ConvertTo-Json -Compress) -TimeoutSec 15 | Out-Null
  } catch {
    Write-Warning "heartbeat '$Event' dropped: $($_.Exception.Message)"
  }
}

function Test-PortListening {
  param([int]$Port)
  $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  return [bool]$c
}

# --- Child registry: label -> @{ Proc; Start = scriptblock returning a Process } ---
$children = @{}

function Start-Postgres {
  $exe = Join-Path $BinDir 'pgsql\bin\postgres.exe'
  Start-Process -FilePath $exe -ArgumentList @('-D', $PgData, '-p', "$PgPort") `
    -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $LogDir 'pg.err.log') `
    -RedirectStandardOutput (Join-Path $LogDir 'pg.out.log')
}
function Start-Backend {
  $node = Join-Path $BinDir 'node\node.exe'
  $tsx  = Join-Path $AppCode 'node_modules\tsx\dist\cli.mjs'
  Start-Process -FilePath $node -ArgumentList @($tsx, (Join-Path $AppCode 'src\index.ts')) `
    -WorkingDirectory $AppCode -WindowStyle Hidden -PassThru `
    -RedirectStandardError (Join-Path $LogDir 'backend.err.log') `
    -RedirectStandardOutput (Join-Path $LogDir 'backend.out.log')
}
function Start-Ui {
  $node = Join-Path $BinDir 'node\node.exe'
  $next = Join-Path $AppCode 'node_modules\next\dist\bin\next'
  Start-Process -FilePath $node -ArgumentList @($next, 'start', '-p', "$UiPort", '-H', '127.0.0.1') `
    -WorkingDirectory $AppCode -WindowStyle Hidden -PassThru `
    -RedirectStandardError (Join-Path $LogDir 'ui.err.log') `
    -RedirectStandardOutput (Join-Path $LogDir 'ui.out.log')
}

$starters = @{ postgres = ${function:Start-Postgres}; backend = ${function:Start-Backend}; ui = ${function:Start-Ui} }

# --- Exclusive lock: only one supervisor runs. Second instance exits 0 silently. ---
$lockPath = Join-Path $RunDir 'supervisor.lock'
try {
  $lock = [System.IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
  Write-Host 'Another supervisor holds the lock; exiting.'
  exit 0
}

$stop = $false
$null = Register-EngineEvent -SourceIdentifier ([System.Management.Automation.PsEngineEvent]::Exiting) -Action { $script:stop = $true }

try {
  # Cold start: nothing is listening yet -> start all three, emit cold_start.
  $coldStart = -not (Test-PortListening -Port $PgPort)
  foreach ($label in 'postgres','backend','ui') {
    $children[$label] = & $starters[$label]
  }
  if ($coldStart) { Send-Heartbeat -Event 'watchdog_restart' -Detail 'cold_start' }

  $lastBeat = [DateTime]::MinValue
  $lastPgCheck = [DateTime]::MinValue

  while (-not $stop) {
    Start-Sleep -Seconds $PollSec

    # Restart any dead child (never re-create a live one).
    foreach ($label in @($children.Keys)) {
      $p = $children[$label]
      if ($null -eq $p -or $p.HasExited) {
        $code = if ($p) { $p.ExitCode } else { 'none' }
        $children[$label] = & $starters[$label]
        Send-Heartbeat -Event 'watchdog_restart' -Detail ("{0}_exit_{1}" -f $label, $code)
      }
    }

    # pg health every ~60s.
    if (([DateTime]::Now - $lastPgCheck).TotalSeconds -ge $HeartbeatIntervalSec) {
      $pgReady = & (Join-Path $BinDir 'pgsql\bin\pg_isready.exe') -h '127.0.0.1' -p $PgPort 2>$null; $ok = ($LASTEXITCODE -eq 0)
      Send-Heartbeat -Event 'pg_health' -PgOk $ok -Detail ($(if ($ok) { 'pg_ok' } else { 'pg_unready' }))
      $lastPgCheck = [DateTime]::Now
    }

    # alive every 60s.
    if (([DateTime]::Now - $lastBeat).TotalSeconds -ge $HeartbeatIntervalSec) {
      Send-Heartbeat -Event 'alive'
      $lastBeat = [DateTime]::Now
    }
  }
} finally {
  Send-Heartbeat -Event 'shutdown'
  $lock.Close()
}
