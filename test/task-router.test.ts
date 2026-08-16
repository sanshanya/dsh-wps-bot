import test from "node:test";
import assert from "node:assert/strict";

import { WpsRouter, defaultFactify, type ChatSessionHandle } from "../src/task-router.ts";
import { EventDedup } from "../src/dedup.ts";
import type { WpsEvent } from "../src/protocol.ts";

function ev(over: Partial<WpsEvent> = {}): WpsEvent {
  return {
    chatId: "c1",
    chatType: "group",
    eventId: "m1",
    quoteMsgId: "",
    senderId: "u1",
    senderName: "张三",
    mentioned: false,
    botIds: ["app-1", "sp-1"],
    text: "hello",
    attachments: [],
    cloudDocLinks: [],
    sharedDocIds: [],
    unparsed: [],
    observations: [],
    evidenceBearing: false,
    isPrivate: false,
    ...over,
  };
}

interface FakeHandle extends ChatSessionHandle {
  followupLog: string[];
  injectLog: string[];
  running: boolean;
}

function fakeHandle(over: { running?: boolean; injectOk?: boolean; followupFail?: boolean } = {}): FakeHandle {
  const log: FakeHandle = {
    sessionId: "sess",
    running: over.running ?? false,
    followupLog: [],
    injectLog: [],
    status() {
      return this.running ? "running" : "idle";
    },
    followup(text: string) {
      if (over.followupFail) throw new Error("followup boom");
      log.followupLog.push(text);
    },
    inject(text: string) {
      if (over.injectOk === false) return false;
      log.injectLog.push(text);
      return true;
    },
  };
  return log;
}

test("分诊矩阵：未 @ 且未引用的群消息 → drop", async () => {
  const d = new EventDedup({ limit: 128 });
  const router = new WpsRouter({ dedup: d, ensure: async () => fakeHandle() });
  assert.equal(await router.handleEvent(ev()), "drop");
});

test("分诊矩阵：私聊消息进队；未运行 + 无会话 → ensure 建立会话并投递", async () => {
  const d = new EventDedup({ limit: 128 });
  const handle = fakeHandle();
  const ensured: string[] = [];
  const router = new WpsRouter({
    dedup: d,
    ensure: async (chatId) => {
      ensured.push(chatId);
      return handle;
    },
  });
  assert.equal(await router.handleEvent(ev({ isPrivate: true, chatType: "p2p" })), "enqueue");
  assert.equal(ensured.length, 1);
  assert.equal(router.getTask(ensured[0]!)?.chatId, "c1");
  assert.equal(handle.followupLog.length, 1);
  assert.ok(handle.followupLog[0]!.includes("requester 张三(u1)"));
});

test("分诊矩阵：运行中 + direct + 无 evidence → inject（intervention seam）+ ack", async () => {
  const d = new EventDedup({ limit: 128 });
  const handle = fakeHandle({ running: false });
  const acks: string[] = [];
  const router = new WpsRouter({
    dedup: d,
    ensure: async () => handle,
    ackIntervention: async (chatId, userId) => {
      acks.push(`${chatId}:${userId}`);
    },
  });
  // 先建会话（a1 私聊投递成立）
  await router.handleEvent(ev({ eventId: "a1", isPrivate: true }));
  handle.running = true;
  assert.equal(await router.handleEvent(ev({ eventId: "a2", mentioned: true })), "inject");
  assert.equal(handle.injectLog.length, 1);
  assert.deepEqual(acks, ["c1:u1"]);
  assert.equal(d.has("a2"), true);
});

test("分诊矩阵：运行中但带附件 → 不走 inject，落队；idle 后串行 drain", async () => {
  const d = new EventDedup({ limit: 128 });
  const handle = fakeHandle({ running: false });
  const router = new WpsRouter({ dedup: d, ensure: async () => handle });
  // a1 空闲投递成立 →视同当轮任务在跑
  await router.handleEvent(ev({ eventId: "a1", isPrivate: true, text: "t1" }));
  handle.running = true;
  assert.equal(
    await router.handleEvent(
      ev({
        eventId: "a2",
        mentioned: true,
        attachments: [{ kind: "file", storageKey: "stor-1", name: "a.pdf", size: 1, mime: "" }],
        evidenceBearing: true,
      }),
    ),
    "enqueue",
  );
  assert.equal(handle.injectLog.length, 0);
  assert.equal(handle.followupLog.length, 1); // 只有 a1 的投递（t1）
  handle.running = false;
  const taskIds = [...router.entries()].map(([k]) => k);
  assert.equal(taskIds.length, 1);
  await router.drain(taskIds[0]!);
  assert.equal(handle.followupLog.length, 2);
  assert.ok(handle.followupLog[1]!.includes("附件"));
});

test("分诊矩阵：dedup 同 event_id 再投递 → duplicate；release 后允许接管", async () => {
  const d = new EventDedup({ limit: 128 });
  const handle = fakeHandle();
  const router = new WpsRouter({ dedup: d, ensure: async () => handle });
  assert.equal(await router.handleEvent(ev({ eventId: "m9", isPrivate: true })), "enqueue");
  assert.equal(await router.handleEvent(ev({ eventId: "m9", isPrivate: true })), "duplicate");
  assert.equal(handle.followupLog.length, 1);
  // drop 不 accepted：同 id 重新到、行状改 direct → 仍能被接管
  assert.equal(await router.handleEvent(ev({ eventId: "m10", text: "x" })), "drop");
  assert.equal(await router.handleEvent(ev({ eventId: "m10", isPrivate: true })), "enqueue");
});

test("分诊矩阵：P-C quote 语义——注册表/卡钩命中目标任务 → 继承注入；裸历史 id 不算", async () => {
  const d = new EventDedup({ limit: 128 });
  const handle = fakeHandle();
  // 卡3 裁：注前 fake quoteLookup（single-source）——代双写热件
  const regHits = new Map<string, { sessionId: string; chatId: string }>();
  const router = new WpsRouter({
    dedup: d, ensure: async () => handle,
    quoteLookup: { lookup: (id: string) => regHits.get(id) ?? null },
  });
  await router.handleEvent(ev({ eventId: "b1", isPrivate: true, text: "borne" }));
  // 任务键从任务表取
  const taskKey = [...router.entries()].map(([k]) => k)[0]!;

  // 未引用的群非@（且无注册表命中）→ drop
  assert.equal(await router.handleEvent(ev({ eventId: "b2", quoteMsgId: "b1" })), "drop");

  // 注册表记账：quote→task 交绑（setland 注册表消费的宿主输入面）→ 另一用户引用进场
  regHits.set("o-1", { sessionId: taskKey, chatId: "c1" });
  handle.running = true;
  assert.equal(await router.handleEvent(ev({ eventId: "b3", quoteMsgId: "o-1", senderId: "u2", senderName: "李" })), "inject");
  const task = router.getTask(taskKey);
  assert.ok(task?.participants.some((p) => p.userId === "u2"));

  // 卡钩在跑命中（quoteTaskOwner 供生面）——钩值须为 host 自己的任务键
  let k2 = "";
  const router2 = new WpsRouter({
    dedup: new EventDedup({ limit: 128 }),
    ensure: async () => handle,
    quoteTaskOwner: (q: string) => (q === "card-1" ? k2 : null),
  });
  await router2.handleEvent(ev({ eventId: "c0", isPrivate: true, text: "borne" }));
  k2 = [...router2.entries()][0]![0]!;
  handle.running = true;
  assert.equal(await router2.handleEvent(ev({ eventId: "c1x", quoteMsgId: "card-1" })), "inject");
});

test("分诊矩阵：followup 失败 → 补充回队首，不重释已投递", async () => {
  const d = new EventDedup({ limit: 128 });
  let injectFailedOnce = true;
  const handle: FakeHandle = {
    sessionId: "sess",
    running: false,
    followupLog: [],
    injectLog: [],
    status() {
      return "idle";
    },
    followup() {
      if (injectFailedOnce) {
        injectFailedOnce = false;
        throw new Error("first attempt failed");
      }
    },
    inject() {
      return false;
    },
  };
  const router = new WpsRouter({ dedup: d, ensure: async () => handle });
  // A2 裁：followup 失败回队首不抛——dedup accepted,队列自持待再触发下（不借 WPS 重投）
  await router.handleEvent(ev({ eventId: "f1", isPrivate: true }));
  assert.equal(handle.followupLog.length, 0);
  await router.drain("c1");
  assert.equal(handle.followupLog.length, 0); // 第二次成功无日志，只计 not throw
});

test("defaultFactify：head 含 chat/requester，未落盘附件落占位行 + observations 原样进面", () => {
  const out = defaultFactify(
    ev({
      text: "",
      evidenceBearing: true,
      attachments: [{ kind: "file", storageKey: "s", name: "a", size: 0, mime: "" }],
      observations: ["Attachment download failed for a at /x: boom"],
    }),
  );
  assert.ok(out.includes("[WPS 任务 |"));
  assert.ok(out.includes("附件 a（未落盘）"));
  assert.ok(out.includes("Attachment download failed for a at /x: boom"));
});

test("defaultFactify：已落盘附件给模型可读路径（GA downloads 语用）", () => {
  const out = defaultFactify(
    ev({
      text: "",
      attachments: [{ kind: "image", storageKey: "s", name: "p.png", size: 3, mime: "image/png", localPath: "/ws/downloads/d41/01_p.png" }],
    }),
  );
  assert.ok(out.includes("附件 p.png → /ws/downloads/d41/01_p.png"));
  assert.ok(!out.includes("未落盘"));
});

test("R2：factify head 带防幻觉固定行；R5：image 附件带「不得声称看到了图」明示", () => {
  const text = defaultFactify(ev({ text: "看看" }));
  // 文案换代（评审：P-D 后「历史不可见」是假命题——工具已存在）
  assert.ok(text.includes("要翻历史就调 search_wps_history，不要编造"));
  assert.ok(text.includes("不要编造"));
  const withImage = defaultFactify(ev({ attachments: [{ kind: "image", storageKey: "k", name: "a.png", size: 1, mime: "image/png", localPath: "/tmp/x/a.png" }] as never }));
  assert.ok(withImage.includes("未进入视觉链路"));
  assert.ok(withImage.includes("不得声称看到了图"));
  const withFile = defaultFactify(ev({ attachments: [{ kind: "file", storageKey: "k", name: "b.zip", size: 1, mime: "application/zip" }] as never }));
  assert.ok(!withFile.includes("不得声称看到了图"));
});
