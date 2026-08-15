/**
 * dsh-wps-bot —— WPS 365 聊天通道（cordis 宿主插件）。
 *
 * 本文件只做 cordis 接线（schema、agents.create、ctx.on、ctx.effect、boot 过程、
 * open-event-sdk 长连接）；所有可测语义都在 ./bot.ts（WpsBotCore）与各纯模块。
 *
 * @module dsh-wps-bot
 */

import { Client as WpsEventClient, Dispatcher, LogLevel } from "open-event-sdk";

import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

import { WpsClient } from "./client.ts";
import { EventDedup } from "./dedup.ts";
import {
  normalizeEventData,
  isSelfEvent,
  type RawMessageEventData,
  type WpsEvent,
} from "./protocol.ts";
import type { ChatSessionHandle } from "./dispatch.ts";
import {
  WpsBotCore,
  type CoreBotOptions,
  type AgentSessionLike,
  type ApprovalOutcome,
} from "./bot.ts";

export const name = "wps-bot";
export const inject = ["agents"];

export interface WpsBotConfig {
  clientId?: string;
  clientSecret?: string;
  spId?: string;
  apiBase?: string;
  /** 直接注入 access_token（联调场景；空走 oauth2） */
  accessToken?: string;
  provider?: string;
  model?: string;
  workspaceRoot?: string;
  seenEventsPath?: string;
  personaTitle?: string;
  cardMode?: "card" | "off";
  cardInitialDelaySeconds?: number;
  cardHeartbeatSeconds?: number;
  cardUpdateMinIntervalSeconds?: number;
  cardSettle?: "recall" | "update";
  approvalMode?: "windows" | "disabled";
  approvalTimeoutSeconds?: number;
  allowWindow?: boolean;
  auditPath?: string;
  ackInterventionText?: string;
  deliverChunks?: number;
}

export const Config: Schema<WpsBotConfig> = Schema.object({
  clientId: Schema.string().default(""),
  clientSecret: Schema.string().default(""),
  spId: Schema.string().default(""),
  apiBase: Schema.string().default("https://openapi.wps.cn"),
  accessToken: Schema.string().default(""),
  provider: Schema.string().default("deepseek-official"),
  model: Schema.string().default("deepseek-v4-flash"),
  workspaceRoot: Schema.string().default(""),
  seenEventsPath: Schema.string().default("runtime/wps-bot-seen-events.jsonl"),
  personaTitle: Schema.string().default("甘小雨"),
  cardMode: Schema.string().default("card"),
  cardInitialDelaySeconds: Schema.number().default(5),
  cardHeartbeatSeconds: Schema.number().default(120),
  cardUpdateMinIntervalSeconds: Schema.number().default(2),
  cardSettle: Schema.string().default("recall"),
  approvalMode: Schema.string().default("windows"),
  approvalTimeoutSeconds: Schema.number().default(300),
  allowWindow: Schema.boolean().default(true),
  auditPath: Schema.string().default("runtime/wps-bot-approval.jsonl"),
  ackInterventionText: Schema.string().default("已收到补充信息，当前任务会在下一轮处理。"),
  deliverChunks: Schema.number().default(4500),
});

interface AgentHandleInner {
  followup(message: unknown): unknown;
  inject(message: unknown): unknown;
  status?: string;
  session?: AgentSessionLike;
}
interface AgentHandleLike {
  agent?: AgentHandleInner;
  dispose(): Promise<unknown>;
  session?: AgentSessionLike;
}

interface ChatEntry {
  chatId: string;
  handle?: AgentHandleLike;
  requester?: { userId: string; name: string };
}

export function apply(rawCtx: Context, config: WpsBotConfig): void {
  const ctx: any = rawCtx;
  const logger = ctx.logger ?? console;

  const clientId = config.clientId || process.env.WPS365_CLIENT_ID || "";
  const clientSecret = config.clientSecret || process.env.WPS365_CLIENT_SECRET || "";
  const spId = config.spId || process.env.WPS365_SP_ID || "";
  if (!clientId || !clientSecret || !spId) {
    throw new Error(
      "wps-bot: missing credentials (config.clientId / clientSecret / spId，或环境变量的 WPS365_CLIENT_ID / WPS365_CLIENT_SECRET / WPS365_SP_ID)",
    );
  }
  const apiBase = config.apiBase || process.env.WPS365_API_BASE || "https://openapi.wps.cn";
  const client = new WpsClient({
    clientId,
    clientSecret,
    apiBase,
    accessToken: config.accessToken ?? "",
  });
  const botIds = [clientId, spId];

  // ---- 每 chat 的会话句柄与 requester 注册 ----

  const chats = new Map<string, ChatEntry>();

  function wrap(chatId: string, handle: AgentHandleLike): ChatSessionHandle {
    const userMessage = (text: string) =>
      createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
    return {
      sessionId: String(handle.agent?.session?.id ?? handle.session?.id ?? `wps-bot:${chatId}`),
      status: () => handle.agent?.status,
      followup: (text: string) => handle.agent?.followup(userMessage(text)),
      inject: (text: string) => {
        if (handle.agent?.status !== "running") return false;
        try {
          handle.agent.inject(userMessage(text));
          return true;
        } catch (error) {
          logger.warn("[wps-bot] inject declined:", error);
          return false;
        }
      },
    };
  }

  async function ensure(chatId: string): Promise<ChatSessionHandle> {
    let entry = chats.get(chatId);
    if (entry !== undefined && entry.handle !== undefined) return wrap(chatId, entry.handle);
    const handle = (await ctx.agents.create({
      sessionId: SessionId(`wps-bot:${chatId}`),
      meta: { cwd: config.workspaceRoot || process.cwd() },
      agentOptions: {
        provider: config.provider ?? "deepseek-official",
        model: config.model ?? "deepseek-v4-flash",
      },
    })) as AgentHandleLike;
    if (entry === undefined) {
      entry = { chatId };
      chats.set(chatId, entry);
    }
    entry.handle = handle;
    return wrap(chatId, handle);
  }

  function ownSessionId(entry: ChatEntry): string {
    return String(entry.handle?.agent?.session?.id ?? entry.handle?.session?.id ?? "");
  }

  function chatForSessionId(sessionId: string): string | null {
    for (const [chatId, entry] of chats) {
      const sid = ownSessionId(entry);
      if (sid && sid === sessionId) return chatId;
    }
    return null;
  }

  function chatForAgent(agent: unknown): string | null {
    if (agent === undefined || agent === null) return null;
    for (const [chatId, entry] of chats) {
      if (entry.handle?.agent === agent) return chatId;
      const sid = String((agent as AgentHandleInner | undefined)?.session?.id ?? "");
      const ownSid = ownSessionId(entry);
      if (sid && ownSid && sid === ownSid) return chatId;
    }
    return null;
  }

  let dedup: EventDedup | null = null;
  let core: WpsBotCore | null = null;
  let eventClient: WpsEventClient | undefined;

  // ---- 事件订阅核心接线 ----

  function buildCore(d: EventDedup): WpsBotCore {
    const opts: CoreBotOptions = {
      client,
      logger: logger as CoreBotOptions["logger"],
      dedup: d,
      sessions: {
        ensure,
        setRequester: (chatId, r) => {
          const entry = chats.get(chatId);
          if (entry !== undefined) entry.requester = r;
        },
        getRequester: (chatId) => chats.get(chatId)?.requester,
      },
      chatForSessionId,
      chatForAgent,
      config: {
        cardMode: config.cardMode === "off" ? "off" : "card",
        cardTitle: config.personaTitle ?? "甘小雨",
        cardInitialDelayMs: Math.max(0, (config.cardInitialDelaySeconds ?? 5) * 1000),
        cardHeartbeatMs: Math.max(1000, (config.cardHeartbeatSeconds ?? 120) * 1000),
        cardUpdateMinIntervalMs: Math.max(0, (config.cardUpdateMinIntervalSeconds ?? 2) * 1000),
        cardSettle: config.cardSettle === "update" ? "update" : "recall",
        approvalMode: config.approvalMode === "disabled" ? "disabled" : "windows",
        approvalTimeoutMs: Math.max(1000, (config.approvalTimeoutSeconds ?? 300) * 1000),
        allowWindow: config.allowWindow !== false,
        auditPath: config.auditPath ?? "runtime/wps-bot-approval.jsonl",
        ackInterventionText:
          config.ackInterventionText ?? "已收到补充信息，当前任务会在下一轮处理。",
        deliverChunks: config.deliverChunks ?? 4500,
      },
    };
    return new WpsBotCore(opts);
  }

  // ---- cordis 事件钩子 ----

  void ctx.on("session/event", (session: AgentSessionLike, event: { type: string; data?: unknown }) => {
    if (core === null) return;
    core.handleSessionEvent(String(session?.id ?? ""), event);
  });

  ctx.on(
    "approval/request",
    async (req: unknown, next: () => Promise<ApprovalOutcome>) => {
      if (core === null) return next();
      return core.handleApprovalRequest(
        req as Parameters<WpsBotCore["handleApprovalRequest"]>[0],
        next,
      );
    },
    true,
  );

  // ---- WPS 事件入站 ----

  function eventData(event: unknown): RawMessageEventData {
    const record = (event as Record<string, unknown> | undefined) ?? {};
    const raw = record.parsedData ?? record.data;
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw) as RawMessageEventData;
      } catch {
        return { raw } as unknown as RawMessageEventData;
      }
    }
    return (raw ?? {}) as RawMessageEventData;
  }

  async function onWpsEvent(ev: WpsEvent): Promise<void> {
    if (core === null) return;
    await core.handleIncomingEvent(ev);
  }

  const bootstrap = (async () => {
    dedup = await EventDedup.load({
      limit: 2048,
      path: config.seenEventsPath ?? "runtime/wps-bot-seen-events.jsonl",
    });
    core = buildCore(dedup);
    const dispatcher = new Dispatcher().registerFunc(
      "kso.app_chat.message.create",
      async (event: unknown) => {
        const data = eventData(event);
        const sender = (data?.sender ?? {}) as RawMessageEventData["sender"];
        if (isSelfEvent(sender, botIds)) return;
        const record = event as Record<string, unknown> | undefined;
        const eventId = String(record?.eventId ?? record?.id ?? record?.uuid ?? "");
        const payload = normalizeEventData(data, botIds, eventId);
        if (!payload) return;
        await onWpsEvent(payload);
      },
    );
    eventClient = new WpsEventClient({
      appId: clientId,
      appSecret: clientSecret,
      dispatcher,
      logLevel: LogLevel.Info,
      reconnectMaxRetry: -1,
    });
    await eventClient.start();
  })();

  bootstrap.catch((error: unknown) => {
    logger.error("[wps-bot] bootstrap failed:", error);
  });

  ctx.effect(() => {
    void bootstrap.catch(() => undefined);
    return async () => {
      await core?.shutdown().catch(() => undefined);
      const disposals = [...chats.values()]
        .filter((entry) => entry.handle !== undefined)
        .map((entry) => (entry.handle as AgentHandleLike).dispose());
      await Promise.allSettled(disposals);
      try {
        eventClient?.stop(); // SDK 1.0.1 stop(): void（无 await）
      } catch {
        /* 静默 */
      }
    };
  }, "wps-bot.serve");
}

export { approvalQuestion, ACK_APPROVED, ACK_DECLINED, ACK_TIMEOUT } from "./bot.ts";
export default { name, Config, apply };
