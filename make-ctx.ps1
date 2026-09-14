# 生成干净的 docker build context（仅 git 追踪+未忽略的未跟踪文件）
# 避开工作区里并行构建产生的大量产物（context 曾达 567MB+ 且传输卡死）
Set-Location $PSScriptRoot
git -c core.quotepath=false ls-files --cached --others --exclude-standard | Where-Object { $_ -notmatch '\.(log|txt)$' -and $_ -notmatch '^apps/mobile/' } | Out-File -Encoding ascii .docker-filelist.txt -Width 32768
"$((Get-Content .docker-filelist.txt).Count) files listed" | Write-Host
if (Test-Path .docker-ctx) { Remove-Item -Recurse -Force .docker-ctx }
New-Item -ItemType Directory .docker-ctx | Out-Null
# bsdtar（Windows 自带）按清单打包再解包，秒级完成且保留正斜杠路径
tar -cf .docker-ctx.tar -T .docker-filelist.txt
tar -xf .docker-ctx.tar -C .docker-ctx
Remove-Item .docker-ctx.tar
"context size MB: " + [math]::Round(((Get-ChildItem .docker-ctx -Recurse -File | Measure-Object Length -Sum).Sum)/1MB,1) | Write-Host
"CTX_DONE" | Add-Content -Encoding ascii .docker-ctx-done.txt
