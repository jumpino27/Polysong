$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $projectDir '.dev'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$backendLog = Join-Path $logDir 'backend.log'
$backendErr = Join-Path $logDir 'backend.err.log'

$backend = Start-Process -FilePath 'cargo.exe' `
  -ArgumentList @('run', '--package', 'polysong-app', '--', '--backend-server') `
  -WorkingDirectory $projectDir `
  -RedirectStandardOutput $backendLog `
  -RedirectStandardError $backendErr `
  -WindowStyle Hidden `
  -PassThru

try {
  Start-Sleep -Seconds 2
  pnpm -C frontend dev
}
finally {
  if ($backend -and -not $backend.HasExited) {
    Stop-Process -Id $backend.Id -Force
  }
}
