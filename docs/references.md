# references：源码考古锚点表（f1#1 收拢位）

> src 各文件头注只留一句职责 + 本表指针；考古详情集中于此。改语义前先核对锚点。

| 模块 | GA 锚 | 要点 |
|---|---|---|
| src/protocol.ts | ga_wps/protocol.py:132-370 + wps-docs/docs/server/message/ | .text={content}；mentions[].id=下标串、identity.id=真 id；sp 自产；@ 判双通道；rich_text 六种节点；file.cloud/local 分途 |
| src/dispatch.ts | ga_wps/app.py（分诊面） | seen_events 定式；quote/在途卡 gate；direct+running+无 evidence→inject(completion seam)；排队 drain |
| src/bot.ts | ga_runtime.py:23,272-289 / app.py:339,372-395,425-435 | materialize【GA:339】、[[attach:]] artifacts 交付序、三模板中断通知 |
| src/client.ts | ga_wps/client.py:97-112,146,232-245 | 4500 分段、_card_content 信封、auth/token 300s 预刷 |
| src/card.ts | ga_wps/progress.py:59-204 | 标题甘小雨稳定格式；心跳/轮次/工具行；_settle_if_ready 三分支 |
| src/dedup.ts | approval.py 同款 + app.py claim 定式 | claim/record/release 幂等三件套；compact 时级衔接 |
| src/consent.ts | approval.py:15-25,86,142-155 | consent 词表/窗判定/fail-closed 语义 |
| src/signature.ts | ga_wps 的 KSO-1 签名面 | X-Kso-Authorization 头形 |
| src/notify.ts | app.py:425-435 | 三模板逐字、联署、幂等 |
| src/audit.ts | approval.py:86+ / ga_handler.py:146 | allow_window=verdict.source=="ai_gate"；决策别字段组 |
| src/split.ts | client.py:97-112 | _split(text,limit=4500) 逐行对位 |
| src/evidence.ts | app.py:532-561 | unparsed/cloud_docs/shared_doc_ids 三落盘 |
| src/index.ts:84 等 | vendor/loader `unwrapExports`(default ?? exports)、session/index.ts:639 callbackArgs=[this,event]、runtime-types.ts:70 | B-1 定位锚 |
| packages/core/session/src/types.ts:252 | DSH turn/end wire 形状 | { turn, reason:{kind} } |
