import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeEventData,
  parseContent,
  isSelfEvent,
  type RawMessageEventData,
} from "../src/protocol.ts";

const BOT_IDS = ["app-1", "sp-1"];

test("normalizeEventData：字段面按 bridge normalize 逐字对齐", () => {
  const data: RawMessageEventData = {
    chat: { id: "c1", type: "group" },
    sender: { id: "u1", name: "张三" },
    message: {
      id: "m1",
      quote_msg_id: "m0",
      content: { text: { content: "你好" } },
      mentions: [],
    },
  };
  const ev = normalizeEventData(data, BOT_IDS, "e9");
  assert.equal(ev?.chatId, "c1");
  assert.equal(ev?.chatType, "group");
  assert.equal(ev?.eventId, "m1");
  assert.equal(ev?.quoteMsgId, "m0");
  assert.equal(ev?.senderId, "u1");
  assert.equal(ev?.senderName, "张三");
  assert.equal(ev?.text, "你好");
  assert.equal(ev?.mentioned, false);
  assert.equal(ev?.isPrivate, false);
  assert.equal(ev?.evidenceBearing, false);
});

test("normalizeEventData：event id 三级回退；无 chat id → null", () => {
  const ev1 = normalizeEventData(
    { chat: { id: "c1", type: "group" }, sender: { id: "u1" }, message_id: "mid" } as RawMessageEventData,
    BOT_IDS,
    "event-id",
  );
  assert.equal(ev1?.eventId, "mid");
  const ev2 = normalizeEventData({ sender: { id: "u1" } } as RawMessageEventData, BOT_IDS, "e");
  assert.equal(ev2, null);
});

test("parseContent：rich 富文本 mention 节点把 @名称拼进文本", () => {
  const parsed = parseContent({
    rich_text: {
      elements: [
        { type: "text", text: { content: "看看" } },
        {
          type: "mention",
          mention_content: {
            name: "甘小雨",
            identity: { type: "app", app_id: "app-1" },
          },
        },
      ],
    },
  });
  assert.equal(parsed.text, "看看@甘小雨");
  assert.equal(parsed.evidenceBearing, false);
});

test("parseContent：附件/云文档/unparsed 触发 evidenceBearing（GA 四字段判定面）", () => {
  const attachments = parseContent({
    rich_text: { elements: [{ type: "file", storage_key: "stor-1", name: "报告.pdf", size: 1 }] },
  });
  assert.equal(attachments.evidenceBearing, true);
  assert.equal(attachments.attachments.length, 1);
  assert.equal(attachments.attachments[0]?.storageKey, "stor-1");

  const cloud = parseContent({ rich_text: { elements: [{ type: "cloud_doc", url: "https://kdocs.cn/doc/1", doc_id: "d1" }] } });
  assert.equal(cloud.evidenceBearing, true);
  assert.deepEqual(cloud.cloudDocLinks, ["https://kdocs.cn/doc/1"]);
  assert.deepEqual(cloud.sharedDocIds, ["d1"]);

  const unknown = parseContent({ rich_text: { elements: [{ type: "mystery-node", raw: 1 }] } });
  assert.equal(unknown.evidenceBearing, true);
  assert.equal(unknown.unparsed.length, 1);
  assert.equal(unknown.unparsed[0]?.reason, "unparsed-type:mystery-node");

  const nonObject = parseContent("hi");
  assert.equal(nonObject.evidenceBearing, true);
  assert.equal(nonObject.unparsed[0]?.reason, "non-object-content");
});

test("isSelfEvent：只有 app/sp 且 id 命中 botIds 才认自带", () => {
  assert.equal(isSelfEvent({ type: "app", id: "app-1" }, BOT_IDS), true);
  assert.equal(isSelfEvent({ type: "sp", app_id: "sp-1" }, BOT_IDS), true);
  assert.equal(isSelfEvent({ type: "user", id: "app-1" }, BOT_IDS), false);
  assert.equal(isSelfEvent({ type: "app", id: "someone" }, BOT_IDS), false);
  assert.equal(isSelfEvent(undefined, BOT_IDS), false);
});

test("normalizeEventData：rich mention 命中 bot → mentioned", () => {
  const data: RawMessageEventData = {
    chat: { id: "c1", type: "group" },
    sender: { id: "u1" },
    message: {
      id: "m2",
      content: {
        rich_text: {
          elements: [
            { type: "text", text: { content: "查下" } },
            {
              type: "mention",
              mention_content: { name: "甘小雨", identity: { type: "app", app_id: "app-1" } },
            },
          ],
        },
      },
      mentions: [],
    },
  };
  const ev = normalizeEventData(data, BOT_IDS, "e");
  assert.equal(ev?.mentioned, true);
});
