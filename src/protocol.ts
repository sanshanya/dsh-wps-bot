/**
 * WPS 365 事件 canonical 化（wire 面）—— 双源对齐：
 *   ├── ksbot_ga/src/ga_wps/protocol.py:132-370（生产可证的 parser）
 *   └── wps-docs/docs/server/message/（官方面）
 *
 * 真值要点（修正此前按 SDK .d.ts 假造的差异）：
 *  1. message.content.text 是 { content: string }——.d.ts 的「text: string」是名不副实的
 *  2. mentions[].id 是「@ 索引」字符串（"1","2"…），identity.id / identity.app_id 才是被 @ 实体的真 id
 *  3. sender.type ∈ {user, sp, app, unknown}——bot 自产消息的 sender.id == spId
 *  4. bot 被 @ 的检测双通道：
 *     A. mentions[].identity.type ∈ {sp, app} 且 identity.id/app_id 命中 botIds（GA 主链）
 *     B. 文本中的 <at id="N">甘小雨</at> 按 botDisplayName 字面兜底匹配（GA 生产真机的另一路）
 *  5. rich_text 中的元素按 GA 的 vortex 识别（text/mention/doc/image/sticker/custom_emoji/line_break）
 *  6. file.cloud + file.local 分途（GA document()）；matured image/audio/video 走 media() 的 storage_key 必填
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
export interface UnparsedNode { path: string; reason: string; value: unknown }
export interface ParsedContent {
  text: string;
  attachments: Attachment[];
  cloudDocLinks: string[];
  sharedDocIds: string[];
  unparsed: UnparsedNode[];
  evidenceBearing: boolean;
}

const SELF_TYPES = new Set(["app", "sp", "service_principal"]);

export interface V7IdentityLike {
  type?: string;
  id?: string;
  app_id?: string;
  name?: string;
  sender_name?: string;
  extended_attribute?: { source?: string; name?: string } | null;
}
export interface V7MessageContentTextLike { content?: string; type?: string }
export interface V7MessageContentLike {
  text?: string | V7MessageContentTextLike;
  image?: { storage_key?: string; name?: string; size?: number | string } | null;
  file?: {
    type?: string;
    name?: string;
    local?: { name?: string; size?: string | number; storage_key?: string } | null;
    cloud?: { name?: string; id?: string; file_id?: string; link_id?: string; link_url?: string } | null;
  } | null;
  rich_text?: unknown;
}
export interface V7MentionIdentityLike {
  type?: string;
  id?: string;
  app_id?: string;
  name?: string;
  company_id?: string;
}
export interface V7MentionLike {
  id?: string;               // ⚠️ 这是「@ 索引」（"1","2"…），不是 user_id
  type?: string;             // user | all
  identity?: V7MentionIdentityLike | null;
  mention_content?: { name?: string; text?: string; identity?: V7MentionIdentityLike };
}
export interface V7MessageLike {
  id?: string;
  type?: string;
  content?: V7MessageContentLike | unknown;
  mentions?: V7MentionLike[];
  quote_msg_id?: string;
}
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

/** GA protocol.py:189-195 text_value —— str | {content: string} | {text: string} */
export function textValue(value: unknown): [string, boolean] {
  if (typeof value === "string") return [value, true];
  if (isRecord(value)) {
    if (typeof value.content === "string") return [value.content, true];
    if (typeof value.text === "string") return [value.text, true];
  }
  return ["", false];
}

/** <at id="N">name</at> 内联替换（GA protocol.py:178-186 inline 同名）；bot 命中时 name 置空 */
export function inlineMentions(input: string, resolve: (id: string, name: string) => string): string {
  if (!input || !input.toLowerCase().includes("<at")) return input;
  return input.replace(/<at\s+id=["\']([^"\']+)["\']\s*>([^<]*?)\s*<\/at>\s*/gi, (_m, id, name) =>
    resolve(String(id), String(name)),
  );
}

/** GA protocol.py:171-176 identity_name：identity 命中 bot_ids 时 name 置空（我们自己的 @ 不进正文）。 */
export function identityName(
  identity: unknown,
  label: string,
  botIds: string[],
): string {
  if (!isRecord(identity)) return label.trim();
  for (const key of ["app_id", "id"]) {
    const value = String((identity as Record<string, unknown>)[key] ?? "");
    if (value && botIds.includes(value)) return "";
  }
  return String(
    (identity as Record<string, unknown>).name ?? label ?? (identity as Record<string, unknown>).id ?? "",
  ).trim();
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

const CONTENT_KNOWN_KEYS = new Set([
  // GA protocol.py 只实际解 these；还有 location/vote/calendar/meeting/merge_forward 未经——落 unparsed 不静默吞
  "text", "image", "file", "rich_text", "audio", "video", "sticker", "card",
]);

function mediaAttachment(kind: string, source: unknown, path: string, into: ParsedContent): void {
  if (!isRecord(source)) {
    into.unparsed.push({ path, reason: `WPS ${kind} content is not an object`, value: source });
    return;
  }
  const storageKey =
    typeof source.storage_key === "string"
      ? source.storage_key
      : typeof (source as Record<string, unknown>).file_id === "string"
        ? String((source as Record<string, unknown>).file_id)
        : "";
  if (!storageKey) {
    into.unparsed.push({ path, reason: `WPS ${kind} content has no storage_key`, value: source });
    return;
  }
  into.attachments.push({
    kind,
    storageKey,
    name: String(source.name ?? (source as Record<string, unknown>).file_name ?? ""),
    size: typeof source.size === "number" ? source.size : Number(source.size ?? 0) || 0,
    mime: String(source.mime ?? (source as Record<string, unknown>).type ?? ""),
  });
}

/** GA protocol.py:246-257 document：Cloud 档记录 -> cloud 链接 + shared doc id。 */
function documentNode(source: unknown, path: string, title: string, into: ParsedContent): void {
  if (!isRecord(source)) return;
  const rec = source as Record<string, unknown>;
  const ids = ["id", "file_id", "link_id"].map((k) => String(rec[k] ?? "").trim()).filter(Boolean);
  const links = ["link_url", "url"].map((k) => String(rec[k] ?? "").trim()).filter(Boolean);
  const label = title || String(rec.name ?? "").trim();
  if (ids.length === 0 && links.length === 0) {
    into.unparsed.push({ path, reason: "WPS cloud document has no file id or link", value: source });
    if (!into.text.trim()) into.text = label ? `[doc:${label}]` : "[cloud-doc]";
    return;
  }
  for (const link of links) into.cloudDocLinks.push(link);
  for (const id of ids) into.sharedDocIds.push(id);
  if (!into.text.trim() && label) into.text = `[doc:${label}]`;
}

/** GA protocol.py:205-221 card_node 递归遍历 header/title/elements/... */
function cardNode(value: unknown, into: ParsedContent): void {
  const [text, mapped] = textValue(value);
  if (mapped) {
    if (text) into.text += text;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) cardNode(item, into);
    return;
  }
  if (!isRecord(value)) return;
  for (const key of ["header", "title", "elements", "table", "columns", "rows", "cells", "content", "value", "text"]) {
    if (key in value) cardNode(value[key], into);
  }
}

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
  const raw = content as Record<string, unknown>;

  // ---- 卡片优先展开（GA：卡片消息优先于 text） ----
  if (isRecord(raw.card)) cardNode(raw.card, parsed);
  else {
    // ---- text 三态 ----
    const [textBody, mapped] = textValue(raw.text);
    if (mapped) parsed.text = textBody;
  }

  // ---- image / audio / video / sticker ----
  if (isRecord(raw.image)) mediaAttachment("image", raw.image, "content.image", parsed);
  if (isRecord(raw.audio)) mediaAttachment("audio", raw.audio, "content.audio", parsed);
  if (isRecord(raw.video)) mediaAttachment("video", raw.video, "content.video", parsed);
  if (isRecord(raw.sticker)) mediaAttachment("sticker", raw.sticker, "content.sticker", parsed);

  // ---- file（GA: local / cloud 分途）----
  const file = raw.file;
  if (isRecord(file)) {
    const name = String(file.name ?? "");
    const fileType = String(file.type ?? "");
    const local = file.local;
    const cloud = file.cloud;
    if (fileType === "cloud" || isRecord(cloud)) {
      documentNode(cloud ?? file, "content.file.cloud", name, parsed);
    }
    if (isRecord(local)) mediaAttachment("file", local, "content.file.local", parsed);
    if (!isRecord(local) && !isRecord(cloud) && fileType !== "cloud") {
      parsed.unparsed.push({ path: "content.file", reason: "WPS file content is neither local nor cloud", value: file });
    }
  }

  // ---- rich_text 元素的 spot 识别 ----
  const elements = flattenRichElements(raw);
  elements.forEach((item, index) => {
    const path = `rich_text.elements[${index}]`;
    if (!isRecord(item)) {
      parsed.unparsed.push({ path, reason: "non-record-element", value: item });
      return;
    }
    const type = String(item.type ?? "");
    switch (type) {
      case "text": {
        const source = item.text_content ?? item.style_text_content ?? item.content ?? item.text;
        if (isRecord(source)) {
          const [t, ok] = textValue(source);
          if (ok) { parsed.text += t; return; }
        } else if (typeof source === "string") {
          parsed.text += source;
          return;
        }
        break;
      }
      case "emoji": {
        const c = (item.content as { content?: string } | undefined) ?? {};
        if (typeof c.content === "string") { parsed.text += c.content; return; }
        break;
      }
      case "custom_emoji": {
        mediaAttachment("custom_emoji", item.image_content ?? item, `${path}.image_content`, parsed);
        return;
      }
      case "mention": {
        const inner = (item.mention_content as { name?: string; text?: string; identity?: Record<string, unknown> } | undefined) ?? {};
        const name = identityName(inner.identity, String(inner.text ?? inner.name ?? ""), []);
        if (name) parsed.text += `@${name} `;
        return;
      }
      case "doc": {
        const doc = (item.doc_content as Record<string, unknown> | undefined) ?? {};
        documentNode(doc.file ?? doc, `${path}.doc_content`, String(doc.text ?? ""), parsed);
        return;
      }
      case "image": {
        mediaAttachment("image", item.image_content ?? item.content, `${path}.image_content`, parsed);
        return;
      }
      case "sticker": {
        mediaAttachment("sticker", (item.sticker as Record<string, unknown> | undefined) ?? item.image, `${path}.sticker`, parsed);
        return;
      }
      case "line_break":
      case "br": {
        parsed.text += "\n";
        return;
      }
    }
    parsed.unparsed.push({ path, reason: `unparsed-type:${type || "unknown"}`, value: item });
  });

  // ---- 未知 content 键记录 unparsed（GA 的残差弹簧要求） ----
  for (const key of Object.keys(raw)) {
    if (!CONTENT_KNOWN_KEYS.has(key)) {
      parsed.unparsed.push({ path: `content.${key}`, reason: "unknown-content-key", value: raw[key] });
    }
  }

  if (!parsed.text.trim()) {
    if (parsed.attachments.length > 0 || parsed.cloudDocLinks.length > 0 || parsed.sharedDocIds.length > 0) {
      parsed.text = "[attachment-only message]";
    } else if (parsed.unparsed.length > 0) {
      parsed.text = "[message content could not be fully normalized]";
    }
  }
  parsed.evidenceBearing =
    parsed.attachments.length > 0 ||
    parsed.cloudDocLinks.length > 0 ||
    parsed.sharedDocIds.length > 0 ||
    parsed.unparsed.length > 0;
  return parsed;
}

function byId(mentions: unknown): Map<string, V7MentionLike> {
  const out = new Map<string, V7MentionLike>();
  if (!Array.isArray(mentions)) return out;
  for (const m of mentions as V7MentionLike[]) {
    if (m && typeof m.id === "string" && m.id) out.set(m.id, m);
  }
  return out;
}

/** bot 是否被 @ —— 双通道（A 文档主链 / B 文本标记兜底）。 */
export function mentionMatched(
  message: V7MessageLike | undefined,
  botIds: string[],
  botDisplayName: string,
): { matched: boolean; matchedBy: "mentions" | "markup" | null } {
  if (message === undefined) return { matched: false, matchedBy: null };
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  for (const m of mentions) {
    const id = m?.identity;
    if (!id) continue;
    if (id.type === "all") return { matched: true, matchedBy: "mentions" };
    if (id.type === "sp" || id.type === "app") {
      for (const key of [String(id.id ?? ""), String(id.app_id ?? "")]) {
        if (key.length > 0 && botIds.includes(key)) return { matched: true, matchedBy: "mentions" };
      }
    }
  }
  // B 通道：text 中的 <at id="N">botDisplayName</at> 字面兜底
  if (botDisplayName) {
    const content = isRecord(message.content) ? (message.content as Record<string, unknown>) : {};
    const [body] = textValue(content.text);
    if (body.toLowerCase().includes("<at") &&
        body.toLowerCase().includes(`<at`) &&
        body.toLowerCase().includes(botDisplayName.toLowerCase())) {
      return { matched: true, matchedBy: "markup" };
    }
    // 或者在内容 rich_text 文本块中
    const rich = flattenRichElements(content);
    for (const item of rich) {
      if (!isRecord(item)) continue;
      const source = [(item as Record<string, unknown>).text_content, (item as Record<string, unknown>).style_text_content];
      for (const s of source) {
        if (!isRecord(s)) continue;
        const [text, ok] = textValue(s);
        if (ok && text.toLowerCase().includes(botDisplayName.toLowerCase()) && text.includes("<at")) {
          return { matched: true, matchedBy: "markup" };
        }
      }
    }
  }
  return { matched: false, matchedBy: null };
}

/** kso.app_chat.message.create → canonical WpsEvent（GA protocol.py 的字段面 vs wpbdocs 的真值） */
export function normalizeEventData(
  data: RawMessageEventData,
  botIds: string[],
  eventId: string,
  botDisplayName = "甘小雨",
): WpsEvent | null {
  const message = (isRecord(data?.message) ? data.message : undefined) as V7MessageLike | undefined;
  const content: unknown =
    message?.content ??
    (isRecord(data?.content) ? data.content : undefined) ??
    (message as unknown);
  const sender = data?.sender ?? {};
  const chatId = String(data?.chat?.id ?? data?.chat_id ?? "");
  if (!chatId) return null;
  const parsed = parseContent(content);
  const mentionCheck = mentionMatched(message, botIds, botDisplayName);

  const byIdMap = byId(message?.mentions);
  const text = inlineMentions(parsed.text, (id, name) => {
    // GA 语义：bot 名字面命中（识不到落置空）→ 置空（自家 @ 不进正文）
    if (botDisplayName && name.trim() === botDisplayName.trim()) return "";
    const m = byIdMap.get(id);
    const identity = m?.identity ?? {};
    const resolvedName = identityName(identity, name, botIds);
    return resolvedName ? `@${resolvedName} ` : "";
  });

  return {
    chatId,
    chatType: String(data?.chat?.type ?? ""),
    eventId: String(
      message?.id ?? data?.message_id ?? data?.event_id ?? eventId ?? "",
    ),
    quoteMsgId: String(message?.quote_msg_id ?? data?.quote_msg_id ?? ""),
    senderId: String(sender.id ?? ""),
    senderName: String(
      sender.name ?? sender.sender_name ?? sender.extended_attribute?.name ?? "",
    ),
    mentioned: mentionCheck.matched,
    botIds,
    text,
    attachments: parsed.attachments,
    cloudDocLinks: parsed.cloudDocLinks,
    sharedDocIds: parsed.sharedDocIds,
    unparsed: parsed.unparsed,
    evidenceBearing: parsed.evidenceBearing,
    isPrivate: String(data?.chat?.type ?? "") === "p2p",
  };
}

/** bot 自身消息一律不进入任务运行流（GA bridge 的第一道闸门）。 */
export function isSelfEvent(
  sender: V7IdentityLike | undefined,
  botIds: string[],
): boolean {
  if (!sender) return false;
  if (!SELF_TYPES.has(String(sender.type ?? ""))) return false;
  return [sender.id, sender.app_id]
    .map(String)
    .some((id) => id.length > 0 && botIds.includes(id));
}
