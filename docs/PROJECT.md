# PROJECT

> 基线：真机三场景全绿（2026-08-16，证据 docs/acceptance-live.md）。本文件是**目标契约**：
> 会话模型按「群×发起人×任务」迁移；实现现状与偏差、波次见最后一节。
> 同一行为只留一条路径；历史证据入 commit 与 acceptance 文档，不入本文件。

## 边界与索引

dsh-wps-bot 是 dsh（DeepSeek Harness）的 cordis 插件，把 WPS 365 事件接到 dsh agent 循环。职责边界：

- dsh 拥有：agent 生命周期、loop、工具、session 持久、approval/user-questions waterfall、模型面；本插件不改写其语义，固定上游 `@deepseek-ai/dsh-bundle`（邻仓 `deepseek-harness`，rc5+ 为基线）；组合（persona/工具注册）属宿主仓 `ksbot-dsh`。
- 本插件拥有：WPS transport、任务会话路由、交付、审批面、历史面。
- GA（ksbot_ga，deprecated）只作语义参照系；冲突处以本文件为准。

```text
src/index.ts    cordis 接线：WS 入站、REST 出站、agents 注册、事件/审批订阅、teardown
src/protocol.ts wire 归一（真机帧固定钉，@bot/自答/mention/附件/quote）
src/task-router.ts 路由与幂等（dedup、队列、inject/排队判据）→ 将演化为 task-router
src/bot.ts      会话总线（状态、卡片、审批面、交付、shutdown）→ 将拆 task-session/task-delivery
src/client.ts   WPS REST（auth、消息、卡片、附件、历史上拉）
src/{split,consent,audit,dedup,card,notify}.ts  稳定纯模块
compositions.. 宿主侧组合与 persona 见 ksbot-dsh/compositions/wps-*.cordis.yml
docs/acceptance-live.md  真机验收判据与实测记录
docs/references.md       构成依据、SDK/wps-docs 索引与抓取清单
```

## 真值优先级与传输铁律

1. 真机帧 > GA 源 > wps-docs > SDK `.d.ts`（`.d.ts` 对 `content.text` 类型曾是错的）。
2. **WS 单播律**：同一 SP 每条事件恰好投递一条连接——多开监听/双服务=随机丢消息（04:10 事故实证）。生产同 SP 同时只许一条入站连接。
3. **群聊 @ 律**：WS 只推 @bot 的群消息（抓包结论③）；非 @ 消息（含「只引用不 @」）可能不送达——B2 继承面在群内强制「引用并 @」，或 REST 补拉，由 Phase 0.5 探针裁决后写入路由正文。
4. `content.text={content:string}`；mentions[].identity.id 是真实体 id；bot 自产 `sender.type="sp"`；SP 卡片 `content:null`；REST 历史键 `data.items`、`ctime` epoch 毫秒、分页**升序**。

## 目标模型：会话 = 群 × 发起人 × 任务

- `sessionId = wps-bot:<chatId>:<ownerUserId>:<taskId>`；taskId=根消息 message_id；p2p 同构。
- 会话身份：`owner`（发起人）、`participants[]`（引用继承进入者）、`requester`（最近触发路由者）。
- 状态机二维分离：**任务态**（created→running→waiting→completed/resumed→archived；aborted 终）× **turn 态**（running/idle）。审批等待是「turn running + 任务 waiting」，不可合并。
- 完成任务不引用的再次 @ → 新任务新会话（上下文不无限涨）；引用旧回答 → resume 旧会话。
- 注册表 D1： botMessageId→sessionId，7 天/2000 条双闸，JSONL 持久化+压缩；一次任务所有出站 messageId 全注册。
- 消息路由优先级：审批 pending 答允 > quote 命中注册表（running→inject；completed→resume）> 该同户有 running/waiting 任务→inject/排队 > 新建任务。误判风险受控于 @ 律与 pending 优先。

## 工具契约：显式任务边界

- `reply({text})`：中途说、不等答——即时发群，turn 继续；本 turn 用过 reply 则末态文本不再发（去重）。
- `finish_task({text})`：终态交付登记；turn/end completed 时优先交付登记物；`[[attach:]]` 语义照旧从 finish 文本解析。
- 默认**宽松模式**：无 finish_task 时回落交付末条 assistant 文本（模型服从率未知时静默是失败）；`strictFinishContract=true` 才启用「无 finish 不交付+unavailable 通知」。服从率经真机观测后再收紧，收紧须改本文件。
- 中途问且等答：`dsh-user-questions` waterfall，通道代答，复用审批答允机器（群问/窗/audit），模板与审批不同。
- persona 注入规则（组合 persona 承担）：默认不臆造群回复；需要中途说话必须 reply；结束必须 finish_task。
- factify 防幻觉固定行（A3-P0）：每条入站文本 head 带「入群前历史对你不可见；问到就明说，不要编造。」——事实进模型，规则防幻觉。
- 图像明示降级（A6-P0，在读入透传未放行的 v1 内）：image 附件 factify 附「图片内容未进入视觉链路，仅有文件路径可用；不得声称看到了图」——模型必须明示而非静默。

## 审批模型

- any-of：owner 与 participants 任一回复「同意/同意 N 分钟」即放行；群问 @owner+@requester（同人只 @一次）。
- 窗键 `(chatId, taskId, userId)`：任务内有效、参与者各自独立、跨任务不继承；fail-closed reason 永不窗。<br>群问文案同步改为「对本任务内您本人后续待确认操作生效」。
- audit 三元组：`sessionId/taskId/ownerUserId/requesterUserId/approverUserId`(+toolName/callId/reason/…沿用）。
- G5 语义反转注记：单 requester → 多参与者是**用户定稿的产品决定**；原 G5 红测在 P-C 波次翻案改写。
- reply/finish_task 不经过 waterfall；requestPermission 保 one-shot；限时窗是通道策略，显式记录，绝不成为绕过 one-shot 的隐形授权。

## 中断、关闭与生命周期纪律

- 中断通知三模板（runtime_failure/service_stopping/unavailable，GA 文案对位），幂等，群聊 mention 尽力，不泄异常原文；completed 无文本分支发 unavailable。
- teardown 序：断入站（stop+closed 闸）→ 取消/排水（含 continuable subagents，P2 欠账）→ pending 取消 → 卡片收口 → dispose，总预算 `shutdownDeadlineSeconds`（默认 10s）。
- 投递与清理铁律（真机固化）：turn/end 发射序先于 idle——drain 只由 `agent/status(idle)` 触发；dispose 序「core 先、chats 后」；答允幂等（settled guard）；wrap 不闭包捕获句柄，投递前 `ctx.agents.get(id)===agent` 活体校验（P2）。
- 进度卡：标题「甘小雨」稳定格式（已收到/心跳/轮次/工具），不入 prompt/history；spawn 后获得 `realCardId` 前不可交互卡路由。收官对位 GA progress.py:148-174 **三分支**：已交付→recall 收口；recall 失败→update「任务已完成。正式回答已发送，但进度消息撤回失败。」；未交付→update 失败文案（默认「任务未完成，服务已停止继续处理。」）。

## 文件与历史面

- 任务写入隔离：`workspaceRoot/<chatId>/<userId>/<taskId>/{downloads,artifacts,work}`；downloads 键 `sha256(message_id)[:12]/NN_safeName`；artifacts 经 `[[attach:artifacts/FILE]]` 出群。
- 跨群历史只读：`workspaceRoot/history/<chatId>/{messages.jsonl,files/}`，全任务可读、无群级 gate；读操作写 JSONL 审计（谁/哪个 session/读了什么）。
- 证据落盘（R4）：不可归一节点、云文档链接、shared_doc_ids 三路由 JSONL 落盘（`unparsed_content.jsonl`/`cloud_docs.jsonl`/`shared_doc_ids.jsonl`，路径随事实进 prompt）——未知节点不再静默蒸发。
- `search_wps_history({chatId?,userId?,since?,until?,keywords[],limit})` 只读模型工具；模型自取旧证据继续工作。

## 呈现层（现有契约保留）

Markdown 4500 分段（CRLF 归一/自然段/硬切 UTF-16 代理体守卫/首段 mention 预留额度）；卡片两模式 cardSettle∈{update,recall}（默认 recall）；附件单件失败=观察行不致命；出站 `.jpg` 映射 `image/jpg`（GA 真值）。

## 契约×实现偏差与波次（浓缩总账）

| 波 | 内容 | 状态 |
|---|---|---|
| Phase 0 发布门禁 | lib 构建+exports/files+lockfile 重铸+`@types/node`+verify:pack；干净检出四门绿 | ✅ b4d0509 |
| Phase 0.5 投递裁决 |「纯引用不@」=非@特例，抓包结论③已覆盖：**不推**。@律裁定：群内继承强制**引用并@**(07:10:20 实证秒通);非@ 内容看板=REST 补拉，不在 v0.1 范围 | ✅ 裁决落(不再探) |
| P-A 纯增量 | finish_task（宽松默认）+reply+audit 三元组+D1 注册表模块 | ✅ c294126+6f…（工具对 registry 通道注册；P-C 时键迁移） |
| P-B 通道代答 | user-questions 接通道（复用答允机器，模板分面） | ✅ 964db43 |
| 拆分(§4) | god class 拆件：bot 978→574；task-approval/task-questions/task-delivery/history/channel-tools 归位；dispatch 正名 task-router | ✅ …|

| P-C 分叉主体 | B 路由全键(sessionId=chat×owner×taskId/并行任务/quote 注册表消费+participants 增员)+any-of 审批+窗键 sessionKey+三元组真值+任务工作区分盘 | ✅ `4e8be7e`+`d5d3bff` |
| P-D 历史面 | inbound 全件归档 ws/history/<chat>.jsonl+searchHistory+search_wps_history 工具+读审计行 | ✅ `6f38296` |
| 发版闸 | RELEASE 仪式文书 | ✅ a6bea45；U1/U2 用户域欠账目 |

## 运行与检查

宿主组装：`scripts/boot-live.ps1 -Detached`（组合 `ksbot-dsh/compositions/wps-bot.cordis.yml`）。验收：三场景判据 docs/acceptance-live.md；门禁：`node --test test/*.test.ts && tsc --noEmit && node scripts/token-budget.mjs`。token 预算=总量与分组双 ratchet，只有经批准的新产品契约可读研；regen 必带 commit msg 理据。凭据只入未跟踪文件（`F:\github\.env.wps`/`.env`）。

## 限制与负担

- Session/审批/窗为进程内状态；重启清窗；accepted 任务不持久重放。
- 归档淘汰规则（P-D 结案裁定）：
  - `quote-registry.jsonl`：7 天 / 2000 条双闸（超出整表重写，文件即事实）；
  - `ws/history/<chat>/history.jsonl`：单文件在期无自动淘汰——每次重写超 1 MB 自裁（读取最重 N=40 尾部法；大文件读慢才收紧，现文：「10 万条将重战收掞」）；
  - `ws/<chat>/<owner>/<task>/`：任务目录无自动删——完成任务 30 天后可人工清底（机制面不清除，避免观察/审计脱节）。
- 旧 GA 服务与我并存时会共用入站（单播律下两者随机丢消息）——生产部署须独占连接。
- p2p 全量推送未探测（引用继承在私聊可用性待证）。
- 模型工具服从率未知（宽松默认即为此设）。
