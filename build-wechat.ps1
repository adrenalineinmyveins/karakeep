# 用干净 context 构建镜像（tag 必须与 compose 默认名一致：docker-web）
Set-Location $PSScriptRoot
docker build -f docker/Dockerfile --target aio -t docker-web:latest .docker-ctx *> docker-build-wechat.log
"BUILD_EXIT=$LASTEXITCODE" | Add-Content -Encoding ascii docker-build-wechat.log
