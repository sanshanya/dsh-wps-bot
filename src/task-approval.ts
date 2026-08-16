/**
 * 审批服务（GA approval.py:86+ 矩阵的 dsh 对位件）：群问+同意语法+限时窗+审计三元组全态。
 *
 * @module dsh-wps-bot/task-approval
 */

import { appendApprovalAudit, autoAllowEntry, type ApprovalAuditEntry } from "./audit.ts";
import { ApprovalWindowStore, parseConsent, windowAllows } from "./consent.ts";
import { parseTaskKey } from "./task-keys.ts";
import type { WpsEvent } from "./protocol.ts";
import type { WpsRouter } from "./dispatch.ts";
import type { ProgressCards } from "./card.ts";

export const ACK_APPROVED = "操作已批准。";
export const ACK_APPROVED_NO_WINDOW = "操作已批准，但本次未开启自动同意窗口。";
export const ACK_DECLINED = "操作已取消，意见将交给模型继续处理。";
export const ACK_TIMEOUT = "审批超时未获答复，本次操作已取消。";

export function ackApprovedWindow(n: number): string {
  return `已开启 ${n} 分钟自动同意窗口——窗口对本对话中您本人发起的后续确认操作生效。`;
}

export function allowsWindowForReason(reason: string | undefined): boolean {
  if (typeof reason !== "string") return true;
  return !reason.startsWith("[gate-source=fail_closed]");
}

export type ReplyEvent =
  | { kind: "reply"; text: string; userId?: string }
  | { kind: "timeout" }
  | { kind: "cancelled" };

export interface ApprovalRequestLike {
  agent?: unknown;
  toolName?: string;
  reason?: string;
  callId?: unknown;
  signal?: { aborted: boolean; addEventListener?: (evt: string, cb: () => void) => void };
}

export type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";

export function approvalQuestion(review: string, allowWindow: boolean): string {
  const instruction = allowWindow
    ? "回复“同意”仅执行本次；回复“同意5分钟”（分钟数可替换）开启限时自动同意——窗口对本对话中您本人发起的后续所有待确认操作生效。"
    : "本次仅支持回复“同意”执行一次，不开放限时自动同意。";
  return `**需要确认的操作**\n\n${instruction}\n\n${review}`;
}

function withTriple(entry: ApprovalAuditEntry, sessionId: string, owner: { userId: string } | undefined, requester: { userId: string }): void {
  entry.sessionId = sessionId;
  entry.ownerUserId = owner?.userId ?? requester.userId;
  entry.requesterUserId = requester.userId;
}
function withFields(entry: ApprovalAuditEntry, sessionId: string, owner: { userId: string } | undefined, requester: { userId: string }, approver: string): void {
  withTriple(entry, sessionId, owner, requester);
  entry.approverUserId = approver;
}

interface PendingApproval {
  userIds: Set<string>;
  resolvedBy?: string;
  timer: NodeJS.Timeout;
  abortHook?: () => void;
  resolve: (reply: ReplyEvent) => void;
}

export interface ApprovalClient {
  resolveMention(userId: string, name?: string): Promise<unknown>;
  sendMarkdown(chatId: string, markdown: string, mention?: unknown): Promise<unknown>;
  sendMarkdownSplit(chatId: string, text: string, mention: unknown, limit?: number): Promise<string[]>;
}

export interface ApprovalSessions {
  getRequester(sessionId: string): { userId: string; name: string } | undefined;
}

export function decideApproval(
  reply: ReplyEvent,
  allowWindow: boolean,
  chatId: string,
  userId: string,
  reason: string,
  windows: ApprovalWindowStore,
  sessionKey?: string,
): { outcome: ApprovalOutcome; ackText: string | null; audit: ApprovalAuditEntry } {
  const timestamp = Math.floor(Date.now() / 1000);
  if (reply.kind === "cancelled") {
    return {
      outcome: "cancelled",
      ackText: null,
      audit: { timestamp, kind: "reply-resolution", auditOutcome: "cancelled", chatId, userId, approved: false, reason },
    };
  }
  if (reply.kind === "timeout") {
    return {
      outcome: "rejected",
      ackText: ACK_TIMEOUT,
      audit: { timestamp, kind: "reply-resolution", auditOutcome: "timeout", chatId, userId, approved: false, reason },
    };
  }
  const minutes = parseConsent(reply.text);
  if (minutes === null) {
    return {
      outcome: "rejected",
      ackText: ACK_DECLINED,
      audit: { timestamp, kind: "reply-resolution", auditOutcome: "decision", chatId, userId, approved: false, reason, feedback: reply.text },
    };
  }
  if (minutes > 0 && allowWindow) {
    const windowExpiresAt = windows.grant(sessionKey ?? chatId, userId, minutes);
    return {
      outcome: "allowed-once",
      ackText: ackApprovedWindow(minutes),
      audit: { timestamp, kind: "reply-resolution", auditOutcome: "decision", chatId, userId, approved: true, reason, windowExpiresAt, grantMinutes: minutes },
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

export class TaskApprovalService {
  private readonly windows = new ApprovalWindowStore();
  private readonly approvalByChat = new Map<string, Promise<unknown>>();
  readonly pendings = new Map<string, PendingApproval>();

  private readonly deps: {
    approvalMode: string;
    approvalTimeoutMs: number;
    allowWindow: boolean;
    auditPath: string;
    client: ApprovalClient;
    router: WpsRouter;
    sessions: ApprovalSessions;
    cards: ProgressCards;
    chatForAgent: (agent: unknown) => string | null;
    logger: { warn(...args: unknown[]): void };
  };

  constructor(deps: TaskApprovalService["deps"]) {
    this.deps = deps;
  }

  get count(): number {
    return this.pendings.size;
  }

  get windowStore(): ApprovalWindowStore {
    return this.windows;
  }

  /** prepend answerer：同任务会话单槽 FIFO（旧 pending flush 成 cancelled 即防竞）。 */
  async handle(req: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const chainChatId = this.deps.chatForAgent(req.agent);
    if (chainChatId !== null) {
      const prev = this.approvalByChat.get(chainChatId) ?? Promise.resolve();
      const current = prev.catch(() => undefined).then(() => this.inner(req, next));
      this.approvalByChat.set(chainChatId, current);
      try {
        return await current;
      } finally {
        if (this.approvalByChat.get(chainChatId) === current) this.approvalByChat.delete(chainChatId);
      }
    }
    return this.inner(req, next);
  }

  private async inner(req: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const cfg = this.deps;
    if (cfg.approvalMode === "disabled") return next();
    if (req.signal?.aborted) return "cancelled";
    const sessionId = cfg.chatForAgent(req.agent);
    if (sessionId === null) return next();
    const chatId = parseTaskKey(sessionId)?.chatId ?? sessionId;
    const owner = cfg.router.getOwner(sessionId);
    const requester = cfg.sessions.getRequester(sessionId);
    if (requester === undefined) return next();
    const task = cfg.router.getTask(sessionId);
    const allowed = new Set<string>([
      ...(owner !== undefined ? [owner.userId] : []),
      ...(task?.participants ?? []).map((p) => p.userId),
    ]);
    if (allowed.size === 0) allowed.add(requester.userId);

    const allowWindow = cfg.allowWindow && allowsWindowForReason(req.reason);
    if ([...allowed].some((u) => windowAllows(this.windows, sessionId, u, allowWindow))) {
      try {
        const hitUser = [...allowed].find((u) => windowAllows(this.windows, sessionId, u, allowWindow)) ?? requester.userId;
        const entry = autoAllowEntry({
          chatId,
          userId: hitUser,
          review: req.reason,
          reason: req.reason,
          toolName: req.toolName,
          callId: req.callId !== undefined ? String(req.callId) : undefined,
          windowExpiresAt: this.windows.expiresAt(sessionId, hitUser) ?? undefined,
        });
        withTriple(entry, sessionId, owner, requester);
        await appendApprovalAudit(cfg.auditPath, entry);
        return "allowed-once";
      } catch {
        return "unavailable";
      }
    }

    const mentionTargets = [
      owner !== undefined ? owner : requester,
      ...(owner === undefined || owner.userId === requester.userId ? [] : [requester]),
    ];
    const mentions = await Promise.all(
      mentionTargets.map((t) => cfg.client.resolveMention(t.userId, t.name).catch(() => null)),
    ).then((list) => list.filter((m) => m !== null));
    const reason = String(req.reason ?? "");
    try {
      await cfg.client.sendMarkdownSplit(chatId, approvalQuestion(reason, allowWindow), mentions.length > 0 ? (mentions as never) : null, undefined);
    } catch (error) {
      cfg.logger.warn("[wps-bot] approval question send failed:", error);
      return next();
    }
    this.deps.cards.phase(sessionId, { phase: "等待人工审批" });

    const reply = await this.waitReply(sessionId, allowed, req.signal);
    const decisionUserId = reply.kind === "reply" ? (reply.userId ?? requester.userId) : requester.userId;
    const decision = decideApproval(reply, allowWindow, chatId, decisionUserId, reason, this.windows, sessionId);
    withTriple(decision.audit, sessionId, owner, requester);
    if (reply.kind === "reply") decision.audit.approverUserId = decisionUserId;
    await appendApprovalAudit(cfg.auditPath, decision.audit).catch((error: unknown) => {
      cfg.logger.warn("[wps-bot] audit append failed:", error);
    });
    if (decision.ackText) {
      await cfg.client.sendMarkdown(chatId, decision.ackText, mentions.length > 0 ? (mentions as never) : undefined).catch(() => undefined);
    }
    return decision.outcome;
  }

  cancel(sessionId: string): void {
    const pend = this.pendings.get(sessionId);
    if (pend === undefined) return;
    pend.resolve({ kind: "cancelled" });
  }

  cancelAll(reason: Error): void {
    for (const [, pend] of [...this.pendings]) pend.resolve({ kind: "cancelled" });
    this.pendings.clear();
  }

  /** any-of 消费（owner∪participants）：sender 命中即 resolve。 */
  tryConsume(ev: WpsEvent, sameChat: (sessionId: string) => boolean): PendingApproval | null {
    for (const [sessionId, pend] of this.pendings) {
      if (!sameChat(sessionId) || !pend.userIds.has(ev.senderId)) continue;
      pend.resolvedBy = ev.senderId;
      pend.resolve({ kind: "reply", text: ev.text.trim(), userId: ev.senderId });
      return pend;
    }
    return null;
  }

  private waitReply(
    sessionId: string,
    userIds: Set<string>,
    signal?: { aborted: boolean; addEventListener?: (evt: string, cb: () => void) => void },
  ): Promise<ReplyEvent> {
    return new Promise((resolve) => {
      const selfDelete = (entry: PendingApproval) => {
        if (this.pendings.get(sessionId) === entry) this.pendings.delete(sessionId);
      };
      const entry: PendingApproval = {
        userIds,
        resolve: (reply) => {
          if ((entry as { settled?: boolean }).settled === true) return;
          (entry as { settled?: boolean }).settled = true;
          clearTimeout(timer);
          if (entry.abortHook) entry.abortHook();
          selfDelete(entry);
          resolve(reply);
        },
        timer: undefined as unknown as NodeJS.Timeout,
        abortHook: undefined,
      };
      const timer = setTimeout(() => {
        selfDelete(entry);
        resolve({ kind: "timeout" });
      }, this.deps.approvalTimeoutMs);
      entry.timer = timer;
      entry.abortHook = undefined;
      if (signal?.aborted) {
        resolve({ kind: "cancelled" });
        return;
      }
      if (signal?.addEventListener) {
        const onAbort = () => {
          entry.resolve({ kind: "cancelled" });
        };
        signal.addEventListener("abort", onAbort);
        entry.abortHook = () => {
          const remover = (signal as unknown as { removeEventListener?: (evt: string, cb: () => void) => void }).removeEventListener;
          if (typeof remover === "function") {
            remover.call(signal, "abort", onAbort);
          }
        };
      }
      const old = this.pendings.get(sessionId);
      if (old !== undefined) old.resolve({ kind: "cancelled" });
      this.pendings.set(sessionId, entry);
    });
  }
}
