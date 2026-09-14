# Hard reset WSL, start Docker Desktop, poll daemon ready, then regression-test container cleanup
Set-Location $PSScriptRoot
$O = @()
wsl --shutdown 2>&1 | ForEach-Object { $O += "wsl: $_" }
Start-Sleep -Seconds 8
$O += "---- starting Docker Desktop ----"
Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
$Ready = $false
for ($I = 1; $I -le 36; $I++) {
  Start-Sleep -Seconds 5
  docker version --format "ok" 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { $O += "daemon ready after $($I*5)s"; $Ready = $true; break }
}
if (-not $Ready) { $O += "daemon NOT ready in 180s" }
if ($Ready) {
  $P = Start-Process -FilePath "docker" -ArgumentList 'run','--rm','alpine:latest','true' -RedirectStandardOutput .tmp-rd-out.txt -RedirectStandardError .tmp-rd-err.txt -WindowStyle Hidden -PassThru
  if ($P.WaitForExit(45000)) { $O += "docker run --rm exit=$($P.ExitCode) cleanup-OK" }
  else { $O += "docker run --rm STILL-TIMEOUT wedge-not-cleared"; Stop-Process -Id $P.Id -Force -ErrorAction SilentlyContinue }
}
$O | Set-Content -Encoding ascii .tmp-start.txt
"START_DONE" | Add-Content -Encoding ascii .tmp-start.txt
