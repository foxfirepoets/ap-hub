<#
  Creates a CurrentUser-DPAPI protected, short-lived installer credential bundle.
  Secret values are entered through SecureString prompts and never appear in process args.
#>
[CmdletBinding()]
param([string]$Path = (Join-Path $env:TEMP ("aphub-install-{0}.dpapi" -f ([guid]::NewGuid()))))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

function Read-PlainSecret([string]$Label) {
  $secure = Read-Host $Label -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

$payload = @{
  InstallToken = Read-PlainSecret 'Broker install token'
  GmailClientSecret = Read-PlainSecret 'Gmail client secret'
  GoogleSsoClientSecret = Read-PlainSecret 'Google SSO client secret'
  QboSandboxClientSecret = Read-PlainSecret 'QBO sandbox client secret'
} | ConvertTo-Json -Compress
$encrypted = [Security.Cryptography.ProtectedData]::Protect(
  [Text.Encoding]::UTF8.GetBytes($payload), $null, 'CurrentUser'
)
[IO.File]::WriteAllText($Path, [Convert]::ToBase64String($encrypted))
Write-Output $Path
