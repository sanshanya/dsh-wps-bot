/**
 * 交付服务（finishTask 产物、marker 提取、artifact 上传、错误回述）。
 *
 * @module dsh-wps-bot/task-delivery
 */

import { readFile, stat } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { parseTaskKey, sanitizePathKey } from "./task-keys.ts";

export const ATTACH_MARKER = /\[\[attach:([^\]]+)\]\]/g;

export function safeArtifactName(name: string): string {
  return name
    .split("")
    .map((ch) => (/^[\p{L}\p{N}]$/u.test(ch) || "._-".includes(ch) ? ch : "_"))
    .join("")
    .slice(0, 160);
}

/** 任务工作区根：任务键形态时按 ws/<chat>/<owner>/<task>，旧形态回落全局 ws 根。 */
export function taskRootOf(workspaceRoot: string, sessionIdOrChat: string): string {
  const parsed = parseTaskKey(sessionIdOrChat);
  if (parsed === null) return resolve(workspaceRoot);
  return resolve(
    workspaceRoot,
    sanitizePathKey(parsed.chatId),
    sanitizePathKey(parsed.ownerId),
    sanitizePathKey(parsed.taskId),
  );
}

export interface ArtifactExtraction {
  cleaned: string;
  files: Array<{ marker: string; candidate: string }>;
  errors: string[];
}

export function extractArtifacts(
  text: string,
  taskRoot: string,
): ArtifactExtraction {
  const artifactRoot = resolve(taskRoot, "artifacts");
  const files: Array<{ marker: string; candidate: string }> = [];
  const errors: string[] = [];
  const seenMarkers = new Set<string>();
  const seenCandidates = new Set<string>();
  for (const match of text.matchAll(ATTACH_MARKER)) {
    const marker = (match[1] ?? "").trim();
    const candidate = resolve(taskRoot, marker);
    if (candidate !== artifactRoot && !candidate.startsWith(artifactRoot + sep)) {
      if (!seenMarkers.has(marker)) errors.push(`artifact path is outside the deliverable directory: ${marker}`);
      seenMarkers.add(marker);
      continue;
    }
    if (seenCandidates.has(candidate)) continue;
    seenCandidates.add(candidate);
    files.push({ marker, candidate });
  }
  return { cleaned: text.replace(ATTACH_MARKER, "").trim(), files, errors };
}

export interface DeliveryClient {
  sendMarkdownSplit(chatId: string, text: string, mention: unknown, limit?: number): Promise<string[]>;
  uploadFile(chatId: string, name: string, data: Buffer): Promise<unknown>;
}

export class TaskDeliveryService {
  private readonly deliverChunks: number;
  private readonly workspaceRoot: string;
  private readonly client: DeliveryClient;
  private readonly logger: { warn(...args: unknown[]): void; error(...args: unknown[]): void };
  private readonly registerOutboundIds: (sessionId: string, chatId: string, ids: string[]) => void;

  constructor(opts: {
    deliverChunks: number;
    workspaceRoot: string;
    client: DeliveryClient;
    logger: { warn(...args: unknown[]): void; error(...args: unknown[]): void };
    registerOutboundIds: (sessionId: string, chatId: string, ids: string[]) => void;
  }) {
    this.deliverChunks = opts.deliverChunks;
    this.workspaceRoot = opts.workspaceRoot;
    this.client = opts.client;
    this.logger = opts.logger;
    this.registerOutboundIds = opts.registerOutboundIds;
  }

  async deliver(sessionId: string, text: string): Promise<void> {
    const chatId = parseTaskKey(sessionId)?.chatId ?? sessionId;
    try {
      const { cleaned, files, errors } = extractArtifacts(text, taskRootOf(this.workspaceRoot, sessionId));
      const deliveryErrors = [...errors];
      if (cleaned.length > 0 || files.length === 0) {
        const ids = await this.client.sendMarkdownSplit(chatId, cleaned, null, this.deliverChunks);
        this.registerOutboundIds(sessionId, chatId, ids);
      }
      for (const { marker, candidate } of files) {
        const name = basename(candidate);
        const info = await stat(candidate).catch(() => null);
        if (info === null || !info.isFile()) {
          deliveryErrors.push(`artifact file does not exist: ${marker}`);
          continue;
        }
        try {
          const uploadSent = await this.client.uploadFile(chatId, name, await readFile(candidate));
          const uploadIds = (uploadSent as { messageId?: unknown }).messageId;
          this.registerOutboundIds(sessionId, chatId, typeof uploadIds === "string" && uploadIds !== "" ? [uploadIds] : []);
        } catch (error) {
          deliveryErrors.push(`Artifact delivery failed for ${name}: ${String(error)}`);
        }
      }
      for (const failure of deliveryErrors) {
        await this.client
          .sendMarkdownSplit(chatId, failure, null, this.deliverChunks)
          .catch((error: unknown) => this.logger.warn("[wps-bot] delivery failure notice failed:", error));
      }
    } catch (error) {
      this.logger.error("[wps-bot] deliver failed:", error);
    }
  }
}
