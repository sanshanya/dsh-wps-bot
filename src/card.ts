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
    if (typeof phase.turn === "number" && Number.isFinite(phase.turn)) state.turn = phase.turn;
    if (phase.tool) state.tool = phase.tool;
    if (phase.phase) state.phase = phase.phase;
    if (state.messageId !== null) void this.maybeUpdate(chatId, state);
  }

  /** 完结收口：不收在不该收的错误里。 */
  async finish(chatId: string): Promise<void> {
    if (this.opts.mode === "off") return;
    const state = this.states.get(chatId);
    if (state === undefined) return;
    this.states.delete(chatId);
    if (state.delayTimer) clearTimeout(state.delayTimer);
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    if (state.messageId === null) return;
    try {
      if (this.opts.settle === "update") {
        await this.opts.client.updateCard(
          state.messageId,
          renderCard(state, Date.now() / 1000),
          this.opts.title,
        );
      } else {
        await this.opts.client.recallMessage(state.messageId);
      }
    } catch (error) {
      this.logger?.warn(`[wps-bot] progress card settle failed: ${String(error)}`, error);
    }
  }

  /** 同 chat 是否还有活卡（GA 干预不重置轮次时钟的锚点）。 */
  hasActive(chatId: string): boolean {
    return this.states.has(chatId);
  }

  /** 延迟命中后仍未完结 → 发送首卡并启动心跳。 */
  private async ensureCard(chatId: string): Promise<void> {
    const state = this.states.get(chatId);
    if (state === undefined || state.messageId !== null || state.done) return;
    state.messageId = await this.opts.client.sendCard(
      chatId,
      renderCard(state, Date.now() / 1000),
      this.opts.title,
    );
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

  /** 进程内全部任务清空（卸载纪律）。 */
  async finishAll(): Promise<void> {
    const chatIds = [...this.states.keys()];
    await Promise.allSettled(chatIds.map((chatId) => this.finish(chatId)));
  }
}
