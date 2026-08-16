/**
 * 审批同意解析 + 限时窗口（纯逻辑）。考古锚点见 docs/references.md。
 *
 * @module dsh-wps-bot/consent
 */

/** _CONSENT 正则：^(?:同意|approve)(?:\s*(\d+)\s*(?:分钟|分|minutes?|min|m))?[。.!！]?$ */
export const CONSENT_RE =
  /^(?:同意|approve)(?:\s*(\d+)\s*(?:分钟|分|minutes?|min|m))?[。.!！]?$/i;

/**
 * @returns 0 = 单次同意；N>0 = 同意并开窗 N 分钟；null = 未同意
 *   （分钟数=0 视为未同意，approval.py:25 的 else 分支）
 */
export function parseConsent(text: string): number | null {
  const match = CONSENT_RE.exec(text.trim());
  if (!match) return null;
  const raw = match[1];
  if (raw === undefined) return 0;
  const minutes = Number.parseInt(raw, 10);
  if (!Number.isFinite(minutes)) return null;
  return minutes > 0 ? minutes : null;
}

export interface Clock {
  now(): number; // epoch seconds
}

export const SYSTEM_CLOCK: Clock = { now: () => Date.now() / 1000 };

/**
 * 限时窗口存储（进程内；重启清除与 GA 一致）。
 * 键 = chatId + "\0" + userId（approval.py:45,56-76；NUL 分隔避免相邻字段粘连撞键）。
 */
export class ApprovalWindowStore {
  private readonly windows = new Map<string, number>();
  private readonly clock: Clock;

  constructor(clock: Clock = SYSTEM_CLOCK) {
    this.clock = clock;
  }

  static key(chatId: string, userId: string): string {
    return chatId + "\u0000" + userId;
  }

  hasActive(chatId: string, userId: string): boolean {
    const key = ApprovalWindowStore.key(chatId, userId);
    const expiresAt = this.windows.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.clock.now()) {
      this.windows.delete(key);
      return false;
    }
    return true;
  }

  grant(chatId: string, userId: string, minutes: number): number {
    const expiresAt = this.clock.now() + minutes * 60;
    this.windows.set(ApprovalWindowStore.key(chatId, userId), expiresAt);
    return expiresAt;
  }

  expiresAt(chatId: string, userId: string): number | null {
    return this.hasActive(chatId, userId)
      ? (this.windows.get(ApprovalWindowStore.key(chatId, userId)) ?? null)
      : null;
  }

  clearAll(): void {
    this.windows.clear();
  }
}

/** 开放窗语义（approval.py:62）：allow_window=false 时窗口永不生效。 */
export function windowAllows(
  store: ApprovalWindowStore,
  chatId: string,
  userId: string,
  allowWindow = true,
): boolean {
  return allowWindow && store.hasActive(chatId, userId);
}
