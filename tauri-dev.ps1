[CmdletBinding()]
param(
    [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$tauriDir = Join-Path $repoRoot "tauri-app"
$packageJson = Join-Path $tauriDir "package.json"
$packageLock = Join-Path $tauriDir "package-lock.json"
$nodeModules = Join-Path $tauriDir "node_modules"

function Assert-CommandExists {
    param([Parameter(Mandatory = $true)][string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found. Please install Node.js first."
    }
}

function Assert-NodeVersion {
    $versionText = (& node --version).Trim()
    $match = [regex]::Match($versionText, '^v?(\d+)\.(\d+)\.(\d+)')

    if (-not $match.Success) {
        throw "Could not read the Node.js version: $versionText"
    }

    $major = [int]$match.Groups[1].Value
    $minor = [int]$match.Groups[2].Value
    if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 19)) {
        throw "Node.js 22.19.0 or newer is required. Current version: $versionText"
    }

    return $versionText
}

function Test-LocalPortInUse {
    param([Parameter(Mandatory = $true)][int]$Port)

    try {
        return $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1)
    }
    catch {
        return $false
    }
}

if (-not (Test-Path -LiteralPath $packageJson)) {
    throw "Tauri project was not found: $tauriDir"
}

Assert-CommandExists "node"
Assert-CommandExists "npm"
$nodeVersion = Assert-NodeVersion

Write-Host "HT Logistic Workspace - Tauri development" -ForegroundColor Cyan
Write-Host "Repository: $repoRoot"
Write-Host "Node.js:    $nodeVersion"

if (Test-LocalPortInUse -Port 5173) {
    throw "Port 5173 is already in use. Close the old development process and run this script again."
}

if ($CheckOnly) {
    Write-Host "Environment check passed." -ForegroundColor Green
    exit 0
}

Push-Location $tauriDir
try {
    if (-not (Test-Path -LiteralPath $nodeModules)) {
        Write-Host "Installing frontend dependencies..." -ForegroundColor Yellow
        if (Test-Path -LiteralPath $packageLock) {
            & npm ci
        }
        else {
            & npm install
        }

        if ($LASTEXITCODE -ne 0) {
            throw "Dependency installation failed with exit code $LASTEXITCODE."
        }
    }

    Write-Host "Starting Tauri development mode..." -ForegroundColor Green
    & npm run tauri dev
    $exitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}

if ($exitCode -ne 0) {
    exit $exitCode
}
