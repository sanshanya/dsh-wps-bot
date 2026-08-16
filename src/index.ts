/**
 * dsh-wps-bot —— WPS 365 聊天通道（cordis 宿主插件）。
 *
 * 本文件只做 cordis 接线（schema、agents.create、ctx.on、ctx.effect、boot 过程、
 * open-event-sdk 长连接）；所有可测语义都在 ./bot.ts（WpsBotCore）与各纯模块。
 *
 * @module dsh-wps-bot
 */

import { isAbsolute } from "node:path";

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

/** 补充 ACK 单一文案源（GA intervention seam 对位；原 bot.ts 死常量收编此）。 */
const ACK_INTERVENTION_TEXT = "已收到补充信息，当前任务会在下一轮处理。";
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
  botDisplayName?: string;
  cardMode?: string;
  cardInitialDelaySeconds?: number;
  cardHeartbeatSeconds?: number;
  cardUpdateMinIntervalSeconds?: number;
  cardSettle?: string;
  approvalMode?: string;
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
  /** @bot 验真名（默认值按 WPS 租户侧的统一对名入口） */
  botDisplayName: Schema.string().default("甘小雨"),
  cardMode: Schema.string().default("card"),
  cardInitialDelaySeconds: Schema.number().default(5),
  cardHeartbeatSeconds: Schema.number().default(120),
  cardUpdateMinIntervalSeconds: Schema.number().default(2),
  cardSettle: Schema.string().default("recall"),
  approvalMode: Schema.string().default("windows"),
  approvalTimeoutSeconds: Schema.number().default(300),
  allowWindow: Schema.boolean().default(true),
  auditPath: Schema.string().default("runtime/wps-bot-approval.jsonl"),
  ackInterventionText: Schema.string().default(ACK_INTERVENTION_TEXT),
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

/** 测试注入点：真集实质上 open-event-sdk 的 Client；假实现可在 node --test 中走协议帧。 */
export interface EventClientLike {
  start(): Promise<void>;
  stop(): void;
}
export interface EventClientOptions {
  appId: string;
  appSecret: string;
  dispatcher: unknown;
}
export type EventClientFactory = (opts: EventClientOptions) => EventClientLike;

export interface BootDeps {
  /** WPS REST 出站；默认真实 WpsClient。 */
  client?: import("./bot.ts").BotClient;
  /** open-event-sdk Client 的工厂；默认真实 SDK。假实现只须无网络地回 dispatcher 投递。 */
  makeEventClient?: EventClientFactory;
}

interface ChatEntry {
  chatId: string;
  handle?: AgentHandleLike;
  requester?: { userId: string; name: string };
}

/** F5/R17 调用面：resume 优先，失败/无持久化再 create（两个入口返回同一 AgentHandleLike）。 */
export async function createOrResume(
  agents: {
    create: (opts: Record<string, unknown>) => Promise<unknown>;
    resume?: (opts: Record<string, unknown>) => Promise<unknown>;
  },
  args: { sessionId: unknown; cwd: string; agentOptions: Record<string, unknown> },
): Promise<unknown> {
  if (agents.resume !== undefined) {
    try {
      return await agents.resume({
        resumeSessionId: args.sessionId,
        agentOptions: args.agentOptions,
      });
    } catch (error) {
      // 二度报告 §五：resume 失败全吞=排障信息丢失——warn 留痕后继走 create
      console.warn("[wps-bot] resume 失败，回落 create:", error);
    }
  }
  return agents.create({
    sessionId: args.sessionId,
    meta: { cwd: args.cwd },
    agentOptions: args.agentOptions,
  });
}

/** N1：agent/disposed 的清句柄（payload 形状 runtime-types.ts:168 = { agent }）。 */
export function clearDisposedHandles(
  chats: Map<string, { handle?: { agent?: unknown } }>,
  payload: unknown,
): string[] {
  const agent = (payload as { agent?: unknown } | null | undefined)?.agent;
  const cleared: string[] = [];
  for (const [chatId, entry] of chats) {
    if (entry.handle?.agent !== undefined && entry.handle.agent === agent) {
      entry.handle = undefined;
      cleared.push(chatId);
    }
  }
  return cleared;
}

export function apply(rawCtx: Context, config: WpsBotConfig, deps: BootDeps = {}): void {
  const ctx: any = rawCtx;
  const logger = ctx.logger ?? console;
  const ctxLogger = typeof ctx.logger === "function" ? ctx.logger("wps-bot") : logger;

  const clientId = config.clientId || process.env.WPS365_CLIENT_ID || "";
  const clientSecret = config.clientSecret || process.env.WPS365_CLIENT_SECRET || "";
  const spId = config.spId || process.env.WPS365_SP_ID || "";
  if (!clientId || !clientSecret || !spId) {
    throw new Error(
      "wps-bot: missing credentials (config.clientId / clientSecret / spId，或环境变量的 WPS365_CLIENT_ID / WPS365_CLIENT_SECRET / WPS365_SP_ID)",
    );
  }
  // 二度报告 §三.7：dsh session meta.cwd 必须绝对路径（ACP 同款 restrict）——boot 期硬校验好于运行期破窗
  if (config.workspaceRoot && !isAbsolute(config.workspaceRoot)) {
    throw new Error(`wps-bot: config.workspaceRoot 必须是绝对路径（收到: ${config.workspaceRoot}）`);
  }
  const apiBase = config.apiBase || process.env.WPS365_API_BASE || "https://openapi.wps.cn";
  const client: import("./bot.ts").BotClient =
    deps.client ??
    new WpsClient({
      clientId,
      clientSecret,
      apiBase,
      accessToken: config.accessToken ?? "",
    });
  const botIds = [clientId, spId];

  // ---- 每 chat 的会话句柄与 requester 注册 ----

  const chats = new Map<string, ChatEntry>();

  // f2#2/b2：不闭包捕获 handle——dispose 后旧句柄成尸；每次调用现读 chats 在册句柄
  function wrap(chatId: string): ChatSessionHandle {
    const live = (): AgentHandleLike | undefined => chats.get(chatId)?.handle;
    const userMessage = (text: string) =>
      createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
    return {
      get sessionId() {
        const handle = live();
        return String(handle?.agent?.session?.id ?? handle?.session?.id ?? `wps-bot:${chatId}`);
      },
      status: () => live()?.agent?.status,
      followup: (text: string) => live()?.agent?.followup(userMessage(text)),
      inject: (text: string) => {
        const handle = live();
        if (handle?.agent?.status !== "running") return false;
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
    if (entry !== undefined && entry.handle !== undefined) return wrap(chatId);
    // F5/R17：resume 优先——持久 line 截盘上已存在同 id 时 create 走拒绝路径，turn 照跑零持久化零信号
    const sessionId = SessionId(`wps-bot:${chatId}`);
    const handle = (await createOrResume(ctx.agents, {
      sessionId,
      cwd: config.workspaceRoot || process.cwd(),
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
    return wrap(chatId);
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
  let eventClient: EventClientLike | undefined;

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
        approvalTimeoutMs: Math.max(1000, Math.max(1, config.approvalTimeoutSeconds ?? 300) * 1000),
        allowWindow: config.allowWindow !== false,
        auditPath: config.auditPath ?? "runtime/wps-bot-approval.jsonl",
        ackInterventionText:
          config.ackInterventionText ?? ACK_INTERVENTION_TEXT,
        deliverChunks: Math.max(1, config.deliverChunks ?? 4500), // F7：<=0 会让 splitMarkdown 死循环
        // workspaceRoot 与 agents.create 的 cwd 同源：downloads/artifacts 都在会话工作区下
        workspaceRoot: config.workspaceRoot || process.cwd(),
      },
    };
    return new WpsBotCore(opts);
  }

  // ---- cordis 事件钩子 ----

  // N1：payload 形状是 { agent }（runtime-types.ts:168），不能按整包做恒等比较
  void ctx.on("agent/disposed", (payload: unknown) => {
    // 顺序钉死：core 先行（其 chatForAgent 反查依赖在册 handle），clear 殿后——反了 core 恒空转
    void core?.handleAgentDisposed(payload);
    clearDisposedHandles(chats, payload);
  });

  // P0-1 生死线：turn/end 在 setPhase(idle) 前发射（agent-loop agent.ts:216-223 vs 316-322）——
  // drain/卡片收官只能靠 idle 转换触发。payload = { agent, status }（runtime-types）。
  void ctx.on("agent/status", (payload: unknown) => {
    if (core === null) return;
    const p = payload as { agent?: unknown; status?: unknown } | null | undefined;
    void core.handleAgentStatus(p?.agent, String(p?.status ?? ""));
  });

  void ctx.on("session/event", (session: AgentSessionLike, event: { type: string; data?: unknown }) => {
    if (core === null) return;
    // B-1（r2 封盘实证）：真机里本回调第一参恒== Agent.session（session/index.ts:639
    // callbackArgs=[this,event]；runtime-types.ts:70），同一性命中后必须传【session.id 字符串】
    // ——handleSessionEvent 的入参语义是 sessionId；误传 chatId 则 chatForSessionId 恒 null 全吞。
    // 未命中直接 drop：dispose/重建同 id 的迟到事件不得借 id 字符串兜底污染新会话。
    if (session === undefined || session === null) return;
    for (const [, entry] of chats) {
      const candidate = entry.handle?.agent?.session;
      if (candidate !== undefined && candidate === (session as unknown)) {
        core.handleSessionEvent(String(session.id ?? ""), event);
        return;
      }
    }
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
        const payload = normalizeEventData(data, botIds, eventId, config.botDisplayName ?? "甘小雨");
        if (!payload) return;
        await onWpsEvent(payload);
      },
    );
    const factory: EventClientFactory =
      deps.makeEventClient ??
      ((opts: EventClientOptions) =>
        new WpsEventClient({
          appId: opts.appId,
          appSecret: opts.appSecret,
          dispatcher: opts.dispatcher as any,
          // SDK 直写 stdout 违反组合纪律（stdout 只许 JSON-RPC 帧）——接进 cordis logger，默认 Error
          logger: {
            debug: (...a: unknown[]) => ctxLogger.debug(...a),
            info: (...a: unknown[]) => ctxLogger.info(...a),
            warn: (...a: unknown[]) => ctxLogger.warn(...a),
            error: (...a: unknown[]) => ctxLogger.error(...a),
          } as never,
          logLevel: LogLevel.Error,
          reconnectMaxRetry: -1,
        }));
    eventClient = factory({ appId: clientId, appSecret: clientSecret, dispatcher });
    // 观测锚点必须先行：open-event-sdk 1.0.1 的 start() 在连接存活期间不 resolve——
    // 放 await 后 = 永不打印，stop 时反补一条假信号（二度报告 §三.8 实证）。
    logger.info(
      `[wps-bot] listening (approvalMode=${String(config.approvalMode)}, cardMode=${String(config.cardMode)}, botDisplayName=${config.botDisplayName})`,
    );
    await eventClient.start();
  })();

  bootstrap.catch((error: unknown) => {
    logger.error("[wps-bot] bootstrap failed:", error);
  });

  ctx.effect(() => {
    void bootstrap.catch(() => undefined);
    return async () => {
      // 清理序：先断入站（stop）→ 再收业务（shutdown）→ 最后 agent dispose
      try {
        eventClient?.stop(); // SDK 1.0.1 stop(): void（无 await）
      } catch {
        /* 静默 */
      }
      await core?.shutdown().catch(() => undefined);
      const disposals = [...chats.values()]
        .filter((entry) => entry.handle !== undefined)
        .map((entry) => (entry.handle as AgentHandleLike).dispose());
      await Promise.allSettled(disposals);
    };
  }, "wps-bot.serve");
}

export { approvalQuestion, ACK_APPROVED, ACK_DECLINED, ACK_TIMEOUT } from "./bot.ts";
// 装载器真值 vendor/loader/src:194：`exports.default ?? exports`——default 在则遮蔽具名 inject，
// 导致 fork 无声明、ctx.agents 访问炸「cannot get property without inject」（真机实证）。两面都要。
export default { name, inject, Config, apply };
