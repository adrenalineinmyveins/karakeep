# Add registry mirror to daemon.json, restart Docker, test BuildKit
Set-Location $PSScriptRoot
$O = @()
# Update daemon.json with registry mirrors
$Daemon = "$env:USERPROFILE\.docker\daemon.json"
$Content = @"
{
  "builder": {
    "gc": {
      "defaultKeepStorage": "20GB",
      "enabled": true
    }
  },
  "experimental": false,
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://docker.1panel.live"
  ]
}
"@
$Content | Set-Content -Encoding ascii $Daemon
$O += "daemon.json updated with registry mirrors"
# Restart Docker
$Names = @('docker','docker-buildx','com.docker.build','Docker Desktop','com.docker.backend','docker-agent')
foreach ($N in $Names) {
  $Procs = Get-Process -Name $N -ErrorAction SilentlyContinue
  foreach ($P2 in $Procs) { Stop-Process -Id $P2.Id -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Seconds 3
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
if ($Ready) {
  $O += "---- driver + mirror check ----"
  docker info 2>&1 | Select-String "driver|Registry" | ForEach-Object { $O += $_.Line.Trim() }
  # Start buildx build (not legacy)
  $O += "---- starting buildx build ----"
  Remove-Item build-mir-out.log, build-mir-err.log -ErrorAction SilentlyContinue
  $BP = Start-Process -FilePath "docker" -ArgumentList 'build','-f','docker/Dockerfile','--target','aio','-t','docker-web:latest','.docker-ctx' -RedirectStandardOutput build-mir-out.log -RedirectStandardError build-mir-err.log -WindowStyle Hidden -PassThru
  $O += "BUILD_PID=$($BP.Id)"
}
$O | Set-Content -Encoding ascii .tmp-mir.txt
"MIR_DONE" | Add-Content -Encoding ascii .tmp-mir.txt
