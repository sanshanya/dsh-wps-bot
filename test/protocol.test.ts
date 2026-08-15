import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeEventData,
  parseContent,
  textValue,
  inlineMentions,
  identityName,
  isSelfEvent,
  mentionMatched,
  type RawMessageEventData,
} from "../src/protocol.ts";

const BOT_IDS = ["app-1", "sp-1", "service-principal-1"];

// ---- 真机帧样本（已抓）——来自 /tmp/wps-bot-e2e/ws-frames.jsonl（没有 pen test 凭据）----
// 私聊帧：text.content={content:"test"}、无 mentions
const P2P_CAP: RawMessageEventData = {
  company_id: "corp-1",
  chat: { id: "91755485", type: "p2p" },
  sender: { id: "u1", type: "user" },
  send_time: 1_700_000_000,
  message: {
    id: "l2hMI2i8hLh5SVSdHAIV",
    type: "text",
    content: { text: { content: "test" } },
  },
};

// 群聊帧：@bot 以 <at id="1">甘小雨</at> 内嵌正文出现；mentions 为空数组（机真！）
const GROUP_BOT_MENTION: RawMessageEventData = {
  company_id: "corp-1",
  chat: { id: "91793929", type: "group" },
  sender: { id: "u2", type: "user" },
  send_time: 1_700_000_000,
  message: {
    id: "4ohXIVinhAh1SNHGSJHk",
    type: "text",
    content: { text: { content: "<at id=\"1\">甘小雨</at> test" } },
    mentions: [],
  },
};

// 官方 docs 的标准 mentions 载荷样例（接收消息.md）
const DOC_STANDARD_MENTION: RawMessageEventData = {
  chat: { id: "demo_chat", type: "group" },
  sender: { id: "demo_sender_id", type: "user" },
  message: {
    id: "demo_message_id",
    type: "text",
    content: { text: { content: "你好<at id=\"1\">机器人</at>" } },
    mentions: [
      { id: "1", type: "user", identity: { type: "sp", id: "sp-1", app_id: "app-1", name: "甘小雨" } },
    ],
  },
};

test("textValue：str | {content} | {text} 三态", () => {
  assert.deepEqual(textValue("hello"), ["hello", true]);
  assert.deepEqual(textValue({ content: "hello" }), ["hello", true]);
  assert.deepEqual(textValue({ text: "hello" }), ["hello", true]);
  assert.equal(textValue(undefined)[1], false);
  assert.equal(textValue(null)[1], false);
});

test("identityName：bot identity 命中 bot_ids → 置空（GA identity_name）", () =>
  {
    assert.equal(identityName({ type: "sp", id: "sp-1" }, "label", BOT_IDS), "");
    assert.equal(identityName({ type: "user", id: "u1" }, "label", BOT_IDS), "label");
    assert.equal(identityName({ type: "user", id: "u1", name: "张三" }, "fallback", BOT_IDS), "张三");
    assert.equal(identityName({}, "lab", BOT_IDS), "lab");
  });

test("inlineMentions：<at id=..>name</at>落地为 '@name '（GA inline）", () => {
  const out = inlineMentions("<at id=\"1\">张三</at>联东西", (id, name) => `@${name} `);
  assert.equal(out, "@张三 联东西");
  // bot identity 空名 → 被删掉
  const out2 = inlineMentions("<at id=\"1\">甘小雨</at>跳过来", () => "");
  assert.equal(out2, "跳过来");
});

test("normalizeEventData：真机私聊帧的 canonical 化", () => {
  const ev = normalizeEventData(P2P_CAP, BOT_IDS, "fallback");
  assert.equal(ev?.chatId, "91755485");
  assert.equal(ev?.eventId, "l2hMI2i8hLh5SVSdHAIV");
  assert.equal(ev?.text, "test");
  assert.equal(ev?.isPrivate, true);
  assert.equal(ev?.mentioned, false);
  assert.equal(ev?.senderId, "u1");
});

test("normalizeEventData：真机群聊@bot 帧——mentions 空但按 text markup 判为被 @", () => {
  const ev = normalizeEventData(GROUP_BOT_MENTION, BOT_IDS, "fallback", "甘小雨");
  assert.equal(ev?.mentioned, true);
  assert.equal(ev?.chatType, "group");
  assert.equal(ev?.chatId, "91793929");
  assert.equal(ev?.text, "test"); // '<at id="1">甘小雨</at>' 在正文中被 inline 删去（bot identity 空名）
});

test("normalizeEventData：官方 docs 的标准 mentions 帧按 identity.id 主匹配", () => {
  const ev = normalizeEventData(DOC_STANDARD_MENTION, BOT_IDS, "fallback", "甘小雨");
  assert.equal(ev?.mentioned, true);
  assert.equal(ev?.text, "你好"); // mentions 命中 bot，文本里 inline 也删去
});

test("normalizeEventData：其他用户 identity 命中之后仍 inline 为 '@名'", () => {
  const data: RawMessageEventData = {
    chat: { id: "c1", type: "group" },
    sender: { id: "u1" },
    message: {
      id: "m1",
      type: "text",
      content: { text: { content: "<at id=\"1\">张三</at>联东西" } },
      mentions: [
        { id: "1", type: "user", identity: { id: "u-other", type: "user", name: "张三" } },
      ],
    },
  };
  const ev = normalizeEventData(data, BOT_IDS, "e");
  assert.equal(ev?.mentioned, false);
  assert.equal(ev?.text, "@张三 联东西");
});

test("parseContent：image / file.local / file.cloud / location 的 storage 键识别", () => {
  const image = parseContent({ image: { storage_key: "img-1", name: "pic.png", size: 4 } });
  assert.equal(image.attachments[0]?.storageKey, "img-1");
  assert.equal(image.evidenceBearing, true);

  const local = parseContent({ file: { type: "local", local: { name: "a.pdf", size: 1, storage_key: "stor-x" } } });
  assert.equal(local.attachments[0]?.kind, "file");
  assert.equal(local.cloudDocLinks.length, 0);
  assert.equal(local.evidenceBearing, true);

  const cloud = parseContent({ file: { type: "cloud", name: "云档", cloud: { name: "云档", id: "d-9", link_url: "https://kdocs.cn/d/d-9", link_id: "l-9" } } });
  assert.equal(cloud.attachments.length, 0);
  assert.equal(cloud.cloudDocLinks.at(0), "https://kdocs.cn/d/d-9");
  assert.equal(cloud.sharedDocIds.at(0), "d-9");
  assert.equal(cloud.evidenceBearing, true);

  const unknown = parseContent({ location: { address: "x", latitude: 0, longitude: 0 } });
  assert.equal(unknown.unparsed.length, 1);
  assert.equal(unknown.unparsed[0]?.reason, "unknown-content-key");
});

test("parseContent：GA rich_text 兼容识别与未知节点落 unparsed", () => {
  const parsed = parseContent({
    rich_text: {
      elements: [
        { type: "text", text: { content: "看看" } },
        { type: "mention", mention_content: { name: "甘小雨", identity: { type: "app", app_id: "app-1" } } },
        { type: "mystery-node", raw: 1 },
      ],
    },
  });
  assert.equal(parsed.text, "看看@甘小雨 ");
  assert.equal(parsed.unparsed.length, 1);
  assert.equal(parsed.unparsed[0]?.reason, "unparsed-type:mystery-node");
});

test("isSelfEvent：sender.type ∈ {app, sp, service_principal} 且 id/app_id 命中 bot_ids → 自产消息过滤", () => {
  assert.equal(isSelfEvent({ type: "app", id: "app-1" }, BOT_IDS), true);
  assert.equal(isSelfEvent({ type: "sp", id: "sp-1" }, BOT_IDS), true);
  assert.equal(isSelfEvent({ type: "service_principal", id: "service-principal-1" }, BOT_IDS), true);
  assert.equal(isSelfEvent({ type: "user", id: "app-1", app_id: "app-1" }, BOT_IDS), false);
  assert.equal(isSelfEvent({ type: "app", id: "outsider" }, BOT_IDS), false);
  assert.equal(isSelfEvent(undefined, BOT_IDS), false);
});

test("mentionMatched：mentions identity=[all] 强制匹配（不减大意数组的兼容性）", () => {
  const hit = mentionMatched(
    {
      content: { text: { content: "x" } },
      mentions: [{ id: "1", type: "all", identity: { type: "all" } }],
    },
    BOT_IDS,
    "甘小雨",
  );
  assert.equal(hit.matched, true);
});
