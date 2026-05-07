$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $projectDir '.dev'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$backendLog = Join-Path $logDir 'backend.log'
$backendErr = Join-Path $logDir 'backend.err.log'
$backendPort = 4777
$backendExe = Join-Path $projectDir 'target\debug\polysong-app.exe'
$resolvedBackendExe = (Resolve-Path -LiteralPath $backendExe -ErrorAction SilentlyContinue).Path

Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $backendPort -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object {
    $process = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
    if ($process) {
      $resolvedProcessPath = if ($process.Path) { (Resolve-Path -LiteralPath $process.Path -ErrorAction SilentlyContinue).Path } else { $null }
      if ($resolvedBackendExe -and $resolvedProcessPath -eq $resolvedBackendExe) {
        Stop-Process -Id $process.Id -Force
      } else {
        throw "Port $backendPort is already in use by PID $($process.Id) ($($process.ProcessName)). Stop that process before starting Polysong."
      }
    }
  }

Set-Content -LiteralPath $backendLog -Value '' -Encoding UTF8
Set-Content -LiteralPath $backendErr -Value '' -Encoding UTF8

$backend = Start-Process -FilePath 'cargo.exe' `
  -ArgumentList @('run', '--package', 'polysong-app', '--', '--backend-server') `
  -WorkingDirectory $projectDir `
  -RedirectStandardOutput $backendLog `
  -RedirectStandardError $backendErr `
  -WindowStyle Hidden `
  -PassThru

try {
  Start-Sleep -Seconds 2
  if ($backend.HasExited) {
    $stderr = if (Test-Path $backendErr) { Get-Content -Raw $backendErr } else { '' }
    throw "Polysong backend failed to start.`n$stderr"
  }
  pnpm -C frontend dev
}
finally {
  if ($backend -and -not $backend.HasExited) {
    Stop-Process -Id $backend.Id -Force
  }
}
