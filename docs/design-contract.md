# 设计契约 × 现行实现 偏差总账（2026-08-16 定稿）

> 本文件是产品契约：实现向它收敛，不向 GA 收敛。GA 只作语义参照系。
> 偏差级：✅ 已合 / ◐ 部分 / ○ 未做 / ⚡ 与现行冲突须返工。

## A. 任务边界与回复契约

| 契约 | 现行 | 偏差 |
|---|---|---|
| A1 `finish_task(result)` 显式交付；turn/end 交付登记物，**fallback 最后 assistant 文本** | 无工具；completed 时发最后 assistant 文本（GA A9 移植） | ○ 增量：session 面新增登记+交付换源；fallback 已存在 |
| A2 `reply(text)` 中途说不等答 | 无 | ○ 新增通道工具（模型面注册+tool/call 即时发送+turn 末去重规则） |
| A3 中途问且等答 → **user-questions 通道代答**（与 approval 同 waterfall 纪律） | 组合已挂 `dsh-user-questions`；通道未接 | ○ 复用 approval 答允机器（群问/窗/audit 改答题面） |
| A4 默认不臆造群回复；无工具动作只更卡片 | 已合：中间 step 文本从不进群 | ✅ |
| A5 审批悬挂（turn 内 fail-closed） | approval waterfall 悬挂，真机已验 | ✅ |

## B. 会话粒度与路由（⚡ 最大分叉件）

| 契约 | 现行 | 偏差 |
|---|---|---|
| B1 会话=(chatId, ownerUserId, taskId=根消息 id)；sessionId=`wps-bot:<chatId>:<ownerUserId>:<taskId>` | `wps-bot:<chatId>` 单会话/chat，resume 优先 | ⚡ 全路由重写：dispatch/bot/卡片/pending 全部多键化 |
| B2 quote→注册表：running→inject；completed→resume | quote 只绑「在途进度卡」(accepts_progress_reply) | ⚡ 需 bot 消息注册表（botMessageId→sessionId，7天/2000条，JSONL 持久+压缩） |
| B3 无引用+有 running→inject/排队；无 running→新建 | 已合（per-chat 粒度下同形） | ◐ 粒度换键后语义保留 |
| B4 p2p 长期单会话 + 新任务可拆子会话 | p2p = `wps-bot:<chatId>` | ◐ 随 B1 |
| B5 完成后不引用再@→新任务新会话（上下文不无限涨） | 不合：永远同会话 resume | ⚡ 随 B1 |

## C. 参与者与审批授权（⚡ 与已落地 G5 冲突——定稿以本件为准）

| 契约 | 现行 | 偏差 |
|---|---|---|
| C1 owner+participants[]；quote 继承入会→双方审批资格（any-of) | **单 requester**(G5：仅真实派发改写，inject 不抢） | ⚡ 推翻 G5 新契约；G5 测试须翻案 |
| C2 群问 @owner+@触发者 | mention 尽力单人 | ○ 小改（mention 列表） |
| C3 audit 三元组 approver/owner/requester | audit 单 userId | ○ 字段扩充 |
| C4 窗键 (chat,user)→(chat,sessionId,user) 或区分参与者窗 | (chatId,userId) | ⚡ 随 B1 换键 |

## D. 历史与文件

| 契约 | 现行 | 偏差 |
|---|---|---|
| D1 bot 消息注册表（7d/2000 条，JSONL+压缩） | 无 | ○ 新纯模块（dedup 同构件） |
| D2 `search_chat_history` 只读模型工具 | 无 | ○ 新工具（client.getMessages 已备） |
| D3 读全局开放/写按任务隔离 `workspace/<chatId>/<userId>/<taskId>/` | 单 workspaceRoot（downloads/artifacts 共址） | ⚡ 随 B1 |
| D4 读/写历史凭据审计 JSONL | 无 | ○ audit 增事件类 |

## E. 已合且不被本契约改动的基础件

幂等 dedup、WS 单播纪律、notify 三模板、seal/shutdown、卡片共养、materialize 下载、[[attach:]] 上传、审批串行+settled guard、agent/status 真接线、dispose 序、loader inject——**全部保留**。

## 实施波次（红测先行；每波独立三门绿）

1. **波次 P-A（纯增量，与现行零冲突）**：A1 finish_task 交付件（fallback 保留）+ C3 audit 三元组 + D1 注册表模块 + A2 reply 工具（含去重规则：本 turn 用过 reply 则末态文本不再发）。
2. **波次 P-B（通道代答扩展）**：A3 user-questions 接通道（复用群问+窗+audit；答题面与审批面不同模板）。
3. **波次 P-C（分叉主体，一次性切换）**：B1-B5 + C1/C2/C4 + D3——dispatch/bot/session 键全换；G5 翻案；旧会话（`wps-bot:<chatId>` 持久线）迁移策略=不迁移（新键新会话，旧线作废记档）。
4. **波次 P-D**：D2 search 工具 + D4 审计。

## 未决小项（落地时顺手裁）

- reply 与 finish_task 同 turn 并存时交付序：reply 件即时、finish 件收官，互不包含。
- 注册表过期界：先 7d/2000 双闸，任一先触即失效。
- waiting_user 去留：保留为「收轮原因标记」，复归交给注册表+quote 直接命中，不再维护 GA 的 waiting_message_ids 启发式。
