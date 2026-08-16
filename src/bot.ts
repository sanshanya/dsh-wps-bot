/**
 * 调度/卡片/审批的宿主无关核心（cordis 之外可测）。
 *
 * `index.ts` 唯一责任是把 cordis（ctx / agents.create / ctx.on / ctx.effect / schemastery）
 * 与 open-event-sdk 长连接映射到本类的注入接口上；本类不 import 任何 dsh/open-event-sdk 包，
 * 因此全用例可以在假实现下运行（与真 cordis 同源逻辑，WPS 事件入站/审批/相位/回包的时序都在测试里）。
 *
 * @module dsh-wps-bot/bot
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

import { WpsClient, type Mention } from "./client.ts";
import { ProgressCards } from "./card.ts";
import { ApprovalWindowStore, parseConsent, windowAllows } from "./consent.ts";
import { appendApprovalAudit, autoAllowEntry, type ApprovalAuditEntry } from "./audit.ts";
import { detailFor, InterruptionLedger, interruptionNotice, reasonForTurnEnd } from "./notify.ts";
import { EvidenceStore } from "./evidence.ts";
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
  | "sendMarkdown"
  | "sendMarkdownSplit"
  | "sendCard"
  | "updateCard"
  | "recallMessage"
  | "resolveMention"
  | "downloadAttachment"
  | "uploadFile"
>;

/** GA ga_runtime.py:23：`[[attach:路径]]` 交付标记（模型面约定，人写提示词由组合 persona 承载）。 */
const ATTACH_MARKER = /\[\[attach:([^\]]+)\]\]/g;

/** GA history.attachment_target 的文件名净化：unicode 字母数字 + . _ -，其余 _，截 160。 */
function safeArtifactName(name: string): string {
  return name
    .split("")
    .map((ch) => (/^[\p{L}\p{N}]$/u.test(ch) || "._-".includes(ch) ? ch : "_"))
    .join("")
    .slice(0, 160);
}

export const ACK_APPROVED = "操作已批准。";
export const ACK_APPROVED_NO_WINDOW = "操作已批准，但本次未开启自动同意窗口。";
export const ACK_DECLINED = "操作已取消，意见将交给模型继续处理。";
export const ACK_TIMEOUT = "审批超时未获答复，本次操作已取消。";
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
    /** 会话工作区根：downloads/ 与 artifacts/ 的父目录（GA workspace 语义）。 */
    workspaceRoot: string;
    /** shutdown 总预算毫秒（GA config.py:43 的 10s 对位）。 */
    shutdownDeadlineMs?: number;
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
  abortHook?: (() => void) | undefined;
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
  private readonly interruptionLedger = new InterruptionLedger();
  private evidenceStore: EvidenceStore | null = null;
  private get evidence(): EvidenceStore {
    this.evidenceStore ??= new EvidenceStore(this.cfg.workspaceRoot);
    return this.evidenceStore;
  }
  private readonly lastDelivered = new Set<string>();
  private readonly lastFailure = new Map<string, string>();

  /** P0-4：同 chatId 的单飞 ensure：两条并发 direct 不会为同一 sessionId 创交项。 */
  private async singleFlightEnsure(chatId: string): Promise<ChatSessionHandle> {
    const existing = this.pendingEnsures.get(chatId);
    if (existing !== undefined) return existing;
    const pending = this.sessions.ensure(chatId);
    this.pendingEnsures.set(chatId, pending);
    try {
      return await pending;
    } finally {
      this.pendingEnsures.delete(chatId);
    }
  }

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
      // 改 buildCore：抱抱 chorine 整座 ensure 调用一个 p-cycle 的单飞避免并发创两次会话（报告 P0-4）
      ensure: (chatId) => this.singleFlightEnsure(chatId),
      // GA accepts_progress_reply：quote == 在途进度卡 id 且会话在跑
      isProgressReply: (ev, busy) =>
        busy &&
        ev.quoteMsgId.length > 0 &&
        this.cards.progressMessageId(ev.chatId) === ev.quoteMsgId,

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
      onDispatched: (chatId, ev, route) => {
        // G5：requester=「审批权归属」——只有真实派发新任务（enqueue）才改写；
        // inject 是把补充塞进 A 的任务，B 不应因此获得审批窗（f3 安全回归）
        if (route === "enqueue") {
          this.sessions.setRequester(chatId, { userId: ev.senderId, name: ev.senderName });
        }
        // GA 一卡共养：同 chat 已有活卡就不起步（跨排程任务续更同一张卡；
        // 仅当 finalizeTurn 在空闲收官回完上张卡后才设新一轮的起始点）
        if (this.cards.hasActive(chatId)) return;
        this.cards.start(chatId);
      },
      logger: { warn: (...args: unknown[]) => this.logger.warn(...args) },
    });
  }

  /**
   * WPS 事件入口：先 answerer dedup（避免 WPS 重投让审批路径绕过幂等判据）→ pending 原子消费→ router。
   * 已 accepted 的回复不会被二次计当（已被 record 过的事件重归时 rejective duplicate）。
   */
  async handleIncomingEvent(ev: WpsEvent): Promise<Route | "approval-reply" | "duplicate"> {
    if (!this.router.claimLock(ev.eventId)) return "duplicate"; // 幂等均垫
    const pend = this.pendings.get(ev.chatId);
    if (pend !== undefined && ev.senderId === pend.userId) {
      try {
        pend.resolve({ kind: "reply", text: ev.text.trim() });
        await this.router.recordAcceptance(ev.eventId);
        return "approval-reply";
      } catch (error) {
        this.router.releaseAcceptance(ev.eventId);
        throw error;
      }
    }
    // GA app.py:339：run 前 eager materialize——附件落盘先于分发/排队/注入
    // 二度报告 §五：materialize 抛错必须 release——否则 event_id 永远 in-flight（dedup 死位）
    // R4 三落盘（先于 materialize;失败仅 warn 不阻断——证据面不劫持调度）
    await this.recordEvidence(ev).catch((error) => this.logger.warn("[wps-bot] evidence 落盘失败:", error));
    try {
      await this.materializeAttachments(ev);
    } catch (error) {
      this.router.releaseAcceptance(ev.eventId);
      throw error;
    }
    return this.router.handleEvent(ev, { preClaimed: true });
  }

  /** R4：unparsed/cloud_docs/shared_doc_ids 三路 JSONL 落盘；路径经 observations 进 prompt。 */
  private async recordEvidence(ev: WpsEvent): Promise<void> {
    const base = { chatId: ev.chatId, eventId: ev.eventId };
    const lines: string[] = [];
    if (ev.unparsed.length > 0) {
      const path = await this.evidence.record(
        "unparsed_content",
        ev.unparsed.map((u) => ({ ...base, path: u.path, reason: u.reason, value: u.value })),
      );
      if (path !== null) lines.push(`未解析节点原文 → ${path}`);
    }
    if (ev.cloudDocLinks.length > 0) {
      const path = await this.evidence.record(
        "cloud_docs",
        ev.cloudDocLinks.map((link) => ({ ...base, link })),
      );
      if (path !== null) lines.push(`云文档链接台账 → ${path}`);
    }
    if (ev.sharedDocIds.length > 0) {
      const path = await this.evidence.record(
        "shared_doc_ids",
        ev.sharedDocIds.map((id) => ({ ...base, id })),
      );
      if (path !== null) lines.push(`共享文档 id 台账 → ${path}`);
    }
    for (const line of lines) ev.observations.push(line);
  }

  /**
   * GA _download_attachments 对位：downloads/{sha256(eventId)[:12]}/{NN}_{safeName|kind}。
   * 逐附件容错——失败不阻断分发，观察原样进 observations 供 factify 注入（GA:527-531）。
   */
  private async materializeAttachments(ev: WpsEvent): Promise<void> {
    const withKey = ev.attachments.filter((a) => a.storageKey);
    if (withKey.length === 0) return;
    const digest = createHash("sha256").update(ev.eventId, "utf8").digest("hex").slice(0, 12);
    const dir = join(this.cfg.workspaceRoot, "downloads", digest);
    await mkdir(dir, { recursive: true });
    let index = 0;
    for (const attachment of withKey) {
      index += 1;
      const target = join(dir, `${String(index).padStart(2, "0")}_${safeArtifactName(attachment.name) || attachment.kind}`);
      try {
        const bytes = await this.client.downloadAttachment(ev.chatId, ev.eventId, attachment.storageKey);
        await writeFile(target, bytes);
        attachment.localPath = target;
      } catch (error) {
        ev.observations.push(
          `Attachment download failed for ${attachment.name || attachment.kind} at ${target}: ${String(error)}`,
        );
      }
    }
  }

  /**
   * GA _ATTACHMENT 收集（ga_runtime.py:272-289）：marker 解析 → 必须在 artifacts 根内的
   * 现存文件；违规/缺失记 errors（原样上群）；marker 从交付正文剥离。
   */
  private extractArtifacts(
    text: string,
  ): { cleaned: string; files: Array<{ marker: string; candidate: string }>; errors: string[] } {
    const workspaceRoot = resolve(this.cfg.workspaceRoot);
    const artifactRoot = resolve(workspaceRoot, "artifacts");
    const files: Array<{ marker: string; candidate: string }> = [];
    const errors: string[] = [];
    const seenMarkers = new Set<string>();
    const seenCandidates = new Set<string>();
    for (const match of text.matchAll(ATTACH_MARKER)) {
      const marker = (match[1] ?? "").trim();
      const candidate = resolve(workspaceRoot, marker);
      if (candidate !== artifactRoot && !candidate.startsWith(artifactRoot + sep)) {
        if (!seenMarkers.has(marker)) errors.push(`artifact path is outside the deliverable directory: ${marker}`);
        seenMarkers.add(marker);
        continue;
      }
      if (seenCandidates.has(candidate)) continue;
      seenCandidates.add(candidate);
      files.push({ marker, candidate });
    }
    return { cleaned: text.replace(ATTACH_MARKER, "").trim(), files, errors };
  }

  /** 并发审批串行链：同 chat 同时刻至多只挂一只群问（P1 单槽覆盖改案）。 */
  private readonly approvalByChat = new Map<string, Promise<unknown>>();

  /** 审批 answerer（prepend waterfall；GA approval.py:86+ 矩阵） */
  async handleApprovalRequest(
    req: ApprovalRequestLike,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    const chainChatId = this.chatForAgentFn(req.agent);
    if (chainChatId !== null) {
      const prev = this.approvalByChat.get(chainChatId) ?? Promise.resolve();
      const current = prev.catch(() => undefined).then(() => this.handleApprovalRequestInner(req, next));
      this.approvalByChat.set(chainChatId, current);
      try {
        return await current;
      } finally {
        if (this.approvalByChat.get(chainChatId) === current) this.approvalByChat.delete(chainChatId);
      }
    }
    return this.handleApprovalRequestInner(req, next);
  }

  private async handleApprovalRequestInner(
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
        // 审计失败=fail-closed：显式 unavailable 而不是 next()（另一宽 answerer 在同组合时会抢答）
        return "unavailable";
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

    const reply = await this.waitReply(chatId, requester.userId, req.signal);
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

  /** 每 chat 当轮最高一个含 text 的 assistant 消息正文（GA terminal response 的最后一条）。 */
  private readonly turnFinalText = new Map<string, string>();
  /** F4：同 chatId 的 ensure 单飞：两条并发 direct 并发只建一份会话句柄。 */
  private readonly pendingEnsures = new Map<string, Promise<ChatSessionHandle>>();

  /** session/event 钩子：相位 + 终态回答缓冲 + turn/end 的验收/中断/泄流。
   *  wire 形状按 packages/core/session/src/types.ts:252（turn/end: { turn, reason: TurnEndReason }，kind ∈ completed/aborted/error/blocked/max-tokens）。
   */
  handleSessionEvent(sessionId: string, event: { type: string; data?: unknown }): void {
    const chatId = this.chatForSessionIdFn(sessionId);
    if (chatId === null) return;
    const data = event.data as Record<string, unknown> | undefined;
    switch (event.type) {
      case "assistant/message": {
        // GA A9：只有终态回答可作正式交付；step-by-step 的中间 ara 先入缓冲，turn/end 才定稿
        const text = assistantTextOf(event);
        if (text !== undefined) this.turnFinalText.set(chatId, text);
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
        const reason = (data as { reason?: { kind?: string } } | undefined)?.reason;
        const kind = reason?.kind;
        const turnNo = typeof data?.turn === "number" ? data.turn : 0;
        let deferred = false;
        if (kind === "completed") {
          const finalText = this.turnFinalText.get(chatId);
          if (finalText !== undefined && finalText.length > 0) {
            this.turnFinalText.delete(chatId);
            // B4：交付结果回填卡片真值——收官延后到 deliver 落地（真值到时才可见）
            deferred = true;
            void this.deliver(chatId, finalText)
              .then(() => {
                this.lastDelivered.add(chatId);
              })
              .catch(() => {
                this.lastFailure.set(chatId, "正式回答发送失败，请查看本条上下消息或重试。");
              })
              .finally(() => {
                void this.finalizeTurn(chatId);
              });
          } else {
            // G3：completed 空文本原静默——GA 同分支发「无法继续完成」通告
            this.turnFinalText.delete(chatId);
            void this.notifyInterrupted(chatId, "unavailable", `${chatId}:${turnNo}:completed-empty`);
          }
        } else {
          this.turnFinalText.delete(chatId);
          const noticeReason = reasonForTurnEnd(String(kind));
          if (noticeReason !== null) {
            this.cancelPending(chatId); // M1：turn 死去，死的 pending 不得以幻影走答允
            this.lastFailure.set(chatId, detailFor(noticeReason));
            void this.notifyInterrupted(chatId, noticeReason, `${chatId}:${turnNo}:${String(kind)}`);
          }
        }
        if (!deferred) void this.finalizeTurn(chatId);
        break;
      }
      default:
        break;
    }
  }

  /**
   * GA app.py:372-395 交付序：正文（剥离 attach marker）→ 产物逐个 upload_file →
   * 交付失败逐条 markdown 通告（同文案:Artifact delivery failed …）。
   */
  async deliver(chatId: string, text: string): Promise<void> {
    try {
      const { cleaned, files, errors } = this.extractArtifacts(text);
      const deliveryErrors = [...errors];
      if (cleaned.length > 0 || files.length === 0) {
        await this.client.sendMarkdownSplit(chatId, cleaned, null, this.cfg.deliverChunks);
      }
      for (const { marker, candidate } of files) {
        const name = basename(candidate);
        // GA ga_runtime.py:281-282：不存在/非常规文件 = missing 措辞（先于任何上传尝试）
        const info = await stat(candidate).catch(() => null);
        if (info === null || !info.isFile()) {
          deliveryErrors.push(`artifact file does not exist: ${marker}`);
          continue;
        }
        try {
          await this.client.uploadFile(chatId, name, await readFile(candidate));
        } catch (error) {
          deliveryErrors.push(`Artifact delivery failed for ${name}: ${String(error)}`);
        }
      }
      for (const failure of deliveryErrors) {
        await this.client
          .sendMarkdownSplit(chatId, failure, null, this.cfg.deliverChunks)
          .catch((error: unknown) => this.logger.warn("[wps-bot] delivery failure notice failed:", error));
      }
    } catch (error) {
      this.logger.error("[wps-bot] deliver failed:", error);
    }
  }

  /**
   * agent/status 事件桥接——全部排队下游的挽救点：
   * （report P0-1 的死锁场景修复）turn/end 迈用时 phase 仍 running；kick.finally 切 idle 时才真正
   * 释放队列；这是必须 drain 的唯一正确时机。
   */
  async handleAgentStatus(agent: unknown, status: string): Promise<void> {
    if (status !== "idle") return;
    const chatId = this.chatForAgentFn(agent);
    if (chatId === null) return;
    await this.finalizeTurn(chatId);
  }

  /**
   * agent/disposed（payload { agent }）：僵尸句柄清理——router.forget 以及 pending/card 也一并取消。
   */
  async handleAgentDisposed(payload: unknown): Promise<void> {
    const agent = (payload as { agent?: unknown } | null | undefined)?.agent;
    if (agent === undefined) return;
    const chatId = this.chatForAgentFn(agent);
    if (chatId === null) return;
    this.router.forget(chatId);
    this.cancelPending(chatId);
    this.turnFinalText.delete(chatId);
    await this.cards.finish(chatId, { delivered: false });
  }

  async finalizeTurn(chatId: string): Promise<void> {
    // N2：drain 表示本次又派发了下轮任务 → 卡片共养续更，只在真苦闲态（无交付+队列空）时收官
    // 注意：turn/end 迈用 phase 可能是 running——drain 拒却不能收，预设 agent/status(idle) 时处理
    const dispatched = await this.router.drain(chatId).catch(() => false);
    if (!dispatched && this.router.queued(chatId) === 0 && !this.router.busy(chatId)) {
      const failure = this.lastFailure.get(chatId);
      this.lastFailure.delete(chatId);
      await this.cards.finish(chatId, { delivered: this.lastDelivered.delete(chatId), failure });
    }
  }

  /**
   * 卸载/重启（G4 对位 GA app.py:run 的 service_stopping 面）：
   *  1. seal：router 拒新 claim；
   *  2. 对在册 chat（队列非空或卡片在途或有 pending）群发 service_stopping（幂等）；
   *  3. pending 回 cancelled；卡片完结；deadline 兜底（config.shutdownDeadlineMs，默认 10s）。
   */
  async shutdown(): Promise<void> {
    this.router.seal();
    const deadlineMs = this.cfg.shutdownDeadlineMs ?? 10_000;
    const work = (async () => {
      for (const chatId of this.router.chatIdsWithWork()) {
        await this.notifyInterrupted(chatId, "service_stopping");
      }
      for (const chatId of [...this.pendings.keys()]) {
        this.cancelPending(chatId);
      }
      await this.cards.finishAll(detailFor("service_stopping")).catch(() => undefined);
    })();
    await Promise.race([work, new Promise((r) => setTimeout(r, deadlineMs))]);
  }

  /** G3：中断通知——模板对位 ga_wps/app.py:430-435；幂等 + 群聊 mention 尽力 + 文案不泄异常串。 */
  async notifyInterrupted(chatId: string, reason: Parameters<typeof interruptionNotice>[0], key?: string): Promise<void> {
    if (!this.interruptionLedger.claim(key ?? `${chatId}:${reason}`)) return;
    const requester = this.sessions.getRequester(chatId);
    const mention =
      requester === undefined
        ? null
        : await this.client.resolveMention(requester.userId, requester.name).catch(() => null);
    try {
      await this.client.sendMarkdownSplit(chatId, interruptionNotice(reason, chatId), mention);
    } catch (error) {
      this.logger.warn("[wps-bot] interruption notice failed:", error);
    }
  }

  pendingCount(): number {
    return this.pendings.size;
  }

  cancelPending(chatId: string): void {
    const pend = this.pendings.get(chatId);
    if (pend === undefined) return;
    pend.resolve({ kind: "cancelled" });
  }

  private waitReply(
    chatId: string,
    userId: string,
    signal?: { aborted: boolean; addEventListener?: (evt: string, cb: () => void) => void },
  ): Promise<ReplyEvent> {
    return new Promise((resolve) => {
      // b3 身份自检：delete 前核对在册条目仍是「我」——老 timer 不得误删新 pending
      const selfDelete = (entry: PendingApproval) => {
        if (this.pendings.get(chatId) === entry) this.pendings.delete(chatId);
      };
      const entry: PendingApproval = {
        userId,
        resolve: (reply) => {
          if ((entry as { settled?: boolean }).settled === true) return; // 迟来答允不得双答（audit/ack 单发）
          (entry as { settled?: boolean }).settled = true;
          clearTimeout(timer);
          if (entry.abortHook) entry.abortHook();
          selfDelete(entry);
          resolve(reply);
        },
        timer: undefined as unknown as NodeJS.Timeout,
      };
      const timer = setTimeout(() => {
        selfDelete(entry);
        resolve({ kind: "timeout" });
      }, this.cfg.approvalTimeoutMs);
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
          const remover = (signal as unknown as { removeEventListener?: (evt: string, cb: () => void) => void })
            .removeEventListener;
          if (typeof remover === "function") {
            remover.call(signal, "abort", onAbort);
          }
        };
      }
      // 同 chatId 有老 pending：先 flush 成 cancelled（避免新质竞老情）
      const old = this.pendings.get(chatId);
      if (old !== undefined) old.resolve({ kind: "cancelled" });
      this.pendings.set(chatId, entry);
    });
  }
}

/** GA approval.py 的群问面提示词（Kubernetes 写作拆掉，本插件不做 K8s 特化）。 */
export function approvalQuestion(review: string, allowWindow: boolean): string {
  const instruction = allowWindow
    ? "回复“同意”仅执行本次；回复“同意5分钟”（分钟数可替换）开启限时自动同意——窗口对本对话中您本人发起的后续所有待确认操作生效。"
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
