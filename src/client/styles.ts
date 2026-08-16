/**
 * 配置页样式表：以插件自有 `<style>` 元素注入，随 fiber 生命周期卸载。
 * 类名带 `wpsb-` 前缀避免与官方样式碰撞；所有颜色与圆角全部骑 shell 的
 * 设计令牌（--dsw-alias-*），随每套主题换肤——对齐 better-model-provider
 * 的 styles.ts 纪律。
 *
 * @module dsh-wps-bot/client/styles
 */

/** One styletext for the whole section. */
export const STYLES = `
.wpsb-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.wpsb-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
.wpsb-muted {
  margin: 0;
  color: var(--dsw-alias-label-tertiary, rgba(0, 0, 0, 0.45));
  font-size: 13px;
  line-height: 1.5;
}
.wpsb-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  border-radius: 8px;
}
.wpsb-cardHeader {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.wpsb-cardTitle {
  font-weight: 600;
}
.wpsb-cardMeta {
  color: var(--dsw-alias-label-tertiary, rgba(0, 0, 0, 0.45));
  font-size: 12px;
}
.wpsb-fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.wpsb-field {
  display: grid;
  grid-template-columns: 120px 1fr;
  align-items: center;
  gap: 8px;
}
.wpsb-label {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.65));
}
.wpsb-input,
.wpsb-select {
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: inherit;
  font-size: 13px;
  padding: 6px 8px;
  max-width: 340px;
  width: 100%;
  box-sizing: border-box;
}
.wpsb-secretNote {
  margin-left: 6px;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, rgba(0, 0, 0, 0.45));
}
.wpsb-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.wpsb-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.wpsb-button {
  padding: 6px 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-3, rgba(0, 0, 0, 0.06));
  color: inherit;
  font-size: 13px;
  cursor: pointer;
}
.wpsb-button:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.1));
}
.wpsb-button:disabled,
.wpsb-input:disabled,
.wpsb-select:disabled {
  opacity: 0.6;
  cursor: default;
}
.wpsb-staged {
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  background: var(--dsw-alias-state-warn-tertiary, rgba(240, 160, 0, 0.15));
  color: var(--dsw-alias-state-warn-primary, #a06800);
}
.wpsb-ok {
  font-size: 12px;
  color: var(--dsw-alias-state-ok-primary, #1a7f37);
}
.wpsb-error {
  padding: 8px;
  border-radius: 6px;
  /* 平台调色板没有 soft-error 令牌；半透明红叠底在明暗题下都可读。 */
  background: rgba(192, 52, 43, 0.12);
  color: var(--dsw-alias-state-error-primary, #c0342b);
  font-size: 12px;
  word-break: break-word;
}
`
