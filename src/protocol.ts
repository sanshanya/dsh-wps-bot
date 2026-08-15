/**
 * WPS 365 事件 canonical 化 + content 解析（wire 面）。
 *
 * 迁移来源：
 *  - ksbot_ga/bridge/wps_event_normalize.mjs（normalize 的形状与 mentions/diff 逻辑）
 *  - ksbot_ga/src/ga_wps/protocol.py（canonical 字段面、残差语义）
 *
 * v0 的 content 解析只覆盖 text / rich_text 基础节点。
 * 未知节点类型按 GA 残差语义落 unparsed 记录（不做静默丢弃）。
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

/** kso.app_chat.message.create 事件 data 的最小形状（正常形态由 bridge 约定）。 */
export interface RawMessageEventData {
  message?: Record<string, unknown>;
  content?: Record<string, unknown>;
  mentions?: unknown[];
  chat?: { id?: string; type?: string };
  chat_id?: string;
  sender?: { id?: string; name?: string; sender_name?: string; type?: string; app_id?: string };
  message_id?: string;
  event_id?: string;
  quote_msg_id?: string;
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

function identityMatchesBot(
  identity: Record<string, unknown> | undefined,
  botIds: string[],
): boolean {
  if (!identity || !["sp", "app"].includes(String(identity.type))) return false;
  const id = [identity.app_id, identity.id].map(String);
  return id.some((value) => value && botIds.includes(value));
}

function mentionsSync(
  rawMentions: unknown,
  content: Record<string, unknown> | null,
  botIds: string[],
): boolean {
  const mentions = Array.isArray(rawMentions) ? rawMentions : [];
  if (
    mentions.some((item) =>
      identityMatchesBot(
        isRecord(item) && isRecord(item.identity) ? item.identity : undefined,
        botIds,
      ),
    )
  ) {
    return true;
  }
  const rich = content?.rich_text as Record<string, unknown> | undefined;
  const rows = (rich?.elements ?? rich?.content) as unknown;
  if (!Array.isArray(rows)) return false;
  return rows.some((row) => {
    const elements = isRecord(row) && Array.isArray(row.elements) ? row.elements : [row];
    return (elements as unknown[]).some(
      (item) =>
        isRecord(item) &&
        item.type === "mention" &&
        identityMatchesBot(
          isRecord(item.mention_content) && isRecord((item.mention_content as Record<string, unknown>).identity)
            ? ((item.mention_content as Record<string, unknown>).identity as Record<string, unknown>)
            : undefined,
          botIds,
        ),
    );
  });
}

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

/** 解析 content 为 text + 附件 + 云文档 + unparsed。 */
export function parseContent(content: unknown): ParsedContent {
  const parsed: ParsedContent = {
    text: "",
    attachments: [],
    cloudDocLinks: [],
    sharedDocIds: [],
    unparsed: [],
    evidenceBearing: false,
  };
  if (!isRecord(content)) {
    if (content !== null && content !== undefined) {
      parsed.unparsed.push({
        path: "content",
        reason: "non-object-content",
        value: content,
      });
      parsed.evidenceBearing = true;
    }
    return parsed;
  }

  const text = content.text as Record<string, unknown> | undefined;
  if (typeof text?.content === "string") {
    parsed.text = text.content;
  }

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
        /** mention 节点只补 @显示名，不回灌 identity 给模型 */
        const inner = raw.mention_content as Record<string, unknown> | undefined;
        const name = String(inner?.name ?? inner?.content ?? "");
        parsed.text += name ? `@${name}` : "@";
        return;
      }
      case "file":
      case "attachment":
      case "media":
      case "image": {
        const attachment: Attachment = {
          kind: type,
          storageKey: String(
            raw.storage_key ?? raw.file_token ?? raw.file_id ?? raw.url ?? "",
          ),
          name: String(raw.name ?? raw.file_name ?? ""),
          size: Number(raw.size ?? 0) || 0,
          mime: String(raw.mime ?? raw.mime_type ?? ""),
        };
        parsed.attachments.push(attachment);
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

  parsed.evidenceBearing =
    parsed.attachments.length > 0 ||
    parsed.cloudDocLinks.length > 0 ||
    parsed.sharedDocIds.length > 0 ||
    parsed.unparsed.length > 0;
  return parsed;
}

/**
 * kso.app_chat.message.create 事件 → canonical WpsEvent。
 * 逐行迁移 ksbot_ga/bridge/wps_event_normalize.mjs 的字段面。
 */
export function normalizeEventData(
  data: RawMessageEventData,
  botIds: string[],
  eventId: string,
): WpsEvent | null {
  const message = isRecord(data?.message) ? data.message : {};
  const content = isRecord(message.content)
    ? message.content
    : isRecord(data?.content)
      ? data.content
      : isRecord(data?.message as unknown)
        ? (data.message as Record<string, unknown>)
        : null;
  const mentions = Array.isArray(message.mentions) && message.mentions.length
    ? message.mentions
    : Array.isArray(data?.mentions)
      ? data.mentions
      : [];
  const chatId = String(data?.chat?.id ?? data?.chat_id ?? "");
  if (!chatId) return null;

  const parsed = parseContent(content);
  const mentioned = mentionsSync(mentions, content, botIds);

  return {
    chatId,
    chatType: String(data?.chat?.type ?? ""),
    eventId: String(
      message.id ?? data?.message_id ?? data?.event_id ?? eventId ?? "",
    ),
    quoteMsgId: String(message.quote_msg_id ?? data?.quote_msg_id ?? ""),
    senderId: String(data?.sender?.id ?? ""),
    senderName: String(data?.sender?.name ?? data?.sender?.sender_name ?? ""),
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

/** 服务主体自带消息不计入用户行为（bridge.mjs:26-27 的过滤语义）。 */
export function isSelfEvent(
  sender: RawMessageEventData["sender"],
  botIds: string[],
): boolean {
  if (!sender) return false;
  if (!["app", "sp"].includes(String(sender.type))) return false;
  return [sender.id, sender.app_id]
    .map(String)
    .some((id) => id && botIds.includes(id));
}
