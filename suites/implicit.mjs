/**
 * 套件 E · 隐性触发（模型会不会**自己**想起要写）
 *
 * 用法：node suites/implicit.mjs [--cc 3] [--reps 1] [--tag implicit]
 *
 * ⚠️ 场景数据在 suites/implicit-scenarios.mjs —— 那是**纯数据模块**，
 *    顶层不执行任何东西，供实验层安全 import。
 *    本文件只负责跑。（历史上数据与执行混在一起，导致 import 它就等于跑整套；
 *    实验层一开始 import 这份文件，直接把整套隐式实验在后台启动了。）
 */
import { runSuite, summarize } from '../lib/runner.mjs'
import { fixtureEmpty } from '../lib/fixtures.mjs'
import { IMPLICIT_SCENARIOS, judgeImplicit } from './implicit-scenarios.mjs'
const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const tag = arg('tag', 'implicit')
const cc = Number(arg('cc', '3'))
const reps = Number(arg('reps', '1'))

const scenarios = []
for (let r = 1; r <= reps; r++) {
  for (const s of IMPLICIT_SCENARIOS) {
    scenarios.push({ ...s, id: reps > 1 ? `${s.id}-r${r}` : s.id })
  }
}

console.log(`[suite] implicit（隐性触发）· ${scenarios.length} 次 · 并发 ${cc}`)
console.log('[suite] 场景里**不提任何记忆工具名**，只给对话原文 + 一句通用收尾')

const rows = await runSuite({
  suiteTag: tag,
  scenarios,
  concurrency: cc,
  cfgPatch: { promptLayerOverrides: {} },
  seed: async ({ cwd }) => fixtureEmpty(cwd),
  judgeFn: judgeImplicit,
})

const s = summarize(tag, rows)
console.log('')
console.log(`通过 ${s.pass}/${s.n} (${s.n ? Math.round(s.pass / s.n * 100) : 0}%)  违规 ${s.viol}`)

// 按期望类型拆（这是本套件的核心读数）
const byWant = {}
for (const r of rows) {
  const sc = IMPLICIT_SCENARIOS.find(x => r.scenario.startsWith(x.id))
  const w = sc ? sc.expect.want : '?'
  byWant[w] = byWant[w] || { p: 0, n: 0 }
  byWant[w].n++
  if (r.pass) byWant[w].p++
}
console.log('')
console.log('按期望类型：')
for (const [w, v] of Object.entries(byWant)) {
  console.log(`  ${w.padEnd(14)} ${v.p}/${v.n}  ${Math.round(v.p / v.n * 100)}%`)
}

console.log('')
console.log('逐条：')
for (const r of rows) {
  const m = r.metrics || {}
  console.log(
    `  ${String(r.scenario).padEnd(22)} ${r.pass ? 'PASS' : 'FAIL'}  ` +
    `sg=${m.sharedGround || 0} cm=${m.commitment || 0} up=${m.userPercept || 0} cal=${m.calendar || 0} ho=${m.handoff || 0}`,
  )
}
