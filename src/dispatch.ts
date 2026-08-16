/**
 * WPS 通道分诊器（dispatch router）。
 *
 * 逐行迁移 ksbot_ga/src/ga_wps/app.py 的核心分诊语义：
 *  - 幂等 claim/record/release（dedup.ts 同款 seen_events 定式）
 *  - 卡片/回复 gate：quote 命中进行中任务且非 direct → 丢弃；
 *    未 @ 且未引用最近任务的群消息 → 丢弃（GA：普通未 @ 群消息不进模型）
 *  - direct + 运行中 + 无 evidence → 注入当轮（GA intervention seam）+ ack；
 *    evidence_bearing（附件/云文档/shared_doc_ids/unparsed）永不走注入，一律落队
 *  - 落队按 chat FIFO；同 chat 串行、跨 chat 并行（GA _drain_chat 同构）
 *  - requester/chat 作为本轮事实进模型；event id 不入模型
 *
 * 不依赖 cordis / dsh-*：session 抽象由宿主注入（dsh-wps-bot/index.ts 转化为 agent.followup/inject）。
 *
 * @module dsh-wps-bot/dispatch
 */

import type { WpsEvent } from "./protocol.ts";
import type { EventDedup } from "./dedup.ts";

export interface ChatSessionHandle {
  sessionId: string;
  /** 'running' | 其他（含 undefined）。与 GA is_running()/b7 反转窗对齐时只认 running。 */
  status(): string | undefined;
  /** 落队列：当前排后续任务（DSH agent.followup 语义的宿主映射）。 */
  followup(text: string): Promise<unknown> | unknown;
  /** 注入运行中 turn（DSH agent.inject 语义的宿主映射）；false = 婉拒，落队。 */
  inject(text: string): boolean;
}

export interface RouterOptions {
  dedup: EventDedup;
  /** 为空 chat 构造句柄（首次 direct 消息时宿主建会话）。 */
  ensure: (chatId: string) => Promise<ChatSessionHandle>;
  /** 成功 inject 后的可控 ack（GA app.py:250 的文案语义，宿主决定发不发）。 */
  ackIntervention?: (chatId: string, senderUserId: string, senderName: string) => Promise<void>;
  /** 定制度事实包装；默认 defaultFactify。 */
  /** 事件被真正派发（followup/inject 落地）时通知宿主（requester 追踪/卡片启动）。 */
  onDispatched?: (chatId: string, ev: WpsEvent, route: Exclude<Route, "duplicate" | "drop">) => void;
  /** GA accepts_progress_reply：quote 命中在途进度卡 message id（busy 时才成立）。 */
  isProgressReply?: (ev: WpsEvent, busy: boolean) => boolean;
  logger?: { warn(...args: unknown[]): void };
}

export type Route = "inject" | "enqueue" | "duplicate" | "drop";

/** GA：requester/chat 作为本轮事实进模型；evidence 恒定供给（GA run_task 的 live-attachments 语用）。 */
export function defaultFactify(ev: WpsEvent): string {
  // A3-P0 防幻觉固定行：入群前历史对模型不可见——事实进模型，规则防编造
  const head =
    `[WPS 任务 | chat ${ev.chatType || "group"}/${ev.chatId} | requester ${ev.senderName}(${ev.senderId})]` +
    "\n注意：bot 入群前的历史对你不可见；问到就明说，不要编造。";
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

export class WpsRouter {
  private readonly opts: RouterOptions;
  private readonly handles = new Map<string, ChatSessionHandle>();
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

  private async route(ev: WpsEvent): Promise<Route> {
    const handle = this.handles.get(ev.chatId);
    const busy = handle?.status() === "running";
    // GA：direct = isPrivate || mentioned || (quote == 在途进度卡 message id 且会话在跑)
    const progressReply = this.opts.isProgressReply?.(ev, busy) ?? false;
    const direct = ev.isPrivate || ev.mentioned || progressReply;
    const evidence = ev.evidenceBearing;

    if (handle && direct && busy && !evidence) {
      // GA：运行中收到明确引用/私聊/@ → 复用原生 intervention seam 补充当前用户事实
      if (handle.inject(defaultFactify(ev))) {
        // ack 失败不阻止 accepted：inject 已成功，重发只会重复注入
        await this.opts.ackIntervention?.(ev.chatId, ev.senderId, ev.senderName).catch(() => undefined);
        this.opts.onDispatched?.(ev.chatId, ev, "inject");
        return "inject";
      }
      return this.enqueue(ev);
    }
    // 未 @、非私聊、未引用进行中任务的群消息 → 丢弃，不进模型
    if (!direct) return "drop";
    return this.enqueue(ev);
  }

  /** 同 chat FIFO 落队 + 空闲立刻派发。 */
  private async enqueue(ev: WpsEvent): Promise<"enqueue"> {
    const queue = this.queues.get(ev.chatId) ?? [];
    queue.push(ev);
    this.queues.set(ev.chatId, queue);
    await this.drain(ev.chatId);
    return "enqueue";
  }

  /** 同 chat 串行：仅在会话空闲时吐出队首一条。会话空闲事件由宿主调用本方法。
   *  @returns true = 本逼交涉成功出队并投递（finalizeTurn 靠它决定是否算作「还有活任务」）
   */
  async drain(chatId: string): Promise<boolean> {
    const handle = this.handles.get(chatId);
    if (handle && handle.status() === "running") return false;
    const queue = this.queues.get(chatId);
    if (!queue || queue.length === 0) return false;
    const next = queue.shift();
    if (next === undefined) return false;
    let target = handle;
    if (target === undefined) {
      target = await this.opts.ensure(chatId);
      this.handles.set(chatId, target);
    }
    try {
      this.opts.onDispatched?.(chatId, next, "enqueue");
      await target.followup(defaultFactify(next));
      return true;
    } catch (error) {
      queue.unshift(next);
      this.opts.logger?.warn(`[wps-bot] followup failed, requeued in front: ${String(error)}`);
      throw error;
    }
  }

  /** G4：shutdown 通知枚举面——队列非空或会话在跑的在册 chat。 */
  chatIdsWithWork(): string[] {
    const out: string[] = [];
    for (const [chatId] of this.handles) {
      if (this.busy(chatId) || (this.queues.get(chatId)?.length ?? 0) > 0) out.push(chatId);
    }
    for (const [chatId, queue] of this.queues) {
      if (queue.length > 0 && !out.includes(chatId)) out.push(chatId);
    }
    return out;
  }

  /** 会话内是否还有待办（卡片/审批计时器等效观察）。 */
  queued(chatId: string): number {
    return this.queues.get(chatId)?.length ?? 0;
  }

  entries(): IterableIterator<[string, ChatSessionHandle]> {
    return this.handles.entries();
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

  /** 会话句柄报告忙闲（GA: session.is_running()）——宿主有线双向取：优先 handle.status，另去忙阅眼项。 */
  busy(chatId: string): boolean {
    return this.handles.get(chatId)?.status() === "running";
  }

  /** 宿主会话报错/中止的路径：把手柄从在册清出（下次 direct 重建）。 */
  forget(chatId: string): void {
    this.handles.delete(chatId);
  }
}
