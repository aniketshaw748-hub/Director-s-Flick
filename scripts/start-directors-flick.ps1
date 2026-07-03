<#
.SYNOPSIS
  One-shot launcher for Director's Flick (T-67).

.DESCRIPTION
  From a cold clone (node + ffmpeg installed):
    1. Verifies node and ffmpeg are on PATH.
    2. Installs app/ and ui/ dependencies when node_modules is missing.
    3. Rebuilds the ui when dist/ is missing or older than the newest source.
    4. Starts the backend (which also serves the built ui) and opens the
       default browser at the app.
  The server itself prints a friendly message and exits if the port is
  already in use.

.EXAMPLE
  powershell -File scripts\start-directors-flick.ps1
  powershell -File scripts\start-directors-flick.ps1 -Port 4100 -NoBrowser
#>
param(
    [int]$Port = 4000,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

function Fail($msg) {
    Write-Host $msg -ForegroundColor Red
    exit 1
}

# 1. prerequisites
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail "node is not on PATH. Install Node.js 22+ from https://nodejs.org and re-run."
}
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Fail "ffmpeg is not on PATH. Install ffmpeg (with NVENC support for GPU export) and re-run."
}
Write-Host "OK  node $(node --version), ffmpeg present"

# Python is only needed for the ALIGN step (script-to-voiceover timing via
# stable-ts); serving and reviewing work without it, so warn - don't fail.
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) {
    Write-Host "NOTE python is not on PATH - creating/aligning projects will fail until it is installed (Python 3.12 + 'pip install stable-ts'). Reviewing/exporting existing projects works fine." -ForegroundColor Yellow
} else {
    $hasStableTs = $false
    try { python -c "import stable_whisper" 2>$null; $hasStableTs = ($LASTEXITCODE -eq 0) } catch {}
    if ($hasStableTs) {
        Write-Host "OK  python + stable-ts present (align ready)"
    } else {
        Write-Host "NOTE python found but stable-ts is missing - run 'pip install stable-ts' before aligning new projects." -ForegroundColor Yellow
    }
}

# 2. dependencies
foreach ($pkg in @('app', 'ui')) {
    if (-not (Test-Path (Join-Path $root "$pkg\node_modules"))) {
        Write-Host "... installing $pkg dependencies - the first run can take a few minutes on a cold npm cache; deprecation warnings are normal"
        Push-Location (Join-Path $root $pkg)
        npm install --no-audit --no-fund --loglevel=error
        if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "npm install failed in $pkg/" }
        Pop-Location
    }
}
Write-Host "OK  dependencies present"

# 3. ui build freshness
$dist = Join-Path $root 'ui\dist\index.html'
$needBuild = -not (Test-Path $dist)
if (-not $needBuild) {
    $distTime = (Get-Item $dist).LastWriteTimeUtc
    $newestSrc = Get-ChildItem (Join-Path $root 'ui\src') -Recurse -File |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if ($newestSrc -and $newestSrc.LastWriteTimeUtc -gt $distTime) { $needBuild = $true }
}
if ($needBuild) {
    Write-Host "... building ui (dist missing or stale)"
    Push-Location (Join-Path $root 'ui')
    npm run build
    if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "ui build failed" }
    Pop-Location
} else {
    Write-Host "OK  ui build is fresh"
}

# 4. start server (serves API + built ui) and open the browser
Write-Host "... starting Director's Flick on http://localhost:$Port"
if (-not $NoBrowser) {
    # give the server a moment, then open the app
    Start-Job -ScriptBlock {
        param($u)
        Start-Sleep -Seconds 2
        Start-Process $u
    } -ArgumentList "http://localhost:$Port" | Out-Null
}
Push-Location (Join-Path $root 'app')
npm run cli -- serve --port $Port
Pop-Location
