$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$localSdk = Join-Path $env:USERPROFILE 'Tools\dotnet'
if (Test-Path (Join-Path $localSdk 'dotnet.exe')) {
    $env:PATH = $localSdk + ';' + $env:PATH
    $env:DOTNET_ROOT = $localSdk
}
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
Push-Location (Join-Path $projectRoot 'services\agent')
try {
    & '.\.venv\Scripts\python.exe' -m uvicorn pocketpilot_agent.main:app --host 0.0.0.0 --port 8000
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
