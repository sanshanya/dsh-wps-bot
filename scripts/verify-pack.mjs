#!/usr/bin/env node
/**
 * verify-pack —— 发布 tarball 完整性 + 裸 consumer 双探测（BMP 同款，g4 修订）。
 *
 * 四步：
 *   0. 断言 lib/ 已 build（缺则提示先 npm run build）。
 *   1. `npm pack --json` 取 tarball 与文件清单。
 *   2. 白名单断言：严格落在 lib/ + README/LICENSE/cordis.patch.yml/package.json
 *      （与 files 同步收紧；不再允许 src|examples —— 这是对 b4 草案 regex 的修正）。
 *   3. 裸 consumer `npm install <tarball> typescript @types/node`（npm 会自动装 peer，
 *      因此这一步同时验证 peer 同源 pin 可解析）。
 *   4. `node probe.mjs`（运行时 import dsh-wps-bot 与 /protocol 必须 exit=0，钉死 strip-types 失败）
 *      + `tsc --noEmit probe.ts`（type 消费面必须 0 错）。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'; // c4：Windows 下 execFileSync('npm') 不可执行
const root = resolve(process.cwd());
const fail = (msg) => { console.error(`verify-pack: ${msg}`); process.exit(1); };

// 0. build 产物必须存在
for (const f of ['lib/index.js', 'lib/index.d.ts', 'lib/protocol.js', 'lib/client.js']) {
  if (!existsSync(join(root, f))) fail(`缺 ${f}，先 npm run build`);
}

// 1. npm pack --json
let packJson;
try {
  packJson = JSON.parse(execFileSync(NPM, ['pack', '--json'], { cwd: root, encoding: 'utf8' }));
} catch (e) {
  fail(`npm pack 失败: ${e.message}`);
}
const pkg = Array.isArray(packJson) ? packJson[0] : packJson;
const tarball = join(root, pkg.filename);

// 2. 白名单断言
const ALLOW = /^(lib\/)|^(README\.md|LICENSE|cordis\.patch\.yml|package\.json|examples\/wps-bot\.cordis\.yml)$/;
const bad = pkg.files.map((f) => f.path).filter((p) => !ALLOW.test(p));
if (bad.length) fail(`tarball 含非白名单文件: ${JSON.stringify(bad)}`);

// 3 + 4. 裸 consumer
const tmp = mkdtempSync(join(tmpdir(), 'wps-consumer-'));
try {
  execFileSync(NPM, ['init', '-y'], { cwd: tmp, stdio: 'ignore' });
  execFileSync(
    NPM, ['install', '--no-audit', '--no-fund', tarball, 'typescript', '@types/node'],
    { cwd: tmp, stdio: 'ignore' },
  );

  // 运行时探测（只 import 运行期具名导出；WpsBotConfig 是 interface，运行时被擦除，不进 value import）
  writeFileSync(join(tmp, 'probe.mjs'), [
    `import mod, { name, inject, Config, apply } from 'dsh-wps-bot';`,
    `import * as protocol from 'dsh-wps-bot/protocol';`,
    `if (name !== 'wps-bot') throw new Error('bad name');`,
    `if (typeof apply !== 'function') throw new Error('bad apply');`,
    `if (!Array.isArray(inject)) throw new Error('bad inject');`,
    `if (typeof Config !== 'object' && typeof Config !== 'function') throw new Error('bad Config');`,
    `if (!protocol.normalizeEventData) throw new Error('bad protocol');`,
    `console.log('consumer node import OK:', Object.keys(mod.default ?? {}).sort().join(','));`,
  ].join('\n'));

  // 类型消费探测
  writeFileSync(join(tmp, 'probe.ts'), [
    `import type { WpsBotConfig } from 'dsh-wps-bot';`,
    `import type { WpsEvent } from 'dsh-wps-bot/protocol';`,
    `const c: WpsBotConfig = { approvalMode: 'windows', cardMode: 'card' };`,
    `const _e: WpsEvent | null = null;`,
    `void c; void _e;`,
  ].join('\n'));

  execFileSync(process.execPath, ['probe.mjs'], { cwd: tmp, stdio: 'inherit' });
  const tscBin = join(tmp, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  execFileSync(
    tscBin,
    ['--noEmit', '--strict', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--skipLibCheck', 'probe.ts'],
    { cwd: tmp, stdio: 'inherit' },
  );

  console.log('verify-pack: OK — 白名单通过，裸 consumer node/tsc 双探测通过');
} catch (e) {
  fail(`consumer 探测失败: ${e.message}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(tarball, { force: true });
}
