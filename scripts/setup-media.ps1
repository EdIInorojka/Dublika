$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$binaryDirectory = Join-Path $projectRoot '.local-bin'
$binaryPath = Join-Path $binaryDirectory 'yt-dlp.exe'
$downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.exe'

New-Item -ItemType Directory -Force -Path $binaryDirectory | Out-Null
if (-not (Test-Path -LiteralPath $binaryPath)) {
  Write-Host 'Downloading the official YouTube/VK import module...'
  Invoke-WebRequest -Uri $downloadUrl -OutFile $binaryPath
}

& $binaryPath --version
Write-Host 'Media modules are ready.'
