/**
 * 实验 CLI —— 不用起 HTTP 服务也能跑实验。
 *
 * 用法：
 *   node experiments/run.mjs                          # 列出可用实验
 *   node experiments/run.mjs <name> --dry-run         # 只校验配置，不跑
 *   node experiments/run.mjs <name>                   # 跑
 *   node experiments/run.mjs <name> --reps 5 --cc 3   # 覆盖 reps / 并发
 *
 * 退出码：
 *   0  成功
 *   1  配置校验失败（打印每条 error 的 code / msg / hint）
 *   2  运行失败
 */
import path from 'node:path'
import {
  listExperiments, loadExperiment, validateExperiment,
} from '../lib/experiment.mjs'
import { runExperiment } from '../lib/experiment-run.mjs'
import { SCENARIOS } from '../suites/scenarios.mjs'
import { IMPLICIT_SCENARIOS } from '../suites/implicit-scenarios.mjs'

/** 该套件有哪些场景 id —— 用于抓拼错的场景名（否则会静默少跑） */
async function knownScenariosFor(suite) {
  if (suite === 'implicit') return IMPLICIT_SCENARIOS.map(s => s.id)
  if (suite === 'handoff') {
    const { TASKS } = await import('../suites/corpus-handoff.mjs')
    return TASKS.map((t, i) => (typeof t === 'string' ? 'handoff-' + i : (t.id || 'handoff-' + i)))
  }
  return SCENARIOS.map(s => s.id)
}

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const has = (n) => argv.includes('--' + n)
const target = argv.find(a => !a.startsWith('--'))

if (!target) {
  const list = listExperiments()
  console.log('可用实验（experiments/）:')
  if (!list.length) console.log('  （无 —— 新建一个 .mjs，见 experiments/percept-sentence-table.mjs）')
  for (const e of list) console.log('  · ' + e.id)
  console.log('')
  console.log('校验: node experiments/run.mjs <name> --dry-run')
  console.log('运行: node experiments/run.mjs <name>')
  process.exit(0)
}

const loaded = await loadExperiment(target)
if (!loaded.ok) {
  console.error('✗ ' + loaded.error)
  process.exit(1)
}

// 命令行覆盖（便于临时调整，不必改文件）
const cfg = { ...loaded.config }
if (arg('reps')) cfg.reps = Number(arg('reps'))
if (arg('cc')) cfg.concurrency = Number(arg('cc'))
if (arg('scenarios')) cfg.scenarios = String(arg('scenarios')).split(',').map(s => s.trim())

console.log('═══ 实验校验 ═══')
console.log('文件   ' + path.basename(loaded.file))
console.log('名称   ' + cfg.name)
if (cfg.description) console.log('说明   ' + cfg.description)
console.log('')

const v = validateExperiment(cfg, { knownScenarios: await knownScenariosFor(cfg.suite || 'families') })

// 层注册表摘要（让人一眼看出「能改什么」）
if (v.registry && v.registry.ok) {
  const reg = v.registry
  const dead = Object.entries(reg.layers).filter(([, x]) => x.dead).map(([k]) => k)
  console.log('提示词层注册表（' + Object.keys(reg.layers).length + ' 层）')
  console.log('  slim    ' + reg.byPath.slim.length + ' 层 —— 仅在精简版帧出现')
  console.log('  dynamic ' + reg.byPath.dynamic.length + ' 层 —— 每轮动态快照')
  console.log('  static  ' + reg.byPath.static.length + ' 层 —— 固定纪律')
  console.log('  死键    ' + (dead.length ? dead.join(', ') : '（无）'))
  console.log('')
}

for (const [arm, m] of Object.entries(v.matrix || {})) {
  const cad = m.cadence || {}
  console.log(`臂 ${arm}`)
  console.log(`  改的层   ${m.layers.length ? m.layers.join(', ') : '（无，纯基线）'}`)
  console.log(`  注入节奏 gap=${cad.snapshotMinGapRounds} slimEvery=${cad.slimEveryRounds}`
    + ` tiered=${cad.snapshotTieredInject} inject=${m.injectEnabled}`)
  for (const p of m.problems || []) console.log('  ★ ' + p)
}
console.log('')

if (v.errors.length) {
  console.log('✗ ' + v.errors.length + ' 项错误（跑之前必须先修）:')
  for (const e of v.errors) {
    console.log(`  [${e.code}] ${e.msg}`)
    if (e.hint) console.log(`       → ${e.hint}`)
    for (const r of (e.reasons || [])) console.log(`       → ${r}`)
  }
  console.log('')
}
if (v.warnings.length) {
  console.log('⚠ ' + v.warnings.length + ' 项提醒（能跑，但读结论要打折）:')
  for (const w of v.warnings) console.log(`  [${w.code}] ${w.msg}`)
  console.log('')
}

if (has('dry-run')) {
  console.log(v.ok ? '✓ 配置可用（--dry-run 不实际运行）' : '✗ 配置不可用')
  process.exit(v.ok ? 0 : 1)
}

if (!v.ok) {
  console.log('✗ 校验未通过，拒绝运行 —— 这类错误跑起来只会得到空转结果')
  process.exit(1)
}

console.log('═══ 开始运行 ═══')
console.log(`场景 ${(cfg.scenarios || []).length} 个 × 臂 ${Object.keys(cfg.arms).length} 个 × ${cfg.reps} 次`
  + ` = ${(cfg.scenarios || []).length * Object.keys(cfg.arms).length * cfg.reps} 条`)
console.log('')

const t0 = Date.now()
const res = await runExperiment({ config: cfg })
const dur = Math.round((Date.now() - t0) / 1000)

console.log('')
console.log('═══ 结果 ═══')
console.log(`状态 ${res.status} · ${res.progress.done}/${res.progress.total} 条 · ${dur}s`)
console.log(`违规 ${res.violations} · 可疑 ${res.suspicious}`)
console.log('')
const w = Math.max(...Object.keys(res.arms).map(a => a.length), 3)
for (const [a, s] of Object.entries(res.arms)) {
  const pct = Math.round(s.rate * 100)
  const bar = '█'.repeat(Math.round(pct / 5)).padEnd(20, '·')
  console.log(`  ${a.padEnd(w)}  ${String(s.pass + '/' + s.n).padStart(7)}  ${String(pct).padStart(3)}%  ${bar}`)
}
if (res.comparisons && res.comparisons.length) {
  console.log('')
  console.log('臂间对比（以第一个臂为基线）:')
  for (const c of res.comparisons) {
    const sign = c.delta > 0 ? '+' : ''
    console.log(`  ${c.a} → ${c.b}: ${sign}${(c.delta * 100).toFixed(1)} pp`
      + `（${c.nA} vs ${c.nB} 条；${c.note}）`)
    for (const d of (c.detail || []).filter(x => x.delta !== 0)) {
      console.log(`      ${d.scenario.padEnd(16)} ${(d[c.a] * 100).toFixed(0)}% → ${(d[c.b] * 100).toFixed(0)}%`)
    }
  }
}
if (res.warnings && res.warnings.length) {
  console.log('')
  console.log('⚠ 读结论前请先看这些:')
  for (const x of res.warnings) console.log(`  [${x.code}] ${x.msg}`)
}
console.log('')
console.log('结果已落盘: ' + res.runId)
process.exit(res.status === 'done' ? 0 : 2)
