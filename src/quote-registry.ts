/**
 * botMessageId→sessionId 注册表（契约 D1）：引用继承的查件面。
 * 7 天 / 2000 条双闸，JSONL 追加+加载+超闸重写（dedup 同构件）。
 *
 * @module dsh-wps-bot/quote-registry
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface Record_ {
  botMessageId: string;
  sessionId: string;
  chatId: string;
  sentAt: number;
}

const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const MAX_COUNT = 2000;

let persistSeq = 0;

export class QuoteRegistry {
  private readonly byId = new Map<string, Record_>();

  private readonly path: string | null;

  constructor(path: string | null) {
    this.path = path;
  }

  async load(): Promise<void> {
    if (this.path === null) return;
    try {
      const body = await readFile(this.path, "utf8");
      for (const line of body.split("\n")) {
        if (line.trim() === "") continue;
        try {
          const rec = JSON.parse(line) as Record_;
          if (typeof rec.botMessageId === "string" && typeof rec.sessionId === "string") {
            this.byId.set(rec.botMessageId, rec);
          }
        } catch { /* 单行坏不连坐 */ }
      }
    } catch { /* 首跑无档 */ }
  }

  async register(botMessageIds: string[], sessionId: string, chatId: string): Promise<void> {
    const sentAt = Date.now();
    for (const id of botMessageIds) {
      if (id.length === 0) continue;
      this.byId.set(id, { botMessageId: id, sessionId, chatId, sentAt });
    }
    await this.persist();
  }

  lookup(botMessageId: string): Record_ | null {
    const rec = this.byId.get(botMessageId) ?? null;
    if (rec === null) return null;
    if (Date.now() - rec.sentAt > MAX_AGE_MS) {
      this.byId.delete(botMessageId);
      return null;
    }
    return rec;
  }

  /** 双闸裁剪+整表重写（追加写不耐 2000 条上限的保守路径——量小，整写足构）。 */
  private async persist(): Promise<void> {
    if (this.path === null) return;
    const now = Date.now();
    for (const [id, rec] of this.byId) {
      if (now - rec.sentAt > MAX_AGE_MS) this.byId.delete(id);
    }
    const all = [...this.byId.values()].sort((a, b) => a.sentAt - b.sentAt);
    const kept = all.length > MAX_COUNT ? all.slice(all.length - MAX_COUNT) : all;
    this.byId.clear();
    for (const rec of kept) this.byId.set(rec.botMessageId, rec);
    await mkdir(dirname(this.path), { recursive: true });
    // Y2-4：tmp 名唯一化（pid+atomicseq——多任务并发 persist 不撞名；同 dedup.compact 先例）
    const tmp = `${this.path}.fine.${process.pid}.${++persistSeq}.tmp`;
    await writeFile(tmp, kept.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    const { rename } = await import("node:fs/promises");
    await rename(tmp, this.path);
  }

  get size(): number {
    return this.byId.size;
  }
}
