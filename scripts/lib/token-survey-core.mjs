/**
 * Token survey core — measure the exact reading load this repo puts on an agent.
 *
 * Court of origin: better-model-provider/scripts/token-survey.mjs（移植核查面见
 * README「Token 预算」一节）。本仓是一个 agent 维护的项目——source/test/doc/tooling
 * 每一份 tracked 文本都与维护者的注意力窗口竞争；token 测量必须是真 BPE，不是
 * bytes/lines 的代理指标。
 *
 * 移植时保留的设计诚实有：
 *   - File set = `git ls-files -z`：只数 tracked 文件；lib/、node_modules/、
 *     runtime/、临时残迹天然不入账（.gitignore 免费生效）。
 *   - 生成物（lockfile、*.map）与二进制（NUL sniff）各计一次、如实报为 excluded、
 *     永不混进分类：没人读它们；假装它们免费和直接漏掉一样是自欺。
 *   - 每文件恰好落入一个 bucket（见 categoryOf 的仓内版）。
 *   - Tokenizer = cl100k_base via js-tiktoken：对该词表精确，对其它 BPE 模型是稳定
 *     上界代理；tokenizer 名印在每一份报告里——数字永不脱离量具而被引用。
 *
 * 与 BMP 的三处有意差（本文件即记录）：
 *   1. bucket 集按本仓布局改：source=src/、tests=test/、docs=**.md+docs/+examples/、
 *      tooling=其余 tracked（scripts/、configs、LICENSE）。
 *   2. 计数核心抽成本模块，供 token-budget.mjs 的门禁复用同一次测量（单信源）。
 *   3. js-tiktoken 必须在 package.json devDependencies 里显式锁版（BMP 是靠
 *      node_modules 里现成包跑的未申报依赖）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { getEncoding } from 'js-tiktoken'

export const TOKENIZER = 'cl100k_base (js-tiktoken)'

/** tracked paths matching this are generated, not read: excluded with a note. */
export const GENERATED = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$|\.map$/

/** 不计入测量的 tracked 文件（门禁基线自引用 + 纯仓库仪式件）。 */
export const EXCLUDED_NAMES = new Set(['.gitignore', 'scripts/token-baseline.json'])

/** 整段划在预算面外的前缀：rounds/ 过程文档天然单调增长，入 ratchet 会恒红（ksbot-dsh EXCLUDED_PREFIXES 同款教训）。 */
export const EXCLUDED_PREFIXES = ['rounds/']

/** 本仓布局的四分类：每文件恰好一个 bucket。 */
export function categoryOf(rel) {
  if (rel.startsWith('src/')) return 'source'
  if (rel.startsWith('test/')) return 'tests'
  if (rel.toLowerCase().endsWith('.md') || rel.startsWith('docs/') || rel.startsWith('examples/')) return 'docs'
  return 'tooling'
}

export const CATEGORY_ORDER = ['source', 'tests', 'docs', 'tooling']

/** Sniff a small prefix: NUL 意味着二进制；那些字节永远不是 agent 的上下文。 */
export function isBinary(buffer) {
  const probe = buffer.subarray(0, Math.min(buffer.length, 8000))
  return probe.includes(0)
}

/** 对某个仓库根做一次全量测量（默认 cwd）。 */
export function survey(root = process.cwd()) {
  const listed = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', cwd: root })
  const paths = listed
    .split('\0')
    .filter(rel => rel.length > 0 && !EXCLUDED_NAMES.has(rel) && !EXCLUDED_PREFIXES.some(p => rel.startsWith(p)))

  const enc = getEncoding('cl100k_base')
  const files = []
  const excluded = []
  for (const rel of paths) {
    const buffer = readFileSync(`${root}/${rel}`)
    if (isBinary(buffer)) {
      excluded.push({ path: rel, reason: 'binary', bytes: buffer.length })
      continue
    }
    if (GENERATED.test(rel)) {
      excluded.push({ path: rel, reason: 'generated', bytes: buffer.length })
      continue
    }
    const text = buffer.toString('utf8')
    files.push({
      path: rel,
      category: categoryOf(rel),
      lines: text.length === 0 ? 0 : text.split('\n').length,
      chars: text.length,
      tokens: enc.encode(text).length,
    })
  }
  files.sort((a, b) => b.tokens - a.tokens)

  const categories = {}
  for (const name of CATEGORY_ORDER) {
    categories[name] = { files: 0, lines: 0, chars: 0, tokens: 0 }
  }
  const totals = { files: 0, lines: 0, chars: 0, tokens: 0 }
  for (const file of files) {
    for (const key of ['lines', 'chars', 'tokens']) {
      categories[file.category][key] += file[key]
      totals[key] += file[key]
    }
    categories[file.category].files += 1
    totals.files += 1
  }

  const src = categories.source.tokens
  return {
    tokenizer: TOKENIZER,
    categories,
    totals,
    // 注意力稀释指标：每 1 个产品 token 上骑着的非产品文本。
    ratios: {
      testsPerSource: src === 0 ? null : categories.tests.tokens / src,
      docsPerSource: src === 0 ? null : categories.docs.tokens / src,
      toolingPerSource: src === 0 ? null : categories.tooling.tokens / src,
    },
    files,
    excluded,
  }
}
