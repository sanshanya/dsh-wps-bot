# dsh-wps-bot 运行时 junctions（Windows 侧）。
# 背景：WSL 里建的符号链接 Windows Node 解析不了；junction 双向（WSL/Win）都可见。
# 幂等：已存在且指向正确目标→跳过；错误目标→报错人工处理。
$ErrorActionPreference = 'Stop'
$root = 'F:\github\dsh-wps-bot\node_modules'
$map = [ordered]@{
  "$root\@deepseek-ai\cordis"      = 'F:\github\deepseek-harness\vendor\cordis'
  "$root\@deepseek-ai\dsh-agent"   = 'F:\github\deepseek-harness\packages\core\agent'
  "$root\@deepseek-ai\dsh-llm"     = 'F:\github\deepseek-harness\packages\llm\llm'
  "$root\@deepseek-ai\dsh-session" = 'F:\github\deepseek-harness\packages\core\session'
  "$root\@deepseek-ai\schemastery" = 'F:\github\deepseek-harness\vendor\schemastery'
  "$root\open-event-sdk"           = 'F:\github\ksbot\node_modules\open-event-sdk'
  "$root\ws"                       = 'F:\github\ksbot\node_modules\ws'
}
foreach ($link in $map.Keys) {
  $target = $map[$link]
  if (Test-Path $target) {} else { throw "junction 目标不存在: $target" }
  if (Test-Path $link) {
    $item = Get-Item $link -Force
    if ($item.LinkType -eq 'Junction' -and $item.Target -eq $target) { Write-Output "skip  $link"; continue }
    throw "已存在且非预期 junction: $link ($($item.LinkType) -> $($item.Target))"
  }
  New-Item -ItemType Junction -Path $link -Target $target | Out-Null
  Write-Output "link  $link -> $target"
}
foreach ($link in $map.Keys) {
  if (-not (Test-Path "$link\package.json")) { throw "junction 建立但 package.json 不可读: $link" }
}
Write-Output 'OK: 7 junctions verified'
