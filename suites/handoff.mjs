/**
 * 套件 C · 交接账本（H1–H4 判据 + 一次写对率）
 *
 * 用法：
 *   node suites/handoff.mjs                    # 20 条语料，默认提示词
 *   node suites/handoff.mjs --slim             # 127 字符版本
 *   node suites/handoff.mjs --tiny --n 5       # 45 字符版本 × 每类 5 条
 *   node suites/handoff.mjs --arm baseline     # 指定臂名（影响产物文件名）
 *
 * ★ 与套件 A 的区别：这里只测「交接账本」一种写入，但用 **20 条自包含任务**
 *   覆盖 14 个任务类型，且判据用产品自己的 checkHandoffCriteriaPre（H1–H4）。
 *
 * ★★ 这条套件跑出来的两个反直觉结论：
 *   1. 合规率天花板是 100%，8 个提示词版本全过 —— 合规率已无提升空间。
 *   2. 「一次写对率」才是唯一有分辨力的指标：写了「标题必须逐字」的版本
 *      5/5 一次写对，不写的版本几乎每条都要先挨一次 H1 拒绝。
 */
import { readFileSync } from 'node:fs'
import { runSuite, summarize } from '../lib/runner.mjs'
import { PROMPT_VARIANTS } from './prompt-variants.mjs'
import { REPO } from '../lib/config.mjs'
import { fixtureEmpty } from '../lib/fixtures.mjs'

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const has = (n) => argv.includes('--' + n)

const variant = has('tiny') ? 'tiny' : has('slim') ? 'slim' : has('nosuffix') ? 'nosuffix'
  : has('receipt') ? 'receipt' : has('noinject') ? 'noinject' : 'default'
const arm = arg('arm', 'handoff-' + variant)
const n = Number(arg('n', '0'))   // 0 = 全跑
const cc = Number(arg('cc', '3'))

// 语料
const { TASKS } = await import('./corpus-handoff.mjs')
let list = TASKS
if (n > 0) list = list.slice(0, n)

// 判分：直接用产品函数（禁止自评）
const { checkHandoffCriteriaPre } = await import(
  'file:///' + REPO.replace(/\\/g, '/') + '/lib/wb-contract.js'
)

/** 从成功写入的 memory_note 入参里取账本（口径见 lib/judge.mjs 的说明） */
function pickLedger(writes) {
  const hs = writes.handoffs
  if (!hs.length) return null
  return hs[hs.length - 1].content
}

const judgeFn = async ({ writes }) => {
  const text = pickLedger(writes)
  if (!text) {
    return { pass: false, detail: ['★没有成功的 memory_note(kind=handoff) 调用'], metrics: { attempts: writes.handoffs.length } }
  }
  const r = checkHandoffCriteriaPre(text)
  const pollution = String(text).split(/\r?\n/)
    .filter(l => /^##\s/.test(l) && /[（(]\s*type\s*[:：]/i.test(l)).length
  const detail = []
  detail.push(`hardPass=${r.hardPass} chars=${String(text).length}`)
  for (const h of r.hard) if (!h.pass) detail.push(`★${h.id}: ${(h.missing || []).join('|').slice(0, 90)}`)
  detail.push(`标题污染 ${pollution} 处`)
  return {
    pass: r.hardPass,
    detail,
    metrics: {
      chars: String(text).length,
      H1: r.hard.find(h => h.id === 'H1')?.pass,
      H2: r.hard.find(h => h.id === 'H2')?.pass,
      H3: r.hard.find(h => h.id === 'H3')?.pass,
      H4: r.hard.find(h => h.id === 'H4')?.pass,
      pollution,
      attempts: writes.handoffs.length,
    },
  }
}

console.log(`[suite] handoff · variant=${variant}（${PROMPT_VARIANTS[variant].label}）· ${list.length} 条 · 并发 ${cc}`)

const rows = await runSuite({
  suiteTag: arm,
  scenarios: list,
  concurrency: cc,
  cfgPatch: PROMPT_VARIANTS[variant].cfg,
  seed: async ({ cwd }) => fixtureEmpty(cwd),
  judgeFn,
})

const s = summarize(arm, rows)
console.log('')
console.log(`${arm}  通过 ${s.pass}/${s.n} (${s.n ? Math.round(s.pass / s.n * 100) : 0}%)  超时 ${s.killed}  违规 ${s.viol}`)

// 一次写对率（有分辨力的那个指标）
const firstTry = rows.filter(r => r.metrics && r.metrics.attempts === 1 && r.pass).length
const retried = rows.filter(r => r.metrics && r.metrics.attempts > 1).length
const polluted = rows.filter(r => r.metrics && r.metrics.pollution > 0).length
console.log(`一次写对 ${firstTry}/${s.n}   需重试 ${retried}/${s.n}   标题污染 ${polluted}/${s.n}`)

const fails = rows.filter(r => !r.pass)
if (fails.length) {
  console.log('')
  console.log('失败明细：')
  for (const r of fails) console.log(`  ${r.scenario.padEnd(12)} ${(r.detail || []).join(' / ').slice(0, 150)}`)
}
process.exitCode = fails.length ? 1 : 0
