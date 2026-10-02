$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir

if (-not (Test-Path (Join-Path $ProjectRoot 'dist/bin/jmc.mjs'))) {
  Write-Host '[INFO] Building JMC from source'
  Push-Location $ProjectRoot
  try { npm run build } finally { Pop-Location }
}

$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node) {
  Write-Error 'Node.js 20 or newer is required to install JMC'
  exit 1
}

Push-Location $ProjectRoot
try {
  node (Join-Path $ScriptDir 'install.mjs')
} finally {
  Pop-Location
}