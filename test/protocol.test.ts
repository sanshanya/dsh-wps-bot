import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeEventData,
  parseContent,
  isSelfEvent,
  type RawMessageEventData,
} from "../src/protocol.ts";

const BOT_IDS = ["app-1", "sp-1", "service-principal-1"];

// open-event-sdk@1.0.1 dist/event/model/index.d.ts 对齐形状：content.text 是 string
const SDK_SHAPED: RawMessageEventData = {
  company_id: "corp-1",
  chat: { id: "chat-1", type: "group" },
  sender: {
    type: "user",
    id: "u1",
    extended_attribute: { name: "张三" },
  },
  send_time: 1_700_000_000,
  message: {
    id: "msg-1",
    type: "text",
    content: { text: "你好" },
    mentions: [],
    quote_msg_id: "msg-0",
  },
};

test("normalizeEventData：SDK 真实模型的字段面", () => {
  const ev = normalizeEventData(SDK_SHAPED, BOT_IDS, "fallback");
  assert.equal(ev?.chatId, "chat-1");
  assert.equal(ev?.chatType, "group");
  assert.equal(ev?.eventId, "msg-1");
  assert.equal(ev?.quoteMsgId, "msg-0");
  assert.equal(ev?.senderId, "u1");
  assert.equal(ev?.senderName, "张三");
  assert.equal(ev?.text, "你好");
  assert.equal(ev?.mentioned, false);
  assert.equal(ev?.isPrivate, false);
  assert.equal(ev?.evidenceBearing, false);
});

test("normalizeEventData：eventId 三级回退；无 chat id → null", () => {
  const ev1 = normalizeEventData(
    {
      chat: { id: "c1" },
      sender: { id: "u1" },
      message_id: "mid",
    } as RawMessageEventData,
    BOT_IDS,
    "event-id",
  );
  assert.equal(ev1?.eventId, "mid");
  const ev2 = normalizeEventData({ sender: { id: "u1" } } as RawMessageEventData, BOT_IDS, "e");
  assert.equal(ev2, null);
});

test("normalizeEventData：mentions 数组走 SDK (type=user,id=sp) 命中 bot", () => {
  const data: RawMessageEventData = {
    ...SDK_SHAPED,
    message: {
      ...SDK_SHAPED.message,
      mentions: [{ type: "user", id: "sp-1", offset: 0, length: 1 }],
    },
  };
  const ev = normalizeEventData(data, BOT_IDS, "e");
  assert.equal(ev?.mentioned, true);
});

test("parseContent：content.text 是 string", () => {
  const parsed = parseContent({ text: "hello" });
  assert.equal(parsed.text, "hello");
  assert.equal(parsed.evidenceBearing, false);
});

test("parseContent：file / image 触发 evidence 并入住附件", () => {
  const parsed = parseContent({ file: { file_id: "file-tok-1", name: "报告.pdf" } });
  assert.equal(parsed.evidenceBearing, true);
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0]?.kind, "file");
  assert.equal(parsed.attachments[0]?.storageKey, "file-tok-1");

  const image = parseContent({ image: { file_id: "img-1" } });
  assert.equal(image.evidenceBearing, true);
  assert.equal(image.attachments[0]?.kind, "image");
});

test("parseContent：未知 content 键列为 unparsed（空 evidence 语义）", () => {
  const parsed = parseContent({ text: "好", audio: { file_id: "a1" } });
  assert.equal(parsed.evidenceBearing, true);
  assert.equal(parsed.unparsed.length, 1);
  assert.equal(parsed.unparsed[0]?.reason, "unknown-content-key");
  assert.equal(parsed.unparsed[0]?.path, "content.audio");
});

test("parseContent：老 wire 的 rich_text 兼容识别", () => {
  const parsed = parseContent({
    rich_text: {
      elements: [
        { type: "text", text: { content: "看看" } },
        {
          type: "mention",
          mention_content: { name: "甘小雨", identity: { type: "app", app_id: "app-1" } },
        },
      ],
    },
  });
  assert.equal(parsed.text, "看看@甘小雨");
  assert.equal(parsed.evidenceBearing, false);
});

test("isSelfEvent：匹配 SDK sender.type=u/app/service_principal + id/app_id", () => {
  assert.equal(isSelfEvent({ type: "app", id: "app-1" }, BOT_IDS), true);
  assert.equal(isSelfEvent({ type: "service_principal", id: "sp-1" }, BOT_IDS), true);
  assert.equal(isSelfEvent({ type: "app", id: "app-1", app_id: "app-1" }, BOT_IDS), true);
  assert.equal(isSelfEvent({ type: "app", id: "someone" }, BOT_IDS), false);
  assert.equal(isSelfEvent({ type: "user", id: "app-1" }, BOT_IDS), false);
  assert.equal(isSelfEvent(undefined, BOT_IDS), false);
});
