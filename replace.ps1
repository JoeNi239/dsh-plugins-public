[CmdletBinding()]
param(
  [string]$Workspace = (Get-Location).Path,
  [string]$RepoUrl = 'https://github.com/JoeNi239/dsh-plugins-public',
  [string]$ProfilesRoot = (Join-Path $env:USERPROFILE '.dsh\profiles'),
  [string]$FromZip,
  [switch]$SkipData,
  [switch]$SkipPip,
  [switch]$SkipInstall,
  [switch]$SkipReload,
  [switch]$KeepTemp
)

$ErrorActionPreference = 'Stop'

function Step([string]$text) { Write-Host "==> $text" }

if (-not (Test-Path $Workspace)) { throw "工作区不存在：$Workspace" }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $Workspace ".plugin-backup\$stamp"
$tempRoot = Join-Path $env:TEMP "dsh-plugins-$stamp"
$zipPath = Join-Path $env:TEMP "dsh-plugins-$stamp.zip"

Step "准备插件包"
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
if ($FromZip) {
  if (-not (Test-Path $FromZip)) { throw "找不到本地 zip：$FromZip" }
  Step "使用本地 zip $FromZip"
  Copy-Item $FromZip $zipPath -Force
} else {
  Step "下载 $RepoUrl/archive/refs/heads/main.zip"
  Invoke-WebRequest -Uri "$RepoUrl/archive/refs/heads/main.zip" -OutFile $zipPath -UseBasicParsing
}
Expand-Archive -Path $zipPath -DestinationPath $tempRoot -Force
$source = Get-ChildItem $tempRoot -Directory | Select-Object -First 1
if (-not $source) { throw '解压后没有找到仓库目录' }
Step "解压到 $($source.FullName)"

$names = @('trade-practice-plugin', 'pdf-reader-plugin')
foreach ($name in $names) {
  if (-not (Test-Path (Join-Path $source.FullName $name))) { throw "压缩包缺少 $name" }
}

# 备份旧版本（保留可回滚）
$existing = @($names | Where-Object { Test-Path (Join-Path $Workspace $_) })
if ($existing.Count -gt 0) {
  New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
  foreach ($name in $existing) {
    Step "备份旧插件 $name -> $backupRoot"
    Move-Item (Join-Path $Workspace $name) (Join-Path $backupRoot $name) -Force
  }
}

try {
  foreach ($name in $names) {
    Step "安装 $name"
    Copy-Item (Join-Path $source.FullName $name) (Join-Path $Workspace $name) -Recurse -Force
  }
  foreach ($file in @('setup.ps1', 'README.md', 'ONE-PROMPT.md')) {
    $from = Join-Path $source.FullName $file
    if (Test-Path $from) { Copy-Item $from (Join-Path $Workspace $file) -Force }
  }
} catch {
  if (Test-Path $backupRoot) {
    Step '安装失败，恢复旧版本'
    foreach ($name in $existing) {
      Remove-Item (Join-Path $Workspace $name) -Recurse -Force -ErrorAction SilentlyContinue
      Move-Item (Join-Path $backupRoot $name) (Join-Path $Workspace $name) -Force
    }
  }
  throw
}

Step '运行 setup.ps1（注册插件 / pnpm install / 行情数据 / PyMuPDF）'
$setupArgs = @('-RepoRoot', $Workspace, '-ProfilesRoot', $ProfilesRoot)
if ($SkipData) { $setupArgs += '-SkipData' }
if ($SkipPip) { $setupArgs += '-SkipPip' }
if ($SkipInstall) { $setupArgs += '-SkipInstall' }
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Workspace 'setup.ps1') @setupArgs

if (-not $SkipReload) {
  Step '触发 DSH 插件热重载'
  $patches = @()
  if (Test-Path $ProfilesRoot) {
    $patches = Get-ChildItem $ProfilesRoot -Directory | ForEach-Object { Join-Path $_.FullName 'cordis.patch.yml' } |
      Where-Object { Test-Path $_ }
  }
  if (-not $patches) {
    Write-Warning '没有找到 profile 的 cordis.patch.yml，请手动重启 DSH。'
  } else {
    foreach ($patch in $patches) {
      $original = [System.IO.File]::ReadAllBytes($patch)
      $marker = "`n# dsh-plugins reload $stamp`n"
      [System.IO.File]::AppendAllText($patch, $marker, (New-Object System.Text.UTF8Encoding($false)))
      Start-Sleep -Seconds 4
      [System.IO.File]::WriteAllBytes($patch, $original)
    }
    Write-Host '    已触发重载；如果界面还是旧版，重启一次 DSH 即可。'
  }
}

if (-not $KeepTemp) {
  Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host '完成。' -ForegroundColor Green
if ($existing.Count -gt 0) { Write-Host "旧版本备份：$backupRoot" }
Write-Host '检查：GET /trade-practice/health 与 GET /pdf-reader/health 都应返回 ok:true'
