$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = Join-Path $env:USERPROFILE ".config\opencode"
$pluginSource = Join-Path $root "plugins\limit-fallback"
$pluginTarget = Join-Path $config "plugins\limit-fallback"

Write-Host "Local Fallback installer" -ForegroundColor Cyan
Write-Host "Config: $config"

New-Item -ItemType Directory -Force -Path (Split-Path $pluginTarget) | Out-Null
if (Test-Path $pluginTarget) {
  Remove-Item $pluginTarget -Recurse -Force
}
Copy-Item $pluginSource $pluginTarget -Recurse -Force
Write-Host "Plugin copied to $pluginTarget" -ForegroundColor Green

$configFile = Join-Path $config "opencode.json"
if (-not (Test-Path $configFile)) {
  Copy-Item (Join-Path $root "opencode.example.json") $configFile -Force
  Write-Host "Created $configFile" -ForegroundColor Green
} else {
  Write-Host ""
  Write-Host "opencode.json already exists. Add this provider block manually:" -ForegroundColor Yellow
  Write-Host ""
  Get-Content (Join-Path $root "opencode.example.json") -Raw | Write-Host
}

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Start your local server (LM Studio / Ollama) with a code model."
Write-Host "  2. Open http://127.0.0.1:1236/ and set the server URL and model name."
Write-Host "  3. In OpenCode run /local (or use the Ctrl+P command palette)."
