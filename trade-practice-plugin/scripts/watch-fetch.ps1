$Workspace = "C:\Users\joe\Documents\deepseek-harness\default-workspace"
$State = Join-Path $Workspace ".trade-practice\state\XAUUSD-1m-fetch.json"
$Log = Join-Path $Workspace ".trade-practice\logs\XAUUSD-1m-fetch.log"
while ($true) {
  Clear-Host
  Write-Host "=== XAUUSD 1m HistData fetch ===" (Get-Date -Format "HH:mm:ss")
  if (Test-Path $State) { Get-Content $State -Raw | ConvertFrom-Json | Format-List }
  else {
    Write-Host "No state file yet. Start:"
    Write-Host "  powershell -File scripts/run-histdata-backfill.ps1 -Workspace $Workspace -Pair XAUUSD -FromYear 2020"
  }
  if (Test-Path $Log) { Write-Host "`n--- log tail ---"; Get-Content $Log -Tail 8 }
  Start-Sleep -Seconds 5
}
