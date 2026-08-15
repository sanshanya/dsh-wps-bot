#!/usr/bin/env node
/**
 * Token budget（ratchet 门禁）——BMP 测量仪 + GA token_budget.py 的 ratchet 纪律。
 *
 * GA 的治理口径（ksbot_ga/docs/PROJECT.md:74）：总量/分组预算只减不增，
 * 「只有批准的新产品契约可提高」。本仓实现：
 *   - 基线 = scripts/token-baseline.json（{tokenizer, categories(tokens), total}）。
 *   - 任一 bucket 或 total 超过基线 → 逐行红标、FAIL 清单、exit≠0。
 *   - 基线缺席 → 以当前测量生成基线并写盘，exit 0（首次启用）。
 *   - `--regen` 强制重写基线 = 提高预算的唯一显式动作（单行 commit 纪律）。
 *   - `--json` 输出完整比对。
 *
 * 与 GA 版的两处有意差：计数器从启发式（CJK/ASCII 词法近似）换成 cl100k_base
 * 真 BPE（量具印在每份报告与基线 meta 里）；bucket 从 GA 目录布局换成本仓布局。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { CATEGORY_ORDER, EXCLUDED_NAMES, GENERATED, TOKENIZER, survey } from './lib/token-survey-core.mjs'

const BASELINE_PATH = 'scripts/token-baseline.json'

function parseArgs(argv) {
  const options = { json: false, regen: false }
  for (const arg of argv) {
    if (arg === '--json') options.json = true
    else if (arg === '--regen') options.regen = true
    else throw new Error(`token-budget: unknown flag ${arg}`)
  }
  return options
}

function gitHead() {
  try {
    const out = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' })
    return out.trim() || null
  } catch {
    return null
  }
}

const options = parseArgs(process.argv.slice(2))
const report = survey()
const totals = Object.fromEntries(CATEGORY_ORDER.map(name => [name, report.categories[name].tokens]))
const total = report.totals.tokens

let baseline = null
if (!options.regen) {
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  } catch {
    baseline = null
  }
}

if (baseline === null) {
  const payload = {
    _meta: {
      generated_by: 'scripts/token-budget.mjs',
      generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      git_head: gitHead(),
      tokenizer: TOKENIZER,
      enumeration: 'git ls-files -z',
      excluded_names: [...EXCLUDED_NAMES].sort(),
      generated_pattern: String(GENERATED),
      ratchet: '任一 bucket 或 total 超过本基线即红；仅经 --regen 单行 commit 显式提高（GA PROJECT.md:74 口径）',
    },
    categories: totals,
    total,
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  process.stdout.write(`baseline written: ${BASELINE_PATH} (categories=${CATEGORY_ORDER.length}, total=${total})\n`)
  process.exit(0)
}

const limits = baseline.categories ?? {}
const failures = []
const rows = []
for (const name of CATEGORY_ORDER) {
  const cur = totals[name]
  const lim = limits[name]
  if (lim === undefined || lim === null) {
    failures.push(`category:${name}(new-unbudgeted)`)
    rows.push([name, cur, null, true])
  } else {
    const over = cur > lim
    if (over) failures.push(`category:${name}`)
    rows.push([name, cur, lim, over])
  }
}
if (total > Number(baseline.total ?? 0)) failures.push('total')

const useColor = process.stdout.isTTY && !('NO_COLOR' in process.env)
const colorize = s => (useColor ? `\u001b[31m${s}\u001b[0m` : s)

if (options.json) {
  process.stdout.write(`${JSON.stringify({
    tokenizer: report.tokenizer,
    category_totals: totals,
    category_limits: limits,
    ratios: report.ratios,
    total,
    total_limit: baseline.total,
    failures,
  }, null, 2)}\n`)
} else {
  for (const [name, cur, lim, over] of rows) {
    const mark = over ? '  OVER' : lim === null ? '  UNBUDGETED' : ''
    const line = `${name.padEnd(10)} ${String(cur).padStart(7)} / ${lim === null ? '-' : String(lim)}`
    process.stdout.write(`${over || lim === null ? colorize(line + mark) : line}${mark ? '' : ''}\n`)
  }
  for (const [g, v] of Object.entries(report.ratios)) {
    if (v !== null) process.stdout.write(`[ratio] ${g.padEnd(16)} ${v.toFixed(2)}\n`)
  }
  process.stdout.write(`${'TOTAL'.padEnd(10)} ${String(total).padStart(7)} / ${baseline.total}\n`)
  if (failures.length) {
    process.stdout.write(colorize(`FAIL: ${failures.join(', ')}\n`))
    process.stdout.write('提高预算只经 `node scripts/token-budget.mjs --regen` 单行 commit（需产品契约理由）。\n')
  }
}
process.exit(failures.length ? 1 : 0)
