# RELEASE v0.1.0（发布闸文书）

> 对位 GA docs/RELEASE_V0.1.0.md 的发布仪式：冻结 SHA、验收事实、回滚面、遗留负担。

## 发布前硬性检查（按序）

1. 门禁五连：`npm ci && npm run typecheck && npm test && npm run budget:tokens && npm run verify:pack`（全绿）。
2. 真机三场景验收新戳（docs/acceptance-live.md；最近一次：2026-08-16T06:04Z 全绿）。
3. npm 名字占用：`dsh-wps-bot` 查询 404=可占（2026-08-16 验）。
4. 版本与仪式：
   ```powershell
   npm version 0.1.0 --no-git-tag-version
   git add package.json package-lock.json
   git commit -m "release: v0.1.0"
   git tag -a v0.1.0 -m "dsh-wps-bot v0.1.0 - WPS 365 channel plugin for dsh"
   npm publish      # prepublishOnly 自动 build+verify:pack
   git push --follow-tags   # 需用户明示批准
   ```
5. 回滚：npm unpublish 仅在 72h 内（此后 deprecate）；git 面 `git revert` + bump patch。

## 本版验收事实

- 场景：文本问答/进度卡/限时审批窗——真实 WPS 租户 + 真模型合跑（2026-08-15/16 两戳）。
- 发布门禁：lib 构建 + 四子路径 exports（types+default）、裸消费者 import/require 双通、lockfile 0 link。
- 测试：95 用例全绿；CI 四门矩阵（ubuntu/windows × node22/24）。
- 通道代答：approval one-shot/限时窗 + user-questions 群问面。

## 遗留负担（发版不遮）

- U1 断网重放窗口：需真实入站消息在宿主离线 >2min 后复验（dedup 真机线欠账；离线窗口已内测幂等逻辑）。
- U2 GUI secret 渲染：需租户管理员界面亲验（用户域事项）。
- Phase 0.5 引用不@ 投递探针未跑（B 模型 go/no-go；契约 계획 P-C 前端）。
- 旧 GA 服务并存时按 WS 单播律双丢消息——生产部署须独占连接。
- persona/工具契约（finish_task/reply 工具面 v1 用 persona 约定，真工具注册待 P-A）。
