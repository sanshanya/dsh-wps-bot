/**
 * 活火演练（fire drill）：真 REST 出站 + 真 pacing + 编排 agent——不依赖 LLM 的全链路自检。
 * 直接驱动 WpsBotCore（bot.ts 是宿主无关语义核；cordis 接线已由 host-boot E2E 覆盖），
 * logger=console——cordis 默认 logger 静默，演练要看得见每一步。
 *
 * 覆盖：入站真帧归一 → dedup → 路由 → requester → 进度卡（12s/两次心跳）
 *   → 审批群问（人回「同意5分钟」→ 窗；不回 → 超时取消旁路）
 *   → 终态回答 → 卡 recall 收口 → dedup/审计 JSONL
 *
 * 用法：node --env-file /tmp/wps-bot-e2e/env.local examples/live/fire-drill.mjs [chatId] [waitApproveMs]
 * 出站全是真实 WPS 发送（群里出现演练消息属预期）。
 */
import { WpsBotCore } from '../../src/bot.ts';
import { WpsClient } from '../../src/client.ts';
import { EventDedup } from '../../src/dedup.ts';
import { normalizeEventData } from '../../src/protocol.ts';
import { readFile } from 'node:fs/promises';

const chatId = process.argv[2] ?? '91793929';
const userId = process.env.DRILL_USER_ID ?? '3Bj5ABr'; // 冯三山（真帧取得）
const waitApproveMs = Number(process.argv[3] ?? 240_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = new WpsClient({
  clientId: process.env.WPS365_CLIENT_ID,
  clientSecret: process.env.WPS365_CLIENT_SECRET,
  apiBase: process.env.WPS365_API_BASE,
});

const handle = {
  sessionId: `wps-bot:${chatId}`,
  running: false,
  status() { return this.running ? 'running' : 'idle'; },
  followup() { void turn(); },
  inject() { return true; },
};

let core;
async function ev2(type, data) {
  await core.handleSessionEvent(handle.sessionId, { type, data });
}
async function turn() {
  handle.running = true;
  await ev2('turn/start', { turn: 1 });
  await ev2('assistant/message', {
    turn: 1, step: 1,
    message: { content: [{ type: 'text', text: '（演练中间步：干活中，等心跳）' }] },
  });
  await sleep(12_000); // 心跳窗
  const outcome = await core.handleApprovalRequest(
    { agent: 'agent:c1', toolName: 'pwsh', callId: 'drill-call-1', reason: '【演练】写 C:\\Temp\\hello.txt（不会真写）' },
    () => Promise.resolve('unavailable'),
  );
  console.log('[drill] 审批 outcome =', outcome);
  await ev2('assistant/message', {
    turn: 1, step: 2,
    message: { content: [{ type: 'text', text: `【演练自检】链路全通：审批结果=${String(outcome)}。本条由 dsh-wps-bot fire-drill 发出，非模型产物。` }] },
  });
  await ev2('turn/end', { turn: 1, reason: { kind: 'completed' } });
  handle.running = false;
  await core.handleAgentStatus('agent:c1', 'idle');
}

const dedup = await EventDedup.load({ limit: 256, path: '/tmp/wps-bot-e2e/drill-seen.jsonl' });
core = new WpsBotCore({
  client,
  logger: console,
  dedup,
  sessions: {
    ensure: async () => handle,
    setRequester: () => {},
    getRequester: () => ({ userId, name: '冯三山' }),
  },
  chatForSessionId: (id) => (id === handle.sessionId ? chatId : null),
  chatForAgent: (a) => (a === 'agent:c1' ? chatId : null),
  config: {
    cardMode: 'card', cardTitle: '甘小雨', cardInitialDelayMs: 1_000, cardHeartbeatMs: 6_000,
    cardUpdateMinIntervalMs: 1_000, cardSettle: 'recall',
    approvalMode: 'windows', approvalTimeoutMs: waitApproveMs, allowWindow: true,
    auditPath: '/tmp/wps-bot-e2e/drill-approval.jsonl',
    ackInterventionText: 'x', deliverChunks: 4500, workspaceRoot: '/tmp/wps-bot-e2e/drill-ws',
  },
});

const eventId = `drill-${Date.now()}`;
const payload = normalizeEventData(
  {
    chat: { id: chatId, type: 'group' },
    message: {
      id: eventId,
      content: { text: { content: '<at id="1">甘小雨</at> 演练：链路自检' } },
      mentions: [{ id: '1', identity: { type: 'sp', id: process.env.WPS365_SP_ID, app_id: process.env.WPS365_CLIENT_ID, company_id: 'lLomJ37', name: '甘小雨' } }],
      sender: { type: 'user', id: userId, name: '冯三山' },
    },
  },
  [process.env.WPS365_SP_ID],
  eventId,
  '甘小雨',
);
if (!payload) throw new Error('normalize 失败');
console.log('[drill] 注入', eventId, '→', payload.text);
const route = await core.handleIncomingEvent(payload);
console.log('[drill] route =', route);

const drillStart = Date.now(); // 观测下界=注入时刻（page 升序取头，须自过滤自消息）
const deadline = drillStart + waitApproveMs + 60_000;
const seen = { card: false, question: false, answer: false, recalled: false };
let lastCardId = '';
while (Date.now() < deadline) {
  await sleep(5_000);
  const r = await client.getMessages(chatId, 40);
  for (const m of ((r.data ?? {}).items ?? []).slice(-20)) {
    if (m.sender?.type !== 'sp') continue;
    if (Number(m.ctime) < drillStart - 10_000) continue;
    const t = m?.content?.text;
    const body = typeof t === 'string' ? t : t?.content ?? '';
    if (!seen.card && m.type === 'card') { seen.card = true; lastCardId = String(m.id ?? ''); console.log('[drill] ✓ 进度卡已出现', lastCardId); }
    if (!seen.question && String(body).includes('需要确认的操作')) { seen.question = true; console.log('[drill] ✓ 审批群问已出现'); }
    if (!seen.answer && String(body).includes('演练自检')) { seen.answer = true; console.log('[drill] ✓ 终态回答已送达'); }
  }
  if (seen.answer) break;
}
console.log('[drill] 裁决:', JSON.stringify(seen));
const dedupStat = await readFile('/tmp/wps-bot-e2e/drill-seen.jsonl', 'utf8').then((s) => `${s.trim().split('\n').length} 行`).catch(() => '(无)');
const auditStat = await readFile('/tmp/wps-bot-e2e/drill-approval.jsonl', 'utf8').catch(() => '(无——人未答或已超时)');
console.log('[drill] dedup:', dedupStat);
console.log('[drill] audit:', auditStat);
await core.shutdown();
process.exit(seen.card && seen.question ? 0 : 1);
