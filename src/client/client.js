window.__ModuleLoader__.load({ id: "dsh-wps-bot", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";
/**
 * WPS Bot 配置页面（settings.section 正规面：name+react component 第二参——对齐 ui-settings-general/:170-177）。
 * 空值 = 跟随 composition Config / dsh 注册表默认；凭据保存到 settings ns `wps-bot` 即刻（watch 启动 host bootstrap）。
 */
const React = require("react");
const e = React.createElement;

Object.defineProperty(exports, "__esModule", { value: true });
exports.name = "wps-bot/client";
exports.inject = ["slots", "locale", "connection", "remote"];

const NS = "wps-bot";

function textRow(id, labelText, value, type) {
  return e("input", { key: id, "data-field": id, defaultValue: value || "", placeholder: labelText, type: type || "text", style: { display: "block", marginBottom: 8, width: "60%" } });
}

function WpsBotSection(props) {
  const [saving, setSaving] = React.useState(false);
  const [status, setStatus] = React.useState("");
  const [providers, setProviders] = React.useState([]);
  const [models, setModels] = React.useState({});

  React.useEffect(() => {
    void (async () => {
      try {
        const rp = await props.connection.api.llm.providers({});
        if (rp.result.ok) setProviders((rp.result.value && rp.result.value.providers) ? rp.result.value.providers : []);
        if (typeof props.connection.api.llm.models === "function") {
          const rm = await props.connection.api.llm.models({});
          if (rm.result.ok) {
            const v = rm.result.value || {};
            const groups = v.groups || v.providers || [];
            const map = {};
            for (const g of groups) map[g.id] = (g.models || []).map((m) => ({ id: m.id, name: m.name || m.id }));
            setModels(map);
          }
        }
      } catch { }
    })();
  }, []);

  const [bridge, setBridge] = React.useState(true);
  const [provider, setProvider] = React.useState("");
  const [model, setModel] = React.useState("");
  const [clientId, setClientId] = React.useState("");
  const [clientSecret, setClientSecret] = React.useState("");
  const [spId, setSpId] = React.useState("");

  const onSave = async () => {
    setSaving(true); setStatus("");
    try {
      const r = await props.connection.api.settings.mutate({
        ns: NS,
        ops: [
          { path: ["bridge"], value: bridge },
      { path: ["provider"], value: provider },
          { path: ["model"], value: model },
          { path: ["clientId"], value: clientId },
          { path: ["clientSecret"], value: clientSecret },
          { path: ["spId"], value: spId },
        ],
      });
      setStatus(r.result.ok ? "已保存（即刻生效）" : ((r.result.error && r.result.error.message) || "保存失败"));
    } finally { setSaving(false); }
  };

  const listProviders = [{ provider: "", displayName: "(dsh 注册表默认)" }].concat(providers);
  const oddSet = models[provider] || [];

  return e("section", { "aria-label": "WPS Bot 配置" },
    e("h3", null, "WPS Bot 配置"),
    e("p", null, "凭据："),
    e("div", null, e("input", { placeholder: "clientId", value: clientId, onChange: (ev) => setClientId(ev.target.value), style: { display: "block", marginBottom: 8, width: "60%" } })),
    e("div", null, e("input", { placeholder: "clientSecret", type: "password", value: clientSecret, onChange: (ev) => setClientSecret(ev.target.value), style: { display: "block", marginBottom: 8, width: "60%" } })),
    e("div", null, e("input", { placeholder: "spId", value: spId, onChange: (ev) => setSpId(ev.target.value), style: { display: "block", marginBottom: 8, width: "60%" } })),
    e("p", null, "供应商 / 模型："),
    e("label", { style: { display: "block", marginBottom: 8 } },
      e("input", { type: "checkbox", checked: bridge, onChange: (ev) => setBridge(ev.target.checked) }),
      " 启用 bridge（WPS 通道）"),
    e("select", { value: provider, onChange: (ev) => setProvider(ev.target.value), style: { display: "block", marginBottom: 8 } },
      listProviders.map((p) => e("option", { key: p.provider || "default", value: p.provider }, p.displayName))),
    e("select", { value: model, onChange: (ev) => setModel(ev.target.value), style: { display: "block", marginBottom: 8 } },
      [{ id: "", name: "(catalog 默认)" }, ...oddSet].map((m) => e("option", { key: m.id || "def", value: m.id }, m.name))),
    e("button", { onClick: onSave, disabled: saving }, saving ? "保存中…" : "保存"),
    e("span", { style: { marginLeft: 12 } }, status));
}

exports.apply = function apply(ctx) {
  ctx.locale.register(NS, {
    zh: { "wps-bot.nav": "WPS Bot 配置" },
    en: { "wps-bot.nav": "WPS Bot Settings" },
  });

  ctx.slots.inject("settings.section", () => ctx.slots.register(
    { name: "settings.section", id: NS, order: 12, label: "WPS Bot 配置", locale: NS },
    WpsBotSection,
  ));
};

return module.exports;
}
});