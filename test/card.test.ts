import test from "node:test";
import assert from "node:assert/strict";

import { renderCard, ProgressCards, type CardLikeClient } from "../src/card.ts";

test("renderCard：GA progress.py 正文模板逐字对齐", () => {
  const base = {
    startedAt: 1000,
    lastActivity: 1060,
    phase: "正在准备任务",
    turn: 2,
    tool: "kubectl",
  };
  // elapsed 60 → 1 分钟；idle 0 → 刚刚有活动；turn 存在 → 轮尾挂轮次；tool 优先于阶段行
  assert.equal(
    renderCard(base, 1060),
    "已收到，正在处理。\n\n心跳：1 分钟，刚刚有活动，轮次 2\n工具：kubectl",
  );
  // 无 tool 且有自定义相位 + idle<60 → 阶段行
  assert.equal(
    renderCard({ ...base, tool: "", phase: "正在等待模型和工具", turn: null }, 1060),
    "已收到，正在处理。\n\n心跳：1 分钟，刚刚有活动",
  );
  assert.equal(
    renderCard({ ...base, tool: "", phase: "等待人工审批", turn: null }, 1060),
    "已收到，正在处理。\n\n心跳：1 分钟，刚刚有活动\n阶段：等待人工审批",
  );
  // idle >= 60 → “N 分钟前：相位”
  const idleLong = { ...base, lastActivity: 820, tool: "" };
  assert.equal(
    renderCard(idleLong, 1060),
    "已收到，正在处理。\n\n心跳：1 分钟，4 分钟前：正在准备任务，轮次 2",
  );
  // elapsed < 60 → 不到 1 分钟；自定义相位 + idle<60 → 阶段行照常渲染
  assert.equal(
    renderCard({ startedAt: 900, lastActivity: 920, phase: "p", turn: null, tool: "" }, 930),
    "已收到，正在处理。\n\n心跳：不到 1 分钟，刚刚有活动\n阶段：p",
  );
});

function fakeClient(log: { sendCard: unknown[]; updateCard: unknown[]; recall: string[] }): CardLikeClient {
  return {
    async sendCard(chatId: string, markdown: string, title: string): Promise<string> {
      log.sendCard.push({ chatId, markdown, title });
      return "card-1";
    },
    async updateCard(messageId: string, markdown: string): Promise<unknown> {
      log.updateCard.push({ messageId, markdown });
      return {};
    },
    async recallMessage(messageId: string): Promise<unknown> {
      log.recall.push(messageId);
      return {};
    },
  };
}

test("ProgressCards：initialDelay 内完结 → 零交互（GA 短任务不发卡）", async () => {
  const log = { sendCard: [], updateCard: [], recall: [] };
  const cards = new ProgressCards({
    client: fakeClient(log),
    title: "甘小雨",
    initialDelayMs: 50,
    heartbeatMs: 60000,
    updateMinIntervalMs: 0,
    settle: "recall",
    mode: "card",
  });
  cards.start("wps-bot:c1:u1:t1", "c1");
  cards.phase("wps-bot:c1:u1:t1", { turn: 1 });
  await new Promise((r) => setTimeout(r, 20));
  await cards.finish("wps-bot:c1:u1:t1");
  assert.equal(log.sendCard.length, 0);
  assert.equal(log.recall.length, 0);
});

test("ProgressCards：超时后才发卡 + 完结 recall", async () => {
  const log = { sendCard: [], updateCard: [], recall: [] };
  const cards = new ProgressCards({
    client: fakeClient(log),
    title: "甘小雨",
    initialDelayMs: 10,
    heartbeatMs: 60000,
    updateMinIntervalMs: 0,
    settle: "recall",
    mode: "card",
  });
  cards.start("wps-bot:c2:u1:t1", "c2");
  cards.phase("wps-bot:c2:u1:t1", { turn: 2 });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(log.sendCard.length, 1);
  cards.phase("wps-bot:c2:u1:t1", { turn: 3 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(log.updateCard.length, 1);
  await cards.finish("wps-bot:c2:u1:t1");
  assert.equal(log.recall.length, 1);
});

test("ProgressCards：mode=off 完全静默", async () => {
  const log = { sendCard: [], updateCard: [], recall: [] };
  const cards = new ProgressCards({
    client: fakeClient(log),
    title: "甘小雨",
    mode: "off",
  });
  cards.start("wps-bot:c3:u1:t1", "c3");
  cards.phase("wps-bot:c3:u1:t1", { turn: 1 });
  await new Promise((r) => setTimeout(r, 30));
  await cards.finish("wps-bot:c3:u1:t1");
  assert.equal(log.sendCard.length, 0);
});

test("B4-a：recall 失败 → 代为 update「任务已完成…撤回失败」文案（progress.py:162-168 分支）", async () => {
  const calls: Array<{ kind: string; text?: string }> = [];
  const fake: CardLikeClient = {
    async sendCard() { return "card-1"; },
    async updateCard(_id: string, text: string) { calls.push({ kind: "update", text }); return {}; },
    async recallMessage() { calls.push({ kind: "recall" }); throw new Error("recall expired"); },
  };
  const cards = new ProgressCards({ client: fake, mode: "card", settle: "recall", title: "甘小雨", initialDelayMs: 1, heartbeatMs: 60000 });
  cards.start("wps-bot:c1:u1:t1", "c1");
  await new Promise((r) => setTimeout(r, 20));
  await cards.finish("wps-bot:c1:u1:t1", { delivered: true });
  assert.ok(calls.some((c) => c.kind === "recall"));
  assert.ok(calls.some((c) => c.kind === "update" && c.text!.includes("任务已完成") && c.text!.includes("撤回失败")));
});

test("B4-b：未交付完结 → 失败文案 update 且无 recall（progress.py:169-174 分支）", async () => {
  const calls: Array<{ kind: string; text?: string }> = [];
  const fake: CardLikeClient = {
    async sendCard() { return "card-1"; },
    async updateCard(_id: string, text: string) { calls.push({ kind: "update", text }); return {}; },
    async recallMessage() { calls.push({ kind: "recall" }); return {}; },
  };
  const cards = new ProgressCards({ client: fake, mode: "card", settle: "recall", title: "甘小雨", initialDelayMs: 1, heartbeatMs: 60000 });
  cards.start("wps-bot:c1:u1:t1", "c1");
  await new Promise((r) => setTimeout(r, 20));
  await cards.finish("wps-bot:c1:u1:t1", { delivered: false, failure: "处理期间发生运行时异常。" });
  assert.equal(calls.filter((c) => c.kind === "recall").length, 0);
  assert.ok(calls.some((c) => c.kind === "update" && c.text!.includes("处理期间发生运行时异常")));
});
