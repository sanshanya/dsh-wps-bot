/**
 * rounds/r4/y2-bug 复演案件入编（原地址 gitignored rounds/；入编版金同语义、同断言）：
 *  Y2-3 P1：chatId 键净化（history/downloads 双管道不得出逃 wsRoot）
 *  Y2-2 P2：searchHistory 新→旧顺序（「最近 N 条」= newest-first）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WpsBotCore, type BotClient, type BotSessions } from "../src/bot.ts";
import type { ChatSessionHandle } from "../src/task-router.ts";
import type { WpsEvent } from "../src/protocol.ts";
import { EventDedup } from "../src/dedup.ts";
import { HistoryStore } from "../src/history.ts";

const SILENT = { info() {}, warn() {}, error() {} };

function ev(over: Partial<WpsEvent> = {}): WpsEvent {
  return {
    chatId: "c1", chatType: "group", eventId: "e1", quoteMsgId: "", senderId: "u1",
    senderName: "n", mentioned: false, botIds: [], text: "x", attachments: [],
    cloudDocLinks: [], sharedDocIds: [], unparsed: [], observations: [],
    evidenceBearing: false, isPrivate: false, ...over,
  };
}

test("Y2-3：含 ../ 的 chatId 不得逃出 workspaceRoot（history + downloads 双管道）", async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "y2-path-"));
  const ws = join(tmpRoot, "ws");
  await mkdir(ws, { recursive: true });
  try {
    const handle: ChatSessionHandle & { running: boolean } = {
      sessionId: "sess", running: false, status: () => "idle", followup() {}, inject: () => false,
    };
    const sessions: BotSessions = {
      ensure: async () => handle, setRequester: () => {}, getRequester: () => undefined,
    };
    const client = { async downloadAttachment() { return Buffer.from("bytes"); } } as unknown as BotClient;
    const core = new WpsBotCore({
      client, logger: SILENT, dedup: new EventDedup({ limit: 64 }), sessions,
      chatForSessionId: () => null, chatForAgent: () => null,
      config: {
        cardMode: "off", cardTitle: "t", cardInitialDelayMs: 5000, cardHeartbeatMs: 60000,
        cardUpdateMinIntervalMs: 0, cardSettle: "recall", approvalMode: "windows",
        approvalTimeoutMs: 5000, allowWindow: true, auditPath: join(tmpRoot, "a.jsonl"),
        ackInterventionText: "x", deliverChunks: 4500, workspaceRoot: ws,
      },
    });
    const e = ev({
      chatId: "../../escape", isPrivate: true, chatType: "p2p", eventId: "m-1",
      attachments: [{ kind: "file", storageKey: "sk", name: "a.bin", size: 1, mime: "" }],
    });
    await core.handleIncomingEvent(e);
    await new Promise((r) => setTimeout(r, 60));

    // 一切 ws 外写入均不允许
    for (const leak of [join(tmpRoot, "escape"), join(tmpRoot, "escape", "history.jsonl")]) {
      let leakExists = true;
      try { await access(leak); } catch { leakExists = false; }
      assert.equal(leakExists, false, `不得写出 workspaceRoot：${leak}`);
    }
    await core.shutdown();
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("Y2-2：searchHistory 返回 newest-first（最近 N 条=从最新回放）", async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "y2-order-"));
  const file = join(tmpRoot, "history", "c1", "history.jsonl");
  await mkdir(join(tmpRoot, "history", "c1"), { recursive: true });
  const rows = [1, 2, 3].map((i) => JSON.stringify({
    ts: 1700000000 + i, senderUserId: `u${i}`, senderName: ["甲", "乙", "丙"][i - 1], text: `条${i}`,
  }));
  await writeFile(file, rows.join("\n") + "\n");
  try {
    const store = new HistoryStore(tmpRoot);
    const hits = await store.search("c1", "", 3);
    assert.equal(hits.length, 3);
    assert.equal(hits[0]!.senderName, "丙", "第一命中须是最新一条");
    assert.equal(hits[2]!.senderName, "甲", "最后命中须是最旧一条");
    // 关键词路同序
    const hits2 = await store.search("c1", "条", 2);
    assert.deepEqual(hits2.map((h) => h.senderName), ["丙", "乙"]);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("Y2-extra：QuoteRegistry 并发 register 串行化——A/B 都在持久层活着(不写丢)", async () => {
  const { QuoteRegistry } = await import("../src/quote-registry.ts");
  const tmpRoot2 = await mkdtemp(join(tmpdir(), "y2-seq-"));
  try {
    const reg = new QuoteRegistry(join(tmpRoot2, "r.jsonl"));
    await Promise.all([
      reg.register(["a1", "a2"], "wps-bot:c1:u1:t1", "c1"),
      reg.register(["b1"], "wps-bot:c1:u1:t2", "c1"),
    ]);
    assert.equal(reg.size, 3);
    // load 重阅同文件：全量都活着
    const reg2 = new QuoteRegistry(join(tmpRoot2, "r.jsonl"));
    await reg2.load();
    assert.equal(reg2.size, 3);
    assert.ok(reg2.lookup("b1") !== null);
  } finally {
    await rm(tmpRoot2, { recursive: true, force: true });
  }
});


test("Y2-4：QuoteRegistry persist tmp 文件名唯一（pid+seq——同 key 连写不撞名）", async () => {
  const { QuoteRegistry } = await import("../src/quote-registry.ts");
  const tmpRoot = await mkdtemp(join(tmpdir(), "y2-tmpname-"));
  try {
    const reg = new QuoteRegistry(join(tmpRoot, "r.jsonl"));
    await reg.register(["k1"], "wps-bot:c1:u1:t1", "c1");
    await reg.register(["k2"], "wps-bot:c1:u1:t1", "c1");
    // 不撞名完成，超调任务同层直过
    const reg2 = new QuoteRegistry(join(tmpRoot, "r.jsonl"));
    await reg2.load();
    assert.ok(reg2.lookup("k1") !== null && reg2.lookup("k2") !== null);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

// Y2-5 三态面见 task-questions 挂闸；走主文件缝—— host-boot E2E-1 已叫响 userQuestions 服务在场路径
