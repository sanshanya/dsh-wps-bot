/**
 * dsh-wps-bot —— WPS 365 聊天通道（cordis 宿主插件）。
 *
 * 形态归属：ksbot_ga 形态A 的「open-event-sdk 长连接 + 通道调度 + 卡片/审批」合并入单进程 TS 插件。
 *  - 事件入站：open-event-sdk（与 GA bridge 同 wire）
 *  - 分诊：ksbot_ga/src/ga_wps/app.py（dispatch.ts）
 *  - 卡片：ksbot_ga/src/ga_wps/progress.py（card.ts）
 *  - 审批窗：ksbot_ga/src/ga_wps/approval.py（consent.ts + prepend waterfall）
 *  - 回包：ksbot_ga/src/ga_wps/client.py（client.ts）
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
import { ProgressCards } from "./card.ts";
import { ApprovalWindowStore, parseConsent, windowAllows } from "./consent.ts";
import { appendApprovalAudit, autoAllowEntry, type ApprovalAuditEntry } from "./audit.ts";
import {
  normalizeEventData,
  isSelfEvent,
  type RawMessageEventData,
  type WpsEvent,
} from "./protocol.ts";
import { WpsRouter, type ChatSessionHandle } from "./dispatch.ts";

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

/** 默认文案与 GA 对应（approval.py:120-128）。 */
const ACK_APPROVED = "操作已批准。";
const ACK_APPROVED_NO_WINDOW = "操作已批准，但本次未开启自动同意窗口。";
const ACK_DECLINED = "操作已取消，意见将交给模型继续处理。";
const ACK_TIMEOUT = "审批超时未获答复，本次操作已取消。";
const ACK_APPROVED_WINDOW = (n: number) => `操作已批准，并开启 ${n} 分钟自动同意窗口。`;

interface AgentSessionLike {
  id?: string;
}
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
interface ApprovalRequestLike {
  agent?: unknown;
  toolName?: string;
  callId?: string;
  reason?: string;
  signal?: { aborted: boolean };
}
type ApprovalOutcomeLiteral = "allowed-once" | "rejected" | "cancelled" | "unavailable";

interface ChatEntry {
  chatId: string;
  handle?: AgentHandleLike;
  requester?: { userId: string; name: string };
}
interface PendingApproval {
  userId: string;
  resolve: (
    reply: { kind: "reply"; text: string } | { kind: "timeout" } | { kind: "cancelled" },
  ) => void;
  timer: NodeJS.Timeout;
}

type ReplyEvent =
  | { kind: "reply"; text: string }
  | { kind: "timeout" }
  | { kind: "cancelled" };

/** GA ga_handler.py:146：fail_closed 一律不开窗（消费方生成 [gate-source=] 前缀与生产方的锚）。 */
function allowsWindowForReason(reason: string | undefined): boolean {
  if (typeof reason !== "string") return true;
  return !reason.startsWith("[gate-source=fail_closed]");
}

export function apply(rawCtx: Context, config: WpsBotConfig): void {
  const ctx = rawCtx as any;
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
  const cardTitle = config.personaTitle ?? "甘小雨";
  const auditPath = config.auditPath ?? "runtime/wps-bot-approval.jsonl";
  const approvalTimeoutMs = Math.max(1000, (config.approvalTimeoutSeconds ?? 300) * 1000);
  const ackInterventionText =
    config.ackInterventionText ?? "已收到补充信息，当前任务会在下一轮处理。";

  const store = new ApprovalWindowStore();
  const chats = new Map<string, ChatEntry>();
  const pendings = new Map<string, PendingApproval>();
  let dedup: EventDedup | null = null;
  let eventClient: WpsEventClient | undefined;

  // ---- 会话句柄 ----

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
    const handle = await ctx.agents.create({
      sessionId: SessionId(`wps-bot:${chatId}`),
      meta: { cwd: config.workspaceRoot || process.cwd() },
      agentOptions: {
        provider: config.provider ?? "deepseek-official",
        model: config.model ?? "deepseek-v4-flash",
      },
    });
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

  // ---- 卡片 / 调度 ----

  const cards = new ProgressCards({
    client,
    title: cardTitle,
    initialDelayMs: Math.max(0, (config.cardInitialDelaySeconds ?? 5) * 1000),
    heartbeatMs: Math.max(1000, (config.cardHeartbeatSeconds ?? 120) * 1000),
    updateMinIntervalMs: Math.max(0, (config.cardUpdateMinIntervalSeconds ?? 2) * 1000),
    settle: config.cardSettle === "update" ? "update" : "recall",
    mode: config.cardMode === "off" ? "off" : "card",
    logger,
  });

  const router = new WpsRouter({
    get dedup() {
      return dedup!;
    },
    ensure,
    ackIntervention: async (chatId, senderUserId, senderName) => {
      const mention = await client.resolveMention(senderUserId, senderName).catch(() => null);
      await client.sendMarkdown(chatId, ackInterventionText, mention ? [mention] : undefined);
    },
    onDispatched: (chatId, ev) => {
      const entry = chats.get(chatId);
      if (entry !== undefined) {
        entry.requester = { userId: ev.senderId, name: ev.senderName };
      }
    },
    logger: { warn: (...args: unknown[]) => logger.warn(...args) },
  });

  // ---- 审批 ----

  async function askApproval(
    req: ApprovalRequestLike,
    next: () => Promise<ApprovalOutcomeLiteral>,
  ): Promise<ApprovalOutcomeLiteral> {
    if (config.approvalMode === "disabled") return next();
    if (req.signal?.aborted) return "cancelled";
    const chatId = chatForAgent(req.agent);
    if (chatId === null) return next();
    const entry = chats.get(chatId);
    const requester = entry?.requester;
    if (requester === undefined) return next();

    const allowWindow =
      config.allowWindow !== false && allowsWindowForReason(req.reason);
    if (allowWindow && windowAllows(store, chatId, requester.userId, allowWindow)) {
      try {
        await appendApprovalAudit(
          auditPath,
          autoAllowEntry({
            chatId,
            userId: requester.userId,
            review: req.reason,
            reason: req.reason,
            toolName: req.toolName,
            callId: req.callId,
            windowExpiresAt: store.expiresAt(chatId, requester.userId) ?? undefined,
          }),
        );
        return "allowed-once";
      } catch {
        return next(); // 审计写失败 → 降级回群问（未记账的自动答允不得出闸）
      }
    }

    const mention = await client
      .resolveMention(requester.userId, requester.name)
      .catch(() => null);
    const reason = String(req.reason ?? "");
    try {
      await client.sendMarkdownSplit(
        chatId,
        consentPrompt(reason, allowWindow),
        mention,
        config.deliverChunks ?? 4500,
      );
    } catch (error) {
      logger.warn("[wps-bot] approval question send failed:", error);
      return next();
    }
    void cards.phase(chatId, { phase: "等待人工审批" });

    const reply = await waitReply(chatId, requester.userId, approvalTimeoutMs);
    const decision = decide(reply, allowWindow, chatId, requester.userId, reason);
    await appendApprovalAudit(auditPath, decision.audit).catch((error: unknown) => {
      logger.warn("[wps-bot] audit append failed:", error);
    });
    if (decision.ackText) {
      await client
        .sendMarkdown(chatId, decision.ackText, mention ? [mention] : undefined)
        .catch(() => undefined);
    }
    return decision.outcome;
  }

  function waitReply(chatId: string, userId: string, timeoutMs: number): Promise<ReplyEvent> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendings.delete(chatId);
        resolve({ kind: "timeout" });
      }, timeoutMs);
      pendings.set(chatId, {
        userId,
        resolve: (reply) => {
          clearTimeout(timer);
          pendings.delete(chatId);
          resolve(reply);
        },
        timer,
      });
    });
  }

  function decide(
    reply: ReplyEvent,
    allowWindow: boolean,
    chatId: string,
    userId: string,
    reason: string,
  ): { outcome: ApprovalOutcomeLiteral; ackText: string | null; audit: ApprovalAuditEntry } {
    const timestamp = Math.floor(Date.now() / 1000);
    if (reply.kind === "cancelled") {
      return {
        outcome: "cancelled",
        ackText: null,
        audit: {
          timestamp,
          kind: "reply-resolution",
          auditOutcome: "cancelled",
          chatId,
          userId,
          approved: false,
          reason,
        },
      };
    }
    if (reply.kind === "timeout") {
      return {
        outcome: "rejected",
        ackText: ACK_TIMEOUT,
        audit: {
          timestamp,
          kind: "reply-resolution",
          auditOutcome: "timeout",
          chatId,
          userId,
          approved: false,
          reason,
        },
      };
    }
    const minutes = parseConsent(reply.text);
    if (minutes === null) {
      return {
        outcome: "rejected",
        ackText: ACK_DECLINED,
        audit: {
          timestamp,
          kind: "reply-resolution",
          auditOutcome: "decision",
          chatId,
          userId,
          approved: false,
          reason,
          feedback: reply.text,
        },
      };
    }
    if (minutes > 0 && allowWindow) {
      const windowExpiresAt = store.grant(chatId, userId, minutes);
      return {
        outcome: "allowed-once",
        ackText: ACK_APPROVED_WINDOW(minutes),
        audit: {
          timestamp,
          kind: "reply-resolution",
          auditOutcome: "decision",
          chatId,
          userId,
          approved: true,
          reason,
          windowExpiresAt,
          grantMinutes: minutes,
        },
      };
    }
    return {
      outcome: "allowed-once",
      ackText: minutes > 0 ? ACK_APPROVED_NO_WINDOW : ACK_APPROVED,
      audit: {
        timestamp,
        kind: "reply-resolution",
        auditOutcome: "decision",
        chatId,
        userId,
        approved: true,
        reason,
        ...(minutes > 0 ? { grantMinutes: minutes } : {}),
      },
    };
  }

  function cancelPending(chatId: string): void {
    const pend = pendings.get(chatId);
    if (pend === undefined) return;
    pend.resolve({ kind: "cancelled" });
  }

  // ---- 回包与相位 ----

  function assistantTextOf(event: { data?: unknown }): string | undefined {
    const message = (event.data as Record<string, unknown> | undefined)?.message as
      | Record<string, unknown>
      | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return undefined;
    const parts: string[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string" && b.text) parts.push(b.text);
    }
    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  async function deliver(chatId: string, text: string): Promise<void> {
    try {
      await client.sendMarkdownSplit(chatId, text, null, config.deliverChunks ?? 4500);
    } catch (error) {
      logger.error("[wps-bot] deliver failed:", error);
    }
  }

  async function interrupt(chatId: string, kind: unknown): Promise<void> {
    try {
      await client.sendMarkdown(
        chatId,
        `[任务已中止] 当前任务已${kind === "aborted" ? "被中止" : "失败"}（chat ${chatId}）。如需继续，请重新发起任务。`,
      );
    } catch (error) {
      logger.warn("[wps-bot] interrupt notice failed:", error);
    }
  }

  async function finalizeTurn(chatId: string): Promise<void> {
    await router.drain(chatId).catch(() => undefined);
    if (router.queued(chatId) === 0) await cards.finish(chatId);
  }

  // ---- WPS 事件入站 ----

  async function onWpsEvent(ev: WpsEvent): Promise<void> {
    const pend = pendings.get(ev.chatId);
    if (pend !== undefined && ev.senderId === pend.userId) {
      pend.resolve({ kind: "reply", text: ev.text.trim() });
      return;
    }
    await router.handleEvent(ev);
  }

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

  // ---- 事件钩子（相位 + drain / card settle） ----

  void ctx.on("session/event", (session: AgentSessionLike, event: {
    type: string;
    data?: Record<string, unknown>;
  }) => {
    const chatId = chatForSessionId(String(session?.id ?? ""));
    if (chatId === null) return;
    switch (event.type) {
      case "assistant/message": {
        const text = assistantTextOf(event);
        if (text !== undefined) void deliver(chatId, text);
        break;
      }
      case "turn/start": {
        const turn = (event.data as { turn?: unknown } | undefined)?.turn;
        cards.phase(chatId, typeof turn === "number" ? { turn } : {});
        break;
      }
      case "tool/call": {
        const tool = (event.data as { name?: unknown } | undefined)?.name;
        cards.phase(chatId, { tool: typeof tool === "string" && tool ? tool : "工具" });
        break;
      }
      case "approval/asked": {
        cards.phase(chatId, { phase: "等待人工审批" });
        break;
      }
      case "turn/end": {
        const kind = (event.data as { kind?: unknown } | undefined)?.kind;
        if (kind === "error" || kind === "aborted") {
          void interrupt(chatId, kind);
        }
        void finalizeTurn(chatId);
        break;
      }
      default:
        break;
    }
  });

  ctx.on(
    "approval/request",
    (async (req: ApprovalRequestLike, next: () => Promise<ApprovalOutcomeLiteral>) =>
      askApproval(req, next)) as never,
    true,
  );

  // ---- 生命周期（bootstrap 后台执行；事件钩子立即可用） ----

  const bootstrap = (async () => {
    dedup = await EventDedup.load({
      limit: 2048,
      path: config.seenEventsPath,
    });
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
      for (const chatId of [...pendings.keys()]) cancelPending(chatId);
      await cards.finishAll().catch(() => undefined);
      const disposals = [...chats.values()]
        .filter((entry) => entry.handle !== undefined)
        .map((entry) => (entry.handle as AgentHandleLike).dispose());
      await Promise.allSettled(disposals);
      if (eventClient !== undefined) {
        await eventClient.stop().catch(() => undefined);
      }
    };
  }, "wps-bot.serve");
}

/** GA approval.py 的群问面提示词（Kubernetes 特化字样去产品化）。 */
export function consentPrompt(review: string, allowWindow: boolean): string {
  const instruction = allowWindow
    ? "回复“同意”仅执行本次；回复“同意5分钟”（分钟数可替换）开启限时自动同意。"
    : "本次仅支持回复“同意”执行一次，不开放限时自动同意。";
  return `**需要确认的操作**\n\n${instruction}其他回复会取消本次操作并交给模型。\n\n${review}`;
}

export default { name, Config, apply };
