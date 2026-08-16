/**
 * user-questions 通道代答面（R6/P-B）：questions 服务群问+quote 绑定消费。
 *
 * @module dsh-wps-bot/task-questions
 */

import { parseTaskKey } from "./task-keys.ts";
import type { WpsEvent } from "./protocol.ts";

interface PendingQuestion {
  userId: string;
  messageIds: string[];
  resolve: (answer: string) => void;
  cancel: (reason: Error) => void;
}

export interface QuestionsClient {
  resolveMention(userId: string, name?: string): Promise<unknown>;
  sendMarkdownSplit(chatId: string, text: string, mention: unknown): Promise<string[]>;
}

export interface QuestionsSessions {
  getRequester(sessionId: string): { userId: string; name: string } | undefined;
}

export class TaskQuestionsService {
  private readonly pending = new Map<string, PendingQuestion>();

  private readonly deps: {
    client: QuestionsClient;
    sessions: QuestionsSessions;
    chatForAgent: (agent: unknown) => string | null;
    logger: { warn(...args: unknown[]): void };
  };

  constructor(deps: TaskQuestionsService["deps"]) {
    this.deps = deps;
  }

  async ask(request: {
    questions: Array<{ id: string; question: string; detail?: string; header?: string; options?: Array<{ label: string }> }>;
    agent?: unknown;
    signal?: { aborted: boolean; addEventListener?: (evt: string, cb: () => void) => void };
  }): Promise<{ answers: Array<{ id: string; selected: string[]; custom?: string }> }> {
    const agentLike = request.agent as { session?: { id?: unknown } } | undefined;
    const sessionId = String(agentLike?.session?.id ?? "");
    const parsedKey = parseTaskKey(sessionId);
    const chatId = parsedKey !== null ? parsedKey.chatId : this.deps.chatForAgent(request.agent);
    if (chatId === null) {
      const e = new Error("wps-bot: 无从落聊的租答请求");
      (e as { code?: string }).code = "NO_CHAT_BINDING";
      throw e;
    }
    const requester = this.deps.sessions.getRequester(sessionId);
    const parts: string[] = ["## 需要你的回答"];
    request.questions.forEach((q, index) => {
      parts.push(`**${q.header ?? `问题 ${index + 1}/${request.questions.length}`}**\n\n${q.question}`);
      if (q.detail) parts.push(q.detail);
      if (q.options !== undefined && q.options.length > 0) {
        parts.push(q.options.map((option, i) => `${i + 1}) ${option.label}`).join("  "));
      }
    });
    parts.push("回复本条（引用）+ 你的答案：序号/选项名/自由文本均可。");
    const mention =
      requester === undefined
        ? null
        : await this.deps.client.resolveMention(requester.userId, requester.name).catch(() => null);
    const messageIds = await this.deps.client.sendMarkdownSplit(chatId, parts.join("\n\n"), mention);

    // L3-4：先验 aborted 再发包；监听挂后须可摘（abortHook）
    if (request.signal?.aborted === true) {
      const e0 = new Error("wps-bot: 租答请求遭中止");
      (e0 as { code?: string }).code = "ASK_ABORTED";
      throw e0;
    }
    const text = await new Promise<string>((resolve, reject) => {
      const selfDelete = (entry: PendingQuestion) => {
        if (this.pending.get(sessionId) === entry) this.pending.delete(sessionId);
      };
      const entry: PendingQuestion = {
        userId: requester?.userId ?? "",
        messageIds,
        resolve: (answer) => {
          if ((entry as { settled?: boolean }).settled === true) return;
          (entry as { settled?: boolean }).settled = true;
          selfDelete(entry);
          resolve(answer);
        },
        cancel: (reason) => {
          if ((entry as { settled?: boolean }).settled === true) return;
          (entry as { settled?: boolean }).settled = true;
          selfDelete(entry);
          reject(reason);
        },
      };
      if (requester === undefined) { entry.cancel(new Error("wps-bot: 无从知位相相者")); return; }
      const oldPending = this.pending.get(sessionId);
      if (oldPending !== undefined) oldPending.cancel(Object.assign(new Error("wps-bot: 新问件覆盖了旧问相答允"), { code: "ASK_OVERRIDDEN" }));
      this.pending.set(sessionId, entry);
      if (request.signal?.addEventListener) {
        const onAbort = () => {
          const e = new Error("wps-bot: 租答请求遭中止");
          (e as { code?: string }).code = "ASK_ABORTED";
          entry.cancel(e);
        };
        request.signal.addEventListener("abort", onAbort);
        const withRemoval = <A,>(fn: (arg: A) => void) => (arg: A) => {
          const remover = (request.signal as unknown as { removeEventListener?: (evt: string, cb: () => void) => void }).removeEventListener;
          if (typeof remover === "function") remover.call(request.signal, "abort", onAbort);
          fn(arg);
        };
        entry.resolve = withRemoval(entry.resolve);
        entry.cancel = withRemoval(entry.cancel);
      }
    });

    return {
      answers: request.questions.map((q, index) => {
        const hit = q.options?.find((o, i) => text === String(i + 1) || text === o.label);
        if (index !== 0) return { id: q.id, selected: [] as string[] };
        return hit !== undefined ? { id: q.id, selected: [hit.label] } : { id: q.id, selected: [] as string[], custom: text };
      }),
    };
  }

  /** 消费 quote-答允：命中即 resolve；返回 true=已处理。 */
  async consume(ev: WpsEvent, sameChat: (sessionId: string) => boolean): Promise<boolean> {
    for (const [sessionId, question] of this.pending) {
      if (!sameChat(sessionId) || question.userId !== ev.senderId || !question.messageIds.includes(ev.quoteMsgId)) continue;
      question.resolve(ev.text.trim());
      return true;
    }
    return false;
  }

  cancelAll(reason: Error): void {
    for (const [, question] of [...this.pending]) question.cancel(reason);
  }
}
