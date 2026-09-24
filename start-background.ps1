# Launches the bot detached, so it keeps running after this window closes.
# Logs to bot.log next to this script.
#
#   powershell -ExecutionPolicy Bypass -File start-background.ps1
#
# To stop it:  Get-Content bot.pid | ForEach-Object { Stop-Process -Id $_ }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

if (-not (Test-Path ".env")) {
  Write-Error "No .env file. Copy .env.example to .env and fill it in first."
  exit 1
}

if (Test-Path "bot.pid") {
  $old = Get-Content "bot.pid"
  $running = Get-Process -Id $old -ErrorAction SilentlyContinue
  if ($running) {
    Write-Host "Already running (PID $old). Stop it first, or delete bot.pid if that's stale."
    exit 1
  }
}

$proc = Start-Process -FilePath "node" `
  -ArgumentList "src/index.js" `
  -WorkingDirectory $here `
  -RedirectStandardOutput "bot.log" `
  -RedirectStandardError "bot.err.log" `
  -WindowStyle Hidden `
  -PassThru

$proc.Id | Out-File -FilePath "bot.pid" -Encoding ascii

Write-Host "Started (PID $($proc.Id)). Logs: bot.log / bot.err.log"
Write-Host "Stop it with: Get-Content bot.pid | ForEach-Object { Stop-Process -Id `$_ }"
