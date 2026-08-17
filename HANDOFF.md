# HANDOFF — dsh-wps-bot

> 给下一位接手者（人或 agent）的一页全貌。读它 + `AGENT_RULES` + `docs/` 即可续命。
> 最后更新：r9 前夕（HEAD 见 git）。

## 这是什么

DeepSeek Harness (dsh) 的 cordis 插件：WPS 365 群聊机器人通道——把 dsh agent 接到 WPS 群（长连接收消息、markdown/卡片回复、限时开窗审批、终态交付）。
生产形态 = dsh web profile（`/root/.dsh/profiles/web`，plugin 以 `link:` 挂本仓）**单进程**装载；没有旁路服务。

## 硬边界（犯了会挨雷）

1. **不 push 除非明批**（本轮已双 authorize 破例一次）。
2. 插件加载后**不动 webui 与原生 dsh 任何东西**（AGENT_RULES:23）；只对 WPS 侧入流量生效；设置页只是配置页。
3. 不碰用户的 dsh 进程/profile/数据（不 restart、不 pkill、读日志也只读）。
4. 可自证的声明必须先自证再报绿；每个外部评审断言先对树裁 STALE/VALID 再修。
5. `rounds/` 永不入 git。

## 架构地图（src/）

| 件 | 职 |
|---|---|
| `index.ts` | cordis apply：Config schema、凭据 merge（settings>env>composition）、**通道状态机**（teardown/startBootstrap/凭据指纹）、设置节注册（离帧 setTimeout + deps.installSettingsSection 缝）、`.wps_context.json` 落盘 |
| `client.ts` | WPS OpenAPI（KSO-1 签名在 `signature.ts`，token client_credentials） |
| `bot.ts` | WpsBotCore：路由/审批开窗/卡片/交付/history 落盘（fire-and-forget 接力链，shutdown 前 `drain()`） |
| `channel-tools.ts` | **模型可见业务 tool 只有 `finish_task`**（r9 前是 finish_task+reply+search_wps_history，第二轮极简工具面已撤） |
| `history.ts` | 逐 chat jsonl 归档；`historyFilePath` 是寻址单源 |
| `src/client/` | 设置页源码树（esbuild → `lib/browser.js`，ModuleLoader 壳，id=包名）：store（describe/mutate+expectedRevision+generation 竞态闸）/WpsBotSection（草稿 Apply/Revert、conflict 语义、secret write-only）/styles（--dsw-alias-* 令牌）/locales（zh+en）/wire（type-only 契约） |
| `scripts/wps-chat.mjs` + `skills/wps-chat/` | skill 驱动面：`history` 读本地归档（零网络）；`reply` 直发（凭据只吃 env） |

## 关键语义现状（r8 封盘后）

- **工具面**：`pwsh/skill/finish_task` + dsh 组合原生；业务 tool 禁增（第二轮 §2.1）。
- **Gate**：独立 AI Gate（`ksbot-dsh/plugins/gate-production` v2）挂 `tools/pre-execute`；出口 ONLY=恰好一次 `submit_gate_decision` tool call；`isConcurrencySafe===true` 原生直通；不可用默认 fail-closed ask；[gate-source=] 前缀是审批开窗联动载体。
- **设置页 = 凭据入口**：空凭据不抛错；`clientSecret/accessToken` 无默认（presence 语义）；bridge 默认开；保存即刻生效（onChange → 状态机）。
- **settings NS**：`wps-bot`，installSettingsSection 官方面 + composition entry 兜底。

## 门禁（全绿才算完）

```bash
timeout 240 node --test test/*.test.ts   # 110
npx tsc --noEmit && npx tsc --noEmit -p tsconfig.client.json
npm run build                            # lib + lib/browser.js
node scripts/token-budget.mjs            # 红则 --regen 单行 commit（需产品契约理由）
node scripts/verify-pack.mjs             # 白名单+consumer 双探测+browser bundle 契约+孤儿 map
```

## 部署/运行姿

- 生产：`dsh web`（用户的，别动）自动挂本仓 link；改代码后 `npm run build` + **用户自己重启 web**。
- 备用长连宿主：`scripts/boot-live.sh -d`（WSL；env 从 `/mnt/f/github/.env[.wps]`）。**严禁与 web profile 双连 WPS WS**。
- 真机验收口径：页面填 cred → 日志 `[wps-bot] listening` → 群里 @ 它。

## 挂账（r9 波 α 候选）

1. `exports["./client"]` types d.ts 出口。
2. React 渲染面测试（引 jsdom/RTL 与否**需用户拍板**）。
3. 真机 GUI 装载验证（悬案）。
4. gate v0.2 欠账余量：inbound 凭据/环境探测 parity；evidence 终审复评。

## 相关仓

- `ksbot-dsh`（姊妹仓，已推 `sanshanya/ksbot_dsh`）：gate-production 插件 + 组合 + design/。
- 评判语义祖坟：`ksbot_ga`（python GA——凡语义分歧先查它再开口）。
