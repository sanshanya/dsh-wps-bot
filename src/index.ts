/**
 * dsh-wps-bot —— WPS 365 聊天通道（cordis 宿主插件）：本文件只做接线（schema/agents/事件/teardown），可测语义在 ./bot.ts 与各纯模块。考古锚点见 docs/references.md。
 *
 * @module dsh-wps-bot
 */

import { isAbsolute, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { Client as WpsEventClient, Dispatcher, LogLevel } from "open-event-sdk";

import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

import { WpsClient } from "./client.ts";
import { EventDedup } from "./dedup.ts";
import { historyFilePath } from "./history.ts";
import {
  normalizeEventData,
  isSelfEvent,
  type RawMessageEventData,
  type WpsEvent,
} from "./protocol.ts";
import type { ChatSessionHandle } from "./task-router.ts";
import { parseTaskKey, sanitizePathKey } from "./task-keys.ts";
import { registerChannelTools } from "./channel-tools.ts";
import {
  WpsBotCore,
  type CoreBotOptions,
  type AgentSessionLike,
  type ApprovalOutcome,
} from "./bot.ts";

export const name = "wps-bot";

/** 补充 ACK 单一文案源（GA intervention seam 对位；原 bot.ts 死常量收编此）。 */
const ACK_INTERVENTION_TEXT = "已收到补充信息，当前任务会在下一轮处理。";
export const inject = ["agents", "userQuestions", "tools"];

export interface WpsBotConfig {
  clientId?: string;
  clientSecret?: string;
  spId?: string;
  apiBase?: string;
  /** bridge 开关：false=插件在场但不开 WS——配置页同日记。 */
  bridge?: boolean;
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
  shutdownDeadlineSeconds?: number;
  channelQuestionProvider?: boolean;
  strictFinishContract?: boolean;
  deliverChunks?: number;
}

export const Config: Schema<WpsBotConfig> = Schema.object({
  clientId: Schema.string().default(""),
  // role('secret')：settings.describe 永不下线其值（secrets 槽只报 set 与否），页面字段成 write-only。
  clientSecret: Schema.string().role("secret").default(""),
  spId: Schema.string().default(""),
  apiBase: Schema.string().default("https://openapi.wps.cn"),
  bridge: Schema.boolean().default(true),
  // 运行期自举凭据（clientId/secret 换得），同样 write-only。
  accessToken: Schema.string().role("secret").default(""),
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
  /** shutdown 总预算秒（GA GA_WPS_SHUTDOWN_TIMEOUT_SECONDS:43 对位；r3-γ 裁决 (b) 真配）。 */
  shutdownDeadlineSeconds: Schema.number().default(10),
  /** 通道代答 user-questions provider 主见位单（默认不抢主；apiproxy 在场时保持 apiproxy）。 */
  channelQuestionProvider: Schema.boolean().default(false),
  /** 严格完结契约（PROJECT 契约案）：true=无 finish_task 不落交付。 */
  strictFinishContract: Schema.boolean().default(false),
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
  /**
   * 设置节安装面：缺省 = 运行时动态 import(@deepseek-ai/dsh-settings)。
   * 测试注入它可避免真实 import 的成本/不确定性（9p 全量并行实证会把 bootstrap 挤出时窗）。
   */
  installSettingsSection?: (
    ctx: unknown, ns: string, schema: unknown, entry: WpsBotConfig,
    hooks: { setSource: (next: () => WpsBotConfig) => void; onChange: () => void },
  ) => void;
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
      // A1-1：整条删，不只清 handle——任务键无界增长防项
      chats.delete(chatId);
      cleared.push(chatId);
    }
  }
  return cleared;
}

export function apply(rawCtx: Context, config: WpsBotConfig, deps: BootDeps = {}): void {
  // 供应商/模型 settings 覆位：settings > Config（dsh-settings 可选——动态 import 失败静默回退）
  let cfgSource: () => WpsBotConfig = () => config;
  const ctx: any = rawCtx;
  const logger = ctx.logger ?? console;
  const ctxLogger = typeof ctx.logger === "function" ? ctx.logger("wps-bot") : logger;

  // 凭据 = 后设（settings 页填或环境键或 composition Config）：缺不 throw——挂上并在 creds 到位才 boot
  const credsOf = (fromCfg: WpsBotConfig): { clientId: string; clientSecret: string; spId: string } => ({
    clientId: fromCfg.clientId || process.env.WPS365_CLIENT_ID || "",
    clientSecret: fromCfg.clientSecret || process.env.WPS365_CLIENT_SECRET || "",
    spId: fromCfg.spId || process.env.WPS365_SP_ID || "",
  });
  const creds0 = credsOf(config);
  // 二度报告 §三.7：dsh session meta.cwd 必须绝对路径（ACP 同款 restrict）——boot 期硬校验好于运行期破窗
  if (config.workspaceRoot && !isAbsolute(config.workspaceRoot)) {
    throw new Error(`wps-bot: config.workspaceRoot 必须是绝对路径（收到: ${config.workspaceRoot}）`);
  }
  const apiBase = config.apiBase || process.env.WPS365_API_BASE || "https://openapi.wps.cn";

  // ---- 每 chat 的会话句柄与 requester 注册 ----

  const chats = new Map<string, ChatEntry>();

  // f2#2/b2：不闭包捕获 handle——dispose 后旧句柄成尸；每次调用现读 chats 在册句柄
  function wrap(chatId: string): ChatSessionHandle {
    const live = (): AgentHandleLike | undefined => {
      const handle = chats.get(chatId)?.handle;
      if (handle === undefined) return undefined;
      const sid = String(handle.agent?.session?.id ?? "");
      if (sid.length > 0 && sid.startsWith("wps-bot:")) {
        // ACP 纪律：投递前活体校验——registry 里的同名实例必须正是这具
        const registered = (ctx.agents as unknown as { get?: (id: unknown) => unknown })
          .get?.(sid.startsWith("wps-bot:") ? SessionId(sid) : sid);
        if (registered !== undefined && registered !== handle.agent) return undefined;
      }
      return handle;
    };
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
    // P0-1 修复（评估：旧线双前缀实证）：入参即任务会话键（router 源头保证），
    // 非任务键形态才回包（p2p 直通/测试 fake 面）；禁止裸包。
    const sessionId = SessionId(parseTaskKey(chatId) !== null ? chatId : `wps-bot:${chatId}`);
    const taskParts = parseTaskKey(chatId);
    const cwd = taskParts !== null
      ? join(
          config.workspaceRoot || process.cwd(),
          sanitizePathKey(taskParts.chatId),
          sanitizePathKey(taskParts.ownerId),
          sanitizePathKey(taskParts.taskId),
        )
      : (config.workspaceRoot || process.cwd());
    const handle = (await createOrResume(ctx.agents, {
      sessionId,
      cwd,
      agentOptions: {
        provider: cfgSource().provider ?? "deepseek-official",
        model: cfgSource().model ?? "deepseek-v4-flash",
      },
    })) as AgentHandleLike;
    if (entry === undefined) {
      entry = { chatId };
      chats.set(chatId, entry);
    }
    entry.handle = handle;
    // wps-chat skill 落点（§9.3/C）：把「我是谁/我的归档在哪」以纯数据交付脚本面——凭据不落盘（脚本走 env）。
    void (async () => {
      const wsRoot = config.workspaceRoot || process.cwd();
      const displayChatId = taskParts?.chatId ?? chatId;
      await mkdir(cwd, { recursive: true });
      await writeFile(
        join(cwd, ".wps_context.json"),
        JSON.stringify({
          chatId: displayChatId,
          sessionKey: String(sessionId),
          historyFile: historyFilePath(wsRoot, displayChatId),
          updatedAt: new Date().toISOString(),
        }, null, 2),
      );
    })().catch((error: unknown) => logger.warn("[wps-bot] .wps_context.json 落盘失败:", error));
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

  function buildCore(d: EventDedup, client: import("./bot.ts").BotClient): WpsBotCore {
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
        shutdownDeadlineMs: (config.shutdownDeadlineSeconds ?? 10) * 1000,
        strictFinishContract: config.strictFinishContract,
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

  let closed = false;
  let providerDisposer: (() => void) | undefined;
  let settingsWired = false;
  // 设置提交的统一反应：bridge 关→断连；开+凭据齐→拉起 bootstrap。
  const onSettingsChange = (): void => {
    const live = cfgSource();
    const creds = credsOf(live);
    const credsOk = creds.clientId !== "" && creds.clientSecret !== "" && creds.spId !== "";
    if (live.bridge === false && eventClient !== null && eventClient !== undefined) {
      try { eventClient.stop(); } catch { /* 静默 */ }
      logger.info("[wps-bot] bridge 关闭（WS 断开）");
    } else if (live.bridge !== false && credsOk) {
      startBootstrap();
    }
  };
  const wireSettingsSection = (): void => {
    if (settingsWired || closed) return;
    settingsWired = true;
    // 无条件挂——页面本身就是凭据的入口，不能只活在 bootstrap 之后（死锁规避靠调用点的离帧调度）。
    if (deps.installSettingsSection !== undefined) {
      try {
        deps.installSettingsSection(rawCtx as unknown, "wps-bot", Config as unknown, config, {
          setSource: (next: () => WpsBotConfig) => { cfgSource = next; },
          onChange: () => { onSettingsChange(); },
        });
      } catch (error) {
        logger.warn("[wps-bot] 设置节挂载失败:", error);
      }
      return;
    }
    void import("@deepseek-ai/dsh-settings")
      .then((m) => {
        const inst = (m as unknown as { installSettingsSection: (c: unknown, ns: string, schema: unknown, entry: WpsBotConfig, hooks: { setSource: (n: () => WpsBotConfig) => void; onChange: () => void }) => void }).installSettingsSection;
        inst(rawCtx as unknown, "wps-bot", Config as unknown, config, {
          setSource: (next: () => WpsBotConfig) => { cfgSource = next; },
          onChange: () => { onSettingsChange(); },
        });
        logger.info("[wps-bot] 设置节已注册（ns=wps-bot）");
      })
      .catch((error: unknown) => {
        // absent peer → 组合墙内可接受的 noop；其余错误必须可见（静默吞错的实证代价：页面粉屏无尸检）。
        if ((error as { code?: string })?.code === "ERR_MODULE_NOT_FOUND") return;
        logger.warn("[wps-bot] 设置节挂载失败:", error);
      });
  };

  let bootstrap: Promise<void> | undefined;
  const startBootstrap = (): void => {
    if (bootstrap !== undefined) return;
    bootstrap = (async () => {
    dedup = await EventDedup.load({
      limit: 2048,
      path: config.seenEventsPath ?? "runtime/wps-bot-seen-events.jsonl",
    });
    if (closed) return;
    // 活凭据：页面后设的凭据必须在此刻现取（此前 creds0 是启动时空壳——bootstrap 永拿空串实证）。
    const liveCreds = credsOf(cfgSource());
    if (liveCreds.clientId === "" || liveCreds.clientSecret === "" || liveCreds.spId === "") {
      logger.warn("[wps-bot] bootstrap 中止：凭据仍缺——设置页补齐后经 onChange 重试");
      bootstrap = undefined;
      return;
    }
    const client: import("./bot.ts").BotClient =
      deps.client ??
      new WpsClient({
        clientId: liveCreds.clientId,
        clientSecret: liveCreds.clientSecret,
        apiBase,
        accessToken: cfgSource().accessToken ?? "",
      });
    const botIds = [liveCreds.clientId, liveCreds.spId];
    core = buildCore(dedup, client);
    await core.loadRegistry().catch((error) => logger.warn('[wps-bot] quoteRegistry load 失败:', error));
    if (closed) return;
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
    // R6/P-B：user-questions 通道代答 provider（组合未挂该服务时 warn 降级）
    const userQuestions = (ctx as unknown as {
      userQuestions?: { registerProvider?: (p: unknown) => () => void };
    }).userQuestions;
    if (core !== null && config.channelQuestionProvider === true) {
      if (userQuestions?.registerProvider === undefined) {
        logger.warn("[wps-bot] channelQuestionProvider=true 但 userQuestions 服务未挂载——provider 不注册");
      } else {
        const owned = core;
        try {
          const disposer = userQuestions.registerProvider({
            ask: (request: unknown) => owned.askUserQuestion(request as Parameters<typeof owned.askUserQuestion>[0]),
          });
          if (typeof disposer === "function") providerDisposer = disposer as () => void;
          logger.info("[wps-bot] user-questions provider 已注册");
        } catch (error) {
          if ((error as { code?: string }).code === "DUPLICATE_PROVIDER") {
            logger.warn("[wps-bot] user-questions provider 已有主（apiproxy 广播面）——通道代答跳过");
          } else {
            throw error;
          }
        }
      }
    }
    // flag false（默认）=有意不注册（apiproxy 广播活在场）——静默正确
    // P0 回归修复：通道工具接线（定义已搬 channel-tools.ts，调用未迁——发布阻断实证）
    const toolsRegistry = (ctx as unknown as {
      tools?: { register?: (tool: unknown) => void };
    }).tools;
    if (core !== null && toolsRegistry?.register !== undefined) {
      const owed = core;
      // 第二轮 §2.1：唯一业务模型 tool = finish_task（reply/history 降 wps-chat skill/script）。
      registerChannelTools(toolsRegistry, (kind: "finish", chatId: string, text: string) =>
        owed.noteFinishTask(chatId, text),
      (agent: unknown) => chatForAgent(agent));
      logger.info("[wps-bot] finish_task 通道工具已注册");
    } else {
      logger.warn("[wps-bot] tools 服务未挂载——finish_task 缺位（组合层补挂）");
    }

    if (closed) return;
    eventClient = factory({ appId: liveCreds.clientId, appSecret: liveCreds.clientSecret, dispatcher });
    // 观测锚点必须先行：open-event-sdk 1.0.1 的 start() 在连接存活期间不 resolve——
    // 放 await 后 = 永不打印，stop 时反补一条假信号（二度报告 §三.8 实证）。
    logger.info(
      `[wps-bot] listening (approvalMode=${String(config.approvalMode)}, cardMode=${String(config.cardMode)}, botDisplayName=${config.botDisplayName})`,
    );
    if (closed) return;
    await eventClient.start();
    })().then(undefined, (error: unknown) => {
      logger.error("[wps-bot] bootstrap failed:", error);
      console.error("[wps-bot] bootstrap failed:", error);
    });
  };


  // 设置节无条件注册（页面 = 凭据入口，无凭据时恰恰最需要它）。离帧调度：
  // sync apply 帧内动态 import 会死锁装载器（host-boot E2E-1 pushey 实证）。
  const settingsTimer = setTimeout(() => { wireSettingsSection(); }, 0);
  ctx.effect(() => () => { clearTimeout(settingsTimer); settingsWired = true; });

  // 凭据 + bridge 面到位即发 bootstrap；两关都关的式
  const cred0Missing = creds0.clientId === "" || creds0.clientSecret === "" || creds0.spId === "";
  if (config.bridge === false) {
    logger.info("[wps-bot] bridge=false——插件在场但 WS 不开（设置页面打开后自动启动）");
  } else if (cred0Missing) {
    logger.info("[wps-bot] 凭据未设——在设置页填写 clientId/secret/spId 后自动启动");
  } else {
    startBootstrap();
  }

  ctx.effect(() => {
    void bootstrap?.catch(() => undefined);
    return async () => {
      closed = true;
      try { providerDisposer?.(); } catch { /* 静默 */ }
      providerDisposer = undefined;
      // 清理序：先断入站（stop）→ 再收业务（shutdown）→ 最后 agent dispose
      try {
        eventClient?.stop(); // SDK 1.0.1 stop(): void（无 await）
      } catch {
        /* 静默 */
      }
      // ACP/L1-5 裁：子代理排水先于业务收口（与 PROJECT 拆分契约同序）
      const subagents = (ctx as unknown as {
        get?: (key: string) => unknown;
      }).get?.("subagents") as { drainContinuableDescendants?: (agents: unknown[]) => Promise<unknown> } | undefined;
      if (subagents?.drainContinuableDescendants !== undefined) {
        await subagents
          .drainContinuableDescendants([...chats.values()].map((entry) => entry.handle?.agent).filter(Boolean))
          .catch(() => undefined);
      }
      await core?.shutdown().catch(() => undefined);
      const disposals = [...chats.values()]
        .filter((entry) => entry.handle !== undefined)
        .map((entry) => (entry.handle as AgentHandleLike).dispose());
      await Promise.allSettled(disposals);
    };
  }, "wps-bot.serve");
}

export default { name, inject, Config, apply };
