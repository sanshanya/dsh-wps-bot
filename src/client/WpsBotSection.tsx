/**
 * WPS Bot 配置节：一张设置页，编辑凭据（clientId / clientSecret / spId）、
 * bridge 通道开关与作答模型（提供方 + 模型）。每次写入是一条最小的
 * `settings.mutate` 路径操作（set/unset）；空文本 = 回到合成/Schema 默认
 * （unset 而不是写空串——presence 语义，镜像设置缝的分层）。
 *
 * 草稿纪律对齐 better-model-provider：未应用 edit 留在本地（`staged`），
 * Apply 写穿；推送来的 reload 只在页面干净时才重铺草稿，脏草稿永不被
 * 后台刷新覆盖。clientSecret 是 write-only 槽：describe 永不下线其值，
 * 页面只能从 secrets 槽得知它已配置与否。
 *
 * @module dsh-wps-bot/client/WpsBotSection
 */

import { useState } from 'react'
import type { ReactElement } from 'react'
import type { WpsBotController, WpsBotState } from './store.ts'
import { HarnessRpcError, messageOf } from './wire.ts'
import type { SettingsNamespaceView, SettingsPathOpView } from './wire.ts'
import type { WpsBotKey } from './locales.ts'

/** Bound translator the section consumes. */
export type TFn = (key: WpsBotKey, params?: Record<string, string | number>) => string

/** The section's inject face bound at registration time. */
export interface WpsBotSectionInjected {
  /** The page controller. */
  controller: WpsBotController
  /** Identity-stable snapshot hook. */
  useSnapshot: () => WpsBotState
  /** Bound translate for this section's dictionaries. */
  t: TFn
}

/** Owner share of the settings.section entry. */
export interface WpsBotSectionProps extends WpsBotSectionInjected {
  /** Close the settings panel. */
  close: () => void
}

/** 页面上可编辑的非密字段。 */
interface DraftValues {
  clientId: string
  spId: string
  bridge: boolean
  provider: string
  model: string
}

/** 从脱敏 resolved 值归一出展示初值（Schema 默认已折叠其中）。 */
function resolvedOf(namespace: SettingsNamespaceView): DraftValues {
  const value = (namespace.value ?? {}) as Record<string, unknown>
  return {
    clientId: typeof value['clientId'] === 'string' ? value['clientId'] : '',
    spId: typeof value['spId'] === 'string' ? value['spId'] : '',
    bridge: typeof value['bridge'] === 'boolean' ? value['bridge'] : true,
    provider: typeof value['provider'] === 'string' ? value['provider'] : '',
    model: typeof value['model'] === 'string' ? value['model'] : '',
  }
}

/** 字符串字段的最小写：空 = unset（落回默认），非空 = set。 */
function stringOps(path: string[], next: string, current: string): SettingsPathOpView[] {
  if (next === current) return []
  if (next === '') return [{ op: 'unset', path }]
  return [{ op: 'set', path, value: next }]
}

/** The WPS Bot settings section component. */
export function WpsBotSection(props: WpsBotSectionProps): ReactElement {
  const { controller, useSnapshot, t } = props
  const snapshot = useSnapshot()
  // 首挂载拥有首取：idle 只在此被观察到，渲染路径直接踢 load——hook 顺序
  // 恒定，因为没有任何 hook 条件执行（同官方 Models 页的纪律）。
  if (snapshot.status === 'idle') void controller.load()

  // null = 未暂存（展示 resolved）；非 null = 存在本地 edit。
  const [draft, setDraft] = useState<DraftValues | null>(null)
  const [secretDraft, setSecretDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedFlash, setSavedFlash] = useState(false)

  if (snapshot.status === 'idle' || snapshot.status === 'loading') {
    return <div className="wpsb-section"><p className="wpsb-muted">{t('loading')}</p></div>
  }
  if (snapshot.status === 'error') {
    return (
      <div className="wpsb-section">
        <div className="wpsb-error" role="alert">{t('loadFailed')}: {snapshot.error}</div>
        <div className="wpsb-actions">
          <button type="button" className="wpsb-button" onClick={() => void controller.reload()}>{t('retry')}</button>
        </div>
      </div>
    )
  }
  const namespace = snapshot.namespace
  if (namespace === undefined) {
    return (
      <div className="wpsb-section">
        <div className="wpsb-error" role="alert">{t('loadFailed')}: namespace wps-bot not registered</div>
        <div className="wpsb-actions">
          <button type="button" className="wpsb-button" onClick={() => void controller.reload()}>{t('retry')}</button>
        </div>
      </div>
    )
  }

  const resolved = resolvedOf(namespace)
  const shown = draft ?? resolved
  const secretSet = namespace.secrets.some(slot => slot.path.length === 1 && slot.path[0] === 'clientSecret' && slot.set)
  const editable = snapshot.writable && !saving
  const dirty = (draft !== null && (
    draft.clientId !== resolved.clientId
    || draft.spId !== resolved.spId
    || draft.bridge !== resolved.bridge
    || draft.provider !== resolved.provider
    || draft.model !== resolved.model
  )) || secretDraft !== ''

  const edit = (patch: Partial<DraftValues>): void => {
    setDraft({ ...shown, ...patch })
    setSavedFlash(false)
    setSaveError(null)
  }

  const onRevert = (): void => {
    setDraft(null)
    setSecretDraft('')
    setSaveError(null)
    setSavedFlash(false)
  }

  const onApply = async (): Promise<void> => {
    const ops: SettingsPathOpView[] = [
      ...stringOps(['clientId'], shown.clientId.trim(), resolved.clientId),
      ...stringOps(['spId'], shown.spId.trim(), resolved.spId),
      ...stringOps(['provider'], shown.provider, resolved.provider),
      ...stringOps(['model'], shown.model, resolved.model),
    ]
    if (shown.bridge !== resolved.bridge) ops.push({ op: 'set', path: ['bridge'], value: shown.bridge })
    // 密钥只写：输入非空才携带；留空即"不碰"，merge 语义保留已存值。
    if (secretDraft !== '') ops.push({ op: 'set', path: ['clientSecret'], value: secretDraft })
    setSaving(true)
    setSaveError(null)
    try {
      await controller.save(ops)
      onRevert()
      setSavedFlash(true)
    } catch (caught) {
      // 并发改动：edit 保留在下方——对照刚刷新的状态再应用。
      if (caught instanceof HarnessRpcError && caught.code === 'settings-conflict') {
        setSaveError(t('conflict'))
        void controller.reload()
      } else {
        setSaveError(messageOf(caught))
      }
    } finally {
      setSaving(false)
    }
  }

  const modelGroup = snapshot.groups.find(group => group.id === shown.provider)
  const modelOptions = modelGroup?.models ?? []
  const modelMissing = shown.model !== '' && !modelOptions.some(entry => entry.id === shown.model)
  const providerMissing = shown.provider !== '' && !snapshot.providers.some(entry => entry.provider === shown.provider)

  return (
    <div className="wpsb-section">
      <h2 className="wpsb-title">{t('title')}</h2>
      <p className="wpsb-muted">{t('intro')}</p>
      {!snapshot.writable && <p className="wpsb-muted">{t('readOnly')}</p>}

      <div className="wpsb-card">
        <div className="wpsb-cardHeader">
          <span className="wpsb-cardTitle">{t('credsTitle')}</span>
        </div>
        <p className="wpsb-muted">{t('credsHint')}</p>
        <div className="wpsb-fields">
          <div className="wpsb-field">
            <label className="wpsb-label" htmlFor="wpsb-clientId">{t('clientId')}</label>
            <input
              id="wpsb-clientId"
              className="wpsb-input"
              value={shown.clientId}
              disabled={!editable}
              onChange={event => edit({ clientId: event.target.value })}
            />
          </div>
          <div className="wpsb-field">
            <label className="wpsb-label" htmlFor="wpsb-clientSecret">{t('clientSecret')}</label>
            <span>
              <input
                id="wpsb-clientSecret"
                className="wpsb-input"
                type="password"
                value={secretDraft}
                disabled={!editable}
                autoComplete="new-password"
                onChange={event => { setSecretDraft(event.target.value); setSavedFlash(false); setSaveError(null) }}
              />
              <span className="wpsb-secretNote">{secretSet ? t('secretSet') : t('secretUnset')}</span>
            </span>
          </div>
          <div className="wpsb-field">
            <label className="wpsb-label" htmlFor="wpsb-spId">{t('spId')}</label>
            <input
              id="wpsb-spId"
              className="wpsb-input"
              value={shown.spId}
              disabled={!editable}
              onChange={event => edit({ spId: event.target.value })}
            />
          </div>
        </div>
      </div>

      <div className="wpsb-card">
        <div className="wpsb-cardHeader">
          <span className="wpsb-cardTitle">{t('channelTitle')}</span>
        </div>
        <label className="wpsb-toggle">
          <input
            type="checkbox"
            checked={shown.bridge}
            disabled={!editable}
            onChange={event => edit({ bridge: event.target.checked })}
          />
          <span>{t('bridgeLabel')}</span>
        </label>
        <p className="wpsb-muted">{t('bridgeHint')}</p>
      </div>

      <div className="wpsb-card">
        <div className="wpsb-cardHeader">
          <span className="wpsb-cardTitle">{t('modelTitle')}</span>
        </div>
        <p className="wpsb-muted">{t('modelHint')}</p>
        <div className="wpsb-fields">
          <div className="wpsb-field">
            <label className="wpsb-label" htmlFor="wpsb-provider">{t('provider')}</label>
            <select
              id="wpsb-provider"
              className="wpsb-select"
              value={shown.provider}
              disabled={!editable}
              onChange={event => {
                const provider = event.target.value
                // 跟随新提供方落到其目录首选模型；无目录则保留已填 id（truthful mismatch 比静默错对好）。
                const group = snapshot.groups.find(entry => entry.id === provider)
                edit({ provider, model: group?.models[0]?.id ?? shown.model })
              }}
            >
              {snapshot.providers.map(entry => (
                <option key={entry.provider} value={entry.provider}>{entry.displayName}</option>
              ))}
              {providerMissing && <option value={shown.provider}>{shown.provider}</option>}
            </select>
          </div>
          <div className="wpsb-field">
            <label className="wpsb-label" htmlFor="wpsb-model">{t('model')}</label>
            <select
              id="wpsb-model"
              className="wpsb-select"
              value={shown.model}
              disabled={!editable}
              onChange={event => edit({ model: event.target.value })}
            >
              {modelOptions.map(entry => (
                <option key={entry.id} value={entry.id}>{entry.name}</option>
              ))}
              {modelMissing && <option value={shown.model}>{shown.model}</option>}
            </select>
          </div>
        </div>
        {modelGroup === undefined && <p className="wpsb-muted">{t('catalogEmpty')}</p>}
      </div>

      {snapshot.error !== null && <div className="wpsb-error" role="alert">{snapshot.error}</div>}
      {saveError !== null && <div className="wpsb-error" role="alert">{saveError}</div>}
      <div className="wpsb-actions">
        {dirty && <span className="wpsb-staged">{t('staged')}</span>}
        {savedFlash && !dirty && <span className="wpsb-ok">{t('saved')}</span>}
        <button type="button" className="wpsb-button" disabled={!dirty || !editable} onClick={() => void onApply()}>
          {saving ? t('applying') : t('apply')}
        </button>
        <button type="button" className="wpsb-button" disabled={!dirty || saving} onClick={onRevert}>
          {t('revert')}
        </button>
      </div>
    </div>
  )
}
