/**
 * WPS 通道分诊器（dispatch router）。考古锚点见 docs/references.md。
 */

import type { WpsEvent } from "./protocol.ts";
import type { EventDedup } from "./dedup.ts";
import { parseTaskKey } from "./task-keys.ts";

export interface ChatSessionHandle {
  sessionId: string;
  /** 'running' | 其他（含 undefined）。与 GA is_running()/b7 反转窗对齐时只认 running。 */
  status(): string | undefined;
  /** 落队列：当前排后续任务（DSH agent.followup 语义的宿主映射）。 */
  followup(text: string): Promise<unknown> | unknown;
  /** 注入运行中 turn（DSH agent.inject 语义的宿主映射）；false = 婉拒，落队。 */
  inject(text: string): boolean;
}

export interface QuoteLookup {
  lookup(botMessageId: string): { sessionId: string; chatId: string } | null;
}

export interface RouterOptions {
  dedup: EventDedup;
  /** P0-2 修复：注入唯一持久真源（QuoteRegistry）；缺位再回落内存热件。 */
  quoteLookup?: QuoteLookup;
  /** 为空 chat 构造句柄（首次 direct 消息时宿主建会话）。 */
  ensure: (chatId: string) => Promise<ChatSessionHandle>;
  /** 成功 inject 后的可控 ack（GA app.py:250 的文案语义，宿主决定发不发）。 */
  ackIntervention?: (chatId: string, senderUserId: string, senderName: string) => Promise<void>;
  /** 定制度事实包装；默认 defaultFactify。 */
  /** 事件被真正派发（followup/inject 落地）时通知宿主（requester 追踪/卡片启动）。 */
  onDispatched?: (chatId: string, ev: WpsEvent, route: Exclude<Route, "duplicate" | "drop">) => void;
  /** 在途进度卡 message id → 所属 sessionId（GA accepts_progress_reply 的宿主面；P-C 后注册表为主路）。 */
  quoteTaskOwner?: (quoteMsgId: string) => string | null;
  logger?: { warn(...args: unknown[]): void };
}

export type Route = "inject" | "enqueue" | "duplicate" | "drop";

/** GA：requester/chat 作为本轮事实进模型；evidence 恒定供给（GA run_task 的 live-attachments 语用）。 */
export function defaultFactify(ev: WpsEvent): string {
  // 防幻觉固定行：上下文面见历史（story R2）——工具代替沉默（P-D 后）
  const head =
    `[WPS 任务 | chat ${ev.chatType || "group"}/${ev.chatId} | requester ${ev.senderName}(${ev.senderId})]` +
    "\n注意：你的直接上下文不含本对话的旧聊天（尤其你入群前的）；要翻历史就调 search_wps_history，不要编造。";
  const parts: string[] = [];
  // GA live-attachments：已落盘附件给模型可读路径（materialize 先于分发并完成注入）
  for (const a of ev.attachments) {
    parts.push(a.localPath ? `附件 ${a.name || a.kind} → ${a.localPath}` : `附件 ${a.name || a.kind}（未落盘）`);
    // A6-P0 明示降级：图片未进视觉链路（v1 不透传）——模型须明示“看不到图”
    if (a.kind === "image") {
      parts.push("注意：上述图片内容未进入视觉链路，仅有文件路径可用；不得声称看到了图。");
    }
  }
  for (const obs of ev.observations) parts.push(obs);
  if (ev.cloudDocLinks.length > 0) parts.push(`云文档 ${ev.cloudDocLinks.join(" ")}`);
  if (ev.unparsed.length > 0) parts.push(`未解析节点 ×${ev.unparsed.length}（非文本证据消息）`);
  const body = ev.text.trim();
  const summary = parts.join("\n");
  if (body.length > 0) return `${head}\n\n${body}${summary ? `\n\n${summary}` : ""}`;
  return `${head}\n\n${summary || "（无文本）"}`;
}

export interface TaskState {
  /** 任务会话键：`wps-bot:<chatId>:<ownerId>:<taskId>`（task-keys.ts）。 */
  sessionId: string;
  chatId: string;
  ownerId: string;
  ownerName: string;
  participants: Array<{ userId: string; name: string }>;
  /** ensure 在途旗：findOwnRunning 的活判据之一。 */
  ensuring?: boolean;
  handle?: ChatSessionHandle;
}

export class WpsRouter {
  private readonly opts: RouterOptions;
  private readonly tasks = new Map<string, TaskState>();
  private readonly queues = new Map<string, WpsEvent[]>();

  constructor(opts: RouterOptions) {
    this.opts = opts;
  }

  /**
   * 事件入口。调用者已 dedup.claim 过的场景（如 WpsBotCore 先查审批再分发）传 { preClaimed: true }，
   * 本路由跳过重复 claim，只负责 route → record/release 联锁；普通直接调用 route 自带全量幂等闸。
   */
  async handleEvent(ev: WpsEvent, opts: { preClaimed?: boolean } = {}): Promise<Route> {
    if (!opts.preClaimed && !this.opts.dedup.claim(ev.eventId)) return "duplicate";
    let accepted = false;
    try {
      const route = await this.route(ev);
      if (route !== "drop") {
        // E2：record 失败不得标 accepted——finally successful release，回放重试优于静默丢幂等位
        await this.opts.dedup.record(ev.eventId);
        accepted = true;
      }
      return route;
    } finally {
      if (!accepted) this.opts.dedup.release(ev.eventId);
    }
  }

  /** P-C 路由（GA app.py:206-232 优先级对位+用户定稿裁决）：pending 外侧已消费；此处：
   *  1. quote 命中注册表/在册任务 → 目标任务（inject 或落队）
   *  2. 未 direct（群非@且未命中）→ drop
   *  3. 本人 running 任务 → inject（无证据）或落队
   *  4. 否则 → 新任务（taskId=根消息 eventId，owner=sender）
   */
  /** 路由前嗅探：返回 intend 的 sessionId（不落队）——materialize 需目标任务盘。 */
  previewTarget(ev: WpsEvent): string | null {
    if (ev.quoteMsgId.length > 0) {
      const inherited = this.lookupQuote(ev.quoteMsgId, ev.chatId);
      if (inherited !== null) return inherited.sessionId;
      const cardOwner = this.opts.quoteTaskOwner?.(ev.quoteMsgId);
      const cardTask = cardOwner !== undefined && cardOwner !== null ? (this.tasks.get(cardOwner)?.handle?.status() === "running" ? this.tasks.get(cardOwner) : undefined) : undefined;
      if (cardTask !== undefined && cardTask !== null) return cardTask.sessionId;
    }
    if (!ev.isPrivate && !ev.mentioned) return null;
    const own = this.findOwnRunning(ev.chatId, ev.senderId);
    if (own !== null) return own.sessionId;
    return `wps-bot:${ev.chatId}:${ev.senderId}:${ev.eventId}`;
  }

  private async route(ev: WpsEvent): Promise<Route> {
    // 1) quote 继承
    if (ev.quoteMsgId.length > 0) {
      const inherited = this.lookupQuote(ev.quoteMsgId, ev.chatId);
      if (inherited !== null) {
        if (inherited.ownerId !== ev.senderId && !inherited.participants.some((p) => p.userId === ev.senderId)) {
          inherited.participants.push({ userId: ev.senderId, name: ev.senderName });
        }
        return this.dispatchToTask(inherited, ev);
      }
      // in-flight 进度卡 quote 的 GA 特殊面：命中在跑任务时按 inject 走
      const cardOwner = this.opts.quoteTaskOwner?.(ev.quoteMsgId);
      const cardTask0 = cardOwner !== undefined && cardOwner !== null ? this.tasks.get(cardOwner) : undefined;
      if (cardTask0 !== undefined && cardTask0.chatId === ev.chatId && cardTask0.handle?.status() === "running") {
        const task = cardTask0;
        if (task !== undefined) return this.dispatchToTask(task, ev);
      }
    }
    const direct = ev.isPrivate || ev.mentioned;
    if (!direct) return "drop";

    // 2) 本人 running 任务（同 chat 最新一个）
    const own = this.findOwnRunning(ev.chatId, ev.senderId);
    if (own !== null && !ev.evidenceBearing) {
      return this.dispatchToTask(own, ev);
    }
    if (own !== null) return this.enqueueTo(own, ev);

    // 3) 新任务
    const fresh = this.createTask(ev.chatId, ev.senderId, ev.senderName, ev.eventId);
    return this.enqueueTo(fresh, ev);
  }

  /** quote 参照：先查询唯一持久真源（task 在册则返回；不在册=会话已废→null，按 new task 走）
   *  落底：registry 未注入时查热件 outboundIds（兼容单测路径）。 */
  /** 注册表命中但任务不在册（重启后/会话已裁）→ 从键义重立任务状态（resume 会话来路） */
  private reviveTask(sessionId: string): TaskState | null {
    const parts = parseTaskKey(sessionId);
    if (parts === null) return null;
    const { chatId, ownerId, taskId } = parts;
    this.opts.logger?.warn(`[wps-bot] 引用继承 revive 旧任务会话 ${sessionId}`);
    return this.createTask(chatId, ownerId, ownerId, taskId);
  }

  private lookupQuote(quoteMsgId: string, eventChatId?: string): TaskState | null {
    const regHit = this.opts.quoteLookup?.lookup(quoteMsgId);
    if (regHit === null || regHit === undefined) return null;
    // A2-1：跨 chat 引用不接——命中 chat 与事件 chat 必须一致
    if (eventChatId !== undefined && regHit.chatId !== eventChatId) return null;
    return this.tasks.get(regHit.sessionId) ?? this.reviveTask(regHit.sessionId);
  }


  /** 同 owner 的活任务：在跑或队列非空（连续消息同任务——P0-4/P-C 用户定稿「连续@→当前任务下一轮」）。 */
  findOwnRunning(chatId: string, ownerId: string): TaskState | null {
    let found: TaskState | null = null;
    for (const [sessionId, task] of this.tasks) {
      if (task.chatId !== chatId || task.ownerId !== ownerId) continue;
      if (task.ensuring === true || task.handle?.status() === "running" || (this.queues.get(sessionId)?.length ?? 0) > 0) found = task;
    }
    return found;
  }

  createTask(chatId: string, ownerId: string, ownerName: string, taskId: string): TaskState {
    const sessionId = `wps-bot:${chatId}:${ownerId}:${taskId}`;
    let state = this.tasks.get(sessionId);
    if (state === undefined) {
      state = { sessionId, chatId, ownerId, ownerName, participants: [] };
      this.tasks.set(sessionId, state);
    }
    return state;
  }

  getTask(sessionId: string): TaskState | undefined {
    return this.tasks.get(sessionId);
  }
  getOwner(sessionId: string): { userId: string; name: string } | undefined {
    const task = this.tasks.get(sessionId);
    return task === undefined ? undefined : { userId: task.ownerId, name: task.ownerName };
  }

  private dispatchToTask(task: TaskState, ev: WpsEvent): Promise<Route> {
    const handle = task.handle;
    if (handle?.status() === "running" && !ev.evidenceBearing) {
      if (handle.inject(defaultFactify(ev))) {
        void this.opts.ackIntervention?.(task.chatId, ev.senderId, ev.senderName).catch(() => undefined);
        this.opts.onDispatched?.(task.sessionId, ev, "inject");
        return Promise.resolve("inject" as Route);
      }
    }
    return this.enqueueTo(task, ev);
  }

  private async enqueueTo(task: TaskState, ev: WpsEvent): Promise<Route> {
    const queue = this.queues.get(task.sessionId) ?? [];
    queue.push(ev);
    this.queues.set(task.sessionId, queue);
    await this.drain(task.sessionId);
    return "enqueue";
  }

  async drain(sessionId: string): Promise<boolean> {
    const task = this.tasks.get(sessionId);
    if (task === undefined || task.ensuring === true) return false; // A2-5：在途 ensure 不再双开
    const handle = task.handle;
    if (handle && handle.status() === "running") return false;
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) return false;
    const next = queue[0];
    if (next === undefined) return false;
    let target = handle;
    if (target === undefined) {
      // A2-2：ensure 先成功后 shift——失败保队首不丢
      task.ensuring = true;
      try {
        target = await this.opts.ensure(sessionId);
        task.handle = target;
      } catch (error) {
        this.opts.logger?.warn(`[wps-bot] ensure failed, 队首保留: ${String(error)}`);
        return false;
      } finally {
        task.ensuring = false;
      }
    }
    queue.shift();
    try {
      this.opts.onDispatched?.(sessionId, next, "enqueue");
      await target.followup(defaultFactify(next));
      return true;
    } catch (error) {
      // A2-3：followup 失败回队首不抛——防 dedup release + 队列副本双轨
      queue.unshift(next);
      this.opts.logger?.warn(`[wps-bot] followup failed, requeued in front: ${String(error)}`);
      return false;
    }
  }

  /** G4：shutdown 通知枚举面——队列非空或会话在跑的在册 sessionId。 */
  sessionIdsWithWork(): string[] {
    const out: string[] = [];
    for (const [sessionId, task] of this.tasks) {
      if (task.handle?.status() === "running" || (this.queues.get(sessionId)?.length ?? 0) > 0) out.push(sessionId);
    }
    return out;
  }

  /** 会话内是否还有待办（卡片/审批计时器等效观察）。 */
  queued(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0;
  }

  entries(): IterableIterator<[string, TaskState]> {
    return this.tasks.entries();
  }

  private sealed = false;

  /** G4：shutdown 首幕——封路后 claimLock 恒败（新事件一律不再入场）。 */
  seal(): void {
    this.sealed = true;
  }
  get isSealed(): boolean {
    return this.sealed;
  }

  /** 幂等三件套（approval reply 路线与 dispatch 路线共享 seen_events） */
  claimLock(eventId: string): boolean {
    if (this.sealed) return false;
    return this.opts.dedup.claim(eventId);
  }
  async recordAcceptance(eventId: string): Promise<boolean> {
    return this.opts.dedup.record(eventId);
  }
  releaseAcceptance(eventId: string): void {
    this.opts.dedup.release(eventId);
  }

  /** 会话句柄报告忙闲（GA: session.is_running()）。 */
  busy(sessionId: string): boolean {
    return this.tasks.get(sessionId)?.handle?.status() === "running";
  }

  /** 宿主会话报错/中止的路径：把手柄从在册清出。 */
  /** A2-9：forget 必须清队——处置后已 record 的排队事件不成孤儿（保守参与者也清） */
  forget(sessionId: string): void {
    this.tasks.delete(sessionId);
    this.queues.delete(sessionId);
  }
}
