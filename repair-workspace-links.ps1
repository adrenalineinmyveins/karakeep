﻿# 修复 pnpm workspace 包的 junction 链接（Windows）
#
# 适用场景：pnpm install 中断（进程被杀/被沙箱拦截）后，node_modules 里的 workspace 包
# 链接丢失或残留空目录，导致工具报错，例如：
#   - vitest:  Failed to resolve import "@karakeep/shared/concurrency"
#   - vite:    failed to resolve "extends":"@karakeep/tsconfig/node.json"
#
# 处理规则（幂等，可重复运行）：
#   - 链接已存在且指向正确            -> OK 跳过
#   - 链接指向错误目标 / 已悬空       -> 删除重建
#   - 链接位置是空目录（install 残留） -> 删除后建链接
#   - 链接位置是非空普通目录          -> 警告跳过（可能是 pnpm 的合法产物，不动它）
#
# 注意：本脚本只是快速恢复手段；根本修复是在无拦截的终端完整执行一次 pnpm install。
#
# 用法：powershell -ExecutionPolicy Bypass -File repair-workspace-links.ps1

$ErrorActionPreference = "Stop"
$repo = $PSScriptRoot

# 链接位置（相对仓库根） -> 真实包目录（相对仓库根）
$links = [ordered]@{
  # 根 node_modules：hoisted 提升层
  "node_modules\@karakeep\api"           = "packages\api"
  "node_modules\@karakeep\db"            = "packages\db"
  "node_modules\@karakeep\open-api"      = "packages\open-api"
  "node_modules\@karakeep\plugins"       = "packages\plugins"
  "node_modules\@karakeep\sdk"           = "packages\sdk"
  "node_modules\@karakeep\shared"        = "packages\shared"
  "node_modules\@karakeep\shared-react"  = "packages\shared-react"
  "node_modules\@karakeep\shared-server" = "packages\shared-server"
  "node_modules\@karakeep\trpc"          = "packages\trpc"
  "node_modules\@karakeep\tsconfig"      = "tooling\typescript"
  # apps/web：web 的直接依赖解析层
  "apps\web\node_modules\@karakeep\api"            = "packages\api"
  "apps\web\node_modules\@karakeep\db"             = "packages\db"
  "apps\web\node_modules\@karakeep\shared"         = "packages\shared"
  "apps\web\node_modules\@karakeep\shared-react"   = "packages\shared-react"
  "apps\web\node_modules\@karakeep\shared-server"  = "packages\shared-server"
  "apps\web\node_modules\@karakeep\trpc"           = "packages\trpc"
  "apps\web\node_modules\@karakeep\tailwind-config" = "tooling\tailwind"
  "apps\web\node_modules\@karakeep\tsconfig"       = "tooling\typescript"
}

function Remove-LinkSafe([string]$path) {
  # 用 rmdir 删除 junction/空目录：只删链接本身，绝不穿透删除目标内容
  cmd /c rmdir "$path" | Out-Null
  return -not (Test-Path $path)
}

$ok = 0; $fixed = 0; $warn = 0; $err = 0

foreach ($entry in $links.GetEnumerator()) {
  $linkRel = $entry.Key
  $targetRel = $entry.Value
  $link = Join-Path $repo $linkRel
  $target = Join-Path $repo $targetRel

  if (-not (Test-Path $target)) {
    Write-Host "ERR   $linkRel -> $targetRel ：目标目录不存在，仓库布局可能已变化"
    $err++
    continue
  }
  $targetResolved = (Resolve-Path $target).Path

  if (Test-Path $link) {
    $item = Get-Item $link -Force
    if ($item.LinkType -eq "Junction") {
      $cur = if ($item.Target) { @($item.Target)[0] } else { $null }
      $curResolved = $null
      if ($cur) {
        try { $curResolved = (Resolve-Path $cur -ErrorAction SilentlyContinue).Path } catch { $curResolved = $null }
      }
      if ($curResolved -eq $targetResolved) {
        $ok++
        continue
      }
      # 指向错误或悬空：删除重建
      if ((Remove-LinkSafe $link)) {
        New-Item -ItemType Junction -Path $link -Target $target | Out-Null
        Write-Host "FIXED $linkRel（原链接指向错误，已重建）"
        $fixed++
      } else {
        Write-Host "ERR   $linkRel ：无法删除损坏的链接"
        $err++
      }
      continue
    }
    # 普通目录：仅当为空（install 中断残留）时替换为链接
    if ((Get-ChildItem $link -Force -ErrorAction SilentlyContinue | Measure-Object).Count -eq 0) {
      if ((Remove-LinkSafe $link)) {
        New-Item -ItemType Junction -Path $link -Target $target | Out-Null
        Write-Host "FIXED $linkRel（空目录残留，已替换为链接）"
        $fixed++
      } else {
        Write-Host "ERR   $linkRel ：无法删除空目录"
        $err++
      }
    } else {
      Write-Host "WARN  $linkRel ：已是非空普通目录，跳过（若工具仍报错请手动检查该目录）"
      $warn++
    }
    continue
  }

  # 不存在：创建
  New-Item -ItemType Directory -Force -Path (Split-Path $link -Parent) | Out-Null
  New-Item -ItemType Junction -Path $link -Target $target | Out-Null
  Write-Host "FIXED $linkRel（新建链接）"
  $fixed++
}

Write-Host ""
Write-Host "完成：OK=$ok  FIXED=$fixed  WARN=$warn  ERR=$err"
if ($err -gt 0) { exit 1 }
