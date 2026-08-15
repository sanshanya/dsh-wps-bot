import test from "node:test";
import assert from "node:assert/strict";

import { parseConsent, ApprovalWindowStore, windowAllows } from "../src/consent.ts";

test("parseConsent：GA 答复矩阵", () => {
  // 同意 / approve（无分钟数）→ 0（单次）
  assert.equal(parseConsent("同意"), 0);
  assert.equal(parseConsent("approve"), 0);
  assert.equal(parseConsent("同意。"), 0);
  assert.equal(parseConsent(" 同意  "), 0);
  // 同意 N 分钟 → N
  assert.equal(parseConsent("同意5分钟"), 5);
  assert.equal(parseConsent("同意 90 分钟"), 90);
  assert.equal(parseConsent("approve 15min"), 15);
  assert.equal(parseConsent("同意2分"), 2);
  assert.equal(parseConsent("同意1m"), 1);
  assert.equal(parseConsent("同意10minutes"), 10);
  // 同意0分钟 → null（视为未同意）
  assert.equal(parseConsent("同意0分钟"), null);
  assert.equal(parseConsent("同意00分钟"), null);
  // 其他 → null
  assert.equal(parseConsent("不同意"), null);
  assert.equal(parseConsent("同意吧"), null);
  assert.equal(parseConsent(""), null);
  assert.equal(parseConsent("同意+5"), null);
});

function fakeClock(start: number) {
  const state = { t: start };
  return { now: () => state.t, set: (t: number) => { state.t = t; } };
}

test("ApprovalWindowStore：开仓/有效/到期清除", () => {
  const clock = fakeClock(1000);
  const store = new ApprovalWindowStore({ now: clock.now });
  store.grant("c1", "u1", 5);
  assert.equal(store.hasActive("c1", "u1"), true);
  assert.equal(store.hasActive("c1", "u2"), false); // 键含 user
  clock.set(1000 + 299);
  assert.equal(store.hasActive("c1", "u1"), true);
  clock.set(1000 + 300); // exp <= now → 过期清
  assert.equal(store.hasActive("c1", "u1"), false);
  store.grant("c1", "u1", 5);
  store.clearAll();
  assert.equal(store.hasActive("c1", "u1"), false);
});

test("windowAllows：allow_window=false 时窗口永不生效（approval.py:62）", () => {
  const clock = fakeClock(1000);
  const store = new ApprovalWindowStore({ now: clock.now });
  store.grant("c1", "u1", 5);
  assert.equal(windowAllows(store, "c1", "u1", true), true);
  assert.equal(windowAllows(store, "c1", "u1", false), false);
});

test("ApprovalWindowStore：expiresAt / 重启清除（纯内存）", () => {
  const clock = fakeClock(1000);
  const store = new ApprovalWindowStore({ now: clock.now });
  assert.equal(store.expiresAt("c1", "u1"), null);
  const exp = store.grant("c1", "u1", 10);
  assert.equal(store.expiresAt("c1", "u1"), exp);
  // 新实例 = 重启 → 无遗留窗口
  const store2 = new ApprovalWindowStore({ now: clock.now });
  assert.equal(store2.hasActive("c1", "u1"), false);
});
