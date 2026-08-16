import test from "node:test";
import assert from "node:assert/strict";

/**
 * 最小复演：index.ts「session/event 同一性双闸」把 chatId 误传给 handleSessionEvent。
 *
 * 背景（src/index.ts:332-344，HEAD=dd4ea7e/e3137f5）：
 *   void ctx.on("session/event", (session, event) => {
 *     let chatId = null;
 *     for (const [candidate, entry] of chats)
 *       if (entry.handle?.agent?.session === session) { chatId = candidate; break; }
 *     core.handleSessionEvent(chatId ?? String(session?.id ?? ""), event);
 *   });
 *
 * handleSessionEvent(sessionId, event)（src/bot.ts:387-389）内部第一行是
 *   const chatId = this.chatForSessionIdFn(sessionId); if (chatId === null) return;
 * 即入参是 sessionId（如 "wps-bot:chat-42"），再由 chatForSessionId 反查 chatId。
 *
 * 真机里 session/event 的第一个参数就是 Agent.session 同一个对象
 * （DSH packages/core/session/src/index.ts:639 `callbackArgs = [this, event]`，
 *  `this` 即 Session；packages/core/agent/src/runtime-types.ts:70 `Agent.session` 是同一实例）。
 * 所以 identity 命中后 chatId=「chat-42」被当作 sessionId 传入，
 * chatForSessionId("chat-42") 找不到 session.id==="chat-42" 的条目 → 恒 null → 事件被吞。
 *
 * 常设套件 host-boot.test.ts E2E-1 之所以绿，是因为它 fire 的是另一个 `{id:...}` 对象
 * （对象引用不等 → 双闸不命中 → 落到 String(session.id) 兜底），掩盖了真机路径。
 *
 * 本文件 fire 的是「与 handle.agent.session 同一引用」的 session 对象，模拟真机，
 * 断言终态文本应被交付；当前实现下该断言失败 = 复演成立。
 */

const { apply } = (await import("../src/index.ts")) as any;

interface FakeRec {
  followups: string[];
  injects: string[];
  running: boolean;
}

function makeHost() {
  const listeners = new Map<string, Array<{ handler: (...a: unknown[]) => unknown; prepend: boolean }>>();
  const handles = new Map<string, { handle: unknown; record: FakeRec }>();

  const makeHandle = (sessionId: string) => {
    const record: FakeRec = { followups: [], injects: [], running: false };
    const session = { id: sessionId };
    const handle = {
      agent: {
        session,
        get status() {
          return record.running ? "running" : "idle";
        },
        followup(msg: { content: Array<{ type: string; text: string }> }) {
          record.followups.push(msg.content[0]!.text);
          record.running = true;
        },
        inject(msg: { content: Array<{ type: string; text: string }> }) {
          if (!record.running) return;
          record.injects.push(msg.content[0]!.text);
        },
      },
      async dispose() {},
    };
    handles.set(sessionId, { handle, record });
    return handle;
  };

  const idev = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on(event: string, handler: (...a: unknown[]) => unknown, prepend = false) {
      const list = listeners.get(event) ?? [];
      list.push({ handler, prepend });
      listeners.set(event, list);
      return () => {};
    },
    effect(fn: () => unknown) {
      fn();
    },
    agents: {
      async create(opts: Record<string, unknown>) {
        return makeHandle(String(opts.sessionId));
      },
      async resume(opts: Record<string, unknown>) {
        return makeHandle(String(opts.resumeSessionId));
      },
    },
  };

  return {
    idev,
    handles,
    fire(event: string, ...args: unknown[]) {
      const list = listeners.get(event) ?? [];
      const prepends = list.filter((l) => l.prepend);
      const normal = list.filter((l) => !l.prepend);
      for (const kind of [...prepends, ...normal]) void kind.handler(...args);
    },
    sessionObject(sessionId: string) {
      return (handles.get(sessionId)!.handle as { agent: { session: unknown } }).agent.session;
    },
  };
}

function makeClient() {
  const self: {
    sends: string[];
    fake: Record<string, unknown>;
  } = { sends: [], fake: {} };
  self.fake = {
    async sendMarkdown(_chatId: string, text: string) {
      self.sends.push(text);
      return {};
    },
    async sendMarkdownSplit(_chatId: string, text: string) {
      self.sends.push(text);
      return ["m-1"];
    },
    async sendCard() {
      return "card-1";
    },
    async updateCard() {
      return {};
    },
    async recallMessage() {
      return {};
    },
    async resolveMention() {
      return null;
    },
  };
  return self;
}

function baseConfig() {
  const dir = `/tmp/wps-bot-g2-${Math.random().toString(36).slice(2)}`;
  return {
    clientId: "app-1",
    clientSecret: "sek",
    spId: "sp-1",
    workspaceRoot: "/tmp/wps-bot-ws",
    seenEventsPath: `${dir}/seen.jsonl`,
    auditPath: `${dir}/audit.jsonl`,
    cardMode: "off",
    approvalMode: "windows",
    approvalTimeoutSeconds: 10,
    deliverChunks: 4500,
  };
}

function p2pFrame() {
  return {
    eventCode: "kso.app_chat.message.create",
    data: JSON.stringify({
      company_id: "corp-1",
      chat: { id: "chat-42", type: "p2p" },
      sender: { type: "user", id: "u-1", extended_attribute: { name: "张三" } },
      send_time: 1700000000,
      message: { id: "msg-1", type: "text", content: { text: "开个任务" } },
    }),
  };
}

test("同一引用 session/event 也能把终态文本交付（真机路径；现实现吞事件）", async () => {
  const host = makeHost();
  const client = makeClient();
  const pushey: { push: ((ev: unknown) => Promise<unknown>) | null } = { push: null };
  const factory = (opts: { dispatcher: { handle(ev: unknown): Promise<void> } }) => {
    pushey.push = (ev) => opts.dispatcher.handle(ev);
    return { async start() {}, stop() {} };
  };

  apply(host.idev, baseConfig(), { client: client.fake, makeEventClient: factory });
  await new Promise((r) => setTimeout(r, 30));

  await pushey.push!(p2pFrame());
  await new Promise((r) => setTimeout(r, 20));

  // 真机形状：session/event 的第一参数与 handle.agent.session 是同一对象
  const sessionObj = host.sessionObject("wps-bot:chat-42");
  const record = host.handles.get("wps-bot:chat-42")!.record;

  host.fire("session/event", sessionObj, {
    type: "assistant/message",
    data: { turn: 1, step: 2, message: { content: [{ type: "text", text: "终态答案：42" }] } },
  });
  record.running = false;
  host.fire("session/event", sessionObj, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  await new Promise((r) => setTimeout(r, 30));

  assert.ok(
    client.sends.some((s) => s.includes("终态答案：42")),
    "同一引用的 session/event 应触发终态交付；实际事件被吞（chatId 被当作 sessionId 反查失败）",
  );
});
