<#
  uninstall-pilot.ps1 — remove the AP-Hub pilot (CHUNK_7). NON-elevated.

  Default: unregister the watchdog task, stop the supervisor + child processes, and STOP.
  It PRESERVES all local accounting data by default. Deleting the data (the Postgres
  cluster, .env, secrets) requires a SEPARATE explicit typed confirmation (-PurgeData and
  typing DELETE ALL DATA), never the default path.
#>
[CmdletBinding()]
param(
  [string]$AppDir = (Join-Path $env:LOCALAPPDATA 'APHub'),
  [switch]$PurgeData,
  [switch]$NonInteractive
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version Latest

$BinDir = Join-Path $AppDir 'bin'
$PgData = Join-Path $AppDir 'data\pg'

# --- 1. Unregister the watchdog task (idempotent) ---
& schtasks /Delete /TN 'APHubWatchdog' /F 2>$null | Out-Null

# --- 2. Stop the supervisor + children (best-effort; never fail the uninstall) ---
$pgctl = Join-Path $BinDir 'pgsql\bin\pg_ctl.exe'
if (Test-Path $pgctl) { & $pgctl -D $PgData -m fast stop 2>$null | Out-Null }
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='postgres.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$AppDir*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Host 'AP-Hub pilot stopped and the watchdog task was removed.' -ForegroundColor Green

# --- 3. Data deletion is opt-in and requires a separate typed confirmation ---
if (-not $PurgeData) {
  Write-Host "Local accounting data is PRESERVED at $AppDir." -ForegroundColor Yellow
  Write-Host 'To delete ALL local data, re-run with -PurgeData (a separate typed confirmation is required).'
  return
}

if (-not $NonInteractive) {
  Write-Host "This will PERMANENTLY DELETE all local AP-Hub data under $AppDir." -ForegroundColor Red
  $confirm = Read-Host 'Type DELETE ALL DATA to confirm'
  if ($confirm -ne 'DELETE ALL DATA') { Write-Host 'Confirmation not given — data preserved.'; return }
}

Remove-Item -Recurse -Force $AppDir -ErrorAction SilentlyContinue
Write-Host "All local AP-Hub data under $AppDir has been deleted." -ForegroundColor Green
