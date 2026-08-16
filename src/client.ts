/**
 * WPS 365 客户端：认证、加签、消息/卡片/附件、历史上拉。考古锚点见 docs/references.md。
 *
 * @module dsh-wps-bot/client
 */

import { createHash } from "node:crypto";

import { kso1Signature, ksoDate } from "./signature.ts";
import { isRecord } from "./protocol.ts";
import { splitMarkdown } from "./split.ts";

export class WpsApiError extends Error {
  readonly operation: string;
  readonly status: number | null;
  readonly code: number | string | null;
  readonly requestId: string;

  constructor(
    operation: string,
    message: string,
    opts: { status?: number; code?: number | string | null; requestId?: string } = {},
  ) {
    const fields = [
      `operation=${operation}`,
      ...(opts.status !== undefined ? [`status=${opts.status}`] : []),
      ...(opts.code !== undefined ? [`code=${opts.code}`] : []),
      ...(opts.requestId ? [`request_id=${opts.requestId}`] : []),
    ];
    super(`WPS API failure (${fields.join(", ")}): ${message}`);
    this.operation = operation;
    this.status = opts.status ?? null;
    this.code = opts.code ?? null;
    this.requestId = opts.requestId ?? "";
  }
}

export interface Mention {
  userId: string;
  companyId: string;
  displayName: string;
  /** GA protocol.Mention.at_tag(index) */
  atTag(index: number): string;
  /** GA protocol.Mention.payload(index) */
  payload(index: number): Record<string, unknown>;
}

function makeMention(userId: string, companyId: string, displayName: string): Mention {
  return {
    userId,
    companyId,
    displayName,
    atTag: (index: number) => `<at id="${index}">${displayName || userId.slice(0, 8)}</at>`,
    payload: (index: number) => ({
      id: String(index),
      type: "user",
      identity: { id: userId, type: "user", company_id: companyId },
    }),
  };
}

export interface WpsClientOptions {
  clientId: string;
  clientSecret: string;
  apiBase: string;
  /** 直接注入的 access_token（用于联调/代理场景；空走 oauth2 token） */
  accessToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

type Json = Record<string, unknown>;

function errorFields(value: Json, fallback = "unknown error"): {
  message: string;
  code: number | string | null;
  requestId: string;
} {
  return {
    message: String(value.message ?? value.msg ?? value.error ?? fallback),
    code: ((value.code ?? value.errcode ?? null) as number | string | null),
    requestId: String(value._request_id ?? value.request_id ?? ""),
  };
}

/** GA client.py:_image_dimensions 逐字移植（PNG/GIF/JPEG 头部；读不出回 null）。 */
export function imageDimensions(data: Buffer): { width: number; height: number } | null {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length >= 10 && data.subarray(0, 3).toString("latin1") === "GIF") {
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) { offset += 1; continue; }
      const marker = data[offset + 1]!;
      const size = data.readUInt16BE(offset + 2);
      if (marker !== undefined && marker >= 0xc0 && marker <= 0xc3) {
        return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
      }
      offset += Math.max(size + 2, 2);
    }
  }
  return null;
}

/** GA upload_file 的后缀→image type 映射（注意 .jpg 真值是 "image/jpg" 非标准串，GA 原样）。 */
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpg",
  ".jpeg": "image/jpg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function extensionOf(nameDim: string): string {
  const dot = nameDim.lastIndexOf(".");
  return dot === -1 ? "" : nameDim.slice(dot).toLowerCase();
}

export class WpsClient {
  private readonly apiBase: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly timeoutMs: number;
  private readonly providedAccessToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private token = "";
  private tokenExpiry = 0;
  private readonly mentionCache = new Map<string, Mention>();
  private companyId = "";

  constructor(opts: WpsClientOptions) {
    this.apiBase = opts.apiBase.replace(/\/+$/, "");
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.providedAccessToken = (opts.accessToken ?? "").trim();
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async accessToken(): Promise<string> {
    if (this.providedAccessToken) return this.providedAccessToken;
    if (this.token && Date.now() < this.tokenExpiry) return this.token;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
    }).toString();
    const data = (await this.sendRaw(
      "POST",
      `${this.apiBase}/oauth2/token`,
      "oauth token",
      Buffer.from(body),
      { "Content-Type": "application/x-www-form-urlencoded" },
    )) as Json;
    const token = data.access_token;
    if (!token) {
      throw new WpsApiError("oauth token", "response missing access_token", { code: "invalid_response" });
    }
    this.token = String(token);
    this.tokenExpiry = Date.now() + Math.max(60, Number(data.expires_in ?? 7200) - 300) * 1000;
    return this.token;
  }

  private async sendRaw(
    method: string,
    url: string,
    operation: string,
    body: Buffer | undefined,
    headers: Record<string, string>,
  ): Promise<Json> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers,
        body: body !== undefined && body.length > 0 ? new Uint8Array(body) : undefined,
        signal: controller.signal,
      });
      const raw = Buffer.from(await response.arrayBuffer());
      if (!response.ok) {
        let parsed: Json = {};
        try {
          parsed = JSON.parse(raw.toString("utf8")) as Json;
        } catch {
          throw new WpsApiError(operation, `HTTP ${response.status}`, { status: response.status });
        }
        const { message, code, requestId } = errorFields(parsed);
        throw new WpsApiError(operation, message, {
          status: response.status,
          code,
          requestId: requestId || (response.headers.get("x-request-id") ?? ""),
        });
      }
      try {
        return JSON.parse(raw.toString("utf8")) as Json;
      } catch {
        throw new WpsApiError(operation, "response was not a valid JSON object", { code: "invalid_response" });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async requestJson(
    method: string,
    uri: string,
    payload?: Json,
    operation?: string,
  ): Promise<Json> {
    const body =
      payload !== undefined
        ? Buffer.from(JSON.stringify(payload), "utf8")
        : Buffer.alloc(0);
    const date = ksoDate();
    const signature = kso1Signature({
      method,
      uri,
      date,
      body,
      clientSecret: this.clientSecret,
    });
    const result = await this.sendRaw(method, `${this.apiBase}${uri}`, operation ?? uri, body, {
      "Content-Type": "application/json",
      "X-Kso-Date": date,
      "X-Kso-Authorization": `KSO-1 ${this.clientId}:${signature}`,
      Authorization: `Bearer ${await this.accessToken()}`,
    });
    return ok(result, operation ?? uri);
  }

  /** GA _transfer：无加签/Bearer 的裸传输（presigned 资源面）。GET 不带 body。 */
  private async transfer(
    method: string,
    url: string,
    body: Buffer | undefined,
    headers: Record<string, string>,
  ): Promise<Buffer> {
    const operation = `resource transfer ${method.toUpperCase()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers,
        body: body !== undefined && body.length > 0 && method.toUpperCase() !== "GET" ? new Uint8Array(body) : undefined,
        signal: controller.signal,
      });
      const raw = Buffer.from(await response.arrayBuffer());
      if (!response.ok) {
        let parsed: Json = {};
        try { parsed = JSON.parse(raw.toString("utf8")) as Json; } catch { /* 文本错误体 */ }
        const { message, code, requestId } = errorFields(parsed, `HTTP ${response.status}`);
        throw new WpsApiError(operation, message, {
          status: response.status,
          code,
          requestId: requestId || (response.headers.get("x-request-id") ?? ""),
        });
      }
      return raw;
    } finally {
      clearTimeout(timer);
    }
  }

  /** GA download_attachment：换 presigned URL → 裸 GET 字节。 */
  async downloadAttachment(chatId: string, messageId: string, storageKey: string): Promise<Buffer> {
    const result = await this.requestJson(
      "GET",
      `/v7/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}` +
        `/resources/${encodeURIComponent(storageKey)}/download`,
      undefined,
      "get attachment download URL",
    );
    const url = (result.data as Json | undefined)?.url;
    if (!url) {
      throw new WpsApiError("get attachment download URL", "response missing download url", { code: "invalid_response" });
    }
    return this.transfer("GET", String(url), undefined, {});
  }

  /**
   * GA upload_file：allocate（sha256）→ upload_entry 传输 → /messages/create 发 image/file。
   * image 后缀走 image content（尽力补 width/height）；其余走 file.local。
   */
  async uploadFile(chatId: string, name: string, data: Buffer): Promise<Json> {
    const allocation = await this.requestJson(
      "POST",
      "/v7/chats/resources/upload",
      {
        file_name: name.slice(0, 256),
        file_size: data.length,
        checksum: createHash("sha256").update(data).digest("hex"),
      },
      "allocate upload",
    );
    const info = (allocation.data ?? {}) as Json;
    const entry = (info.upload_entry ?? {}) as Json;
    const storageKey = info.storage_key;
    if (!storageKey || !entry.url) {
      throw new WpsApiError("allocate upload", "response missing upload entry", { code: "invalid_response" });
    }
    let url = String(entry.url);
    const params = (entry.params ?? {}) as Json;
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) query.set(k, String(v));
    const qs = query.toString();
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((entry.headers ?? {}) as Json)) headers[k] = String(v);
    await this.transfer(
      String(entry.method ?? "PUT").toUpperCase(),
      url,
      data,
      headers,
    );

    const mime = IMAGE_MIME[extensionOf(name)];
    const content: Json = mime
      ? {
          image: {
            type: mime,
            thumbnail_type: mime,
            name,
            size: data.length,
            storage_key: String(storageKey),
            ...(imageDimensions(data) ?? {}),
          },
        }
      : {
          file: {
            type: "local",
            local: { storage_key: String(storageKey), name, size: data.length },
          },
        };
    return this.requestJson(
      "POST",
      "/v7/messages/create",
      { type: mime ? "image" : "file", receiver: { receiver_id: chatId, type: "chat" }, content },
      mime ? "send image" : "send file",
    );
  }

  getMessages(chatId: string, pageSize = 30, pageToken?: string, startTime?: number): Promise<Json> {
    const query = new URLSearchParams({ page_size: String(pageSize) });
    if (pageToken) query.set("page_token", pageToken);
    if (startTime !== undefined) query.set("start_time", String(startTime));
    return this.requestJson(
      "GET",
      `/v7/chats/${encodeURIComponent(chatId)}/messages?${query.toString()}`,
      undefined,
      "get chat messages",
    );
  }

  async currentServicePrincipal(): Promise<Json> {
    return this.data("/v7/service_principals/current", "get current service principal");
  }

  async getUser(userId: string): Promise<Json> {
    return this.data(`/v7/users/${encodeURIComponent(userId)}`, "get user");
  }

  async sendMarkdown(chatId: string, markdown: string, mentions?: Mention[]): Promise<Json> {
    const payload: Json = {
      type: "text",
      receiver: { receiver_id: chatId, type: "chat" },
      content: { text: { content: markdown, type: "markdown" } },
    };
    if (mentions && mentions.length > 0) {
      payload.mentions = mentions.map((m, i) => m.payload(i + 1));
    }
    return this.requestJson("POST", "/v7/messages/create", payload, "send message");
  }

  async sendCard(chatId: string, markdown: string, title: string): Promise<string> {
    const payload = {
      type: "card",
      receiver: { receiver_id: chatId, type: "chat" },
      content: cardContent(markdown, title),
    };
    const result = await this.requestJson("POST", "/v7/messages/create", payload, "send card");
    return messageId(result, "send card");
  }

  async updateCard(messageIdValue: string, markdown: string, title: string): Promise<Json> {
    return this.requestJson(
      "POST",
      `/v7/messages/${encodeURIComponent(messageIdValue)}/update`,
      { type: "card", content: cardContent(markdown, title) },
      "update card",
    );
  }

  async recallMessage(messageIdValue: string): Promise<Json> {
    return this.requestJson(
      "POST",
      `/v7/messages/${encodeURIComponent(messageIdValue)}/recall`,
      undefined,
      "recall message",
    );
  }

  /**
   * 分段发送：首段带 mention.atTag(1) + mention payload；后续段不带。
   * （GA send_markdown_split 的延迟 0.4s 由调用方按 config 控制。）
   */
  async sendMarkdownSplit(
    chatId: string,
    markdown: string,
    mention?: Mention | null,
    limit = 4500,
  ): Promise<string[]> {
    const tag = mention ? `${mention.atTag(1)}\n\n` : "";
    // 首段 mention 预留额度：tag 前缀计入 limit——超额尾部挪作新的第二段（其长 ≤ tag.length < limit）
    let parts = splitMarkdown(markdown, limit);
    if (tag !== "" && parts.length > 0 && (parts[0] as string).length + tag.length > limit) {
      const room = Math.max(1, limit - tag.length);
      parts = [(parts[0] as string).slice(0, room), (parts[0] as string).slice(room), ...parts.slice(1)];
    }
    const ids: string[] = [];
    for (let index = 0; index < parts.length; index++) {
      let part = parts[index] as string;
      const first = index === 0 && mention;
      if (first && mention) part = `${tag}${part}`;
      const response = await this.sendMarkdown(chatId, part, first && mention ? [mention] : undefined);
      try {
        ids.push(messageId(response, "send message"));
      } catch {
        /* GA 同行为：无 id 时 warnings 但不阻塞后续段 */
      }
      if (index + 1 < parts.length) await this.sleep(400);
    }
    return ids;
  }

  async resolveMention(userId: string, displayName: string): Promise<Mention | null> {
    const cached = this.mentionCache.get(userId);
    if (cached) return cached;
    if (!this.companyId) {
      try {
        const sp = await this.currentServicePrincipal();
        this.companyId = String(sp.company_id ?? "");
      } catch {
        /* 静默降级 */
      }
    }
    if (!this.companyId) return null;
    let name = displayName.trim();
    try {
      const user = await this.getUser(userId);
      name = String(user.user_name ?? user.name ?? name).trim();
    } catch {
      /* 保留原显示名 */
    }
    const mention = makeMention(userId, this.companyId, name || `User(${userId.slice(0, 6)})`);
    this.mentionCache.set(userId, mention);
    return mention;
  }

  private async data(uri: string, operation: string): Promise<Json> {
    const result = await this.requestJson("GET", uri, undefined, operation);
    const data = result.data as Json | undefined;
    if (!data || !data.id) {
      throw new WpsApiError(operation, "response missing data.id", { code: "invalid_response" });
    }
    return data;
  }
}

function ok(result: Json, operation: string): Json {
  const success =
    result.ok === true ||
    [result.code, result.errcode].some((v) => v === 0 || v === "0");
  if (!success) {
    const { message, code, requestId } = errorFields(result);
    throw new WpsApiError(operation, message, { code: code ?? "?", requestId });
  }
  return result;
}

function messageId(result: Json, operation: string): string {
  const data = result.data as Json | undefined;
  let messageIdValue = isRecord(data) && data.message_id ? String(data.message_id) : "";
  if (!messageIdValue && isRecord(data) && data.id) messageIdValue = String(data.id);
  if (!messageIdValue) {
    throw new WpsApiError(operation, "response missing data.message_id", { code: "invalid_response" });
  }
  return messageIdValue;
}

/** GA client.py:146 _card_content（title 不变量由调用方 constexpr）。 */
export function cardContent(markdown: string, title = "甘小雨"): Json {
  return {
    card: {
      config: {},
      i18n_items: [
        {
          key: "zh-CN",
          value: {
            header: { title: { tag: "text", text: { type: "plain", content: title } } },
            elements: [
              {
                text: { tag: "text", text: { type: "markdown", content: markdown } },
              },
            ],
          },
        },
      ],
    },
  };
}
