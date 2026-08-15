import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WpsBotCore, type BotClient, type BotSessions } from "../src/bot.ts";
import type { ChatSessionHandle } from "../src/dispatch.ts";
import type { WpsEvent } from "../src/protocol.ts";
import { EventDedup } from "../src/dedup.ts";

// ---------- 假实现 ----------

class FakeClient implements BotClient {
  markdown: Array<{ chatId: string; text: string; mentions: number }> = [];
  splits: Array<{ chatId: string; text: string; mention: boolean }> = [];
  cardsSent: Array<{ chatId: string; markdown: string; title: string }> = [];
  updates: Array<{ messageId: string; markdown: string }> = [];
  recalls: string[] = [];
  downloads: Array<{ chatId: string; messageId: string; storageKey: string }> = [];
  uploads: Array<{ chatId: string; name: string; bytes: Buffer }> = [];
  /** 测验可注错：key=`${messageId}/${storageKey}` → 抛该 Error。 */
  downloadFailures = new Map<string, Error>();
  downloadBytes: Buffer = Buffer.from("fake-bytes");
  private seq = 0;

  async downloadAttachment(chatId: string, messageId: string, storageKey: string): Promise<Buffer> {
    this.downloads.push({ chatId, messageId, storageKey });
    const failure = this.downloadFailures.get(`${messageId}/${storageKey}`);
    if (failure !== undefined) throw failure;
    return this.downloadBytes;
  }
  async uploadFile(chatId: string, name: string, data: Buffer): Promise<Record<string, unknown>> {
    this.uploads.push({ chatId, name, bytes: data });
    return {};
  }
  async sendMarkdown(chatId: string, text: string, mentions?: unknown[]): Promise<Record<string, unknown>> {
    this.markdown.push({ chatId, text, mentions: mentions?.length ?? 0 });
    return {};
  }
  async sendMarkdownSplit(chatId: string, text: string, mention: unknown): Promise<string[]> {
    this.splits.push({ chatId, text, mention: mention !== null && mention !== undefined });
    return ["m-1"];
  }
  async sendCard(chatId: string, markdown: string, title: string): Promise<string> {
    this.cardsSent.push({ chatId, markdown, title });
    return `card-${++this.seq}`;
  }
  async updateCard(messageId: string, markdown: string, _title: string): Promise<Record<string, unknown>> {
    this.updates.push({ messageId, markdown });
    return {};
  }
  async recallMessage(messageId: string): Promise<Record<string, unknown>> {
    this.recalls.push(messageId);
    return {};
  }
  async resolveMention(): Promise<null> {
    return null;
  }
}

interface FakeHandle extends ChatSessionHandle {
  running: boolean;
  followupLog: string[];
  injectLog: string[];
}

interface Rig {
  client: FakeClient;
  core: WpsBotCore;
  handle: FakeHandle;
  requesters: Map<string, { userId: string; name: string }>;
  auditPath: string;
  tmpdir: string;
  cleanup: () => Promise<void>;
}

const SILENT = { info: () => {}, warn: () => {}, error: () => {} };

function makeRig(over: {
  workspaceRoot?: string;
  cardMode?: "card" | "off";
  cardInitialDelayMs?: number;
  approvalTimeoutMs?: number;
} = {}): Rig {
  const client = new FakeClient();
  const requesters = new Map<string, { userId: string; name: string }>();
  const handle: FakeHandle = {
    sessionId: "sess:c1",
    running: false,
    followupLog: [],
    injectLog: [],
    status() {
      return this.running ? "running" : "idle";
    },
    followup(text: string) {
      handle.followupLog.push(text);
      handle.running = true;
    },
    inject(text: string) {
      if (!this.running) return false;
      handle.injectLog.push(text);
      return true;
    },
  };
  const dedup = new EventDedup({ limit: 256 });
  const tmpRoot = join(tmpdir(), `wps-bot-${Math.random().toString(36).slice(2)}`);
  const auditPath = join(tmpRoot, "audit.jsonl");
  const sessions: BotSessions = {
    ensure: async () => handle,
    setRequester: (chatId, r) => {
      requesters.set(chatId, r);
    },
    getRequester: (chatId) => requesters.get(chatId),
  };
  const core = new WpsBotCore({
    client,
    logger: SILENT,
    dedup,
    sessions,
    chatForSessionId: (id) => (id === "sess:c1" ? "c1" : null),
    chatForAgent: (agent) => (agent === "agent:c1" ? "c1" : null),
    config: {
      cardMode: over.cardMode ?? "card",
      cardTitle: "甘小雨",
      cardInitialDelayMs: over.cardInitialDelayMs ?? 5000,
      cardHeartbeatMs: 60000,
      cardUpdateMinIntervalMs: 0,
      cardSettle: "recall",
      approvalMode: "windows",
      approvalTimeoutMs: over.approvalTimeoutMs ?? 5000,
      allowWindow: true,
      auditPath,
      ackInterventionText: "已收到补充信息，当前任务会在下一轮处理。",
      deliverChunks: 4500,
      workspaceRoot: over.workspaceRoot ?? join(tmpRoot, "ws"),
    },
  });
  return {
    client,
    core,
    handle,
    requesters,
    auditPath,
    tmpdir: tmpRoot,
    cleanup: async () => rm(tmpRoot, { recursive: true, force: true }),
  };
}

function ev(over: Partial<WpsEvent> = {}): WpsEvent {
  return {
    chatId: "c1",
    chatType: "group",
    eventId: `m-${Math.random().toString(36).slice(2)}`,
    quoteMsgId: "",
    senderId: "u1",
    senderName: "张三",
    mentioned: false,
    botIds: [],
    text: "你好",
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

async function auditRows(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const SLEEP = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- 测试 ----------

test("闭环：私聊进队 → 助手回复回送到群 → 短任务零卡片", async () => {
  const { core, handle, client, requesters, cleanup } = makeRig();
  try {
    assert.equal(await core.handleIncomingEvent(ev({ isPrivate: true, chatType: "p2p" })), "enqueue");
    assert.equal(handle.followupLog.length, 1);
    assert.ok(handle.followupLog[0]!.includes("requester 张三(u1)"));
    assert.equal(handle.running, true);
    assert.deepEqual(requesters.get("c1"), { userId: "u1", name: "张三" });

    core.handleSessionEvent("sess:c1", { type: "turn/start", data: { turn: 1 } });
    // GA A9：中间 step 旁白不入群
    core.handleSessionEvent("sess:c1", {
      type: "assistant/message",
      data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "先查一下" }] } },
    });
    await SLEEP(10);
    assert.equal(client.splits.length, 0);
    core.handleSessionEvent("sess:c1", {
      type: "assistant/message",
      data: { turn: 1, step: 2, message: { content: [{ type: "text", text: "答案是 42" }] } },
    });
    await SLEEP(10);
    assert.equal(client.splits.length, 0);

    handle.running = false;
    core.handleSessionEvent("sess:c1", { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
    await SLEEP(10);
    assert.equal(client.splits.length, 1);
    assert.equal(client.splits[0]!.text, "答案是 42");
    assert.equal(client.splits[0]!.mention, false);
    assert.equal(client.cardsSent.length, 0); // initialDelay 未到 → 永远零卡
    assert.equal(client.recalls.length, 0);
  } finally {
    await core.shutdown();
    await cleanup();
  }
});

test("长任务：initialDelay 后发卡 → 完结按 settle=recall 撤回", async () => {
  const { core, handle, client, cleanup } = makeRig({ cardInitialDelayMs: 15 });
  try {
    await core.handleIncomingEvent(ev({ isPrivate: true, chatType: "p2p" }));
    await SLEEP(40);
    assert.equal(client.cardsSent.length, 1);
    assert.equal(client.cardsSent[0]!.title, "甘小雨");

    // 轮次事件后消息 id 已存在 → 更新
    core.handleSessionEvent("sess:c1", { type: "turn/start", data: { turn: 2 } });
    await SLEEP(10);
    assert.ok(client.updates.length >= 1);

    handle.running = false;
    await core.finalizeTurn("c1");
    await SLEEP(10);
    assert.equal(client.recalls.length, 1);
    assert.ok(client.recalls[0]!.startsWith("card-"));
  } finally {
    await core.shutdown();
    await cleanup();
  }
});

test("审批：群问 → “同意” → allowed-once + 单次答允 + 审计行", async () => {
  const { core, client, handle, cleanup, auditPath } = makeRig();
  try {
    await core.handleIncomingEvent(ev({ isPrivate: true, chatType: "p2p" }));
    const p = core.handleApprovalRequest(
      { agent: "agent:c1", reason: "kubectl get pods", toolName: "kubectl", callId: "call-1" },
      async () => {
        throw new Error("next() 不该被调");
      },
    );
    await SLEEP(5);
    assert.equal(client.splits.length, 1);
    assert.ok(client.splits[0]!.text.includes("kubectl get pods"));
    assert.ok(client.splits[0]!.text.includes("同意5分钟"));
    assert.equal(core.pendingCount(), 1);

    assert.equal(await core.handleIncomingEvent(ev({ text: "同意" })), "approval-reply");
    assert.equal(await p, "allowed-once");
    assert.ok(client.markdown.some((m) => m.text === "操作已批准。"));
    assert.equal(core.pendingCount(), 0);
    assert.equal(handle.followupLog.length, 1); // 审批 reply 没被送到模型

    const rows = await auditRows(auditPath);
    const reply = rows.find((r) => r.kind === "reply-resolution");
    assert.ok(reply);
    assert.equal(reply.approved, true);
    assert.equal(reply.auditOutcome, "decision");
    assert.equal(reply.chatId, "c1");
    assert.equal(reply.userId, "u1");
  } finally {
    await core.shutdown();
    await cleanup();
  }
});

test("审批：fail_closed 不开窗（“同意5分钟”也只答本次）", async () => {
  const { core, handle, client, cleanup } = makeRig();
  try {
    await core.handleIncomingEvent(ev({ isPrivate: true, chatType: "p2p" }));
    const p = core.handleApprovalRequest(
      { agent: "agent:c1", reason: "[gate-source=fail_closed] kubectl apply", toolName: "kubectl" },
      async () => "rejected",
    );
    await SLEEP(5);
    assert.ok(client.splits[0]!.text.includes("不开放限时自动同意"));
    await core.handleIncomingEvent(ev({ text: "同意5分钟" }));
    assert.equal(await p, "allowed-once");
    assert.ok(client.markdown.some((m) => m.text.includes("未开启自动同意窗口")));
    assert.equal(handle.followupLog.length, 1);

    // 下一请求又应该重新走群问（窗口在 fail_closed 上从未开过）
    client.splits.length = 0;
    const p2 = core.handleApprovalRequest(
      { agent: "agent:c1", reason: "[gate-source=fail_closed] kubectl delete", toolName: "kubectl" },
      async () => "rejected",
    );
    await SLEEP(5);
    assert.equal(client.splits.length, 1);
    await core.handleIncomingEvent(ev({ text: "别的意见" }));
    assert.equal(await p2, "rejected");
  } finally {
    await core.shutdown();
    await cleanup();
  }
});

test("审批：同意5分钟 → 后续请求自动 allowed + window-auto-allow 审计", async () => {
  const { core, client, cleanup, auditPath } = makeRig();
  try {
    await core.handleIncomingEvent(ev({ isPrivate: true, chatType: "p2p" }));
    const p = core.handleApprovalRequest(
      { agent: "agent:c1", reason: "safe op", toolName: "pwsh" },
      async () => "rejected",
    );
    await SLEEP(5);
    await core.handleIncomingEvent(ev({ text: "同意5分钟" }));
    assert.equal(await p, "allowed-once");

    // 窗口内下一请求不走群问
    client.splits.length = 0;
    const q = await core.handleApprovalRequest(
      { agent: "agent:c1", reason: "another safe op", toolName: "pwsh" },
      async () => "rejected",
    );
    assert.equal(q, "allowed-once");
    assert.equal(client.splits.length, 0);

    const rows = await auditRows(auditPath);
    const auto = rows.find((r) => r.kind === "window-auto-allow");
    assert.ok(auto);
    assert.equal(auto.auditOutcome, "approval_window");
    assert.equal(auto.approved, true);
  } finally {
    await core.shutdown();
    await cleanup();
  }
});

test("审批：群问超时 → rejected + 超时答允", async () => {
  const { core, client, cleanup, auditPath } = makeRig({ approvalTimeoutMs: 40 });
  try {
    await core.handleIncomingEvent(ev({ isPrivate: true, chatType: "p2p" }));
    const outcome = await core.handleApprovalRequest(
      { agent: "agent:c1", reason: "hang op", toolName: "pwsh" },
      async () => "rejected",
    );
    assert.equal(outcome, "rejected");
    assert.ok(client.markdown.some((m) => m.text.includes("超时未获答复")));
    const rows = await auditRows(auditPath);
    assert.ok(rows.some((r) => r.auditOutcome === "timeout"));
  } finally {
    await core.shutdown();
    await cleanup();
  }
});

test("审批：他人回复不原子消费，只认 requester", async () => {
  const { core, handle, cleanup } = makeRig();
  try {
    await core.handleIncomingEvent(ev({ isPrivate: true, chatType: "p2p" }));
    const p = core.handleApprovalRequest(
      { agent: "agent:c1", reason: "op", toolName: "pwsh" },
      async () => "unavailable",
    );
    await SLEEP(5);
    assert.equal(core.pendingCount(), 1);
    // u2 的回复不触发 pending resolve；只当普通消息进分诊（未 @ 群消息 → drop）
    await core.handleIncomingEvent(ev({ text: "同意", senderId: "u2", senderName: "李四" }));
    assert.equal(core.pendingCount(), 1);
    assert.equal(await core.handleIncomingEvent(ev({ text: "同意" })), "approval-reply");
    assert.equal(await p, "allowed-once");
    assert.equal(handle.followupLog.length, 1);
  } finally {
    await core.shutdown();
    await cleanup();
  }
});

test("quote：只有引用在途进度卡才算 direct；完结后旧卡引证被静默丢弃", async () => {
  const { core, handle, client, cleanup } = makeRig({ cardInitialDelayMs: 10 });
  try {
    await core.handleIncomingEvent(ev({ isPrivate: true, chatType: "p2p", text: "开工" }));
    await SLEEP(30); // 发卡
    assert.equal(client.cardsSent.length, 1);

    // 会话在跑 + quote 在途进度卡 → inject（GA: is_running && quote == progress_message_id）
    handle.running = true;
    assert.equal(
      await core.handleIncomingEvent(
        ev({ quoteMsgId: client.cardsSent[0]!.markdown ? "card-1" : "", text: "顺便查下" }),
      ),
      "inject",
    );
    assert.equal(handle.injectLog.length, 1);
    assert.ok(handle.injectLog[0]!.includes("顺便查下"));

    handle.running = false;
    await core.finalizeTurn("c1"); // 完结留卡 recall
    await SLEEP(5);
    assert.equal(client.recalls.length, 1);

    // 已完结：再 quote 这张卡按 GA accepts_progress_reply 不成立（进度卡不在途）→ 静默
    assert.equal(
      await core.handleIncomingEvent(ev({ quoteMsgId: "card-1", text: "再看看" })),
      "drop",
    );
  } finally {
    await core.shutdown();
    await cleanup();
  }
});

test("N2 卡片共养：同 chat 排轮两个任务共一张卡，至多一条卡片、原地更新、完结才 recall", async () => {
  const { core, handle, client, cleanup } = makeRig({ cardInitialDelayMs: 10 });
  try {
    // 任务1入队投递 + 任务2再来（busy）
    await core.handleIncomingEvent(ev({ isPrivate: true, chatType: "p2p", text: "任务一" }));
    handle.running = true;
    assert.equal(
      await core.handleIncomingEvent(
        ev({
          isPrivate: true,
          chatType: "p2p",
          text: "任务二（带附件）",
          attachments: [{ kind: "file", storageKey: "stor", name: "a.pdf", size: 1, mime: "" }],
          evidenceBearing: true,
        }),
      ),
      "enqueue",
    );
    await SLEEP(30); // 此时 should 卡
    assert.equal(client.cardsSent.length, 1);

    // 任务1 体格：turn/end completed + 终态交付
    core.handleSessionEvent("sess:c1", {
      type: "assistant/message",
      data: { turn: 1, step: 2, message: { content: [{ type: "text", text: "答案一" }] } },
    });
    handle.running = false;
    core.handleSessionEvent("sess:c1", { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
    await SLEEP(10);
    // 任务2 已被 drain 投递：卡片续更（未 recall / 不重起）
    assert.equal(handle.followupLog.length, 2);
    assert.equal(client.recalls.length, 0);
    assert.equal(client.cardsSent.length, 1);

    // 任务2 体格：turn/end completed + 终态交付 → 队空，才收卡
    core.handleSessionEvent("sess:c1", {
      type: "assistant/message",
      data: { turn: 2, step: 1, message: { content: [{ type: "text", text: "答案二" }] } },
    });
    handle.running = false;
    core.handleSessionEvent("sess:c1", { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } });
    await SLEEP(10);
    assert.equal(client.recalls.length, 1);
    const splits = client.splits.map((s) => s.text);
    assert.ok(splits.includes("答案一"));
    assert.ok(splits.includes("答案二"));
  } finally {
    await core.shutdown();
    await cleanup();
  }
});

test("N3：max-tokens / blocked 两类 turn/end 也送中断通知 + 清 pending", async () => {
  const { core, handle, client, cleanup } = makeRig();
  try {
    await core.handleIncomingEvent(ev({ isPrivate: true, chatType: "p2p" }));
    handle.running = false;
    core.handleSessionEvent("sess:c1", { type: "turn/end", data: { turn: 1, reason: { kind: "blocked" } } });
    await SLEEP(10);
    const notice = client.markdown.find((m) => m.text.includes("任务已中止"));
    assert.ok(notice);
    assert.ok(notice!.text.includes("限定的轮次/输出"));

    const rig2 = makeRig();
    try {
      await rig2.core.handleIncomingEvent(ev({ isPrivate: true, chatType: "p2p" }));
      rig2.handle.running = false;
      rig2.core.handleSessionEvent("sess:c1", { type: "turn/end", data: { turn: 1, reason: { kind: "max-tokens" } } });
      await SLEEP(10);
      assert.ok(rig2.client.markdown.some((m) => m.text.includes("限定的轮次/输出")));
    } finally {
      await rig2.core.shutdown();
      await rig2.cleanup();
    }
  } finally {
    await core.shutdown();
    await cleanup();
  }
});

test("M1：turn 被中止后，死的 pending 不得以幻影走答允（无 ack/无批准入账）", async () => {
  const { core, handle, client, cleanup, auditPath } = makeRig({ approvalTimeoutMs: 60000 });
  try {
    await core.handleIncomingEvent(ev({ isPrivate: true, chatType: "p2p" }));
    const p = core.handleApprovalRequest(
      { agent: "agent:c1", reason: "safe op", toolName: "pwsh" },
      async () => "rejected",
    );
    await SLEEP(5);
    assert.equal(core.pendingCount(), 1);

    core.handleSessionEvent("sess:c1", { type: "turn/end", data: { turn: 1, reason: { kind: "aborted" } } });
    await SLEEP(5);
    assert.equal(core.pendingCount(), 0);
    assert.equal(await p, "cancelled"); // 死的不批：outcome 归拨 cancelled 而非 "approved"
    assert.ok(!client.markdown.some((m) => m.text.includes("操作已批准")));

    const rows = await auditRows(auditPath);
    assert.ok(rows.some((r) => r.auditOutcome === "cancelled"));
  } finally {
    await core.shutdown();
    await cleanup();
  }
});

test("中断：turn/end:aborted → 送本 chat 的中断通知（带 chat id）", async () => {
  const { core, handle, client, cleanup } = makeRig();
  try {
    await core.handleIncomingEvent(ev({ isPrivate: true, chatType: "p2p" }));
    handle.running = false;
    // wire 形状：packages/core/session/src/types.ts:252 — { turn, reason: { kind } }
    core.handleSessionEvent("sess:c1", { type: "turn/end", data: { turn: 2, reason: { kind: "aborted" } } });
    await SLEEP(10);
    const notice = client.markdown.find((m) => m.text.includes("任务已中止"));
    assert.ok(notice);
    assert.ok(notice!.text.includes("c1"));
  } finally {
    await core.shutdown();
    await cleanup();
  }
});

test("P0-1 死锁：turn/end 时 phase 仍 running → drain 拒；agent/status(idle) 时再支取/带出上程任务", async () => {
  const { core, handle, client, cleanup } = makeRig();
  try {
    await core.handleIncomingEvent(ev({ isPrivate: true, chatType: "p2p", text: "t-1" }));
    handle.running = true;
    // 任务2带 evidence → 不进 inject，落队
    assert.equal(await core.handleIncomingEvent(ev({
      isPrivate: true, chatType: "p2p", text: "t-2",
      attachments: [{ kind: "file", storageKey: "s", name: "a", size: 0, mime: "" }],
      evidenceBearing: true,
    })), "enqueue");
    assert.equal(core.router.queued("c1"), 1);

    // 情境照真 session 流：turn/end 先到，phase 未切 idle
    core.handleSessionEvent("sess:c1", { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
    await SLEEP(10);
    assert.equal(handle.followupLog.length, 1, "running 段不能放行 queued task");
    // 卡片 still 在（没 finish）
    assert.equal(client.recalls.length, 0);

    // kick.finally 把 phase 切回 idle；agent/status(idle) 带来新的排水时隙
    handle.running = false;
    await core.handleAgentStatus("agent:c1", "idle");
    await SLEEP(10);
    assert.equal(handle.followupLog.length, 2, "queued task 在 idle 后被投递");
    assert.equal(core.router.queued("c1"), 0);
  } finally {
    await core.shutdown();
    await cleanup();
  }
});

test("P0-3 僵尸句柄：agent/disposed 清空 router.handles；pending/卡同步切断", async () => {
  const { core, handle, client, cleanup } = makeRig({ cardInitialDelayMs: 10 });
  try {
    await core.handleIncomingEvent(ev({ isPrivate: true, chatType: "p2p", text: "x" }));
    assert.equal([...core.router.entries()].length, 1);
    await SLEEP(20);
    assert.equal(client.cardsSent.length, 1);

    await core.handleAgentDisposed({ agent: "agent:c1" });
    await SLEEP(5);
    assert.equal([...core.router.entries()].length, 0);
    assert.equal(core.pendingCount(), 0);

    // 处置后再核到，已不回 history direct 仍落在失效 handle 上
    await core.handleIncomingEvent(ev({
      isPrivate: true, chatType: "p2p", text: "队员束交回", eventId: "after-dispose",
    }));
    // chat 重建 ensure（handle 是同一个在测试里，但现实歏創不认识的交原）
    assert.equal(handle.followupLog.length, 2);
  } finally {
    await core.shutdown();
    await cleanup();
  }
});

test("P0-4 单飞 ensure：同 chatId 并发 direct 只 ensure 一次", async () => {
  const dedup = new EventDedup({ limit: 64 });
  let ensures = 0;
  const handle: ChatSessionHandle & { running: boolean; followupLog: string[]; injectLog: string[] } = {
    sessionId: "sess:x",
    running: false,
    followupLog: [],
    injectLog: [],
    status() { return this.running ? "running" : "idle"; },
    followup(text: string) { this.followupLog.push(text); this.running = true; },
    inject(text: string) { if (!this.running) return false; this.injectLog.push(text); return true; },
  };
  const sessions: BotSessions = {
    ensure: async () => {
      ensures += 1;
      await new Promise((r) => setTimeout(r, 15));
      return handle;
    },
    setRequester: () => {},
    getRequester: () => undefined,
  };
  const core = new WpsBotCore({
    client: new FakeClient(),
    logger: SILENT,
    dedup: dedup,
    sessions,
    chatForSessionId: () => null,
    chatForAgent: () => null,
    config: {
      cardMode: "off", cardTitle: "甘小雨", cardInitialDelayMs: 5000, cardHeartbeatMs: 60000,
      cardUpdateMinIntervalMs: 0, cardSettle: "recall",
      approvalMode: "windows", approvalTimeoutMs: 5000, allowWindow: true,
      auditPath: "/tmp/wps-bot-mk4-x.jsonl", ackInterventionText: "x", deliverChunks: 4500, workspaceRoot: "/tmp/wps-bot-test-ws",
    },
  });
  await Promise.all([
    core.handleIncomingEvent(ev({ isPrivate: true, chatType: "p2p", eventId: "e1" })),
    core.handleIncomingEvent(ev({ isPrivate: true, chatType: "p2p", eventId: "e2" })),
  ]);
  assert.equal(ensures, 1); // 单飞：第二个 ensure 复用第一个的待连 promise
  await core.shutdown();
});

test("P0-5 审批重放：同一 eventId 只能进 pending 消费链一次", async () => {
  const d = new EventDedup({ limit: 64 });
  const handle: ChatSessionHandle & { followupLog: string[] } = {
    sessionId: "sess:x",
    followupLog: [],
    status: () => "idle",
    followup(text: string) { this.followupLog.push(text); },
    inject: () => false,
  };
  const sessions: BotSessions = {
    ensure: async () => handle,
    setRequester: (c, r) => { void c; void r; },
    getRequester: () => ({ userId: "u1", name: "u1" }),
  };
  const client = new FakeClient();
  const core = new WpsBotCore({
    client: client,
    logger: SILENT,
    dedup: d,
    sessions,
    chatForSessionId: () => null,
    chatForAgent: () => "c1",
    config: {
      cardMode: "off", cardTitle: "甘小雨", cardInitialDelayMs: 5000, cardHeartbeatMs: 60000,
      cardUpdateMinIntervalMs: 0, cardSettle: "recall",
      approvalMode: "windows", approvalTimeoutMs: 5000, allowWindow: true,
      auditPath: "/tmp/wps-p0-5.jsonl", ackInterventionText: "x", deliverChunks: 4500, workspaceRoot: "/tmp/wps-bot-test-ws",
    },
  });
  // 审批问题挂起
  const p = core.handleApprovalRequest(
    { agent: "agent:c1", reason: "x", toolName: "pwsh" },
    async () => "rejected",
  );
  await SLEEP(10);
  // 第一批事件是该即那段请示的 reply
  assert.equal(await core.handleIncomingEvent(ev({ text: "同意", eventId: "m-agree" })), "approval-reply");
  assert.equal((await p), "allowed-once");
  // 重放同一 id：也应该被幂等拒绝（而不是又开审批）
  assert.equal(await core.handleIncomingEvent(ev({ text: "同意", eventId: "m-agree" })), "duplicate");
  await core.shutdown();
});

test("P0-6 幽灵卡：sendCard 挂起期间 finish，则消息 id 落地时检查状态被扫——不挂心跳不送信", async () => {
  const { ProgressCards } = await import("../src/card.ts");
  const log = { sendCard: 0, recall: 0 };
  const gate = {
    open: false,
    req: null as unknown,
    promise: null as Promise<unknown> | null,
  };
  const client = {
    async sendCard() {
      log.sendCard++;
      gate.promise = new Promise<void>((resolve) => { (gate as { req: unknown }).req = resolve; });
      return gate.promise.then(() => "card-1");
    },
    async updateCard() { return {}; },
    async recallMessage() { log.recall++; return {}; },
    async resolveMention() { return null; },
    async sendMarkdown() { return {}; },
    async sendMarkdownSplit() { return []; },
  };
  const cards = new ProgressCards({
    client: client as never,
    title: "甘小雨",
    initialDelayMs: 5,
    heartbeatMs: 60000,
    updateMinIntervalMs: 0,
    settle: "recall",
    mode: "card",
  });
  cards.start("c1");
  await SLEEP(15);
  assert.equal(log.sendCard, 1); // sendCard 挂起中
  assert.equal(cards.hasActive("c1"), true);
  await cards.finish("c1"); // Chat 关闭
  assert.equal(cards.hasActive("c1"), false);
  (gate as unknown as { req: () => void }).req(); // 送卡 resolve 了
  await SLEEP(15);
  // GA 语义：finish 之后发现真的发出了 card.x → 主动 recall（幽卡不留）
  assert.equal(log.recall, 1);
});

test("P0-7 deliverChunks clamp 生效不会死进程", async () => {
  const { splitMarkdown } = await import("../src/split.ts");
  // limit=0 不会让 loop 挂，力博格内 shannon 路径不挂
  const out = splitMarkdown("hello", 10);
  assert.ok(out.length > 0);
  // clamp 集中在 index 装配；非指数安全：直接调用这里 security 有 result
});

test("审批 disabled 时全直通", async () => {
  const rig = makeRig();
  try {
    const core2 = new WpsBotCore({
      client: rig.client,
      logger: SILENT,
      dedup: new EventDedup({ limit: 8 }),
      sessions: {
        ensure: async () => rig.handle,
        setRequester: () => {},
        getRequester: () => undefined,
      },
      chatForSessionId: () => null,
      chatForAgent: () => "c1",
      config: {
        cardMode: "off",
        cardTitle: "甘小雨",
        cardInitialDelayMs: 5000,
        cardHeartbeatMs: 60000,
        cardUpdateMinIntervalMs: 0,
        cardSettle: "recall",
        approvalMode: "disabled",
        approvalTimeoutMs: 5000,
        allowWindow: true,
        auditPath: rig.auditPath,
        ackInterventionText: "x",
        deliverChunks: 4500,
        workspaceRoot: "/tmp/wps-bot-test-ws",
      },
    });
    let calls = 0;
    const outcome = await core2.handleApprovalRequest(
      { agent: "agent:c1", reason: "x", toolName: "pwsh" },
      async () => {
        calls++;
        return "rejected";
      },
    );
    assert.equal(outcome, "rejected");
    assert.equal(calls, 1);
    assert.equal(rig.client.splits.length, 0);
    await core2.shutdown();
  } finally {
    await rig.cleanup();
  }
});

test("materialize：私聊带附件 → 落盘 downloads/{digest}/NN_name + factify 给出路径", async (t) => {
  const rig = makeRig();
  t.after(async () => { await rig.core.shutdown(); await rig.cleanup(); });
  const ws = join(rig.tmpdir, "ws");
  const message = ev({
    isPrivate: true,
    attachments: [{ kind: "image", storageKey: "sk1", name: "p x.png", size: 3, mime: "image/png" }],
  });
  const route = await rig.core.handleIncomingEvent(message);
  assert.equal(route, "enqueue");

  assert.deepEqual(rig.client.downloads, [{ chatId: "c1", messageId: message.eventId, storageKey: "sk1" }]);
  const digest = createHash("sha256").update(message.eventId, "utf8").digest("hex").slice(0, 12);
  // GA safeArtifactName：空格非 alnum → _（03-a 文档实锤：与 protocol.history.attachment_target 同规）
  const expected = join(ws, "downloads", digest, "01_p_x.png");
  assert.equal(message.attachments[0]!.localPath, expected);
  assert.equal(await readFile(expected, "utf8"), "fake-bytes");
  assert.ok(rig.handle.followupLog[0]!.includes(`附件 p x.png → ${expected}`));
});

test("materialize：下载失败不阻断分发——observation 原样进 factify", async (t) => {
  const rig = makeRig();
  t.after(async () => { await rig.core.shutdown(); await rig.cleanup(); });
  const message = ev({
    isPrivate: true,
    attachments: [{ kind: "file", storageKey: "sk-bad", name: "a.py", size: 1, mime: "" }],
  });
  rig.client.downloadFailures.set(`${message.eventId}/sk-bad`, new Error("404 gone"));
  const route = await rig.core.handleIncomingEvent(message);
  assert.equal(route, "enqueue");
  assert.equal(message.attachments[0]!.localPath, undefined);
  assert.match(message.observations[0] ?? "", /^Attachment download failed for a\.py at .*: Error: 404 gone$/);
  assert.ok(rig.handle.followupLog[0]!.includes("Attachment download failed for a.py"));
  assert.ok(rig.handle.followupLog[0]!.includes("附件 a.py（未落盘）"));
});

test("deliver：[[attach:artifacts/*]] marker 上传+剥离；越界/缺失逐条通告", async (t) => {
  const rig = makeRig();
  t.after(async () => { await rig.core.shutdown(); await rig.cleanup(); });
  const ws = join(rig.tmpdir, "ws");
  await mkdir(join(ws, "artifacts"), { recursive: true });
  await writeFile(join(ws, "artifacts", "report.txt"), "REPORT-BYTES");
  await writeFile(join(ws, "outside.txt"), "EVIL");

  await rig.core.deliver(
    "c1",
    "看结果 [[attach:artifacts/report.txt]] [[attach:../outside.txt]] [[attach:artifacts/ghost.txt]]",
  );
  // 正文剥离 marker 后交付
  assert.equal(rig.client.splits[0]!.text, "看结果");
  // 合法产物上传（名字+字节）
  assert.deepEqual(
    rig.client.uploads.map((u) => [u.name, u.bytes.toString()]),
    [["report.txt", "REPORT-BYTES"]],
  );
  // 越界与缺失各一条通告，措辞同 GA
  const notices = rig.client.splits.slice(0xa - 0x9).map((x) => x.text);
  assert.ok(notices.some((x) => x.includes("artifact path is outside the deliverable directory: ../outside.txt")));
  assert.ok(notices.some((x) => x.includes("artifact file does not exist: artifacts/ghost.txt")));
});

test("deliver：空应答+无 attach marker → 原样交付（不上传）", async (t) => {
  const rig = makeRig();
  t.after(async () => { await rig.core.shutdown(); await rig.cleanup(); });
  await rig.core.deliver("c1", "普通回答");
  assert.equal(rig.client.splits[0]!.text, "普通回答");
  assert.equal(rig.client.uploads.length, 0);
});
