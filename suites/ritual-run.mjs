/**
 * 套件 B 入口 · 接续前刷新仪式
 *
 * 用法：
 *   node suites/ritual.mjs                      # 全部版本 × 全部世界
 *   node suites/ritual.mjs --versions R0_current,R3_revision
 *   node suites/ritual.mjs --worlds hasEvent,empty
 *   node suites/ritual.mjs --reps 2             # 每个组合重复次数
 *
 * ★ 这个套件必须**真调工具** —— 它测多步编排能否走通，离线评判测不出来。
 *
 * ★★ 关键指标是「有事件世界的完成率」。产品的真实缺陷在这里：
 *   实测空库 92%、已有事件 15%（13 次里 11 次超时），且四个提示词版本都救不了。
 *   瓶颈在 memory_recall(scope=events) 的词法匹配 —— 模型得猜中关键词。
 */
import { runSuite, summarize } from '../lib/runner.mjs'
import { buildRitualScenarios, judgeRitual } from './ritual.mjs'
import { fixtureWithEvents, fixtureEmpty, fixtureSingleEvent } from '../lib/fixtures.mjs'
import { RITUAL_VERSIONS } from './ritual-prompts.mjs'

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}

const versions = arg('versions', Object.keys(RITUAL_VERSIONS).join(',')).split(',').map(s => s.trim())
const worlds = arg('worlds', 'hasEvent,empty').split(',').map(s => s.trim())
const reps = Number(arg('reps', '1'))
const cc = Number(arg('cc', '2'))
const tag = arg('tag', 'ritual')

// 展开重复
const base = buildRitualScenarios({ versionKeys: versions, worlds })
const scenarios = []
for (let i = 1; i <= reps; i++) {
  for (const s of base) scenarios.push({ ...s, id: reps > 1 ? `${s.id}-r${i}` : s.id })
}

console.log(`[suite] ritual · 版本 [${versions.join(',')}] · 世界 [${worlds.join(',')}] · ${scenarios.length} 次 · 并发 ${cc}`)

const seed = async ({ cwd, scenario }) => {
  const w = scenario._world
  if (w === 'hasEvent') {
    const dir = fixtureWithEvents(cwd)
    scenario._preEventIds = ['evt_act11111', 'evt_old22222', 'evt_act33333']
    scenario._closedIds = ['evt_old22222']
    return dir
  }
  if (w === 'single') {
    const dir = fixtureSingleEvent(cwd)
    scenario._preEventIds = ['evt_single01']
    scenario._closedIds = []
    return dir
  }
  const dir = fixtureEmpty(cwd)
  scenario._preEventIds = []
  scenario._closedIds = []
  return dir
}

const rows = await runSuite({
  suiteTag: tag,
  scenarios,
  concurrency: cc,
  cfgPatch: { promptLayerOverrides: {} },
  seed,
  judgeFn: judgeRitual,
  timeoutMs: 240000,   // 仪式有 120s 预算，给一倍余量
})

const s = summarize(tag, rows)
console.log('')
console.log(`通过 ${s.pass}/${s.n}  超时 ${s.killed}  违规 ${s.viol}  平均 ${s.avgSec}s`)

// 按世界拆开（这是本套件最有价值的读数）
const byWorld = {}
for (const r of rows) {
  const w = (r.scenario.match(/-(hasEvent|empty|single)(-r\d+)?$/) || [])[1] || '?'
  byWorld[w] = byWorld[w] || { p: 0, n: 0, killed: 0, secs: [] }
  byWorld[w].n++
  if (r.pass) byWorld[w].p++
  if (r.killed) byWorld[w].killed++
  byWorld[w].secs.push(r.seconds || 0)
}
console.log('')
console.log('按世界拆：')
for (const [w, v] of Object.entries(byWorld)) {
  const avg = Math.round(v.secs.reduce((a, b) => a + b, 0) / v.n)
  console.log(`  ${w.padEnd(10)} ${v.p}/${v.n} (${Math.round(v.p / v.n * 100)}%)  超时 ${v.killed}  平均 ${avg}s`)
}

const fails = rows.filter(r => !r.pass)
if (fails.length) {
  console.log('')
  console.log('失败明细：')
  for (const r of fails) {
    console.log(`  ${r.scenario.padEnd(34)} ${r.killed ? '★超时 ' : ''}${(r.detail || []).join(' / ').slice(0, 150)}`)
    if (r.recallQueries && r.recallQueries.length) {
      console.log(`      recall 尝试 ${r.recallQueries.length} 次: ${r.recallQueries.slice(0, 5).map(q => JSON.stringify(q)).join(' ')}`)
    }
  }
}
process.exitCode = fails.length ? 1 : 0
