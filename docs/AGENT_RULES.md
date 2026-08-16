# Agent Project Rules

编码前创建、结束后删除 `.agent/TASK`：

```text
OUTCOME: 可观察结果
NON-GOALS: 不做什么
VERIFY: 实际验证
ADDS: 新增永久概念，或 none
```

无法明确 `OUTCOME` 与 `VERIFY` 时不得编码。

## 删改纪律

优先删除、复用、修改；仅在结果无法实现时新增永久文件、API、配置、依赖或运行模式。禁止假想扩展、兼容层、备用路径、单实现抽象、新旧并存、压行和把逻辑移入 Prompt。同一行为只留一条路径；拆分必须降低真实任务切片。

## 真值与验证纪律

- 改变 dsh 原生行为或本插件目标契约前，先更新 `docs/PROJECT.md`；削弱核心能力须经用户批准。
- WPS wire 事实一律真机帧优先（真机帧 > GA 源 > wps-docs > SDK .d.ts）；新增协议行必须配真机帧固定钉（fixtures/live/*）或指向既有钉。
- Mock 不替代真机验收：涉及 WS 投递/审批/卡片/附件的行为变更，须按 docs/acceptance-live.md 场景复跑或登记欠账。
- 外部审查报告（rounds/*）**先裁定后修**：每条对现行树证真/证伪，裁定矩阵留档；偏离报告给定顺序时在裁定文件中写明理据。
- 红测先行：修复须有「修复前红、修复后绿」的用例；一个错误行为只留一个最强测试。

## 提交与门禁

阶段提交前执行 `VERIFY`、`node --test test/*.test.ts`、`tsc --noEmit`、`node scripts/token-budget.mjs`（npm run budget:tokens）、diff 检查并删除临时内容。token 预算为总量与分组双 ratchet；增长必须对应 `docs/PROJECT.md` 中已记录的产品契约，regen 的 commit msg 写明理据。

## 秘密与运行纪律

凭据只入未跟踪文件（`F:\github\.env.wps`、`.env`、`/tmp/wps-bot-e2e/env.local`）；任何提交不得带入。WS 单播律：验收/生产期间同 SP 只允许一条入站连接，验收前检查无侧车监听存活。未获用户明示同意不执行 git push 与线上服务变更。
