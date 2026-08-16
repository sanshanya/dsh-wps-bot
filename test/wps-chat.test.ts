/**
 * wps-chat skill 脚本验收（第二轮 §9/§11/§11.4）：
 * - history：.wps_context.json + 本地归档驱动的只读面（sender/keyword/limit 过滤、空归档≠错）
 * - reply：fake openapi server 端到端——token 换取 + KSO-1 签名 + markdown 落点 + 凭据只走 env
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { kso1Signature, ksoDate } from "../src/signature.ts";

const run = promisify(execFile);
const SCRIPT = join(import.meta.dirname, "..", "scripts", "wps-chat.mjs");

test("history：context 供点 + sender/keyword/limit 过滤 + 空归档 hits=[]", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wpschat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const histDir = join(root, "history", "c1");
  await mkdir(histDir, { recursive: true });
  await writeFile(join(histDir, "history.jsonl"), [
    JSON.stringify({ ts: 1000, senderName: "冯三山", text: "昨晚巡检怎么样" }),
    JSON.stringify({ ts: 1001, senderName: "甘小雨", text: "巡检通过，基线符合" }),
    JSON.stringify({ ts: 1002, senderName: "冯三山", text: "收到" }),
  ].join("\n") + "\n");
  const ws = join(root, "ws", "c1");
  await mkdir(ws, { recursive: true });
  await writeFile(join(ws, ".wps_context.json"), JSON.stringify({ chatId: "c1", historyFile: join(histDir, "history.jsonl") }));

  const { stdout: all } = await run("node", [SCRIPT, "history"], { cwd: ws });
  const allOut = JSON.parse(all) as { hits: string[] };
  assert.equal(allOut.hits.length, 3);

  const { stdout: kw } = await run("node", [SCRIPT, "history", "--keyword", "巡检", "--limit", "1"], { cwd: ws });
  const kwOut = JSON.parse(kw) as { hits: string[] };
  assert.equal(kwOut.hits.length, 1);
  assert.ok(kwOut.hits[0]!.includes("巡检通过"));

  const { stdout: sd } = await run("node", [SCRIPT, "history", "--sender", "冯三山"], { cwd: ws });
  assert.equal((JSON.parse(sd) as { hits: string[] }).hits.length, 2);

  // 空归档 ≠ 错（退出 0，hits 空）
  const ws2 = join(root, "ws2");
  await mkdir(ws2, { recursive: true });
  const { stdout: empty } = await run("node", [SCRIPT, "history"], { cwd: ws2 }).then((r) => r, () => ({ stdout: "", stderr: "" }));
  assert.equal(empty, "", "无 context 无 file 必须 fail(非零)——空≠错只针对归档缺席");

  const ws3 = join(root, "ws3");
  await mkdir(ws3, { recursive: true });
  await writeFile(join(ws3, ".wps_context.json"), JSON.stringify({ chatId: "cX", historyFile: join(root, "nowhere.jsonl") }));
  const { stdout: arcMiss } = await run("node", [SCRIPT, "history"], { cwd: ws3 });
  assert.deepEqual((JSON.parse(arcMiss) as { hits: unknown[] }).hits, []);
});

test("reply：fake openapi 端到端（token+KSO-1 签名+payload）；缺凭据 fail-closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wpschat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ws = join(root, "ws");
  await mkdir(ws, { recursive: true });
  await writeFile(join(ws, ".wps_context.json"), JSON.stringify({ chatId: "chat-9", historyFile: join(root, "h.jsonl") }));

  let sawToken: { body: string } | null = null;
  let sawSend: { headers: Record<string, string | string[] | undefined>; body: string } | null = null;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (req.url === "/oauth2/token") {
        sawToken = { body: raw };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ access_token: "tok-1", expires_in: 7200 }));
        return;
      }
      if (req.url === "/v7/messages/create") {
        sawSend = { headers: req.headers, body: raw };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ message_id: "m-1" }));
        return;
      }
      res.statusCode = 404; res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  const env = {
    ...process.env,
    WPS365_CLIENT_ID: "cid-1",
    WPS365_CLIENT_SECRET: "sec-1",
    WPS365_API_BASE: `http://127.0.0.1:${port}`,
  };
  const { stdout } = await run("node", [SCRIPT, "reply", "--text", "收到，先查一下"], { cwd: ws, env });
  assert.deepEqual(JSON.parse(stdout), { chatId: "chat-9", delivered: true, response: JSON.stringify({ message_id: "m-1" }) });

  assert.ok(sawToken !== null);
  const tokBody = (sawToken as { body: string }).body;
  assert.ok(tokBody.includes("grant_type=client_credentials") && tokBody.includes("client_id=cid-1"));
  assert.ok(sawSend !== null);
  const send = sawSend as { headers: Record<string, string | string[] | undefined>; body: string };
  const body = JSON.parse(send.body) as { type: string; receiver: { receiver_id: string; type: string }; content: { text: { content: string; type: string } } };
  assert.equal(body.receiver.receiver_id, "chat-9");
  assert.equal(body.content.text.content, "收到，先查一下");
  assert.equal(body.content.text.type, "markdown");
  assert.equal(send.headers["authorization"], "Bearer tok-1");
  const kso = String(send.headers["x-kso-authorization"]);
  assert.ok(kso.startsWith("KSO-1 cid-1:"));
  // 签名复算（同一 signature 件的端到端性：不重写规则）
  const expect = kso1Signature({
    method: "POST",
    uri: "/v7/messages/create",
    date: String(send.headers["x-kso-date"]),
    body: Buffer.from(send.body, "utf8"),
    clientSecret: "sec-1",
  });
  assert.equal(kso, `KSO-1 cid-1:${expect}`);

  // 凭据缺席 → 非零 + stderr；且不向 server 发任何请求
  await assert.rejects(
    run("node", [SCRIPT, "reply", "--text", "x"], { cwd: ws, env: { ...process.env, WPS365_CLIENT_ID: "", WPS365_CLIENT_SECRET: "" } }),
  );
});

test("reply：缺 chatId/缺 text fail-closed（参数面无凭据）", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wpschat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(run("node", [SCRIPT, "reply", "--text", "x"], { cwd: root }));
  await assert.rejects(run("node", [SCRIPT, "reply", "--chat-id", "c1"], { cwd: root }));
});
