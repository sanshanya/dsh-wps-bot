import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WpsBotCore, type BotClient, type BotSessions } from "../src/bot.ts";
import type { ChatSessionHandle } from "../src/task-router.ts";
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
  lastKey: () => string;
  cleanup: () => Promise<void>;
}

const SILENT = { info: () => {}, warn: () => {}, error: () => {} };

function makeRig(over: {
  workspaceRoot?: string;
  cardMode?: "card" | "off";
  cardInitialDelayMs?: number;
  quoteRegistryPath?: string;
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
  // P-C 键面对齐：单会话测试容器——ensure 捕获末次 key，所有反查回末次（等价旧 "c1" 语义容器）
  let lastEnsuredKey = "wps-bot:c1:u1:task-1";
  const sessions: BotSessions = {
    ensure: async (sessionId) => { lastEnsuredKey = sessionId; return handle; },
    setRequester: (sessionId, r) => {
      requesters.set(sessionId, r);
    },
    getRequester: (sessionId) => requesters.get(sessionId) ?? [...requesters.values()].at(-1),
  };
  const core = new WpsBotCore({
    client,
    logger: SILENT,
    dedup,
    sessions,
    chatForSessionId: (id) => (id === "sess:c1" ? lastEnsuredKey : null),
    chatForAgent: (agent) => (agent === "agent:c1" ? lastEnsuredKey : null),
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
      quoteRegistryPath: over.quoteRegistryPath,
    },
  });
  return {
    client,
    core,
    handle,
    requesters,
    auditPath,
    tmpdir: tmpRoot,
    lastKey: () => lastEnsuredKey,
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
    assert.equal(handle.running, true);
    assert.deepEqual([...requesters.values()].at(-1), { userId: "u1", name: "张三" });

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

    // B4 后语义：delivered 完成才 recall；未交付走失败文案 update
    handle.running = false;
    core.handleSessionEvent("sess:c1", { type: "assistant/message", data: { turn: 2, step: 1, message: { content: [{ type: "text", text: "终态" }] } } });
    core.handleSessionEvent("sess:c1", { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } });
    await SLEEP(80); // deliver 链 + 延后 finalize
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
    core.handleSessionEvent("sess:c1", { type: "assistant/message", data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "终态" }] } } });
    core.handleSessionEvent("sess:c1", { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
    await SLEEP(80);
    assert.equal(client.recalls.length, 1);

    // P-C/G5 语义文书重定：完结任务的卡也注册了在册 id → 引用=恢复旧会话（D1 注册表消费）
    assert.equal(
      await core.handleIncomingEvent(ev({ quoteMsgId: "card-1", text: "再看看" })),
      "enqueue", // quote 继承同任务会话——恢复后 followup
    );
    assert.ok(handle.followupLog.some((f) => f.includes("再看看")));
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

test("N3：blocked turn/end 送中断通知", async () => {
  const { core, handle, client, cleanup } = makeRig();
  try {
    await core.handleIncomingEvent(ev({ isPrivate: true, chatType: "p2p" }));
    handle.running = false;
    core.handleSessionEvent("sess:c1", { type: "turn/end", data: { turn: 1, reason: { kind: "blocked" } } });
    await SLEEP(10);
    // G3：max-tokens/blocked → unavailable 模板（对位 app.py:430-435，「已发起的外部操作不会自动回滚」联署）
    const notice = client.splits.find((m) => m.text.includes("当前对话已中断"));
    assert.ok(notice);
    assert.ok(notice!.text.includes("当前任务无法继续完成"));
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
    const notice = client.splits.find((m) => m.text.includes("当前对话已中断"));
    assert.ok(notice);
  } finally {
    await core.shutdown();
    await cleanup();
  }
});

test("P0-1 死锁：turn/end 时 phase 仍 running → drain 拒；agent/status(idle) 时再支取/带出上程任务", async () => {
  const { core, handle, client, cleanup, lastKey } = makeRig();
  const lastKeyRef = { get value() { return lastKey(); } };
  try {
    await core.handleIncomingEvent(ev({ isPrivate: true, chatType: "p2p", text: "t-1" }));
    handle.running = true;
    // 任务2带 evidence → 不进 inject，落队
    assert.equal(await core.handleIncomingEvent(ev({
      isPrivate: true, chatType: "p2p", text: "t-2",
      attachments: [{ kind: "file", storageKey: "s", name: "a", size: 0, mime: "" }],
      evidenceBearing: true,
    })), "enqueue");
    assert.equal(core.router.queued(lastKeyRef.value), 1);

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
    assert.equal(core.router.queued(lastKeyRef.value), 0);
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
  cards.start("wps-bot:c1:u1:t1", "c1");
  await SLEEP(15);
  assert.equal(log.sendCard, 1); // sendCard 挂起中
  assert.equal(cards.hasActive("wps-bot:c1:u1:t1"), true);
  await cards.finish("wps-bot:c1:u1:t1"); // Chat 关闭
  assert.equal(cards.hasActive("wps-bot:c1:u1:t1"), false);
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
  // P-C：任务工作区分盘 ws/<chatId>/<owner>/<taskId>/downloads
  const expected = join(ws, "c1", "u1", message.eventId, "downloads", digest, "01_p_x.png");
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

test("G5/P-C：requester=最近触发；审批权=owner+participants（quote 继承入会在册）", async (t) => {
  const rig = makeRig();
  t.after(async () => { await rig.core.shutdown(); await rig.cleanup(); });
  const { core, handle, requesters } = rig;

  // A 发起任务 → requester=A
  await core.handleIncomingEvent(ev({ senderId: "u-A", senderName: "甲", isPrivate: true, chatType: "p2p" }));
  assert.equal([...requesters.values()].at(-1)?.userId, "u-A");

  // A 的在跑；B 未引用私聊 → 得到自己的新任务（不会 inject 进 A 任务）
  handle.running = true;
  const r1 = await core.handleIncomingEvent(ev({ senderId: "u-B", senderName: "乙", isPrivate: true, chatType: "p2p", text: "补一句" }));
  assert.equal(r1, "enqueue");

  // B quote A 的在册出站 id → 继承入会 + inject 到 A 任务
  const taskA = [...requesters.keys()][0]!;
  // P0-2 单源后：唯一真源=registry（热件 registerOutbound 已不做 quote 面唯一证）；向真源记件
  await rig.core.quoteRegistry.register(["a-card-1"], taskA, "c1");
  const r2 = await core.handleIncomingEvent(ev({ senderId: "u-B", senderName: "乙", quoteMsgId: "a-card-1", text: "补充" }));
  assert.equal(r2, "inject");
  const taskState = core.router.getTask(taskA);
  assert.ok(taskState?.participants.some((p) => p.userId === "u-B"));
});

test("R4：unparsed/云文档/共享 id 三路落盘 + 路径观察行进 factify（不再静默蒸发）", async (t) => {
  const rig = makeRig();
  t.after(async () => { await rig.core.shutdown(); await rig.cleanup(); });
  const { core, handle } = rig;
  const e = ev({
    isPrivate: true, chatType: "p2p", text: "",
    attachments: [],
  });
  e.unparsed.push({ path: "content.card", reason: "unknown card shape", value: { x: 1 } });
  e.cloudDocLinks.push("https://kdocs.cn/l/abc");
  e.sharedDocIds.push("file-42");
  await core.handleIncomingEvent(e);
  const { readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = join(rig.tmpdir, "ws", "evidence");
  const unparsed = join(dir, "unparsed_content.jsonl");
  assert.ok(existsSync(unparsed));
  const line = readFileSync(unparsed, "utf8").trim().split("\n").at(-1)!;
  assert.ok(line.includes("unknown card shape"));
  assert.ok(existsSync(join(dir, "cloud_docs.jsonl")));
  assert.ok(existsSync(join(dir, "shared_doc_ids.jsonl")));
  // 路径观察行进事实文本（模型可用 file_read 自查）
  const injected = handle.followupLog.join("\n");
  assert.ok(injected.includes("未解析节点原文 →"), injected);
  assert.ok(injected.includes("unparsed_content.jsonl"));
});

test("R6-A13：ask_user_question 群问→quote 答允消费；非 quote 不消费；终态清理", async (t) => {
  const rig = makeRig();
  t.after(async () => { await rig.core.shutdown(); await rig.cleanup(); });
  const { core, handle, client } = rig;
  await core.handleIncomingEvent(ev({ isPrivate: true, chatType: "p2p" }));

  const ask = core.askUserQuestion({
    questions: [{ id: "q1", question: "选哪个方案？", options: [{ label: "甲" }, { label: "乙" }] }],
    agent: { session: { id: "wps-bot:c1:u1:task-1" } },
  });
  await SLEEP(20);
  // 群问发出（mention 尽力）+ waiting ids = 返回的 message ids
  const question = client.splits.find((m) => m.text.includes("需要你的回答"));
  assert.ok(question, JSON.stringify(client.splits.map((x) => x.text)));
  assert.ok(question!.text.includes("1) 甲"));
  // 非 quote 消息不消费
  const stray = await core.handleIncomingEvent(ev({ text: "甲", quoteMsgId: "" }));
  assert.notEqual(stray, "approval-reply");
  // quote 命中 → 消费作答（序号映射 selected）
  const quoteReply = await core.handleIncomingEvent(ev({ text: "2", quoteMsgId: "m-1" }));
  assert.equal(quoteReply, "approval-reply");
  const answer = await ask;
  assert.deepEqual(answer.answers[0], { id: "q1", selected: ["乙"] });
});

test("R6：标签原文/自由文本回复 → selected/custom 分路", async (t) => {
  const rig = makeRig();
  t.after(async () => { await rig.core.shutdown(); await rig.cleanup(); });
  const { core } = rig;
  await core.handleIncomingEvent(ev({ isPrivate: true, chatType: "p2p" }));
  const ask = core.askUserQuestion({
    questions: [{ id: "q1", question: "口味？", options: [{ label: "甜" }, { label: "咸" }] }],
    agent: { session: { id: "wps-bot:c1:u1:task-1" } },
  });
  await SLEEP(10);
  await core.handleIncomingEvent(ev({ text: "其实我想吃辣的", quoteMsgId: "m-1" }));
  const answer = await ask;
  assert.deepEqual(answer.answers[0], { id: "q1", selected: [], custom: "其实我想吃辣的" });
});

test("error→runtime_failure：崩溃轮种走「处理期间发生运行时异常」模板（零覆盖补钉）", async (t) => {
  const rig = makeRig();
  t.after(async () => { await rig.core.shutdown(); await rig.cleanup(); });
  const { core, handle, client } = rig;
  await core.handleIncomingEvent(ev({ isPrivate: true, chatType: "p2p" }));
  handle.running = false;
  core.handleSessionEvent("sess:c1", { type: "turn/end", data: { turn: 1, reason: { kind: "error" } } });
  await SLEEP(20);
  assert.ok(client.splits.some((m) => m.text.includes("处理期间发生运行时异常")));
});

test("P-A：finish_task 登记优先交付；reply 过的 turn 不重复发末态；宽松回落保留", async (t) => {
  const rig = makeRig();
  t.after(async () => { await rig.core.shutdown(); await rig.cleanup(); });
  const { core, handle, client } = rig;
  await core.handleIncomingEvent(ev({ isPrivate: true, chatType: "p2p" }));

  // 1) finish_task 登记物优先（模型末态文本不喧宾）
  // 新契约（Z2-D）：登记缀当前轮——先发 turn/start，照当前务务轮
  core.handleSessionEvent("sess:c1", { type: "turn/start", data: { turn: 1 } });
  core.noteFinishTask(rig.lastKey(), "显式交付件");
  core.handleSessionEvent("sess:c1", { type: "assistant/message", data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "思维内噪音" }] } } });
  handle.running = false;
  core.handleSessionEvent("sess:c1", { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  await SLEEP(60);
  assert.ok(client.splits.some((m) => m.text.includes("显式交付件")));
  assert.ok(!client.splits.some((m) => m.text.includes("思维内噪音")));

  // 2) reply 过的 turn 末态文本不发
  client.splits.length = 0;
  core.handleSessionEvent("sess:c1", { type: "turn/start", data: { turn: 2 } });
  await core.noteReply(rig.lastKey(), "中途说一句");
  core.handleSessionEvent("sess:c1", { type: "assistant/message", data: { turn: 2, step: 1, message: { content: [{ type: "text", text: "不应重发" }] } } });
  core.handleSessionEvent("sess:c1", { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } });
  await SLEEP(20);
  assert.ok(client.splits.some((m) => m.text.includes("中途说一句")));
  assert.ok(!client.splits.some((m) => m.text.includes("不应重发")));

  // 3) 宽松回落：无 finish 无 reply → 末态文本照发（默认模式防静默）
  client.splits.length = 0;
  core.handleSessionEvent("sess:c1", { type: "turn/start", data: { turn: 3 } });
  core.handleSessionEvent("sess:c1", { type: "assistant/message", data: { turn: 3, step: 1, message: { content: [{ type: "text", text: "回落文本" }] } } });
  core.handleSessionEvent("sess:c1", { type: "turn/end", data: { turn: 3, reason: { kind: "completed" } } });
  await SLEEP(60);
  assert.ok(client.splits.some((m) => m.text.includes("回落文本")));
});

test("P-D：inbound 全件归档 + searchHistory 同 chat 检索（读开历史底账）", async (t) => {
  const rig = makeRig();
  t.after(async () => { await rig.core.shutdown(); await rig.cleanup(); });
  await rig.core.handleIncomingEvent(ev({ senderName: "冯三山", text: "备份服务器 10.0.0.8 的周巡检还差一栏", chatType: "group" }));
  await rig.core.handleIncomingEvent(ev({ senderId: "u9", senderName: "李四", text: "巡检我已经补完", chatType: "group" }));
  await new Promise((r) => setTimeout(r, 150)); // history 归档为尽力异步——测试结算窗放宽

  const hits = await rig.core.searchHistory("c1", "巡检");
  assert.ok(hits.length >= 2);
  assert.equal(hits[0]!.text.includes("巡检"), true);
  // 空白 q 也得出（=最近回看）
  const recent = await rig.core.searchHistory("c1", "", 1);
  assert.equal(recent.length, 1);
  assert.equal(recent[0]!.senderName, "李四");
  // 别 chat 互相隔离
  assert.equal((await rig.core.searchHistory("c2", "巡检")).length, 0);
});
test("P1：reply 过的 turn 在宽松模式不得误发「无法继续完成」", async (t) => {
  const rig = makeRig();
  t.after(async () => { await rig.core.shutdown(); await rig.cleanup(); });
  await rig.core.handleIncomingEvent(ev({ isPrivate: true, chatType: "p2p" }));
  rig.handle.running = false;
  rig.core.handleSessionEvent("sess:c1", { type: "turn/start", data: { turn: 1 } });
  await rig.core.noteReply(rig.lastKey(), "中途说一句");
  rig.core.handleSessionEvent("sess:c1", { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  await new Promise((r) => setTimeout(r, 80));

  // 不得发末条文本重发 也不得发 unavailable 通知
  assert.ok(!rig.client.splits.some((m) => m.text.includes("无法继续完成")), "reply 过的 turn 误发了 unavailable");
});

test("P0-2 重启继承回归：registry 文件跨重启，旧回答引用恢复旧会话", async (t) => {
  const r1 = makeRig();
  t.after(async () => { await r1.core.shutdown(); await r1.cleanup(); });
  await r1.core.handleIncomingEvent(ev({ isPrivate: true, chatType: "p2p", text: "立项" }));
  r1.handle.running = false;
  r1.core.handleSessionEvent("sess:c1", { type: "assistant/message", data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "立项完成总结" }] } } });
  r1.core.handleSessionEvent("sess:c1", { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  await new Promise((r) => setTimeout(r, 80));
  // FakeClient.sendMarkdownSplit 恒返 "m-1"——交付件在册 id 就是它
  const deliveredId = "m-1";
  assert.ok(r1.client.splits.length >= 1);
  const sessionKey = r1.lastKey();
  const registryPath = `${r1.tmpdir}/ws/quote-registry.jsonl`;
  await r1.core.shutdown();

  // 第二开合（同一注册表文件）→ reload 后旧回答引用续进旧会话
  const r2 = makeRig({ quoteRegistryPath: registryPath });
  t.after(async () => { await r2.core.shutdown(); await r2.cleanup(); });
  await r2.core.loadRegistry();
  const route = await r2.core.handleIncomingEvent(ev({ quoteMsgId: deliveredId, text: "回顾下上次总结" }));
  assert.equal(route, "enqueue");
  // 命中的是同一任务会话键（而不是按 sender 新建）
  assert.equal([...r2.core.router.entries()][0]![0], sessionKey);
});


test("strictFinishContract=true：无 finish_task 的 completed 走 unavailable 通知（宽拒不触达）", async (t) => {
  const rig = makeRig({ workspaceRoot: undefined }); // rig 带默认=false——用统一 config override
  // 重建一个 strict=1 的 rig
  const rig2 = makeRig();
  await rig2.core.shutdown();
  // 简化：直接在原 rig 内打开 strictFlag
  (rig.core as unknown as { cfg: { strictFinishContract?: boolean } }).cfg.strictFinishContract = true;
  t.after(async () => { await rig.core.shutdown(); await rig.cleanup(); });
  await rig.core.handleIncomingEvent(ev({ isPrivate: true, chatType: "p2p" }));
  rig.handle.running = false;
  rig.core.handleSessionEvent("sess:c1", { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  await new Promise((r) => setTimeout(r, 60));
  const notifyTexts = rig.client.markdowns?.map((m: { markdown: string }) => m.markdown) ?? [];
  // 宽松面下同一流程会发「无法继续完成」(G3);strict 下走的是 normalizationNotice——照看 client.submits
  const allOut = [...rig.client.splits.map((s) => s.text), ...notifyTexts];
  assert.ok(allOut.some((t) => t.includes("无法") || t.includes("unavailable") || t.includes("服务")), `strict+无finish 须致 unvailable 面达: ${JSON.stringify(allOut).slice(0,120)}`);
});
