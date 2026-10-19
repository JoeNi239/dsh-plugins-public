[CmdletBinding()]
param(
  [string]$RepoRoot,
  [string]$ProfilesRoot = (Join-Path $env:USERPROFILE '.dsh\profiles'),
  [switch]$DryRun,
  [switch]$SkipPip,
  [switch]$SkipInstall,
  [switch]$SkipData
)

$ErrorActionPreference = 'Stop'

if (-not $RepoRoot) { $RepoRoot = $PSScriptRoot }
if (-not $RepoRoot) { throw '无法确定仓库目录，请用 -RepoRoot 指定' }

function Step([string]$text) { Write-Host "==> $text" }

$tradeRoot = Join-Path $RepoRoot 'trade-practice-plugin'
$pdfRoot = Join-Path $RepoRoot 'pdf-reader-plugin'
foreach ($dir in @($tradeRoot, $pdfRoot)) {
  if (-not (Test-Path (Join-Path $dir 'package.json'))) { throw "找不到插件目录：$dir" }
}

$entries = @(
  @{ Name = '@local/trade-practice'; Path = $tradeRoot },
  @{ Name = '@local/pdf-reader'; Path = $pdfRoot }
)

if (-not (Test-Path $ProfilesRoot)) {
  throw "找不到 DSH profile 目录：$ProfilesRoot（先启动一次 DSH 再运行本脚本）"
}
$profiles = Get-ChildItem $ProfilesRoot -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'package.json') }
if (-not $profiles) { throw "在 $ProfilesRoot 下没有找到含 package.json 的 profile" }

function Get-Pnpm {
  $cmd = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($cmd) { return @{ Exe = $cmd.Source; Args = @() } }
  $runtime = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'
  if (-not (Test-Path $runtime)) { return $null }
  $node = Get-ChildItem $runtime -Recurse -Filter node.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\dependencies\\node\\bin\\node\.exe$' } | Select-Object -First 1
  $pnpm = Get-ChildItem $runtime -Recurse -Filter pnpm.mjs -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\pnpm\\bin\\pnpm\.mjs$' } | Select-Object -First 1
  if ($node -and $pnpm) { return @{ Exe = $node.FullName; Args = @($pnpm.FullName) } }
  return $null
}

foreach ($profile in $profiles) {
  $pkgPath = Join-Path $profile.FullName 'package.json'
  Step "profile: $($profile.FullName)"
  $pkg = Get-Content $pkgPath -Raw -Encoding utf8 | ConvertFrom-Json

  if (-not $pkg.PSObject.Properties['dependencies']) {
    $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
  }
  foreach ($entry in $entries) {
    $link = 'link:' + ($entry.Path -replace '\\', '/')
    $pkg.dependencies | Add-Member -NotePropertyName $entry.Name -NotePropertyValue $link -Force
    Write-Host "    dependencies: $($entry.Name) -> $link"
  }

  if (-not $pkg.PSObject.Properties['dsh']) {
    $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{})
  }
  if (-not $pkg.dsh.PSObject.Properties['profile']) {
    $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{})
  }
  if (-not $pkg.dsh.profile.PSObject.Properties['bundles']) {
    $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @()
  }
  $bundles = @($pkg.dsh.profile.bundles)
  foreach ($entry in $entries) {
    if ($bundles -notcontains $entry.Name) {
      $bundles += $entry.Name
      Write-Host "    bundles: + $($entry.Name)"
    }
  }
  $pkg.dsh.profile.bundles = @($bundles)

  if ($DryRun) { continue }
  $json = $pkg | ConvertTo-Json -Depth 32
  # UTF-8 without BOM: DSH parses package.json with JSON.parse.
  [System.IO.File]::WriteAllText($pkgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "    已写入 $pkgPath"
}

if (-not $SkipInstall -and -not $DryRun) {
  $pnpm = Get-Pnpm
  if (-not $pnpm) {
    Write-Warning '没有找到 pnpm；若重启后插件未加载，请在 profile 目录执行 pnpm install。'
  } else {
    foreach ($profile in $profiles) {
      Step "pnpm install @ $($profile.Name)"
      Push-Location $profile.FullName
      try {
        & $pnpm.Exe @($pnpm.Args + @('install'))
        if ($LASTEXITCODE -ne 0) { Write-Warning "pnpm install 退出码 $LASTEXITCODE" }
      } finally {
        Pop-Location
      }
    }
  }
}

function Get-DataRoot {
  # Trade Practice resolves its CSV directory from the active DSH workspace, so
  # data must live there even when this repo was cloned somewhere else.
  $store = Join-Path $env:USERPROFILE '.dsh\storages\workspace.json'
  if (Test-Path $store) {
    try {
      $data = Get-Content $store -Raw -Encoding utf8 | ConvertFrom-Json
      $defaultId = $data.global.defaultWorkspaceId
      $workspaces = $data.tables.workspaces
      $chosen = $null
      if ($defaultId -and $workspaces.PSObject.Properties[$defaultId]) {
        $chosen = $workspaces.PSObject.Properties[$defaultId].Value
      }
      if (-not $chosen) {
        $first = $workspaces.PSObject.Properties | Select-Object -First 1
        if ($first) { $chosen = $first.Value }
      }
      if ($chosen -and $chosen.path -and (Test-Path $chosen.path)) {
        return (Join-Path $chosen.path '.trade-practice\data')
      }
    } catch { }
  }
  return (Join-Path $RepoRoot '.trade-practice\data')
}

if (-not $SkipData -and -not $DryRun) {
  $dataDir = Get-DataRoot
  if (Test-Path (Join-Path $dataDir 'XAUUSD')) {
    Step "行情数据已存在，跳过下载（$dataDir）"
  } else {
    Step '下载行情数据 trade-practice-data.zip（约 52 MB）'
    $zip = Join-Path $env:TEMP 'trade-practice-data.zip'
    $url = 'https://github.com/JoeNi239/dsh-plugins-public/releases/download/data-v1/trade-practice-data.zip'
    try {
      Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
      New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
      Expand-Archive -Path $zip -DestinationPath $dataDir -Force
      Remove-Item $zip -Force -ErrorAction SilentlyContinue
      Write-Host "    已解压到 $dataDir"
    } catch {
      Write-Warning "行情数据下载失败：$($_.Exception.Message)；可稍后在面板点「更新数据」，或手动下载：$url"
    }
  }
}

if (-not $SkipPip -and -not $DryRun) {
  Step '安装 PyMuPDF'
  $installed = $false
  foreach ($python in @('py', 'python')) {
    $cmd = Get-Command $python -ErrorAction SilentlyContinue
    if (-not $cmd) { continue }
    try {
      & $cmd.Source -m pip install --quiet --disable-pip-version-check pymupdf
      if ($LASTEXITCODE -eq 0) { $installed = $true; break }
    } catch { }
  }
  if (-not $installed) { Write-Warning 'PyMuPDF 安装失败，请手动执行：py -m pip install pymupdf' }
}

if ($DryRun) {
  Write-Host ''
  Write-Host 'dry run：以上为将要写入的改动，未修改任何文件。'
  return
}

Write-Host ''
Write-Host '完成。请重启 DeepSeek Harness，然后检查：' -ForegroundColor Green
Write-Host '  - 左侧栏底部出现「PDF 阅读」'
Write-Host '  - 主面板打开 Trade Practice，图表有 XAUUSD/GBPUSD 历史数据'
