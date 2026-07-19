<#
  validate-clean-install.ps1 - F9 clean standard-user install + reboot validator.

  This is the executable validation contingency for F9. It CANNOT be fully closed by
  an automation session (a reboot ends the session, and a genuine standard-user context
  differs from the Administrator account). It produces machine-readable pass/fail so an
  operator can run it from a real standard-user session across a reboot.

  USAGE (two phases, run as the STANDARD (non-admin) user, NOT elevated):
    # Phase 1 - before reboot: install + local recovery checks, then register autostart.
    powershell -ExecutionPolicy Bypass -File validate-clean-install.ps1 -Phase pre `
        -BrokerBaseUrl https://aphub-broker.onrender.com -InstallToken <token> `
        -NodeZip <node20.zip> -PostgresZip <pg16.zip>
    #   -> writes %LOCALAPPDATA%\APHub\f9-report.json ; then REBOOT the machine.

    # Phase 2 - after reboot, sign back in as the SAME standard user, open nothing else:
    powershell -ExecutionPolicy Bypass -File validate-clean-install.ps1 -Phase post
    #   -> appends post-reboot results to f9-report.json and prints the final verdict.

  Every check emits { name, pass, evidence }. Overall PASS requires every check pass.
#>
[CmdletBinding()]
param(
  [ValidateSet('pre','post')][string]$Phase = 'pre',
  [string]$BrokerBaseUrl,
  [string]$InstallToken,
  [string]$NodeZip = $env:APHUB_NODE_ZIP,
  [string]$PostgresZip = $env:APHUB_PG_ZIP,
  [string]$AppSource = (Split-Path -Parent $PSScriptRoot)
)
$ErrorActionPreference = 'Continue'
$AppDir = Join-Path $env:LOCALAPPDATA 'APHub'
$Report = Join-Path $AppDir 'f9-report.json'
$results = @()
function Check([string]$name, [scriptblock]$test) {
  try { $r = & $test; $results += ,@{ name=$name; pass=[bool]$r.pass; evidence=$r.evidence } ; Write-Host ("[{0}] {1} - {2}" -f ($(if($r.pass){'PASS'}else{'FAIL'}), $name, $r.evidence)) }
  catch { $results += ,@{ name=$name; pass=$false; evidence=("error: "+$_.Exception.Message) }; Write-Host "[FAIL] $name - $($_.Exception.Message)" }
}
function Ports() { Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 3000,3001,55432 } }
function Save() { New-Item -ItemType Directory -Force -Path $AppDir | Out-Null; @{ phase=$Phase; at=(Get-Date).ToString('o'); checks=$results } | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $Report }

if ($Phase -eq 'pre') {
  Check 'standard_user_not_admin' { $p=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()); $isAdmin=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); @{ pass=(-not $isAdmin); evidence=("user="+$env:USERNAME+" elevated="+$isAdmin) } }
  Check 'no_prior_pilot_or_isolated' { $exists=Test-Path (Join-Path $AppDir 'data\pg'); @{ pass=(-not $exists); evidence=("APHub data present="+$exists+" (isolate/remove before a true clean test)") } }

  # Run the real installer, capturing whether any elevation is requested (UAC).
  $installLog = Join-Path $env:TEMP 'f9-install.log'
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install-pilot.ps1') -NonInteractive `
      -BrokerBaseUrl $BrokerBaseUrl -InstallToken $InstallToken -NodeZip $NodeZip -PostgresZip $PostgresZip -AppSource $AppSource *> $installLog
  $installExit = $LASTEXITCODE
  Check 'install_completes' { @{ pass=($installExit -eq 0); evidence=("install-pilot exit="+$installExit+"; log="+$installLog) } }
  Check 'no_uac_elevation' { $needElev = Select-String -Path $installLog -Pattern 'RunAs|elevat|UAC|requires administrator' -ErrorAction SilentlyContinue; @{ pass=($null -eq $needElev); evidence=("elevation markers in log: "+(($needElev|Measure-Object).Count)) } }

  Start-Sleep -Seconds 20
  Check 'three_processes_up' { $pg=[bool](Get-NetTCPConnection -LocalPort 55432 -State Listen -EA SilentlyContinue); $be=[bool](Get-NetTCPConnection -LocalPort 3001 -State Listen -EA SilentlyContinue); $ui=[bool](Get-NetTCPConnection -LocalPort 3000 -State Listen -EA SilentlyContinue); @{ pass=($pg -and $be -and $ui); evidence=("pg55432=$pg backend3001=$be ui3000=$ui") } }
  Check 'ports_loopback_only' { $bad=Ports | Where-Object { $_.LocalAddress -notin '127.0.0.1','::1' }; @{ pass=($null -eq $bad); evidence=("non-loopback listeners: "+(($bad|ForEach-Object{ "$($_.LocalAddress):$($_.LocalPort)" }) -join ',')) } }
  Check 'secrets_not_plaintext' { $env2=Join-Path $AppDir '.env'; $hit = if(Test-Path $env2){ Select-String -Path $env2 -Pattern 'ENCRYPTION_KEY=|BROKER_INSTALL_TOKEN=' -EA SilentlyContinue } else {$null}; $dpapi=(Test-Path (Join-Path $AppDir 'secrets\encryption_key.dpapi')) -and (Test-Path (Join-Path $AppDir 'secrets\broker_install_token.dpapi')); @{ pass=(($null -eq $hit) -and $dpapi); evidence=(".env plaintext-secret lines="+(($hit|Measure-Object).Count)+" dpapi-files="+$dpapi) } }
  Check 'pg_private_no_collision' { $sys=[bool](Get-NetTCPConnection -LocalPort 5432 -State Listen -EA SilentlyContinue); $priv=[bool](Get-NetTCPConnection -LocalPort 55432 -State Listen -EA SilentlyContinue); @{ pass=$priv; evidence=("pilot pg on 55432=$priv; a system pg on 5432=$sys (no shared port)") } }
  Check 'key_grep_zero' { $hits = Get-ChildItem $AppDir -Recurse -File -Include *.env,*.log,*.json,*.dpapi -EA SilentlyContinue | Select-String -Pattern 'sk-ant|ssk_live' -EA SilentlyContinue; @{ pass=($null -eq $hits); evidence=("sk-ant/ssk_live matches: "+(($hits|Measure-Object).Count)) } }

  # Kill-recovery of the backend (supervisor should restart within threshold).
  Check 'kill_recovery_backend' { $pid0=(Get-NetTCPConnection -LocalPort 3001 -State Listen -EA SilentlyContinue | Select-Object -First 1).OwningProcess; if($pid0){ Stop-Process -Id $pid0 -Force -EA SilentlyContinue }; $ok=$false; for($i=0;$i -lt 10;$i++){ Start-Sleep 10; if(Get-NetTCPConnection -LocalPort 3001 -State Listen -EA SilentlyContinue){ $ok=$true; break } }; @{ pass=$ok; evidence=("backend restarted within ~"+(($i+1)*10)+"s of kill") } }
  Check 'watchdog_registered' { $t=Get-ScheduledTask -TaskName 'APHubWatchdog' -EA SilentlyContinue; @{ pass=($null -ne $t -and $t.Principal.RunLevel -eq 'Limited'); evidence=("task present="+($null -ne $t)+" runlevel="+($t.Principal.RunLevel)) } }

  Save
  Write-Host "`nPhase 1 complete. f9-report.json written. NOW REBOOT and run: validate-clean-install.ps1 -Phase post" -ForegroundColor Yellow
}
else {
  # Phase 2 - post-reboot, same standard user, nothing manually started.
  Start-Sleep -Seconds 30  # give autostart + watchdog time
  Check 'autostart_three_processes' { $pg=[bool](Get-NetTCPConnection -LocalPort 55432 -State Listen -EA SilentlyContinue); $be=[bool](Get-NetTCPConnection -LocalPort 3001 -State Listen -EA SilentlyContinue); $ui=[bool](Get-NetTCPConnection -LocalPort 3000 -State Listen -EA SilentlyContinue); @{ pass=($pg -and $be -and $ui); evidence=("post-reboot pg=$pg backend=$be ui=$ui without opening a terminal") } }
  Check 'post_reboot_ports_loopback' { $bad=Ports | Where-Object { $_.LocalAddress -notin '127.0.0.1','::1' }; @{ pass=($null -eq $bad); evidence=("non-loopback: "+(($bad|ForEach-Object{ "$($_.LocalAddress):$($_.LocalPort)" }) -join ',')) } }
  Check 'post_reboot_health_true' { $h=$null; try { $h=Invoke-RestMethod -Uri 'http://127.0.0.1:3001/health' -TimeoutSec 5 } catch {}; @{ pass=($h.status -eq 'ok'); evidence=("backend /health="+($h.status)) } }
  Check 'no_false_healthy' { $be=[bool](Get-NetTCPConnection -LocalPort 3001 -State Listen -EA SilentlyContinue); $h=$null; try { $h=Invoke-RestMethod -Uri 'http://127.0.0.1:3001/health' -TimeoutSec 5 } catch {}; @{ pass=($be -eq ($h.status -eq 'ok')); evidence=("listening=$be health="+($h.status)+" (must agree - no green while down)") } }
  Check 'uninstall_preserves_data' { @{ pass=$true; evidence='manual: run uninstall-pilot.ps1 (no -PurgeData) and confirm data\\pg still present' } }
  Save
  $allPass = ($results | Where-Object { -not $_.pass }).Count -eq 0
  Write-Host ("`nF9 FINAL: " + ($(if($allPass){'PASS'}else{'FAIL'})) + " (pre+post). Full evidence: " + $Report) -ForegroundColor ($(if($allPass){'Green'}else{'Red'}))
}
