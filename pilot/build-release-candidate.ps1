<#
  build-release-candidate.ps1 (Decision 3) - produce a fresh, verifiable pilot release
  candidate from the merged tree and a tamper-evident manifest.

  Runs the full gate, builds the production app, records the git commit, a cryptographic
  hash of the packaged artifact, the schema version (highest applied migration), the app
  version, and the bundled portable-runtime versions, then writes release-manifest.json.

  A tester's install is verified against this manifest (commit + artifact hash) so the
  running code provably matches the recorded release candidate.

  USAGE (from the repo root):
    .\pilot\build-release-candidate.ps1 -NodeZip <node20.zip> -PostgresZip <pg16.zip> -OutDir <dir>
#>
[CmdletBinding()]
param(
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$NodeZip = $env:APHUB_NODE_ZIP,
  [string]$PostgresZip = $env:APHUB_PG_ZIP,
  [string]$OutDir = (Join-Path ([IO.Path]::GetTempPath()) 'aphub-rc'),
  [string]$DatabaseUrl = 'postgres://aphub:aphub@127.0.0.1:5432/aphub'
)
$ErrorActionPreference = 'Stop'
Push-Location $RepoRoot
$env:DATABASE_URL = $DatabaseUrl
$fail = @()
function Step([string]$name, [scriptblock]$b) {
  Write-Host "== $name ==" -ForegroundColor Cyan
  & $b; if ($LASTEXITCODE -ne 0) { $script:fail += $name; Write-Host "  FAILED ($LASTEXITCODE)" -ForegroundColor Red }
}

# --- Gate: migrations, tests, typecheck, lint, no-leak, production build ---
Step 'migrate:up'  { npm run migrate:up 2>&1 | Out-Host }
Step 'typecheck'   { npm run typecheck 2>&1 | Out-Host }
Step 'lint'        { npm run lint 2>&1 | Out-Host }
Step 'lint:noleak' { npm run lint:noleak 2>&1 | Out-Host }
Step 'test'        { npm test 2>&1 | Out-Host }
Step 'broker test' {
  # broker owns a separate DB (aphub_broker); don't leak the app-level DATABASE_URL into it.
  $prevDbUrl = $env:DATABASE_URL
  $env:DATABASE_URL = 'postgres://aphub:aphub@127.0.0.1:5432/aphub_broker'
  npm --prefix broker test 2>&1 | Out-Host
  $env:DATABASE_URL = $prevDbUrl
}
Step 'web:build'   { npm run web:build 2>&1 | Out-Host }

# --- Package: copy the app (excluding node_modules/.git/data/test/.env) into OutDir\app ---
$appOut = Join-Path $OutDir 'app'
if (Test-Path $appOut) { Remove-Item -Recurse -Force $appOut }
New-Item -ItemType Directory -Force $appOut | Out-Null
robocopy $RepoRoot $appOut /E /XD node_modules .git data test e2e coverage playwright-report /XF .env .env.* *.local /NFL /NDL /NJH /NJS /NC /NS | Out-Null

# --- Record identity ---
$commit = (git rev-parse HEAD).Trim()
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
$schemaVersion = (Get-ChildItem "$RepoRoot\migrations" -Filter '*.sql' | Where-Object { $_.Name -notlike '*.down.sql' } | Sort-Object Name | Select-Object -Last 1).BaseName
$pkg = Get-Content "$RepoRoot\package.json" -Raw | ConvertFrom-Json
$brokerPkg = Get-Content "$RepoRoot\broker\package.json" -Raw | ConvertFrom-Json

# Deterministic artifact hash: SHA-256 over sorted (relpath + file sha) of the packaged app.
$hashLines = Get-ChildItem $appOut -Recurse -File | Sort-Object FullName | ForEach-Object {
  $rel = $_.FullName.Substring($appOut.Length + 1); "$rel  $((Get-FileHash $_.FullName -Algorithm SHA256).Hash)"
}
$manifestFilesPath = Join-Path $OutDir 'files.sha256'
$hashLines | Set-Content -Encoding ascii $manifestFilesPath
$artifactHash = (Get-FileHash $manifestFilesPath -Algorithm SHA256).Hash

$manifest = [ordered]@{
  name              = 'ap-hub-pilot'
  builtAt           = (Get-Date).ToUniversalTime().ToString('o')
  gitCommit         = $commit
  gitBranch         = $branch
  appVersion        = $pkg.version
  brokerVersion     = $brokerPkg.version
  schemaVersion     = $schemaVersion
  artifactHash      = "sha256:$artifactHash"
  filesManifest     = 'files.sha256'
  gatePassed        = ($fail.Count -eq 0)
  gateFailures      = $fail
  bundled           = [ordered]@{
    node     = if ($NodeZip) { Split-Path -Leaf $NodeZip } else { 'not-provided' }
    postgres = if ($PostgresZip) { Split-Path -Leaf $PostgresZip } else { 'not-provided' }
  }
}
$manifestPath = Join-Path $OutDir 'release-manifest.json'
$manifest | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $manifestPath
Write-Host "`nRelease manifest -> $manifestPath" -ForegroundColor Green
$manifest | ConvertTo-Json -Depth 6 | Write-Host
if ($fail.Count) { Write-Host "GATE FAILURES: $($fail -join ', ') - NOT a valid RC" -ForegroundColor Red; Pop-Location; exit 1 }
Write-Host "Release candidate OK. Verify a tester install with: gitCommit=$commit artifactHash=sha256:$artifactHash" -ForegroundColor Green
Pop-Location
