# HT Logistic Workspace - Python sidecar setup script
#
# Usage (in python-sidecar directory):
#   .\setup.ps1
#
# This script will:
#   1. Create .venv if not exists
#   2. Configure pip mirror (Tsinghua) to bypass SSL cert CN mismatch
#   3. Install requirements.txt
#   4. Install pyinstaller (for packaging ht-sidecar.exe)
#   5. Print how to start the service
#
# If Tsinghua mirror is slow, switch to Aliyun by editing $MIRROR below.
#
# Usage:
#   .\setup.ps1                              # auto-detect Python (prefer 3.11/3.12)
#   .\setup.ps1 -PythonExe "C:\Path\python.exe"  # force a specific Python

param(
    [string]$PythonExe = ""
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$MIRROR = "https://pypi.tuna.tsinghua.edu.cn/simple"
$MIRROR_HOST = "pypi.tuna.tsinghua.edu.cn"

# ============ Find a working Python 3.10+ (prefer 3.11/3.12, skip 3.13+ dev builds) ============
# Windows often ships a Store "App Execution Alias" stub as `python` that does
# nothing in non-interactive shells (returns empty version). Skip it and prefer
# the `py` launcher, then scan known install locations.
#
# We prefer 3.11 / 3.12 because 3.13+ (especially 3.14 dev builds like
# pythoncore-3.14 from the Store) often lack prebuilt wheels for packages
# like pandas / numpy / pdfplumber, and source builds fail on Windows without
# C++ build tools. 3.13+ is only used as last resort with a warning.
function Find-Python {
    $candidates = @()
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) {
        try {
            $exe = & py -3 -c "import sys; print(sys.executable)" 2>$null
            if ($exe -and (Test-Path $exe.Trim())) { $candidates += $exe.Trim() }
        } catch {}
    }
    foreach ($cmd in @("python","python3")) {
        $g = Get-Command $cmd -ErrorAction SilentlyContinue
        if ($g -and $g.Source -and ($g.Source -notmatch "WindowsApps")) { $candidates += $g.Source }
    }
    $knownRoots = @()
    if ($env:LOCALAPPDATA) { $knownRoots += Join-Path $env:LOCALAPPDATA "Programs\Python" }
    $knownRoots += "C:\Python*", "$env:ProgramFiles\Python*", "${env:ProgramFiles(x86)}\Python*"
    foreach ($root in $knownRoots) {
        Get-ChildItem -Path $root -Filter "python.exe" -Recurse -ErrorAction SilentlyContinue -Depth 1 |
            ForEach-Object { $candidates += $_.FullName }
    }
    # Deduplicate
    $candidates = $candidates | Select-Object -Unique
    # Categorize by minor version: prefer 3.11/3.12, then 3.10, 3.13+ last
    $stable = @()
    $older = @()
    $newDev = @()
    foreach ($c in $candidates) {
        try {
            $ver = & $c --version 2>&1
            if ($ver -match "Python 3\.(\d+)") {
                $minor = [int]$Matches[1]
                if ($minor -ge 11 -and $minor -le 12) { $stable += $c }
                elseif ($minor -eq 10) { $older += $c }
                elseif ($minor -ge 13) { $newDev += $c }
            }
        } catch {}
    }
    if ($stable.Count -gt 0) { return $stable[0] }
    if ($older.Count -gt 0)  { return $older[0] }
    if ($newDev.Count -gt 0) {
        Write-Host "WARN: only Python 3.13+ found (dev/preview build)." -ForegroundColor Yellow
        Write-Host "      Many packages may lack prebuilt wheels. Install may fail." -ForegroundColor Yellow
        Write-Host "      Recommend installing Python 3.11 or 3.12 from python.org." -ForegroundColor Yellow
        return $newDev[0]
    }
    return $null
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  HT Logistic Workspace - Sidecar Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

if ($PythonExe -and (Test-Path $PythonExe)) {
    $pythonExe = $PythonExe
    Write-Host "Using Python (from -PythonExe): $pythonExe" -ForegroundColor Green
} else {
    $pythonExe = Find-Python
    if (-not $pythonExe) {
        Write-Host "ERROR: No working Python 3.10+ found." -ForegroundColor Red
        Write-Host "The Python sidecar requires Python. The Windows Store 'python' stub does NOT count." -ForegroundColor White
        Write-Host ""
        Write-Host "Option A — Auto-install (recommended, no admin needed):" -ForegroundColor White
        Write-Host "  Go to repo root and run:" -ForegroundColor White
        Write-Host "    .\scripts\install-python.ps1" -ForegroundColor White
        Write-Host "  It downloads Python 3.12 and installs silently, then re-run this script." -ForegroundColor White
        Write-Host ""
        Write-Host "Option B — Manual install:" -ForegroundColor White
        Write-Host "  1. Download from https://www.python.org/downloads/" -ForegroundColor White
        Write-Host "  2. Run the installer and CHECK 'Add python.exe to PATH'" -ForegroundColor White
        Write-Host "  3. Reopen PowerShell and re-run this script" -ForegroundColor White
        exit 1
    }
}
Write-Host "Using Python: $pythonExe" -ForegroundColor Green

# ============ 1. Create venv ============
if (-not (Test-Path ".\.venv\Scripts\Activate.ps1")) {
    Write-Host "[1/5] Creating virtual environment .venv ..." -ForegroundColor Yellow
    & $pythonExe -m venv .venv
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Failed to create venv with $pythonExe" -ForegroundColor Red
        exit 1
    }
    Write-Host "OK: venv created" -ForegroundColor Green
} else {
    Write-Host "[1/5] venv .venv already exists, skip" -ForegroundColor Green
}

# ============ 2. Activate venv ============
Write-Host "[2/5] Activating venv ..." -ForegroundColor Yellow
. .\.venv\Scripts\Activate.ps1
Write-Host "OK: activated" -ForegroundColor Green

# ============ 3. Configure pip mirror ============
# pip/python 往 stderr 写警告（deprecation、进度等），ErrorActionPreference=Stop
# 时会触发 NativeCommandError 终止脚本。pip 调用期间临时放宽为 Continue。
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
Write-Host "[3/5] Configuring pip mirror (Tsinghua) ..." -ForegroundColor Yellow
$null = python -m pip config set global.index-url $MIRROR 2>&1
$null = python -m pip config set global.trusted-host $MIRROR_HOST 2>&1
Write-Host "OK: mirror configured (current user only)" -ForegroundColor Green

# ============ 4. Upgrade pip ============
Write-Host "[4/5] Upgrading pip ..." -ForegroundColor Yellow
$null = python -m pip install --upgrade pip -i $MIRROR --trusted-host $MIRROR_HOST 2>&1
Write-Host "OK: pip upgraded" -ForegroundColor Green

# ============ 5. Install requirements ============
Write-Host "[5/5] Installing requirements.txt ..." -ForegroundColor Yellow
$logPath = Join-Path (Resolve-Path .) "pip-install.log"
$firstFailed = $false
& pip install -r requirements.txt -i $MIRROR --trusted-host $MIRROR_HOST *> $logPath
if ($LASTEXITCODE -ne 0) {
    $firstFailed = $true
    Write-Host "Install failed with Tsinghua mirror, trying Aliyun ..." -ForegroundColor Yellow
    $MIRROR = "https://mirrors.aliyun.com/pypi/simple/"
    $MIRROR_HOST = "mirrors.aliyun.com"
    $null = python -m pip config set global.index-url $MIRROR 2>&1
    $null = python -m pip config set global.trusted-host $MIRROR_HOST 2>&1
    & pip install -r requirements.txt -i $MIRROR --trusted-host $MIRROR_HOST *> $logPath
}
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ERROR: pip install failed with both mirrors." -ForegroundColor Red
    Write-Host "Possible cause: your Python version ($(& python --version 2>$null)) may be too new" -ForegroundColor Red
    Write-Host "(you have Python 3.13+/3.14+ dev builds). Many packages do not yet have" -ForegroundColor Red
    Write-Host "prebuilt wheels for 3.13+/3.14+, and source builds fail on Windows without" -ForegroundColor Red
    Write-Host "a C compiler (Build Tools for Visual Studio)." -ForegroundColor Red
    Write-Host ""
    Write-Host "Full pip log: $logPath" -ForegroundColor White
    Write-Host ""
    Write-Host "Fix options (choose one):" -ForegroundColor White
    Write-Host "  A. Install a stable Python 3.11 or 3.12 (recommended)" -ForegroundColor White
    Write-Host "     - Download from https://www.python.org/downloads/release/" -ForegroundColor White
    Write-Host "     - Check 'Add python.exe to PATH' during install" -ForegroundColor White
    Write-Host "     - Delete .venv folder, reopen PowerShell, re-run deploy.ps1" -ForegroundColor White
    Write-Host "  B. Install Build Tools for Visual Studio (C++ build tools)" -ForegroundColor White
    Write-Host "     so packages can compile from source" -ForegroundColor White
    Write-Host "  C. Run: Get-Content $logPath -Tail 50" -ForegroundColor White
    Write-Host "     to see the exact error, then send it to me" -ForegroundColor White
    $ErrorActionPreference = $prevEAP
    exit 1
}
Write-Host "OK: requirements installed" -ForegroundColor Green

# ============ 6. Install pyinstaller (for packaging) ============
Write-Host "[+] Installing pyinstaller (for packaging ht-sidecar.exe) ..." -ForegroundColor Yellow
$null = pip install pyinstaller -i $MIRROR --trusted-host $MIRROR_HOST 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "WARN: pyinstaller install failed, handle later when packaging" -ForegroundColor Yellow
} else {
    Write-Host "OK: pyinstaller installed" -ForegroundColor Green
}
$ErrorActionPreference = $prevEAP

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Setup Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor White
Write-Host "  Start sidecar:  python -m uvicorn main:app --reload --port 8000" -ForegroundColor White
Write-Host "  Package:        pyinstaller ht-sidecar.spec" -ForegroundColor White
Write-Host "  Health check:   http://127.0.0.1:8000/api/health" -ForegroundColor White
Write-Host ""
