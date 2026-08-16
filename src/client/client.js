window.__ModuleLoader__.load({ id: "dsh-wps-bot", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";
/**
 * wps-bot 设定页：settings.section——选供应商 / 模型，
 * 保存写入 settings 命名空间 `wps-bot`（宿主侧 installSettingsSection 即刻生效）。
 * 空值 = 「跟随 dsh 注册表第一路」。
 * 源：src/client/index.ts（类型已剥——此包是无工具链产物，与源同步维护）。
 */

Object.defineProperty(exports, "__esModule", { value: true });
exports.name = "wps-bot/client";
exports.inject = ["slots", "locale", "connection", "remote"];

const NS = "wps-bot";

exports.apply = function apply(ctx) {
  ctx.locale.register(NS, {
    zh: {
      "gate.title": "Gate 生产写审批",
      "gate.provider": "Gate 供应商（留空=跟随 dsh 注册表第一路）",
      "gate.model": "Gate 模型（留空=catalog 默认）",
      "gate.save": "保存",
      "gate.saved": "已保存",
      "gate.error": "保存失败",
    },
    en: {
      "gate.title": "Production Gate",
      "gate.provider": "Gate provider (empty = dsh registry first)",
      "gate.model": "Gate model (empty = catalog default)",
      "gate.save": "Save",
      "gate.saved": "Saved",
      "gate.error": "Save failed",
    },
  });

  ctx.slots.inject("settings.section", () => ctx.slots.register({
    id: NS,
    label: "Gate 生产写审批",
    mount(element) {
      const h = (tag, text) => {
        const el = document.createElement(tag);
        if (text !== undefined) el.textContent = text;
        return el;
      };
      const providerSelect = document.createElement("select");
      const modelSelect = document.createElement("select");
      const saveBtn = h("button", "保存");
      const status = h("span");
      element.appendChild(h("h3", "Gate 生产写审批"));
      const provRow = h("p");
      provRow.append(h("label", "供应商: "), providerSelect);
      const modelRow = h("p");
      modelRow.append(h("label", "模型: "), modelSelect);
      element.append(provRow, modelRow);
      const actionRow = h("p");
      actionRow.append(saveBtn, status);
      element.appendChild(actionRow);

      let groups = [];
      const refill = (sel, opts) => {
        while (sel.firstChild) sel.removeChild(sel.firstChild);
        for (const o of opts) {
          const el = document.createElement("option");
          el.value = o.value;
          el.textContent = o.label;
          sel.appendChild(el);
        }
      };
      const refillModels = () => {
        const g = groups.find((x) => x.id === providerSelect.value);
        refill(modelSelect, [{ value: "", label: "(catalog 默认)" }].concat((g && g.models ? g.models : []).map((m) => ({ value: m.id, label: m.name || m.id }))));
      };

      void (async () => {
        const rp = await ctx.connection.api.llm.providers({});
        const providers = rp.result.ok ? ((rp.result.value && rp.result.value.providers) ? rp.result.value.providers : []) : [];
        refill(providerSelect, [{ value: "", label: "(dsh 注册表第一路)" }].concat(providers.map((p) => ({ value: p.provider, label: p.displayName }))));
        if (typeof ctx.connection.api.llm.models === "function") {
          const rm = await ctx.connection.api.llm.models({});
          if (rm.result.ok) {
            const v = rm.result.value || {};
            groups = v.groups || v.providers || [];
          }
        }
        refillModels();
      })();
      providerSelect.addEventListener("change", refillModels);

      saveBtn.addEventListener("click", () => {
        void (async () => {
          status.textContent = "";
          const r = await ctx.connection.api.settings.mutate({
            ns: NS,
            ops: [
              { path: ["provider"], value: providerSelect.value },
              { path: ["model"], value: modelSelect.value },
            ],
          });
          status.textContent = r.result.ok ? " 已保存（即刻生效）" : " " + ((r.result.error && r.result.error.message) || "保存失败");
        })();
      });
      return () => { while (element.firstChild) element.removeChild(element.firstChild); };
    },
  }));
};

	return module.exports;
}
});