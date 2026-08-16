/**
 * 通道工具注册（仅 finish_task——reply/history 降 skill/script，第二轮极简工具面 §2.1）。
 * P0-3：使用 dsh-tools 官方 defineTool（参数规按官方 spec 方言；真实校验输入面一致）。
 *
 * @module dsh-wps-bot/channel-tools
 */

import { defineTool } from "@deepseek-ai/dsh-tools";

type RegistryLike = { register?: (tool: unknown) => void };

/** 通道终态工具：finish_task 唯一注册面（第二轮 §2.1）。 */
export function registerChannelTools(
  registry: RegistryLike,
  act: (kind: "finish", chatId: string, text: string) => Promise<void> | void,
  chatForAgentFn: (agent: unknown) => string | null,
): void {
  const make = (name: string, description: string) =>
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
        await act("finish", sessionId, args.text);
        return { delivered: true };
      },
    });
  registry.register?.(make("finish_task", "收本任务的正式交付件——任务完结信号；使用后不再返还末条文本。") as never);
}
