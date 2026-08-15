# dsh-wps-bot 真机验收 boot（Windows）。
# 组合: F:\github\ksbot-dsh\compositions\wps-bot.cordis.yml（wps-sdk 全栈 + wps-bot 条目）
# 凭据: F:\github\.env（DEEPSEEK_*）+ F:\github\.env.wps（WPS365_*）——严禁把值写进本脚本/日志。
# cwd 固定 F:\github\ksbot-dsh（./runtime、./.sessions、persistence 根全以它为基）。
param([switch]$Detached)
$ErrorActionPreference = 'Stop'

function Import-DotEnv([string]$path) {
  foreach ($line in Get-Content $path) {
    if ($line -match '^\s*#' -or $line -match '^\s*$') { continue }
    $kv = $line -split '=', 2
    if ($kv.Count -ne 2) { continue }
    $name = $kv[0].Trim()
    $value = $kv[1].Trim().Trim('"').Trim("'")
    [System.Environment]::SetEnvironmentVariable($name, $value, 'Process')
  }
}

Import-DotEnv 'F:\github\.env'
Import-DotEnv 'F:\github\.env.wps'

foreach ($k in @('DEEPSEEK_API_KEY', 'WPS365_CLIENT_ID', 'WPS365_CLIENT_SECRET', 'WPS365_SP_ID')) {
  if (-not [System.Environment]::GetEnvironmentVariable($k, 'Process')) { throw "缺少环境键: $k" }
}

$logDir = 'F:\github\ksbot-dsh\runtime\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ("wps-bot-{0:yyyyMMdd-HHmmss}.log" -f (Get-Date))
Write-Output "boot log: $log"

Set-Location 'F:\github\ksbot-dsh'
# bin 参数是位置式 <path/to/cordis.yml>（jsonrpc-demo/src/bin.ts usage 行；无 --config）
$nodeArgs = @(
  'F:\github\dsh-wps-bot\scripts\keepalive-stdin.mjs', '--',
  'F:\github\deepseek-harness\packages\examples\jsonrpc-demo\lib\bin.js',
  'F:\github\ksbot-dsh\compositions\wps-bot.cordis.yml'
)
if ($Detached) {
  # WSL/任务计划拉起的会话没有稳定 TTY——脱离流式，直接文件重定向 + PID 落盘
  $err = "$log.err"
  $p = Start-Process -FilePath 'node' -ArgumentList $nodeArgs -WorkingDirectory 'F:\github\ksbot-dsh' `
    -RedirectStandardOutput $log -RedirectStandardError $err -WindowStyle Hidden -PassThru
  Set-Content -Path "$log.pid" -Value $p.Id
  Write-Output "detached pid=$($p.Id) out=$log err=$err"
  return
}
node @nodeArgs 2>&1 | Tee-Object -FilePath $log


