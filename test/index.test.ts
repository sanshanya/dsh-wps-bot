import test from "node:test";
import assert from "node:assert/strict";

// 该文件仅承载宿主接线层（index.ts）中抽出的纯函数（createOrResume / clearDisposedHandles）。
// 缺本机 node_modules mirror（symlink @deepseek-ai/* + open-event-sdk）时整组跳，不拖死红。

let helpers: { createOrResume: Function; clearDisposedHandles: Function } | null = null;
try {
  const mod = await import("../src/index.ts");
  helpers = { createOrResume: mod.createOrResume, clearDisposedHandles: mod.clearDisposedHandles };
} catch {
  helpers = null;
}

test("createOrResume：resume 优先；resume 失败以 create 顶补（R17）", { skip: helpers === null }, async () => {
  const { createOrResume } = helpers!;

  // resume 成功时，create 不该被调
  {
    let resumeUsed = 0;
    let created = 0;
    const handles = new Map<string, unknown>();
    const agents = {
      async resume(opts: Record<string, unknown>) {
        resumeUsed += 1;
        handles.set(String(opts.resumeSessionId), { id: "resume" });
        return { id: "resume" };
      },
      async create() {
        created += 1;
        return { id: "create" };
      },
    };
    const result = await createOrResume(agents, { sessionId: "wps-bot:c1", cwd: "/x", agentOptions: {} });
    assert.equal((result as { id: string }).id, "resume");
    assert.equal(resumeUsed, 1);
    assert.equal(created, 0);
  }

  // resume 抛错 → 回落 create，且仅一次
  {
    let resumeTried = 0;
    let created = 0;
    const agents = {
      async resume() {
        resumeTried += 1;
        throw new Error("no persisted session");
      },
      async create(opts: Record<string, unknown>) {
        created += 1;
        return { id: "create", wanted: opts.sessionId };
      },
    };
    const result = await createOrResume(agents, { sessionId: "wps-bot:c2", cwd: "/x", agentOptions: {} });
    assert.equal((result as { id: string }).id, "create");
    assert.equal(resumeTried, 1);
    assert.equal(created, 1);
  }

  // 平台没有 resume（老 dsh 版本）→ 直接 create
  {
    let created = 0;
    const agents = {
      async create() {
        created += 1;
        return { id: "create" };
      },
    };
    const result = await createOrResume(agents, { sessionId: "wps-bot:c3", cwd: "/x", agentOptions: {} });
    assert.equal((result as { id: string }).id, "create");
    assert.equal(created, 1);
  }
});

test("clearDisposedHandles：payload 是 { agent } 包装（runtime-types.ts:168），只清同引用的句柄", { skip: helpers === null }, () => {
  const { clearDisposedHandles } = helpers!;
  const deadAgent = { name: "dead" };
  const liveAgent = { name: "live" };
  const chats = new Map<string, { handle?: { agent?: unknown } }>([
    ["c1", { handle: { agent: deadAgent } }],
    ["c2", { handle: { agent: liveAgent } }],
    ["c3", { handle: undefined }],
  ]);
  const cleared = clearDisposedHandles(chats, { agent: deadAgent });
  assert.deepEqual(cleared, ["c1"]);
  assert.equal(chats.get("c1")!.handle, undefined);
  assert.equal(chats.get("c2")!.handle!.agent, liveAgent);

  // 全包形状（裸 Agent）不再清——这个正是 N1
  const cleared2 = clearDisposedHandles(chats, deadAgent);
  assert.deepEqual(cleared2, []);
  assert.equal(chats.get("c2")!.handle!.agent, liveAgent);

  // 空 payload 不炸
  assert.deepEqual(clearDisposedHandles(chats, null), []);
  assert.deepEqual(clearDisposedHandles(chats, {}), []);
});

test("default 导出必须携带 inject（vendor/loader unwrapExports 优先 default，缺则真机炸 without inject）", async () => {
  const mod = await import("../src/index.ts") as unknown as { default: { inject?: unknown; name?: string; apply?: unknown } };
  assert.deepEqual(mod.default.inject, ["agents"]);
  assert.equal(mod.default.name, "wps-bot");
  assert.equal(typeof mod.default.apply, "function");
});

