param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

$ErrorActionPreference = "Stop"
$root = (Get-Location).Path
$runtime = Join-Path $root "tools\klevar-yolo-runtime"
$distCli = Join-Path $runtime "dist\cli.js"

if (-not (Test-Path $runtime)) {
  throw "Klevar YOLO runtime not found at tools\klevar-yolo-runtime. Sync this project with the latest template first."
}

Push-Location $runtime
try {
  if (-not (Test-Path "node_modules")) {
    Write-Host "Installing Klevar YOLO runtime dependencies..." -ForegroundColor Cyan
    npm ci
  }

  if (-not (Test-Path $distCli)) {
    Write-Host "Building Klevar YOLO runtime..." -ForegroundColor Cyan
    npm run build
  }
}
finally {
  Pop-Location
}

node $distCli @Args
