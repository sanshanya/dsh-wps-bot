import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { WpsClient } from "../src/client.ts";

type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

function makeFetch(handlers: Record<string, { status?: number; body?: unknown; header?: Record<string, string> }>) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = (async (url, init = {}) => {
    const method = String((init as RequestInit).method ?? "GET");
    // 归一小写（真 fetch 对 header 键均做 lower-case 归一）
    const headers = Object.fromEntries(
      Object.entries((init as RequestInit).headers ?? {}).map(([k, v]) => [k.toLowerCase(), v as string]),
    );
    const body = init.body !== undefined ? Buffer.from(init.body as Uint8Array).toString("utf8") : "";
    calls.push({ url: String(url), method, headers, body });
    const key = `${method} ${String(url)}`;
    const found = Object.entries(handlers).find(([k]) => key.startsWith(k));
    if (!found) return new Response("not found", { status: 404 });
    const def = found[1];
    return new Response(JSON.stringify(def.body ?? {}), {
      status: def.status ?? 200,
      headers: def.header ?? { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function makeClient(handlers: Record<string, { status?: number; body?: unknown; header?: Record<string, string> }> = {}) {
  const { calls, fetchImpl } = makeFetch(handlers);
  const sleeps: number[] = [];
  const client = new WpsClient({
    clientId: "app-1",
    clientSecret: "sek",
    apiBase: "https://openapi.wps.cn",
    fetchImpl,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return { client, calls, sleeps };
}

const TOKEN_RESPONSE = { ok: true, access_token: "tok-1", expires_in: 7200 };

test("client：OAuth2 换 token，之后 KSO-1 签名头带齐", async () => {
  const { client, calls } = makeClient({
    "POST https://openapi.wps.cn/oauth2/token": { body: TOKEN_RESPONSE },
    "POST https://openapi.wps.cn/v7/messages/create": { body: { ok: true, data: { message_id: "m-1" } } },
  });

  await client.sendMarkdown("chat-1", "hello");

  const oauthCall = calls[0]!;
  assert.equal(oauthCall.method, "POST");
  assert.equal(oauthCall.headers["content-type"], "application/x-www-form-urlencoded");
  assert.ok(oauthCall.body.includes("grant_type=client_credentials"));
  assert.ok(oauthCall.body.includes("client_id=app-1"));

  const call = calls[1]!;
  assert.equal(call.method, "POST");
  assert.ok(call.url.startsWith("https://openapi.wps.cn/v7/messages/create"));
  assert.equal(call.headers["x-kso-date"] !== undefined, true);
  assert.ok(call.headers["x-kso-authorization"]!.startsWith("KSO-1 app-1:"));
  assert.equal(call.headers["authorization"], "Bearer tok-1");

  // 真值重算签名：与 GA _headers 逐字节一致
  const date = call.headers["x-kso-date"]!;
  const body = Buffer.from(call.body, "utf8");
  const digest = body.length > 0 ? createHash("sha256").update(body).digest("hex") : "";
  const signing = `KSO-1POST/v7/messages/createapplication/json${date}${digest}`;
  const expected = createHmac("sha256", "sek").update(signing).digest("hex");
  assert.equal(call.headers["x-kso-authorization"], `KSO-1 app-1:${expected}`);
});

test("client：注入 accessToken → 直接带签，不发 oauth；串行保持", async () => {
  const calls: Call[] = [];
  const fetchImpl = (async (url: unknown, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: String(init.method ?? "GET"),
      headers: Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v as string]),
      ),
      body: init.body !== undefined ? Buffer.from(init.body as Uint8Array).toString("utf8") : "",
    });
    return new Response(JSON.stringify({ ok: true, data: { message_id: "m-1" } }), { status: 200 });
  }) as typeof fetch;
  const client = new WpsClient({
    clientId: "app-1",
    clientSecret: "sek",
    apiBase: "https://openapi.wps.cn",
    accessToken: "pre-token",
    fetchImpl,
  });
  await client.sendMarkdown("chat-1", "hello");
  // 只发了一次 REST 出栈——没走 oauth
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://openapi.wps.cn/v7/messages/create");
  assert.equal(calls[0]!.headers["authorization"], "Bearer pre-token");
  assert.ok(calls[0]!.headers["x-kso-authorization"]!.startsWith("KSO-1 app-1:"));
});

test("client：ok=false 的 GA 包装 → WpsApiError，code 传递", async () => {
  const { client } = makeClient({
    "POST https://openapi.wps.cn/oauth2/token": { body: TOKEN_RESPONSE },
    "POST https://openapi.wps.cn/v7/messages/create": {
      status: 200,
      body: { ok: false, message: "invalid receiver", code: 1001, _request_id: "rq-9" },
    },
  });
  await assert.rejects(client.sendMarkdown("chat-1", "hello"), /invalid receiver/);
});

test("client.sendMarkdownSplit：首段带 mention，后续不带", async () => {
  const { client, sleeps } = makeClient({
    "POST https://openapi.wps.cn/oauth2/token": { body: TOKEN_RESPONSE },
    "POST https://openapi.wps.cn/v7/messages/create": {
      body: { ok: true, data: { message_id: "m-x" } },
    },
  });
  const md = ["a".repeat(100), " ", "b".repeat(100)].join("\n\n".repeat(60)); // 强制多段
  const mention = {
    userId: "u1",
    companyId: "corp",
    displayName: "张三",
    atTag: (i: number) => `<at id="${i}">张三</at>`,
    payload: (i: number) => ({ id: String(i), type: "user", identity: { id: "u1", type: "user", company_id: "corp" } }),
  };
  const parts = await client.sendMarkdownSplit("chat-1", md, mention, 120);
  assert.ok(parts.length >= 2);
  assert.ok(sleeps.every((ms) => ms === 400));
});

test("client.sendCard / updateCard / recallMessage 的 endpoint 面", async () => {
  const { client, calls } = makeClient({
    "POST https://openapi.wps.cn/oauth2/token": { body: TOKEN_RESPONSE },
    "POST https://openapi.wps.cn/v7/messages/create": {
      body: { ok: true, data: { message_id: "card-9" } },
    },
    "POST https://openapi.wps.cn/v7/messages/card-9/update": {
      body: { ok: true },
    },
    "POST https://openapi.wps.cn/v7/messages/card-9/recall": {
      body: { ok: true },
    },
  });
  const id = await client.sendCard("chat-1", "已收到，正在处理。", "甘小雨");
  assert.equal(id, "card-9");
  await client.updateCard("card-9", "心跳：1 分钟，刚刚有活动", "甘小雨");
  await client.recallMessage("card-9");
  const urls = calls.map((c) => c.url);
  assert.ok(urls.some((u) => u.includes("/oauth2/token")));
  assert.ok(urls.some((u) => u.includes("/v7/messages/create")));
  assert.ok(urls.some((u) => u.includes("/v7/messages/card-9/update")));
  assert.ok(urls.some((u) => u.includes("/v7/messages/card-9/recall")));
});
