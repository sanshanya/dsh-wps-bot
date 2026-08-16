/**
 * WPS Bot 配置页的中英文案。键源是 en；zh 一一对应。
 *
 * @module dsh-wps-bot/client/locales
 */

/** English dictionary — the key source. */
export const en = {
  nav: 'WPS Bot',
  title: 'WPS Bot',
  intro:
    'Credentials and channel switch for the WPS 365 open platform. Saving takes effect immediately: '
    + 'with bridge enabled and credentials complete, the bot opens the long connection on its own.',
  loading: 'Loading settings…',
  retry: 'Retry now',
  conflict:
    'The settings document changed elsewhere. Your edits are kept below — review the refreshed state, then apply again.',
  readOnly: 'Settings are read-only in this view',
  credsTitle: 'Credentials',
  credsHint: 'From the WPS 365 open platform application. Secrets are write-only: the page only learns whether one is configured.',
  clientId: 'Client ID',
  clientSecret: 'Client Secret',
  secretSet: 'configured — type to replace',
  secretUnset: 'not configured',
  spId: 'SP ID',
  channelTitle: 'Channel',
  bridgeLabel: 'Enable bridge (WPS long connection)',
  bridgeHint: 'When off, the plugin never connects to WPS: no WPS-side message reaches the agent.',
  modelTitle: 'Model',
  modelHint: 'The provider and model the bot answers with, chosen from the dsh registry.',
  provider: 'Provider',
  model: 'Model',
  apply: 'Apply',
  revert: 'Revert',
  applying: 'Applying…',
  staged: 'unapplied',
  saved: 'Applied — live now',
  loadFailed: 'Load failed',
  catalogEmpty: 'This provider published no model catalog; the typed-in id is kept.',
} as const

/** Union of copy keys the section consumes. */
export type WpsBotKey = keyof typeof en

/** Chinese dictionary, one-to-one with `en`. */
export const zh: Record<WpsBotKey, string> = {
  nav: 'WPS Bot 配置',
  title: 'WPS Bot 配置',
  intro: 'WPS 365 开放平台的凭据与通道开关。保存即刻生效：bridge 开启且凭据齐全时，机器人自动建立长连接。',
  loading: '正在加载设置…',
  retry: '立即重试',
  conflict: '设置文档已在别处变更。你的编辑保留在下方——请先对照刚刷新的状态，再重新应用。',
  readOnly: '此视图下设置为只读',
  credsTitle: '凭据',
  credsHint: '来自 WPS 365 开放平台应用。密钥为只写：页面只能得知它是否已配置。',
  clientId: 'Client ID',
  clientSecret: 'Client Secret',
  secretSet: '已配置——输入以更换',
  secretUnset: '未配置',
  spId: 'SP ID',
  channelTitle: '通道',
  bridgeLabel: '启用 bridge（WPS 长连接）',
  bridgeHint: '关闭后插件不连接 WPS：任何 WPS 侧消息都不会触达 agent。',
  modelTitle: '模型',
  modelHint: '机器人作答所用的提供方与模型，从 dsh 注册表中选择。',
  provider: '提供方',
  model: '模型',
  apply: '应用',
  revert: '还原',
  applying: '应用中…',
  staged: '未应用',
  saved: '已应用，即刻生效',
  loadFailed: '加载失败',
  catalogEmpty: '该提供方未发布模型目录，保留已填写的 id。',
}
