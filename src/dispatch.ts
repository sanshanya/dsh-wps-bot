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
  factify?: (ev: WpsEvent) => string;
  /** 事件被真正派发（followup/inject 落地）时通知宿主（requester 追踪/卡片启动）。 */
  onDispatched?: (chatId: string, ev: WpsEvent, route: Exclude<Route, "duplicate" | "drop">) => void;
  logger?: { warn(...args: unknown[]): void };
}

export type Route = "inject" | "enqueue" | "duplicate" | "drop";

/** GA：requester/chat 作为本轮事实进模型；evidence 恒定供给（GA run_task 的 live-attachments 语用）。 */
export function defaultFactify(ev: WpsEvent): string {
  const head = `[WPS 任务 | chat ${ev.chatType || "group"}/${ev.chatId} | requester ${ev.senderName}(${ev.senderId})]`;
  const parts: string[] = [];
  if (ev.attachments.length > 0)
    parts.push(`附件 ×${ev.attachments.length}（暂不下注端点内容，按后续技能处理）`);
  if (ev.cloudDocLinks.length > 0) parts.push(`云文档 ${ev.cloudDocLinks.join(" ")}`);
  if (ev.unparsed.length > 0) parts.push(`未解析节点 ×${ev.unparsed.length}（非文本证据消息）`);
  const body = ev.text.trim();
  const summary = parts.join("\n");
  if (body.length > 0) return `${head}\n\n${body}${summary ? `\n\n${summary}` : ""}`;
  return `${head}\n\n${summary || "（无文本）"}`;
}

const PROMPT_IDS_CAP = 128;

export class WpsRouter {
  private readonly opts: RouterOptions;
  private readonly handles = new Map<string, ChatSessionHandle>();
  private readonly queues = new Map<string, WpsEvent[]>();
  private readonly promptIds = new Map<string, string[]>();

  constructor(opts: RouterOptions) {
    this.opts = opts;
  }

  async handleEvent(ev: WpsEvent): Promise<Route> {
    if (!this.opts.dedup.claim(ev.eventId)) return "duplicate";
    let accepted = false;
    try {
      const route = await this.route(ev);
      if (route !== "drop") {
        accepted = true;
        await this.opts.dedup.record(ev.eventId);
      }
      return route;
    } finally {
      if (!accepted) this.opts.dedup.release(ev.eventId);
    }
  }

  private quoteHitsPrompt(ev: WpsEvent): boolean {
    if (!ev.quoteMsgId) return false;
    return this.promptIds.get(ev.chatId)?.includes(ev.quoteMsgId) ?? false;
  }

  private factify(ev: WpsEvent): string {
    return (this.opts.factify ?? defaultFactify)(ev);
  }

  private async route(ev: WpsEvent): Promise<Route> {
    const handle = this.handles.get(ev.chatId);
    const direct = ev.isPrivate || ev.mentioned || this.quoteHitsPrompt(ev);
    const evidence = ev.evidenceBearing;
    const busy = handle?.status() === "running";

    if (handle && direct && busy && !evidence) {
      // GA：运行中收到明确引用/私聊/@ → 复用原生 intervention seam 补充当前用户事实
      if (handle.inject(this.factify(ev))) {
        await this.opts.ackIntervention?.(ev.chatId, ev.senderId, ev.senderName);
        await this.markPrompt(ev.chatId, ev.eventId);
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
    await this.markPrompt(ev.chatId, ev.eventId);
    await this.drain(ev.chatId);
    return "enqueue";
  }

  /** 同 chat 串行：仅在会话空闲时吐出队首一条。会话空闲事件由宿主调用本方法。 */
  async drain(chatId: string): Promise<void> {
    const handle = this.handles.get(chatId);
    if (handle && handle.status() === "running") return;
    const queue = this.queues.get(chatId);
    if (!queue || queue.length === 0) return;
    const next = queue.shift();
    if (next === undefined) return;
    let target = handle;
    if (target === undefined) {
      target = await this.opts.ensure(chatId);
      this.handles.set(chatId, target);
    }
    try {
      this.opts.onDispatched?.(chatId, next, "enqueue");
      await target.followup(this.factify(next));
    } catch (error) {
      queue.unshift(next);
      this.opts.logger?.warn(`[wps-bot] followup failed, requeued in front: ${String(error)}`);
      throw error;
    }
  }

  /** 会话内是否还有待办（卡片/审批计时器等效观察）。 */
  queued(chatId: string): number {
    return this.queues.get(chatId)?.length ?? 0;
  }

  entries(): IterableIterator<[string, ChatSessionHandle]> {
    return this.handles.entries();
  }

  private async markPrompt(chatId: string, id: string): Promise<void> {
    if (!id) return;
    const ids = this.promptIds.get(chatId) ?? [];
    ids.push(id);
    if (ids.length > PROMPT_IDS_CAP) ids.shift();
    this.promptIds.set(chatId, ids);
  }

  /** 宿主会话报错/中止的路径：把手柄从在册清出（下次 direct 重建）。 */
  forget(chatId: string): void {
    this.handles.delete(chatId);
  }
}
