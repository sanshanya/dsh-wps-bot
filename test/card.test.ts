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
  cards.start("c1");
  cards.phase("c1", { turn: 1 });
  await new Promise((r) => setTimeout(r, 20));
  await cards.finish("c1");
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
  cards.start("c2");
  cards.phase("c2", { turn: 2 });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(log.sendCard.length, 1);
  cards.phase("c2", { turn: 3 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(log.updateCard.length, 1);
  await cards.finish("c2");
  assert.equal(log.recall.length, 1);
});

test("ProgressCards：mode=off 完全静默", async () => {
  const log = { sendCard: [], updateCard: [], recall: [] };
  const cards = new ProgressCards({
    client: fakeClient(log),
    title: "甘小雨",
    mode: "off",
  });
  cards.start("c3");
  cards.phase("c3", { turn: 1 });
  await new Promise((r) => setTimeout(r, 30));
  await cards.finish("c3");
  assert.equal(log.sendCard.length, 0);
});
