# HT Logistic Workspace - Pi Extension installer
#
# Usage (in pi-extensions directory):
#   .\install.ps1
#
# This script will:
#   1. Locate ~/.pi/agent/extensions/ (create if missing)
#   2. Copy all-in-one.ts there (overwrite)
#   3. Ensure package.json exists in target dir (npm init -y if missing)
#   4. Install deps IN the target dir
#      (Pi loads extension from ~/.pi/agent/extensions/, so node_modules
#       must live there, not in the source repo)
#      - pdf-parse: pure JS, required
#      - better-sqlite3: native, optional (non-fatal if build tools absent)
#   5. Deploy pi-agent-config (SYSTEM.md + skills/) to ~/.pi/agent/
#      (SYSTEM.md defines permission tiers; skills/ define per-domain workflows)
#   6. Print verification steps
#
# Why a dedicated installer:
#   Pi 用 jiti 加载 ~/.pi/agent/extensions/all-in-one.ts，Node 模块查找从
#   扩展文件所在目录向上找 node_modules。若依赖装在源码仓库 pi-extensions/
#   下，Pi 加载时找不到，扩展会报 Cannot find module 'better-sqlite3'。
#   所以必须把依赖装到 ~/.pi/agent/extensions/ 本地。

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Pi Extension Installer (all-in-one)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ============ 0. Resolve source file ============
$srcFile = Join-Path $PSScriptRoot "all-in-one.ts"
if (-not (Test-Path $srcFile)) {
    Write-Host "ERROR: all-in-one.ts not found next to install.ps1 (looked: $srcFile)" -ForegroundColor Red
    Write-Host "Run this script from the pi-extensions directory." -ForegroundColor Red
    exit 1
}

# ============ 1. Resolve target dir ~/.pi/agent/extensions/ ============
$homeDir = $env:USERPROFILE
if (-not $homeDir) { $homeDir = $env:HOME }
if (-not $homeDir) {
    Write-Host "ERROR: cannot resolve user home (USERPROFILE/HOME unset)" -ForegroundColor Red
    exit 1
}
$piAgentDir = Join-Path $homeDir ".pi\agent"
$extDir = Join-Path $piAgentDir "extensions"

Write-Host "[1/6] Target dir: $extDir" -ForegroundColor Yellow
if (-not (Test-Path $extDir)) {
    New-Item -ItemType Directory -Path $extDir -Force | Out-Null
    Write-Host "OK: created (was missing — extension was never installed before)" -ForegroundColor Green
} else {
    Write-Host "OK: exists" -ForegroundColor Green
}

# ============ 2. Copy all-in-one.ts ============
Write-Host "[2/6] Copying all-in-one.ts ..." -ForegroundColor Yellow
Copy-Item -Path $srcFile -Destination (Join-Path $extDir "all-in-one.ts") -Force
Write-Host "OK: copied (overwrote existing)" -ForegroundColor Green

# ============ 3. Ensure package.json in target dir ============
Write-Host "[3/6] Ensuring package.json in target dir ..." -ForegroundColor Yellow
$pkgJson = Join-Path $extDir "package.json"
if (-not (Test-Path $pkgJson)) {
    Push-Location $extDir
    try {
        npm init -y
        if ($LASTEXITCODE -ne 0) {
            Write-Host "ERROR: npm init failed" -ForegroundColor Red
            exit 1
        }
    } finally { Pop-Location }
    Write-Host "OK: package.json created" -ForegroundColor Green
} else {
    Write-Host "OK: package.json already exists (kept)" -ForegroundColor Green
}

# ============ 4. Install deps IN target dir ============
Write-Host "[4/6] Installing deps in target dir ..." -ForegroundColor Yellow
# npm 往 stderr 写 deprecation 警告（如 prebuild-install deprecated），
# PowerShell 在 ErrorActionPreference=Stop 时会把原生命令的 stderr 当作
# NativeCommandError 终止错误，即使 2>$null 也压不住。npm 调用期间临时
# 放宽为 Continue，警告只显示不中断，用 $LASTEXITCODE 判断真实成败。
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
Push-Location $extDir
try {
    # pdf-parse is pure JS — always install (required for parse_pdf tool).
    Write-Host "  Installing pdf-parse (pure JS, required) ..." -ForegroundColor Gray
    $null = npm install pdf-parse@^1.1.1 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: pdf-parse install failed (network?)." -ForegroundColor Red
        $ErrorActionPreference = $prevEAP
        exit 1
    }
    Write-Host "  OK: pdf-parse installed" -ForegroundColor Green

    # better-sqlite3 is a native module. On Windows with Node 24 there is often no
    # prebuilt binary, so npm falls back to node-gyp which needs Python + VS Build
    # Tools (C++ compiler). That is a heavy install many users lack. Make it
    # NON-FATAL: if it fails, the extension still loads — SQLite-dependent tools
    # (task/note/query_database) are auto-disabled via feature detection in
    # all-in-one.ts. Core logistic tools are unaffected.
    Write-Host "  Installing better-sqlite3 (native, optional) ..." -ForegroundColor Gray
    $null = npm install better-sqlite3@^11.3.0 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  WARN: better-sqlite3 install failed (needs Python + VS Build Tools to" -ForegroundColor Yellow
        Write-Host "        compile). Skipping — SQLite tools will be disabled, logistic tools OK." -ForegroundColor Yellow
    } else {
        Write-Host "  OK: better-sqlite3 installed" -ForegroundColor Green
    }
} finally {
    $ErrorActionPreference = $prevEAP
    Pop-Location
}

# ============ 5. Deploy agent config (SYSTEM.md + skills/) ============
Write-Host "[5/6] Deploying agent config (SYSTEM.md + skills/) ..." -ForegroundColor Yellow
$agentConfigDir = Join-Path $PSScriptRoot "..\pi-agent-config"
if (Test-Path $agentConfigDir) {
    # SYSTEM.md -> ~/.pi/agent/SYSTEM.md
    $systemMd = Join-Path $agentConfigDir "SYSTEM.md"
    if (Test-Path $systemMd) {
        Copy-Item -Path $systemMd -Destination (Join-Path $piAgentDir "SYSTEM.md") -Force
        Write-Host "  OK: SYSTEM.md deployed" -ForegroundColor Green
    }
    # skills/ -> ~/.pi/agent/skills/
    $skillsSrc = Join-Path $agentConfigDir "skills"
    $skillsDst = Join-Path $piAgentDir "skills"
    if (Test-Path $skillsSrc) {
        if (-not (Test-Path $skillsDst)) {
            New-Item -ItemType Directory -Path $skillsDst -Force | Out-Null
        }
        Get-ChildItem -Path $skillsSrc -Filter "*.md" | ForEach-Object {
            Copy-Item -Path $_.FullName -Destination (Join-Path $skillsDst $_.Name) -Force
        }
        Write-Host "  OK: skills/ deployed ($(@(Get-ChildItem -Path $skillsSrc -Filter '*.md')).Count files)" -ForegroundColor Green
    }
} else {
    Write-Host "  SKIP: pi-agent-config/ not found (skipping config deploy)" -ForegroundColor Yellow
}

# ============ 6. Verify ============
Write-Host "[6/6] Verifying ..." -ForegroundColor Yellow
$installedTs = Join-Path $extDir "all-in-one.ts"
$nodeModules = Join-Path $extDir "node_modules"
$bsql = Join-Path $nodeModules "better-sqlite3"
$pdfp = Join-Path $nodeModules "pdf-parse"
$allOk = $true
# Required: all-in-one.ts + pdf-parse
foreach ($p in @($installedTs, $pdfp)) {
    if (Test-Path $p) {
        Write-Host "  [OK] $p" -ForegroundColor Green
    } else {
        Write-Host "  [MISSING] $p (required)" -ForegroundColor Red
        $allOk = $false
    }
}
# Optional: better-sqlite3 (SQLite tools disabled if missing; logistic tools unaffected)
if (Test-Path $bsql) {
    Write-Host "  [OK] $bsql" -ForegroundColor Green
} else {
    Write-Host "  [OPTIONAL-MISSING] $bsql (SQLite tools will be disabled, logistic tools OK)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
if ($allOk) {
    Write-Host "  Install Complete!" -ForegroundColor Green
} else {
    Write-Host "  Install finished with warnings (see MISSING above)" -ForegroundColor Yellow
}
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Installed to: $extDir" -ForegroundColor White
Write-Host ""
Write-Host "Next steps:" -ForegroundColor White
Write-Host "  1. Restart Pi (or Tauri app) so it reloads extension + SYSTEM.md + skills" -ForegroundColor White
Write-Host "  2. In Pi, ask: 'list the tools you can call'" -ForegroundColor White
Write-Host "     You should see logistic_* tools (invoice_packing, customs_generator," -ForegroundColor White
Write-Host "     customs_extractor, data_analysis, list_tools)" -ForegroundColor White
Write-Host "  3. Try: 'analyze C:\path\to\data.xlsx'" -ForegroundColor White
Write-Host "     Pi should call logistic_data_analysis directly (no asking permission)" -ForegroundColor White
Write-Host "  4. Permission mode: toggle in Tauri Settings > 工具权限模式" -ForegroundColor White
Write-Host "     - Standard: only delete/external-write/script executions prompt" -ForegroundColor White
Write-Host "     - Full Trust: all tool calls auto-approved, zero interruption" -ForegroundColor White
Write-Host ""
Write-Host "Note: Make sure Tauri app is running so the Python sidecar (port 8000)" -ForegroundColor Gray
Write-Host "      is up — logistic_* tools call it over HTTP." -ForegroundColor Gray
Write-Host ""
