$ErrorActionPreference = 'Stop'

if (-not $env:INSTALLER_OUT) {
  throw 'INSTALLER_OUT is not set.'
}

$installer = $env:INSTALLER_OUT
if (-not (Test-Path -LiteralPath $installer)) {
  throw "Installer was not found: $installer"
}

$cert = $null
if ($env:POLYSONG_SIGN_CERT_PATH) {
  if (-not (Test-Path -LiteralPath $env:POLYSONG_SIGN_CERT_PATH)) {
    throw "Signing certificate was not found: $env:POLYSONG_SIGN_CERT_PATH"
  }
  $passwordText = if ($env:POLYSONG_SIGN_CERT_PASSWORD) { $env:POLYSONG_SIGN_CERT_PASSWORD } else { '' }
  $password = ConvertTo-SecureString $passwordText -AsPlainText -Force
  $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 `
    -ArgumentList @($env:POLYSONG_SIGN_CERT_PATH, $password)
} elseif ($env:POLYSONG_SIGN_CERT_THUMBPRINT) {
  $thumbprint = $env:POLYSONG_SIGN_CERT_THUMBPRINT.Replace(' ', '').ToUpperInvariant()
  $cert = Get-ChildItem Cert:\CurrentUser\My, Cert:\LocalMachine\My |
    Where-Object { $_.Thumbprint -and $_.Thumbprint.Replace(' ', '').ToUpperInvariant() -eq $thumbprint } |
    Select-Object -First 1
  if (-not $cert) {
    throw 'Signing certificate thumbprint was not found in CurrentUser or LocalMachine certificate stores.'
  }
} else {
  Write-Host 'Code signing skipped: no signing certificate was configured.'
  Write-Host 'Set POLYSONG_SIGN_CERT_PATH + POLYSONG_SIGN_CERT_PASSWORD or POLYSONG_SIGN_CERT_THUMBPRINT to sign the installer.'
  Write-Host 'A trusted code-signing certificate is required to reduce Windows SmartScreen warnings.'
  exit 0
}

$signature = Set-AuthenticodeSignature `
  -FilePath $installer `
  -Certificate $cert `
  -TimestampServer 'http://timestamp.digicert.com' `
  -HashAlgorithm SHA256

if ($signature.Status -ne 'Valid') {
  throw "Code signing failed: $($signature.StatusMessage)"
}

Write-Host "Signed installer: $installer"
