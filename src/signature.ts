/**
 * WPS 365 请求签名（KSO-1）。考古锚点见 docs/references.md。
 *
 * @module dsh-wps-bot/signature
 */

import { createHash, createHmac } from "node:crypto";

export interface KsoSignInput {
  method: string;
  /** 请求路径（含 query，仅 path 部分，如 "/v7/messages/create"） */
  uri: string;
  /** RFC 1123 GMT 日期字符串 */
  date: string;
  /** 请求体（无则为空 Buffer） */
  body: Buffer;
  clientSecret: string;
}

export function kso1Signature(input: KsoSignInput): string {
  const digest =
    input.body.length > 0
      ? createHash("sha256").update(input.body).digest("hex")
      : "";
  const signing = `KSO-1${input.method.toUpperCase()}${input.uri}application/json${input.date}${digest}`;
  return createHmac("sha256", input.clientSecret).update(signing).digest("hex");
}

/** RFC 1123 GMT 日期（GA formatdate(timeval=now, usegmt=True) 等价）。 */
export function ksoDate(now: Date = new Date()): string {
  return now.toUTCString();
}
