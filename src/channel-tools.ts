/**
 * 通道工具注册（finish_task / reply / search_wps_history）。
 * P0-3：使用 dsh-tools 官方 defineTool（参数规按官方 spec 方言；真实校验输入面一致）。
 *
 * @module dsh-wps-bot/channel-tools
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ApprovalAuditEntry } from "./audit.ts";
import { parseTaskKey } from "./task-keys.ts";
import type { WpsBotCore } from "./bot.ts";

type RegistryLike = { register?: (tool: unknown) => void };

/** P-D 历史面注册：检索当前/指定 chat 归档，act 入审计行。 */
export function registerHistoryTool(
  registry: RegistryLike,
  owned: WpsBotCore,
  chatForAgent: (agent: unknown) => string | null,
  auditAppend: (entry: ApprovalAuditEntry) => Promise<void>,
): void {
  registry.register?.(defineTool({
    name: "search_wps_history",
    description: "检索本对话（群/p2p）的聊天历史归档，按关键词出最近条目；历史为读开素材，不做私权。",
    parameters: {
      query: { type: "string", required: true, description: "关键词（空白分隔，任一命中即出件）。" },
      limit: { type: "number", default: 5, description: "最多返回条数（上限 20）。" },
      chat_id: { type: "string", default: "", description: "可选：跨群读开——精确 chat id；缺省=当前对话。" },
      user_id: { type: "string", default: "", description: "可选：只看某发送者的条目（senderUserId 精确匹）。" },
      since: { type: "number", default: 0, description: "可选：epoch 秒下限（含）。" },
      until: { type: "number", default: 0, description: "可选：epoch 秒上限（含）。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { hits: { type: "array", items: { type: "string" }, default: [] } },
      },
      render: (_args: unknown, value: unknown) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(
      args: { query: string; limit?: number; chat_id?: string; user_id?: string; since?: number; until?: number },
      exec: { agent?: unknown },
    ) {
      const sessionId = chatForAgent(exec.agent);
      const chatId = sessionId !== null ? (parseTaskKey(sessionId)?.chatId ?? sessionId) : null;
      if (chatId === null) return { hits: [] };
      const targetChat = typeof args.chat_id === "string" && args.chat_id.length > 0 ? args.chat_id : chatId;
      const since = typeof args.since === "number" ? args.since : 0;
      const until = typeof args.until === "number" ? args.until : 0;
      const rawHits = await owned.searchHistory(targetChat, String(args.query), 40);
      const hits = rawHits
        .filter((h) => (args.user_id === undefined || args.user_id === "" ? true : h.senderUserId === args.user_id))
        .filter((h) => (since > 0 ? h.ts >= since : true))
        .filter((h) => (until > 0 ? h.ts <= until : true))
        .slice(0, Math.min(20, Math.max(1, args.limit ?? 5)));
      await auditAppend({
        timestamp: Math.floor(Date.now() / 1000),
        kind: "history-read",
        auditOutcome: "decision",
        chatId: targetChat,
        userId: (sessionId !== null ? (parseTaskKey(sessionId)?.ownerId ?? sessionId) : chatId),
        approved: true,
        reason: `search_wps_history q=?${args.query}?`,
        feedback: hits.length > 0 ? `hits=${hits.length}` : "empty",
      }).catch(() => undefined);
      return { hits: hits.map((h) => `[${new Date(h.ts * 1000).toISOString()}] ${h.senderName}: ${h.text}`) };
    },
  }));
}

/** P-A：finish_task/reply 注册面。 */
export function registerChannelTools(
  registry: RegistryLike,
  act: (kind: "finish" | "reply", chatId: string, text: string) => Promise<void> | void,
  chatForAgentFn: (agent: unknown) => string | null,
): void {
  const make = (kind: "finish" | "reply", name: string, description: string) =>
    defineTool({
      name,
      description,
      parameters: {
        text: { type: "string", required: true, description: "要发给对话的文本。" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { delivered: { type: "boolean", default: false } },
        },
        render: (_args: unknown, value: unknown) => [{ type: "text", text: JSON.stringify(value) }],
      },
      async execute(args: { text: string }, exec: { agent?: unknown }) {
        const sessionId = chatForAgentFn(exec.agent);
        if (sessionId === null) throw new Error("wps-bot: no session 关联无从落件");
        await act(kind, sessionId, args.text);
        return { delivered: true };
      },
    });
  registry.register?.(make("finish", "finish_task", "收本任务的正式交付件——任务完结信号；使用后不再返还末条文本。") as never);
  registry.register?.(make("reply", "reply", "中途回复对话——立即发送，会话继续；完结须用 finish_task。") as never);
}
