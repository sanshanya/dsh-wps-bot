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
