/**
 * 套件 A · 记忆面遵循能力（7 个面 × N 个场景）
 *
 * 用法：
 *   node suites/families.mjs                        # 默认提示词，全部场景
 *   node suites/families.mjs --slim 127             # 用内置 V1 最小集覆盖提示词
 *   node suites/families.mjs --tiny                 # 用内置 V3 极简（45 字符）
 *   node suites/families.mjs --noinject             # 关掉记忆注入（极限对照）
 *   node suites/families.mjs --only calendar,event  # 只跑指定面
 *   node suites/families.mjs --n 3 --cc 3           # 每面重复次数 / 并发
 *
 * ★ 设计要点：**同一份脚本 + 命令行开关**，不再为每个变量复制一份文件
 *   （旧实现有三份 199 行的近似副本，改一处要改三处）。
 */
import { runSuite, summarize } from '../lib/runner.mjs'
import { SCENARIOS } from './scenarios.mjs'
import { PROMPT_VARIANTS } from './prompt-variants.mjs'
import { fixtureWithEvents, fixtureEmpty } from '../lib/fixtures.mjs'

// ── 解析参数 ──
const argv = process.argv.slice(2)
const arg = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}
const has = (name) => argv.includes('--' + name)

const variant = has('tiny') ? 'tiny' : has('slim') ? 'slim' : has('noinject') ? 'noinject' : 'default'
const only = arg('only', '')
const tag = arg('tag', 'families-' + variant)
const repeats = Number(arg('n', '1'))
const cc = Number(arg('cc', '3'))

// ── 选场景 ──
let list = SCENARIOS
if (only) {
  const fams = only.split(',').map(s => s.trim())
  list = list.filter(s => fams.includes(s.family) || fams.includes(s.id))
}
// 需要预置事件的场景打上标记（runner 的 seed 会读到）
for (const s of list) if (s.setup === 'event') s._needOldEvent = true

// ── 夹具 ──
// 场景里凡是「有 eventId=evt_abc12345」的任务，都要真的把那个事件预置进 store，
// 否则模型查不到、只会新建（实测过：不预置时 ev-append 场景 100% 失败）。
const seed = async ({ cwd, scenario }) => {
  if (scenario.setup === 'event' || scenario._needOldEvent) {
    fixtureWithEvents(cwd)
  } else {
    fixtureEmpty(cwd)
  }
}

const promptCfg = PROMPT_VARIANTS[variant]
console.log(`[suite] families · variant=${variant}（${promptCfg.label}）· 场景 ${list.length} · 并发 ${cc}`)

const rows = await runSuite({
  suiteTag: tag,
  scenarios: list,
  concurrency: cc,
  cfgPatch: promptCfg.cfg,
  seed,
})

const s = summarize(tag, rows)
console.log('')
console.log(`${tag}  通过 ${s.pass}/${s.n} (${s.n ? Math.round(s.pass / s.n * 100) : 0}%)  ` +
  `超时 ${s.killed}  违规 ${s.viol}  平均 ${s.avgSec}s`)
for (const [f, v] of Object.entries(s.byFam)) console.log(`  ${f.padEnd(14)} ${v.p}/${v.n}`)

const fails = rows.filter(r => !r.pass)
if (fails.length) {
  console.log('')
  console.log('失败明细：')
  for (const r of fails) console.log(`  ${r.scenario.padEnd(16)} ${r.detail.join(' / ').slice(0, 160)}`)
}
process.exitCode = fails.length ? 1 : 0
