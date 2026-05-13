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

$ytDlpUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
$ffmpegUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip'
$manifestPath = Join-Path $tools 'installer-tools.manifest.json'

function Get-RemoteAssetId {
  param([Parameter(Mandatory = $true)][string]$Uri)

  try {
    $response = Invoke-WebRequest -Uri $Uri -Method Head -MaximumRedirection 5 -UseBasicParsing
    $etag = $response.Headers['ETag']
    $lastModified = $response.Headers['Last-Modified']
    $length = $response.Headers['Content-Length']
    $finalUri = if ($response.BaseResponse -and $response.BaseResponse.ResponseUri) {
      $response.BaseResponse.ResponseUri.AbsoluteUri
    } else {
      $Uri
    }
    return (@($finalUri, $etag, $lastModified, $length) | Where-Object { $_ }) -join '|'
  } catch {
    Write-Host "Could not check remote helper metadata for $Uri; using local copy if present."
    return $null
  }
}

$ytDlpAssetId = Get-RemoteAssetId -Uri $ytDlpUrl
$ffmpegAssetId = Get-RemoteAssetId -Uri $ffmpegUrl
$manifest = [ordered]@{
  schema = 1
  tools = [ordered]@{
    ytDlp = [ordered]@{
      file = 'yt-dlp.exe'
      url = $ytDlpUrl
      assetId = $ytDlpAssetId
    }
    ffmpeg = [ordered]@{
      files = @('ffmpeg.exe', 'ffprobe.exe')
      url = $ffmpegUrl
      assetId = $ffmpegAssetId
    }
  }
}
$manifestJson = $manifest | ConvertTo-Json -Depth 5
$existingManifestJson = if (Test-Path -LiteralPath $manifestPath) {
  Get-Content -Raw -LiteralPath $manifestPath
} else {
  ''
}
$refreshTools = $env:POLYSONG_REFRESH_INSTALLER_TOOLS -eq '1' -or $existingManifestJson.Trim() -ne $manifestJson.Trim()

if ($refreshTools) {
  Write-Host 'Installer tool recipe changed or refresh was requested; refreshing bundled helper tools.'
}

$ytDlp = Join-Path $tools 'yt-dlp.exe'
if ($refreshTools -or -not (Test-Path -LiteralPath $ytDlp)) {
  Write-Host 'Downloading yt-dlp.exe...'
  Invoke-WebRequest `
    -Uri $ytDlpUrl `
    -OutFile $ytDlp
}

$ffmpeg = Join-Path $tools 'ffmpeg.exe'
$ffprobe = Join-Path $tools 'ffprobe.exe'
if ($refreshTools -or -not ((Test-Path -LiteralPath $ffmpeg) -and (Test-Path -LiteralPath $ffprobe))) {
  Write-Host 'Downloading FFmpeg LGPL build...'
  $zip = Join-Path $cache 'ffmpeg-master-latest-win64-lgpl.zip'
  $extract = Join-Path $cache 'ffmpeg'

  if (Test-Path -LiteralPath $extract) {
    Remove-Item -LiteralPath $extract -Recurse -Force
  }

  Invoke-WebRequest `
    -Uri $ffmpegUrl `
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

$manifestJson | Set-Content -LiteralPath $manifestPath -Encoding ASCII

foreach ($file in @($ytDlp, $ffmpeg, $ffprobe)) {
  if (-not (Test-Path -LiteralPath $file)) {
    throw "Missing helper tool: $file"
  }
}

Write-Host 'Bundled helper tools are ready.'
