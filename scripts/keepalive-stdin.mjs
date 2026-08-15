#!/usr/bin/env node
/**
 * hold-open 包装：spawn 目标进程，stdin 用永不开写的 pipe 持有，保证子进程
 * 永远收不到 stdin EOF。
 *
 * 动机：deepseek-harness/packages/examples/jsonrpc-demo/src/runner.ts:51
 * `process.stdin.on('end') → disposeAndExit(0)`——bot 常驻进程一旦被
 * 无 stdin 的方式拉起来（计划任务/守护），stdin EOF 会把整个 cordis ctx
 * 一并销毁，WPS 长连接跟着死。本包装让子进程 stdin 恒开。
 *
 * 用法：node keepalive-stdin.mjs -- <bin.js> [args...]
 * 退出：收到 SIGINT/SIGTERM 时向子进程转发，子等退后按同码退出。
 */
import { spawn } from 'node:child_process';

const sep = process.argv.indexOf('--');
const args = process.argv.slice(sep + 1);
if (sep === -1 || args.length === 0) {
  console.error('用法: node keepalive-stdin.mjs -- <bin.js> [args...]');
  process.exit(2);
}

const child = spawn(process.execPath, args, {
  stdio: ['pipe', 'inherit', 'inherit'],
  env: process.env,
});

let exiting = false;
function shutdown(sig) {
  if (exiting) return;
  exiting = true;
  try { child.kill(sig); } catch {}
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
// 关键：永不 end() child.stdin。
