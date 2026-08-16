---
name: wps-chat
description: 查 WPS 聊天归档（history）与向当前对话插一句话（reply）。全部经本地脚本完成，不经模型工具注册面。
---

# WPS 对话作业面（脚本，不是工具）

执行面：`<THIS_SKILL_DIR>/../../scripts/wps-chat.mjs`（node 直跑，无依赖安装）。
`.wps_context.json`（会话工作区根）供给当前 chatId 与归档绝对路径——**优先在会话工作区执行**；
跨对话只读查询用 `--chat-id` 显式指定。凭据永不出现在命令行/参数/本文件：发送侧由宿主环境变量
`WPS365_CLIENT_ID` / `WPS365_CLIENT_SECRET`（+可选 `WPS365_API_BASE`）托管。

## history —— 读本地归档（零网络、零凭据）

```bash
node "<THIS_SKILL_DIR>/../../scripts/wps-chat.mjs" history --limit 30
node "<THIS_SKILL_DIR>/../../scripts/wps-chat.mjs" history --chat-id CHAT_ID --limit 30
node "<THIS_SKILL_DIR>/../../scripts/wps-chat.mjs" history --sender "甘小雨" --keyword "巡检"
```

- 归档 = 通道自行落盘的逐聊天 `history.jsonl`（所见即本 Runtime 处理面，早于入群的消息不在其中）。
- 输出 JSON：`{ chatId, archive, hits[] }`，每条 `[ISO 时间] 发送者: 文本`。

## reply —— 向当前对话立即发一句（不打断在跑任务）

```bash
node "<THIS_SKILL_DIR>/../../scripts/wps-chat.mjs" reply --text "收到，我先查一下"
node "<THIS_SKILL_DIR>/../../scripts/wps-chat.mjs" reply --text-file ./draft.md --chat-id CHAT_ID
```

- 发送语义 = 通道 markdown 直发（openapi `/v7/messages/create`，KSO-1 签名 + client_credentials token）。
- **任务完结不要用 reply**——完结只调 `finish_task` 工具。

## 失败语义

- history：归档不存在 → `hits: []`（空≠错）。
- reply：缺 chatId/凭据/文本或 API 非 2xx → stderr + 非零退出，**不要重试放大**（先核凭据与 chatId）。
