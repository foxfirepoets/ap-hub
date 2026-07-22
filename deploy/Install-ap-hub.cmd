@echo off
REM ============================================================================
REM  ap-hub - double-click this file to install with the guided wizard.
REM  Searches this computer for keys you already have, generates an encryption
REM  key, provisions the database, and starts the service. Sandbox-only; never
REM  modifies Gmail.
REM ============================================================================
setlocal
set "HERE=%~dp0"
REM Uses Windows' built-in PowerShell; -STA is required for the Windows Forms UI;
REM -ExecutionPolicy Bypass runs the wizard without changing machine-wide policy.
powershell -NoProfile -STA -ExecutionPolicy Bypass -File "%HERE%install-gui.ps1" %*
if errorlevel 1 (
  echo.
  echo The installer reported a problem. See the messages above.
  pause
)
endlocal
