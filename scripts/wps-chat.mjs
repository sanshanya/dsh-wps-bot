#!/usr/bin/env node
/**
 * wps-chat skill 执行面（第二轮 §9：历史/reply 均为 skill+script，不注册模型 tool）。
 *
 * 用法：
 *   node wps-chat.mjs history [--chat-id ID] [--limit 30] [--sender NAME] [--keyword KW] [--file ABS]
 *   node wps-chat.mjs reply --text TEXT [--chat-id ID]
 *
 * 契约：
 * - history 只读本地归档（historyFilePath 单源寻址；--file 显式优先，否则 .wps_context.json 供给）。
 * - reply 经 openapi 直发 markdown；凭据 ONLY 走环境变量 WPS365_CLIENT_ID/SECRET（+可选 WPS365_API_BASE），
 *   参数面永不携带凭据（GA auth runtime-managed 纪律）。
 * - 全部输出 JSON；失败写 stderr + exit 1。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { kso1Signature, ksoDate } from "../lib/signature.js";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) { out[key] = true; }
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

async function readContext(cwd) {
  try {
    return JSON.parse(await readFile(join(cwd, ".wps_context.json"), "utf-8"));
  } catch {
    return null;
  }
}

function fail(message) {
  process.stderr.write(`wps-chat: ${message}\n`);
  process.exit(1);
}

/* ---------------- history：本地归档只读 ---------------- */

async function cmdHistory(args) {
  const ctx = await readContext(process.cwd());
  const chatId = typeof args["chat-id"] === "string" ? args["chat-id"] : ctx?.chatId;
  const file = typeof args.file === "string"
    ? args.file
    : typeof ctx?.historyFile === "string"
      ? ctx.historyFile
      : null;
  if (file === null) fail("缺归档落点：--file 或在带 .wps_context.json 的会话工作区执行");
  const limit = Math.min(50, Math.max(1, Number(args.limit ?? 30) || 30));
  let lines;
  try {
    lines = (await readFile(file, "utf-8")).split("\n").filter((l) => l.trim() !== "");
  } catch {
    process.stdout.write(JSON.stringify({ chatId: chatId ?? null, hits: [] }) + "\n");
    return;
  }
  const keyword = typeof args.keyword === "string" ? args.keyword.trim() : "";
  const sender = typeof args.sender === "string" ? args.sender : "";
  const hits = lines
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e !== null)
    .filter((e) => sender === "" || e.senderName === sender || e.senderUserId === sender)
    .filter((e) => keyword === "" || String(e.text ?? "").includes(keyword))
    .slice(-limit)
    .map((e) => `[${new Date(Number(e.ts) * 1000).toISOString()}] ${e.senderName}: ${String(e.text ?? "").slice(0, 500)}`);
  process.stdout.write(JSON.stringify({ chatId: chatId ?? null, archive: file, hits }) + "\n");
}

/* ---------------- reply：openapi markdown 直发（凭据只吃 env） ---------------- */

async function fetchToken(apiBase, clientId, clientSecret) {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  }).toString();
  const res = await fetch(`${apiBase}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) fail(`oauth token HTTP ${res.status}`);
  const data = await res.json();
  if (typeof data.access_token !== "string" || data.access_token === "") fail("oauth token 响应缺 access_token");
  return data.access_token;
}

async function cmdReply(args) {
  const ctx = await readContext(process.cwd());
  const chatId = typeof args["chat-id"] === "string" ? args["chat-id"] : ctx?.chatId;
  if (typeof chatId !== "string" || chatId === "") fail("缺 chatId：--chat-id 或会话 .wps_context.json");
  const text = typeof args.text === "string" ? args.text
    : typeof args["text-file"] === "string" ? await readFile(args["text-file"], "utf-8")
    : "";
  if (text.trim() === "") fail("缺 --text（或 --text-file）");
  const clientId = process.env.WPS365_CLIENT_ID ?? "";
  const clientSecret = process.env.WPS365_CLIENT_SECRET ?? "";
  if (clientId === "" || clientSecret === "") fail("缺 WPS365_CLIENT_ID/WPS365_CLIENT_SECRET 环境变量——凭据只走 env（纪律：参数面无凭据）");
  const apiBase = process.env.WPS365_API_BASE ?? "https://openapi.wps.cn";
  const token = await fetchToken(apiBase, clientId, clientSecret);
  const uri = "/v7/messages/create";
  const body = Buffer.from(JSON.stringify({
    type: "text",
    receiver: { receiver_id: chatId, type: "chat" },
    content: { text: { content: text, type: "markdown" } },
  }), "utf8");
  const date = ksoDate();
  const res = await fetch(`${apiBase}${uri}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Kso-Date": date,
      "X-Kso-Authorization": `KSO-1 ${clientId}:${kso1Signature({ method: "POST", uri, date, body, clientSecret })}`,
      Authorization: `Bearer ${token}`,
    },
    body,
  });
  const text2 = await res.text();
  if (!res.ok) fail(`send HTTP ${res.status}: ${text2.slice(0, 300)}`);
  process.stdout.write(JSON.stringify({ chatId, delivered: true, response: text2.slice(0, 500) }) + "\n");
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
if (cmd === "history") await cmdHistory(args);
else if (cmd === "reply") await cmdReply(args);
else fail("usage: wps-chat.mjs history|reply …");
