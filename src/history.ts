/**
 * 历史归档存store（P-D）：inbound 全件归档 + 同 chat 关键词最近件检索。
 *
 * @module dsh-wps-bot/history
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WpsEvent } from "./protocol.ts";
import { sanitizePathKey } from "./task-keys.ts";

export interface HistoryHit {
  ts: number;
  senderName: string;
  senderUserId: string;
  text: string;
}

/** 归档文件寻址单源（bot 内省件与 skills/wps-chat 脚本共用，禁止第二处重写本规则）。 */
export function historyFilePath(workspaceRoot: string, chatId: string): string {
  return join(workspaceRoot, "history", sanitizePathKey(chatId), "history.jsonl");
}

export class HistoryStore {
  private readonly workspaceRoot: string;
  /** per-file 写入串行链：同 chat 并行事件按到达序落行（竞态实证）。 */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  private fileOf(chatId: string): string {
    return historyFilePath(this.workspaceRoot, chatId);
  }

  async record(ev: WpsEvent): Promise<void> {
    const file = this.fileOf(ev.chatId);
    const prev = this.chains.get(file) ?? Promise.resolve();
    // L4-1：返回未 catch 的链——调用面看到失败(true-error perceivable)；链本身仍保序不锁
    const next = prev.then(() => this.recordOnce(file, ev));
    this.chains.set(file, next.catch(() => undefined));
    await next;
  }

  /** 排空全部在途 append 链——shutdown 必须先等它，否则接力写会撞上调用方的目录清扫（ENOTEMPTY 实证）。 */
  async drain(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  private async recordOnce(file: string, ev: WpsEvent): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(
      file,
      JSON.stringify({
        ts: Math.floor(Date.now() / 1000),
        eventId: ev.eventId,
        senderUserId: ev.senderId,
        senderName: ev.senderName,
        chatType: ev.chatType,
        quoteMsgId: ev.quoteMsgId.length > 0 ? ev.quoteMsgId : undefined,
        text: ev.text.slice(0, 500),
        attachments: ev.attachments.map((a) => a.name).filter(Boolean),
      }) + "\n",
    );
  }

  async search(chatId: string, query: string, limit = 5): Promise<HistoryHit[]> {
    let raw = "";
    try {
      raw = await readFile(this.fileOf(chatId), "utf8");
    } catch {
      return [];
    }
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const out: HistoryHit[] = [];
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const e = JSON.parse(lines[i] as string) as Partial<HistoryHit>;
        const hay = `${e.text ?? ""} ${e.senderName ?? ""}`.toLowerCase();
        if (terms.length === 0 || terms.some((t) => hay.includes(t))) {
          out.push({
            ts: Number(e.ts ?? 0),
            senderName: String(e.senderName ?? ""),
            senderUserId: String(e.senderUserId ?? ""),
            text: String(e.text ?? ""),
          });
        }
      } catch {
        // 坏行跳过
      }
    }
    return out;
  }
}
