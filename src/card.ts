/**
 * 进度卡片（Runtime 旁路状态机）。
 *
 * 逐行迁移 ksbot_ga/src/ga_wps/progress.py:59-204 + ksbot-dsh/channel/wps_channel/progress_adapter.py：
 *  - 生命周期 at-most-one 卡片：start → 首次更新延迟 → 轮次/工具/审批相位 → 完结收口
 *  - 短任务零交互（initial_delay 内 finish → 从不发送）
 *  - 卡片正文稳定模板「已收到，正在处理。/心跳/轮次/工具」
 *  - GA 措辞：心跳：{elapsed_text}，{activity_text}；状态行轮次/工具
 *  - settle 默认 recall（GA 收口行为；WPS 撤回有系统通知——由 config 控制可选 keep）
 *
 * @module dsh-wps-bot/card
 */

export interface CardLikeClient {
  sendCard(chatId: string, markdown: string, title: string): Promise<string>;
  updateCard(messageId: string, markdown: string, title: string): Promise<unknown>;
  recallMessage(messageId: string): Promise<unknown>;
}

export interface ProgressPhase {
  turn?: number;
  tool?: string;
  phase?: string;
}

export interface ProgressCardsOptions {
  client: CardLikeClient;
  title: string;
  initialDelayMs?: number;
  heartbeatMs?: number;
  updateMinIntervalMs?: number;
  settle?: "recall" | "update";
  mode?: "card" | "off";
  logger?: { warn(this: unknown, msg: string, error?: unknown): void };
}

interface CardState {
  messageId: string | null;
  startedAt: number;
  lastActivity: number;
  phase: string;
  turn: number | null;
  tool: string;
  lastUpdateAt: number;
  delayTimer: NodeJS.Timeout | null;
  heartbeatTimer: NodeJS.Timeout | null;
  /** 用于完结安静期：已完成的任务 count（避免刚起步又 settle 竞态）。 */
  done: boolean;
}

/** GA progress.py 卡片正文模板（逐字对齐）。 */
export function renderCard(
  state: Pick<CardState, "startedAt" | "lastActivity" | "phase" | "turn" | "tool">,
  now: number,
): string {
  const elapsed = Math.max(0, Math.floor(now - state.startedAt));
  const idle = Math.max(0, Math.floor(now - state.lastActivity));
  const elapsedText = elapsed >= 60 ? `${Math.floor(elapsed / 60)} 分钟` : "不到 1 分钟";
  const activityText =
    idle < 60 ? "刚刚有活动" : `${Math.floor(idle / 60)} 分钟前：${state.phase}`;
  let heartbeat = `心跳：${elapsedText}，${activityText}`;
  if (state.turn !== null) heartbeat += `，轮次 ${state.turn}`;
  const lines = ["已收到，正在处理。", "", heartbeat];
  if (state.tool) lines.push(`工具：${state.tool}`);
  else if (!["正在准备任务", "正在等待模型和工具"].includes(state.phase) && idle < 60) {
    lines.push(`阶段：${state.phase}`);
  }
  return lines.join("\n");
}

export class ProgressCards {
  private readonly opts: Required<Omit<ProgressCardsOptions, "logger">>;
  private readonly logger: ProgressCardsOptions["logger"];
  private readonly states = new Map<string, CardState>();

  constructor(opts: ProgressCardsOptions) {
    this.opts = {
      client: opts.client,
      title: opts.title,
      initialDelayMs: opts.initialDelayMs ?? 5000,
      heartbeatMs: opts.heartbeatMs ?? 120000,
      updateMinIntervalMs: opts.updateMinIntervalMs ?? 2000,
      settle: opts.settle ?? "recall",
      mode: opts.mode ?? "card",
    };
    this.logger = opts.logger;
  }

  start(chatId: string): void {
    if (this.opts.mode === "off") return;
    this.states.delete(chatId);
    const now = Date.now() / 1000;
    const state: CardState = {
      messageId: null,
      startedAt: now,
      lastActivity: now,
      phase: "正在准备任务",
      turn: null,
      tool: "",
      lastUpdateAt: 0,
      delayTimer: null,
      heartbeatTimer: null,
      done: false,
    };
    this.states.set(chatId, state);
    state.delayTimer = setTimeout(() => {
      void this.ensureCard(chatId).catch((error: unknown) => {
        this.logger?.warn(`[wps-bot] progress card start failed: ${String(error)}`, error);
      });
    }, this.opts.initialDelayMs);
  }

  /**
   * 事件驱动的相位（轮次 n / 工具：name / 等待人工审批）。
   * 对应 ksbot-dsh/session-tail 的 toProgressPhase 词汇集。
   */
  phase(chatId: string, phase: ProgressPhase): void {
    if (this.opts.mode === "off") return;
    const state = this.states.get(chatId);
    if (state === undefined) return;
    state.lastActivity = Date.now() / 1000;
    // GA _TURN：turn 换到时清上历 tool（之前留在旧工具上）
    if (typeof phase.turn === "number" && Number.isFinite(phase.turn)) {
      state.turn = phase.turn;
      state.tool = "";
    }
    if (phase.tool) state.tool = phase.tool;
    if (phase.phase) state.phase = phase.phase;
    if (state.messageId !== null) void this.maybeUpdate(chatId, state);
  }

  /**
   * 完结收口（B4 三分支对位 ga_wps/progress.py:148-174）：
   *  delivered=true  → recall 收口；recall 失败 → update「任务已完成。…撤回失败。」
   *  delivered=false → update 失败文案（默认「任务未完成，服务已停止继续处理。」），不 recall
   *  settle=update 的旧路并入 delivered=false 同通道（终态 update），delivered=true 仍 recall。
   */
  async finish(chatId: string, outcome: { delivered: boolean; failure?: string } = { delivered: true }): Promise<void> {
    if (this.opts.mode === "off") return;
    const state = this.states.get(chatId);
    if (state === undefined) return;
    this.states.delete(chatId);
    state.done = true;
    if (state.delayTimer) clearTimeout(state.delayTimer);
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    if (state.messageId === null) return;
    if (outcome.delivered) {
      if (state.messageId === "") return;
      if (this.opts.settle === "update") {
        try {
          await this.opts.client.updateCard(state.messageId, "任务已完成。", this.opts.title);
        } catch (error) {
          this.logger?.warn(`[wps-bot] progress card settle update failed: ${String(error)}`, error);
        }
        return;
      }
      try {
        await this.opts.client.recallMessage(state.messageId);
        return;
      } catch (error) {
        this.logger?.warn(`[wps-bot] progress card recall failed: ${String(error)}`, error);
      }
    }
    // 未交付或 recall 失败 → update 失败/旁证文案（keep 模式也让失败可见）
    const text = outcome.delivered
      ? "任务已完成。\n\n正式回答已发送，但进度消息撤回失败。"
      : (outcome.failure ?? "任务未完成，服务已停止继续处理。");
    try {
      await this.opts.client.updateCard(state.messageId, text, this.opts.title);
    } catch (error) {
      this.logger?.warn(`[wps-bot] progress card settle update failed: ${String(error)}`, error);
    }
  }

  /** 同 chat 是否还有活卡（GA 干预不重置轮次时钟的锚点）。 */
  hasActive(chatId: string): boolean {
    return this.states.has(chatId);
  }

  /** 在途进度卡 message id（GA accepts_progress_reply 的对撞对象）。 */
  progressMessageId(chatId: string): string | null {
    return this.states.get(chatId)?.messageId ?? null;
  }

  /**
   * 延迟命中后仍未完结 → 发送首卡并启动心跳。
   * 场景：sendCard 网络延迟中 sh finish（short task）→ states 表已删：果断放弃，不再挂
   * 心跳（否则消息的卡被出，但 interval 不停 + 卡留在外）。
   */
  private async ensureCard(chatId: string): Promise<void> {
    const state = this.states.get(chatId);
    if (state === undefined || state.messageId !== null || state.done) return;
    const messageId = await this.opts.client.sendCard(
      chatId,
      renderCard(state, Date.now() / 1000),
      this.opts.title,
    );
    // 检查 sendCard 结束后该 chat 状态是否仍是同一个（中公被 finish 或 reopen 换掉的话不挂心跳）
    const live = this.states.get(chatId);
    if (live !== state || state.done) {
      try { await this.opts.client.recallMessage(messageId); } catch { /* 静默 */ }
      return;
    }
    state.messageId = messageId;
    state.heartbeatTimer = setInterval(() => {
      const st = this.states.get(chatId);
      if (st === undefined || st.messageId === null) return;
      void this.maybeUpdate(chatId, st, true);
    }, this.opts.heartbeatMs);
  }

  private async maybeUpdate(chatId: string, state: CardState, fromHeartbeat = false): Promise<void> {
    const now = Date.now() / 1000;
    if (!fromHeartbeat && now * 1000 - state.lastUpdateAt * 1000 < this.opts.updateMinIntervalMs) {
      return;
    }
    try {
      await this.opts.client.updateCard(state.messageId as string, renderCard(state, now), this.opts.title);
      state.lastUpdateAt = now;
    } catch (error) {
      this.logger?.warn(`[wps-bot] progress card update failed: ${String(error)}`, error);
    }
  }

  /** 进程内全部任务清空（卸载纪律）；failure 非空=按未交付分支落失败文案。 */
  async finishAll(failure?: string): Promise<void> {
    const chatIds = [...this.states.keys()];
    await Promise.allSettled(chatIds.map((chatId) => this.finish(chatId, { delivered: false, failure })));
  }
}
