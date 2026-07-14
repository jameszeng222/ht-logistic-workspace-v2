# HT Logistic Workspace - All-in-one installer build script (Windows PowerShell)
#
# Usage:
#   cd ht-logistic-workspace-v2
#   .\scripts\build-installer.ps1
#
# Output (users just double-click to install, no Node.js/Python/Rust needed):
#   tauri-app\src-tauri\target\release\bundle\nsis\HT Logistic Agent_0.1.0_x64-setup.exe
#
# Steps:
#   1. Build Python sidecar (PyInstaller -> ht-sidecar.exe)
#   2. Prepare pi-runtime (download portable Node.js + npm install pi + generate pi.cmd)
#   3. npm install + npm run tauri build (bundle sidecar + pi-runtime together)
#   4. Print output paths

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$sidecarDir = Join-Path $repoRoot "python-sidecar"
$tauriDir = Join-Path $repoRoot "tauri-app"
$piRuntimeDir = Join-Path $repoRoot "pi-runtime"

function Write-PiLauncher {
    param([Parameter(Mandatory = $true)][string]$RuntimeDir)

    $piCliJs = "node_modules\@earendil-works\pi-coding-agent\dist\cli.js"
    $piCliPath = Join-Path $RuntimeDir $piCliJs
    if (-not (Test-Path $piCliPath)) {
        throw "Pi CLI entry not found: $piCliPath"
    }

    $launcherLine = '"%PI_RUNTIME_DIR%node.exe" "%PI_RUNTIME_DIR%node_modules\@earendil-works\pi-coding-agent\dist\cli.js" %*'
    if ($launcherLine -match "[`r`n]") {
        throw "Internal error: pi.cmd launcher line contains a newline."
    }

    $piCmdContent = @(
        '@echo off',
        'setlocal',
        'set "PI_RUNTIME_DIR=%~dp0"',
        'set "PATH=%PI_RUNTIME_DIR%;%PATH%"',
        $launcherLine
    ) -join "`r`n"

    $piCmdPath = Join-Path $RuntimeDir "pi.cmd"
    [System.IO.File]::WriteAllText($piCmdPath, $piCmdContent + "`r`n", [System.Text.Encoding]::ASCII)
    Test-PiLauncher -RuntimeDir $RuntimeDir
}

function Test-PiLauncher {
    param([Parameter(Mandatory = $true)][string]$RuntimeDir)

    $piCmdPath = Join-Path $RuntimeDir "pi.cmd"
    $nodePath = Join-Path $RuntimeDir "node.exe"
    $piCliPath = Join-Path $RuntimeDir "node_modules\@earendil-works\pi-coding-agent\dist\cli.js"

    if (-not (Test-Path $piCmdPath)) { throw "pi.cmd missing: $piCmdPath" }
    if (-not (Test-Path $nodePath)) { throw "node.exe missing: $nodePath" }
    if (-not (Test-Path $piCliPath)) { throw "Pi CLI entry missing: $piCliPath" }

    $lines = [System.IO.File]::ReadAllLines($piCmdPath, [System.Text.Encoding]::ASCII)
    $expected = '"%PI_RUNTIME_DIR%node.exe" "%PI_RUNTIME_DIR%node_modules\@earendil-works\pi-coding-agent\dist\cli.js" %*'
    if ($lines.Count -lt 5 -or $lines[4] -ne $expected) {
        throw "pi.cmd launcher is invalid. Expected one command line: $expected"
    }
}

Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  HT Logistic Workspace Installer Build" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# ---------- 1. Build Python sidecar ----------
Write-Host "[1/4] Building Python sidecar..." -ForegroundColor Yellow
Push-Location $sidecarDir
try {
    if (-not (Test-Path ".venv")) {
        Write-Host "  Creating venv..." -ForegroundColor Gray
        python -m venv .venv
    }
    & .\.venv\Scripts\Activate.ps1
    pip install -r requirements.txt --quiet
    pip install pyinstaller --quiet
    Write-Host "  Running PyInstaller..." -ForegroundColor Gray
    # PyInstaller writes INFO logs to stderr, which PowerShell treats as errors
    # (NativeCommandError). Route stdout+stderr to a log file via cmd.exe so we
    # can check $LASTEXITCODE and inspect the log if it fails.
    $pyinstallerLog = Join-Path $env:TEMP "ht-pyinstaller.log"
    cmd /c "pyinstaller ht-sidecar.spec --noconfirm --clean > `"$pyinstallerLog`" 2>&1"
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path "dist\ht-sidecar.exe")) {
        Write-Host "  PyInstaller log:" -ForegroundColor Red
        if (Test-Path $pyinstallerLog) {
            Get-Content $pyinstallerLog -Tail 50 | ForEach-Object { Write-Host "    $_" -ForegroundColor Gray }
            Write-Host "  Full log: $pyinstallerLog" -ForegroundColor Gray
        }
        throw "PyInstaller failed (exit code $LASTEXITCODE). See log above."
    }
    Copy-Item "dist\ht-sidecar.exe" "ht-sidecar.exe" -Force
    Write-Host "  sidecar exe ready" -ForegroundColor Green
}
finally {
    Pop-Location
}

# ---------- 2. Prepare pi-runtime (portable Node + pi package) ----------
Write-Host ""
Write-Host "[2/4] Preparing pi-runtime (portable Node.js + pi package)..." -ForegroundColor Yellow

if (Test-Path $piRuntimeDir) {
    # Use robocopy mirror trick for long-path safety (Remove-Item fails on >260 chars)
    $emptyTemp = Join-Path $env:TEMP "ht-empty-dir-for-mirror"
    New-Item -ItemType Directory -Path $emptyTemp -Force | Out-Null
    robocopy $emptyTemp $piRuntimeDir /MIR /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
    Remove-Item $piRuntimeDir -Force -ErrorAction SilentlyContinue
    Remove-Item $emptyTemp -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Path $piRuntimeDir -Force | Out-Null

# 2a. Download portable Node.js (x64)
#     Use curl.exe (bundled on Windows 10+) for resume + auto retry,
#     more stable than Invoke-WebRequest (IWR often EOFs on flaky networks).
#     -L follow redirects, --retry auto retry, -C - resume, --connect-timeout timeout
$nodeVersion = "v22.20.0"
$nodeArch = "x64"
$nodeUrl = "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-win-$nodeArch.zip"
$nodeZip = Join-Path $env:TEMP "node-portable.zip"
$nodeExtractDir = Join-Path $env:TEMP "node-portable-extract"

Write-Host "  Downloading Node.js $nodeVersion (win-$nodeArch)..." -ForegroundColor Gray
if (Test-Path $nodeExtractDir) { Remove-Item $nodeExtractDir -Recurse -Force }

# Prefer curl.exe (most stable), fallback to Invoke-WebRequest
$curlExe = Get-Command curl.exe -ErrorAction SilentlyContinue
if ($curlExe) {
    Write-Host "    using curl.exe with retry + resume..." -ForegroundColor Gray
    & curl.exe -L --retry 5 --retry-delay 3 --retry-connrefused `
        --connect-timeout 30 --max-time 600 `
        -C - -o "$nodeZip" "$nodeUrl"
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $nodeZip)) {
        throw "curl download failed (exit $LASTEXITCODE). Manually download $nodeUrl to $nodeZip"
    }
} else {
    Write-Host "    curl.exe not found, falling back to Invoke-WebRequest..." -ForegroundColor Gray
    $downloaded = $false
    for ($i = 1; $i -le 3; $i++) {
        try {
            Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZip -UseBasicParsing -TimeoutSec 600
            $downloaded = $true
            break
        } catch {
            Write-Host "    IWR failed (attempt $i/3): $($_.Exception.Message)" -ForegroundColor Yellow
            if ($i -lt 3) { Start-Sleep -Seconds 3 }
        }
    }
    if (-not $downloaded) {
        throw "Node.js download failed (IWR retried 3 times). Manually download $nodeUrl to $nodeZip"
    }
}
Write-Host "    download complete" -ForegroundColor Gray

Expand-Archive -Path $nodeZip -DestinationPath $nodeExtractDir -Force
$nodeDir = Get-ChildItem -Path $nodeExtractDir -Directory | Select-Object -First 1
Copy-Item (Join-Path $nodeDir.FullName "node.exe") $piRuntimeDir -Force
Write-Host "  node.exe ready" -ForegroundColor Green

# 2b. Use portable node to run npm and install pi package
Write-Host "  Installing pi package into pi-runtime..." -ForegroundColor Gray
$npmCli = Join-Path $nodeDir.FullName "node_modules\npm\bin\npm-cli.js"
$pkgJson = @{ name = "pi-runtime"; version = "1.0.0"; private = $true } | ConvertTo-Json
Set-Content -Path (Join-Path $piRuntimeDir "package.json") -Value $pkgJson

Push-Location $piRuntimeDir
try {
    # npm writes progress/logs to stderr; route through cmd to a log file to
    # avoid NativeCommandError and surface diagnostics on failure.
    $npmLog = Join-Path $env:TEMP "ht-npm-install.log"
    $npmExe = Join-Path $piRuntimeDir "node.exe"
    cmd /c "`"$npmExe`" `"$npmCli`" install @earendil-works/pi-coding-agent --no-save --ignore-scripts > `"$npmLog`" 2>&1"
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path "node_modules\@earendil-works\pi-coding-agent")) {
        Write-Host "  npm install log:" -ForegroundColor Red
        if (Test-Path $npmLog) {
            Get-Content $npmLog -Tail 30 | ForEach-Object { Write-Host "    $_" -ForegroundColor Gray }
            Write-Host "  Full log: $npmLog" -ForegroundColor Gray
        }
        throw "pi package install failed (exit code $LASTEXITCODE). See log above."
    }
}
finally {
    Pop-Location
}
Write-Host "  pi package installed" -ForegroundColor Gray

# 2c. Generate pi.cmd launcher (calls portable node to run pi cli.js)
Write-PiLauncher -RuntimeDir $piRuntimeDir
Write-Host "  pi.cmd launcher generated and validated" -ForegroundColor Gray

# 2d. Clean up npm cache and non-runtime files to reduce size and avoid
#     NSIS path-too-long errors (aws-sdk .d.ts paths exceed Windows MAX_PATH).
#     Pi runs compiled .js via node.exe -- .d.ts/.ts/.map/test files are dead weight.
Remove-Item (Join-Path $piRuntimeDir "package.json") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $piRuntimeDir "package-lock.json") -Force -ErrorAction SilentlyContinue

# Non-runtime file extensions (TypeScript declarations, source maps, docs, etc.)
$junkExts = @("*.md","*.markdown","*.map","*.d.ts","*.ts","*.flow","*.coffee","*.tsbuildinfo","*.text","*.txt")
foreach ($ext in $junkExts) {
    Get-ChildItem $piRuntimeDir -Recurse -Include $ext -File -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
}

# Junk directories (tests, docs, type defs, npm bin scripts, IDE configs)
$junkDirs = @("__tests__","__mocks__","tests","test","docs","documentation",".github",".bin",".vscode",".idea","coverage","node_modules/.cache")
foreach ($sub in $junkDirs) {
    $p = Join-Path $piRuntimeDir $sub
    if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }
}

# Remove @types packages entirely (TypeScript type definitions, not used at runtime)
Get-ChildItem (Join-Path $piRuntimeDir "node_modules\@types") -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

$runtimeSize = [math]::Round((Get-ChildItem $piRuntimeDir -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
Write-Host "  pi-runtime ready (about ${runtimeSize} MB after cleanup)" -ForegroundColor Green

# 2e. Compress pi-runtime to src-tauri/pi-runtime.7z (single-file archive).
#     This avoids NSIS MAX_PATH 260-char limit: pi-runtime contains @mistralai's
#     deeply nested files with paths >260 chars that NSIS cannot package as
#     loose files. By compressing to a single 7z, NSIS sees only one file.
#     At runtime, main.rs extracts this 7z to %LOCALAPPDATA%\ht-logistic\pi-runtime\
#     on first launch (and on version change, tracked by archive size marker).
$tauriSrcDir = Join-Path $tauriDir "src-tauri"
$pi7zPath = Join-Path $tauriSrcDir "pi-runtime.7z"
$repoPiRuntimeDir = Join-Path $tauriSrcDir "pi-runtime"

# Find or download 7z executable (only needed at build time, NOT bundled in installer)
$sevenZip = $null
$cmd7z = Get-Command 7z -ErrorAction SilentlyContinue
if ($cmd7z) {
    $sevenZip = $cmd7z.Source
} elseif (Test-Path "C:\Program Files\7-Zip\7z.exe") {
    $sevenZip = "C:\Program Files\7-Zip\7z.exe"
} elseif (Test-Path "C:\Program Files (x86)\7-Zip\7z.exe") {
    $sevenZip = "C:\Program Files (x86)\7-Zip\7z.exe"
} else {
    # Download 7zr.exe (standalone console, ~500KB, only handles 7z format)
    Write-Host "  7-Zip not installed, downloading 7zr.exe (standalone)..." -ForegroundColor Gray
    $sevenZip = Join-Path $env:TEMP "7zr.exe"
    if (-not (Test-Path $sevenZip)) {
        & curl.exe -L --retry 5 --retry-delay 3 --retry-connrefused `
            --connect-timeout 30 --max-time 120 `
            -o "$sevenZip" "https://www.7-zip.org/a/7zr.exe"
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $sevenZip)) {
            throw "Failed to download 7zr.exe. Install 7-Zip from https://7-zip.org/ or download 7zr.exe manually to $sevenZip"
        }
    }
}
Write-Host "  using 7z: $sevenZip" -ForegroundColor Gray

# Clean old artifacts: remove old pi-runtime.7z and old pi-runtime/ dir (if any)
if (Test-Path $pi7zPath) { Remove-Item $pi7zPath -Force }
if (Test-Path $repoPiRuntimeDir) {
    Write-Host "  cleaning old pi-runtime dir (using robocopy for long-path safety)..." -ForegroundColor Gray
    $emptyTemp = Join-Path $env:TEMP "ht-empty-dir-for-mirror"
    New-Item -ItemType Directory -Path $emptyTemp -Force | Out-Null
    robocopy $emptyTemp $repoPiRuntimeDir /MIR /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
    Remove-Item $repoPiRuntimeDir -Force -ErrorAction SilentlyContinue
    Remove-Item $emptyTemp -Force -ErrorAction SilentlyContinue
}

# Compress pi-runtime to 7z archive.
# -t7z  : 7z format
# -mx=5 : medium compression (good balance of speed/size; sevenz-rust2 handles it)
# -ms=off: non-solid archive (faster random access, wider decoder compatibility)
# Run via cmd to avoid PowerShell NativeCommandError on 7z's stderr logging.
Write-Host "  Compressing pi-runtime to pi-runtime.7z (this may take a minute)..." -ForegroundColor Gray
$compressLog = Join-Path $env:TEMP "ht-7z-compress.log"
cmd /c "`"$sevenZip`" a -t7z -mx=5 -ms=off `"$pi7zPath`" `"$piRuntimeDir\*`" > `"$compressLog`" 2>&1"
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $pi7zPath)) {
    Write-Host "  7z compress log (last 20 lines):" -ForegroundColor Red
    if (Test-Path $compressLog) {
        Get-Content $compressLog -Tail 20 | ForEach-Object { Write-Host "    $_" -ForegroundColor Gray }
        Write-Host "  Full log: $compressLog" -ForegroundColor Gray
    }
    throw "7z compression failed (exit code $LASTEXITCODE). See log above."
}

$archiveSizeMB = [math]::Round((Get-Item $pi7zPath).Length / 1MB, 1)
Write-Host "  pi-runtime.7z created ($archiveSizeMB MB) at $pi7zPath" -ForegroundColor Green

# ---------- 3. Clean sidecar temp + build Tauri installer ----------
Write-Host ""
Write-Host "[3/4] Cleaning + building Tauri installer..." -ForegroundColor Yellow
$cleanupDirs = @("build", "dist", "__pycache__", ".pytest_cache")
foreach ($d in $cleanupDirs) {
    $p = Join-Path $sidecarDir $d
    if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }
}
Get-ChildItem $sidecarDir -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

# ---------- 3. Clean sidecar temp + build Tauri installer ----------
Write-Host ""
Write-Host "[3/4] Cleaning + building Tauri installer..." -ForegroundColor Yellow

# 3a. Verify updater signing key is configured (required to generate .sig artifacts)
#     NOTE: Tauri v2 official env var names are TAURI_SIGNING_PRIVATE_KEY and
#     TAURI_SIGNING_PRIVATE_KEY_PASSWORD (see v2.tauri.app/reference/environment-variables).
#     Writing TAURI_PRIVATE_KEY won't work, .sig won't be generated.
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    Write-Host ""
    Write-Host "WARNING: TAURI_SIGNING_PRIVATE_KEY environment variable not set." -ForegroundColor Red
    Write-Host "  Without the signing key, the updater .sig file won't be generated," -ForegroundColor Yellow
    Write-Host "  and auto-update will fail signature verification." -ForegroundColor Yellow
    Write-Host "  Generate a key pair with:" -ForegroundColor Yellow
    Write-Host "    npm run tauri signer generate -- -w `$HOME/.tauri/ht-logistic.key" -ForegroundColor Gray
    Write-Host "  Then set before running this script:" -ForegroundColor Yellow
    Write-Host "    `$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content `$HOME/.tauri/ht-logistic.key -Raw" -ForegroundColor Gray
    Write-Host "    `$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = 'your-password-if-set'" -ForegroundColor Gray
    Write-Host "  Continuing build WITHOUT updater signature (auto-update disabled)..." -ForegroundColor Yellow
    Write-Host ""
}

$cleanupDirs = @("build", "dist", "__pycache__", ".pytest_cache")
foreach ($d in $cleanupDirs) {
    $p = Join-Path $sidecarDir $d
    if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }
}
Get-ChildItem $sidecarDir -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

Push-Location $tauriDir
try {
    npm install --silent

    # 3a-pre. Clear stale NSIS bundle artifacts before building.
    # Tauri's incremental build reuses any existing *-setup.exe in the bundle/nsis
    # dir if it thinks nothing changed. When version is bumped in tauri.conf.json,
    # Tauri DOES regenerate, but an OLD setup.exe with the previous version number
    # can linger in the dir. The 4e ASSERT in build-and-release.ps1 then picks up
    # that stale file (Get-ChildItem *-setup.exe | Select -First 1) and fails with
    # "url does not contain current version setup.exe filename".
    # Fix: wipe the nsis bundle dir before each build so only fresh artifacts remain.
    $nsisBundleDir = Join-Path $tauriDir "src-tauri\target\release\bundle\nsis"
    if (Test-Path $nsisBundleDir) {
        Write-Host "  cleaning stale NSIS bundle dir..." -ForegroundColor Gray
        Remove-Item $nsisBundleDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    npm run tauri build
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }
}
finally {
    Pop-Location
}

# 3b. Clean up src-tauri/pi-runtime -- it's now embedded in the NSIS installer,
#     no longer needed on disk. Removing it keeps the repo clean and avoids
#     accidental commits of this large directory.
#     Use robocopy mirror trick for long-path safety.
if (Test-Path $repoPiRuntimeDir) {
    $emptyTemp = Join-Path $env:TEMP "ht-empty-dir-for-mirror"
    New-Item -ItemType Directory -Path $emptyTemp -Force | Out-Null
    robocopy $emptyTemp $repoPiRuntimeDir /MIR /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
    Remove-Item $repoPiRuntimeDir -Force -ErrorAction SilentlyContinue
    Remove-Item $emptyTemp -Force -ErrorAction SilentlyContinue
}

# ---------- 4. Generate latest.json + print upload checklist ----------
Write-Host ""
Write-Host "[4/4] Build complete! Generating updater manifest..." -ForegroundColor Green
$bundleDir = Join-Path $tauriDir "src-tauri\target\release\bundle\nsis"

# Locate the NSIS setup .exe (filename includes version + arch, e.g. "HT Logistic Agent_0.1.0_x64-setup.exe")
$setupExe = Get-ChildItem (Join-Path $bundleDir "*-setup.exe") -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $setupExe) {
    throw "NSIS setup .exe not found in $bundleDir"
}
$setupSig = "$($setupExe.FullName).sig"

# Read app version from tauri.conf.json
$tauriConfPath = Join-Path $tauriDir "src-tauri\tauri.conf.json"
$tauriConf = Get-Content $tauriConfPath -Raw | ConvertFrom-Json
$appVersion = $tauriConf.version

# GitHub Release asset URL pattern: releases/latest/download/<filename>
# The tag is set by the user when creating the release; the "latest" alias resolves to the most recent.
# IMPORTANT: filename contains spaces (e.g. "HT Logistic Agent_0.1.3_x64-setup.exe"),
# must URL-encode it to %20 or GitHub returns 404 on the download URL.
$repoOwner = "jameszeng222"
$repoName = "ht-logistic-workspace-v2"
$encodedName = [uri]::EscapeDataString($setupExe.Name)
$setupUrl = "https://github.com/$repoOwner/$repoName/releases/latest/download/$encodedName"

# Read signature content (single-line base64 + header)
$signature = ""
if (Test-Path $setupSig) {
    $signature = (Get-Content $setupSig -Raw).Trim()
} else {
    Write-Host "  WARNING: .sig file not found at $setupSig" -ForegroundColor Yellow
    Write-Host "  Auto-update will not work. Did you set TAURI_SIGNING_PRIVATE_KEY?" -ForegroundColor Yellow
}

# Build the updater manifest consumed by the client's check() call.
# Field names are dictated by the Tauri updater protocol:
#   version:  new version string
#   notes:    release notes (shown in the UI)
#   pub_date: ISO 8601 timestamp
#   platforms: per-target signature + download URL
#   "windows-x86_64" is the target key Tauri uses on x64 Windows.
$releaseNotes = "HT Logistic Agent v$appVersion. See GitHub Release for details."
$latestJson = @{
    version = $appVersion
    notes = $releaseNotes
    pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    platforms = @{
        "windows-x86_64" = @{
            signature = $signature
            url = $setupUrl
        }
    }
} | ConvertTo-Json -Depth 5

$latestJsonPath = Join-Path $bundleDir "latest.json"
# Use .NET API to write UTF-8 without BOM (PowerShell 5.x Set-Content -Encoding UTF8
# adds BOM, Tauri updater uses serde_json which rejects UTF-8 BOM, causing
# "error decoding response body". Must use UTF8Encoding($false) to explicitly disable BOM.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($latestJsonPath, $latestJson, $utf8NoBom)

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  Build artifacts ready" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Upload these 3 files to a new GitHub Release:" -ForegroundColor Yellow
Write-Host ""
$filesToUpload = @($setupExe.FullName, $setupSig, $latestJsonPath)
foreach ($f in $filesToUpload) {
    if (Test-Path $f) {
        $size = [math]::Round((Get-Item $f).Length / 1MB, 1)
        Write-Host "  $f  (${size} MB)" -ForegroundColor White
    } else {
        Write-Host "  $f  (MISSING!)" -ForegroundColor Red
    }
}
Write-Host ""
Write-Host "Release steps:" -ForegroundColor Cyan
Write-Host "  1. Tag: v$appVersion  (must match version in tauri.conf.json)" -ForegroundColor Gray
Write-Host "  2. Title: HT Logistic Agent v$appVersion" -ForegroundColor Gray
Write-Host "  3. Attach the 3 files above" -ForegroundColor Gray
Write-Host "  4. Publish release" -ForegroundColor Gray
Write-Host ""
Write-Host "Client endpoint (already configured in tauri.conf.json):" -ForegroundColor Cyan
Write-Host "  https://github.com/$repoOwner/$repoName/releases/latest/download/latest.json" -ForegroundColor Gray
Write-Host ""
Write-Host "Users: just double-click the .exe to install. No Node.js/Python/Rust needed." -ForegroundColor Green
