/**
 * 证据落盘（R4 对位 GA app.py:532-561）：
 * 三路——unparsed_content / cloud_docs / shared_doc_ids，JSONL 追加写，路径随事实进 prompt。
 * 未知节点不再静默蒸发：原文落原盘，模型可用 file_read 自查。
 *
 * @module dsh-wps-bot/evidence
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export type EvidenceKind = "unparsed_content" | "cloud_docs" | "shared_doc_ids";

export class EvidenceStore {
  private readonly dir: string;

  constructor(workspaceRoot: string) {
    this.dir = join(workspaceRoot, "evidence");
  }

  /** 空集不入盘（无噪音）；返回写盘路径供观察行引用。 */
  async record(kind: EvidenceKind, entries: unknown[]): Promise<string | null> {
    if (entries.length === 0) return null;
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, `${kind}.jsonl`);
    await appendFile(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
    return path;
  }
}
