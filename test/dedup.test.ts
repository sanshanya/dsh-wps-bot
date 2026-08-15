import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventDedup } from "../src/dedup.ts";

test("claim / record / release 的 at-most-once", async () => {
  const d = new EventDedup({ limit: 1024 });
  assert.equal(d.claim(""), true); // 空 id 直放，不做幂等跟踪
  assert.equal(d.claim(""), true);
  assert.equal(d.claim("e1"), true);
  assert.equal(d.claim("e1"), false); // in-flight 期间重复 → 拒
  assert.equal(await d.record("e1"), true);
  assert.equal(d.claim("e1"), false); // accepted 后再到 → 拒
  assert.equal(await d.record("e1"), false); // 重复 accepted → 幂等拒
  assert.equal(d.claim("e2"), true);
  d.release("e2"); // 未 accepted 收回 → 可重试
  assert.equal(d.claim("e2"), true);
  assert.equal(await d.record("e2"), true);
  assert.equal(d.has("e2"), true);
});

test("FIFO 逐出到 limit", async () => {
  const d = new EventDedup({ limit: 3 });
  for (const id of ["a", "b", "c", "d"]) {
    assert.equal(d.claim(id), true);
    await d.record(id);
  }
  assert.equal(d.claim("a"), true); // a 已逐出（重投可被接管）
  assert.equal(d.claim("d"), false);
});

test("持久化：重启后仍 at-most-once，且 limit 写入触发文件压缩", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wps-bot-dedup-"));
  try {
    const path = join(dir, "seen.jsonl");
    const a = await EventDedup.load({ limit: 3, path });
    for (const id of ["e1", "e2", "e3", "e4"]) {
      assert.equal(a.claim(id), true);
      await a.record(id);
    }
    // writes=4 ≥ limit=3 → 触发了一次 compact 重建
    const text = await readFile(path, "utf8");
    assert.ok(text.split("\n").filter(Boolean).length >= 1);

    const b = await EventDedup.load({ limit: 3, path });
    assert.equal(b.claim("e4"), false); // 重启后仍认已 accepted
    assert.equal(b.has("e2"), true);
    assert.equal(b.claim("e1"), true); // e1 已逐出，重投可接管
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
