# Launches a dedicated Chrome window with the Scout extension preloaded.
# - Uses a separate profile so it doesn't touch your main Chrome (bookmarks,
#   logins, extensions). Profile lives at %LOCALAPPDATA%\Scout\Profile.
# - Reads the latest build from apps\extension\dist. Run `pnpm build` first
#   if you've changed the extension source.
#
# Re-run any time to reopen Scout. Closing the Chrome window keeps the
# profile state intact for next launch (auth session, library, etc.).

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$extDir = Join-Path $repo 'apps\extension\dist'
$profileDir = Join-Path $env:LOCALAPPDATA 'Scout\Profile'

if (-not (Test-Path $extDir)) {
  Write-Error "Extension build not found at $extDir. Run ``pnpm build`` from $repo first."
}

$chromePaths = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chrome = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) {
  Write-Error "Chrome not found. Install Chrome or edit this script to point at your browser."
}

if (-not (Test-Path $profileDir)) {
  New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
}

$args = @(
  "--user-data-dir=$profileDir",
  "--load-extension=$extDir",
  '--no-first-run',
  '--no-default-browser-check',
  '--new-window',
  'chrome://extensions/'
)

Write-Host "Launching Scout-enabled Chrome"
Write-Host "  extension: $extDir"
Write-Host "  profile:   $profileDir"
Start-Process -FilePath $chrome -ArgumentList $args
