import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

import { kso1Signature, ksoDate } from "../src/signature.ts";

test("KSO-1 签名：与 GA _headers 的 signing 串逐字节一致", () => {
  const body = Buffer.from(JSON.stringify({ a: 1 }), "utf8");
  const date = "Sun, 15 Aug 2026 08:30:00 GMT";
  const digest = createHash("sha256").update(body).digest("hex");
  const signing = `KSO-1POST/v7/messages/createapplication/json${date}${digest}`;
  const expected = createHmac("sha256", "sekret").update(signing).digest("hex");
  const actual = kso1Signature({
    method: "post",
    uri: "/v7/messages/create",
    date,
    body,
    clientSecret: "sekret",
  });
  assert.equal(actual, expected);
});

test("KSO-1 签名：空 body → digest 为空串（GA: digest = sha256(body) or ''）", () => {
  const date = "Sun, 15 Aug 2026 08:30:00 GMT";
  const signing = `KSO-1GET/v7/chats/abc/messagesapplication/json${date}`;
  const expected = createHmac("sha256", "sekret").update(signing).digest("hex");
  const actual = kso1Signature({
    method: "GET",
    uri: "/v7/chats/abc/messages",
    date,
    body: Buffer.alloc(0),
    clientSecret: "sekret",
  });
  assert.equal(actual, expected);
});

test("ksoDate：RFC 1123 GMT（GA formatdate(usegmt=True) 等价）", () => {
  const date = new Date("2026-08-15T08:30:00.000Z");
  assert.equal(ksoDate(date), "Sat, 15 Aug 2026 08:30:00 GMT");
});
