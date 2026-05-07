$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not $env:PROJECT_DIR) {
  throw 'PROJECT_DIR is not set.'
}
if (-not $env:INSTALLER_TOOLS_DIR) {
  throw 'INSTALLER_TOOLS_DIR is not set.'
}

$tools = $env:INSTALLER_TOOLS_DIR
$cache = Join-Path $env:PROJECT_DIR '.dev\installer-cache'
New-Item -ItemType Directory -Force -Path $tools, $cache | Out-Null

$ytDlp = Join-Path $tools 'yt-dlp.exe'
if (-not (Test-Path -LiteralPath $ytDlp)) {
  Write-Host 'Downloading yt-dlp.exe...'
  Invoke-WebRequest `
    -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' `
    -OutFile $ytDlp
}

$ffmpeg = Join-Path $tools 'ffmpeg.exe'
$ffprobe = Join-Path $tools 'ffprobe.exe'
if (-not ((Test-Path -LiteralPath $ffmpeg) -and (Test-Path -LiteralPath $ffprobe))) {
  Write-Host 'Downloading FFmpeg LGPL build...'
  $zip = Join-Path $cache 'ffmpeg-master-latest-win64-lgpl.zip'
  $extract = Join-Path $cache 'ffmpeg'

  if (Test-Path -LiteralPath $extract) {
    Remove-Item -LiteralPath $extract -Recurse -Force
  }

  Invoke-WebRequest `
    -Uri 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip' `
    -OutFile $zip
  Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force

  $ffmpegSource = Get-ChildItem -LiteralPath $extract -Recurse -Filter ffmpeg.exe | Select-Object -First 1
  $ffprobeSource = Get-ChildItem -LiteralPath $extract -Recurse -Filter ffprobe.exe | Select-Object -First 1
  if (-not $ffmpegSource -or -not $ffprobeSource) {
    throw 'FFmpeg archive did not contain ffmpeg.exe and ffprobe.exe.'
  }

  Copy-Item -LiteralPath $ffmpegSource.FullName -Destination $ffmpeg -Force
  Copy-Item -LiteralPath $ffprobeSource.FullName -Destination $ffprobe -Force
}

foreach ($file in @($ytDlp, $ffmpeg, $ffprobe)) {
  if (-not (Test-Path -LiteralPath $file)) {
    throw "Missing helper tool: $file"
  }
}

Write-Host 'Bundled helper tools are ready.'
