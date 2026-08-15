/**
 * 事件幂等（seen_events 定式）——逐行对位 ksbot_ga/src/ga_wps/app.py:30-90。
 *
 * claim("")         空 event_id 直接放行（GA 不做空 id 剪枝）
 * record("")        空 event_id 直接视为 accepted（no-op）
 * claim(x) → record(x) → 之后同 id 的 record/claim 全部拒（at-most-once）
 * release(x)        只撤 in-flight，不接触 ids（GA 语义；claim 进 ids 的通道是 record）
 * 持久化 JSONL {"event_id","seen_at"}；每个 limit 次写入触发一次文件重建压缩。
 *
 * @module dsh-wps-bot/dedup
 */

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class EventDedup {
  private readonly order: string[] = [];
  private readonly ids = new Set<string>();
  private readonly inflight = new Set<string>();
  private readonly limit: number;
  private readonly path: string | null;
  private writes = 0;

  constructor(opts: { limit?: number; path?: string } = {}) {
    this.limit = opts.limit ?? 2048;
    this.path = opts.path ?? null;
  }

  static async load(opts: { limit?: number; path?: string }): Promise<EventDedup> {
    const store = new EventDedup(opts);
    if (store.path === null) return store;
    try {
      const text = await readFile(store.path, "utf8");
      const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
      store.writes = lines.length % store.limit;
      for (const line of lines.slice(-store.limit)) {
        try {
          const eventId = String(
            (JSON.parse(line) as { event_id?: unknown }).event_id ?? "",
          );
          if (eventId && !store.ids.has(eventId)) {
            store.order.push(eventId);
            store.ids.add(eventId);
          }
        } catch {
          /* 残行忽略 */
        }
      }
    } catch {
      /* 文件不存在：从零起算 */
    }
    return store;
  }

  has(eventId: string): boolean {
    return this.ids.has(eventId);
  }

  /** 新事件占位（GA: claim("" → true → 不做空 id 剪枝；重复/in-flight → false）。 */
  claim(eventId: string): boolean {
    if (!eventId) return true;
    if (this.ids.has(eventId) || this.inflight.has(eventId)) return false;
    this.inflight.add(eventId);
    return true;
  }

  /** 未 accepted 的路径上收回，后续重试可重新接管（GA release 只撤 in-flight）。 */
  release(eventId: string): void {
    if (!eventId) return;
    this.inflight.delete(eventId);
  }

  /**
   * 标记已 accepted：入 ids + 落 JSONL + FIFO 逐出到容量。
   * @returns false = 已经 accepted 过（幂等拒，不重复写）。
   */
  async record(eventId: string): Promise<boolean> {
    if (!eventId) return true;
    if (this.ids.has(eventId)) {
      this.inflight.delete(eventId);
      return false;
    }
    if (this.path !== null) {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(
        this.path,
        JSON.stringify({ event_id: eventId, seen_at: Math.floor(Date.now() / 1000) }) + "\n",
        "utf8",
      );
    }
    if (this.order.length >= this.limit) {
      const head = this.order.shift();
      if (head !== undefined) this.ids.delete(head);
    }
    this.order.push(eventId);
    this.ids.add(eventId);
    this.inflight.delete(eventId);
    if (this.path !== null) {
      this.writes += 1;
      if (this.writes >= this.limit) await this.compact();
    }
    return true;
  }

  /** 按 GA seen_events 语义重建保留 tail limit 的文件。 */
  private async compact(): Promise<void> {
    if (this.path === null) return;
    const tail = this.order.slice(-this.limit);
    const body =
      tail.map((id) => JSON.stringify({ event_id: id })).join("\n") + "\n";
    // GA app.py:50-60 的 tmp+replace；崩落中间态毁不了 seen_events
    const tmpPath = `${this.path}.compact.tmp`;
    await writeFile(tmpPath, body, "utf8");
    await rename(tmpPath, this.path);
    this.writes = 0;
    // 与 load 的回读结果对齐：order/ids 不变（tail 即原 order 的尾部 limit 项）
  }
}
