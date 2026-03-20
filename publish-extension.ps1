<#
.SYNOPSIS
    Automates the release process for Komfy Bridge Extension.

.DESCRIPTION
    This script automates the version release process by:
    1. Reading version from manifest.json (next mode) or using specified version
    2. Creating a ZIP package with all extension files + modules/
    3. Committing and pushing changes
    4. Creating a GitHub Release with the ZIP as an asset

    MODES:
    - next [comment]: Use version from manifest.json and publish release
    - (version) [comment]: Specify exact version to publish
    - -d (version): Delete a tag/release locally and remotely

.EXAMPLE
    .\publish-extension.ps1 next "Added Grok support"
    .\publish-extension.ps1 next
    .\publish-extension.ps1 2.1.0 "Fixed model selection"
    .\publish-extension.ps1 -d 2.1.0
#>

param (
    [Parameter(Mandatory=$false)]
    [Alias("d")]
    [Switch]$Delete,

    [Parameter(Mandatory=$true, Position=0)]
    [string]$Version,

    [Parameter(Mandatory=$false, Position=1)]
    [string]$Comment = "Extension update"
)

$ErrorActionPreference = "Stop"

$REPO_OWNER = "tuyenhm68"
$REPO_NAME  = "komfy-extension"
$GITHUB_API = "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME"

$EXTENSION_FILES = @(
    "background.js",
    "content.js",
    "content_fetch_interceptor.js",
    "content_isolated.js",
    "content_main.js",
    "inject.js",
    "manifest.json",
    "popup.html",
    "popup.js",
    "icon-16.png",
    "icon-32.png",
    "icon-48.png",
    "icon-128.png"
)

function Get-GitHubToken {
    try {
        $result = echo "url=https://github.com" | git credential fill 2>$null
        $token = ($result | Where-Object { $_ -match "^password=" }) -replace "^password=", ""
        if ($token) { return $token }
    } catch {}
    if ($env:GITHUB_TOKEN) { return $env:GITHUB_TOKEN }
    if ($env:GH_TOKEN) { return $env:GH_TOKEN }
    return $null
}

# --- Resolve Version ---
$IsNextMode = $false

if ($Version -eq "next") {
    $IsNextMode = $true
    # Read version directly from manifest.json (source of truth during dev)
    $mPath = "manifest.json"
    if (-not (Test-Path $mPath)) {
        Write-Error "manifest.json not found in current directory."
        exit 1
    }
    $mData = Get-Content $mPath -Raw | ConvertFrom-Json
    $VersionNum = $mData.version
    if (-not $VersionNum) {
        Write-Error "No version field in manifest.json"
        exit 1
    }
    $VersionTag = "v$VersionNum"
    Write-Host "Version from manifest.json: $VersionTag" -ForegroundColor Cyan
} else {
    if ($Version -match "^v?(\d+\.\d+\.\d+)$") {
        $VersionNum = $matches[1]
        $VersionTag = "v$VersionNum"
    } else {
        Write-Error "Invalid version. Use semantic versioning or 'next'."
        exit 1
    }
}

# --- DELETE MODE ---
if ($Delete) {
    Write-Host ""
    Write-Host "DELETING release: $VersionTag" -ForegroundColor Red
    git tag -d $VersionTag 2>$null; $null = $LASTEXITCODE
    git push origin --delete $VersionTag 2>$null; $null = $LASTEXITCODE

    $token = Get-GitHubToken
    if ($token) {
        try {
            $h = @{ Authorization = "Bearer $token"; Accept = "application/vnd.github.v3+json"; "User-Agent" = "KomfyStudio" }
            $rel = Invoke-RestMethod -Uri "$GITHUB_API/releases/tags/$VersionTag" -Headers $h -ErrorAction SilentlyContinue
            if ($rel.id) {
                Invoke-RestMethod -Uri "$GITHUB_API/releases/$($rel.id)" -Method Delete -Headers $h
                Write-Host "  GitHub Release deleted" -ForegroundColor Yellow
            }
        } catch {
            Write-Warning "  Could not delete GitHub Release"
        }
    }
    Write-Host "Done!" -ForegroundColor Green
    exit 0
}

# --- RELEASE MODE ---
Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  Komfy Bridge Extension Release" -ForegroundColor Cyan
Write-Host "  Version: $VersionTag" -ForegroundColor White
Write-Host "  Comment: $Comment" -ForegroundColor Gray
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Update manifest.json
if ($IsNextMode) {
    Write-Host "[1/5] manifest.json already at v$VersionNum" -ForegroundColor DarkGray
} else {
    Write-Host "[1/5] Updating manifest.json..." -ForegroundColor Yellow
    $mPath = "manifest.json"
    $mRaw = Get-Content $mPath -Raw
    $mObj = $mRaw | ConvertFrom-Json
    $oldVer = $mObj.version
    $dq = [char]34
    $findStr = $dq + 'version' + $dq + ':  ' + $dq + $oldVer + $dq
    $replStr = $dq + 'version' + $dq + ':  ' + $dq + $VersionNum + $dq
    $mRaw = $mRaw.Replace($findStr, $replStr)
    Set-Content $mPath -Value $mRaw -Encoding UTF8 -NoNewline
    Write-Host "  OK: $oldVer -> $VersionNum" -ForegroundColor Green
}

# Step 2: Create ZIP
Write-Host "[2/5] Creating ZIP package..." -ForegroundColor Yellow
$zipName = "v$VersionNum.zip"
$zipPath = Join-Path $env:TEMP $zipName
$stagingDir = Join-Path $env:TEMP "komfy-ext-staging"

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
if (Test-Path $stagingDir) { Remove-Item $stagingDir -Recurse -Force }
New-Item -Path $stagingDir -ItemType Directory -Force | Out-Null

$fileCount = 0
$EXTENSION_FILES | ForEach-Object {
    $fp = Join-Path (Get-Location) $_
    if (Test-Path $fp) {
        Copy-Item $fp -Destination $stagingDir
        $fileCount++
    } else {
        Write-Warning "  Missing: $_"
    }
}

# Include modules/ directory
$modulesDir = Join-Path (Get-Location) "modules"
if (Test-Path $modulesDir) {
    $destModules = Join-Path $stagingDir "modules"
    Copy-Item $modulesDir -Destination $destModules -Recurse
    $modFiles = Get-ChildItem $destModules -File
    $fileCount += $modFiles.Count
    Write-Host "  Included modules/: $($modFiles.Count) files" -ForegroundColor DarkGray
}

Compress-Archive -Path "$stagingDir\*" -DestinationPath $zipPath -Force
Remove-Item $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
$zipSize = [math]::Round((Get-Item $zipPath).Length / 1024, 1)
$zipInfo = "  OK: " + $zipName + " - " + $zipSize + " KB, " + $fileCount + " files"
Write-Host $zipInfo -ForegroundColor Green

# Step 3: Git operations
Write-Host "[3/5] Git commit + tag + push..." -ForegroundColor Yellow

git add .
$commitMsg = "release: v$VersionNum - $Comment"
git commit -m $commitMsg 2>$null

git push origin main
if ($LASTEXITCODE -ne 0) { throw "Git push failed" }
Write-Host "  OK: Pushed to main" -ForegroundColor Green

git tag -a $VersionTag -m "Release $VersionTag - $Comment"
if ($LASTEXITCODE -ne 0) { throw "Tag creation failed" }

git push origin $VersionTag
if ($LASTEXITCODE -ne 0) { throw "Tag push failed" }
Write-Host "  OK: Tag $VersionTag pushed" -ForegroundColor Green

# Step 4: Create GitHub Release
Write-Host "[4/5] Creating GitHub Release..." -ForegroundColor Yellow

$token = Get-GitHubToken
if (-not $token) {
    Write-Host ""
    Write-Host "================================================" -ForegroundColor Yellow
    Write-Host "  No GitHub token. Create release manually:" -ForegroundColor Yellow
    Write-Host "  https://github.com/$REPO_OWNER/$REPO_NAME/releases/new" -ForegroundColor White
    Write-Host "  Tag: $VersionTag" -ForegroundColor White
    Write-Host "  Upload: $zipPath" -ForegroundColor White
    Write-Host "================================================" -ForegroundColor Yellow
    exit 0
}

$headers = @{
    Authorization = "Bearer $token"
    Accept = "application/vnd.github.v3+json"
    "User-Agent" = "KomfyStudio"
}

$releaseNotes = "Komfy Bridge v$VersionNum - $Comment"
$releaseData = @{
    tag_name = $VersionTag
    name = "v$VersionNum - $Comment"
    body = $releaseNotes
    draft = $false
    prerelease = $false
} | ConvertTo-Json -Compress

try {
    $release = Invoke-RestMethod -Uri "$GITHUB_API/releases" -Method Post -Body $releaseData -ContentType "application/json" -Headers $headers
    Write-Host "  OK: Release created - $($release.html_url)" -ForegroundColor Green
} catch {
    Write-Error "Failed to create release: $_"
    Write-Host "Create manually: https://github.com/$REPO_OWNER/$REPO_NAME/releases/new" -ForegroundColor Yellow
    exit 1
}

# Step 5: Upload ZIP asset
Write-Host "[5/5] Uploading ZIP asset..." -ForegroundColor Yellow
$braceChar = [char]0x7B
$rawUrl = [string]$release.upload_url
$uploadUrl = $rawUrl.Split($braceChar)[0] + "?name=$zipName"

try {
    $zipBytes = [System.IO.File]::ReadAllBytes($zipPath)
    $uploadHeaders = @{
        Authorization = "Bearer $token"
        Accept = "application/vnd.github.v3+json"
        "Content-Type" = "application/zip"
        "User-Agent" = "KomfyStudio"
    }
    $asset = Invoke-RestMethod -Uri $uploadUrl -Method Post -Body $zipBytes -Headers $uploadHeaders
    Write-Host "  OK: Uploaded - $($asset.browser_download_url)" -ForegroundColor Green
} catch {
    Write-Warning "Failed to upload ZIP: $_"
    Write-Host "Upload manually at: $($release.html_url)" -ForegroundColor Yellow
}

Remove-Item $zipPath -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "  Release v$VersionNum published!" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  https://github.com/$REPO_OWNER/$REPO_NAME/releases/tag/$VersionTag" -ForegroundColor Cyan
Write-Host "  Komfy Studio will auto-download on next startup." -ForegroundColor Gray
Write-Host ""
