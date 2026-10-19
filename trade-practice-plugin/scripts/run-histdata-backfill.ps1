param(
    [string]$Workspace = (Join-Path $PSScriptRoot "..\.." | Resolve-Path),
    [ValidateSet("XAUUSD", "GBPUSD")]
    [string]$Pair = "XAUUSD",
    [int]$FromYear = 2020,
    [int]$ToYear = 0
)

$ErrorActionPreference = "Stop"
$script = Join-Path $PSScriptRoot "fetch_m1.py"
$argsList = @(
    $script,
    "--workspace", $Workspace,
    "--histdata",
    "--pair", $Pair,
    "--from-year", $FromYear
)
if ($ToYear -gt 0)
{
    $argsList += @("--to-year", $ToYear)
}
Write-Host "HistData → DSH 分月 CSV: $Pair $FromYear .. $(if ($ToYear -gt 0) { $ToYear } else { '今年' })"
Write-Host "数据目录: $Workspace\.trade-practice\data\$Pair\1m\YYYY-MM.csv"
& python @argsList
