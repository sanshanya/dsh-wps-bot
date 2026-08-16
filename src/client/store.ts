/**
 * 配置页 store：把 `settings.describe`（分层已脱敏的 wps-bot 命名空间视图）
 * 与 `llm.providers` / `llm.models`（注册表拓扑）汇成一张快照。host 是
 * 唯一的真相来源：每次变更都走 wire 写穿，随后由推送来的失效通知驱动
 * 重新加载再渲染。控制器骨架对齐 better-model-provider 的 store.ts。
 *
 * @module dsh-wps-bot/client/store
 */

import type {
  ConfigurableProviderView, ModelProviderGroup, SettingsNamespaceView, SettingsPathOpView,
} from './wire.ts'
import { HarnessRpcError, messageOf, unwrap } from './wire.ts'

/** 本页编辑的 settings 命名空间。 */
export const WPS_BOT_NS = 'wps-bot'

/** 本页消费的 Remote 面（per-method pick，mock 恰好实现这个面）。 */
export interface WpsBotRemoteApi {
  settings: {
    describe(request: Record<string, never>, signal?: AbortSignal): Promise<import('./wire.ts').RpcResponse<{
      writable: boolean
      hasDocument: boolean
      namespaces: SettingsNamespaceView[]
    }>>
    mutate(request: {
      ns: string
      ops: SettingsPathOpView[]
      expectedRevision?: number
    }): Promise<import('./wire.ts').RpcResponse<SettingsNamespaceView>>
  }
  llm: {
    providers(request: Record<string, never>, signal?: AbortSignal): Promise<import('./wire.ts').RpcResponse<{
      providers: ConfigurableProviderView[]
    }>>
    models(request: Record<string, never>, signal?: AbortSignal): Promise<import('./wire.ts').RpcResponse<{
      groups: ModelProviderGroup[]
      failures: { id: string; name: string; message: string }[]
    }>>
  }
}

/** 页面快照。 */
export interface WpsBotState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** 载入期/写期的错误文本（人话）。 */
  error: string | null
  /** describe 级开关：false 时禁用一切写控件。 */
  writable: boolean
  /** 本命名空间的脱敏分层视图 + revision。 */
  namespace: SettingsNamespaceView | undefined
  /** 可配置的提供方目录。 */
  providers: ConfigurableProviderView[]
  /** 注册表模型目录。 */
  groups: ModelProviderGroup[]
}

/** A tiny snapshot store: one value, subscribe/getSnapshot, notify on set. */
export interface SnapshotStore<T> {
  getSnapshot(): T
  setSnapshot(next: T): void
  subscribe(listener: () => void): () => void
}

/** Create one snapshot store with identity-stable reads between updates. */
export function createSnapshotStore<T>(initial: T): SnapshotStore<T> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    setSnapshot(next) {
      if (Object.is(next, snapshot)) return
      snapshot = next
      const pending = Array.from(listeners)
      for (const listener of pending) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/**
 * The page controller: one async join plus the write path the form drives.
 * Not a Cordis store — the client plugin owns its instance directly.
 */
export class WpsBotController {
  readonly store: SnapshotStore<WpsBotState> = createSnapshotStore<WpsBotState>({
    status: 'idle',
    error: null,
    writable: true,
    namespace: undefined,
    providers: [],
    groups: [],
  })

  constructor(private readonly api: WpsBotRemoteApi) {}

  /** Latest load generation; older responses are never allowed to publish. */
  private generation = 0
  /** Abort the previous read when a newer invalidation supersedes it. */
  private activeAbort: AbortController | undefined
  /** Prevent a disposed plugin fiber from receiving a late response. */
  private disposed = false

  /** Stop in-flight reads and make every later response a no-op. */
  dispose(): void {
    this.disposed = true
    this.generation += 1
    this.activeAbort?.abort()
    this.activeAbort = undefined
  }

  /** Latest-wins 读带着 abort 篱：旧响应永不允许发布到渲染面。 */
  load(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const generation = ++this.generation
    this.activeAbort?.abort()
    const abort = new AbortController()
    this.activeAbort = abort
    return this.runLoad(generation, abort.signal).finally(() => {
      if (this.activeAbort === abort) this.activeAbort = undefined
    })
  }

  /** 首载后的刷新——保留最后接受的快照，草稿与行错误不被清空。 */
  reload(): Promise<void> {
    return this.load()
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation
  }

  private async runLoad(generation: number, signal: AbortSignal): Promise<void> {
    const current = this.store.getSnapshot()
    // 只有首载清空页面：后台刷新继续展示最后接受的快照。
    if (current.namespace === undefined) {
      this.store.setSnapshot({ ...current, status: 'loading', error: null })
    }
    try {
      // Remote 方法是 payload-direct：空对象是这些读唯一被接受的请求。
      const [settings, directory, catalog] = await Promise.all([
        this.api.settings.describe({}, signal).then(unwrap),
        this.api.llm.providers({}, signal).then(unwrap),
        this.api.llm.models({}, signal).then(unwrap),
      ])
      if (!this.isCurrent(generation)) return
      const namespace = settings.namespaces.find(entry => entry.ns === WPS_BOT_NS)
      this.store.setSnapshot({
        status: 'ready',
        error: null,
        writable: settings.writable,
        namespace,
        providers: directory.providers,
        groups: catalog.groups,
      })
    } catch (error) {
      if (!this.isCurrent(generation)) return
      if (error instanceof Error && error.name === 'AbortError') return
      this.store.setSnapshot({ ...this.store.getSnapshot(), status: 'error', error: messageOf(error) })
    }
  }

  /**
   * 路径寻址的写：optimistic-concurrency 带着 describe 时的 revision，
   * 陈旧的编辑器被拒绝而不是静默覆盖并发改动。成功时采用返回的新视图。
   */
  async save(ops: SettingsPathOpView[]): Promise<void> {
    const current = this.store.getSnapshot()
    const namespace = current.namespace
    if (namespace === undefined) throw new HarnessRpcError('settings-rejected', 'namespace not loaded')
    const next = unwrap(await this.api.settings.mutate({
      ns: WPS_BOT_NS,
      ops,
      expectedRevision: namespace.revision,
    }))
    this.store.setSnapshot({ ...this.store.getSnapshot(), namespace: next, error: null })
  }
}
