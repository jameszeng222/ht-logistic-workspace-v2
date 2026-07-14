# HT Logistic Workspace - One-click deploy + validate
#
# Usage (run from anywhere, script auto-detects repo root via $PSScriptRoot):
#   .\deploy.ps1                  # full deploy + validate
#   .\deploy.ps1 -ValidateOnly    # skip deploy steps, only verify + validate
#
# What it does:
#   1. git pull                         (skip with -ValidateOnly)
#   2. Install Pi extension + agent config (calls pi-extensions/install.ps1)
#   3. Ensure Python sidecar deps          (calls python-sidecar/setup.ps1 if .venv missing)
#   4. Verify deployed files exist         (~/.pi/agent/extensions/, SYSTEM.md, skills/)
#   5. Start temp sidecar if :8000 free    (or reuse existing one)
#   6. Validate sidecar API                (/api/health + /api/tools, check 4 tools present)
#   7. Stop temp sidecar
#   8. Print summary with per-step OK/FAIL
#
# Why $PSScriptRoot: 之前版本写死 cd C:\path\to\... 是占位符，用户实际路径不同。
# 现在脚本放在仓库根目录，用 $PSScriptRoot 自动定位，用户只需在仓库根运行 .\deploy.ps1。

param([switch]$ValidateOnly)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# ============ Helpers ============
function Test-Port($port) {
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $tcp.Connect("127.0.0.1", $port)
        $tcp.Close()
        return $true
    } catch { return $false }
}

# 调用子脚本（install.ps1 / setup.ps1）用 Start-Process 子进程，
# 避免子脚本里 exit 1 把整个 PowerShell 会话也退出掉。
function Invoke-SubScript($scriptPath) {
    $p = Start-Process powershell -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File",$scriptPath -Wait -PassThru -NoNewWindow
    return $p.ExitCode
}

# ============ 0. Detect repo root ============
$repoRoot = $PSScriptRoot
if (-not $repoRoot) { $repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  HT Logistic Workspace - Deploy & Validate" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Repo root: $repoRoot" -ForegroundColor Gray
if ($ValidateOnly) { Write-Host "Mode: ValidateOnly (skip deploy steps)" -ForegroundColor Magenta }
Write-Host ""

$results = @()

# ============ 1. git pull ============
if ($ValidateOnly) {
    Write-Host "[1/8] git pull (SKIP)" -ForegroundColor Yellow
    $results += @{ step="git pull"; status="skip" }
} else {
    Write-Host "[1/8] git pull ..." -ForegroundColor Yellow
    Push-Location $repoRoot
    try {
        $gitOut = git pull 2>&1
        Write-Host "  $gitOut" -ForegroundColor Gray
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  OK" -ForegroundColor Green
            $results += @{ step="git pull"; status="ok" }
        } else {
            Write-Host "  WARN: git pull failed (continuing)" -ForegroundColor Yellow
            $results += @{ step="git pull"; status="warn" }
        }
    } finally { Pop-Location }
}

# ============ 2. Install Pi extension + agent config ============
if ($ValidateOnly) {
    Write-Host "[2/8] Pi extension install (SKIP)" -ForegroundColor Yellow
    $results += @{ step="extension install"; status="skip" }
} else {
    Write-Host "[2/8] Installing Pi extension + agent config ..." -ForegroundColor Yellow
    $code = Invoke-SubScript "$repoRoot\pi-extensions\install.ps1"
    if ($code -eq 0) {
        Write-Host "  OK (install.ps1 exit 0)" -ForegroundColor Green
        $results += @{ step="extension install"; status="ok" }
    } else {
        Write-Host "  FAIL: install.ps1 exit $code" -ForegroundColor Red
        $results += @{ step="extension install"; status="fail" }
    }
}

# ============ 3. Ensure Python sidecar deps ============
$venvPy = "$repoRoot\python-sidecar\.venv\Scripts\python.exe"
if ($ValidateOnly) {
    Write-Host "[3/8] Sidecar deps (SKIP)" -ForegroundColor Yellow
    $results += @{ step="sidecar deps"; status="skip" }
} elseif (Test-Path $venvPy) {
    Write-Host "[3/8] Sidecar deps: venv already exists, skip setup" -ForegroundColor Green
    $results += @{ step="sidecar deps"; status="ok" }
} else {
    Write-Host "[3/8] Setting up Python sidecar deps (first time, may take minutes) ..." -ForegroundColor Yellow
    $code = Invoke-SubScript "$repoRoot\python-sidecar\setup.ps1"
    if ($code -eq 0) {
        Write-Host "  OK (setup.ps1 exit 0)" -ForegroundColor Green
        $results += @{ step="sidecar deps"; status="ok" }
    } else {
        Write-Host "  FAIL: setup.ps1 exit $code" -ForegroundColor Red
        $results += @{ step="sidecar deps"; status="fail" }
    }
}

# ============ 4. Verify deployed files ============
Write-Host "[4/8] Verifying deployed files ..." -ForegroundColor Yellow
$homeDir = $env:USERPROFILE
if (-not $homeDir) { $homeDir = $env:HOME }
$fileChecks = @(
    @{ name="Pi extension (all-in-one.ts)";   path="$homeDir\.pi\agent\extensions\all-in-one.ts";       optional=$false },
    @{ name="pdf-parse module";               path="$homeDir\.pi\agent\extensions\node_modules\pdf-parse"; optional=$false },
    @{ name="better-sqlite3 module";          path="$homeDir\.pi\agent\extensions\node_modules\better-sqlite3"; optional=$true },
    @{ name="SYSTEM.md (permission config)";  path="$homeDir\.pi\agent\SYSTEM.md";                      optional=$false },
    @{ name="skills/ dir";                    path="$homeDir\.pi\agent\skills";                         optional=$false }
)
$fileAllOk = $true
foreach ($c in $fileChecks) {
    if (Test-Path $c.path) {
        Write-Host "  [OK] $($c.name)" -ForegroundColor Green
    } elseif ($c.optional) {
        Write-Host "  [OPTIONAL-MISSING] $($c.name) (SQLite tools disabled, logistic tools OK)" -ForegroundColor Yellow
    } else {
        Write-Host "  [MISSING] $($c.name)" -ForegroundColor Red
        Write-Host "          -> $($c.path)" -ForegroundColor Gray
        $fileAllOk = $false
    }
}
if ($fileAllOk) { $results += @{ step="file verify"; status="ok" } }
else { $results += @{ step="file verify"; status="fail" } }

# ============ 5. Start temp sidecar (if :8000 not in use) ============
Write-Host "[5/8] Preparing sidecar for API validation ..." -ForegroundColor Yellow
$tempProc = $null
$sidecarReady = $false
if (Test-Port 8000) {
    Write-Host "  :8000 already in use (Tauri app or external sidecar running) — will reuse" -ForegroundColor Green
    $sidecarReady = $true
} elseif (-not (Test-Path $venvPy)) {
    Write-Host "  [SKIP] python venv not found ($venvPy), cannot start sidecar" -ForegroundColor Yellow
} else {
    Write-Host "  Starting temp sidecar for validation ..." -ForegroundColor Gray
    $tempProc = Start-Process -FilePath $venvPy -ArgumentList "main.py" -WorkingDirectory "$repoRoot\python-sidecar" -PassThru -WindowStyle Hidden
    for ($i = 0; $i -lt 30; $i++) {
        if (Test-Port 8000) { break }
        Start-Sleep -Milliseconds 500
    }
    if (Test-Port 8000) {
        Write-Host "  OK: temp sidecar up (pid=$($tempProc.Id))" -ForegroundColor Green
        $sidecarReady = $true
    } else {
        Write-Host "  [FAIL] temp sidecar did not listen on :8000 within 15s" -ForegroundColor Red
    }
}

# ============ 6. Validate sidecar API ============
Write-Host "[6/8] Validating sidecar API ..." -ForegroundColor Yellow
$apiOk = $false
if (-not $sidecarReady) {
    Write-Host "  [SKIP] sidecar not ready" -ForegroundColor Yellow
} else {
    # /api/health
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/health" -TimeoutSec 5
        if ($health.ok) {
            Write-Host "  [OK] /api/health -> ok=true" -ForegroundColor Green
        } else {
            Write-Host "  [FAIL] /api/health returned ok!=true" -ForegroundColor Red
        }
    } catch {
        Write-Host "  [FAIL] /api/health -> $($_.Exception.Message)" -ForegroundColor Red
    }
    # /api/tools
    try {
        $toolsResp = Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/tools" -TimeoutSec 5
        $toolIds = @($toolsResp.tools | ForEach-Object { $_.id })
        Write-Host "  [OK] /api/tools -> $($toolIds.Count) tools: $($toolIds -join ', ')" -ForegroundColor Green
        $expected = @("invoice-packing", "customs-generator", "customs-extractor", "data-analysis")
        $allExpected = $true
        foreach ($e in $expected) {
            if ($toolIds -contains $e) {
                Write-Host "    [OK] $e present" -ForegroundColor Green
            } else {
                Write-Host "    [MISSING] $e" -ForegroundColor Red
                $allExpected = $false
            }
        }
        if ($allExpected) { $apiOk = $true }
    } catch {
        Write-Host "  [FAIL] /api/tools -> $($_.Exception.Message)" -ForegroundColor Red
    }
}
if ($apiOk) { $results += @{ step="sidecar API"; status="ok" } }
elseif ($sidecarReady) { $results += @{ step="sidecar API"; status="fail" } }
else { $results += @{ step="sidecar API"; status="skip" } }

# ============ 7. Stop temp sidecar ============
if ($tempProc) {
    Write-Host "[7/8] Stopping temp sidecar (pid=$($tempProc.Id)) ..." -ForegroundColor Yellow
    Stop-Process -Id $tempProc.Id -Force -ErrorAction SilentlyContinue
    # uvicorn 单进程模式，杀主 PID 即可；为保险也清理可能的子进程
    Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $tempProc.Id } | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Write-Host "  OK" -ForegroundColor Green
} else {
    Write-Host "[7/8] No temp sidecar to stop (reused existing or skipped)" -ForegroundColor Gray
}

# ============ 8. Summary ============
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Summary" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
foreach ($r in $results) {
    $icon  = switch ($r.status) { "ok"{"[OK]   "}; "fail"{"[FAIL] "}; "warn"{"[WARN] "}; "skip"{"[SKIP] "}; default{"[??]   "} }
    $color = switch ($r.status) { "ok"{"Green"};      "fail"{"Red"};     "warn"{"Yellow"}; "skip"{"Gray"};    default{"White"} }
    Write-Host "  $icon$($r.step)" -ForegroundColor $color
}
Write-Host ""

$anyFail = $results | Where-Object { $_.status -eq "fail" }
if ($anyFail) {
    Write-Host "Deploy finished with FAILURES — see [FAIL] lines above." -ForegroundColor Red
    Write-Host ""
    $sidecarFail = $results | Where-Object { $_.step -eq "sidecar deps" -and $_.status -eq "fail" }
    if ($sidecarFail -and -not (Test-Path $venvPy)) {
        Write-Host "--- Sidecar deps failed: Python likely missing or broken ---" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "If you have Python 3.13+/3.14+ (dev/preview) or the Windows Store stub," -ForegroundColor White
        Write-Host "packages like pandas/numpy won't have prebuilt wheels and pip install fails." -ForegroundColor White
        Write-Host ""
        Write-Host "Option A — Auto-install Python 3.12 (recommended, no admin needed):" -ForegroundColor White
        Write-Host "  .\scripts\install-python.ps1" -ForegroundColor White
        Write-Host "  After install: close PowerShell, reopen, re-run .\deploy.ps1" -ForegroundColor White
        Write-Host ""
        Write-Host "Option B — Manual install:" -ForegroundColor White
        Write-Host "  Download Python 3.12 from https://www.python.org/downloads/" -ForegroundColor White
        Write-Host "  CHECK 'Add python.exe to PATH' during install" -ForegroundColor White
        Write-Host ""
    }
    Write-Host "Fix the failing step, then re-run: .\deploy.ps1" -ForegroundColor Red
    exit 1
} else {
    Write-Host "Deploy & Validate Complete!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor White
    Write-Host "  1. Restart Tauri app (so Pi reloads extension + new SYSTEM.md)" -ForegroundColor White
    Write-Host "  2. In Pi, ask: 'list the tools you can call'" -ForegroundColor White
    Write-Host "     Expect: logistic_invoice_packing, logistic_customs_generator," -ForegroundColor White
    Write-Host "             logistic_customs_extractor, logistic_data_analysis, ..." -ForegroundColor White
    Write-Host "  3. Permission mode: Tauri Settings > 工具权限模式 (Standard / Full Trust)" -ForegroundColor White
    Write-Host ""
    Write-Host "Re-validate anytime without redeploying:" -ForegroundColor Gray
    Write-Host "  .\deploy.ps1 -ValidateOnly" -ForegroundColor Gray
}
