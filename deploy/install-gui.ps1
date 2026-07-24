<#
.SYNOPSIS
  Guided (graphical) ap-hub installer for Windows -- a step-by-step wizard.

.DESCRIPTION
  A Windows Forms wizard for non-technical operators, mirroring the PacketOS
  installer. It uses the SAME install logic as the command-line path
  (deploy/install-core.ps1); this file only draws screens and forces the safety
  confirmations:

    1. Welcome       -- what this does.
    2. Options       -- the local port.
    3. Prerequisites -- checks Windows/Node/PostgreSQL/port/disk; can auto-install PostgreSQL.
    4. Credentials   -- AUTO-DISCOVERS keys already on this machine (environment
                        variables, a running PostgreSQL) and GENERATES the
                        encryption key, pre-filling every box. The operator only
                        fills genuine gaps; required fields gate Next.
    5. Install       -- live progress bar + log (background job; window stays responsive).
    6. Recovery key  -- shows where the generated encryption key was saved and
                        REQUIRES a "I have saved it" tick before finishing.
    7. Finish / Error.

  No graphical dependency beyond Windows' built-in .NET (System.Windows.Forms).
  QBO writes are sandbox-only. Gmail may create drafts but never sends replies.

.PARAMETER SelfTest
  Build every page and exercise the gating logic WITHOUT showing a window or
  installing anything, then exit 0. Used by CI to prove the wizard loads.
#>
[CmdletBinding()]
param(
  [switch]$SelfTest,
  [string]$CaptureTo,
  [string]$CapturePage = "welcome",   # welcome | options | prereq | credentials | recovery
  [string]$InstallRoot,
  [string]$PgSuperuser = "postgres",
  [int]$PgPort = 5432,
  [int]$AppPort = 3001
)

# $PSScriptRoot is empty during param-default binding when the script is run via
# `powershell -File` (Windows PowerShell 5.1 quirk), so resolve the script dir in
# the BODY (where $PSCommandPath is reliable) and derive InstallRoot here rather
# than in the param() defaults.
$script:ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($PSCommandPath) { Split-Path -Parent $PSCommandPath } else { (Get-Location).Path }
if (-not $InstallRoot -or $InstallRoot -eq "") { $InstallRoot = Split-Path -Parent $script:ScriptDir }

. (Join-Path $script:ScriptDir 'install-core.ps1')

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:Ink   = [System.Drawing.Color]::FromArgb(22, 27, 29)
$script:Muted = [System.Drawing.Color]::FromArgb(102, 117, 123)
$script:Paper = [System.Drawing.Color]::FromArgb(244, 246, 245)
$script:Panel = [System.Drawing.Color]::White
$script:Teal  = [System.Drawing.Color]::FromArgb(13, 110, 100)
$script:Crit  = [System.Drawing.Color]::FromArgb(178, 59, 48)
$script:Good  = [System.Drawing.Color]::FromArgb(13, 110, 100)
$script:FontH  = [System.Drawing.Font]::new("Segoe UI Semibold", 15)
$script:FontB  = [System.Drawing.Font]::new("Segoe UI", 10)
$script:FontS  = [System.Drawing.Font]::new("Segoe UI", 9)
$script:FontMono = [System.Drawing.Font]::new("Consolas", 9)

$script:W = @{ Page = ""; Prereqs = $null; Result = $null; RecoveryConfirmed = $false; AppPort = $AppPort; Creds = $null; CredRows = @(); CredValues = $null }

function New-Label {
  param([string]$Text, [System.Drawing.Font]$Font = $script:FontB, [System.Drawing.Color]$Color = $script:Ink,
        [int]$X = 24, [int]$Y = 0, [int]$Width = 470, [int]$Height = 0)
  $l = [System.Windows.Forms.Label]::new()
  $l.Text = $Text; $l.Font = $Font; $l.ForeColor = $Color
  $l.Location = [System.Drawing.Point]::new($X, $Y)
  $l.AutoSize = ($Height -eq 0)
  if ($Height -gt 0) { $l.Size = [System.Drawing.Size]::new($Width, $Height) } else { $l.MaximumSize = [System.Drawing.Size]::new($Width, 0) }
  return $l
}

function Initialize-Wizard {
  $f = [System.Windows.Forms.Form]::new()
  $f.Text = "ap-hub Installer"
  $f.Size = [System.Drawing.Size]::new(600, 520)
  $f.MinimumSize = [System.Drawing.Size]::new(600, 520)
  $f.StartPosition = "CenterScreen"
  $f.FormBorderStyle = "FixedDialog"
  $f.MaximizeBox = $false
  $f.BackColor = $script:Paper
  $f.Font = $script:FontB

  $header = [System.Windows.Forms.Panel]::new()
  $header.Dock = "Top"; $header.Height = 74; $header.BackColor = $script:Panel
  $title = New-Label -Text "ap-hub" -Font $script:FontH -X 24 -Y 14
  $sub = New-Label -Text "" -Font $script:FontS -Color $script:Muted -X 24 -Y 46
  $sub.Name = "subtitle"
  $header.Controls.AddRange(@($title, $sub))

  $content = [System.Windows.Forms.Panel]::new()
  $content.Dock = "Fill"; $content.BackColor = $script:Paper; $content.Padding = [System.Windows.Forms.Padding]::new(0, 8, 0, 0)

  $footer = [System.Windows.Forms.Panel]::new()
  $footer.Dock = "Bottom"; $footer.Height = 58; $footer.BackColor = $script:Panel

  $btnBack = [System.Windows.Forms.Button]::new(); $btnBack.Text = "Back"; $btnBack.Size = [System.Drawing.Size]::new(90, 30); $btnBack.Location = [System.Drawing.Point]::new(290, 14); $btnBack.FlatStyle = "System"
  $btnNext = [System.Windows.Forms.Button]::new(); $btnNext.Text = "Next"; $btnNext.Size = [System.Drawing.Size]::new(110, 30); $btnNext.Location = [System.Drawing.Point]::new(386, 14); $btnNext.FlatStyle = "System"
  $btnCancel = [System.Windows.Forms.Button]::new(); $btnCancel.Text = "Cancel"; $btnCancel.Size = [System.Drawing.Size]::new(90, 30); $btnCancel.Location = [System.Drawing.Point]::new(24, 14); $btnCancel.FlatStyle = "System"
  $btnCancel.Add_Click({ $script:W.Form.Close() })
  $footer.Controls.AddRange(@($btnCancel, $btnBack, $btnNext))

  $f.Controls.Add($content); $f.Controls.Add($footer); $f.Controls.Add($header)

  $script:W.Form = $f; $script:W.Header = $header; $script:W.Subtitle = $sub
  $script:W.Content = $content; $script:W.Back = $btnBack; $script:W.Next = $btnNext; $script:W.Cancel = $btnCancel

  $f.Add_FormClosing({
    if ($script:W.Timer) { $script:W.Timer.Stop(); $script:W.Timer.Dispose(); $script:W.Timer = $null }
    if ($script:W.Job) { Stop-Job $script:W.Job -ErrorAction SilentlyContinue; Remove-Job $script:W.Job -Force -ErrorAction SilentlyContinue; $script:W.Job = $null }
  })
}

function Set-Subtitle { param([string]$Text) $script:W.Subtitle.Text = $Text }
function Clear-Content { $script:W.Content.Controls.Clear() }
function Set-NextHandler { param([scriptblock]$Handler)
  foreach($h in @($script:W.NextHandler)){ if($h){ $script:W.Next.Remove_Click($h) } }
  $script:W.NextHandler = $Handler; if($Handler){ $script:W.Next.Add_Click($Handler) }
}
function Set-BackHandler { param([scriptblock]$Handler)
  foreach($h in @($script:W.BackHandler)){ if($h){ $script:W.Back.Remove_Click($h) } }
  $script:W.BackHandler = $Handler; $script:W.Back.Visible = [bool]$Handler
  if($Handler){ $script:W.Back.Add_Click($Handler) }
}

# ---------------- pages ------------------------------------------------------
function Show-WelcomePage {
  $script:W.Page = "welcome"; Clear-Content; Set-Subtitle "Welcome"
  $c = $script:W.Content
  $c.Controls.Add((New-Label -Text "Set up ap-hub on this computer" -Font $script:FontH -Y 16))
  $c.Controls.Add((New-Label -Text "This wizard installs ap-hub and gets it running. It checks what's needed, searches this computer for any keys you already have so you don't have to hunt for them, generates an encryption key for you, and starts the service." -Color $script:Muted -Y 58 -Width 520))
  $c.Controls.Add((New-Label -Text "ap-hub reads accounting email, proof-gates it, and prepares reviewable QuickBooks entries -- writing only to a QuickBooks sandbox, never to production, and never modifying Gmail." -Color $script:Muted -Y 132 -Width 520))
  $c.Controls.Add((New-Label -Text "It takes a few minutes. You can cancel any time before the final step." -Color $script:Muted -Y 200 -Width 520))
  $script:W.Next.Text = "Next"; $script:W.Next.Enabled = $true
  Set-BackHandler $null
  Set-NextHandler { Show-OptionsPage }
}

function Show-OptionsPage {
  $script:W.Page = "options"; Clear-Content; Set-Subtitle "How you'll access ap-hub"
  $c = $script:W.Content
  $c.Controls.Add((New-Label -Text "Runs on this computer" -Font $script:FontH -Y 12))
  $c.Controls.Add((New-Label -Text "ap-hub runs on THIS computer at a local web address. Nothing on the internet can reach a local address, so your data never leaves this machine." -Color $script:Ink -Y 52 -Width 520))
  $c.Controls.Add((New-Label -Text "Local address port" -Font $script:FontB -Y 132))
  $c.Controls.Add((New-Label -Text "http://localhost:" -Font $script:FontMono -Color $script:Teal -X 24 -Y 160))
  $spin = [System.Windows.Forms.NumericUpDown]::new()
  $spin.Minimum = 1024; $spin.Maximum = 65535; $spin.Value = [decimal]$script:W.AppPort
  $spin.Location = [System.Drawing.Point]::new(140, 157); $spin.Size = [System.Drawing.Size]::new(80, 26); $spin.Font = $script:FontMono
  $c.Controls.Add($spin)
  $c.Controls.Add((New-Label -Text "Only change this if another program already uses 3000." -Font $script:FontS -Color $script:Muted -Y 192 -Width 520))
  $script:W.Next.Text = "Next"; $script:W.Next.Enabled = $true
  Set-BackHandler { Show-WelcomePage }
  Set-NextHandler { $script:W.AppPort = [int]$spin.Value; Show-PrereqPage }
}

function Show-PrereqPage {
  $script:W.Page = "prereq"; Clear-Content; Set-Subtitle "Step 1 of 3  -  Check requirements"
  $c = $script:W.Content
  $c.Controls.Add((New-Label -Text "Checking what's needed" -Font $script:FontH -Y 12))
  $list = [System.Windows.Forms.Panel]::new(); $list.Location = [System.Drawing.Point]::new(20, 52); $list.Size = [System.Drawing.Size]::new(545, 250); $list.AutoScroll = $true
  $c.Controls.Add($list)
  $hint = New-Label -Text "" -Color $script:Crit -X 24 -Y 312 -Width 545 -Height 34; $c.Controls.Add($hint)

  $render = {
    $list.Controls.Clear()
    $script:W.Prereqs = Get-ApHubPrerequisites -InstallRoot $InstallRoot -PgPort $PgPort -AppPort $script:W.AppPort
    $y = 4
    foreach ($chk in $script:W.Prereqs) {
      $icon = if ($chk.Ok) { "OK " } elseif ($chk.CanAutoFix) { "-- " } else { "X  " }
      $col = if ($chk.Ok) { $script:Good } elseif ($chk.CanAutoFix) { $script:Muted } else { $script:Crit }
      $row = New-Label -Text ("{0} {1}   {2}" -f $icon, $chk.Name, $chk.Detail) -Color $col -X 4 -Y $y -Width 520
      $list.Controls.Add($row); $y += 24
      if (-not $chk.Ok) {
        $fx = New-Label -Text ("     " + $chk.FixHint) -Font $script:FontS -Color $script:Muted -X 4 -Y $y -Width 520 -Height 30
        $list.Controls.Add($fx); $y += 34
      }
    }
    $ready = Test-ApHubReady -Checks $script:W.Prereqs
    $script:W.Next.Enabled = $ready
    $autofix = @($script:W.Prereqs | Where-Object { -not $_.Ok -and $_.CanAutoFix })
    if ($ready -and $autofix.Count -gt 0) {
      $hint.ForeColor = $script:Muted; $hint.Text = "PostgreSQL will be installed for you during setup."
    } elseif (-not $ready) {
      $hint.ForeColor = $script:Crit; $hint.Text = "Fix the item(s) marked X above, then click Re-check."
    } else { $hint.Text = "" }
  }
  & $render

  $script:W.Next.Text = "Next"
  Set-BackHandler { Show-OptionsPage }
  $recheck = [System.Windows.Forms.Button]::new(); $recheck.Text = "Re-check"; $recheck.Size = [System.Drawing.Size]::new(90, 28); $recheck.Location = [System.Drawing.Point]::new(20, 345); $recheck.FlatStyle = "System"
  $recheck.Add_Click($render); $c.Controls.Add($recheck)
  Set-NextHandler { Show-CredentialsPage }
}

# --- guided helper dialogs (the "walk me through it" experience) -------------
function Get-CredBox { param([string]$Name) ($script:W.CredRows | Where-Object { $_.Field.Name -eq $Name } | Select-Object -First 1).Box }

function New-HelperForm {
  param([string]$Title, [int]$Height = 480)
  $f = [System.Windows.Forms.Form]::new()
  $f.Text = $Title; $f.Size = [System.Drawing.Size]::new(600, $Height)
  $f.StartPosition = "CenterParent"; $f.FormBorderStyle = "FixedDialog"
  $f.MaximizeBox = $false; $f.MinimizeBox = $false; $f.BackColor = $script:Paper; $f.Font = $script:FontB
  return $f
}

function Add-HelperClose {
  param($Form, [int]$Y)
  $done = [System.Windows.Forms.Button]::new(); $done.Text = "Done"; $done.Size = [System.Drawing.Size]::new(100, 30)
  $done.Location = [System.Drawing.Point]::new(470, $Y); $done.FlatStyle = "System"
  $done.Add_Click({ $Form.Close() }); $Form.Controls.Add($done)
}

function Show-GmailHelper {
  $f = New-HelperForm -Title "Set up Gmail access (read-only)"
  $steps = "1.  Open the Google Cloud Console (button below) and create or select a project.`r`n" +
           "2.  APIs and Services > Library > enable the Gmail API.`r`n" +
           "3.  APIs and Services > Credentials > Create credentials > OAuth client ID.`r`n" +
           "4.  Application type: Desktop app (simplest), or Web application with redirect`r`n" +
           "      http://localhost:3001/oauth/gmail/callback`r`n" +
           "5.  Download the JSON, then click 'Load client_secret.json' below -- it fills the`r`n" +
           "      client ID and secret for you. ap-hub only ever requests read-only Gmail."
  $f.Controls.Add((New-Label -Text "Connect Gmail (read + optional drafts)" -Font $script:FontH -X 20 -Y 16))
  $f.Controls.Add((New-Label -Text $steps -Color $script:Ink -X 20 -Y 54 -Width 545 -Height 150))
  $open = [System.Windows.Forms.Button]::new(); $open.Text = "Open Google Cloud Console"; $open.Size = [System.Drawing.Size]::new(220, 30); $open.Location = [System.Drawing.Point]::new(20, 210); $open.FlatStyle = "System"
  $open.Add_Click({ Start-Process "https://console.cloud.google.com/apis/credentials" }); $f.Controls.Add($open)
  $browse = [System.Windows.Forms.Button]::new(); $browse.Text = "Load client_secret.json"; $browse.Size = [System.Drawing.Size]::new(200, 30); $browse.Location = [System.Drawing.Point]::new(250, 210); $browse.FlatStyle = "System"
  $status = New-Label -Text "" -Color $script:Good -X 20 -Y 256 -Width 545 -Height 40
  $browse.Add_Click({
    $dlg = [System.Windows.Forms.OpenFileDialog]::new(); $dlg.Filter = "JSON files (*.json)|*.json"; $dlg.InitialDirectory = (Join-Path $env:USERPROFILE "Downloads")
    if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
      try {
        $j = Get-Content $dlg.FileName -Raw | ConvertFrom-Json
        $node = if ($j.installed) { $j.installed } elseif ($j.web) { $j.web } else { $null }
        if ($node -and $node.client_id -and $node.client_secret) {
          (Get-CredBox "GMAIL_CLIENT_ID").Text = $node.client_id
          (Get-CredBox "GMAIL_CLIENT_SECRET").Text = $node.client_secret
          $status.ForeColor = $script:Good; $status.Text = "Loaded. Client ID and secret filled from " + (Split-Path -Leaf $dlg.FileName) + "."
        } else { $status.ForeColor = $script:Crit; $status.Text = "That file has no installed/web client_id + client_secret." }
      } catch { $status.ForeColor = $script:Crit; $status.Text = "Could not read that JSON file." }
    }
  }); $f.Controls.Add($browse); $f.Controls.Add($status)
  $f.Controls.Add((New-Label -Text "After install, finish the sign-in with:  npm run cli -- connect gmail" -Font $script:FontS -Color $script:Muted -X 20 -Y 310 -Width 545))
  Add-HelperClose -Form $f -Y 400
  [void]$f.ShowDialog($script:W.Form)
}

function Show-TelegramHelper {
  $f = New-HelperForm -Title "Set up Telegram alerts"
  $steps = "1.  In Telegram, open a chat with @BotFather.`r`n" +
           "2.  Send /newbot and follow the prompts to name your bot.`r`n" +
           "3.  BotFather replies with a token like 123456:ABC-DEF... Paste it below and Validate.`r`n" +
           "4.  Open Telegram and send any message to YOUR new bot (or add it to a group).`r`n" +
           "5.  Click 'Detect chat ID' -- ap-hub reads it from Telegram automatically."
  $f.Controls.Add((New-Label -Text "Connect Telegram (hold alerts)" -Font $script:FontH -X 20 -Y 16))
  $f.Controls.Add((New-Label -Text $steps -Color $script:Ink -X 20 -Y 54 -Width 545 -Height 130))
  $open = [System.Windows.Forms.Button]::new(); $open.Text = "Open BotFather"; $open.Size = [System.Drawing.Size]::new(150, 28); $open.Location = [System.Drawing.Point]::new(20, 188); $open.FlatStyle = "System"
  $open.Add_Click({ Start-Process "https://t.me/BotFather" }); $f.Controls.Add($open)
  $f.Controls.Add((New-Label -Text "Bot token" -Font $script:FontS -Color $script:Muted -X 20 -Y 228))
  $tok = [System.Windows.Forms.TextBox]::new(); $tok.Location = [System.Drawing.Point]::new(20, 248); $tok.Size = [System.Drawing.Size]::new(430, 24); $tok.Font = $script:FontMono
  $tok.Text = [string](Get-CredBox "TELEGRAM_BOT_TOKEN").Text; $f.Controls.Add($tok)
  $status = New-Label -Text "" -Color $script:Good -X 20 -Y 320 -Width 545 -Height 40
  $val = [System.Windows.Forms.Button]::new(); $val.Text = "Validate"; $val.Size = [System.Drawing.Size]::new(100, 26); $val.Location = [System.Drawing.Point]::new(460, 247); $val.FlatStyle = "System"
  $val.Add_Click({
    $u = Test-TelegramBotToken -BotToken $tok.Text.Trim()
    if ($u) { (Get-CredBox "TELEGRAM_BOT_TOKEN").Text = $tok.Text.Trim(); $status.ForeColor = $script:Good; $status.Text = "Token valid -- bot is $u. Now message the bot, then Detect chat ID." }
    else { $status.ForeColor = $script:Crit; $status.Text = "Token not valid (or no internet)." }
  }); $f.Controls.Add($val)
  $det = [System.Windows.Forms.Button]::new(); $det.Text = "Detect chat ID"; $det.Size = [System.Drawing.Size]::new(140, 30); $det.Location = [System.Drawing.Point]::new(20, 284); $det.FlatStyle = "System"
  $det.Add_Click({
    $id = Get-TelegramChatId -BotToken $tok.Text.Trim()
    if ($id) { (Get-CredBox "TELEGRAM_BOT_TOKEN").Text = $tok.Text.Trim(); (Get-CredBox "TELEGRAM_CHAT_ID").Text = $id; $status.ForeColor = $script:Good; $status.Text = "Found chat ID $id and filled it in." }
    else { $status.ForeColor = $script:Crit; $status.Text = "No chat found yet -- send your bot a message first, then try again." }
  }); $f.Controls.Add($det); $f.Controls.Add($status)
  Add-HelperClose -Form $f -Y 400
  [void]$f.ShowDialog($script:W.Form)
}

function Show-QuickBooksHelper {
  $f = New-HelperForm -Title "Connect QuickBooks" -Height 520
  $f.Controls.Add((New-Label -Text "QuickBooks Online (sandbox)" -Font $script:FontH -X 20 -Y 14))
  $qboSteps = "1.  Open the Intuit developer portal (button) and sign in.`r`n" +
              "2.  Create an app > select the Accounting scope.`r`n" +
              "3.  Under 'Keys & credentials' pick the SANDBOX keys: Client ID + Client Secret.`r`n" +
              "4.  Under 'Sandboxes' copy the sandbox Company (realm) ID.`r`n" +
              "5.  Paste them on the previous screen. ap-hub refuses production by design."
  $f.Controls.Add((New-Label -Text $qboSteps -Color $script:Ink -X 20 -Y 46 -Width 555 -Height 110))
  $open = [System.Windows.Forms.Button]::new(); $open.Text = "Open Intuit Developer"; $open.Size = [System.Drawing.Size]::new(190, 28); $open.Location = [System.Drawing.Point]::new(20, 158); $open.FlatStyle = "System"
  $open.Add_Click({ Start-Process "https://developer.intuit.com/app/developer/dashboard" }); $f.Controls.Add($open)

  # QuickBooks Desktop detected panel
  $qb = if ($script:W.Creds) { $script:W.Creds.QbDesktop } else { Get-QuickBooksDesktopInfo }
  $f.Controls.Add((New-Label -Text "QuickBooks Desktop" -Font $script:FontH -X 20 -Y 200))
  if ($qb -and $qb.Installed) {
    $line = "Detected on this computer" + $(if ($qb.SdkCom) { " (qbXML SDK present)" } else { "" }) + $(if ($qb.CompanyFiles.Count -gt 0) { "; " + $qb.CompanyFiles.Count + " company file(s) found" } else { "" }) + "."
    $f.Controls.Add((New-Label -Text $line -Color $script:Good -X 20 -Y 232 -Width 555))
    $f.Controls.Add((New-Label -Text "ap-hub connects to Desktop through the QuickBooks Web Connector. Choose how it may act on your REAL company file:" -Color $script:Ink -X 20 -Y 256 -Width 555 -Height 40))
    $rRead = [System.Windows.Forms.RadioButton]::new(); $rRead.Text = "Read-only verification (this build cannot write to your Desktop company file)"; $rRead.Location = [System.Drawing.Point]::new(24, 300); $rRead.Size = [System.Drawing.Size]::new(545, 24); $rRead.Font = $script:FontS
    $rRead.Checked = $true
    $rRead.Add_CheckedChanged({ if ($rRead.Checked) { $script:W.QbDesktopMode = 'readonly' } })
    $script:W.QbDesktopMode = 'readonly'
    $f.Controls.Add($rRead)
    $f.Controls.Add((New-Label -Text "The Web Connector .QWC config + adapter are set up in a later step; this records your choice." -Font $script:FontS -Color $script:Muted -X 20 -Y 356 -Width 555 -Height 34))
  } else {
    $f.Controls.Add((New-Label -Text "Not detected. Install QuickBooks Desktop + the SDK/Web Connector to use the Desktop path, or use QuickBooks Online above." -Color $script:Muted -X 20 -Y 232 -Width 555 -Height 40))
  }
  Add-HelperClose -Form $f -Y 440
  [void]$f.ShowDialog($script:W.Form)
}

function Show-LlmHelper {
  $f = New-HelperForm -Title "Choose your AI model" -Height 520
  $script:W.LlmDetect = if ($script:W.Creds) { $script:W.Creds.Llm } else { Get-ApHubLlmDetection }
  $llm = $script:W.LlmDetect
  $f.Controls.Add((New-Label -Text "Choose your AI model" -Font $script:FontH -X 20 -Y 14))
  $f.Controls.Add((New-Label -Text "ap-hub works with a local model (free), any OpenAI-compatible API, or a cloud key. Desktop chat apps (Claude Desktop, ChatGPT Desktop) cannot be used -- they have no API a program can call." -Color $script:Ink -X 20 -Y 46 -Width 555 -Height 44))
  $status = New-Label -Text "" -Color $script:Good -X 20 -Y 300 -Width 555 -Height 60; $f.Controls.Add($status)
  $y = 100

  # Local runtime: Ollama
  if ($llm.Ollama) {
    $bo = [System.Windows.Forms.Button]::new(); $bo.Text = "Use Ollama (detected, free)"; $bo.Size = [System.Drawing.Size]::new(210, 28); $bo.Location = [System.Drawing.Point]::new(20, $y); $bo.FlatStyle = "System"
    $bo.Add_Click({
      $rt = $script:W.LlmDetect.Ollama; $m = if ($rt.Models.Count -gt 0) { $rt.Models[0] } else { 'llama3.2-vision' }
      (Get-CredBox 'LLM_PROVIDER').Text = 'auto'; (Get-CredBox 'LLM_BASE_URL').Text = $rt.BaseUrl; (Get-CredBox 'LLM_MODEL').Text = $m
      $status.ForeColor = $script:Good; $status.Text = "Using Ollama at $($rt.BaseUrl) (model $m). For scanned invoices, pull a VISION model, e.g. 'ollama pull llama3.2-vision'."
    })
    $f.Controls.Add($bo)
    $f.Controls.Add((New-Label -Text ("models: " + (($llm.Ollama.Models | Select-Object -First 3) -join ", ")) -Font $script:FontS -Color $script:Muted -X 240 -Y ($y + 6) -Width 320)); $y += 38
  } else {
    $bo = [System.Windows.Forms.Button]::new(); $bo.Text = "Install Ollama (free local AI)"; $bo.Size = [System.Drawing.Size]::new(210, 28); $bo.Location = [System.Drawing.Point]::new(20, $y); $bo.FlatStyle = "System"
    $bo.Add_Click({ Start-Process 'https://ollama.com/download' })
    $f.Controls.Add($bo)
    $f.Controls.Add((New-Label -Text "Not running. Install it, run 'ollama pull llama3.2-vision', then reopen this." -Font $script:FontS -Color $script:Muted -X 240 -Y ($y + 6) -Width 320)); $y += 38
  }

  # Local runtime: LM Studio
  if ($llm.LmStudio) {
    $bl = [System.Windows.Forms.Button]::new(); $bl.Text = "Use LM Studio (detected, free)"; $bl.Size = [System.Drawing.Size]::new(210, 28); $bl.Location = [System.Drawing.Point]::new(20, $y); $bl.FlatStyle = "System"
    $bl.Add_Click({
      $rt = $script:W.LlmDetect.LmStudio; $m = if ($rt.Models.Count -gt 0) { $rt.Models[0] } else { 'local-model' }
      (Get-CredBox 'LLM_PROVIDER').Text = 'auto'; (Get-CredBox 'LLM_BASE_URL').Text = $rt.BaseUrl; (Get-CredBox 'LLM_MODEL').Text = $m
      $status.ForeColor = $script:Good; $status.Text = "Using LM Studio at $($rt.BaseUrl) (model $m)."
    })
    $f.Controls.Add($bl); $y += 38
  }

  $y += 10
  $f.Controls.Add((New-Label -Text "...or use a cloud key / any OpenAI-compatible endpoint on the main screen:" -Font $script:FontB -X 20 -Y $y -Width 555)); $y += 24
  $f.Controls.Add((New-Label -Text ("Detected: " +
        ($(if ($llm.Cli) { "CLI '$($llm.Cli)' (text-only)  " } else { "" })) +
        ($(if ($llm.AnthropicKey) { "ANTHROPIC_API_KEY in env  " } else { "" })) +
        ($(if ($llm.OpenAiKey) { "OPENAI_API_KEY in env  " } else { "" })) +
        ($(if (-not ($llm.Cli -or $llm.AnthropicKey -or $llm.OpenAiKey)) { "no CLI or cloud key" } else { "" }))) `
      -Font $script:FontS -Color $script:Muted -X 20 -Y $y -Width 555 -Height 20)); $y += 26
  $btnOpenAI = [System.Windows.Forms.Button]::new(); $btnOpenAI.Text = "Get an OpenAI key"; $btnOpenAI.Size = [System.Drawing.Size]::new(150, 26); $btnOpenAI.Location = [System.Drawing.Point]::new(20, $y); $btnOpenAI.FlatStyle = "System"
  $btnOpenAI.Add_Click({ Start-Process 'https://platform.openai.com/api-keys' })
  $btnAnthropic = [System.Windows.Forms.Button]::new(); $btnAnthropic.Text = "Get an Anthropic key"; $btnAnthropic.Size = [System.Drawing.Size]::new(160, 26); $btnAnthropic.Location = [System.Drawing.Point]::new(180, $y); $btnAnthropic.FlatStyle = "System"
  $btnAnthropic.Add_Click({ Start-Process 'https://console.anthropic.com/settings/keys' })
  $f.Controls.Add($btnOpenAI); $f.Controls.Add($btnAnthropic)

  Add-HelperClose -Form $f -Y 440
  [void]$f.ShowDialog($script:W.Form)
}

function Show-SwarmSyncHelper {
  $f = New-HelperForm -Title "Document proofs (SwarmSync)" -Height 570
  $f.Controls.Add((New-Label -Text "Document proofs (SwarmSync)" -Font $script:FontH -X 20 -Y 14))
  $desc = "SwarmSync adds three OPTIONAL proof features to every invoice:`r`n" +
          "  - InvoiceProof: a fraud scan (bank-detail changes, duplicates, PO mismatches) that blocks risky auto-posts.`r`n" +
          "  - Verify-API: notarizes the extracted data as a tamper-evident proof (with a confidence score).`r`n" +
          "  - AuditProof: anchors the daily audit trail into a verifiable hash chain.`r`n" +
          "They need a SwarmSync key (ssk_live_...). You can also run ap-hub without them."
  $f.Controls.Add((New-Label -Text $desc -Color $script:Ink -X 20 -Y 46 -Width 555 -Height 118))

  $curEnabled = ([string](Get-CredBox 'SWARMSYNC_ENABLED').Text).ToLower() -ne 'false'

  $rOn = [System.Windows.Forms.RadioButton]::new(); $rOn.Text = "Use SwarmSync (recommended) -- enter your key below"; $rOn.Location = [System.Drawing.Point]::new(24, 170); $rOn.Size = [System.Drawing.Size]::new(545, 22); $rOn.Font = $script:FontB
  $rOff = [System.Windows.Forms.RadioButton]::new(); $rOff.Text = "Don't use SwarmSync"; $rOff.Location = [System.Drawing.Point]::new(24, 196); $rOff.Size = [System.Drawing.Size]::new(545, 22); $rOff.Font = $script:FontB
  if ($curEnabled) { $rOn.Checked = $true } else { $rOff.Checked = $true }
  $f.Controls.Add($rOn); $f.Controls.Add($rOff)

  $f.Controls.Add((New-Label -Text "SwarmSync API key (ssk_live_...)" -Font $script:FontS -Color $script:Muted -X 44 -Y 224))
  $key = [System.Windows.Forms.TextBox]::new(); $key.Location = [System.Drawing.Point]::new(44, 244); $key.Size = [System.Drawing.Size]::new(496, 24); $key.Font = $script:FontMono; $key.UseSystemPasswordChar = $true; $key.Text = [string](Get-CredBox 'SWARMSYNC_API_KEY').Text
  $f.Controls.Add($key)

  $f.Controls.Add((New-Label -Text "If you turn SwarmSync OFF, invoices are held for human review. Proofless automatic posting is not available." -Font $script:FontB -X 24 -Y 284 -Width 545 -Height 44))

  $status = New-Label -Text "" -Color $script:Good -X 20 -Y 372 -Width 545 -Height 44; $f.Controls.Add($status)

  $sync = {
    $key.Enabled = $rOn.Checked
  }
  $rOn.Add_CheckedChanged($sync); $rOff.Add_CheckedChanged($sync); & $sync

  $apply = [System.Windows.Forms.Button]::new(); $apply.Text = "Apply"; $apply.Size = [System.Drawing.Size]::new(100, 30); $apply.Location = [System.Drawing.Point]::new(20, 490); $apply.FlatStyle = "System"
  $apply.Add_Click({
    if ($rOn.Checked) {
      (Get-CredBox 'SWARMSYNC_ENABLED').Text = 'true'
      (Get-CredBox 'SWARMSYNC_API_KEY').Text = $key.Text.Trim()
      $status.ForeColor = $script:Good; $status.Text = "SwarmSync ON: InvoiceProof + Verify-API + AuditProof will run (needs the key)."
    } else {
      (Get-CredBox 'SWARMSYNC_ENABLED').Text = 'false'
      (Get-CredBox 'SWARMSYNC_OFF_MODE').Text = 'review'
      $status.ForeColor = $script:Good
      $status.Text = "SwarmSync OFF: invoices will go to human review; no proofless automatic posting."
    }
  })
  $f.Controls.Add($apply)
  Add-HelperClose -Form $f -Y 490
  [void]$f.ShowDialog($script:W.Form)
}

function Show-CredentialsPage {
  $script:W.Page = "credentials"; Clear-Content; Set-Subtitle "Step 2 of 3  -  Keys and credentials"
  $c = $script:W.Content
  if (-not $script:W.Creds) { $script:W.Creds = Get-ApHubDiscoveredCredentials -PgPort $PgPort }
  $disc = $script:W.Creds

  $c.Controls.Add((New-Label -Text "We searched this computer and filled in what we found" -Font $script:FontH -Y 8 -Width 545))
  $llmNote = if ($disc.Llm -and $disc.Llm.Ollama) { "  Ollama detected (LLM ready)." } elseif ($disc.Llm -and $disc.Llm.LmStudio) { "  LM Studio detected (LLM ready)." } else { "" }
  $foundNote = "Encryption key generated for you." + $(if ($disc.PostgresDetected) { "  PostgreSQL detected." } else { "" }) + $(if ($disc.ClaudeCliDetected) { "  Claude CLI detected." } else { "" }) + $llmNote
  $c.Controls.Add((New-Label -Text $foundNote -Font $script:FontS -Color $script:Teal -Y 40 -Width 545))
  $c.Controls.Add((New-Label -Text "Fields marked * are required. Anything already filled was found on this machine or generated -- you can edit it." -Font $script:FontS -Color $script:Muted -Y 60 -Width 545))

  $scroll = [System.Windows.Forms.Panel]::new(); $scroll.Location = [System.Drawing.Point]::new(18, 88); $scroll.Size = [System.Drawing.Size]::new(552, 250); $scroll.AutoScroll = $true
  $c.Controls.Add($scroll)
  $err = New-Label -Text "" -Color $script:Crit -X 24 -Y 344 -Width 545 -Height 20; $c.Controls.Add($err)

  $script:W.CredRows = @()
  $y = 4; $lastGroup = ""
  foreach ($f in $disc.Fields) {
    if ($f.Group -ne $lastGroup) {
      $g = New-Label -Text $f.Group -Font $script:FontB -Color $script:Ink -X 4 -Y $y -Width 360
      $scroll.Controls.Add($g)
      # A "Guide me" button opens the step-by-step walkthrough for guided groups.
      $helper = $null
      if ($f.Group -like 'AI*') { $helper = { Show-LlmHelper } }
      elseif ($f.Group -like 'Gmail*') { $helper = { Show-GmailHelper } }
      elseif ($f.Group -like 'QuickBooks*') { $helper = { Show-QuickBooksHelper } }
      elseif ($f.Group -like '*SwarmSync*' -or $f.Group -like 'Document proofs*') { $helper = { Show-SwarmSyncHelper } }
      elseif ($f.Group -like 'Gatekeeper*') { $helper = { Show-TelegramHelper } }
      if ($helper) {
        $gb = [System.Windows.Forms.Button]::new(); $gb.Text = "Guide me"; $gb.Size = [System.Drawing.Size]::new(96, 22)
        $gb.Location = [System.Drawing.Point]::new(400, $y); $gb.FlatStyle = "System"; $gb.Font = $script:FontS
        $gb.Add_Click($helper); $scroll.Controls.Add($gb)
      }
      $y += 26; $lastGroup = $f.Group
    }
    $star = if ($f.Required) { " *" } else { "" }
    $srcTag = if ($f.Source -ne "empty") { "   [" + $f.Source + "]" } else { "" }
    $lab = New-Label -Text ($f.Label + $star + $srcTag) -Font $script:FontS -Color $script:Muted -X 8 -Y $y -Width 520
    $scroll.Controls.Add($lab); $y += 20
    $box = [System.Windows.Forms.TextBox]::new()
    $box.Location = [System.Drawing.Point]::new(8, $y); $box.Size = [System.Drawing.Size]::new(510, 24); $box.Font = $script:FontMono
    $box.Text = [string]$f.Value
    if ($f.Secret) { $box.UseSystemPasswordChar = $true }
    $scroll.Controls.Add($box); $y += 32
    $script:W.CredRows += [pscustomobject]@{ Field = $f; Box = $box }
  }

  # Optional: reveal secrets
  $reveal = [System.Windows.Forms.CheckBox]::new(); $reveal.Text = "Show secret values"; $reveal.Location = [System.Drawing.Point]::new(20, 344); $reveal.Size = [System.Drawing.Size]::new(200, 22); $reveal.Font = $script:FontS
  $reveal.Add_CheckedChanged({
    foreach ($r in $script:W.CredRows) { if ($r.Field.Secret) { $r.Box.UseSystemPasswordChar = -not $reveal.Checked } }
  })
  # place reveal only if room; otherwise rely on the err label row
  $c.Controls.Add($reveal); $err.Location = [System.Drawing.Point]::new(24, 368)

  $script:W.Next.Text = "Next"; $script:W.Next.Enabled = $true
  Set-BackHandler { Show-PrereqPage }
  Set-NextHandler {
    $values = @{}; $missing = @()
    foreach ($r in $script:W.CredRows) {
      $v = $r.Box.Text.Trim(); $values[$r.Field.Name] = $v
      if ($r.Field.Required -and $v -eq "") { $missing += $r.Field.Label }
    }
    if ($missing.Count -gt 0) {
      $err.Text = "Please fill the required field(s): " + ($missing -join ", ")
      return
    }
    $script:W.CredValues = $values
    Show-InstallPage
  }
}

function Show-InstallPage {
  $script:W.Page = "install"; Clear-Content; Set-Subtitle "Step 3 of 3  -  Install"
  $c = $script:W.Content
  $c.Controls.Add((New-Label -Text "Installing ap-hub" -Font $script:FontH -Y 12))
  $status = New-Label -Text "Ready to install." -Color $script:Muted -Y 50 -Width 545; $c.Controls.Add($status)
  $bar = [System.Windows.Forms.ProgressBar]::new(); $bar.Location = [System.Drawing.Point]::new(24, 78); $bar.Size = [System.Drawing.Size]::new(540, 18); $bar.Minimum = 0; $bar.Maximum = 100; $c.Controls.Add($bar)
  $log = [System.Windows.Forms.TextBox]::new(); $log.Multiline = $true; $log.ScrollBars = "Vertical"; $log.ReadOnly = $true; $log.Font = $script:FontMono; $log.Location = [System.Drawing.Point]::new(24, 106); $log.Size = [System.Drawing.Size]::new(540, 210); $log.BackColor = [System.Drawing.Color]::FromArgb(248, 250, 249); $c.Controls.Add($log)

  Set-BackHandler { Show-CredentialsPage }
  $script:W.Next.Text = "Install"; $script:W.Next.Enabled = $true

  $runInstall = {
    $script:W.Next.Enabled = $false; $script:W.Back.Enabled = $false; $script:W.Cancel.Enabled = $false
    $progressFile = [System.IO.Path]::GetTempFileName()
    $resultFile = [System.IO.Path]::GetTempFileName()
    $core = (Join-Path $script:ScriptDir 'install-core.ps1')
    # Carry the QuickBooks Desktop mode choice (from the QuickBooks guide) into
    # the install so .env enables the Web Connector path when chosen.
    if ($script:W.QbDesktopMode) { $script:W.CredValues["QB_DESKTOP_MODE"] = $script:W.QbDesktopMode }
    # Serialize credential values for the background job (a hashtable crosses the
    # boundary as base64 JSON so no secret is exposed on a command line).
    $credJson = ($script:W.CredValues | ConvertTo-Json -Compress)
    $credB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($credJson))

    $job = Start-Job -ScriptBlock {
      param($core, $root, $pgUser, $pgPort, $appPort, $pf, $rf, $credB64)
      . $core
      $vals = @{}
      (ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($credB64)))).PSObject.Properties | ForEach-Object { $vals[$_.Name] = $_.Value }
      $cb = { param($p) ($p | ConvertTo-Json -Compress) | Add-Content -Path $pf }
      $r = Invoke-ApHubInstall -Values $vals -InstallRoot $root -PgSuperuser $pgUser -PgPort $pgPort -AppPort $appPort -OnProgress $cb
      ($r | ConvertTo-Json -Compress) | Set-Content -Path $rf
    } -ArgumentList $core, $InstallRoot, $PgSuperuser, $PgPort, $script:W.AppPort, $progressFile, $resultFile, $credB64

    $state = @{ Offset = 0 }
    $timer = [System.Windows.Forms.Timer]::new(); $timer.Interval = 400
    $script:W.Job = $job; $script:W.Timer = $timer
    $timer.Add_Tick({
      if (Test-Path $progressFile) {
        $lines = @(Get-Content $progressFile -ErrorAction SilentlyContinue)
        if ($lines.Count -gt $state.Offset) {
          for ($i = $state.Offset; $i -lt $lines.Count; $i++) {
            try { $p = $lines[$i] | ConvertFrom-Json } catch { continue }
            if ($p.Percent -ge 0 -and $p.Percent -le 100) { $bar.Value = [int]$p.Percent }
            $status.Text = $p.Message
            $log.AppendText(("[{0,3}%] {1}`r`n" -f [int]$p.Percent, $p.Message))
          }
          $state.Offset = $lines.Count
        }
      }
      if ($job.State -in @('Completed', 'Failed', 'Stopped')) {
        $timer.Stop()
        Receive-Job $job -ErrorAction SilentlyContinue | Out-Null
        $res = $null; try { $res = Get-Content $resultFile -Raw | ConvertFrom-Json } catch { }
        Remove-Job $job -Force -ErrorAction SilentlyContinue
        Remove-Item $progressFile, $resultFile -Force -ErrorAction SilentlyContinue
        $timer.Dispose(); $script:W.Job = $null; $script:W.Timer = $null
        $script:W.Cancel.Enabled = $true
        if ($res -and $res.Success) { $script:W.Result = $res; Show-RecoveryPage }
        else {
          $msg = if ($res -and $res.Error) { $res.Error } else { "The install did not complete. See the log above." }
          Show-ErrorPage -Message $msg -Log $log.Text
        }
      }
    })
    $timer.Start()
  }
  Set-NextHandler $runInstall
}

function Show-RecoveryPage {
  $script:W.Page = "recovery"; Clear-Content; Set-Subtitle "Almost done  -  Save your recovery key"
  $c = $script:W.Content
  $res = $script:W.Result
  $c.Controls.Add((New-Label -Text "Save your recovery key" -Font $script:FontH -Y 12))

  if ($res.RecoveryWasCreated) {
    $c.Controls.Add((New-Label -Text "ap-hub generated an encryption key and saved a recovery copy. It is the ONLY copy outside .env. If .env is lost and you don't have this, tokens encrypted with the old key can't be read. Save it somewhere safe." -Color $script:Ink -Y 52 -Width 520))
    $path = New-Label -Text $res.RecoveryKeyPath -Font $script:FontMono -Color $script:Teal -Y 130 -Width 520; $c.Controls.Add($path)
    $open = [System.Windows.Forms.Button]::new(); $open.Text = "Open folder"; $open.Size = [System.Drawing.Size]::new(110, 30); $open.Location = [System.Drawing.Point]::new(24, 162); $open.FlatStyle = "System"
    $open.Add_Click({ Start-Process explorer.exe "/select,`"$($res.RecoveryKeyPath)`"" }); $c.Controls.Add($open)

    $chk = [System.Windows.Forms.CheckBox]::new(); $chk.Text = "I have saved my recovery key in a safe place."; $chk.Location = [System.Drawing.Point]::new(24, 214); $chk.Size = [System.Drawing.Size]::new(520, 24); $chk.Font = $script:FontB
    $chk.Add_CheckedChanged({ $script:W.RecoveryConfirmed = $chk.Checked; $script:W.Next.Enabled = (Test-RecoverySaved -Confirmed $chk.Checked -RecoveryWasCreated $true) })
    $c.Controls.Add($chk)
    $script:W.Next.Enabled = $false
  } else {
    $c.Controls.Add((New-Label -Text "This was a re-install -- your existing encryption key and .env were left untouched. Nothing new to save." -Color $script:Muted -Y 52 -Width 520))
    $script:W.Next.Enabled = $true
  }

  $script:W.Next.Text = "Finish"
  Set-BackHandler $null
  Set-NextHandler { Show-FinishPage }
}

function Show-FinishPage {
  $script:W.Page = "finish"; Clear-Content; Set-Subtitle "Done"
  $c = $script:W.Content
  $res = $script:W.Result
  $c.Controls.Add((New-Label -Text "ap-hub is running" -Font $script:FontH -Color $script:Good -Y 20))
  $c.Controls.Add((New-Label -Text "Open it in your browser at:" -Color $script:Ink -Y 62 -Width 520))
  $url = New-Label -Text ($res.AppUrl + "/onboarding") -Font $script:FontMono -Color $script:Teal -Y 88 -Width 520; $c.Controls.Add($url)
  $open = [System.Windows.Forms.Button]::new(); $open.Text = "Open ap-hub"; $open.Size = [System.Drawing.Size]::new(140, 32); $open.Location = [System.Drawing.Point]::new(24, 118); $open.FlatStyle = "System"
  $open.Add_Click({ Start-Process ($res.AppUrl + "/onboarding") }); $c.Controls.Add($open)
  $c.Controls.Add((New-Label -Text "Connect Gmail and QuickBooks with:  npm run cli -- connect gmail  (and connect qbo)." -Font $script:FontS -Color $script:Muted -Y 170 -Width 520))
  if ($res.QwcPath) {
    $c.Controls.Add((New-Label -Text ("QuickBooks Desktop: import this into the Web Connector -> " + $res.QwcPath) -Font $script:FontS -Color $script:Teal -Y 194 -Width 545))
  }
  $c.Controls.Add((New-Label -Text "QBO writes are sandbox-only. Gmail may create drafts but never sends replies." -Font $script:FontS -Color $script:Muted -Y 220 -Width 520))
  $script:W.Next.Text = "Close"; $script:W.Next.Enabled = $true
  Set-BackHandler $null
  Set-NextHandler { $script:W.Form.Close() }
}

function Show-ErrorPage {
  param([string]$Message, [string]$Log = "")
  $script:W.Page = "error"; Clear-Content; Set-Subtitle "Something needs attention"
  $c = $script:W.Content
  $c.Controls.Add((New-Label -Text "Install didn't finish" -Font $script:FontH -Color $script:Crit -Y 14))
  $c.Controls.Add((New-Label -Text $Message -Color $script:Ink -Y 52 -Width 520 -Height 60))
  $c.Controls.Add((New-Label -Text "You can fix the issue and try again -- nothing was filed or sent. Copy the log below if you need help." -Color $script:Muted -Y 116 -Width 520))
  $logBox = [System.Windows.Forms.TextBox]::new(); $logBox.Multiline = $true; $logBox.ScrollBars = "Vertical"; $logBox.ReadOnly = $true; $logBox.Font = $script:FontMono; $logBox.Text = $Log; $logBox.Location = [System.Drawing.Point]::new(24, 152); $logBox.Size = [System.Drawing.Size]::new(540, 140); $c.Controls.Add($logBox)
  $copy = [System.Windows.Forms.Button]::new(); $copy.Text = "Copy log"; $copy.Size = [System.Drawing.Size]::new(90, 28); $copy.Location = [System.Drawing.Point]::new(24, 300); $copy.FlatStyle = "System"
  $copy.Add_Click({ if ($Log) { [System.Windows.Forms.Clipboard]::SetText($Log) } }); $c.Controls.Add($copy)
  $script:W.Next.Text = "Try again"; $script:W.Next.Enabled = $true; $script:W.Back.Enabled = $true; $script:W.Cancel.Enabled = $true
  Set-BackHandler $null
  Set-NextHandler { Show-CredentialsPage }
}

function Start-Wizard {
  Initialize-Wizard
  Show-WelcomePage
  [System.Windows.Forms.Application]::Run($script:W.Form)
}

# ---------------- entry ------------------------------------------------------
if ($SelfTest) {
  $failures = @()
  try {
    Initialize-Wizard
    foreach ($p in @('Show-WelcomePage', 'Show-OptionsPage', 'Show-PrereqPage', 'Show-CredentialsPage', 'Show-InstallPage')) {
      & $p
      if ($script:W.Content.Controls.Count -lt 1) { $failures += "$p produced no controls" }
    }
    if (-not $script:W.CredRows -or $script:W.CredRows.Count -lt 5) { $failures += "credentials page built no field rows" }
    $script:W.Result = [pscustomobject]@{ Success = $true; RecoveryKeyPath = "C:\x\recovery.key"; RecoveryWasCreated = $true; AppUrl = "http://localhost:3000"; Error = $null }
    Show-RecoveryPage
    if ($script:W.Next.Enabled) { $failures += "recovery page did NOT gate Finish behind the checkbox" }
    Show-FinishPage
    Show-ErrorPage -Message "sample" -Log "sample log"
    if ((Test-RecoverySaved -Confirmed $false -RecoveryWasCreated $true) -ne $false) { $failures += "Test-RecoverySaved should block when unconfirmed" }
    if ((Test-RecoverySaved -Confirmed $true  -RecoveryWasCreated $true) -ne $true)  { $failures += "Test-RecoverySaved should pass when confirmed" }
    if ((Test-RecoverySaved -Confirmed $false -RecoveryWasCreated $false) -ne $true) { $failures += "Test-RecoverySaved should pass when nothing new to save" }
    $script:W.Form.Dispose()
  } catch { $failures += "self-test threw: $($_.Exception.Message)" }

  if ($failures.Count -gt 0) { $failures | ForEach-Object { Write-Error $_ }; exit 1 }
  Write-Output "install-gui self-test OK -- all pages built (incl. credentials) + recovery-key gate enforced"
  exit 0
}

if ($CaptureTo) {
  Initialize-Wizard
  switch ($CapturePage) {
    "options"     { Show-WelcomePage; Show-OptionsPage }
    "prereq"      { Show-WelcomePage; Show-PrereqPage }
    "credentials" { Show-WelcomePage; Show-CredentialsPage }
    "recovery"    {
      $script:W.Result = [pscustomobject]@{ Success = $true; RecoveryKeyPath = "$env:APPDATA\ap-hub\recovery.key"; RecoveryWasCreated = $true; AppUrl = "http://localhost:3000"; Error = $null }
      Show-RecoveryPage
    }
    default       { Show-WelcomePage }
  }
  $script:W.Form.Show(); [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 300; [System.Windows.Forms.Application]::DoEvents()
  $bmp = [System.Drawing.Bitmap]::new($script:W.Form.Width, $script:W.Form.Height)
  $script:W.Form.DrawToBitmap($bmp, [System.Drawing.Rectangle]::new(0, 0, $script:W.Form.Width, $script:W.Form.Height))
  $bmp.Save($CaptureTo, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose(); $script:W.Form.Close()
  Write-Output "captured $CapturePage -> $CaptureTo"
  exit 0
}

Start-Wizard
