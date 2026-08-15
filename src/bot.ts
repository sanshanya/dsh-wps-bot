/**
 * 调度/卡片/审批的宿主无关核心（cordis 之外可测）。
 *
 * `index.ts` 唯一责任是把 cordis（ctx / agents.create / ctx.on / ctx.effect / schemastery）
 * 与 open-event-sdk 长连接映射到本类的注入接口上；本类不 import 任何 dsh/open-event-sdk 包，
 * 因此全用例可以在假实现下运行（与真 cordis 同源逻辑，WPS 事件入站/审批/相位/回包的时序都在测试里）。
 *
 * @module dsh-wps-bot/bot
 */

import { WpsClient, type Mention } from "./client.ts";
import { ProgressCards } from "./card.ts";
import { ApprovalWindowStore, parseConsent, windowAllows } from "./consent.ts";
import { appendApprovalAudit, autoAllowEntry, type ApprovalAuditEntry } from "./audit.ts";
import type { EventDedup } from "./dedup.ts";
import type { WpsEvent } from "./protocol.ts";
import { WpsRouter, type ChatSessionHandle, type Route } from "./dispatch.ts";

export interface CoreLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** 宿主会话句柄提供者（chatId ↔ chat session/requester 追踪）。 */
export interface BotSessions {
  ensure(chatId: string): Promise<ChatSessionHandle>;
  /** requester 回写（宿主把它挂在自己的 chat entry 上）。 */
  setRequester(chatId: string, r: { userId: string; name: string }): void;
  getRequester(chatId: string): { userId: string; name: string } | undefined;
}

/** 运行要求 doc：WpsClient 的 API 浦口；测试用假实现。 */
export type BotClient = Pick<
  WpsClient,
  "sendMarkdown" | "sendMarkdownSplit" | "sendCard" | "updateCard" | "recallMessage" | "resolveMention"
>;

export const ACK_APPROVED = "操作已批准。";
export const ACK_APPROVED_NO_WINDOW = "操作已批准，但本次未开启自动同意窗口。";
export const ACK_DECLINED = "操作已取消，意见将交给模型继续处理。";
export const ACK_TIMEOUT = "审批超时未获答复，本次操作已取消。";
export const ACK_INTERVENTION_DEFAULT = "已收到补充信息，当前任务会在下一轮处理。";
export function ackApprovedWindow(n: number): string {
  return `操作已批准，并开启 ${n} 分钟自动同意窗口。`;
}

export interface ApprovalRequestLike {
  agent?: unknown;
  toolName?: string;
  callId?: string;
  reason?: string;
  signal?: { aborted: boolean };
}
export type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";

export type ReplyEvent =
  | { kind: "reply"; text: string }
  | { kind: "timeout" }
  | { kind: "cancelled" };

export interface AgentSessionLike {
  id?: string;
}

export interface CoreBotOptions {
  client: BotClient;
  logger: CoreLogger;
  dedup: EventDedup;
  sessions: BotSessions;
  /** chatForSessionId / chatForAgent 由宿主负责（cordis 进程内才知道 agent 身分）。 */
  chatForSessionId: (sessionId: string) => string | null;
  chatForAgent: (agent: unknown) => string | null;
  config: {
    cardMode: "card" | "off";
    cardTitle: string;
    cardInitialDelayMs: number;
    cardHeartbeatMs: number;
    cardUpdateMinIntervalMs: number;
    cardSettle: "recall" | "update";
    approvalMode: "windows" | "disabled";
    approvalTimeoutMs: number;
    allowWindow: boolean;
    auditPath: string;
    ackInterventionText: string;
    deliverChunks: number;
  };
}

/** GA ga_handler.py:146：reason 前缀 [gate-source=fail_closed] 一律不开窗。 */
export function allowsWindowForReason(reason: string | undefined): boolean {
  if (typeof reason !== "string") return true;
  return !reason.startsWith("[gate-source=fail_closed]");
}

interface PendingApproval {
  userId: string;
  resolve: (reply: ReplyEvent) => void;
  timer: NodeJS.Timeout;
}

export class WpsBotCore {
  private readonly client: BotClient;
  private readonly logger: CoreLogger;
  private readonly sessions: BotSessions;
  private readonly chatForSessionIdFn: (id: string) => string | null;
  private readonly chatForAgentFn: (agent: unknown) => string | null;
  private readonly cfg: CoreBotOptions["config"];

  readonly router: WpsRouter;
  readonly cards: ProgressCards;
  private readonly windows = new ApprovalWindowStore();
  private readonly pendings = new Map<string, PendingApproval>();

  constructor(opts: CoreBotOptions) {
    this.client = opts.client;
    this.logger = opts.logger;
    this.sessions = opts.sessions;
    this.chatForSessionIdFn = opts.chatForSessionId;
    this.chatForAgentFn = opts.chatForAgent;
    this.cfg = opts.config;

    this.cards = new ProgressCards({
      client: this.client,
      title: this.cfg.cardTitle,
      initialDelayMs: this.cfg.cardInitialDelayMs,
      heartbeatMs: this.cfg.cardHeartbeatMs,
      updateMinIntervalMs: this.cfg.cardUpdateMinIntervalMs,
      settle: this.cfg.cardSettle,
      mode: this.cfg.cardMode,
      logger: this.logger,
    });

    this.router = new WpsRouter({
      dedup: opts.dedup,
      ensure: (chatId) => this.sessions.ensure(chatId),
      ackIntervention: async (chatId, senderUserId, senderName) => {
        const mention = await this.client
          .resolveMention(senderUserId, senderName)
          .catch(() => null);
        await this.client.sendMarkdown(
          chatId,
          this.cfg.ackInterventionText,
          mention ? [mention] : undefined,
        );
      },
      onDispatched: (chatId, ev) => {
        this.sessions.setRequester(chatId, { userId: ev.senderId, name: ev.senderName });
        this.cards.start(chatId); // GA 习惯：任务被 accepted 才开进度卡文体
      },
      logger: { warn: (...args: unknown[]) => this.logger.warn(...args) },
    });
  }

  /** WPS 事件入口：首条 pending 回复原子消费，其余送分诊。 */
  async handleIncomingEvent(ev: WpsEvent): Promise<Route | "approval-reply"> {
    const pend = this.pendings.get(ev.chatId);
    if (pend !== undefined && ev.senderId === pend.userId) {
      pend.resolve({ kind: "reply", text: ev.text.trim() });
      return "approval-reply";
    }
    return this.router.handleEvent(ev);
  }

  /** 审批 answerer（prepend waterfall；GA approval.py:86+ 矩阵） */
  async handleApprovalRequest(
    req: ApprovalRequestLike,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    if (this.cfg.approvalMode === "disabled") return next();
    if (req.signal?.aborted) return "cancelled";
    const chatId = this.chatForAgentFn(req.agent);
    if (chatId === null) return next();
    const requester = this.sessions.getRequester(chatId);
    if (requester === undefined) return next();

    const allowWindow = this.cfg.allowWindow && allowsWindowForReason(req.reason);
    if (windowAllows(this.windows, chatId, requester.userId, allowWindow)) {
      try {
        await appendApprovalAudit(
          this.cfg.auditPath,
          autoAllowEntry({
            chatId,
            userId: requester.userId,
            review: req.reason,
            reason: req.reason,
            toolName: req.toolName,
            callId: req.callId,
            windowExpiresAt: this.windows.expiresAt(chatId, requester.userId) ?? undefined,
          }),
        );
        return "allowed-once";
      } catch {
        return next(); // 审计写失败 → 降级回群问（未记账的自动答允不得出闸）
      }
    }

    const mention = await this.client
      .resolveMention(requester.userId, requester.name)
      .catch(() => null);
    const reason = String(req.reason ?? "");
    try {
      await this.client.sendMarkdownSplit(
        chatId,
        approvalQuestion(reason, allowWindow),
        mention,
        this.cfg.deliverChunks,
      );
    } catch (error) {
      this.logger.warn("[wps-bot] approval question send failed:", error);
      return next();
    }
    void this.cards.phase(chatId, { phase: "等待人工审批" });

    const reply = await this.waitReply(chatId, requester.userId);
    const decision = decideApproval(reply, allowWindow, chatId, requester.userId, reason, this.windows);
    await appendApprovalAudit(this.cfg.auditPath, decision.audit).catch((error: unknown) => {
      this.logger.warn("[wps-bot] audit append failed:", error);
    });
    if (decision.ackText) {
      await this.client
        .sendMarkdown(chatId, decision.ackText, mention ? [mention] : undefined)
        .catch(() => undefined);
    }
    return decision.outcome;
  }

  /** session/event 钩子：相位 + 队列泄流 + 回包/中断。 */
  handleSessionEvent(sessionId: string, event: { type: string; data?: unknown }): void {
    const chatId = this.chatForSessionIdFn(sessionId);
    if (chatId === null) return;
    const data = event.data as Record<string, unknown> | undefined;
    switch (event.type) {
      case "assistant/message": {
        const text = assistantTextOf(event);
        if (text !== undefined) void this.deliver(chatId, text);
        break;
      }
      case "turn/start": {
        const turn = data?.turn;
        this.cards.phase(chatId, typeof turn === "number" ? { turn } : {});
        break;
      }
      case "tool/call": {
        const tool = data?.name;
        this.cards.phase(chatId, { tool: typeof tool === "string" && tool ? tool : "工具" });
        break;
      }
      case "approval/asked": {
        this.cards.phase(chatId, { phase: "等待人工审批" });
        break;
      }
      case "turn/end": {
        const kind = data?.kind;
        if (kind === "error" || kind === "aborted") {
          void this.interrupt(chatId, kind);
        }
        void this.finalizeTurn(chatId);
        break;
      }
      default:
        break;
    }
  }

  async deliver(chatId: string, text: string): Promise<void> {
    try {
      await this.client.sendMarkdownSplit(chatId, text, null, this.cfg.deliverChunks);
    } catch (error) {
      this.logger.error("[wps-bot] deliver failed:", error);
    }
  }

  async interrupt(chatId: string, kind: unknown): Promise<void> {
    try {
      await this.client.sendMarkdown(
        chatId,
        `[任务已中止] 当前任务已${kind === "aborted" ? "被中止" : "失败"}（chat ${chatId}）。如需继续，请重新发起任务。`,
      );
    } catch (error) {
      this.logger.warn("[wps-bot] interrupt notice failed:", error);
    }
  }

  async finalizeTurn(chatId: string): Promise<void> {
    await this.router.drain(chatId).catch(() => undefined);
    if (this.router.queued(chatId) === 0) await this.cards.finish(chatId);
  }

  /** 卸载/重启：失败 pending 回 cancelled；卡片完结；送因回退 commit 的 bash 记志全部留意。 */
  async shutdown(): Promise<void> {
    for (const chatId of [...this.pendings.keys()]) {
      this.cancelPending(chatId);
    }
    await this.cards.finishAll().catch(() => undefined);
  }

  pendingCount(): number {
    return this.pendings.size;
  }

  cancelPending(chatId: string): void {
    const pend = this.pendings.get(chatId);
    if (pend === undefined) return;
    pend.resolve({ kind: "cancelled" });
  }

  private waitReply(chatId: string, userId: string): Promise<ReplyEvent> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendings.delete(chatId);
        resolve({ kind: "timeout" });
      }, this.cfg.approvalTimeoutMs);
      this.pendings.set(chatId, {
        userId,
        resolve: (reply) => {
          clearTimeout(timer);
          this.pendings.delete(chatId);
          resolve(reply);
        },
        timer,
      });
    });
  }
}

/** GA approval.py 的群问面提示词（Kubernetes 写作拆掉，本插件不做 K8s 特化）。 */
export function approvalQuestion(review: string, allowWindow: boolean): string {
  const instruction = allowWindow
    ? "回复“同意”仅执行本次；回复“同意5分钟”（分钟数可替换）开启限时自动同意。"
    : "本次仅支持回复“同意”执行一次，不开放限时自动同意。";
  return `**需要确认的操作**\n\n${instruction}其他回复会取消本次操作并交给模型。\n\n${review}`;
}

function decideApproval(
  reply: ReplyEvent,
  allowWindow: boolean,
  chatId: string,
  userId: string,
  reason: string,
  windows: ApprovalWindowStore,
): { outcome: ApprovalOutcome; ackText: string | null; audit: ApprovalAuditEntry } {
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
    const windowExpiresAt = windows.grant(chatId, userId, minutes);
    return {
      outcome: "allowed-once",
      ackText: ackApprovedWindow(minutes),
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
