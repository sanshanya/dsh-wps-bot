import test from "node:test";
import assert from "node:assert/strict";

import { splitMarkdown } from "../src/split.ts";

test("splitMarkdown：空文本 → [\"\"]", () => {
  assert.deepEqual(splitMarkdown(""), [""]);
  assert.deepEqual(splitMarkdown("   "), [""]);
});

test("splitMarkdown：短于上限不拆", () => {
  assert.deepEqual(splitMarkdown("hello\n\nworld", 100), ["hello\n\nworld"]);
});

test("splitMarkdown：贪心装填（GA _split 合入规则）", () => {
  const a = "a".repeat(60);
  const b = "b".repeat(60);
  assert.deepEqual(splitMarkdown(`${a}\n\n${b}`, 100), [a, b]);
  assert.deepEqual(splitMarkdown(`${a}\n\n${b}`, 124), [a + "\n\n" + b]);
});

test("splitMarkdown：单段超限先结清再硬切", () => {
  const pre = "x".repeat(10);
  const big = "y".repeat(25);
  assert.deepEqual(splitMarkdown(`${pre}\n\n${big}`, 10), [pre, "y".repeat(10), "y".repeat(10), "y".repeat(5)]);
});

test("splitMarkdown：CRLF 归一", () => {
  assert.deepEqual(splitMarkdown("a\r\n\r\nb", 10), ["a\n\nb"]);
});

test("split：硬切遇高代理回退 1 位（emoji 不拦腰）", () => {
  // 构造：limit 切点恰好落在 emoji(高+低代理) 中间
  const head = "a".repeat(9);
  const emoji = "\u{1F600}"; // 2 个 UTF-16 单元
  const text = head + emoji + "b".repeat(20);
  const parts = splitMarkdown(text, 10);
  // 无守卫时 parts[0] = 9a + 高代理；守卫后 = 9a
  assert.equal(parts[0], head);
  assert.ok(parts[1]!.startsWith(emoji));
  for (const p of parts) assert.ok(p.length <= 10);
});
