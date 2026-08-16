/**
 * 浏览器端线面类型：直接 TYPE-ONLY 引用 dsh 发布的客户端契约
 * （`@deepseek-ai/dsh-api-remotes/client`），上游漂移即编译期失败，
 * 而不是浏览器里的事故。import 全是 type-only，运行时零依赖。
 *
 * @module dsh-wps-bot/client/wire
 */

import type { RpcError } from '@deepseek-ai/dsh-api-remotes/client'

export type {
  ConfigurableProviderView,
  ModelProviderGroup,
  RpcResponse,
  SettingsNamespaceView,
  SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'

/**
 * secrets 槽条目的本地结构声明（上游 SettingsSecretView 未经
 * dsh-api-remotes/client 转出口；字段契约见 settings.d.ts）。
 */
export interface SecretSlotView {
  /** 从 section 根到被摘除字段的路径。 */
  path: string[]
  /** 槽当前是否持有值（值永不下线）。 */
  set: boolean
}

/** settings.describe 的载荷形态（契约方法签名见 dsh-host-apiproxy api/settings.d.ts）。 */
export interface SettingsDescribeView {
  writable: boolean
  hasDocument: boolean
  namespaces: import('@deepseek-ai/dsh-api-remotes/client').SettingsNamespaceView[]
}

/** 带着 wire code 的业务失败——调用方按语义分支（如 settings-conflict）。 */
export class HarnessRpcError extends Error {
  constructor(
    /** 关闭的上游错误码并集，绝非自由字符串。 */
    readonly code: RpcError['code'],
    message: string,
    readonly details?: RpcError['details'],
  ) {
    super(message)
    this.name = 'HarnessRpcError'
  }
}

/** 人话的失败文本。 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 拆 Remote 信封：业务失败抛类型化 wire 错误。 */
export function unwrap<T>(response: import('@deepseek-ai/dsh-api-remotes/client').RpcResponse<T>): T {
  if (!response.result.ok) {
    throw new HarnessRpcError(response.result.error.code, response.result.error.message, response.result.error.details)
  }
  return response.result.value
}
