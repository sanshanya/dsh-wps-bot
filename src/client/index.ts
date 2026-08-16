/**
 * WPS Bot client half: registers one `settings.section` entry backed by its
 * own controller, keeps it fresh on every pushed invalidation (settings
 * document, llm adapters, connection reset), and owns the section's
 * stylesheet for the fiber lifetime. 结构逐面学 better-model-provider。
 *
 * @module dsh-wps-bot/client
 */

import { useSyncExternalStore } from 'react'
import { WpsBotController, WPS_BOT_NS } from './store.ts'
import type { WpsBotRemoteApi } from './store.ts'
import { WpsBotSection } from './WpsBotSection.tsx'
import type { WpsBotSectionInjected } from './WpsBotSection.tsx'
import { en, zh } from './locales.ts'
import { STYLES } from './styles.ts'

/** Stable plugin id — MUST equal the package name (module-loader entry id). */
export const name = 'dsh-wps-bot'

/** Cordis fiber dependencies of the browser half. */
export const inject = ['slots', 'locale', 'connection', 'remote']

type Unsubscribe = () => void

/** Client Cordis context 的本插件收窄面。 */
interface ClientShim {
  effect(effect: () => Unsubscribe | void, name?: string): void
  on(event: string, handler: (...args: unknown[]) => void): Unsubscribe
  remote: { $on(event: string, handler: (payload: unknown) => void): Unsubscribe }
  connection: { api: WpsBotRemoteApi }
  locale: {
    register(ns: string, dictionaries: Record<string, Record<string, string>>): Unsubscribe
    bind(ns: string): (key: never, params?: Record<string, string | number>) => string
  }
  slots: {
    inject(name: string, register: () => Unsubscribe | void): void
    register<I>(options: {
      name: string
      id: string
      order: number
      label: () => string
      inject: () => I
    }, component: unknown): Unsubscribe
  }
}

/** Refetch the page only after its first load. */
export function refreshIfLoaded(controller: WpsBotController): void {
  const status = controller.store.getSnapshot().status
  if (status === 'idle') return
  void controller.reload()
}

/**
 * Register the section, the copy dictionaries, the pushed-refresh wiring,
 * and the stylesheet; every contribution disposes with the plugin fiber.
 */
export function apply(ctx: ClientShim): void {
  ctx.effect(() => ctx.locale.register(WPS_BOT_NS, { zh, en }), 'dsh-wps-bot: dictionaries')

  const style = document.createElement('style')
  style.dataset['plugin'] = name
  style.textContent = STYLES
  document.head.appendChild(style)
  ctx.effect(() => () => style.remove(), 'dsh-wps-bot: stylesheet')

  const controller = new WpsBotController(ctx.connection.api)
  ctx.effect(() => () => controller.dispose(), 'dsh-wps-bot: controller')
  const useSnapshot = (): ReturnType<WpsBotController['store']['getSnapshot']> =>
    useSyncExternalStore(
      controller.store.subscribe,
      controller.store.getSnapshot,
    )
  // 注册期文本（nav label thunk）与渲染期 face 共享同一 bound translate；
  // 文案新鲜度骑 locale revision。
  const t = ctx.locale.bind(WPS_BOT_NS) as WpsBotSectionInjected['t']
  const injectFace = (): WpsBotSectionInjected => ({ controller, useSnapshot, t })

  ctx.effect(() => {
    const refresh = (): void => { refreshIfLoaded(controller) }
    const disposers = [
      // 载荷是 (ns, revision)：无关文档的 edit 不应让本页付出一次 join。
      ctx.remote.$on('settings/document-updated', ns => {
        if (ns === WPS_BOT_NS) refreshIfLoaded(controller)
      }),
      ctx.remote.$on('llm/adapters-updated', refresh),
      ctx.on('connection/reset', refresh),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-wps-bot: pushed invalidations')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: WPS_BOT_NS,
    order: 12,
    label: () => t('nav'),
    inject: injectFace,
  }, WpsBotSection))
}
