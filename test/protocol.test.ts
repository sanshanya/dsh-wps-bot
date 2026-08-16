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
  type WpsEvent,
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

// ---- WPS 真机 REST 历史接口锚帧（/tmp/wps-bot-e2e）；作为 regression fixture 恢复原状 ----
const REAL_FRAMES: Array<{ name: string; raw: RawMessageEventData; want: Partial<WpsEvent> | null; eventId: string; botIds: string[] }> = [
  {
    name: "sp 自产消息 → 自答过滤",
    eventId: "2vhBI6irh0tbuwHXtRHw",
    botIds: ["AK20260508ZSAHCR", "kAWqVoB"],
    raw: {
      chat: { id: "91793929", type: "group" },
      sender: { id: "kAWqVoB", app_id: "AK20260508ZSAHCR", type: "sp", company_id: "lLomJ37" },
      message: { id: "2vhBI6irh0tbuwHXtRHw", type: "text", content: { text: { content: "[@冯三山](woa://x) 你好！" } } },
    } as RawMessageEventData,
    want: null, // null = self event
  },
  {
    name: "sp.card(content=null)：按 content 空兜底（防自答）",
    eventId: "k2hEIAi0h0tduBHPtYuZ",
    botIds: ["AK20260508ZSAHCR", "kAWqVoB"],
    raw: {
      chat: { id: "91793929", type: "group" },
      sender: { id: "kAWqVoB", app_id: "AK20260508ZSAHCR", type: "sp" },
      message: { id: "k2hEIAi0h0tduBHPtYuZ", type: "card", content: null },
    } as RawMessageEventData,
    want: null, // 同样被防自答
  },
  {
    name: "image 帧（storage_key 直载）",
    eventId: "l2hMI2i8hdt1uZTEImh7",
    botIds: ["AK20260508ZSAHCR", "kAWqVoB"],
    raw: {
      company_id: "lLomJ37",
      chat: { id: "91793929", type: "group" },
      sender: { id: "3Bj5ABr", type: "user" },
      message: {
        id: "l2hMI2i8hdt1uZTEImh7",
        type: "image",
        content: { image: { storage_key: "066F", name: "pic.png", size: 2911990, type: "image/png", width: 2380, height: 1392 } },
      },
    } as RawMessageEventData,
    want: { evidenceBearing: true, text: "[attachment-only message]", attachments: [{ kind: "image", storageKey: "066F", name: "pic.png", size: 2911990, mime: "image/png" }] },
  },
  {
    name: "file 帧（file.local.storage_key；非 file.cloud）",
    eventId: "XVhnIliwhqtDuBTAHWsG",
    botIds: ["AK20260508ZSAHCR", "kAWqVoB"],
    raw: {
      company_id: "lLomJ37",
      chat: { id: "91793929", type: "group" },
      sender: { id: "3Bj5ABr", type: "user" },
      message: {
        id: "XVhnIliwhqtDuBTAHWsG",
        type: "file",
        content: { file: { local: { name: "omp.py", size: 12969, storage_key: "sk" }, type: "local" } },
      },
    } as RawMessageEventData,
    want: { evidenceBearing: true, attachments: [{ kind: "file", storageKey: "sk", name: "omp.py", size: 12969, mime: "" }] },
  },
  {
    name: "@bot 两帧完全一致——identity.id 命中 spId",
    eventId: "7QhvI7iWh4tzu2HRhAhw",
    botIds: ["AK20260508ZSAHCR", "kAWqVoB"],
    raw: {
      company_id: "lLomJ37",
      chat: { id: "91793929", type: "group" },
      sender: { id: "3Bj5ABr", type: "user" },
      message: {
        id: "7QhvI7iWh4tzu2HRhAhw",
        type: "text",
        content: { text: { content: "<at id=\"1\">甘小雨</at> hello" } },
        mentions: [{ id: "1", type: "user", identity: { id: "kAWqVoB", type: "sp", name: "甘小雨", company_id: "lLomJ37" } }],
      },
    } as RawMessageEventData,
    want: { mentioned: true, text: "hello" },
  },
];

for (const fr of REAL_FRAMES) {
  test(`真机帧：${fr.name}`, () => {
    const ev = normalizeEventData(fr.raw, fr.botIds, fr.eventId, "甘小雨");
    if (fr.want === null) {
      assert.ok(isSelfEvent(fr.raw.sender, fr.botIds));
    } else {
      assert.equal(ev?.mentioned, fr.want.mentioned ?? false);
      assert.equal(ev?.evidenceBearing, fr.want.evidenceBearing ?? false);
      if (fr.want.text !== undefined) assert.equal(ev?.text, fr.want.text);
      if (fr.want.attachments !== undefined) {
        assert.equal(ev?.attachments.length, fr.want.attachments.length);
        for (let i = 0; i < fr.want.attachments.length; i++) {
          assert.equal(ev?.attachments[i]?.kind, fr.want.attachments[i]?.kind);
          assert.equal(ev?.attachments[i]?.storageKey, fr.want.attachments[i]?.storageKey);
        }
      }
    }
  });
}

test("mentionMatched：mentions identity=[all] 不唤醒（b3 裁定：守 GA 语义，@所有人不算 @bot）", () => {
  const hit = mentionMatched(
    {
      content: { text: { content: "x" } },
      mentions: [{ id: "1", type: "all", identity: { type: "all" } }],
    },
    BOT_IDS,
    "甘小雨",
  );
  assert.equal(hit.matched, false);
});

test("mentionMatched：B 通道结构匹配——名与 <at> 分置不误判，标准 <at>N 名</at> 才中", () => {
  const stray = mentionMatched(
    {
      content: { text: { content: "刚提到<atx 标记的事，甘小雨你觉得呢" } },
      mentions: [],
    },
    BOT_IDS,
    "甘小雨",
  );
  assert.equal(stray.matched, false); // 旧子串面会误判
  const structural = mentionMatched(
    {
      content: { text: { content: '<at id="1">甘小雨</at> 在吗' } },
      mentions: [],
    },
    BOT_IDS,
    "甘小雨",
  );
  assert.equal(structural.matched, true);
  assert.equal(structural.matchedBy, "markup");
});

test("R4：i18n_items 卡片信封读回——自己出站的卡能读回标题与正文（protocol.py:223-234）", () => {
  const own = parseContent({
    card: {
      config: {},
      i18n_items: [
        {
          key: "zh-CN",
          value: {
            header: { title: { tag: "text", text: { type: "plain", content: "甘小雨" } } },
            elements: [{ text: { tag: "text", text: { type: "markdown", content: "已收到，正在处理。" } } }],
          },
        },
      ],
    },
  });
  assert.ok(own.text.includes("甘小雨"));
  assert.ok(own.text.includes("已收到，正在处理"));
});
