/**
 * WPS 365 客户端：认证、加签、错误包装、消息/卡片收发、mention 解析。
 *
 * 逐行迁移 ksbot_ga/src/ga_wps/client.py：
 *  - _access_token    （oauth2/client_credentials + 过期前 300s 提前刷新）
 *  - _headers        （KSO-1 签名 + Bearer）
 *  - _ok / _error_fields / _message_id / _data
 *  - send_markdown / send_card / update_card / recall_message / send_markdown_split
 *  - resolve_mention
 *  - send_markdown_split 的 mention 只带首段、at_tag(1) 语义
 *
 * 与 GA 的差异仅为实现语言（fetch 替 requests），所有 wire 面保持一致。
 *
 * @module dsh-wps-bot/client
 */

import { kso1Signature, ksoDate } from "./signature.ts";
import { splitMarkdown } from "./split.ts";

export class WpsApiError extends Error {
  readonly operation: string;
  readonly status: number | null;
  readonly code: number | string | null;
  readonly requestId: string;

  constructor(
    operation: string,
    message: string,
    opts: { status?: number; code?: number | string; requestId?: string } = {},
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
    code: (value.code as number | string | undefined) ?? (value.errcode as number | string | undefined) ?? null,
    requestId: String(value._request_id ?? value.request_id ?? ""),
  };
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
    const parts = splitMarkdown(markdown, limit);
    const ids: string[] = [];
    for (let index = 0; index < parts.length; index++) {
      let part = parts[index] as string;
      const first = index === 0 && mention;
      if (first && mention) part = `${mention.atTag(1)}\n\n${part}`;
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

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
