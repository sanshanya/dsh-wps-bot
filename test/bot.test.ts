import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
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
  private seq = 0;

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
