$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$venvDirectory = Join-Path $projectRoot '.local-bin\demucs-venv'
$venvPython = Join-Path $venvDirectory 'Scripts\python.exe'
$bundledPython = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'

if (-not (Test-Path -LiteralPath $venvPython)) {
  if (Test-Path -LiteralPath $bundledPython) {
    $python = $bundledPython
  } else {
    $python = (Get-Command python -ErrorAction Stop).Source
  }
  Write-Host 'Creating isolated Demucs runtime...'
  & $python -m venv $venvDirectory
}

Write-Host 'Installing local CPU source-separation dependencies...'
& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install torch --index-url https://download.pytorch.org/whl/cpu
& $venvPython -m pip install demucs numpy
& $venvPython -m demucs.separate --help | Select-Object -First 1

Write-Host 'Demucs is ready. Its model downloads once on the first render and remains local.'
