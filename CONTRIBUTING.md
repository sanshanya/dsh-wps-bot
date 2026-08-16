# 贡献 / 发布纪律（单页清单）

本仓由 agent 维护，下述八条是「防回退」硬约束：每一条都对应一个曾实锤过的坑。改代码前先读，PR 前逐条自检。

## 1. 发布阻断红线（改一行就要警惕）
- `main` / `exports` 只许指向 `lib/*.js`（构建产物），**永不**指 `src/*.ts`。原因：Node ≥22.6 的 type stripping 对 `node_modules/` 下的 `.ts` 直接拒绝（`Stripping types is currently unsupported for files under node_modules`，node 22.6/22.19/24.11 三线实证），装包即炸。
- 改完 exports/build 后必须跑 `npm run verify:pack`（裸 consumer node/tsc 双探测）。

## 2. 锁文件纪律
- 提交的 `package-lock.json` 必须 **0 个 `"link": true`**（`grep -c '"link": true' package-lock.json` 必须 =0）。当前错误教训：`npm link`/`file:` 联调后 `npm install` 会把 link 写死进锁 → `npm ci` 在干净机装出指向不存在目录的 symlink（静默绿但坏）。
- 重生命令：`rm -rf node_modules package-lock.json && npm install`。
- `open-event-sdk` 必须落回 registry（`^1.0.1` → 现 1.0.2），不得吊 `../ksbot`。

## 3. peer 版本同源 pin（stale-latest 陷阱）
- 5 个 `@deepseek-ai/dsh-*` 必须**同源 pin `^0.1.0-rc.6`**，禁用 `*`，也不要信 `npm view X version`（那是 `latest` tag）。
- 陷阱实锤：`@deepseek-ai/dsh-llm` / `dsh-session` 的 `latest` tag 是陈旧的 `0.0.1-rc.1`，而 `0.1.0-rc.6` 确实已发布（`npm view X versions --json` 可见）。用 `*` 或信 `latest` 会拿到 0.0.1-rc.1 线，与 `dsh-agent@0.1.0-rc.6` 的 `dsh-invariants@^0.1.0-rc.6` 冲突 → ERESOLVE。
- 两条独立版本线不动：`@deepseek-ai/cordis` `^4.0.1`、`@deepseek-ai/schemastery` `^3.18.1`。

## 4. 构建纪律（tsconfig.build.json 三键）
- `rewriteRelativeImportExtensions: true` + `noEmit: false` + `declaration: true`，缺一不可。
- 原因：全仓相对导入用 `.ts` 后缀（`from "./bot.ts"`），缺 `rewriteRelativeImportExtensions` 时 tsc 不重写 specifier，产出的 `.js` 会 `import "./bot.ts"` 而炸。

## 5. 依赖纪律
- `@types/node` 必须直控在 `devDependencies`（`tsconfig.json` 的 `types:["node"]` 依赖它）。不得靠邻仓 hoisting——今天 typecheck 能过纯靠 `node_modules/@types/node` 是 symlink 指向 better-model-provider，干净 `npm ci` 必 TS2688。

## 6. 门禁纪律（五门全绿才可 PR）
`npm ci && npm run typecheck && npm test && npm run budget:tokens && npm run build && npm run verify:pack`。
- token budget 是 ratchet：超基线只有 `node scripts/token-budget.mjs --regen` 单行 commit + 产品契约理由，否则永不给过。

## 7. 行尾纪律
- `.gitattributes` 首行 `* text=auto eol=lf` **不可删**；不引入 CRLF。
- 原因：`scripts/lib/token-survey-core.mjs` 读的是**工作树字节**（`readFileSync` + `enc.encode`），Windows autocrlf 若 checkout 成 CRLF，budget 计数在 ubuntu/windows 两腿漂移 → 假红/假绿。

## 8. 文件白名单 + 发布仪式
- `files` 只含 `lib` / `cordis.patch.yml` / `examples/wps-bot.cordis.yml` / `README.md` / `LICENSE`。`examples/{live,smoke}`（fire-drill、4 支 smoke）是开发/真机工具链，**永不进 npm tarball**（破相对导入 `../../src/*.ts` + 真机发消息 + 泄漏内部路径）。
- 发布：`git tag -a vX.Y.Z -m "..."`（annotated）→ `npm run build && npm run verify:pack` → `npm publish`。`rounds/` 永不进包（`.gitignore` 排除 + 不在 `files`）。
