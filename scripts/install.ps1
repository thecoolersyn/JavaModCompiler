$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$Bundle = Join-Path $ScriptDir 'bin/jmc.mjs'
$Installer = Join-Path $ScriptDir 'bin/install.mjs'
if (-not (Test-Path $Bundle)) {
  $Bundle = Join-Path $ScriptDir '../dist/bin/jmc.mjs'
  $Installer = Join-Path $ScriptDir '../scripts/install.mjs'
}

if (-not (Test-Path $Bundle)) {
  Write-Error "[FAILED] JMC bundle not found next to $ScriptDir"
  exit 1
}
if (-not (Test-Path $Installer)) {
  Write-Error '[FAILED] install.mjs not found next to the JMC bundle'
  exit 1
}

$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node) {
  Write-Error 'Node.js 22 or newer is required to install JMC'
  exit 1
}

node $Installer @args
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
exit 0
