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
import { appendFile as appendFileSafe, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname as pathDirname, join, resolve, sep } from "node:path";

import { WpsClient, type Mention } from "./client.ts";
import { ProgressCards } from "./card.ts";
import { ApprovalWindowStore, parseConsent, windowAllows } from "./consent.ts";
import { appendApprovalAudit, autoAllowEntry, type ApprovalAuditEntry } from "./audit.ts";
import { detailFor, InterruptionLedger, interruptionNotice, reasonForTurnEnd } from "./notify.ts";
import { EvidenceStore } from "./evidence.ts";
import { QuoteRegistry } from "./quote-registry.ts";
import { parseTaskKey } from "./task-keys.ts";
import { HistoryStore } from "./history.ts";
import { TaskDeliveryService, safeArtifactName, taskRootOf } from "./task-delivery.ts";
import { TaskApprovalService } from "./task-approval.ts";
import { ACK_APPROVED, ACK_APPROVED_NO_WINDOW, ACK_DECLINED, ACK_TIMEOUT, ackApprovedWindow, allowsWindowForReason, type ReplyEvent } from "./task-approval.ts";
import type { EventDedup } from "./dedup.ts";
import type { WpsEvent } from "./protocol.ts";
import { WpsRouter, type ChatSessionHandle, type Route } from "./task-router.ts";

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

/** GA history.attachment_target 的文件名净化：unicode 字母数字 + . _ -，其余 _，截 160。 */

export { ACK_APPROVED, ACK_APPROVED_NO_WINDOW, ACK_DECLINED, ACK_TIMEOUT, ackApprovedWindow } from "./task-approval.ts";

export interface ApprovalRequestLike {
  agent?: unknown;
  toolName?: string;
  callId?: string;
  reason?: string;
  signal?: { aborted: boolean };
}
export type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";

export type { ReplyEvent } from "./task-approval.ts";

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
    /** 引用继承注册 table 档（默认 workspaceRoot/quote-registry.jsonl；null=内存态）。 */
    quoteRegistryPath?: string | null;
    /** 严格完结契约（PROJECT.md 契约案）：true=无 finish_task 不落交付而送「unavailable」；false=宽松回落末条文本。 */
    strictFinishContract?: boolean;
  };
}

/** GA ga_handler.py:146：reason 前缀 [gate-source=fail_closed] 一律不开窗。 */
export { allowsWindowForReason } from "./task-approval.ts";



export class WpsBotCore {
  private readonly client: BotClient;
  private readonly logger: CoreLogger;
  private readonly sessions: BotSessions;
  private readonly chatForSessionIdFn: (id: string) => string | null;
  private readonly chatForAgentFn: (agent: unknown) => string | null;
  private readonly cfg: CoreBotOptions["config"];

  readonly router: WpsRouter;
  readonly cards: ProgressCards;
  /** 当轮最高一个含 text 的 assistant 消息正文（GA terminal response 的最后一条）。 */
  private readonly turnFinalText = new Map<string, string>();
  /** F4：同 chatId 的 ensure 单飞：两条并发 direct 并发只建一份会话句柄。 */
  private readonly pendingEnsures = new Map<string, Promise<ChatSessionHandle>>();
  private readonly approvals: TaskApprovalService;
  private history!: HistoryStore;
  private readonly windows = new ApprovalWindowStore();
  private readonly interruptionLedger = new InterruptionLedger();
  private evidenceStore: EvidenceStore | null = null;
  private quoteRegistryStore: QuoteRegistry | null = null;
  get quoteRegistry(): QuoteRegistry {
    this.quoteRegistryStore ??= new QuoteRegistry(
      this.cfg.quoteRegistryPath ?? `${this.cfg.workspaceRoot}/quote-registry.jsonl`,
    );
    return this.quoteRegistryStore;
  }
  private get evidence(): EvidenceStore {
    this.evidenceStore ??= new EvidenceStore(this.cfg.workspaceRoot);
    return this.evidenceStore;
  }
  private readonly lastDelivered = new Set<string>();
  private readonly lastFailure = new Map<string, string>();
  private readonly finishDeliverable = new Map<string, { text: string; turn: number }>();
  private readonly repliedTurn = new Map<string, number>();
  private readonly currentTurn = new Map<string, number>();

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
      onSent: (sessionId: string, chatId: string, messageId: string) =>
        this.registerOutboundIds(sessionId, chatId, [messageId]),
      logger: this.logger,
    });

    this.router = new WpsRouter({
      dedup: opts.dedup,
      quoteLookup: this.quoteRegistry,
      // 改 buildCore：抱抱 chorine 整座 ensure 调用一个 p-cycle 的单飞避免并发创两次会话（报告 P0-4）
      ensure: (chatId) => this.singleFlightEnsure(chatId),
      // GA accepts_progress_reply：quote == 在途进度卡 id 且会话在跑
      quoteTaskOwner: (quoteMsgId) => this.cards.sessionIdOfMessage(quoteMsgId),

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
      onDispatched: (sessionId, ev, route) => {
        // P-C：requester=最近触发路由者（audit 三元组的 requesterUserId 源）；
        // 审批权归属走 owner+participants 集合（any-of），不回写 requester 权。
        if (route === "enqueue") {
          this.sessions.setRequester(sessionId, { userId: ev.senderId, name: ev.senderName });
        }
        if (this.cards.hasActive(sessionId)) return;
        this.cards.start(sessionId, ev.chatId);
      },
      logger: { warn: (...args: unknown[]) => this.logger.warn(...args) },
    });
    this.approvals = new TaskApprovalService({
      approvalMode: this.cfg.approvalMode,
      approvalTimeoutMs: this.cfg.approvalTimeoutMs,
      allowWindow: this.cfg.allowWindow,
      auditPath: this.cfg.auditPath,
      client: opts.client,
      router: this.router,
      sessions: opts.sessions,
      cards: this.cards,
      chatForAgent: opts.chatForAgent,
      logger: opts.logger,
    });
    this.history = new HistoryStore(this.cfg.workspaceRoot);
    this.delivery = new TaskDeliveryService({
      deliverChunks: this.cfg.deliverChunks,
      workspaceRoot: this.cfg.workspaceRoot,
      client: opts.client,
      logger: opts.logger,
      registerOutboundIds: (sessionId, chatId, ids) => this.registerOutboundIds(sessionId, chatId, ids),
    });
  }

  /** P0-2/P-C：启动期载入持久注册面——引用继承必须跨重启成立。 */
  async loadRegistry(): Promise<void> {
    await this.quoteRegistry.load();
  }

  /**
   * WPS 事件入口：先 answerer dedup（避免 WPS 重投让审批路径绕过幂等判据）→ pending 原子消费→ router。
   * 已 accepted 的回复不会被二次计当（已被 record 过的事件重归时 rejective duplicate）。
   */
  async handleIncomingEvent(ev: WpsEvent): Promise<Route | "approval-reply" | "duplicate"> {
    if (!this.router.claimLock(ev.eventId)) return "duplicate"; // 幂等均垫
    // P-D：群历史读开底账——inbound 全件归档（含 drop；检索工具唯一数据源）
    void this.history.record(ev).catch((error) => this.logger.warn("[wps-bot] history 落盘失败:", error));
    // 审批答允（any-of）：pending 允集(owner∪participants)含发送者且同 chat → 原子消费
    const sameChat = (sessionId: string) => (parseTaskKey(sessionId)?.chatId ?? sessionId) === ev.chatId;
    if (this.approvals.tryConsume(ev, sameChat) !== null) {
      await this.router.recordAcceptance(ev.eventId).then(
        () => undefined,
        (error) => {
          this.router.releaseAcceptance(ev.eventId);
          throw error;
        },
      );
      return "approval-reply";
    }
    // user-questions 答允面：quote 命中在期问题 → 消费作答，不进任务路由
    if (await this.questionsConsume(ev, sameChat)) {
      await this.router.recordAcceptance(ev.eventId).then(() => undefined, (error) => { this.router.releaseAcceptance(ev.eventId); throw error; });
      return "approval-reply";
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
  private readonly delivery: TaskDeliveryService;

  private readonly questionPendings = new Map<string, {
    userId: string;
    messageIds: string[];
    resolve: (answer: string) => void;
    cancel: (reason: Error) => void;
  }>();


  /** user-questions 通道代答实现（P-C 后回并自 task-questions.ts——星型依赖实证）。 */
  private async questionsImpl(request: {
    questions: Array<{ id: string; question: string; detail?: string; header?: string; options?: Array<{ label: string }> }>;
    agent?: unknown;
    signal?: { aborted: boolean; addEventListener?: (evt: string, cb: () => void) => void };
  }): Promise<{ answers: Array<{ id: string; selected: string[]; custom?: string }> }> {
    const agentLike = request.agent as { session?: { id?: unknown } } | undefined;
    const sessionId = String(agentLike?.session?.id ?? "");
    const parsedKey = parseTaskKey(sessionId);
    const chatId = parsedKey !== null ? parsedKey.chatId : this.chatForAgentFn(request.agent);
    if (chatId === null) {
      const e = new Error("wps-bot: 无从落聊的租答请求");
      (e as { code?: string }).code = "NO_CHAT_BINDING";
      throw e;
    }
    const requester = this.sessions.getRequester(sessionId);
    const parts: string[] = ["## 需要你的回答"];
    request.questions.forEach((q, index) => {
      parts.push(`**${q.header ?? `问题 ${index + 1}/${request.questions.length}`}**

${q.question}`);
      if (q.detail) parts.push(q.detail);
      if (q.options !== undefined && q.options.length > 0) {
        parts.push(q.options.map((option, i) => `${i + 1}) ${option.label}`).join("  "));
      }
    });
    parts.push("回复本条（引用）+ 你的答案：序号/选项名/自由文本均可。");
    const mention =
      requester === undefined
        ? null
        : await this.client.resolveMention(requester.userId, requester.name).catch(() => null);
    const messageIds = await this.client.sendMarkdownSplit(chatId, parts.join('\n\n'), mention);

    if (request.signal?.aborted === true) {
      const e0 = new Error("wps-bot: 租答请求遭中止");
      (e0 as { code?: string }).code = "ASK_ABORTED";
      throw e0;
    }
    const text = await new Promise<string>((resolve, reject) => {
      const selfDelete = (entry: (typeof this.questionPendings) extends Map<string, infer V> ? V : never) => {
        if (this.questionPendings.get(sessionId) === entry) this.questionPendings.delete(sessionId);
      };
      const entry: { userId: string; messageIds: string[]; resolve: (answer: string) => void; cancel: (reason: Error) => void } = {
        userId: requester?.userId ?? "",
        messageIds,
        resolve: (answer) => {
          if ((entry as { settled?: boolean }).settled === true) return;
          (entry as { settled?: boolean }).settled = true;
          selfDelete(entry);
          resolve(answer);
        },
        cancel: (reason) => {
          if ((entry as { settled?: boolean }).settled === true) return;
          (entry as { settled?: boolean }).settled = true;
          selfDelete(entry);
          reject(reason);
        },
      };
      if (requester === undefined) { entry.cancel(new Error("wps-bot: 无从知位相相者")); return; }
      const oldEntry = this.questionPendings.get(sessionId);
      if (oldEntry !== undefined) oldEntry.cancel(Object.assign(new Error("wps-bot: 新问件覆盖了旧问相答允"), { code: "ASK_OVERRIDDEN" }));
      this.questionPendings.set(sessionId, entry);
      if (request.signal?.addEventListener) {
        const onAbort = () => {
          const e = new Error("wps-bot: 租答请求遭中止");
          (e as { code?: string }).code = "ASK_ABORTED";
          entry.cancel(e);
        };
        request.signal.addEventListener("abort", onAbort);
        const withRemoval = <A,>(fn: (arg: A) => void) => (arg: A) => {
          const remover = (request.signal as unknown as { removeEventListener?: (evt: string, cb: () => void) => void }).removeEventListener;
          if (typeof remover === "function") remover.call(request.signal, "abort", onAbort);
          fn(arg);
        };
        entry.resolve = withRemoval(entry.resolve);
        entry.cancel = withRemoval(entry.cancel);
      }
    });

    return {
      answers: request.questions.map((q, index) => {
        const hit = q.options?.find((o, i) => text === String(i + 1) || text === o.label);
        if (index !== 0) return { id: q.id, selected: [] as string[] };
        return hit !== undefined ? { id: q.id, selected: [hit.label] } : { id: q.id, selected: [] as string[], custom: text };
      }),
    };
  }

  /** 消费 quote-答允（消费成མ retry) */
  private questionsConsume(ev: WpsEvent, sameChat: (sessionId: string) => boolean): Promise<boolean> {
    for (const [sessionId, question] of this.questionPendings) {
      if (!sameChat(sessionId) || question.userId !== ev.senderId || !question.messageIds.includes(ev.quoteMsgId)) continue;
      question.resolve(ev.text.trim());
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }

  /** 全域取消（shutdown 面）。 */
  private questionsCancelAll(reason: Error): void {
    for (const [, question] of [...this.questionPendings]) question.cancel(reason);
    this.questionPendings.clear();
  }

  /** P-D 搜索面（转 HistoryStore）。 */
  searchHistory(chatId: string, query: string, limit?: number) {
    return this.history.search(chatId, query, limit);
  }

  /** 审批 answerer prepend（转 TaskApprovalService）。 */
  async handleApprovalRequest(
    req: import("./task-approval.ts").ApprovalRequestLike,
    next: () => Promise<import("./task-approval.ts").ApprovalOutcome>,
  ): Promise<import("./task-approval.ts").ApprovalOutcome> {
    return this.approvals.handle(req, next);
  }

  /** user-questions 通道代答（回并自 task-questions.ts）。 */
  askUserQuestion(request: { questions: Array<{ id: string; question: string; detail?: string; header?: string; options?: Array<{ label: string }> }>; agent?: unknown; signal?: { aborted: boolean; addEventListener?: (evt: string, cb: () => void) => void } }): Promise<{ answers: Array<{ id: string; selected: string[]; custom?: string }> }> {
    return this.questionsImpl(request);
  }

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

  /** GA:339 落盘序——downloads/{sha256(eventId)[:12]}/{NN}_{safeName|kind}；逐件容错进 observations。 */
  /** P0-2+A2-7：出站 id 单源登记——registry 唯一真源（热件在 lookupQuote 已衰双轨后不再白写；失败告警不静监） */
  private registerOutboundIds(sessionId: string, chatId: string, ids: string[]): void {
    if (ids.length === 0) return;
    this.quoteRegistry.register(ids, sessionId, chatId).catch((error) => {
      this.logger.warn("[wps-bot] quoteRegistry 登记失败:", error);
    });
  }

  private async materializeAttachments(ev: WpsEvent): Promise<void> {
    const withKey = ev.attachments.filter((a) => a.storageKey);
    if (withKey.length === 0) return;
    // P-C：task 写作隔离 —— downloads 落在目标任务工作区；会话未建时回根任务键
    const taskKey = this.router.previewTarget(ev) ?? `wps-bot:${ev.chatId}:${ev.senderId}:${ev.eventId}`;
    const digest = createHash("sha256").update(ev.eventId, "utf8").digest("hex").slice(0, 12);
    const dir = join(taskRootOf(this.cfg.workspaceRoot, taskKey), "downloads", digest);
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

  /** ga_runtime.py:272-289 [[attach:]]：artifacts 根内现存文件；违规/缺失记 errors；marker 剥离。 */
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
        const tNo = (data as { turn?: number } | undefined)?.turn;
        if (typeof tNo === "number") this.currentTurn.set(chatId, tNo);
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
          const registeredRaw = this.finishDeliverable.get(chatId);
          // Z2-D：finish 按 turn 定界——跨轮不消费、只留下Cleanup
          const registered = registeredRaw !== undefined && registeredRaw.turn === turnNo ? registeredRaw.text : undefined;
          if (registeredRaw !== undefined) this.finishDeliverable.delete(chatId);
          const skipFallback = this.repliedTurn.get(chatId) === (this.currentTurn.get(chatId) ?? 0) && this.repliedTurn.has(chatId);
          const finalText = registered ?? (skipFallback ? undefined : this.turnFinalText.get(chatId));
          if (
            this.cfg.strictFinishContract === true &&
            registered === undefined &&
            this.repliedTurn.get(chatId) !== (this.currentTurn.get(chatId) ?? 0)
          ) {
            // 严格完结：无 finish_task 不落交付——显式通告（审计面外发）
            this.turnFinalText.delete(chatId);
            void this.notifyInterrupted(chatId, "unavailable", `${chatId}:${turnNo}:strict-finish-per-contract`);
          } else if (this.repliedTurn.get(chatId) === (this.currentTurn.get(chatId) ?? 0)) {
            // reply 已交：宽松模式不再补发结束通告（interruptionNotice 属未交付语义）
            this.turnFinalText.delete(chatId);
          } else if (finalText !== undefined && finalText.length > 0) {
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
          this.finishDeliverable.delete(chatId); // Z2-D：非 completed 也清 finish 登记（跨轮伪装不入）
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

  /** GA app.py:372-395 交付序：正文→产物逐个 upload→失败逐条 markdown 通告。 */
  /** 交付出发（转 TaskDeliveryService）。 */
  deliver(sessionId: string, text: string): Promise<void> {
    return this.delivery.deliver(sessionId, text);
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
      const notifChatIds = new Set<string>();
      for (const sessionId of this.router.sessionIdsWithWork()) {
        const parts = sessionId.split(":");
        const chatId = parts[1] ?? sessionId;
        if (notifChatIds.has(chatId)) continue;
        notifChatIds.add(chatId);
        await this.notifyInterrupted(chatId, "service_stopping");
      }
      this.approvals.cancelAll(new Error("wps-bot: service stopping"));
      this.questionsCancelAll(Object.assign(new Error("wps-bot: 服务已关闭或正在重启"), { code: "ASK_ABORTED" }));
      await this.cards.finishAll(detailFor("service_stopping")).catch(() => undefined);
      // history 是 fire-and-forget 接力链：不排空，shutdown 返回后仍有卡在 mkdir/appendFile 之间的写（测试 ENOTEMPTY 实证）。
      await this.history.drain().catch(() => undefined);
    })();
    await Promise.race([work, new Promise((r) => setTimeout(r, deadlineMs))]);
  }

  /** G3：中断通知——模板对位 ga_wps/app.py:430-435；幂等 + 群聊 mention 尽力 + 文案不泄异常串。 */
  /** Y2-5 姊妹路：入参总能是 sessionKey——receiver 一律经同一 parse 缝。 */
  async notifyInterrupted(chatId: string, reason: Parameters<typeof interruptionNotice>[0], key?: string): Promise<void> {
    if (!this.interruptionLedger.claim(key ?? `${chatId}:${reason}`)) return;
    const requester = this.sessions.getRequester(chatId);
    const mention =
      requester === undefined
        ? null
        : await this.client.resolveMention(requester.userId, requester.name).catch(() => null);
    try {
      const displayChatId = parseTaskKey(chatId)?.chatId ?? chatId;
      await this.client.sendMarkdownSplit(displayChatId, interruptionNotice(reason, displayChatId), mention);
    } catch (error) {
      this.logger.warn("[wps-bot] interruption notice failed:", error);
    }
  }

  /** finish_task 工具登记终态交付件（turn/end completed 时优先交付；宽松默认仍留回落面）。 */
  /** Z2-D：finish 按 turn 定界——登记携当前轮；跨轮消费=空账，非 completed 的 turn/end 行清账。 */
  noteFinishTask(chatId: string, text: string): void {
    this.finishDeliverable.set(chatId, { text, turn: this.currentTurn.get(chatId) ?? 0 });
  }

  /** reply 工具即时发群 + 标记本 turn 已答复（末态文本不再重发）。 */
  async noteReply(chatId: string, text: string): Promise<void> {
    this.repliedTurn.set(chatId, this.currentTurn.get(chatId) ?? 0);
    await this.client.sendMarkdownSplit(parseTaskKey(chatId)?.chatId ?? chatId, text, null, this.cfg.deliverChunks);
  }

  pendingCount(): number {
    return this.approvals.count;
  }

  cancelPending(chatId: string): void {
    this.approvals.cancel(chatId);
  }


}

export { approvalQuestion } from "./task-approval.ts";


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
