/**
 * 中断/终态通知族。考古锚点见 docs/references.md。
 *
 * @module dsh-wps-bot/notify
 */

export type InterruptionReason = "runtime_failure" | "service_stopping" | "unavailable";

const DETAIL: Record<InterruptionReason, string> = {
  runtime_failure: "处理期间发生运行时异常。",
  service_stopping: "服务已关闭或正在重启。",
  unavailable: "当前任务无法继续完成。",
};

export function detailFor(reason: InterruptionReason): string {
  return DETAIL[reason];
}

/** GA app.py:430-435 的排版逐字件。 */
export function interruptionNotice(reason: InterruptionReason, chatId: string): string {
  return (
    "## 当前对话已中断\n\n" +
    `${DETAIL[reason]}\n\n` +
    `对话 ID：\`${chatId}\`\n\n` +
    "请重新发送任务。已发起的外部操作不会自动回滚。"
  );
}

/** turn/end reason → 通知件（completed 空文本走 unavailable；GA 同分支）。 */
export function reasonForTurnEnd(kind: string): InterruptionReason | null {
  switch (kind) {
    case "error": return "runtime_failure";
    case "aborted":
    case "max-tokens":
    case "blocked": return "unavailable";
    default: return null;
  }
}

/** 进程内幂等：同键通知只发一次（重放/多路径收官不骚扰群）。 */
export class InterruptionLedger {
  private readonly sent = new Set<string>();
  claim(key: string): boolean {
    if (this.sent.has(key)) return false;
    this.sent.add(key);
    return true;
  }
}
