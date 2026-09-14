# 重启 Docker Desktop 清除 containerd 卡死状态
Set-Location $PSScriptRoot
$O = @()
$Names = @('docker','docker-buildx','com.docker.build','Docker Desktop','com.docker.backend','docker-agent')
foreach ($N in $Names) {
  $Procs = Get-Process -Name $N -ErrorAction SilentlyContinue
  foreach ($P2 in $Procs) {
    Stop-Process -Id $P2.Id -Force -ErrorAction SilentlyContinue
    $O += "stopped $N pid=$($P2.Id)"
  }
}
Start-Sleep -Seconds 5
$Left = Get-Process | Where-Object { $_.ProcessName -match 'docker|vmmem' }
foreach ($X in $Left) { $O += "left: $($X.Id) $($X.ProcessName)" }
$O | Set-Content -Encoding ascii .tmp-rd.txt
"RD_STEP1_DONE" | Add-Content -Encoding ascii .tmp-rd.txt
