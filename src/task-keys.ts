/**
 * 任务会话键：`wps-bot:<chatId>:<ownerUserId>:<taskId>`（taskId=根消息 eventId）。
 * 解析失败=旧线/外部键——返回 null，调用面自裁egacy 处置。
 *
 * @module dsh-wps-bot/task-keys
 */

const PREFIX = "wps-bot:";

export function taskKey(chatId: string, ownerId: string, taskId: string): string {
  return `wps-bot:${chatId}:${ownerId}:${taskId}`;
}

export interface ParsedTaskKey {
  chatId: string;
  ownerId: string;
  taskId: string;
}

export function parseTaskKey(key: string): ParsedTaskKey | null {
  if (!key.startsWith(PREFIX)) return null;
  const rest = key.slice(PREFIX.length);
  const firstSep = rest.indexOf(":");
  if (firstSep <= 0) return null;
  const secondSep = rest.indexOf(":", firstSep + 1);
  if (secondSep <= firstSep + 1) return null;
  const chatId = rest.slice(0, firstSep);
  const ownerId = rest.slice(firstSep + 1, secondSep);
  const taskId = rest.slice(secondSep + 1);
  if (taskId.length === 0 || taskId.includes(":")) return null;
  return { chatId, ownerId, taskId };
}

/** 旧线 `wps-bot:<chatId>` 辨形（迁移记录引据）。 */
export function isLegacyKey(key: string): boolean {
  return key.startsWith(PREFIX) && parseTaskKey(key) === null;
}

/** Y2-3 央束：盘键净化——白名单 [A-Za-z0-9._-]，余者一概「_」；空/纯点键变「_」。
 *  用法：一切落盘路径段必须经此；会话键解析原件不动（运营面不受影响）。 */
export function sanitizePathKey(key: string): string {
  const out = key.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/\.{1,}/g, (m) => (m === ".." ? "__" : m)).replace(/^[._]+|[._]+$/g, (m) => (m.length > 2 ? m : m));
  const cleaned = out.length > 0 && out !== "." && out !== ".." ? out : "_";
  return cleaned;
}
