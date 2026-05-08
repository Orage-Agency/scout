# deploy-edge-functions.ps1 — redeploy all Scout edge functions.
#
# Prerequisites:
#   1. Generate a new PAT at https://supabase.com/dashboard/account/tokens
#   2. Run:  $env:SUPABASE_ACCESS_TOKEN = "<your_new_pat>"
#   3. Then: powershell -ExecutionPolicy Bypass -File scripts\deploy-edge-functions.ps1
#
# All three functions are deployed sequentially. The script exits on first failure.
param(
  [string]$ProjectRef = "wmicxsafqbixedpjhchc"
)

$SupabaseBin = Join-Path $PSScriptRoot "..\node_modules\supabase\bin\supabase.exe"
if (-not (Test-Path $SupabaseBin)) {
  Write-Error "supabase binary not found at $SupabaseBin. Run 'pnpm install' first."
  exit 1
}

if (-not $env:SUPABASE_ACCESS_TOKEN) {
  Write-Error "SUPABASE_ACCESS_TOKEN is not set. Generate a PAT at https://supabase.com/dashboard/account/tokens"
  exit 1
}

$Functions = @("coach", "transcribe", "generate-skill")

foreach ($fn in $Functions) {
  Write-Host "`nDeploying $fn..." -ForegroundColor Cyan
  & $SupabaseBin functions deploy $fn --project-ref $ProjectRef --use-api
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Deploy failed for $fn (exit $LASTEXITCODE)"
    exit $LASTEXITCODE
  }
  Write-Host "  $fn deployed." -ForegroundColor Green
}

Write-Host "`nAll edge functions deployed successfully." -ForegroundColor Green
Write-Host "Dashboard: https://supabase.com/dashboard/project/$ProjectRef/functions"
