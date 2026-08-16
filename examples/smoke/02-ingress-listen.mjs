/**
 * 冒烟 2：真 WS 入站监听 + 原始整帧落地。
 */
import { Client, Dispatcher, LogLevel } from 'open-event-sdk';

const { WPS365_CLIENT_ID, WPS365_CLIENT_SECRET, WPS365_SP_ID } = process.env;
if (!WPS365_CLIENT_ID || !WPS365_CLIENT_SECRET || !WPS365_SP_ID) {
  console.error('[失败] 跑 `node --env-file /tmp/wps-bot-e2e/env.local examples/smoke/02-ingress-listen.mjs`');
  process.exit(1);
}

const BOT_IDS = new Set([WPS365_CLIENT_ID, WPS365_SP_ID]);
const BOT_NAME = process.env.WPS365_BOT_NAME ?? '甘小雨';
const OUT = '/tmp/wps-bot-e2e/ws-frames.jsonl';
const fs = await import('node:fs/promises');

const dispatcher = new Dispatcher().registerFunc('kso.app_chat.message.create', async (event) => {
  const parsed = JSON.parse(event.data);
  const sender = parsed?.sender ?? {};
  const textObj = parsed?.message?.content?.text;
  const textBody = typeof textObj === 'string' ? textObj : (textObj?.content ?? '');
  const mentionList = parsed?.message?.mentions ?? [];
  const mentionMatchByIds = mentionList.find((m) => BOT_IDS.has(String(m?.id)));
  const mentionByMarkup = /<at id="\d+">[^<]*<\/at>/g;
  const markups = String(textBody).match(mentionByMarkup) ?? [];
  const self = ['app', 'service_principal'].includes(String(sender.type)) && BOT_IDS.has(String(sender.id));
  const lines = [
    JSON.stringify({ at: new Date().toISOString(), event_id: parsed?.message?.id ?? '', event_code: event.eventCode, parsed }),
    JSON.stringify({
      at: new Date().toISOString(),
      event_id: parsed?.message?.id ?? '',
      razor: {
        chat_type: parsed?.chat?.type ?? '',
        chat_id: parsed?.chat?.id ?? '',
        sender,
        message_mentions: mentionList,
        text_body: textBody,
        at_markups: markups,
        self_filtered: self,
        matched_by_ids: mentionMatchByIds ?? null,
        matched_by_markup_name: markups.some((m) => m.includes(BOT_NAME)) ? BOT_NAME : null,
      },
    }),
  ];
  for (const line of lines) { await fs.appendFile(OUT, line + '\n'); console.log(line); }
});

const client = new Client({
  appId: WPS365_CLIENT_ID,
  appSecret: WPS365_CLIENT_SECRET,
  dispatcher,
  logLevel: LogLevel.Warn,
  reconnectMaxRetry: -1,
});

const timeoutSec = Number(process.argv[2] ?? 600_000);
if (timeoutSec > 0) setTimeout(() => process.exit(0), timeoutSec * 1000);
console.log(`listening 30min（将原始帧 + 摘要写到 ${OUT}；bot 显示名设为「${BOT_NAME}」）…`);
await client.start();
