# 真机验收手册（真 WPS 租户 × ksbot-dsh wps-bot 组合）

## 靶场

- 宿主组合：`F:\github\ksbot-dsh\compositions\wps-bot.cordis.yml`（wps-sdk 全栈 + 本插件；persona 甘小雨在 agent-spine 层）
- boot：`pwsh F:\github\dsh-wps-bot\scripts\boot-live.ps1 -Detached`（凭据：`F:\github\.env` + `F:\github\.env.wps`，进程外不落盘）
- 群：机器人开发临时群 `91793929`；legacy GA 服务在线（双答为预期，按人设文案分辨——GA 自称"GA"）
- 快照器：`node --env-file /tmp/wps-bot-e2e/env.local examples/smoke/04-acceptance-snapshot.mjs 91793929`（WS帧×宿主日志×REST史×dedup/audit 四面）

## 前置事实（源码核验，非猜测）

- **WS 单播律（04:11 真机事故实证）**：同一 SP 的每条事件**恰好投递一条连接**——多开监听（侧车/双服务/GA+本插件）= 各连接随机丢消息。04:10 实测：任务帧→宿主、答允帧→侧车，pending 吃不到答允、重发被误当答允拒掉。**生产部署 = 同时只许一条入站连接**；验收期间禁止挂侧车。


- **ask 的唯一来源是沙盒升级**：`PreToolDecision{kind:'ask'}` 只由 pre-execute 监听器产生；组合无 hooks、gate-kubectl 关闭——通路 = 越界写先吃 deny → 模型按工具描述用 `sandbox_permissions`+justification 重试 → `approveEscalation` → `ctx.approval` → waterfall（tool-pwsh/src/index.ts:235）。模型多走一步是**预期动态**，不是失败。
- **WS 群聊只推 @bot 消息**（README Roadmap 抓包结论③）：测试消息全部带 @甘小雨；附件须与 @ 同条。
- persona 归组合；`[[attach:artifacts/*]]` 约定行已注入 persona（GA ga_runtime.py:111-114 同约定）。

## 三场景

| # | 触发（群里发） | 通过判据 |
|---|---|---|
| 1 文本问答 | `@甘小雨 读一下 F:\github\dsh-wps-bot\README.md 然后三句话总结这个项目` | 群内出现 ①进度卡（标题 甘小雨，轮次/工具行）②正文三句总结；卡 settle 后撤回 |
| 2 进度卡心跳 | 同 1（turn 超 15s 自然触发；不足则让任务更重） | 快照 REST 面看到卡消息 `updateCard` 轮替（宿主日志 open-event-sdk 帧无 ERROR） |
| 3 限时审批窗 | `@甘小雨 在 C:\Temp 创建文件 hello.txt 内容 test` | ①群内弹「**需要确认的操作**」②回 `同意5分钟` → 回执「操作已批准，并开启 5 分钟自动同意窗口。」③`C:\Temp\hello.txt` 真实落盘 ④`runtime/wps-bot-approval.jsonl` 增 allowed-once 行 ⑤5 分钟内再来一次越界写**免问**直放 |
| 4 附件材料化（选做） | `@甘小雨 这张图写了什么`+附图 | 群回引用图片内容；`${cwd}/downloads/{digest12}/01_*.png` 落盘 |

超时旁路：3 分钟无人答 → 群内「审批超时未获答复，本次操作已取消。」

## 验收后清点（2026-08-16 实测全绿）

- [x] 场景1 文本问答：04-15 17:54 三句话总结真交付（model ep-m-20260424154710-ggz8h，read README 工具调用实证）
- [x] 场景2 进度卡：每次任务 sp card 出现+终态 recall；心跳 updateCard 经 spy/drill 实证
- [x] 场景3 限时审批窗：04:17:19→35 全链 16s——群问→「同意5分钟」→ **单条**回执（settled guard）→ audit `approved:true grantMinutes:5` → `C:\Temp\hello.txt` 落盘「test」
- [x] `.sessions/` 有 `wps-bot:91793929` 持久线；宿主 stderr 零 ERROR
- [x] 真机级回归四件固化：loader default/inject、WS 单播律、答允幂等、dispose 序
- [ ] U1 断网重放窗口 / U2 GUI secret 渲染（发版闸，未测）

## 2026-08-16T06:04Z 复验（B-1 修复后新戳，旧戳保留）

06:04:20 任务→22 卡→24 群问→31 `同意5分钟`→31 单条回执→**33 模型终态回答「已在 C:\Temp\hello2.txt 创建完毕，内容为 done」**（B-1 存活期该件恒缺席）+audit approved:true+hello2.txt 落盘。B-1 病灶（session/event 全吞）闭合；session 路由→交付→卡片收口链路自此具真机证据。

## 实测中暴露并已修的对接面事故（教训登记）

1. loader `unwrapExports` default 遮蔽 inject（b64ba80→修复）；
2. WS 单播律：多连接=随机丢消息（04:10 事故；答允帧被侧车吃掉、重发任务被当答允拒）——**生产同 SP 同时只允许一条入站连接**；
3. 答允幂等：迟来答复副本不得双发 ack/audit（`1eaa6d8` settled guard）。

## 附录：首帧抓包时间戳级存证（2026-08-15 实跑，唯一存证位）

- 16:41:58.772Z（WS 下发）→ 16:41.470Z 本地收到：@bot 群消息 `mentions[].id=="1"`（下标串），真命中 `mentions[].identity.id == spId`；展示名 `甘小雨` 走 `<at id="N">…</at>` 字面兜底。
- 16:42:02.138Z / 16:42:12.226Z：两条**不带 @** 的 image/file 帧——SDK Debug 面无 `Received event`（服务端未推），REST 历史可见 → **WS 群聊只推 @bot**。
- bot 自发：`sender.type=="sp"`、`sender.id==spId`（卡片自发 content 为 null）。
