# dsh-wps-bot

WPS 365 聊天通道插件：把 DeepSeek Harness（dsh）的 Agent 从 WPS 群聊/私聊里带起来。事件经 `open-event-sdk` 长连接入站，Markdown/卡片经 WPS365 OpenAPI 出站——与 ksbot_ga 形态 A 同一 wire 面，但合并进**单进程 TypeScript 插件**（同源自给，不再需要「Node bridge + Python 壳」两个进程）。

- 项目归属：<https://github.com/sanshanya/dsh-wps-bot>
- 上游形态：<https://github.com/sanshanya/ksbot_ga>
- 社区同类参照：[dsh-im-hub](https://github.com/ThreeBody6666/dsh-im-hub)（打包形态）、[dsh-external/telegram](https://gitlab.com/dsh-external/telegram)（per-chat 会话骨架）、[dsh-lark-bot](https://gitlab.com/PlutoKeating/dsh-lark-bot)（交付粒度与发布物管控）

## GA 模块 → TS 模块对照

| ksbot_ga | 本仓库 | 迁契约要点 |
| --- | --- | --- |
| `bridge/wps_event_bridge.mjs` + `wps_event_normalize.mjs` | `src/index.ts`（boot 段）+ `src/protocol.ts` | `chat_id` / `chat_type` / `content` / `mentions` / `event_id` / `quote_msg_id` 字段面逐字对齐；`app/sp` 自带消息过滤 |
| `ga_wps/app.py` 分诊 + `SeenEvents` | `src/dispatch.ts` + `src/dedup.ts` | 幂等 claim/record/release、JSONL 持久化 + 按 limit 压缩；evidence_bearing 不走运行中注入；同 chat FIFO 串行；注入后的可控 ack |
| `ga_wps/progress.py` | `src/card.ts` | `甘小雨` 卡片标题；`已收到，正在处理。`/心跳/轮次/工具正文模板逐字对齐；短任务零交互；settlement 默认 recall |
| `ga_wps/approval.py` | `src/consent.ts` + `src/audit.ts` + `src/index.ts` | 同意矩阵（`同意` / `同意N分钟` / `同意0分钟`）；`(chat,user)` 键窗口（重启清除）；fail_closed 一律不开窗；JSONL 记账 |
| `ga_wps/client.py` | `src/client.ts` | KSO-1 签名（`X-Kso-Authorization: KSO-1 <id>:<sig>`）、OAuth token 过期前 300s 主动刷新、4500 上限分段、`/recall` 撤回、卡片/mention payload |

**主动裁掉**（按产品边界）：kubectl gate（那是 `dsh-gate-kubectl` / ksbot-dsh `plugins/gate-kubectl` 的落地，不是本插件职责）、历史回放、skill 树、APScheduler 重试调度、Docs/Sheets MCP 成熟技能。`pending window` 的 `[gate-source=]` 锚点已依赖 `reason` 存世——插件收到 `fail_closed` 一律不开窗。

## 安装

```bash
dsh plugin --profile wpsbot add @deepseek-ai/dsh-base   # 环境骨架（LLM 与会话/sandbox）
dsh plugin --profile wpsbot add dsh-wps-bot
dsh --profile wpsbot
```

凭据（从 WPS 365 开发者后台生成）：

```bash
export WPS365_CLIENT_ID=...
export WPS365_CLIENT_SECRET=...
export WPS365_SP_ID=...
```

`WPS365_API_BASE` 默认 `https://openapi.wps.cn`，代理端点自行覆盖。

## 配置

`cordis.patch.yml` 中的行（参考 `examples/wps-bot.cordis.yml`）：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `clientId` / `clientSecret` / `spId` | 空 | WPS365 应用凭据；空了回落到环境变量并保持 fail-loud |
| `apiBase` | `https://openapi.wps.cn` | OpenAPI 合路 |
| `provider` / `model` | deepseek-official / deepseek-v4-flash | Agent 模型面 |
| `workspaceRoot` | 进程 cwd | 每 chat 的工作目录（每 chat 独立 session） |
| `seenEventsPath` | `runtime/wps-bot-seen-events.jsonl` | seen_events 幂等落盘 |
| `personaTitle` | `甘小雨` | 交办卡片标题 |
| `cardMode` | `card` | `card` / `off`（debug 时关闭进度卡片） |
| `cardInitialDelaySeconds` | 5 | 短任务零交互窗口（GA 默认） |
| `cardHeartbeatSeconds` | 120 | 心跳卡更新周期 |
| `cardSettle` | `recall` | 完结收口：GA 习惯 recall（撤回会有系统通知）；`update` 改为留卡更新 |
| `approvalMode` | `windows` | `windows` 走同意/窗口矩阵；`disabled` 让宿主走默认审批策略 |
| `approvalTimeoutSeconds` | 300 | 群问超时后按 reject 处理 |
| `allowWindow` | true | 限时窗开关；`false` → 只答单次；`[gate-source=fail_closed]` 的 reason 自动降级 |
| `auditPath` | `runtime/wps-bot-approval.jsonl` | 审批答应 JSONL（键面与 GA `_audit` 对齐） |
| `ackInterventionText` | `已收到补充信息，当前任务会在下一轮处理。` | 运行中注入的确认文案 |
| `deliverChunks` | 4500 | 单条 markdown 长度上限 |

## 测试

```bash
npm test
```

73 个用例（签名 / 分段 / 同意 / 幂等 / 协议 / 分发 / 卡片 / 宿主无关核心全链路 19 例 + 宿主接线纯函数 + cordis E2E + client 出站 wire 面），全部为纯 `node --test` + 假实现替身，运行不需要 WPS 凭据。协议层带**真机 REST 历史帧 regression fixture**（sp 自答 text/card、image `storage_key`、file.local、`@bot` identity 命中），防止 wire 面解析悄悄漂移。与真实 WPS 租户的真实联通验证属于产品发布通路（roadmap 第 2 项）。

`node --test` 依赖 Node ≥ 22.6 的 type stripping；`npm run typecheck`（`tsc --noEmit` strict）须 0 错。协议解析的权威顺序在 src/protocol.ts 头注：**真机帧 > GA `protocol.py:132-370` > wps-docs 官方文档 > open-event-sdk `.d.ts`**——`.d.ts` 曾在 `content.text` 键型上说错话（真机是对象不是字符串），只当线索不当真值。

## Token 预算

本仓由 agent 维护，tracked 文本的 token 总量是维护者注意力的稀缺资源——预算 ratchet 只减不增（GA 口径：只有批准的新产品契约可提高）：

```bash
npm run survey:tokens   # 测量仪（cl100k_base 真 BPE；exit 恒 0）
npm run budget:tokens   # 门禁（超基线任一 bucket 或 total → exit 1）
```

移植自 [better-model-provider/scripts/token-survey.mjs](https://github.com/sanshanya/better-model-provider) 的测量面 + GA `token_budget.py` 的 ratchet 门禁。基线在 `scripts/token-baseline.json`；提高预算的唯一动作是 `node scripts/token-budget.mjs --regen` 单行 commit。设计差（相对 BMP 原稿）：bucket 按本仓布局（src/ test/ docs+examples 其余 tooling）、计数核心与门禁单信源、js-tiktoken 在 devDependencies 显式锁版。per-source 比值（tests/docs/tooling）仅作观察，不入闸。

## 分层

- **纯模块**（无 dsh 依赖，假件可测）：`signature.ts` / `split.ts` / `consent.ts` / `dedup.ts` / `protocol.ts` / `client.ts`（假 fetch）/ `dispatch.ts` / `card.ts`（假 client）
- **宿主无关核心**：`bot.ts`（`WpsBotCore`：事件入口/审批答允/会话事件分流/回包），全部由假实现驱动测 19 用例
- **宿主边界**：`index.ts` 只做 cordis 接线（open-event-sdk 长连接、`ctx.agents.create`、`session/event` 订阅、`approval/request` prepend waterfall、`dispose` 纪律）

## 模态（一套接口，自然应对全模态）

设计原则：协议层把一切入站 content 节点归一到**一只模型**——`WpsEvent.text`（含 inline `<at>`）、`attachments[]`（`{kind, name, storageKey}`：image/audio/video/sticker/file.local/custom_emoji）、`cloudDocLinks`/`sharedDocIds`/`unparsed` 三条辅道；出站暂为 markdown/card 两通道。模型与宿主只见归一面，不见 wire 形状差异——新增模态 = 协议层多认一只节点，业务面零改动。

对 GA 的模态语义对照（GA 真值：`ga_wps/app.py:339/391`、`client.py:412-490`）：

| 面 | GA | 本仓现状 |
|---|---|---|
| 入站解析归一 | protocol.py 全节点集 | ✅ 全量 + 真帧 fixture 背书 |
| 入站字节 | run 前 eager download 全部附件 → `downloads/` + observations 入提示词 | ❌ 只注入「附件 ×N」占位，模型拿不到内容 |
| 出站文件 | `result.files` 逐个 `upload_file`（两段：`POST /v7/chats/resources/upload` 分配 sha256 → PUT 字节 → 按后缀发 image/file 消息） | ❌ 无 upload API |
| 多模态本体 | 经 dsh 桥间接收 | ➖ dsh-llm `ContentBlock` 已有 image 语义块 + provider 能力门（message.ts image admission），通道已备 |

v1 增件拆分（按依赖排序，每步独立可验）：

1. `client.downloadAttachment` / `client.uploadFile`——GA 端点逐字移植，假 fetch 锁 wire；
2. 入站：`dispatch` 前下载到 `${workspaceRoot}/downloads/{chatId}/{eventId}/{idx}-{name}`，factify 注入本地路径清单（对位 GA observations）；
3. 出站：turn settle 时扫描 `${workspaceRoot}/artifacts/` 的新文件并上传（GA `result.files` 的 dsh 对位）；
4. 透传策略：image 且 provider admission 放行 → image 内容块；否则交路径、模型经 fs/pwsh 工具读。

## Roadmap（先打通产品闭环，再做抛光）

1. ✅ **本版**：协议/分诊/卡片/审批纯模块 + 宿主接线 + 33 用例。
2. **真实联通自证**：同一天与真 WPS 租户 + 真 LLM profile 合跑文本问答、进度卡片、限时窗三条主场景。
   - **首帧抓包**：✅ ① @bot 群消息 `mentions[].id` 是下标串（`"1"`），真命中在 `mentions[].identity.id == spId`（另有 `<at id>N 展示名</at>` 字面兜底）；② bot 自发消息 `sender.type == "sp"`、`sender.id == spId`（`SELF_TYPES` 已含），卡片类自发消息 `content` 为 `null`——三样均来自真帧，已固化进 `test/protocol.test.ts` 的 `REAL_FRAMES`；③ **WS 投递面**：群聊帧只在消息 @bot 时下发——实测同群同时段，@bot 文本帧到达（16:41:58.772 → .470Z 收到），两条不带 @ 的 image/file 消息（16:42:02/16:42:12）SDK Debug 面连 `Received event` 都没有（服务端未推，REST 历史可见）。推论：dispatch 的「群非 @ 证据/闲聊」分支在 WS-only 部署是平台性死路（GA 同桥同限制，非本仓缺陷）；附件触达 bot 的唯一入路是**发消息时顺带 @bot**。
3. **v1 增件**：GA 完整 content 节点集灌贯（含媒体字节下载与多模态透传，见「模态」一节）、历史回放、Docs/Sheets MCP 似真、`dsh-gate-kubectl` 同合。

## 许可证

MIT
