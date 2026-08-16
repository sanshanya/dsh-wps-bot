/**
 * r8 裁决回归钉（#1/#2）：
 * #1 save 成功后作废在途旧读——旧 revision 永远不得回落（否则下次 save 带陈旧 CAS 基线 → 假性 settings-conflict）。
 * #2 namespace 在手时后台刷新失败=提示条+页面保活；只有首载失败才扳 error 面。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { WpsBotController } from "../src/client/store.ts";
import type { WpsBotRemoteApi } from "../src/client/store.ts";

function ns( nsName: string, revision: number) {
  return { ns: nsName, revision, value: {}, secrets: [], applies: "live" as const, schema: {} };
}

function apiStub(behaviors: {
  describeImpl?: (signal?: AbortSignal) => Promise<unknown>;
  mutateImpl?: (req: { expectedRevision?: number }) => Promise<unknown>;
}) {
  const ok = (value: unknown) => ({ result: { ok: true as const, value } });
  const api: WpsBotRemoteApi = {
    settings: {
      async describe(_req: Record<string, never>, signal?: AbortSignal) {
        return ((await behaviors.describeImpl?.(signal)) ?? ok({
          writable: true, hasDocument: true, namespaces: [ns("wps-bot", 1)],
        })) as never;
      },
      async mutate(req: { ns: string; ops: never[]; expectedRevision?: number }) {
        return ((await behaviors.mutateImpl?.(req)) ?? ok(ns("wps-bot", (req.expectedRevision ?? 0) + 1))) as never;
      },
    },
    llm: {
      async providers() { return { result: { ok: true as const, value: { providers: [] } } } as never; },
      async models() { return { result: { ok: true as const, value: { groups: [], failures: [] } } } as never; },
    },
  };
  return api;
}

test("#1 竞态：save 落地后在途旧读回落被拒绝——revision 永不退", async () => {
  let releaseSlow!: (v: unknown) => void;
  const slow = new Promise((r) => { releaseSlow = r; });
  const api = apiStub({
    describeImpl: async () => {
      await slow; // 老读挂起——等 save 先落
      return { result: { ok: true, value: { writable: true, hasDocument: true, namespaces: [ns("wps-bot", 1)] } } };
    },
  });
  const c = new WpsBotController(api);
  const staleRead = c.load(); // revision 1 的在途读
  // 先把快照放上（防 save 的 namespace guard）：手工 set
  c.store.setSnapshot({ ...c.store.getSnapshot(), status: "ready", namespace: ns("wps-bot", 7) as never });
  await c.save([{ op: "set", path: ["bridge"], value: false }]); // 响应 revision 8
  assert.equal(c.store.getSnapshot().namespace?.revision, 8);
  releaseSlow(undefined); // 旧读终于回来——带着 revision 1
  await staleRead;
  assert.equal(c.store.getSnapshot().namespace?.revision, 8, "旧读回落=假性冲突母体，必须拒发");
});

test("#2 保活：namespace 在手刷新失败 → ready+提示条；首载失败 → error 面", async () => {
  const okDescribe = { result: { ok: true, value: { writable: true, hasDocument: true, namespaces: [ns("wps-bot", 3)] } } };

  // 首载失败 → error 面
  const c1 = new WpsBotController(apiStub({ describeImpl: async () => { throw new Error("boom"); } }));
  await c1.load();
  assert.equal(c1.store.getSnapshot().status, "error");

  // 已载后刷新失败 → 保活 + error 提示条（页面仍渲染）
  let fail = false;
  const c2 = new WpsBotController(apiStub({
    describeImpl: async () => {
      if (fail) throw new Error("net flap");
      return okDescribe;
    },
  }));
  await c2.load();
  assert.equal(c2.store.getSnapshot().status, "ready");
  fail = true;
  await c2.reload();
  const snap = c2.store.getSnapshot();
  assert.equal(snap.status, "ready", "页面保活——不得扳 error 面");
  assert.equal(snap.namespace?.revision, 3, "旧视图留场");
  assert.ok(snap.error !== null && snap.error.includes("net flap"), "提示条可见");
});
