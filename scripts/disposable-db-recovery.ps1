<#
.SYNOPSIS
  Backup, restore, or rehearse recovery for an explicitly disposable AP Hub database.

.DESCRIPTION
  Safety is enforced by requiring the database name to start with "aphub_disposable_".
  This script is evidence tooling; it will not operate on the normal "aphub" database.
#>
[CmdletBinding()]
param(
  [ValidateSet("Backup", "Restore", "Rehearse")]
  [string]$Action = "Rehearse",
  [Parameter(Mandatory = $true)]
  [string]$Database,
  [string]$HostName = "127.0.0.1",
  [int]$Port = 5432,
  [string]$Username = "aphub",
  [string]$BackupPath = "",
  [switch]$KeepDatabase
)

$ErrorActionPreference = "Stop"

if ($Database -notmatch '^aphub_disposable_[a-zA-Z0-9_]+$') {
  throw "Refusing database '$Database'. Recovery evidence is limited to names beginning aphub_disposable_."
}
foreach ($command in @("psql", "createdb", "dropdb", "pg_dump", "pg_restore")) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
    throw "Required PostgreSQL tool '$command' was not found on PATH."
  }
}
if (-not $BackupPath) {
  $BackupPath = Join-Path $env:TEMP "$Database.backup"
}

function Invoke-Backup {
  & pg_dump --host=$HostName --port=$Port --username=$Username --format=custom --file=$BackupPath $Database
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $BackupPath)) {
    throw "pg_dump failed for disposable database."
  }
}

function Invoke-Restore {
  if (-not (Test-Path -LiteralPath $BackupPath)) {
    throw "Backup file '$BackupPath' does not exist."
  }
  & dropdb --host=$HostName --port=$Port --username=$Username --if-exists $Database
  if ($LASTEXITCODE -ne 0) { throw "dropdb failed for disposable database." }
  & createdb --host=$HostName --port=$Port --username=$Username $Database
  if ($LASTEXITCODE -ne 0) { throw "createdb failed for disposable database." }
  & pg_restore --host=$HostName --port=$Port --username=$Username --dbname=$Database --exit-on-error $BackupPath
  if ($LASTEXITCODE -ne 0) { throw "pg_restore failed for disposable database." }
}

switch ($Action) {
  "Backup" { Invoke-Backup }
  "Restore" { Invoke-Restore }
  "Rehearse" {
    & dropdb --host=$HostName --port=$Port --username=$Username --if-exists $Database
    & createdb --host=$HostName --port=$Port --username=$Username $Database
    & psql --host=$HostName --port=$Port --username=$Username --dbname=$Database `
      --set=ON_ERROR_STOP=1 --command="CREATE TABLE recovery_probe(id integer PRIMARY KEY, marker text NOT NULL); INSERT INTO recovery_probe VALUES (1, 'before-backup');"
    if ($LASTEXITCODE -ne 0) { throw "Disposable recovery fixture creation failed." }
    Invoke-Backup
    Invoke-Restore
    $marker = (& psql --host=$HostName --port=$Port --username=$Username --dbname=$Database `
      --tuples-only --no-align --command="SELECT marker FROM recovery_probe WHERE id=1;").Trim()
    if ($LASTEXITCODE -ne 0 -or $marker -ne "before-backup") {
      throw "Recovery verification failed: expected marker was not restored."
    }
    Write-Output "RECOVERY_REHEARSAL_PASS database=$Database marker=$marker"
    if (-not $KeepDatabase) {
      & dropdb --host=$HostName --port=$Port --username=$Username --if-exists $Database
    }
  }
}
