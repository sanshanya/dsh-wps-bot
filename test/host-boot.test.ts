import test from "node:test";
import assert from "node:assert/strict";

/**
 * 端到端宿主装配自证（无网络）：
 *  真 cordis 接线（apply()）+ 假 fetch（不存在的 REST 出站）+ 假 WS 事件源 ——
 *  走「SDK 真接器 → dispatcher → 规范化 → 分诊 → 会话事件（假回包）→ 出站」。
 *
 * 这一层只信两点是真实装配面而非臆造：
 *   - `dss` 事件帧的形状取 open-event-sdk `V7NotificationAppChatMessageCreateData`
 *   - `session/event` 的 wire shape 取 packages/core/session/src/types.ts:252
 *
 * 依赖 node_modules 里 symlink 的 @deepseek-ai/* 与 open-event-sdk——缺了则整组跳。
 */

const can = await import("../src/index.ts").then(
  () => true,
  () => false,
);

if (!can) {
  await test("宿主装配自证（node_modules 缺 symlink，全组跳）", { skip: true }, () => {});
} else {
  const { apply } = (await import("../src/index.ts")) as any;
  const { WpsBotCore } = (await import("../src/bot.ts")) as any;

  interface HandleRecord {
    followups: string[];
    injects: string[];
    disposed: number;
  }

  function makeHost(overrides: Record<string, unknown> = {}) {
    const listeners = new Map<string, Array<{ handler: (...args: unknown[]) => unknown; prepend: boolean }>>();
    const effects: Array<{ fn: (() => unknown) | (() => () => unknown); scope?: string }> = [];
    const disposers: Array<() => Promise<void>> = [];
    const handlesBySession = new Map<string, { handle: unknown; record: HandleRecord; running: { running: boolean } }>();
    const idev = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      on(event: string, handler: (...args: unknown[]) => unknown, prepend = false) {
        const list = listeners.get(event) ?? [];
        list.push({ handler, prepend });
        listeners.set(event, list);
        return () => {};
      },
      effect(fn: (() => unknown) | (() => () => unknown), scope?: string) {
        effects.push({ fn, scope });
        const out = fn();
        if (typeof out === "function") disposers.push(out as () => Promise<void>);
      },
      agents: {
        async create(opts: Record<string, unknown>) {
          return makeHandle(String(opts.sessionId));
        },
        async resume(opts: Record<string, unknown>) {
          return makeHandle(String(opts.resumeSessionId));
        },
      },
      tools: {
        register(tool: unknown) {
          (ivi.ctxTools as unknown[]).push(tool);
        },
      },
      userQuestions: { registerProvider: () => {} },
      ...overrides,
    };
    function makeHandle(sessionId: string) {
      const record: HandleRecord = { followups: [], injects: [], disposed: 0 };
      const state = { running: false };
      const handle = {
        agent: {
          session: { id: sessionId },
          get status() {
            return state.running ? "running" : "idle";
          },
          followup(message: { content: Array<{ type: string; text: string }> }) {
            record.followups.push(message.content[0]!.text);
            state.running = true;
          },
          inject(message: { content: Array<{ type: string; text: string }> }) {
            if (!state.running) return;
            record.injects.push(message.content[0]!.text);
          },
        },
        async dispose() {
          record.disposed += 1;
        },
      };
      handlesBySession.set(sessionId, { handle, record, running: state });
      return handle;
    }
    const installCalls: Array<{ ctx: unknown; ns: string; entry: unknown }> = [];
    const ivi = {
      ctxTools: [] as unknown[],
      installCalls,
      installStub: (c: unknown, ns: string, _schema: unknown, entry: unknown) => {
        installCalls.push({ ctx: c, ns, entry });
      },
      idev,
      handlesBySession,
      async dispose() {
        for (const d of disposers) await d();
      },
      sessions(sessionId: string) {
        return handlesBySession.get(sessionId) as { handle: unknown; record: HandleRecord; running: { running: boolean } } | undefined;
      },
      fire(eventCode: string, ...args: unknown[]) {
        const list = listeners.get(eventCode) ?? [];
        const prepends = list.filter((l) => l.prepend);
        const normal = list.filter((l) => !l.prepend);
        for (const kind of [...prepends, ...normal]) void kind.handler(...args);
      },
      listeners,
      effects,
    };
    return ivi;
  }

  function makeClient(): {
    sends: Array<{ chatId: string; markdown: string; mention: boolean }>;
    cards: Array<{ chatId: string; markdown: string; title: string }>;
    updates: Array<{ messageId: string; markdown: string }>;
    recalls: string[];
    fake: any;
  } {
    const self: any = {
      sends: [],
      cards: [],
      updates: [],
      recalls: [],
    };
    self.fake = {
      async sendMarkdown(chatId: string, text: string, mentions?: unknown[]) {
        self.sends.push({ chatId, markdown: text, mention: Boolean(mentions?.length) });
        return {};
      },
      async sendMarkdownSplit(chatId: string, text: string, mention: unknown) {
        self.sends.push({ chatId, markdown: text, mention: mention !== null });
        return ["m-1"];
      },
      async sendCard(chatId: string, markdown: string, title: string) {
        self.cards.push({ chatId, markdown, title });
        return "card-1";
      },
      async updateCard(messageId: string, markdown: string) {
        self.updates.push({ messageId, markdown });
        return {};
      },
      async recallMessage(messageId: string) {
        self.recalls.push(messageId);
        return {};
      },
      async resolveMention() {
        return null;
      },
      async currentServicePrincipal() {
        return { id: "sp-1", company_id: "corp-1" };
      },
      getMessages() {
        return Promise.resolve({ ok: true, data: { messages: [] } });
      },
    };
    return self;
  }

  function baseConfig() {
    // 每次独立目录：E2E- 间共享 seenEventsPath 会把同 id 事件拟拒
    const dir = `/tmp/wps-bot-e2e-${Math.random().toString(36).slice(2)}`;
    return {
      clientId: "app-1",
      clientSecret: "sek",
      spId: "sp-1",
      workspaceRoot: "/tmp/wps-bot-ws",
      seenEventsPath: `${dir}/seen.jsonl`,
      auditPath: `${dir}/audit.jsonl`,
      cardMode: "card",
      approvalMode: "windows",
      approvalTimeoutSeconds: 10,
      deliverChunks: 4500,
    } as any;
  }

  function frameBotMessage(chatType = "group"): unknown {
    // SDK V8 帧：content.text 是 string（open-event-sdk@1.0.1 V7MessageContent）
    return {
      eventCode: "kso.app_chat.message.create",
      data: JSON.stringify({
        company_id: "corp-1",
        chat: { id: "chat-42", type: chatType },
        sender: {
          type: "user",
          id: "u-1",
          extended_attribute: { name: "张三" },
        },
        send_time: 1700000000,
        message: {
          id: "msg-1",
          type: "text",
          content: { text: "#第一份出栈答数：" },
          mentions: chatType === "group" ? [{ type: "user", id: "sp-1", offset: 0, length: 1 }] : [],
        },
      }),
    };
  }

  interface PusheyBag {
    pusher: ((event: unknown) => Promise<unknown>) | null;
  }
  function makePushey(): { bag: PusheyBag; factory: unknown } {
    const bag: PusheyBag = { pusher: null };
    const factory = (opts: { dispatcher: { handle(event: unknown): Promise<void> } }) => {
      bag.pusher = (event) => opts.dispatcher.handle(event);
      return { async start() {}, stop() {} };
    };
    return { bag, factory };
  }

  async function waitFor(pred: () => boolean, ms = 80): Promise<void> {
    for (let i = 0; i < ms; i++) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(pred(), "等待超时");
  }

  test("E2E-1：假 WS 帧 → 分诊进入保持会话 → 中间旁白不入群 → turn/end completed 才交终态文本", async () => {
    const ivi = makeHost();
    const client = makeClient();
    const pushey = makePushey();
    apply(ivi.idev, baseConfig(), { client: client.fake, makeEventClient: pushey.factory as any, installSettingsSection: ivi.installStub });
    await new Promise((r) => setTimeout(r, 30));

    // 1) 真 SDK dispatcher 帧 → direct → followup → 会话在跑
    await pushey.bag.pusher!(frameBotMessage("p2p"));
    await waitFor(() => [...ivi.handlesBySession.keys()].length === 1);
    const k1 = [...ivi.handlesBySession.keys()][0]!;
    // 评估 P0-1 生产级断言：create 收到的 sessionId 必须是准任务会话键（不存在第二 wps-bot: 前缀）
    const dek = k1.split(":");
    assert.equal(dek.length, 4, `任务会话键非四段(${dek.length})：${k1}`);
    const s1 = ivi.sessions(k1)!;
    assert.ok(s1.record.followups[0]!.includes("第一份出栈答数"));
    assert.ok(s1.running.running);
    assert.equal((ivi.listeners.get("session/event") ?? []).length, 1);
    // P0-1 生死线：turn/end 在 setPhase(idle) 前发射——drain 只能靠 agent/status(idle) 触发
    assert.equal((ivi.listeners.get("agent/status") ?? []).length, 1);
    assert.equal((ivi.listeners.get("approval/request") ?? []).length, 1);
    assert.equal((ivi.listeners.get("approval/request") ?? [])[0]!.prepend, true); // prepend waterfall
    // 第二轮 §11.4 极简 tool 验收:finish_task 独存，reply/search_wps_history 不得注册
    const registeredToolNames = ivi.ctxTools.map((t) => (t as { name?: string }).name);
    assert.ok(registeredToolNames.includes("finish_task"), `finish_task 未注册 (${registeredToolNames.join(",")})`);
    for (const banned of ["reply", "search_wps_history"]) {
      assert.ok(!registeredToolNames.includes(banned), `${banned} 不得再注册 (${registeredToolNames.join(",")})`);
    }

    // 设置节无条件注册（无凭据态页面=凭据入口——回归锚点）
    assert.deepEqual(ivi.installCalls.map((c) => c.ns), ["wps-bot"]);

    // 2) 中间旁白——fire 真引用（与 handle.agent.session 同一对象；假引用是 E2E-1 漏测根因）
    const sessionRef = (s1.handle as { agent: { session: unknown } }).agent.session;
    ivi.fire("session/event", sessionRef, {
      type: "assistant/message",
      data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "我先查一下" }] } },
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(client.sends.filter((s) => s.markdown.includes("我先查一下")).length, 0);

    // 3) turn/end completed → 只交付终态
    s1.running.running = false;
    ivi.fire("session/event", sessionRef, {
      type: "assistant/message",
      data: { turn: 1, step: 2, message: { content: [{ type: "text", text: "终态答案：42" }] } },
    });
    ivi.fire("session/event", sessionRef, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
    await waitFor(() => client.sends.some((s) => s.markdown.includes("终态答案：42")));
    assert.equal(client.sends.filter((s) => s.markdown.includes("终态答案")).length, 1);
    await ivi.dispose();
  });

  test("E2E-2：防自答过滤——sender.type=app 且 id 命中 clientId → 不入分诊", async () => {
    const ivi = makeHost();
    const client = makeClient();
    const pushey = makePushey();
    apply(ivi.idev, baseConfig(), { client: client.fake, makeEventClient: pushey.factory as any, installSettingsSection: ivi.installStub });
    await new Promise((r) => setTimeout(r, 30));

    const raw = frameBotMessage("p2p") as { data: string };
    const parsed = JSON.parse(raw.data) as { sender: { type: string; id: string } };
    parsed.sender = { type: "app", id: "app-1" };
    await pushey.bag.pusher!({ ...raw, data: JSON.stringify(parsed) });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(ivi.handlesBySession.size, 0);
    assert.equal(client.sends.length, 0);
    await ivi.dispose();
  });

  test("E2E-3：审批上坡道——问题先行、群答「同意」→ allowed-once、audit 入账", async () => {
    const ivi = makeHost();
    const client = makeClient();
    const pushey = makePushey();
    apply(ivi.idev, baseConfig(), { client: client.fake, makeEventClient: pushey.factory as any, installSettingsSection: ivi.installStub });
    await new Promise((r) => setTimeout(r, 30));
    await pushey.bag.pusher!(frameBotMessage("p2p"));
    await waitFor(() => ivi.handlesBySession.size === 1);

    // 引擎调 prepend 的 approval/request 上行
    const approval = (ivi.listeners.get("approval/request") ?? [])[0]!.handler as (
      req: unknown,
      next: () => Promise<string>,
    ) => Promise<string>;
    const req = {
      agent: (ivi.sessions([...ivi.handlesBySession.keys()][0]!)!.handle as { agent: unknown }).agent,
      toolName: "pwsh",
      reason: "测试操作",
      signal: { aborted: false },
    };
    const waiters = new Promise<string>((resolve) => {
      void (approval(req, async () => "rejected") as Promise<string>).then((outcome) => resolve(outcome));
    });
    await waitFor(() => client.sends.some((s) => s.markdown.includes("需要确认的操作")));
    // 评估 P0-1 导出断言：receiver 路径收到的 chatId 必须纯聊无任务键残（防二次前缀）
    assert.ok(client.sends.every((s) => !s.chatId.includes(":")), `receiver id 含 : —— sessionKey 外泄: ${client.sends.map((x) => x.chatId).join(",")}`);
    assert.ok(client.sends[0]!.markdown.includes("测试操作"));

    // 群答「同意」走真事件帧
    await pushey.bag.pusher!(
      (() => {
        const raw = frameBotMessage("p2p") as { data: string };
        const parsed = JSON.parse(raw.data) as {
          message: { id: string; content: { text: string } };
        };
        parsed.message.id = "msg-2";
        parsed.message.content.text = "同意";
        return { ...raw, data: JSON.stringify(parsed) };
      })(),
    );
    assert.equal(await waiters, "allowed-once");
    await waitFor(() => client.sends.some((s) => s.markdown === "操作已批准。"));
    await ivi.dispose();
  });

}
