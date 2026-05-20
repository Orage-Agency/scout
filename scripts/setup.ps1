# Scout one-command setup
# Usage: powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
# Or via: pnpm setup

$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "`n$msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "  OK  $msg" -ForegroundColor Green }
function Write-Fail($msg) { Write-Host "  FAIL $msg" -ForegroundColor Red }
function Ask($prompt, $secret = $false) {
  if ($secret) { Read-Host "$prompt" -AsSecureString | ForEach-Object { [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($_)) } }
  else         { Read-Host "$prompt" }
}

Write-Host ""
Write-Host "  SCOUT SETUP" -ForegroundColor Yellow
Write-Host "  ──────────────────────────────────────" -ForegroundColor DarkGray

# ── 1. Prerequisites ──────────────────────────────────────────────────────────
Write-Step "Checking prerequisites…"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Fail "Node.js not found. Install from https://nodejs.org and re-run."
  exit 1
}
Write-OK "Node.js $(node --version)"

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Host "  Installing pnpm…" -ForegroundColor DarkGray
  npm install -g pnpm | Out-Null
}
Write-OK "pnpm $(pnpm --version)"

if (-not (Get-Command supabase -ErrorAction SilentlyContinue)) {
  Write-Host "  Installing Supabase CLI…" -ForegroundColor DarkGray
  npm install -g supabase | Out-Null
}
Write-OK "Supabase CLI $(supabase --version 2>&1 | Select-String '\d+\.\d+' | ForEach-Object { $_.Matches[0].Value })"

# ── 2. Credentials ────────────────────────────────────────────────────────────
Write-Step "Supabase credentials"
Write-Host "  Find these at supabase.com/dashboard → your project → Settings → API" -ForegroundColor DarkGray

$supabaseUrl     = Ask "  Supabase URL (https://xxxx.supabase.co)"
$supabaseAnonKey = Ask "  Anon key"
$projectRef      = $supabaseUrl -replace "https://(.+)\.supabase\.co.*", '$1'

if (-not $supabaseUrl -or -not $supabaseAnonKey) {
  Write-Fail "Both fields are required."
  exit 1
}

# ── 3. Write .env ─────────────────────────────────────────────────────────────
Write-Step "Writing .env…"
$env_content = @"
SUPABASE_URL=$supabaseUrl
SUPABASE_ANON_KEY=$supabaseAnonKey
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_DB_PASSWORD=
SUPABASE_PROJECT_REF=$projectRef

OPENROUTER_API_KEY=

VITE_SUPABASE_URL=$supabaseUrl
VITE_SUPABASE_ANON_KEY=$supabaseAnonKey
"@
$env_content | Out-File -FilePath ".env" -Encoding utf8 -NoNewline
Write-OK ".env written"

# ── 4. Install dependencies ───────────────────────────────────────────────────
Write-Step "Installing dependencies…"
pnpm install --silent
Write-OK "Dependencies installed"

# ── 5. Build extension ────────────────────────────────────────────────────────
Write-Step "Building extension…"
pnpm build --silent
Write-OK "Extension built"

# ── 6. Apply database migrations ──────────────────────────────────────────────
Write-Step "Applying database migrations…"
Write-Host "  You need a Supabase access token to push migrations." -ForegroundColor DarkGray
Write-Host "  Generate one at: supabase.com/dashboard/account/tokens" -ForegroundColor DarkGray
$token = Ask "  Access token (press Enter to skip)"

if ($token) {
  $env:SUPABASE_ACCESS_TOKEN = $token
  supabase link --project-ref $projectRef 2>&1 | Out-Null
  supabase db push 2>&1
  Write-OK "Migrations applied"

  # ── 7. Deploy edge functions ───────────────────────────────────────────────
  Write-Step "Deploying edge functions…"
  powershell -ExecutionPolicy Bypass -File "scripts\deploy-edge-functions.ps1"
  Write-OK "Edge functions deployed"
} else {
  Write-Host "  Skipped. Run later: " -NoNewline -ForegroundColor DarkGray
  Write-Host "pnpm db:push && pnpm functions:deploy" -ForegroundColor Yellow
}

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ALL DONE" -ForegroundColor Green
Write-Host "  ──────────────────────────────────────" -ForegroundColor DarkGray
Write-Host "  1. Open Chrome → chrome://extensions" -ForegroundColor White
Write-Host "  2. Enable Developer mode (top right)" -ForegroundColor White
Write-Host "  3. Click 'Load unpacked' → select this folder:" -ForegroundColor White
Write-Host "     $PSScriptRoot\.." -ForegroundColor Yellow
Write-Host ""
