# HT Logistic Workspace - One-click build + release script
#
# Automates: version bump, signing env vars, build, verify, print upload checklist
#
# Usage:
#   cd ht-logistic-workspace-v2
#   .\scripts\build-and-release.ps1
#
# Optional params:
#   -Version 0.1.3          Specify version (default: auto +0.0.1)
#   -SkipVersionBump        Don't bump version, use current
#   -KeyPath "C:\Users\HT\.tauri\ht-logistic.key"
#   -KeyPassword "123"
#
# Prerequisites:
#   1. Rust + Node.js + Python installed (dev environment)
#   2. Signing private key at C:\Users\HT\.tauri\ht-logistic.key (password 123)
#   3. Code already pulled to latest (git pull origin main)

param(
    [string]$Version = "",
    [switch]$SkipVersionBump,
    [string]$KeyPath = "$env:USERPROFILE\.tauri\ht-logistic.key",
    [string]$KeyPassword = "123"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$tauriConfPath = Join-Path $repoRoot "tauri-app\src-tauri\tauri.conf.json"

# ========== Helper functions ==========

function Write-Step {
    param([string]$msg)
    Write-Host ""
    Write-Host "================================================" -ForegroundColor Cyan
    Write-Host "  $msg" -ForegroundColor Cyan
    Write-Host "================================================" -ForegroundColor Cyan
}

function Write-OK {
    param([string]$msg)
    Write-Host "  [OK] $msg" -ForegroundColor Green
}

function Write-Warn {
    param([string]$msg)
    Write-Host "  [WARN] $msg" -ForegroundColor Yellow
}

function Write-Err {
    param([string]$msg)
    Write-Host "  [ERROR] $msg" -ForegroundColor Red
}

# ========== 0. Pre-checks ==========

Write-Step "Step 0: Pre-checks"

# 0a. Check repo root
if (-not (Test-Path $tauriConfPath)) {
    Write-Err "tauri.conf.json not found, please run this script from repo root"
    Write-Host "  Current dir: $(Get-Location)"
    Write-Host "  Expected: $tauriConfPath"
    exit 1
}
Write-OK "In repo root"

# 0b. Check signing key
if (-not (Test-Path $KeyPath)) {
    Write-Err "Signing key not found: $KeyPath"
    Write-Host "  Use -KeyPath to specify the key path"
    exit 1
}
Write-OK "Signing key exists: $KeyPath"

# 0c. Check current version
$tauriConf = Get-Content $tauriConfPath -Raw | ConvertFrom-Json
$currentVersion = $tauriConf.version
Write-OK "Current version: $currentVersion"

# 0d. Check git status
#     Use cmd /c to avoid PowerShell NativeCommandError on git's stderr output
$gitStatus = (& cmd /c "git status --porcelain 2>&1") | Out-String
if ($gitStatus.Trim()) {
    Write-Warn "Git has uncommitted changes:"
    Write-Host $gitStatus
    $continue = Read-Host "  Continue? (y/N)"
    if ($continue -ne 'y') { exit 1 }
}

# 0e. Check remote sync
#     Git writes progress/info to stderr (not stdout), which PowerShell treats
#     as a native command error under $ErrorActionPreference="Stop". Wrap git
#     calls with 2>&1 and capture output, or use cmd /c to avoid the issue.
Write-Host "  Checking remote sync..."
$fetchOutput = & cmd /c "git fetch origin main 2>&1" | Out-String
$localCommit = (& cmd /c "git rev-parse HEAD 2>&1").Trim()
$remoteCommit = (& cmd /c "git rev-parse origin/main 2>&1").Trim()
if ($localCommit -ne $remoteCommit) {
    Write-Warn "Local and remote differ, recommend: git pull origin main"
    Write-Host "  Local:  $localCommit"
    Write-Host "  Remote: $remoteCommit"
    $continue = Read-Host "  Continue? (y/N)"
    if ($continue -ne 'y') { exit 1 }
} else {
    Write-OK "Local is up to date"
}

# ========== 1. Bump version ==========

if ($SkipVersionBump) {
    $newVersion = $currentVersion
    Write-Step "Step 1: Skip version bump (using $newVersion)"
} else {
    if ($Version) {
        $newVersion = $Version
    } else {
        # Auto +0.0.1
        $parts = $currentVersion.Split('.')
        $patch = [int]$parts[2] + 1
        $newVersion = "$($parts[0]).$($parts[1]).$patch"
    }

    Write-Step "Step 1: Bump version $currentVersion -> $newVersion"

    $content = Get-Content $tauriConfPath -Raw
    $newContent = $content -replace '"version":\s*"[^"]+"', "`"version`": `"$newVersion`""
    Set-Content -Path $tauriConfPath -Value $newContent -NoNewline

    # Verify
    $verifyConf = Get-Content $tauriConfPath -Raw | ConvertFrom-Json
    if ($verifyConf.version -ne $newVersion) {
        Write-Err "Version write failed, expected $newVersion, got $($verifyConf.version)"
        exit 1
    }
    Write-OK "Version updated: $newVersion"

    # Commit the version bump so repo version stays in sync with built/released version.
    # Without this, local tauri.conf.json has the new version but remote doesn't,
    # causing version-mismatch confusion on next pull/build.
    # IMPORTANT: use -c user.name/email so commit works even without global git config
    # (avoids "Committer identity unknown" error). Check exit code -- if commit fails,
    # the version bump is lost and remote will keep the old version, causing the
    # stuck-at-old-version problem (remote keeps old version, each clone resets).
    & cmd /c "git add tauri-app/src-tauri/tauri.conf.json 2>&1" | Out-Null
    $commitOutput = & cmd /c "git -c user.name='trae-agent' -c user.email='agent@trae.local' commit -m `"chore: bump version to $newVersion`" 2>&1" | Out-String
    $commitExit = $LASTEXITCODE
    if ($commitExit -ne 0 -and $commitOutput -notmatch "nothing to commit|no changes") {
        Write-Err "Version bump commit failed (exit $commitExit):"
        Write-Host $commitOutput -ForegroundColor Gray
        Write-Err "Git identity not configured. Run:"
        Write-Host "  git config --global user.email 'you@example.com'" -ForegroundColor Yellow
        Write-Host "  git config --global user.name 'Your Name'" -ForegroundColor Yellow
        exit 1
    }
    Write-OK "Version bump committed locally (will push to remote after build succeeds)"
}

# ========== 2. Set signing env vars ==========

Write-Step "Step 2: Set signing env vars"

# Private key content (-Raw reads whole file as string, preserves newlines)
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $KeyPath -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $KeyPassword

# Verify
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    Write-Err "TAURI_SIGNING_PRIVATE_KEY not set"
    exit 1
}
if (-not $env:TAURI_SIGNING_PRIVATE_KEY.StartsWith("untrusted comment")) {
    Write-Warn "Key first 30 chars: $($env:TAURI_SIGNING_PRIVATE_KEY.Substring(0, [Math]::Min(30, $env:TAURI_SIGNING_PRIVATE_KEY.Length)))"
    Write-Warn "Key should start with 'untrusted comment', may be format issue"
}
Write-OK "TAURI_SIGNING_PRIVATE_KEY set (length: $($env:TAURI_SIGNING_PRIVATE_KEY.Length))"
Write-OK "TAURI_SIGNING_PRIVATE_KEY_PASSWORD set (length: $($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD.Length))"

# ========== 3. Run build script ==========

Write-Step "Step 3: Building (calling build-installer.ps1)"
Write-Host "  This takes about 5-15 minutes, please wait..." -ForegroundColor Gray
Write-Host "  Includes: PyInstaller + Node.js download + pi install + Tauri build + NSIS" -ForegroundColor Gray

$buildScript = Join-Path $PSScriptRoot "build-installer.ps1"
if (-not (Test-Path $buildScript)) {
    Write-Err "Build script not found: $buildScript"
    exit 1
}

& $buildScript
if ($LASTEXITCODE -ne 0) {
    Write-Err "Build failed (exit code $LASTEXITCODE)"
    exit 1
}

# ========== 4. Verify artifacts ==========

Write-Step "Step 4: Verify build artifacts"

$bundleDir = Join-Path $repoRoot "tauri-app\src-tauri\target\release\bundle\nsis"
if (-not (Test-Path $bundleDir)) {
    Write-Err "Bundle dir not found: $bundleDir"
    exit 1
}

# 4a. Check 3 required files
#     Prefer the setup.exe matching the current build version. If a stale
#     setup.exe from a previous version lingers in the bundle dir (shouldn't
#     happen now that build-installer.ps1 wipes nsis dir pre-build, but be
#     defensive), picking the wrong one causes 404 + signature mismatch.
$allSetups = Get-ChildItem (Join-Path $bundleDir "*-setup.exe") -ErrorAction SilentlyContinue
$setupExe = $allSetups | Where-Object { $_.Name -match "${newVersion}_x64-setup\.exe$" } | Select-Object -First 1
if (-not $setupExe -and $allSetups) {
    # Fallback: if no version-match, use the newest one but warn loudly.
    $setupExe = $allSetups | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    Write-Warn "No setup.exe matches current version $newVersion, using newest: $($setupExe.Name)"
    Write-Warn "This usually means tauri.conf.json version was not bumped before build, OR"
    Write-Warn "Tauri reused stale bundle artifacts. Check tauri.conf.json version field."
}
if (-not $setupExe) {
    Write-Err "setup.exe not found"
    exit 1
}
$setupSizeMB = [math]::Round($setupExe.Length / 1MB, 1)
Write-OK "setup.exe: $($setupExe.Name) ($setupSizeMB MB)"

$setupSig = "$($setupExe.FullName).sig"
if (-not (Test-Path $setupSig)) {
    Write-Err ".sig file not found: $setupSig"
    Write-Host "  Usually because TAURI_SIGNING_PRIVATE_KEY env var not set correctly"
    exit 1
}
$sigSize = (Get-Item $setupSig).Length
$sigSizeKB = [math]::Round($sigSize / 1KB, 1)
Write-OK ".sig file: $sigSizeKB KB"

$latestJsonPath = Join-Path $bundleDir "latest.json"
if (-not (Test-Path $latestJsonPath)) {
    Write-Err "latest.json not found"
    exit 1
}
Write-OK "latest.json exists"

# 4b. Check latest.json has no BOM
$bytes = [System.IO.File]::ReadAllBytes($latestJsonPath)
$first3 = "$($bytes[0]),$($bytes[1]),$($bytes[2])"
if ($bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) {
    Write-Err "latest.json has UTF-8 BOM (EF BB BF), Tauri updater will fail to parse!"
    Write-Host "  First 3 bytes: $first3 (239,187,191 = BOM)"
    exit 1
} else {
    Write-OK "latest.json no BOM (first 3 bytes: $first3)"
}

# 4c. Verify latest.json JSON parsing
try {
    $jsonContent = [System.IO.File]::ReadAllText($latestJsonPath)
    $json = $jsonContent | ConvertFrom-Json
    # version field may be stale if tauri.conf.json had wrong version when Tauri
    # generated latest.json. Fix it instead of failing.
    if ($json.version -ne $newVersion) {
        Write-Warn "latest.json version mismatch: expected $newVersion, got $($json.version) -- will fix"
        $json.version = $newVersion
    }
    if (-not $json.platforms.'windows-x86_64'.signature) {
        Write-Err "latest.json signature field empty"
        exit 1
    }
    if (-not $json.platforms.'windows-x86_64'.url) {
        Write-Err "latest.json url field empty"
        exit 1
    }
    Write-OK "latest.json JSON parsed successfully"
    Write-OK "  pub_date: $($json.pub_date)"
    Write-OK "  signature length: $($json.platforms.'windows-x86_64'.signature.Length)"
    Write-OK "  url (before fix): $($json.platforms.'windows-x86_64'.url)"

    # 4c-fix. Rewrite url AND signature fields to fix multiple issues:
    #
    # url issues (causes 404 download):
    #   1. Tauri's default url uses productName with SPACES matching the local filename.
    #      But GitHub REPLACES spaces with dots when uploading release assets.
    #      url must use GitHub asset name (dots), not local filename (spaces).
    #   2. Tauri's default url may reference the WRONG version if version bump commit
    #      failed and tauri.conf.json had a stale version when Tauri read it.
    #   3. Tauri's default url uses "/releases/latest/download/" which only works for
    #      the release GitHub marks as "latest". Use version-specific URL instead.
    #
    # signature issue (causes "signature verification failed"):
    #   Tauri generates latest.json with a signature, but if tauri.conf.json had a stale
    #   version, the signature in latest.json may be for a DIFFERENT build than the
    #   actual setup.exe. Always read signature from the .sig file that Tauri generated
    #   alongside setup.exe -- they are guaranteed to match because they're from the same
    #   build. The .sig file content IS the base64 signature to put in latest.json.
    $setupFileName = $setupExe.Name  # local filename, e.g. "HT Logistic Agent_0.1.3_x64-setup.exe"
    $githubAssetName = $setupFileName -replace ' ', '.'  # GitHub replaces spaces with dots
    $correctUrl = "https://github.com/jameszeng222/ht-logistic-workspace-v2/releases/download/v$newVersion/$githubAssetName"

    # Read signature from .sig file (guaranteed to match this build's setup.exe)
    $sigFromFile = [System.IO.File]::ReadAllText($setupSig).Trim()

    $needFix = $false
    if ($json.platforms.'windows-x86_64'.url -ne $correctUrl) {
        Write-Warn "url field needs fix:"
        Write-Host "    old: $($json.platforms.'windows-x86_64'.url)" -ForegroundColor Gray
        Write-Host "    new: $correctUrl" -ForegroundColor Green
        $json.platforms.'windows-x86_64'.url = $correctUrl
        $needFix = $true
    }
    if ($json.platforms.'windows-x86_64'.signature -ne $sigFromFile) {
        Write-Warn "signature field needs fix (latest.json had stale signature):"
        Write-Host "    old: $($json.platforms.'windows-x86_64'.signature.Substring(0, [Math]::Min(80, $json.platforms.'windows-x86_64'.signature.Length)))..." -ForegroundColor Gray
        Write-Host "    new: $($sigFromFile.Substring(0, [Math]::Min(80, $sigFromFile.Length)))..." -ForegroundColor Green
        $json.platforms.'windows-x86_64'.signature = $sigFromFile
        $needFix = $true
    }
    if ($needFix) {
        $fixedJson = $json | ConvertTo-Json -Depth 10
        [System.IO.File]::WriteAllText($latestJsonPath, $fixedJson, [System.Text.UTF8Encoding]::new($false))
        Write-OK "latest.json url+signature fixed and saved (no BOM)"
    } else {
        Write-OK "url and signature fields already correct"
    }
} catch {
    Write-Err "latest.json JSON parse failed: $_"
    exit 1
}

# 4d. Verify signature is valid base64
$sig = $json.platforms.'windows-x86_64'.signature
try {
    $sigBytes = [System.Convert]::FromBase64String($sig)
    $sigText = [System.Text.Encoding]::UTF8.GetString($sigBytes)
    if ($sigText -match 'trusted comment: signature from tauri secret key') {
        Write-OK "signature decodes to valid Tauri signature"
    } else {
        Write-Warn "signature decoded content:"
        Write-Host $sigText
    }
} catch {
    Write-Err "signature is not valid base64: $_"
    exit 1
}

# 4e. STRONG ASSERT: url and signature MUST match current build's version.
#     Prevents "latest.json points to old version setup.exe" causing 404 or
#     signature verification failure. Previously v0.1.5 release had latest.json
#     url pointing to 0.1.1 setup.exe and 0.1.1 signature.
#     Final assertion here: exit 1 if mismatch, do not allow bad release upload.
$assertUrl = $json.platforms.'windows-x86_64'.url
$assertSig = $json.platforms.'windows-x86_64'.signature
if ($assertUrl -notmatch "v$newVersion/") {
    Write-Err "ASSERT FAIL: url does not contain current version v$newVersion"
    Write-Host "  url: $assertUrl" -ForegroundColor Gray
    Write-Host "  expected url to contain: /v$newVersion/" -ForegroundColor Yellow
    Write-Err "Upload blocked! latest.json url points to wrong version, will cause 404"
    exit 1
}
if ($assertUrl -notmatch "HT[\. ]Logistic[\. ]Agent[_\.]${newVersion}[_\.]x64-setup\.exe$") {
    Write-Err "ASSERT FAIL: url does not contain current version $newVersion setup.exe filename"
    Write-Host "  url: $assertUrl" -ForegroundColor Gray
    Write-Err "Upload blocked! latest.json url points to wrong version setup.exe"
    exit 1
}
# signature decoded should contain current version setup.exe filename
# (Tauri signature format: file:HT Logistic Agent_x.x.x_x64-setup.exe)
if ($sigText -notmatch "HT Logistic Agent_${newVersion}_x64-setup\.exe") {
    Write-Err "ASSERT FAIL: signature does not contain current version $newVersion filename"
    Write-Host "  signature decoded: $sigText" -ForegroundColor Gray
    Write-Host "  expected to contain: HT Logistic Agent_${newVersion}_x64-setup.exe" -ForegroundColor Yellow
    Write-Err "Upload blocked! signature is for wrong version setup.exe, will cause verification failure"
    exit 1
}
Write-OK "ASSERT PASS: url and signature both match current version v$newVersion"

# ========== 5. Print upload checklist ==========

Write-Step "Step 5: Build complete! Upload checklist"

Write-Host ""
Write-Host "3 files to upload to GitHub Release:" -ForegroundColor Yellow
Write-Host ""

$filesToUpload = @(
    @{ Path = $setupExe.FullName; Desc = "Installer" },
    @{ Path = $setupSig; Desc = "Signature" },
    @{ Path = $latestJsonPath; Desc = "Updater manifest" }
)

foreach ($f in $filesToUpload) {
    if (Test-Path $f.Path) {
        $size = [math]::Round((Get-Item $f.Path).Length / 1MB, 2)
        Write-Host "  [$($f.Desc)] $f.Path" -ForegroundColor White
        Write-Host "          Size: $size MB" -ForegroundColor Gray
    } else {
        Write-Host "  [$($f.Desc)] $f.Path  (MISSING!)" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "GitHub Release steps:" -ForegroundColor Cyan
Write-Host "  Option A: Auto-create release via gh CLI (if installed and authenticated)"
Write-Host "  Option B: Manual upload via browser"
Write-Host ""

# 5a. Try auto-create release via gh CLI
$ghAvailable = $false
try {
    $ghVersion = (& cmd /c "gh --version 2>&1") | Out-String
    if ($LASTEXITCODE -eq 0 -and $ghVersion -match "gh version") {
        $ghAvailable = $true
    }
} catch {}

if ($ghAvailable) {
    # Check if authenticated
    # NOTE: PS 5.x parses "2>&1" inside double-quoted strings as error-stream
    # redirection. Use single-quoted string for the cmd argument to avoid this.
    $authStatus = (& cmd /c 'gh auth status 2>&1') | Out-String
    if ($authStatus -match "Logged in to github.com") {
        Write-OK "gh CLI authenticated"
        $autoRelease = Read-Host "Create GitHub Release v$newVersion and upload 3 files automatically? (Y/n)"
        if ($autoRelease -ne 'n') {
            Write-Step "Creating GitHub Release v$newVersion..."

            $setupExePath = $filesToUpload | Where-Object { $_.Desc -eq "Installer" } | Select-Object -ExpandProperty Path
            $sigPath = $filesToUpload | Where-Object { $_.Desc -eq "Signature" } | Select-Object -ExpandProperty Path
            $jsonPath = $filesToUpload | Where-Object { $_.Desc -eq "Updater manifest" } | Select-Object -ExpandProperty Path

            # Guard: if any path is empty (Desc mismatch regression), gh release create
            # would silently upload fewer files and client update would 404.
            if (-not $setupExePath -or -not $sigPath -or -not $jsonPath) {
                Write-Err "Internal error: file path missing before gh release create"
                Write-Host "  Installer path:        $setupExePath" -ForegroundColor Gray
                Write-Host "  Signature path:        $sigPath" -ForegroundColor Gray
                Write-Host "  Updater manifest path: $jsonPath" -ForegroundColor Gray
                Write-Err "Check $filesToUpload Desc fields match the Where-Object filters above."
                exit 1
            }

            # Check if release already exists, delete if so (to allow re-upload)
            $existingRelease = (& cmd /c 'gh release view {0} 2>&1' -f "v$newVersion") | Out-String
            if ($LASTEXITCODE -eq 0) {
                Write-Warn "Release v$newVersion already exists. Deleting and recreating..."
                & cmd /c 'gh release delete {0} --yes 2>&1' -f "v$newVersion" | Out-Null
            }

            # Create release with all 3 files attached.
            # Build args separately to avoid PS 5.x parsing issues with 2>&1 and
            # embedded quotes in a single double-quoted string.
            $releaseNotes = "HT Logistic Agent v$newVersion. Automated build from commit $(git rev-parse --short HEAD)."
            $createArgs = @('release', 'create', "v$newVersion", $setupExePath, $sigPath, $jsonPath,
                            '--title', "HT Logistic Agent v$newVersion", '--notes', $releaseNotes)
            & gh @createArgs 2>&1 | Out-String | ForEach-Object { Write-Host $_ -ForegroundColor Gray }
            $createExit = $LASTEXITCODE

            if ($createExit -eq 0) {
                Write-OK "Release v$newVersion created and 3 files uploaded!"
                Write-Host ""
                Write-Host "Client 'Check for updates' will now get v$newVersion." -ForegroundColor Green

                # Push version bump commit (since release is published)
                if (-not $SkipVersionBump) {
                    Write-Host "Pushing version bump commit..." -ForegroundColor Gray
                    & git push origin main 2>&1 | Out-String | Write-Host
                    if ($LASTEXITCODE -eq 0) {
                        Write-OK "Version bump pushed. Repo in sync with released v$newVersion."
                    }
                }

                # Open bundle folder for reference
                $openFolder = Read-Host "Open bundle folder in explorer? (y/N)"
                if ($openFolder -eq 'y') {
                    Start-Process explorer.exe -ArgumentList $bundleDir
                }

                Write-Host ""
                Write-Host "================================================" -ForegroundColor Green
                Write-Host "  All done! Release v$newVersion is live." -ForegroundColor Green
                Write-Host "================================================" -ForegroundColor Green
                exit 0
            } else {
                Write-Err "gh release create failed:"
                Write-Host $result -ForegroundColor Red
                Write-Host "Falling back to manual upload." -ForegroundColor Yellow
            }
        }
    } else {
        Write-Warn "gh CLI installed but not authenticated. Run: gh auth login"
    }
} else {
    Write-Host "  (gh CLI not installed, skipping auto-release)" -ForegroundColor Gray
}

# Fallback: manual upload via browser
Write-Host ""
Write-Host "Manual upload required. Files to upload:" -ForegroundColor Cyan
foreach ($f in $filesToUpload) {
    if (Test-Path $f.Path) {
        $size = [math]::Round((Get-Item $f.Path).Length / 1MB, 2)
        Write-Host "  [$($f.Desc)] $($f.Path) (${size} MB)" -ForegroundColor White
    } else {
        Write-Host "  [$($f.Desc)] $f.Path  (MISSING!)" -ForegroundColor Red
    }
}
Write-Host ""
Write-Host "  1. Open: https://github.com/jameszeng222/ht-logistic-workspace-v2/releases/new" -ForegroundColor Gray
Write-Host "  2. Tag: v$newVersion  (must match version)" -ForegroundColor Gray
Write-Host "  3. Title: HT Logistic Agent v$newVersion" -ForegroundColor Gray
Write-Host "  4. Upload the 3 files above" -ForegroundColor Gray
Write-Host "  5. Publish release" -ForegroundColor Gray
Write-Host ""

# 5a. Auto open bundle folder
$openFolder = Read-Host "Open bundle folder in explorer? (Y/n)"
if ($openFolder -ne 'n') {
    Start-Process explorer.exe -ArgumentList $bundleDir
}

# 5b. Auto open GitHub Release page
$openGitHub = Read-Host "Open GitHub Release create page? (Y/n)"
if ($openGitHub -ne 'n') {
    Start-Process "https://github.com/jameszeng222/ht-logistic-workspace-v2/releases/new"
}

# 5c. Push version bump commit to remote (so repo version stays in sync).
#     Auto-push -- build and release both succeeded, version bump must sync to remote,
#     otherwise next clone will have a stale remote version and bump to the same
#     version number again (the stuck-at-0.1.4 problem).
if (-not $SkipVersionBump) {
    Write-Host "Pushing version bump commit to remote..." -ForegroundColor Gray
    & cmd /c "git push origin main 2>&1" | Out-String | Write-Host
    if ($LASTEXITCODE -eq 0) {
        Write-OK "Version bump pushed. Repo now in sync with released v$newVersion."
    } else {
        Write-Warn "Push failed (exit $LASTEXITCODE). Push manually after upload: git push origin main"
    }
}

Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "  All done!" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
