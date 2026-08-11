# HT Logistic Workspace - local Windows installer build entry
#
# Common usage:
#   .\build.ps1
#   .\build.ps1 -CheckOnly
#   .\build.ps1 -SkipTests
#   .\build.ps1 -KeyPassword "your-password"

[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$SkipTests,
    [string]$KeyPath = "$env:USERPROFILE\.tauri\ht-logistic.key",
    [string]$KeyPassword = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$repoRoot = $PSScriptRoot
if (-not $repoRoot) { $repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }
$tauriDir = Join-Path $repoRoot "tauri-app"
$sidecarDir = Join-Path $repoRoot "python-sidecar"
$installerScript = Join-Path $repoRoot "scripts\build-installer.ps1"
$tauriConfigPath = Join-Path $tauriDir "src-tauri\tauri.conf.json"
$outputDir = Join-Path $repoRoot "output\installer"

function Write-Section([string]$Message) {
    Write-Host ""
    Write-Host "================================================" -ForegroundColor Cyan
    Write-Host "  $Message" -ForegroundColor Cyan
    Write-Host "================================================" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
    Write-Host "  [OK] $Message" -ForegroundColor Green
}

function Write-WarningLine([string]$Message) {
    Write-Host "  [WARN] $Message" -ForegroundColor Yellow
}

function Require-Command([string]$Name, [string]$InstallHint) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) {
        throw "缺少 $Name。$InstallHint"
    }
    return $command
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][scriptblock]$Command
    )
    Write-Host "  -> $Label" -ForegroundColor Gray
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Label 失败，退出代码：$LASTEXITCODE"
    }
}

function Get-MajorVersion([string]$VersionText) {
    $match = [regex]::Match($VersionText, "(\d+)")
    if (-not $match.Success) { return 0 }
    return [int]$match.Groups[1].Value
}

try {
    Write-Section "HT Logistic Workspace - 本地安装包构建"

    if (-not (Test-Path $tauriConfigPath)) {
        throw "没有找到 tauri.conf.json：$tauriConfigPath"
    }
    if (-not (Test-Path $installerScript)) {
        throw "没有找到底层构建脚本：$installerScript"
    }

    Write-Section "1/4 检查构建环境"
    Require-Command "node" "请安装 Node.js 22.19 或更高版本。" | Out-Null
    Require-Command "npm" "请重新安装 Node.js，并勾选 npm。" | Out-Null
    Require-Command "cargo" "请安装 Rust：https://rustup.rs/" | Out-Null
    Require-Command "rustc" "请安装 Rust：https://rustup.rs/" | Out-Null
    Require-Command "python" "请安装 Python 3.12，或运行 .\scripts\install-python.ps1。" | Out-Null

    $nodeVersion = (& node --version).Trim()
    $npmVersion = (& npm --version).Trim()
    $rustVersion = (& rustc --version).Trim()
    $pythonVersion = (& python --version 2>&1 | Out-String).Trim()
    if ((Get-MajorVersion $nodeVersion) -lt 22) {
        throw "Node.js 版本过低：$nodeVersion。需要 22.19 或更高版本。"
    }
    if ($pythonVersion -notmatch "Python 3\.(11|12|13)") {
        Write-WarningLine "当前 Python 为 $pythonVersion；建议使用 Python 3.12。"
    }
    Write-Ok "Node.js $nodeVersion / npm $npmVersion"
    Write-Ok $rustVersion
    Write-Ok $pythonVersion

    $config = Get-Content $tauriConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Ok "应用版本 $($config.version)"

    if (Test-Path $KeyPath) {
        $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $KeyPath -Raw -Encoding UTF8
        if ($KeyPassword) {
            $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $KeyPassword
        }
        Write-Ok "已加载更新签名密钥：$KeyPath"
        if (-not $KeyPassword) {
            Write-WarningLine "未提供签名密码；如果密钥有密码，请使用 -KeyPassword 参数。"
        }
    } else {
        Write-WarningLine "没有找到签名密钥：$KeyPath"
        Write-WarningLine "仍可尝试生成安装包，但不会生成可用的自动更新签名。"
    }

    if ($CheckOnly) {
        Write-Host ""
        Write-Ok "环境检查完成，没有开始构建。"
        exit 0
    }

    Write-Section "2/4 运行构建前检查"
    if ($SkipTests) {
        Write-WarningLine "已跳过测试。"
    } else {
        Push-Location $tauriDir
        try {
            if (-not (Test-Path "node_modules")) {
                if (Test-Path "package-lock.json") {
                    Invoke-Checked "安装前端依赖" { npm ci }
                } else {
                    Invoke-Checked "安装前端依赖" { npm install }
                }
            }
            Invoke-Checked "前端测试" { npm test }
            Invoke-Checked "前端生产构建" { npm run build }
        } finally { Pop-Location }

        $testPython = Join-Path $sidecarDir ".venv\Scripts\python.exe"
        if (-not (Test-Path $testPython)) { $testPython = "python" }
        Push-Location $sidecarDir
        try {
            Invoke-Checked "Python Sidecar 测试" { & $testPython -m unittest discover -s tests -p "test_*.py" }
        } finally { Pop-Location }

        Push-Location (Join-Path $tauriDir "src-tauri")
        try {
            Invoke-Checked "Rust 测试" { cargo test }
        } finally { Pop-Location }
        Write-Ok "全部测试通过"
    }

    Write-Section "3/4 构建 Windows 安装包"
    Write-Host "  首次构建会下载便携 Node.js，并打包 Python Sidecar，通常需要 5-15 分钟。" -ForegroundColor Gray
    & $installerScript
    if ($LASTEXITCODE -ne 0) {
        throw "安装包构建失败，退出代码：$LASTEXITCODE"
    }

    Write-Section "4/4 整理构建产物"
    $bundleDir = Join-Path $tauriDir "src-tauri\target\release\bundle\nsis"
    $setupExe = Get-ChildItem $bundleDir -Filter "*-setup.exe" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $setupExe) {
        throw "构建结束但没有找到安装包：$bundleDir"
    }

    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
    Get-ChildItem $outputDir -File -ErrorAction SilentlyContinue | Remove-Item -Force
    Copy-Item $setupExe.FullName $outputDir -Force
    foreach ($extra in @("$($setupExe.FullName).sig", (Join-Path $bundleDir "latest.json"))) {
        if (Test-Path $extra) { Copy-Item $extra $outputDir -Force }
    }

    $finalSetup = Join-Path $outputDir $setupExe.Name
    $sizeMb = [math]::Round((Get-Item $finalSetup).Length / 1MB, 1)
    Write-Host ""
    Write-Host "构建成功。" -ForegroundColor Green
    Write-Host "安装包：$finalSetup" -ForegroundColor White
    Write-Host "大小：${sizeMb} MB" -ForegroundColor Gray
    Write-Host ""
    Write-Host "下一步：双击安装包，在本机完成安装验证。" -ForegroundColor Cyan
} catch {
    Write-Host ""
    Write-Host "构建失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "请查看上方最后一个失败步骤；修复后重新运行 .\build.ps1。" -ForegroundColor Yellow
    exit 1
}
