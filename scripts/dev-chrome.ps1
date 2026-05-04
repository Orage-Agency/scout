# Launch a dedicated Chrome instance with the Scout extension preloaded.
# Uses an isolated user-data-dir so it doesn't fight with your main Chrome.
# First run: sign into Gmail / your CRM / wherever you want to test.
# The profile persists across runs so you stay signed in.

$Chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$ExtDir = "C:\Users\georg\scout\apps\extension\dist"
$Profile = "C:\Users\georg\scout-chrome-profile"

if (-not (Test-Path $Chrome)) { throw "Chrome not found at $Chrome" }
if (-not (Test-Path "$ExtDir\manifest.json")) { throw "Extension dist not built. Run 'pnpm build' first." }

Start-Process $Chrome -ArgumentList @(
  "--user-data-dir=$Profile",
  "--load-extension=$ExtDir",
  "--no-first-run",
  "--no-default-browser-check",
  "https://www.google.com"
)
