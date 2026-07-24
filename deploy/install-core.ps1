<#
.SYNOPSIS
  Shared, GUI-agnostic install logic for ap-hub (AI Accountant Hub).

.DESCRIPTION
  ONE source of truth for the Windows install path, dot-sourced by both the
  command-line installer (install.ps1) and the guided GUI installer
  (install-gui.ps1). Nothing here draws UI; callers render progress via the
  -OnProgress callback.

  Key feature: credential AUTO-DISCOVERY. Get-ApHubDiscoveredCredentials scans
  the machine (environment variables across Process/User/Machine scopes, a
  detected Claude CLI, a running PostgreSQL) and auto-generates what it can
  (ENCRYPTION_KEY), so the operator never has to hunt for keys they already
  have. The GUI pre-fills every field from this and only asks for genuine gaps.

  Provides:
    Get-ApHubPrerequisites        -> prerequisite checks (name/ok/detail/fix)
    Test-ApHubReady               -> $true when every check passes or auto-fixes
    Get-ApHubPaths                -> resolved .env / recovery-key paths
    Get-ApHubCredentialFields     -> the static field catalog (name/required/...)
    Get-ApHubDiscoveredCredentials-> field catalog with discovered/generated values
    Test-RecoverySaved            -> the "user confirmed they saved the key" gate
    Invoke-ApHubInstall           -> run the real install, reporting via -OnProgress

  QBO writes remain sandbox-only. Gmail access may create drafts but never send
  replies. QBD is disabled by default and requires explicit company-bound write
  enablement; the installer makes no accuracy or authority claim.

  Run directly for CI/self-checks (no GUI, no install):
    powershell -File install-core.ps1 -EmitPrereqJson
    powershell -File install-core.ps1 -EmitCredentialsJson
#>
[CmdletBinding()]
param(
  [switch]$EmitPrereqJson,
  [switch]$EmitCredentialsJson,
  [int]$AppPort = 3001
)

function Test-CommandExists {
  param([string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Add-PostgresBinToPath {
  # Put psql on PATH if a known PostgreSQL bin dir exists (standard installer,
  # or the portable EDB zip layout under the user profile).
  if (Test-CommandExists "psql") { return }
  $candidates = @(
    "C:\Program Files\PostgreSQL\16\bin",
    "C:\Program Files\PostgreSQL\15\bin",
    (Join-Path $env:USERPROFILE "pg16\pgsql\bin"),
    (Join-Path $env:USERPROFILE "pgsql\bin")
  )
  foreach ($c in $candidates) {
    if (Test-Path (Join-Path $c "psql.exe")) { $env:PATH = "$c;$env:PATH"; return }
  }
}

function Test-PortFree {
  param([int]$Port = 3000)
  $listener = $null
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    return $true
  } catch { return $false }
  # TcpListener is NOT IDisposable on .NET Framework (Windows PowerShell 5.1);
  # .Stop() releases the socket on both editions. Do NOT add .Dispose().
  finally { if ($listener) { $listener.Stop() } }
}

# One high-entropy 32-byte value as 64 lowercase hex chars (ENCRYPTION_KEY shape).
function New-HexSecret {
  param([int]$Bytes = 32)
  $buf = New-Object 'System.Byte[]' $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($buf) } finally { $rng.Dispose() }
  -join ($buf | ForEach-Object { $_.ToString("x2") })
}

# Read the first non-blank value for any of $Names across Process/User/Machine.
function Get-EnvAny {
  param([string[]]$Names)
  foreach ($n in $Names) {
    foreach ($scope in @('Process', 'User', 'Machine')) {
      $v = [System.Environment]::GetEnvironmentVariable($n, $scope)
      if ($v -and $v.Trim() -ne "") {
        return [pscustomobject]@{ Value = $v.Trim(); Var = $n }
      }
    }
  }
  return $null
}

function New-PrereqCheck {
  param([string]$Name, [bool]$Ok, [string]$Detail, [string]$FixHint = "", [bool]$CanAutoFix = $false)
  [pscustomobject]@{ Name = $Name; Ok = $Ok; Detail = $Detail; FixHint = $FixHint; CanAutoFix = $CanAutoFix }
}

function Get-ApHubPrerequisites {
  [CmdletBinding()] param([string]$InstallRoot = (Split-Path -Parent $PSScriptRoot), [int]$PgPort = 5432, [int]$AppPort = 3001)
  Add-PostgresBinToPath
  $checks = @()

  $checks += New-PrereqCheck -Name "Windows" -Ok ([System.Environment]::OSVersion.Platform -eq 'Win32NT') `
    -Detail ([string][System.Environment]::OSVersion.Version) -FixHint "ap-hub installs on Windows 10/11 or Windows Server."

  $psOk = $PSVersionTable.PSVersion.Major -ge 5
  $checks += New-PrereqCheck -Name "PowerShell 5+" -Ok $psOk -Detail ([string]$PSVersionTable.PSVersion) `
    -FixHint "Windows PowerShell 5.1 ships with Windows; update Windows if older."

  $nodeOk = $false; $nodeDetail = "not found"
  if (Test-CommandExists "node") {
    $nodeDetail = (& node -v) 2>$null
    $major = 0; if ($nodeDetail -match 'v(\d+)') { $major = [int]$Matches[1] }
    $nodeOk = $major -ge 20
  }
  $checks += New-PrereqCheck -Name "Node.js 20+" -Ok $nodeOk -Detail $nodeDetail `
    -FixHint "Install Node.js LTS (20 or newer) from https://nodejs.org, then re-run."

  $pgPresent = Test-CommandExists "psql"
  $wingetOk = Test-CommandExists "winget"
  $checks += New-PrereqCheck -Name "PostgreSQL" -Ok $pgPresent `
    -Detail ($(if ($pgPresent) { (& psql --version) 2>$null } else { "not found" })) `
    -FixHint "The installer can provision PostgreSQL via winget, or install it from postgresql.org." `
    -CanAutoFix ($wingetOk)

  $portOk = Test-PortFree -Port $AppPort
  $checks += New-PrereqCheck -Name "Port $AppPort free" -Ok $portOk -Detail ($(if ($portOk) { "available" } else { "in use" })) `
    -FixHint "Another program is using port $AppPort. Close it, or choose a different port, then Re-check."
  $uiPortOk = Test-PortFree -Port 3000
  $checks += New-PrereqCheck -Name "Port 3000 free (web UI)" -Ok $uiPortOk -Detail ($(if ($uiPortOk) { "available" } else { "in use" })) `
    -FixHint "Another program is using web UI port 3000. Close it and re-run."

  $freeGb = $null; $diskOk = $false
  try {
    $drive = (Split-Path -Qualifier (Resolve-Path $InstallRoot)).TrimEnd(':')
    $vol = Get-PSDrive -Name $drive -ErrorAction Stop
    $freeGb = [math]::Round($vol.Free / 1GB, 1); $diskOk = $freeGb -ge 2
  } catch { $diskOk = $true; $freeGb = "?" }
  $checks += New-PrereqCheck -Name "Disk space 2GB+" -Ok $diskOk -Detail ("$freeGb GB free") `
    -FixHint "Free up at least 2 GB on the install drive."

  $writeOk = $false
  try {
    $probe = Join-Path $InstallRoot (".aphub-write-probe-" + [System.Guid]::NewGuid().ToString("N"))
    Set-Content -Path $probe -Value "probe" -ErrorAction Stop
    Remove-Item $probe -Force -ErrorAction SilentlyContinue
    $writeOk = $true
  } catch { $writeOk = $false }
  $checks += New-PrereqCheck -Name "Write access" -Ok $writeOk -Detail $InstallRoot `
    -FixHint "Run the installer from a folder you can write to (or as Administrator)."

  return $checks
}

function Test-ApHubReady {
  param([array]$Checks)
  foreach ($c in $Checks) { if (-not $c.Ok -and -not $c.CanAutoFix) { return $false } }
  return $true
}

function Get-ApHubPaths {
  param([string]$InstallRoot = (Split-Path -Parent $PSScriptRoot), [int]$AppPort = 3001)
  $recoveryDir = Join-Path $env:APPDATA "ap-hub"
  [pscustomobject]@{
    InstallRoot     = $InstallRoot
    EnvPath         = Join-Path $InstallRoot ".env"
    RecoveryDir     = $recoveryDir
    RecoveryKeyPath = Join-Path $recoveryDir "recovery.key"
    AppUrl          = "http://localhost:3000"
    HealthUrl       = "http://localhost:$AppPort/health"
  }
}

function Test-RecoverySaved {
  param([bool]$Confirmed, [bool]$RecoveryWasCreated)
  if (-not $RecoveryWasCreated) { return $true }
  return [bool]$Confirmed
}

# One credential field descriptor. Group orders the GUI; Required gates Next;
# Secret masks the textbox; EnvNames drives environment auto-discovery.
function New-CredField {
  param(
    [string]$Name, [string]$Label, [bool]$Required, [bool]$Secret,
    [string[]]$EnvNames = @(), [string]$Help = "", [string]$Group = "Core", [string]$Default = ""
  )
  [pscustomobject]@{
    Name = $Name; Label = $Label; Required = $Required; Secret = $Secret;
    EnvNames = $EnvNames; Help = $Help; Group = $Group; Default = $Default;
    Value = $Default; Source = $(if ($Default -ne "") { "default" } else { "empty" })
  }
}

# The static catalog: everything ap-hub's .env can carry, in wizard order.
function Get-ApHubCredentialFields {
  param([int]$PgPort = 5432)
  @(
    New-CredField -Name "DATABASE_URL" -Label "Database connection" -Required $true -Secret $false `
      -EnvNames @("DATABASE_URL") -Group "Core" -Default "postgres://aphub:aphub@localhost:$PgPort/aphub" `
      -Help "PostgreSQL the app uses. The installer can provision this local database for you."
    New-CredField -Name "ENCRYPTION_KEY" -Label "Encryption key (auto-generated)" -Required $true -Secret $true `
      -EnvNames @("ENCRYPTION_KEY") -Group "Core" `
      -Help "32-byte key that encrypts OAuth tokens at rest. Generated for you if not found."
    New-CredField -Name "LLM_PROVIDER" -Label "LLM provider" -Required $false -Secret $false `
      -Group "AI / LLM backend" -Default "auto" `
      -Help "auto | anthropic | openai | ollama | lmstudio | custom | claude | codex | gemini. 'auto' uses a local runtime, then a key. Click 'Guide me'."
    New-CredField -Name "LLM_BASE_URL" -Label "OpenAI-compatible endpoint (…/v1)" -Required $false -Secret $false `
      -EnvNames @("LLM_BASE_URL") -Group "AI / LLM backend" `
      -Help "Any OpenAI-compatible server: OpenAI, OpenRouter, Groq, or a local Ollama/LM Studio. Auto-filled if a local runtime is detected."
    New-CredField -Name "LLM_MODEL" -Label "Model id" -Required $false -Secret $false `
      -EnvNames @("LLM_MODEL") -Group "AI / LLM backend" `
      -Help "e.g. gpt-4o, llama3.2-vision, qwen2.5. Blank = provider default / first local model."
    New-CredField -Name "LLM_API_KEY" -Label "Endpoint API key" -Required $false -Secret $true `
      -EnvNames @("LLM_API_KEY") -Group "AI / LLM backend" `
      -Help "Key for the endpoint above (blank for a local runtime like Ollama/LM Studio)."
    New-CredField -Name "OPENAI_API_KEY" -Label "OpenAI API key" -Required $false -Secret $true `
      -EnvNames @("OPENAI_API_KEY") -Group "AI / LLM backend" -Help "Optional. Used when LLM_PROVIDER=openai."
    New-CredField -Name "ANTHROPIC_API_KEY" -Label "Anthropic API key" -Required $false -Secret $true `
      -EnvNames @("ANTHROPIC_API_KEY", "CLAUDE_API_KEY") -Group "AI / LLM backend" `
      -Help "Optional. Native Claude vision + PDF. No longer required — any LLM backend works. Click 'Guide me'."
    New-CredField -Name "GMAIL_CLIENT_ID" -Label "Gmail OAuth client ID" -Required $true -Secret $false `
      -EnvNames @("GMAIL_CLIENT_ID", "GOOGLE_CLIENT_ID") -Group "Gmail (read + optional drafts)" `
      -Help "From your Google Cloud OAuth app. Draft creation is separately disabled by default; AP Hub never sends replies."
    New-CredField -Name "GMAIL_CLIENT_SECRET" -Label "Gmail OAuth client secret" -Required $true -Secret $true `
      -EnvNames @("GMAIL_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET") -Group "Gmail (read + optional drafts)" `
      -Help "The client secret paired with the Gmail client ID."
    New-CredField -Name "GOOGLE_SSO_CLIENT_ID" -Label "Google sign-in client ID" -Required $true -Secret $false `
      -EnvNames @("GOOGLE_SSO_CLIENT_ID") -Group "Human sign-in" `
      -Help "OAuth web client with http://localhost:3000/api/auth/callback registered."
    New-CredField -Name "GOOGLE_SSO_CLIENT_SECRET" -Label "Google sign-in client secret" -Required $true -Secret $true `
      -EnvNames @("GOOGLE_SSO_CLIENT_SECRET") -Group "Human sign-in" `
      -Help "Secret paired with the Google sign-in client ID."
    New-CredField -Name "SESSION_COOKIE_SECRET" -Label "Session signing secret (auto-generated)" -Required $true -Secret $true `
      -EnvNames @("SESSION_COOKIE_SECRET") -Group "Human sign-in" `
      -Help "Random server-side secret used to sign sessions and OAuth state. Generated if absent."
    New-CredField -Name "TENANT_NAME" -Label "Company / tenant name" -Required $true -Secret $false `
      -EnvNames @("APHUB_TENANT_NAME") -Group "First owner" `
      -Help "Creates the first company record during a clean install."
    New-CredField -Name "OWNER_EMAIL" -Label "First owner Google email" -Required $true -Secret $false `
      -EnvNames @("APHUB_OWNER_EMAIL") -Group "First owner" `
      -Help "Pre-invited owner_controller account; must match the Google account used to sign in."
    New-CredField -Name "QBO_SANDBOX_CLIENT_ID" -Label "QuickBooks sandbox client ID" -Required $false -Secret $false `
      -EnvNames @("QBO_SANDBOX_CLIENT_ID") -Group "QuickBooks (sandbox, optional)" `
      -Help "Optional. QuickBooks Online SANDBOX app client ID. Production is refused by the app."
    New-CredField -Name "QBO_SANDBOX_CLIENT_SECRET" -Label "QuickBooks sandbox client secret" -Required $false -Secret $true `
      -EnvNames @("QBO_SANDBOX_CLIENT_SECRET") -Group "QuickBooks (sandbox, optional)" -Help "Optional."
    New-CredField -Name "QBO_SANDBOX_REALM_ID" -Label "QuickBooks sandbox realm ID" -Required $false -Secret $false `
      -EnvNames @("QBO_SANDBOX_REALM_ID") -Group "QuickBooks (sandbox, optional)" -Help "Optional. The sandbox company realm ID."
    New-CredField -Name "QBO_SANDBOX_COMPANY_NAME" -Label "QuickBooks sandbox company name" -Required $false -Secret $false `
      -EnvNames @("QBO_SANDBOX_COMPANY_NAME") -Group "QuickBooks (sandbox, optional)" -Help "Optional. Confirms the realm on connect."
    New-CredField -Name "QB_DESKTOP_COMPANY_ID" -Label "QuickBooks Desktop company identity" -Required $false -Secret $false `
      -EnvNames @("QB_DESKTOP_COMPANY_ID") -Group "QuickBooks Desktop (optional)" `
      -Help "Expected company identity returned by QBWC. Required before an owner can enable QBD writes."
    New-CredField -Name "SWARMSYNC_ENABLED" -Label "Use SwarmSync document proofs" -Required $false -Secret $false `
      -EnvNames @("SWARMSYNC_ENABLED") -Group "Document proofs (SwarmSync)" -Default "true" `
      -Help "true = InvoiceProof fraud scan + Verify-API + AuditProof (needs a key). false = run without them. Click 'Guide me'."
    New-CredField -Name "SWARMSYNC_API_KEY" -Label "SwarmSync API key" -Required $false -Secret $true `
      -EnvNames @("SWARMSYNC_API_KEY") -Group "Document proofs (SwarmSync)" `
      -Help "ssk_live_... key for Verify-API / AuditProof. Required only when SwarmSync is on. Never logged."
    New-CredField -Name "SWARMSYNC_OFF_MODE" -Label "If SwarmSync is off, invoices should" -Required $false -Secret $false `
      -EnvNames @("SWARMSYNC_OFF_MODE") -Group "Document proofs (SwarmSync)" -Default "review" `
      -Help "review = hold for human review. Proofless automatic posting is not supported."
    New-CredField -Name "QBO_FORWARDING_ADDRESS" -Label "QBO capture forwarding address" -Required $false -Secret $false `
      -EnvNames @("QBO_FORWARDING_ADDRESS") -Group "Gatekeeper (optional)" `
      -Help "Optional. The only address the gatekeeper relay can ever forward to."
    New-CredField -Name "TELEGRAM_BOT_TOKEN" -Label "Telegram bot token" -Required $false -Secret $true `
      -EnvNames @("TELEGRAM_BOT_TOKEN") -Group "Gatekeeper (optional)" -Help "Optional. For held-invoice alerts. Never logged."
    New-CredField -Name "TELEGRAM_CHAT_ID" -Label "Telegram chat ID" -Required $false -Secret $false `
      -EnvNames @("TELEGRAM_CHAT_ID") -Group "Gatekeeper (optional)" -Help "Optional. Chat that receives hold alerts."
  )
}

# Directories the deep scan looks in for stray credential files.
function Get-ScanRoots {
  @(
    (Join-Path $env:USERPROFILE "Downloads"),
    (Join-Path $env:USERPROFILE "Desktop"),
    (Join-Path $env:USERPROFILE "Documents"),
    $env:USERPROFILE,
    (Join-Path $env:APPDATA "gcloud"),
    (Join-Path $env:APPDATA "ap-hub")
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
}

# Deep scan: find a downloaded Google OAuth client secret JSON and parse the
# client_id / client_secret out of its `installed` or `web` block. Returns
# $null if none found. This is the "find the key you already downloaded" step.
function Find-GoogleClientSecret {
  $roots = Get-ScanRoots
  $patterns = @("client_secret*.json", "credentials.json", "*oauth*client*.json")
  foreach ($root in $roots) {
    foreach ($pat in $patterns) {
      $files = Get-ChildItem -Path $root -Filter $pat -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
      foreach ($file in $files) {
        try {
          $j = Get-Content $file.FullName -Raw -ErrorAction Stop | ConvertFrom-Json
          $node = if ($j.installed) { $j.installed } elseif ($j.web) { $j.web } else { $null }
          if ($node -and $node.client_id -and $node.client_secret) {
            return [pscustomobject]@{ ClientId = $node.client_id; ClientSecret = $node.client_secret; File = $file.FullName }
          }
        } catch { }
      }
    }
  }
  return $null
}

# Deep scan: detect QuickBooks Desktop. Returns install presence (registry), the
# qbXML SDK COM component (QBXMLRP2.RequestProcessor) availability, and any .QBW
# company files found. This is detection only unless the operator explicitly
# enables the company-bound Desktop adapter; write enablement remains separate.
function Get-QuickBooksDesktopInfo {
  $installed = $false; $version = ""; $sdkCom = $false; $qbwFiles = @()
  foreach ($key in @("HKLM:\SOFTWARE\Intuit\QuickBooks", "HKLM:\SOFTWARE\WOW6432Node\Intuit\QuickBooks")) {
    if (Test-Path $key) {
      $installed = $true
      try { $sub = Get-ChildItem $key -ErrorAction SilentlyContinue | Select-Object -First 1; if ($sub) { $version = $sub.PSChildName } } catch { }
    }
  }
  # qbXML SDK request processor COM component (installed with the QB SDK).
  try { if ([Type]::GetTypeFromProgID("QBXMLRP2.RequestProcessor")) { $sdkCom = $true } } catch { }
  # Company files (.QBW) in the usual spots.
  $qbwRoots = @(
    (Join-Path $env:PUBLIC "Documents\Intuit\QuickBooks\Company Files"),
    (Join-Path $env:USERPROFILE "Documents\Intuit"),
    (Join-Path $env:USERPROFILE "Documents")
  ) | Where-Object { $_ -and (Test-Path $_) }
  foreach ($r in $qbwRoots) {
    try { $qbwFiles += (Get-ChildItem -Path $r -Filter *.QBW -File -Recurse -Depth 2 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName) } catch { }
  }
  [pscustomobject]@{
    Installed  = $installed
    Version    = $version
    SdkCom     = $sdkCom
    CompanyFiles = @($qbwFiles | Select-Object -Unique)
  }
}

# Call the Telegram Bot API to auto-detect the chat id the bot last received a
# message from. The operator messages their bot, then this reads getUpdates and
# returns the most recent chat id. Returns $null on any error / no messages.
function Get-TelegramChatId {
  param([string]$BotToken)
  if ([string]::IsNullOrWhiteSpace($BotToken)) { return $null }
  try {
    $resp = Invoke-RestMethod -Uri ("https://api.telegram.org/bot{0}/getUpdates" -f $BotToken) -TimeoutSec 8 -ErrorAction Stop
    if ($resp.ok -and $resp.result.Count -gt 0) {
      $last = $resp.result | Select-Object -Last 1
      $chat = if ($last.message) { $last.message.chat } elseif ($last.channel_post) { $last.channel_post.chat } elseif ($last.my_chat_member) { $last.my_chat_member.chat } else { $null }
      if ($chat -and $chat.id) { return [string]$chat.id }
    }
  } catch { }
  return $null
}

# Validate a Telegram bot token by calling getMe. Returns the bot @username or $null.
function Test-TelegramBotToken {
  param([string]$BotToken)
  if ([string]::IsNullOrWhiteSpace($BotToken)) { return $null }
  try {
    $resp = Invoke-RestMethod -Uri ("https://api.telegram.org/bot{0}/getMe" -f $BotToken) -TimeoutSec 8 -ErrorAction Stop
    if ($resp.ok -and $resp.result.username) { return "@" + $resp.result.username }
  } catch { }
  return $null
}

# Detect which LLM backends are usable on this machine: a running local runtime
# (Ollama / LM Studio — OpenAI-compatible, free), an installed CLI, and any cloud
# key already in the environment. Desktop chat apps (Claude Desktop, ChatGPT
# Desktop) expose no programmable endpoint and are never a backend.
function Get-ApHubLlmDetection {
  $ollama = $null; $lmstudio = $null; $cli = $null
  try {
    $r = Invoke-RestMethod -Uri 'http://localhost:11434/api/tags' -TimeoutSec 2 -ErrorAction Stop
    $ollama = [pscustomobject]@{ BaseUrl = 'http://localhost:11434/v1'; Models = @($r.models | ForEach-Object { $_.name }) }
  } catch { }
  try {
    $r = Invoke-RestMethod -Uri 'http://localhost:1234/v1/models' -TimeoutSec 2 -ErrorAction Stop
    $lmstudio = [pscustomobject]@{ BaseUrl = 'http://localhost:1234/v1'; Models = @($r.data | ForEach-Object { $_.id }) }
  } catch { }
  foreach ($b in 'claude', 'codex', 'gemini') { if (Test-CommandExists $b) { $cli = $b; break } }
  [pscustomobject]@{
    Ollama       = $ollama
    LmStudio     = $lmstudio
    Cli          = $cli
    AnthropicKey = [bool](Get-EnvAny -Names @('ANTHROPIC_API_KEY'))
    OpenAiKey    = [bool](Get-EnvAny -Names @('OPENAI_API_KEY'))
  }
}

<#
.SYNOPSIS
  Auto-discovery: return the credential catalog with every value pre-filled from
  the machine. Sources, in priority order:
    environment  -> a matching env var (Process/User/Machine) already holds it
    generated    -> the installer created it (ENCRYPTION_KEY)
    default      -> a sensible local default (DATABASE_URL for the bundled DB)
    empty        -> nothing found; the operator must supply it
.OUTPUTS
  [pscustomobject] Fields (array) + ClaudeCliDetected + PostgresDetected
#>
function Get-ApHubDiscoveredCredentials {
  [CmdletBinding()] param([int]$PgPort = 5432)
  Add-PostgresBinToPath
  $fields = Get-ApHubCredentialFields -PgPort $PgPort

  foreach ($f in $fields) {
    # 1. Environment scan (the "find keys already on the machine" step).
    if ($f.EnvNames.Count -gt 0) {
      $hit = Get-EnvAny -Names $f.EnvNames
      if ($hit) { $f.Value = $hit.Value; $f.Source = "environment (" + $hit.Var + ")"; continue }
    }
    # 2. Generate the encryption key when the environment has none.
    if ($f.Name -eq "ENCRYPTION_KEY" -or $f.Name -eq "SESSION_COOKIE_SECRET") {
      $f.Value = New-HexSecret
      $f.Source = "generated"
      continue
    }
    # 3. Otherwise keep the default (already set) or leave empty.
  }

  # Deep scan: a downloaded Google OAuth client_secret.json fills the Gmail fields
  # when the environment didn't. (Only fills genuinely-empty fields.)
  $googleFile = $null
  $gid = $fields | Where-Object { $_.Name -eq "GMAIL_CLIENT_ID" } | Select-Object -First 1
  $gsec = $fields | Where-Object { $_.Name -eq "GMAIL_CLIENT_SECRET" } | Select-Object -First 1
  if (($gid -and $gid.Source -eq "empty") -or ($gsec -and $gsec.Source -eq "empty")) {
    $g = Find-GoogleClientSecret
    if ($g) {
      $googleFile = $g.File
      if ($gid -and $gid.Source -eq "empty") { $gid.Value = $g.ClientId; $gid.Source = "file (" + (Split-Path -Leaf $g.File) + ")" }
      if ($gsec -and $gsec.Source -eq "empty") { $gsec.Value = $g.ClientSecret; $gsec.Source = "file (" + (Split-Path -Leaf $g.File) + ")" }
    }
  }
  # The same Google web OAuth client can serve human SSO when both callback
  # URIs are registered. Reuse discovered Gmail credentials as a safe default;
  # the operator may still override them in the wizard.
  $ssoId = $fields | Where-Object { $_.Name -eq "GOOGLE_SSO_CLIENT_ID" } | Select-Object -First 1
  $ssoSecret = $fields | Where-Object { $_.Name -eq "GOOGLE_SSO_CLIENT_SECRET" } | Select-Object -First 1
  if ($ssoId -and $ssoId.Source -eq "empty" -and $gid -and $gid.Value) {
    $ssoId.Value = $gid.Value; $ssoId.Source = "Gmail OAuth default"
  }
  if ($ssoSecret -and $ssoSecret.Source -eq "empty" -and $gsec -and $gsec.Value) {
    $ssoSecret.Value = $gsec.Value; $ssoSecret.Source = "Gmail OAuth default"
  }

  $claudeCli = $false
  if (Test-CommandExists "claude") { try { & claude --version 2>$null | Out-Null; $claudeCli = ($LASTEXITCODE -eq 0) } catch { $claudeCli = $true } }

  # PostgreSQL is "detected" if psql is on PATH OR something answers on its port.
  $pgDetected = (Test-CommandExists "psql") -or (-not (Test-PortFree -Port $PgPort))

  $qbDesktop = Get-QuickBooksDesktopInfo

  # LLM backend detection: pre-fill the OpenAI-compatible endpoint from a running
  # local runtime so a no-key, no-CLI user is ready to go out of the box.
  $llm = Get-ApHubLlmDetection
  $baseField = $fields | Where-Object { $_.Name -eq 'LLM_BASE_URL' } | Select-Object -First 1
  $modelField = $fields | Where-Object { $_.Name -eq 'LLM_MODEL' } | Select-Object -First 1
  if ($baseField -and $baseField.Source -eq 'empty') {
    $rt = if ($llm.Ollama) { $llm.Ollama } elseif ($llm.LmStudio) { $llm.LmStudio } else { $null }
    if ($rt) {
      $baseField.Value = $rt.BaseUrl; $baseField.Source = 'detected local runtime'
      if ($modelField -and $modelField.Source -eq 'empty' -and $rt.Models.Count -gt 0) {
        $modelField.Value = $rt.Models[0]; $modelField.Source = 'detected'
      }
    }
  }

  [pscustomobject]@{
    Fields            = $fields
    ClaudeCliDetected = $claudeCli
    PostgresDetected  = $pgDetected
    GoogleSecretFile  = $googleFile
    QbDesktop         = $qbDesktop
    Llm               = $llm
    ScanRoots         = @(Get-ScanRoots)
  }
}

function Send-Progress {
  param([scriptblock]$OnProgress, [string]$Step, [string]$Status, [string]$Message, [int]$Percent)
  if ($OnProgress) { & $OnProgress ([pscustomobject]@{ Step = $Step; Status = $Status; Message = $Message; Percent = $Percent }) }
}

# Render an .env body from a name->value hashtable, only emitting non-blank vars
# plus the fixed defaults the app expects.
function Get-ApHubEnvBody {
  param([hashtable]$Values, [int]$AppPort = 3001)
  $lines = @(
    "# Generated by deploy/install.ps1 for ap-hub. DO NOT commit.",
    "# QBO writes are sandbox-only. Gmail may create drafts but never sends replies.",
    ""
  )
  $order = @(
    "DATABASE_URL","ENCRYPTION_KEY",
    "LLM_PROVIDER","LLM_BASE_URL","LLM_MODEL","LLM_API_KEY","OPENAI_API_KEY","ANTHROPIC_API_KEY",
    "GMAIL_CLIENT_ID","GMAIL_CLIENT_SECRET",
    "GOOGLE_SSO_CLIENT_ID","GOOGLE_SSO_CLIENT_SECRET","SESSION_COOKIE_SECRET",
    "QBO_SANDBOX_CLIENT_ID","QBO_SANDBOX_CLIENT_SECRET","QBO_SANDBOX_REALM_ID","QBO_SANDBOX_COMPANY_NAME",
    "SWARMSYNC_ENABLED","SWARMSYNC_OFF_MODE","SWARMSYNC_API_KEY","QBO_FORWARDING_ADDRESS","TELEGRAM_BOT_TOKEN","TELEGRAM_CHAT_ID"
  )
  foreach ($k in $order) {
    $v = ""; if ($Values.ContainsKey($k) -and $null -ne $Values[$k]) { $v = [string]$Values[$k] }
    $lines += "$k=$v"
  }
  # Fixed, non-secret defaults the config loader expects.
  $gatekeeper = if ($Values["QBO_FORWARDING_ADDRESS"] -and $Values["TELEGRAM_BOT_TOKEN"] -and $Values["TELEGRAM_CHAT_ID"]) { "true" } else { "false" }
  $lines += @(
    "GMAIL_REDIRECT_URI=http://localhost:$AppPort/oauth/gmail/callback",
    "WATCHED_LABEL=AP-Inbox",
    "GMAIL_DRAFTS_ENABLED=false",
    "MAX_ATTACHMENT_BYTES=26214400",
    "SESSION_TTL_HOURS=12",
    "WEB_BASE_URL=http://localhost:3000",
    "QBO_ENV=sandbox",
    "QBO_MINOR_VERSION=73",
    "QBO_SANDBOX_REDIRECT_URI=http://localhost:$AppPort/oauth/qbo/callback",
    "SWARMSYNC_API_BASE=https://api.swarmsync.ai",
    "SWARMSYNC_WEB_BASE=https://swarmsync.ai",
    "GATEKEEPER_ENABLED=$gatekeeper",
    "AUTO_THRESHOLD=0.9",
    "REVIEW_THRESHOLD=0.6",
    "AMOUNT_CEILING=10000",
    "POLL_INTERVAL_SECONDS=180",
    "PORT=$AppPort",
    "LOG_LEVEL=info"
  )
  # QuickBooks Desktop (Web Connector) — only when the operator chose a mode in
  # the QuickBooks guide. Read-only unless they explicitly picked 'write'.
  $qbMode = [string]$Values["QB_DESKTOP_MODE"]
  if ($qbMode -eq "readonly") {
    $qbwcUser = if ($Values["QBWC_USERNAME"]) { [string]$Values["QBWC_USERNAME"] } else { "aphub" }
    $qbwcPass = [string]$Values["QBWC_PASSWORD"]
    $lines += @(
      "QB_DESKTOP_ENABLED=true",
      "QB_DESKTOP_MODE=$qbMode",
      "QB_DESKTOP_COMPANY_ID=$([string]$Values['QB_DESKTOP_COMPANY_ID'])",
      "QB_DESKTOP_WRITE_ENABLED=false",
      "PROVIDER_JOB_LEASE_SECONDS=300",
      "QBWC_USERNAME=$qbwcUser",
      "QBWC_PASSWORD=$qbwcPass"
    )
  } else {
    $lines += @(
      "QB_DESKTOP_ENABLED=false",
      "QB_DESKTOP_MODE=readonly",
      "QB_DESKTOP_COMPANY_ID=",
      "QB_DESKTOP_WRITE_ENABLED=false",
      "PROVIDER_JOB_LEASE_SECONDS=300",
      "QBWC_USERNAME=aphub",
      "QBWC_PASSWORD="
    )
  }
  return ($lines -join "`r`n") + "`r`n"
}

# The recovery artifact: the generated ENCRYPTION_KEY (the only value the operator
# can't otherwise recover). Secrets they supplied themselves are theirs to keep.
function Get-ApHubRecoveryBody {
  param([hashtable]$Values)
  @"
ap-hub recovery key -- generated once at install time.
Store this file offline. It is the only copy of the generated ENCRYPTION_KEY
outside .env. If .env is lost, restore ENCRYPTION_KEY from here; a re-generated
key cannot decrypt OAuth tokens stored with the old one.

ENCRYPTION_KEY=$($Values['ENCRYPTION_KEY'])
"@
}

<#
.SYNOPSIS
  Run the real ap-hub install with the operator's confirmed credential values,
  reporting each step via -OnProgress.
.OUTPUTS
  [pscustomobject] Success / RecoveryKeyPath / RecoveryWasCreated / AppUrl / Error
#>
function Invoke-ApHubInstall {
  [CmdletBinding()]
  param(
    [hashtable]$Values,
    [string]$InstallRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$PgSuperuser = "postgres",
    [int]$PgPort = 5432,
    [int]$AppPort = 3001,
    [scriptblock]$OnProgress
  )
  $ErrorActionPreference = "Stop"
  Add-PostgresBinToPath
  $paths = Get-ApHubPaths -InstallRoot $InstallRoot -AppPort $AppPort
  $result = [pscustomobject]@{ Success = $false; RecoveryKeyPath = $paths.RecoveryKeyPath; RecoveryWasCreated = $false; AppUrl = $paths.AppUrl; HealthUrl = $paths.HealthUrl; QwcPath = $null; Error = $null }

  try {
    if (-not $Values) { throw "No credential values were supplied to the installer." }

    # 1. PostgreSQL present / provisioned + running
    Send-Progress $OnProgress "postgres" "start" "Checking PostgreSQL..." 5
    if (-not (Test-CommandExists "psql")) {
      if (Test-CommandExists "winget") {
        Send-Progress $OnProgress "postgres" "start" "Installing PostgreSQL (winget)..." 5
        winget install --id PostgreSQL.PostgreSQL.16 --silent --accept-source-agreements --accept-package-agreements | Out-Null
        Add-PostgresBinToPath
      }
    }
    if (-not (Test-CommandExists "psql")) { throw "PostgreSQL is not installed and could not be provisioned. Install it from postgresql.org and re-run." }
    $pgService = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pgService -and $pgService.Status -ne "Running") { Start-Service $pgService.Name }
    Send-Progress $OnProgress "postgres" "ok" "PostgreSQL ready." 12

    # 2. Provision the aphub role + database when the DATABASE_URL points at the
    #    bundled local default (best-effort; skipped for an external DB URL).
    $dbUrl = [string]$Values["DATABASE_URL"]
    if ($dbUrl -match '^postgres(ql)?://aphub:aphub@localhost') {
      Send-Progress $OnProgress "database" "start" "Provisioning the local database..." 20
      # Least privilege: a plain LOGIN role that OWNS its own database (below) can
      # run every migration/pg-boss DDL it needs — no SUPERUSER required.
      $roleSql = "DO `$do`$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='aphub') THEN CREATE ROLE aphub LOGIN PASSWORD 'aphub'; END IF; END `$do`$;"
      & psql -U $PgSuperuser -h localhost -p $PgPort -v ON_ERROR_STOP=1 -c $roleSql 2>$null | Out-Null
      $exists = & psql -U $PgSuperuser -h localhost -p $PgPort -tAc "SELECT 1 FROM pg_database WHERE datname='aphub'" 2>$null
      if (-not $exists) { & psql -U $PgSuperuser -h localhost -p $PgPort -c "CREATE DATABASE aphub OWNER aphub" 2>$null | Out-Null }
    }

    # 3. Write .env + recovery key -- IDEMPOTENT: a re-run never rotates the
    #    generated ENCRYPTION_KEY or clobbers a working .env. Write only when
    #    absent (verify-only otherwise), matching the recovery key's own
    #    only-if-absent rule so the two never drift.
    # If the operator chose a QuickBooks Desktop mode, mint a Web Connector
    # password now (used both in .env and when they import the .QWC).
    $qbMode = [string]$Values["QB_DESKTOP_MODE"]
    if ($qbMode -eq "readonly" -and -not $Values["QBWC_PASSWORD"]) {
      $Values["QBWC_PASSWORD"] = (New-HexSecret -Bytes 9)
    }

    if (-not (Test-Path $paths.EnvPath)) {
      Send-Progress $OnProgress "config" "start" "Writing configuration..." 30
      $envBody = Get-ApHubEnvBody -Values $Values -AppPort $AppPort
      [System.IO.File]::WriteAllText($paths.EnvPath, $envBody, (New-Object System.Text.UTF8Encoding($false)))
      try {
        & icacls $paths.EnvPath /inheritance:r 2>$null | Out-Null
        & icacls $paths.EnvPath /grant:r ("{0}:F" -f $env:USERNAME) 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "icacls exit $LASTEXITCODE" }
      } catch {
        throw "Configuration was written but its ACL could not be restricted to the installing user: $($_.Exception.Message)"
      }
      if (-not (Test-Path $paths.RecoveryKeyPath)) {
        New-Item -ItemType Directory -Force -Path $paths.RecoveryDir | Out-Null
        [System.IO.File]::WriteAllText($paths.RecoveryKeyPath, (Get-ApHubRecoveryBody -Values $Values), (New-Object System.Text.UTF8Encoding($false)))
        try {
          & icacls $paths.RecoveryKeyPath /inheritance:r 2>$null | Out-Null
          & icacls $paths.RecoveryKeyPath /grant:r ("{0}:F" -f $env:USERNAME) 2>$null | Out-Null
        } catch { }
        $result.RecoveryWasCreated = $true
      }
      Send-Progress $OnProgress "config" "ok" "Configuration written." 36
    } else {
      Send-Progress $OnProgress "config" "ok" "Existing .env found -- left untouched (re-run is verify-only)." 36
    }

    # 4. Dependencies (turnkey): fetch only if node_modules is absent.
    if (-not (Test-Path (Join-Path $InstallRoot "node_modules"))) {
      Send-Progress $OnProgress "deps" "start" "Installing dependencies (this can take a few minutes)..." 45
      Push-Location $InstallRoot
      try {
        npm install | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Installing dependencies failed (npm install exit $LASTEXITCODE). Check your internet connection and Node.js install, then re-run." }
      } finally { Pop-Location }
    }

    # 5. Migrate (guard the native exit code)
    Send-Progress $OnProgress "migrate" "start" "Setting up the database schema..." 62
    Push-Location $InstallRoot
    try {
      $env:DATABASE_URL = $dbUrl
      npm run migrate:up | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "Database migration failed (exit $LASTEXITCODE)." }
    } finally { Pop-Location }

    # A clean installation has no user who can pass the invite-gated Google SSO
    # flow. Bootstrap exactly one first owner when the database has no tenants.
    $tenantCount = (& psql $dbUrl -tAc "SELECT count(*) FROM tenants" 2>$null).Trim()
    if ($tenantCount -eq "0") {
      $tenantName = [string]$Values["TENANT_NAME"]
      $ownerEmail = [string]$Values["OWNER_EMAIL"]
      if ([string]::IsNullOrWhiteSpace($tenantName) -or [string]::IsNullOrWhiteSpace($ownerEmail)) {
        throw "TENANT_NAME and OWNER_EMAIL are required for first-owner provisioning."
      }
      Push-Location $InstallRoot
      try {
        npm run cli -- bootstrap-tenant --name $tenantName --owner-email $ownerEmail | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "First-owner provisioning failed (exit $LASTEXITCODE)." }
      } finally { Pop-Location }
    }

    # 6. Build and start both processes: backend/workers on AppPort and the
    # authenticated Next.js UI on port 3000.
    Send-Progress $OnProgress "start" "start" "Starting ap-hub..." 80
    Push-Location $InstallRoot
    try {
      npm run web:build | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "Web UI build failed (exit $LASTEXITCODE)." }
    } finally { Pop-Location }
    $npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
    Start-Process -FilePath $npmCommand -ArgumentList "run","dev" -WorkingDirectory $InstallRoot -WindowStyle Hidden | Out-Null
    Start-Process -FilePath $npmCommand -ArgumentList "run","web:start" -WorkingDirectory $InstallRoot -WindowStyle Hidden | Out-Null

    # 7. Poll health
    Send-Progress $OnProgress "health" "start" "Waiting for ap-hub to become healthy..." 90
    $healthy = $false
    for ($i = 0; $i -lt 60; $i++) {
      Start-Sleep -Seconds 2
      try {
        $resp = Invoke-WebRequest -Uri $paths.HealthUrl -UseBasicParsing -TimeoutSec 3
        if ($resp.StatusCode -eq 200) { $healthy = $true; break }
      } catch { }
      Send-Progress $OnProgress "health" "start" "Waiting for ap-hub to become healthy... ($($i*2)s)" 90
    }
    if (-not $healthy) { throw "ap-hub did not become healthy in time. It may still be starting -- check the log, or re-run the installer." }
    try {
      $ui = Invoke-WebRequest -Uri "$($paths.AppUrl)/login" -UseBasicParsing -TimeoutSec 10
      if ($ui.StatusCode -ne 200) { throw "unexpected status $($ui.StatusCode)" }
    } catch {
      throw "Backend is healthy but the web UI did not start: $($_.Exception.Message)"
    }

    # If QuickBooks Desktop was enabled, generate the .QWC to import into the
    # Web Connector (best-effort; failure here never fails the install).
    if ($qbMode -eq "readonly") {
      try {
        Send-Progress $OnProgress "qbwc" "start" "Generating QuickBooks Web Connector config (.QWC)..." 98
        Push-Location $InstallRoot
        try { npm run cli -- qbdesktop qwc --out (Join-Path $InstallRoot "ap-hub.qwc") | Out-Null } finally { Pop-Location }
        $qwc = Join-Path $InstallRoot "ap-hub.qwc"
        if (Test-Path $qwc) { $result.QwcPath = $qwc }
      } catch { }
    }

    Send-Progress $OnProgress "done" "ok" "ap-hub is running at $($paths.AppUrl)" 100
    $result.Success = $true
    return $result
  } catch {
    $result.Error = $_.Exception.Message
    Send-Progress $OnProgress "error" "error" $result.Error 0
    return $result
  }
}

# ---- direct-invocation self-checks (no GUI, no install) --------------------
if ($EmitPrereqJson) {
  Get-ApHubPrerequisites -AppPort $AppPort | ConvertTo-Json -Depth 4
}
if ($EmitCredentialsJson) {
  Get-ApHubDiscoveredCredentials | ConvertTo-Json -Depth 5
}
