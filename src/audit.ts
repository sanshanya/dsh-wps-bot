/**
 * 审批记账 JSONL。考古锚点见 docs/references.md。
 *
 * @module dsh-wps-bot/audit
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type ApprovalAuditOutcome =
  | "decision"
  | "timeout"
  | "approval_window"
  | "cancelled";

export type ApprovalAuditKind = "decision" | "window-auto-allow" | "reply-resolution";

export interface ApprovalAuditEntry {
  /** epoch 秒 */
  timestamp: number;
  kind: ApprovalAuditKind;
  auditOutcome: ApprovalAuditOutcome;
  chatId: string;
  userId: string;
  approved: boolean;
  /** 群问题面正文（GA review 字段的对位面） */
  review?: string;
  /** 用户拒绝时的原文反馈（GA feedback 语义） */
  feedback?: string;
  windowExpiresAt?: number;
  grantMinutes?: number;
  toolName?: string;
  callId?: string;
  reason?: string;
  sessionId?: string;
  ownerUserId?: string;
  requesterUserId?: string;
  approverUserId?: string;
}

export async function appendApprovalAudit(
  path: string,
  entry: ApprovalAuditEntry,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(entry) + "\n", "utf8");
}

export function autoAllowEntry(input: {
  chatId: string;
  userId: string;
  review?: string;
  windowExpiresAt?: number;
  reason?: string;
  toolName?: string;
  callId?: string;
}): ApprovalAuditEntry {
  return {
    timestamp: Math.floor(Date.now() / 1000),
    kind: "window-auto-allow",
    auditOutcome: "approval_window",
    chatId: input.chatId,
    userId: input.userId,
    approved: true,
    ...(input.review !== undefined ? { review: input.review } : {}),
    ...(input.windowExpiresAt !== undefined ? { windowExpiresAt: input.windowExpiresAt } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
    ...(input.callId !== undefined ? { callId: input.callId } : {}),
  };
}
