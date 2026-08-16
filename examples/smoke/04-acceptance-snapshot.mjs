/**
 * 冒烟 4：真机三场景验收快照——三面证据一键对撞。
 * 用法：node --env-file /tmp/wps-bot-e2e/env.local examples/smoke/04-acceptance-snapshot.mjs <chat_id> [sinceISO]
 */
import { readFile, readdir } from 'node:fs/promises';
import { WpsClient } from '../../src/client.ts';

const chatId = process.argv[2];
if (!chatId) { console.error('chat_id 必须。'); process.exit(1); }
const since = Date.parse(process.argv[3] ?? '') || Date.now() - 30 * 60_000;

const LOG_DIR = '/mnt/f/github/ksbot-dsh/runtime/logs';
const RUNTIME_DIR = '/mnt/f/github/ksbot-dsh/runtime';
const FRAMES = '/tmp/wps-bot-e2e/ws-frames.jsonl';

const out = { sinceIso: new Date(since).toISOString() };
console.log(`== 验收快照 (since ${out.sinceIso}, chat ${chatId}) ==\n`);

// ① WS 帧
try {
  const lines = (await readFile(FRAMES, 'utf8')).trim().split('\n').filter(Boolean);
  const fresh = lines.map((l) => JSON.parse(l)).filter((f) => Date.parse(f.at) >= since);
  console.log(`① WS 帧：${fresh.length} 条新帧`);
  for (const f of fresh) {
    const d = JSON.parse(f.data);
    const t = d?.message?.content?.text;
    const body = typeof t === 'string' ? t : t?.content ?? d?.message?.type ?? '?';
    console.log(`   ${f.at} ${f.eventCode} sender=${d?.message?.sender?.type}/${d?.message?.sender?.id} ${String(body).slice(0, 60)}`);
  }
} catch (e) { console.log(`① WS 帧：读取失败 ${e.message}`); }

// ② 宿主日志
try {
  const logs = (await readdir(LOG_DIR)).filter((f) => f.startsWith('wps-bot-') && f.endsWith('.log')).sort();
  const latest = logs.at(-1);
  const text = await readFile(`${LOG_DIR}/${latest}`, 'utf8');
  const hits = text.split('\n').filter((l) => /wps-bot|ERROR/i.test(l));
  console.log(`\n② 宿主日志 ${latest}:[wps-bot]/ERROR 命中 ${hits.length} 行`);
  for (const l of hits.slice(-15)) console.log(`   ${l.slice(0, 160)}`);
  const err = await readFile(`${LOG_DIR}/${latest}.err`, 'utf8').catch(() => '');
  console.log(`   err 尾：${err.trim().split('\n').slice(-3).join(' | ').slice(0, 300) || '(空)'}`);
} catch (e) { console.log(`② 宿主日志：读取失败 ${e.message}`); }

// ③ REST 真历史
try {
  const client = new WpsClient({
    clientId: process.env.WPS365_CLIENT_ID,
    clientSecret: process.env.WPS365_CLIENT_SECRET,
    apiBase: process.env.WPS365_API_BASE,
  });
  const r = await client.getMessages(chatId, 15);
  const items = ((r.data ?? {}).items ?? []).filter((m) => Number(m.ctime) >= since);
  console.log(`\n③ REST 历史：${items.length} 条新消息`);
  for (const m of items) {
    const t = m?.content?.text;
    const body = typeof t === 'string' ? t : t?.content ?? m.type;
    console.log(`   ${new Date(Number(m.ctime)).toISOString()} ${m.sender?.type}/${m.sender?.id} ${String(body).slice(0, 70).replace(/\n/g, '⏎')}`);
  }
} catch (e) { console.log(`③ REST 历史：拉取失败 ${e.message}`); }

// ④ dedup/audit
for (const f of ['wps-bot-seen-events.jsonl', 'wps-bot-approval.jsonl']) {
  try {
    const lines = (await readFile(`${RUNTIME_DIR}/${f}`, 'utf8')).trim().split('\n').filter(Boolean);
    console.log(`\n④ ${f}: ${lines.length} 行`);
    for (const l of lines.slice(-5)) console.log(`   ${l.slice(0, 140)}`);
  } catch { console.log(`\n④ ${f}: (未创建)`); }
}
process.exit(0);
