/**
 * r8 P1 回归钉（真 dsh-settings 契约）：secret 键不设默认——
 * 未配置时 describe 的 secrets 槽 set:false（页面显示「未配置」而非谎报「已配置」）；
 * 用户层写入后 set:true，且值永不下线每层。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import SettingsProvider, { installSettingsSection } from "@deepseek-ai/dsh-settings";

import { apply, Config } from "../src/index.ts";
import type { WpsBotConfig } from "../src/index.ts";

class MemorySettings extends SettingsProvider {
  private doc: Record<string, unknown> = {};
  override get writable(): boolean { return true; }
  override async load(): Promise<Record<string, unknown>> { return this.doc; }
  override async persist(ns: string, section: unknown): Promise<void> { this.doc[ns] = section; }
}

const emptyCfg = (Config as unknown as (v: unknown) => WpsBotConfig)({});

test("secret presence：未配置 set:false；写入后 set:true；值永不下线", async () => {
  const root = new Context();
  root.plugin(MemorySettings);

  root.provide("agents", { create: async () => ({}), resume: async () => ({}) });
  root.provide("tools", { register: () => {} });
  root.provide("userQuestions", { registerProvider: () => () => {} });
  const savedEnv = { id: process.env.WPS365_CLIENT_ID, sec: process.env.WPS365_CLIENT_SECRET, sp: process.env.WPS365_SP_ID };
  delete process.env.WPS365_CLIENT_ID; delete process.env.WPS365_CLIENT_SECRET; delete process.env.WPS365_SP_ID;
  try {
    // 真 ctx：installSettingsSection 的 ctx.inject 面只能在真 cordis 上活（stub 无 inject 被抓即舍）
    root.plugin(((ctx: unknown) => { apply(ctx as never, emptyCfg, { installSettingsSection: installSettingsSection as never }); }) as never, {} as never);
    await new Promise((r) => setTimeout(r, 20)); // 离帧定时器

    const settings = root.get("settings") as unknown as {
      describe: (o?: unknown) => Array<{ ns: string; secrets: Array<{ path: string[]; set: boolean }>; value: Record<string, unknown> }>;
      update: (ns: string, patch: object) => Promise<unknown>;
    };
    const view0 = settings.describe({ redactSecrets: true }).find((n) => n.ns === "wps-bot");
    assert.ok(view0 !== undefined, "未配置时 ns 已在");
    const slots0 = Object.fromEntries(view0.secrets.map((s) => [s.path.join("."), s.set]));
    assert.equal(slots0["clientSecret"], false, "未配置必须 set:false（此前的「已配置」谎报源于 default(\"\")）");
    assert.equal(slots0["accessToken"], false);
    assert.equal(view0.value["clientSecret"], undefined, "secret 值不下线——包括默认空串");

    await settings.update("wps-bot", { clientSecret: "sk-real" } as never);
    const view1 = settings.describe({ redactSecrets: true }).find((n) => n.ns === "wps-bot");
    assert.equal(view1?.secrets.find((s) => s.path[0] === "clientSecret")?.set, true);
    assert.equal(view1?.value["clientSecret"], undefined, "写入后值仍不下线——write-only 契约");
  } finally {
    for (const [k, v] of [["WPS365_CLIENT_ID", savedEnv.id], ["WPS365_CLIENT_SECRET", savedEnv.sec], ["WPS365_SP_ID", savedEnv.sp]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
