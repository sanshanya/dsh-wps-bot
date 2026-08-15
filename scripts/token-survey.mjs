#!/usr/bin/env node
/**
 * Token survey（测量仪，非门禁）——打印本仓 tracked 文本的 BPE token 账。
 *
 * 用法：
 *   node scripts/token-survey.mjs [--json] [--top=N]
 *   npm run survey:tokens
 *
 * Exit code 恒为 0：这是一台仪表，不是闸门。门禁走 scripts/token-budget.mjs。
 * 未知 flag 大声失败——量具不撒谎。
 */
import { survey } from './lib/token-survey-core.mjs'

function parseArgs(argv) {
  const options = { json: false, top: 10 }
  for (const arg of argv) {
    if (arg === '--json') options.json = true
    else if (arg.startsWith('--top=')) {
      options.top = Number(arg.slice('--top='.length))
      if (!Number.isInteger(options.top) || options.top < 0) {
        throw new Error(`token-survey: --top expects a non-negative integer, got ${arg}`)
      }
    } else {
      throw new Error(`token-survey: unknown flag ${arg}`)
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const report = survey()

if (options.json) {
  process.stdout.write(`${JSON.stringify({ ...report, largestFiles: report.files.slice(0, options.top) }, null, 2)}\n`)
  process.exit(0)
}

const head = ['category', 'files', 'lines', 'chars', 'tokens', 'share']
const rows = Object.entries(report.categories).map(([name, c]) => [
  name,
  String(c.files),
  String(c.lines),
  String(c.chars),
  String(c.tokens),
  report.totals.tokens === 0 ? '-' : `${((100 * c.tokens) / report.totals.tokens).toFixed(1)}%`,
])
rows.push([
  'TOTAL',
  String(report.totals.files),
  String(report.totals.lines),
  String(report.totals.chars),
  String(report.totals.tokens),
  '100.0%',
])
const widths = head.map((h, i) => Math.max(h.length, ...rows.map(row => row[i].length)))
const line = row => row.map((cell, i) => cell.padStart(widths[i])).join('  ')
process.stdout.write(`tokenizer: ${report.tokenizer}\n\n${line(head)}\n${'-'.repeat(widths.reduce((a, b) => a + b, 0) + 2 * (head.length - 1))}\n`)
for (const row of rows) process.stdout.write(`${line(row)}\n`)
if (report.categories.source.tokens > 0) {
  process.stdout.write(
    `\nper source token: tests ${report.ratios.testsPerSource.toFixed(2)} · docs ${report.ratios.docsPerSource.toFixed(2)} · tooling ${report.ratios.toolingPerSource.toFixed(2)}\n`,
  )
}
const largest = report.files.slice(0, options.top)
if (largest.length > 0) {
  process.stdout.write(`\nlargest files (top ${largest.length} by tokens):\n`)
  for (const file of largest) {
    process.stdout.write(`  ${String(file.tokens).padStart(7)}  ${file.category.padEnd(7)}  ${file.path}\n`)
  }
}
if (report.excluded.length > 0) {
  process.stdout.write(`\nexcluded from counting (never agent context):\n`)
  for (const skip of report.excluded) {
    process.stdout.write(`  ${skip.reason.padEnd(9)}  ${skip.path} (${skip.bytes} bytes)\n`)
  }
}
