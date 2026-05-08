# Builds the extension then launches a dedicated browser window with Scout
# preloaded. Uses a separate profile so it never touches your main browser.
# Profile lives at %LOCALAPPDATA%\Scout\Profile.
#
# Usage:  pnpm launch   (from the repo root)
#    or:  double-click scripts\start-scout.cmd

$ErrorActionPreference = 'Stop'

$repo     = Split-Path -Parent $PSScriptRoot
$extDir   = Join-Path $repo 'apps\extension\dist'
$profileDir = Join-Path $env:LOCALAPPDATA 'Scout\Profile'

# ---- Build ----------------------------------------------------------------
Write-Host "Building Scout extension..." -ForegroundColor Cyan
Push-Location $repo
pnpm build
if ($LASTEXITCODE -ne 0) { Write-Error "Build failed — not launching."; exit 1 }
Pop-Location
Write-Host "Build complete." -ForegroundColor Green

# ---- Find browser (Brave first, then Chrome) ------------------------------
$browserPaths = @(
  "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe",
  "${env:ProgramFiles(x86)}\BraveSoftware\Brave-Browser\Application\brave.exe",
  "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$browser = $browserPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) {
  Write-Error "Neither Brave nor Chrome found. Edit $PSCommandPath to point at your browser."
}

# ---- Launch ---------------------------------------------------------------
if (-not (Test-Path $profileDir)) {
  New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
}

$launchArgs = @(
  "--user-data-dir=$profileDir",
  "--load-extension=$extDir",
  '--no-first-run',
  '--no-default-browser-check',
  '--new-window',
  'chrome://extensions/'
)

$browserName = Split-Path $browser -Leaf
Write-Host "Launching $browserName with Scout" -ForegroundColor Cyan
Write-Host "  extension: $extDir"
Write-Host "  profile:   $profileDir"
Start-Process -FilePath $browser -ArgumentList $launchArgs
