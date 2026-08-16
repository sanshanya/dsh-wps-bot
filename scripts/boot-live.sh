#!/usr/bin/env bash
# dsh-wps-bot 真机验收 boot（WSL/Linux 版）。
# 组合: /mnt/f/github/ksbot-dsh/compositions/wps-bot.cordis.yml
# 凭据: /mnt/f/github/.env（DEEPSEEK_*）+ /mnt/f/github/.env.wps（WPS365_*）——严禁把值写进本脚本/日志。
# 用法:
#   scripts/boot-live.sh        foreground（日志进 stdout）
#   scripts/boot-live.sh -d     detached（日志重定向 runtime/logs/wps-bot-<ts>.log，PID 落 .pid）
set -euo pipefail

KSROOT=/mnt/f/github/ksbot-dsh
BIN=/mnt/f/github/deepseek-harness/packages/examples/jsonrpc-demo/lib/bin.js
COMP=$KSROOT/compositions/wps-bot.cordis.yml

for f in /mnt/f/github/.env /mnt/f/github/.env.wps; do
  [[ -f $f ]] && set -a && . "$f" && set +a
done
for k in DEEPSEEK_API_KEY WPS365_CLIENT_ID WPS365_CLIENT_SECRET WPS365_SP_ID; do
  [[ -n "${!k:-}" ]] || { echo "缺少环境键: $k" >&2; exit 1; }
done

cd "$KSROOT"
if [[ "${1:-}" == "-d" ]]; then
  mkdir -p runtime/logs
  log="runtime/logs/wps-bot-$(date +%Y%m%d-%H%M%S).log"
  nohup node "$BIN" "$COMP" >"$log" 2>"$log.err" &
  echo "$!" >"$log.pid"
  echo "detached pid=$(cat "$log.pid") out=$log err=$log.err"
  exit 0
fi
exec node "$BIN" "$COMP"
