/**
 * WPS 365 事件 canonical 化（wire 面）——与 `open-event-sdk@1.0.1` 的 `dist/event/model/index.d.ts`
 * 逐字对齐（`V7NotificationAppChatMessageCreateData` / `V7NotificationMessageInfo` /
 * `V7NotificationChatInfo` / `V7Identity` / `V7MessageContent` / `V7ChatMessageMention`），
 * 并保留 rich_text 的向前兼容识别（若未来 wire 新增富文本节点，不静默丢）。
 *
 * 与 ksbot_ga/bridge 的形状差异（本项目照 SDK 真值，不照 GA 先验）：
 *  - `content.text` 是 string（GA 的旧 normalize 按 `{content}` 解；SDK 真值是 string）
 *  - content 只三档 text/image/file（GA 的 rich_text 语义在 SDK 里不存在；保留兼容识别）
 *  - `sender` 无 name 字段（GA 按 `sender.name`；SDK 真值是 `extended_attribute.name`）
 *  - `sender.type` 值域 `user|app|service_principal`（GA 按 `'sp'`）
 *  - 事件对象无 per-event uuid → eventId 只能是 `message.id`（与 GA 回退一致）
 *
 * @module dsh-wps-bot/protocol
 */

export interface Attachment {
  kind: string;
  storageKey: string;
  name: string;
  size: number;
  mime: string;
}

export interface UnparsedNode {
  path: string;
  reason: string;
  value: unknown;
}

export interface ParsedContent {
  text: string;
  attachments: Attachment[];
  cloudDocLinks: string[];
  sharedDocIds: string[];
  unparsed: UnparsedNode[];
  /** GA evidence_bearing 判定面：带附件/云文档/shared_doc_ids/unparsed 的消息永不走运行中注入 */
  evidenceBearing: boolean;
}

/** Credentials 用的自述 sender 类型（GA: app/sp；SDK 真值： user/app/service_principal）。 */
const SELF_TYPES = new Set(["app", "sp", "service_principal"]);

export interface V7IdentityLike {
  type?: string;
  id?: string;
  app_id?: string;
  extended_attribute?: { source?: string; name?: string } | null;
}

export interface V7MessageContentLike {
  text?: string;
  image?: { file_id?: string } | null;
  file?: { file_id?: string; name?: string } | null;
  /** SDK 1.0.1 之外的老 wire：若回拉参到哪里历史节点识别保留 */
  rich_text?: unknown;
}

export interface V7MentionLike {
  type?: string;
  id?: string;
  offset?: number;
  length?: number;
  /** 老 wire：mention 壳在 message.content.rich_text.elements 里 */
  mention_content?: { name?: string; identity?: Record<string, unknown> };
}

export interface V7MessageLike {
  id?: string;
  type?: string;
  content?: V7MessageContentLike | unknown;
  mentions?: V7MentionLike[];
  quote_msg_id?: string;
}

/** kso.app_chat.message.create 事件 data（或 data 中套着的 message）的最小形状（SDK 真值）。 */
export interface RawMessageEventData {
  company_id?: string;
  chat?: { id?: string; type?: string };
  chat_id?: string;
  sender?: V7IdentityLike;
  send_time?: number;
  message?: V7MessageLike;
  message_id?: string;
  event_id?: string;
  quote_msg_id?: string;
  /** 老 wire 兼容：data.content 直接当 content */
  content?: unknown;
  mentions?: unknown[];
}

export interface WpsEvent {
  chatId: string;
  chatType: string;
  eventId: string;
  quoteMsgId: string;
  senderId: string;
  senderName: string;
  mentioned: boolean;
  botIds: string[];
  text: string;
  attachments: Attachment[];
  cloudDocLinks: string[];
  sharedDocIds: string[];
  unparsed: UnparsedNode[];
  evidenceBearing: boolean;
  isPrivate: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mentionsSync(message: V7MessageLike | undefined, botIds: string[]): boolean {
  if (message === undefined || !Array.isArray(message.mentions)) return false;
  return (message.mentions as V7MentionLike[]).some(
    (m) => typeof m?.id === "string" && m.id.length > 0 && botIds.includes(m.id),
  );
}

/** rich_text 兼容识别（SDK 新 wire 无 rich_text 也不走这条路径）。 */
function flattenRichElements(content: Record<string, unknown> | null): unknown[] {
  const rich = content?.rich_text as Record<string, unknown> | undefined;
  const rows = (rich?.elements ?? rich?.content) as unknown;
  if (!Array.isArray(rows)) return [];
  const out: unknown[] = [];
  for (const row of rows) {
    if (isRecord(row) && Array.isArray(row.elements)) out.push(...row.elements);
    else out.push(row);
  }
  return out;
}

function attachmentFrom(content: V7MessageContentLike | unknown, key: string, kind: string): Attachment | null {
  if (!isRecord(content)) return null;
  const node = content[key as keyof typeof content];
  if (!isRecord(node)) return null;
  const fileId = typeof node.file_id === "string" ? node.file_id : typeof node.storage_key === "string" ? node.storage_key : typeof node.url === "string" ? node.url : "";
  if (!fileId) return null;
  return {
    kind,
    storageKey: fileId,
    name: typeof node.name === "string" ? node.name : "",
    size: typeof node.size === "number" ? node.size : 0,
    mime: typeof node.mime === "string" ? node.mime : "",
  };
}

const CONTENT_KNOWN_KEYS = new Set(["text", "image", "file", "rich_text"]);

/** SDK 1.0.1 content 形状：text string 为主，image/file 定值；细节未知一律 unparsed（空 evidence）。 */
export function parseContent(content: unknown): ParsedContent {
  const parsed: ParsedContent = {
    text: "",
    attachments: [],
    cloudDocLinks: [],
    sharedDocIds: [],
    unparsed: [],
    evidenceBearing: false,
  };
  if (content === null || content === undefined) return parsed;
  if (!isRecord(content)) {
    parsed.unparsed.push({ path: "content", reason: "non-object-content", value: content });
    parsed.evidenceBearing = true;
    return parsed;
  }

  const record = content as Record<string, unknown>;

  if (typeof record.text === "string") parsed.text = record.text;

  const image = attachmentFrom(record, "image", "image");
  if (image) parsed.attachments.push(image);
  const file = attachmentFrom(record, "file", "file");
  if (file) parsed.attachments.push(file);

  const elements = flattenRichElements(content);
  elements.forEach((raw, index) => {
    const path = `rich_text.elements[${index}]`;
    if (!isRecord(raw)) {
      parsed.unparsed.push({ path, reason: "non-record-element", value: raw });
      return;
    }
    const type = String(raw.type ?? "");
    switch (type) {
      case "text": {
        const inner = raw.text as Record<string, unknown> | undefined;
        const piece = inner?.content ?? raw.content;
        if (typeof piece === "string") parsed.text += piece;
        return;
      }
      case "mention": {
        const inner = raw.mention_content as Record<string, unknown> | undefined;
        const name = String(inner?.name ?? inner?.content ?? "");
        parsed.text += name ? `@${name}` : "@";
        return;
      }
      case "file":
      case "attachment":
      case "media":
      case "image": {
        const fileId = String(raw.storage_key ?? raw.file_token ?? raw.file_id ?? raw.url ?? "");
        if (fileId) {
          parsed.attachments.push({
            kind: type,
            storageKey: fileId,
            name: String(raw.name ?? raw.file_name ?? ""),
            size: Number(raw.size ?? 0) || 0,
            mime: String(raw.mime ?? raw.mime_type ?? ""),
          });
        }
        return;
      }
      case "cloud_doc": {
        const url = raw.url ?? raw.link;
        if (typeof url === "string") parsed.cloudDocLinks.push(url);
        const docId = raw.doc_id ?? raw.shared_doc_id ?? raw.file_id;
        if (typeof docId === "string") parsed.sharedDocIds.push(docId);
        return;
      }
      case "":
      case "undefined": {
        parsed.unparsed.push({ path, reason: "missing-type", value: raw });
        return;
      }
      default: {
        parsed.unparsed.push({ path, reason: `unparsed-type:${type}`, value: raw });
      }
    }
  });

  for (const key of Object.keys(record)) {
    if (!CONTENT_KNOWN_KEYS.has(key)) {
      parsed.unparsed.push({ path: `content.${key}`, reason: "unknown-content-key", value: record[key] });
    }
  }

  parsed.evidenceBearing =
    parsed.attachments.length > 0 ||
    parsed.cloudDocLinks.length > 0 ||
    parsed.sharedDocIds.length > 0 ||
    parsed.unparsed.length > 0;
  return parsed;
}

/** kso.app_chat.message.create 事件 → canonical WpsEvent（SDK 真值的 `data` 形状）。 */
export function normalizeEventData(
  data: RawMessageEventData,
  botIds: string[],
  eventId: string,
): WpsEvent | null {
  const message = (isRecord(data?.message) ? data.message : undefined) as V7MessageLike | undefined;
  // content 三层回退（与 GA Bridge 一致，但.Primary 路径是 SDK `message.content`）
  const content: unknown =
    message?.content ??
    (isRecord(data?.content) ? data.content : undefined) ??
    (message as unknown);
  const sender = data?.sender ?? {};
  const chatId = String(data?.chat?.id ?? data?.chat_id ?? "");
  if (!chatId) return null;

  const parsed = parseContent(content);
  const mentioned = mentionsSync(message, botIds);

  return {
    chatId,
    chatType: String(data?.chat?.type ?? ""),
    eventId: String(
      message?.id ?? data?.message_id ?? data?.event_id ?? eventId ?? "",
    ),
    quoteMsgId: String(message?.quote_msg_id ?? data?.quote_msg_id ?? ""),
    senderId: String(sender.id ?? ""),
    senderName: String(
      sender.extended_attribute?.name ?? "",
    ),
    mentioned,
    botIds,
    text: parsed.text,
    attachments: parsed.attachments,
    cloudDocLinks: parsed.cloudDocLinks,
    sharedDocIds: parsed.sharedDocIds,
    unparsed: parsed.unparsed,
    evidenceBearing: parsed.evidenceBearing,
    isPrivate: String(data?.chat?.type ?? "") === "p2p",
  };
}

/** 服务主体自带消息不计入用户行为（SDK: type=app|service_principal 且 id 命中 botIds）。 */
export function isSelfEvent(
  sender: V7IdentityLike | undefined,
  botIds: string[],
): boolean {
  if (!sender) return false;
  if (!SELF_TYPES.has(String(sender.type))) return false;
  return [sender.id, sender.app_id]
    .map(String)
    .some((id) => id && botIds.includes(id));
}
