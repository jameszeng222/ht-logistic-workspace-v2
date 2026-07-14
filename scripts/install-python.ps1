# HT Logistic Workspace - Auto-install Python 3.12
#
# Usage:
#   Right-click -> "Run with PowerShell", or:
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-python.ps1
#
# What it does:
#   1. Detect OS architecture (x64 / arm64)
#   2. Check if a usable Python 3.11+ already exists -- if yes, exit early
#   3. Download Python 3.12 installer from python.org
#   4. Install silently (per-user, no admin needed), add to PATH
#   5. Verify installation
#   6. Print next steps
#
# Why per-user install:
#   Python official installer with InstallAllUsers=0 installs to %LOCALAPPDATA%\Programs\Python\Python312,
#   no admin privileges needed. Combined with PrependPath=1 it auto-adds to user PATH.

param(
    [string]$Version = "3.12.7"
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Python 3.12 Auto Installer" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ============ 1. Detect architecture ============
$arch = if ([Environment]::Is64BitOperatingSystem) {
    if ([Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITECTURE") -eq "ARM64") { "arm64" } else { "amd64" }
} else {
    Write-Host "ERROR: 32-bit Windows is not supported." -ForegroundColor Red
    exit 1
}
Write-Host "Architecture: $arch" -ForegroundColor Gray

# ============ 2. Check if usable Python 3.11+ already exists ============
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
    $candidates = $candidates | Select-Object -Unique
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
    if ($stable.Count -gt 0) { return @{ Path = $stable[0]; Tier = "stable" } }
    if ($older.Count -gt 0)  { return @{ Path = $older[0]; Tier = "older" } }
    if ($newDev.Count -gt 0) { return @{ Path = $newDev[0]; Tier = "dev" } }
    return $null
}

$existing = Find-Python
if ($existing -and $existing.Tier -eq "stable") {
    Write-Host ""
    Write-Host "Python $($existing.Path) already installed (stable 3.11/3.12)." -ForegroundColor Green
    Write-Host "No need to install again." -ForegroundColor Green
    Write-Host ""
    Write-Host "Next: run .\deploy.ps1 from repo root" -ForegroundColor White
    pause
    exit 0
}
if ($existing) {
    Write-Host "Found Python at $($existing.Path) (tier: $($existing.Tier))," -ForegroundColor Yellow
    Write-Host "but it is not a stable 3.11/3.12 build. Installing 3.12 alongside." -ForegroundColor Yellow
    Write-Host ""
} else {
    Write-Host "No usable Python found. Installing Python 3.12 ..." -ForegroundColor Yellow
    Write-Host ""
}

# ============ 3. Download installer ============
# Official Python release: https://www.python.org/downloads/release/python-3127/
$exeName = "python-$Version-$arch.exe"
$url = "https://www.python.org/ftp/python/$Version/$exeName"
$installerPath = Join-Path $env:TEMP $exeName

Write-Host "Downloading Python $Version ($arch) ..." -ForegroundColor Yellow
Write-Host "  URL : $url" -ForegroundColor Gray
Write-Host "  Save: $installerPath" -ForegroundColor Gray
try {
    $ProgressPreference = "SilentlyContinue"
    Invoke-WebRequest -Uri $url -OutFile $installerPath -UseBasicParsing
} catch {
    Write-Host ""
    Write-Host "ERROR: Download failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "Try one of these alternatives:" -ForegroundColor White
    Write-Host "  1. Open this URL in browser, download the .exe, double-click to install:" -ForegroundColor White
    Write-Host "     $url" -ForegroundColor White
    Write-Host "     During install: CHECK 'Add python.exe to PATH'" -ForegroundColor White
    Write-Host "  2. Use a mirror (if python.org is slow):" -ForegroundColor White
    Write-Host "     https://mirrors.huaweicloud.com/python/$Version/$exeName" -ForegroundColor White
    exit 1
}
Write-Host "  OK: downloaded ($([math]::Round((Get-Item $installerPath).Length / 1MB, 1)) MB)" -ForegroundColor Green

# ============ 4. Silent install (per-user, no admin) ============
Write-Host ""
Write-Host "Installing Python $Version (silent, per-user, no admin needed) ..." -ForegroundColor Yellow
Write-Host "  This may take 1-3 minutes. Please wait." -ForegroundColor Gray

$args = @(
    "/quiet",
    "InstallAllUsers=0",
    "PrependPath=1",
    "Include_test=0",
    "Include_doc=0",
    "Include_launcher=1",
    "Include_pip=1",
    "Include_tcltk=0"
)
$proc = Start-Process -FilePath $installerPath -ArgumentList $args -Wait -PassThru -NoNewWindow
if ($proc.ExitCode -ne 0) {
    Write-Host ""
    Write-Host "ERROR: Installer exit code $($proc.ExitCode)" -ForegroundColor Red
    Write-Host "  Log file: $env:TEMP\Python $Version ($arch) Install_log.txt" -ForegroundColor Gray
    Write-Host "  Try: download manually from $url and run the installer manually." -ForegroundColor White
    pause
    exit 1
}
Write-Host "  OK: installed" -ForegroundColor Green

# ============ 5. Refresh PATH and verify ============
# The installer adds Python to user PATH, but the current PowerShell session
# still has the old PATH. Refresh from registry so we can verify immediately.
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
$env:Path = "$userPath;$machinePath"

$after = Find-Python
if ($after -and $after.Tier -eq "stable") {
    $verStr = & $after.Path --version 2>&1
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Python Install Complete!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Version : $verStr" -ForegroundColor White
    Write-Host "  Path    : $($after.Path)" -ForegroundColor White
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor White
    Write-Host "  1. CLOSE this PowerShell window (PATH was just updated)" -ForegroundColor White
    Write-Host "  2. Open a NEW PowerShell window" -ForegroundColor White
    Write-Host "  3. cd to the repo folder and run:" -ForegroundColor White
    Write-Host "     .\deploy.ps1" -ForegroundColor White
    Write-Host ""
} else {
    Write-Host ""
    Write-Host "WARNING: Install succeeded but Python not found in current PATH." -ForegroundColor Yellow
    Write-Host "  This is normal -- PATH refresh sometimes needs a new shell window." -ForegroundColor Yellow
    Write-Host "  Close PowerShell, reopen it, and try: python --version" -ForegroundColor Yellow
    Write-Host ""
}

# Cleanup installer
try { Remove-Item $installerPath -Force -ErrorAction SilentlyContinue } catch {}

pause
