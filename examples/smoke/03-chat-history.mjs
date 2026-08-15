/**
 * 冒烟 3：GET /v7/chats/{chat_id}/messages —— 对真历史帧分层 dump。
 * 用法：node --env-file /tmp/wps-bot-e2e/env.local examples/smoke/03-chat-history.mjs <chat_id> [pageSize]
 */
import { WpsClient } from '../../src/client.ts';

const chatId = process.argv[2];
const pageSize = Number(process.argv[3] ?? 30);
if (!chatId) { console.error('chat_id 必须。'); process.exit(1); }

const client = new WpsClient({
  clientId: process.env.WPS365_CLIENT_ID,
  clientSecret: process.env.WPS365_CLIENT_SECRET,
  apiBase: process.env.WPS365_API_BASE,
});

const response = await client.getMessages(chatId, pageSize);
const messages = Array.isArray((response.data ?? {}).messages) ? (response.data).messages : [];
console.log(`拉取 ${messages.length} 条（chat_id=${chatId}）`);
for (const m of messages.slice(-8)) {
  const c = m.content ?? {};
  console.log(JSON.stringify({
    id: m.id,
    type: m.type,
    quote: m.quote_msg_id,
    sender: m.sender ?? {},
    mentions: m.mentions ?? [],
    content: c,
  }, null, 2).slice(0, 1200));
  console.log('---');
}
process.exit(0);
