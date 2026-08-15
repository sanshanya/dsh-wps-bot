import test from "node:test";
import assert from "node:assert/strict";

import { WpsRouter, defaultFactify, type ChatSessionHandle } from "../src/dispatch.ts";
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
  assert.deepEqual(ensured, ["c1"]);
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
  await router.drain("c1");
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

test("分诊矩阵：GA quote 语义——只对在途进度卡的 quote 才算 direct；派发的历史 id 不算", async () => {
  const d = new EventDedup({ limit: 128 });
  const handle = fakeHandle();
  // 假进度卡 id "card-1"；GA busy 时才命中
  const isProgressReply = (e: WpsEvent, busy: boolean) => busy && e.quoteMsgId === "card-1";
  const router = new WpsRouter({ dedup: d, ensure: async () => handle, isProgressReply });
  await router.handleEvent(ev({ eventId: "b1", isPrivate: true, text: "borne" }));
  // quote 任务本体 eventId 的老消息（被派发过）→ 不算 direct（GA 唯一 quote 源是进度卡）
  assert.equal(await router.handleEvent(ev({ eventId: "b2", quoteMsgId: "b1" })), "drop");
  // quote 在途进度卡且会话在跑 → direct → 走 inject
  handle.running = true;
  assert.equal(await router.handleEvent(ev({ eventId: "b3", quoteMsgId: "card-1" })), "inject");
  assert.equal(handle.injectLog.length, 1);
  assert.equal(handle.followupLog.length, 1);
  // 会话空闲后 quote 同一张卡，不算 direct（GA accepts_progress_reply 要求 is_running）
  handle.running = false;
  assert.equal(await router.handleEvent(ev({ eventId: "b4", quoteMsgId: "card-1" })), "drop");
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
  await assert.rejects(router.handleEvent(ev({ eventId: "f1", isPrivate: true })), /first attempt failed/);
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
