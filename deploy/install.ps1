<#
.SYNOPSIS
  Command-line ap-hub installer (no GUI). Discovers credentials from the machine,
  writes .env, provisions the database, installs deps, migrates, and starts the
  service. For the guided popup experience, run install-gui.ps1 instead.

.DESCRIPTION
  Non-interactive by default: it uses auto-discovered/generated values and any
  values already in your environment. Required keys that can't be discovered
  (ANTHROPIC_API_KEY, GMAIL_CLIENT_ID/SECRET) must be present in the environment
  or passed via -Set, or the app will boot-fail until you add them to .env.

.PARAMETER Set
  One or more NAME=VALUE overrides, e.g.
    -Set ANTHROPIC_API_KEY=sk-ant-... GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=...

.PARAMETER AppPort
  Local port for the service (default 3000).
#>
[CmdletBinding()]
param(
  [string[]]$Set = @(),
  [int]$AppPort = 3000,
  [int]$PgPort = 5432,
  [string]$PgSuperuser = "postgres"
)

. (Join-Path $PSScriptRoot 'install-core.ps1')

$disc = Get-ApHubDiscoveredCredentials -PgPort $PgPort
$values = @{}
foreach ($f in $disc.Fields) { $values[$f.Name] = $f.Value }

# Apply NAME=VALUE overrides from -Set.
foreach ($pair in $Set) {
  $i = $pair.IndexOf('=')
  if ($i -gt 0) { $values[$pair.Substring(0, $i)] = $pair.Substring($i + 1) }
}

Write-Host "ap-hub install - discovered:"
foreach ($f in $disc.Fields) {
  $shown = if ($f.Secret -and $values[$f.Name]) { "(set)" } else { $values[$f.Name] }
  Write-Host ("  {0,-26} {1,-14} {2}" -f $f.Name, ("[" + $f.Source + "]"), $shown)
}
if ($disc.ClaudeCliDetected) { Write-Host "  Claude CLI detected on this machine." }

$missing = @()
foreach ($f in $disc.Fields) { if ($f.Required -and [string]::IsNullOrWhiteSpace([string]$values[$f.Name])) { $missing += $f.Name } }
if ($missing.Count -gt 0) {
  Write-Warning ("Required value(s) still empty: {0}. The service will boot-fail until these are set (pass -Set NAME=VALUE, or set them in the environment and re-run)." -f ($missing -join ", "))
}

$onProgress = { param($p) Write-Host ("[{0,3}%] {1}" -f [int]$p.Percent, $p.Message) }
$result = Invoke-ApHubInstall -Values $values -AppPort $AppPort -PgPort $PgPort -PgSuperuser $PgSuperuser -OnProgress $onProgress

if ($result.Success) {
  Write-Host ""
  Write-Host ("ap-hub is running at {0}/health" -f $result.AppUrl) -ForegroundColor Green
  if ($result.RecoveryWasCreated) { Write-Host ("Recovery key saved to {0} - store it safely." -f $result.RecoveryKeyPath) }
  exit 0
} else {
  Write-Error ("Install failed: {0}" -f $result.Error)
  exit 1
}
