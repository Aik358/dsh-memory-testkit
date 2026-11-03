/**
 * 套件 F · 外部基准校准
 *
 * 用法：
 *   # Ornn8（需要先 clone 它的公开示例）
 *   export TESTKIT_ORNN8_DIR=/path/to/memory-system-benchmark
 *   node suites/external.mjs --bench ornn8 --dry-run
 *   node suites/external.mjs --bench ornn8 --only-missing
 *
 *   # LongMemEval（需要先下载数据）
 *   export TESTKIT_LME_DIR=/path/to/longmemeval
 *   node suites/external.mjs --bench lme --only abs,knowledge-update --limit 6
 *
 * ═══ 这个套件存在的理由 ═══
 * 本套件的判据是自己设计的，最大的盲区是「只测到了我们想到的东西」。
 * 外部基准补的正是这个：它们的考点是从大量真实使用里归纳的，
 * 而且带**结构化判据**（必须做到 / 不能这样答），比自己写的更严格。
 *
 * ═══ 三条纪律 ═══
 * 1. **不内置外部数据**。不 clone / 不下载就没有外部场景 —— 明确报错而非静默跳过。
 *    理由：许可、体积、版本漂移，以及「以为测了其实没测」。
 * 2. **不宣称与官方榜可比**。单轮接法测的是「给定素材后能不能答对」，
 *    官方测的是「回放全部历史后还记不记得」。报告里必须标 mode。
 * 3. **规则判分的置信度要如实标**。官方用 GPT-4o 当裁判，我们用字符包含，
 *    假阳性风险更高 ⇒ 每条结果带 `confidence`。
 */
import { runSuite, summarize } from '../lib/runner.mjs'
import { fixtureEmpty } from '../lib/fixtures.mjs'
import { finalText } from '../lib/driver.mjs'
import { instructions as lmeInstructions } from '../lib/external-longmemeval.mjs'
import {
  loadOrnn8, toSingleTurnScenario as ornn8Scenario, judgeExternal, coverageReport as ornn8Coverage,
  ORNN8_CATEGORIES,
} from '../lib/external-ornn8.mjs'
import {
  loadLongMemEval, toSingleTurnScenario as lmeScenario, judgeLongMemEval,
  coverageReport as lmeCoverage, LME_TYPES,
} from '../lib/external-longmemeval.mjs'

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const has = (n) => argv.includes('--' + n)

const bench = arg('bench', 'both')          // ornn8 | lme | both
const only = arg('only', '')                // 逗号分隔的类型/考点过滤
const limit = Number(arg('limit', '0'))     // 0 = 全部
const cc = Number(arg('cc', '2'))
const dryRun = has('dry-run')
/** 只跑我们原本没覆盖的考点 —— 这是本套件最该用的模式 */
const onlyMissing = has('only-missing')
const reps = Number(arg('reps', '1'))

/* ─────────────── 覆盖率总览 ─────────────── */

function printCoverage() {
  const a = ornn8Coverage()
  const b = lmeCoverage()
  console.log('═══ 外部基准覆盖对比（我们原本测不到的部分）═══')
  console.log('')
  console.log(`Ornn8（27 考点）        已覆盖 ${a.covered}/${a.total}`)
  console.log(`LongMemEval（7 类）     已覆盖 ${b.covered}/${b.total}`)
  console.log('')
  console.log('★ 我们缺的（这些是本套件原本完全没测的能力）：')
  const seen = new Set()
  for (const m of a.missing) {
    const key = m.name
    if (seen.has(key)) continue
    seen.add(key)
    console.log('  · Ornn8 ' + m.id + ' ' + m.name + ' —— ' + (m.note || ''))
  }
  for (const m of b.missing) {
    console.log('  · LME   ' + m.id.padEnd(26) + ' —— ' + (m.note || ''))
  }
  console.log('')
}

printCoverage()

if (dryRun && !arg('bench')) {
  console.log('（--dry-run 且未指定 --bench：只打印覆盖率，不跑题）')
  process.exit(0)
}

/* ─────────────── 组装场景 ─────────────── */

const scenarios = []
const judgeMap = new Map()   // scenarioId → { fn, meta }
const provenance = []        // 数据来源（commit / 文件 / 日期），写进报告

// ── Ornn8 ──
if (bench === 'ornn8' || bench === 'both') {
  const dir = process.env.TESTKIT_ORNN8_DIR || arg('ornn8-dir', '')
  if (!dir) {
    console.log('⚠ 未设 TESTKIT_ORNN8_DIR，跳过 Ornn8')
    console.log('  需要先：git clone --depth 1 https://github.com/Ornn8/memory-system-benchmark')
    console.log('')
  } else {
    const r = loadOrnn8(dir)
    if (!r.ok) {
      console.error('✗ Ornn8 载入失败：' + r.error)
    } else {
      provenance.push({
        source: 'ornn8', repo: 'https://github.com/Ornn8/memory-system-benchmark',
        commit: r.commit, file: r.file, items: r.items.length,
        caveat: '仅公开示例（1 人物/27 考点/108 实例），不是正式卷；不能用于排名',
      })
      // 选哪些考点
      let pool = r.items
      if (onlyMissing) {
        const missingIds = new Set(ORNN8_CATEGORIES.filter(c => !c.covered).map(c => c.id))
        pool = r.items.filter(x => {
          const cs = x.id.split('/')[0].split('-').pop()   // PUB01-C001 → C001
          return missingIds.has(cs)
        })
      }
      if (only) {
        const want = only.split(',').map(s => s.trim())
        pool = pool.filter(x => want.some(w => x.category.includes(w) || x.id.includes(w)))
      }
      if (limit > 0) pool = pool.slice(0, limit)

      // 每个考点只取「当天」那一档做单轮（其它档要回放才有意义）
      for (const item of pool) {
        const sc = ornn8Scenario(item)
        scenarios.push(sc)
        judgeMap.set(sc.id, {
          fn: async ({ rows }) => {
            // 判分素材：模型的**最终回复**（不是写入内容）
            const ans = String(finalText(rows || '') || '')
            const j = judgeExternal(sc.external, ans)
            return { pass: j.pass === true, detail: j.detail }
          },
          meta: { source: 'ornn8', judged: 'external-rubric' },
        })
      }
      console.log(`Ornn8：选中 ${pool.length} 个考点（共 ${r.items.length}，commit ${r.commit}）`)
    }
  }
}

// ── LongMemEval ──
if (bench === 'lme' || bench === 'both') {
  const dir = process.env.TESTKIT_LME_DIR || arg('lme-dir', '')
  if (!dir) {
    console.log('⚠ 未设 TESTKIT_LME_DIR，跳过 LongMemEval')
    console.log(lmeInstructions())
    console.log('')
  } else {
    const types = only ? only.split(',').map(s => s.trim()) : null
    // 只跑缺失类型时，优先取 abstention 与 knowledge-update（我们最缺且最有价值）
    const typesEff = types || (onlyMissing ? ['abstention', 'knowledge-update', 'temporal-reasoning', 'multi-session'] : null)
    const r = loadLongMemEval({ dir, file: arg('lme-file', 'lme_oracle.json'), types: typesEff, limit })
    if (!r.ok) {
      console.error('✗ LongMemEval 载入失败：' + r.error)
    } else {
      provenance.push({
        source: 'longmemeval', repo: 'https://github.com/xiaowu0162/LongMemEval',
        file: r.file, total: r.total, selected: r.selected, typeCounts: r.typeCounts,
        caveat: 'oracle 版（只含证据会话）；规则判分，不可与官方 GPT-4o 裁判分数比较',
      })
      for (const item of r.items) {
        const sc = lmeScenario(item)
        scenarios.push(sc)
        judgeMap.set(sc.id, {
          fn: async ({ rows }) => {
            const ans = String(finalText(rows || '') || '')
            const j = judgeLongMemEval(sc.external, ans)
            return {
              pass: j.pass === true,
              detail: [...j.detail, `[判分:${j.judge} 置信:${j.confidence}]`],
            }
          },
          meta: { source: 'longmemeval', judged: 'rule-based', type: item.type },
        })
      }
      console.log(`LongMemEval：选中 ${r.selected} 题 / 总 ${r.total}`)
      console.log('  类型分布：' + Object.entries(r.typeCounts).map(([k, v]) => k + '×' + v).join(', '))
    }
  }
}

if (!scenarios.length) {
  console.log('')
  console.log('✗ 没有任何外部场景 —— 上面的提示里说明怎么准备数据。')
  console.log('  这不视为失败：外部数据需要按各自的许可单独获取。')
  process.exit(0)
}

/* ─────────────── 跑 ─────────────── */

console.log('')
console.log(`═══ 开始跑（${scenarios.length} 题 × ${reps} 次，并发 ${cc}）═══`)

// 展开 reps
const list = []
for (let i = 1; i <= reps; i++) {
  for (const s of scenarios) list.push(reps > 1 ? { ...s, id: s.id + '-r' + i } : s)
}

if (dryRun) {
  console.log('（--dry-run：只打印将跑的题，不实际起会话）')
  for (const s of list.slice(0, 20)) {
    console.log('  · ' + s.id.padEnd(28) + s.label.slice(0, 60))
  }
  if (list.length > 20) console.log(`  …还有 ${list.length - 20} 题`)
  process.exit(0)
}

/**
 * 外部题的判分需要「模型的最终回复」。
 *
 * 取法：judgeFn 能拿到 doRunScenario 的 `rows`（NDJSON 事件），
 * 用 driver 的 `finalText(rows)` 抽出最终回复 —— 与 runner 里同源，
 * 不存在两套口径。**不要**用 scenario 上的临时字段传值（那会在并发下串题）。
 */
const rows = await runSuite({
  suiteTag: arg('tag', 'external'),
  scenarios: list.map(s => ({ ...s })),
  concurrency: cc,
  cfgPatch: { promptLayerOverrides: {} },
  seed: async ({ cwd }) => fixtureEmpty(cwd),
  judgeFn: async (ctx) => {
    // reps 展开后 id 带 -rN 后缀，回查时要剥掉
    const meta = judgeMap.get(ctx.scenario.id) || judgeMap.get(String(ctx.scenario.id).replace(/-r\d+$/, ''))
    if (!meta) return { pass: false, detail: ['没有为这个场景注册判据'] }
    return meta.fn(ctx)
  },
})

const s = summarize(arg('tag', 'external'), rows)
console.log('')
console.log(`通过 ${s.pass}/${s.n} (${s.n ? Math.round(s.pass / s.n * 100) : 0}%)  违规 ${s.viol}  平均 ${s.avgSec}s`)

/* ─────────────── 按来源/类型拆 ─────────────── */

const byFam = {}
for (const r of rows) {
  const f = r.family || '?'
  byFam[f] = byFam[f] || { p: 0, n: 0 }
  byFam[f].n++
  if (r.pass) byFam[f].p++
}
if (Object.keys(byFam).length > 1) {
  console.log('')
  console.log('按考点：')
  for (const [f, v] of Object.entries(byFam).sort((a, b) => b[1].n - a[1].n)) {
    const pct = v.n ? Math.round(v.p / v.n * 100) : 0
    console.log(`  ${f.padEnd(38)} ${String(v.p + '/' + v.n).padStart(6)}  ${pct}%`)
  }
}

/* ─────────────── 数据来源与局限（必须打印） ─────────────── */

console.log('')
console.log('═══ 数据来源与局限（读结论前必看）═══')
for (const p of provenance) {
  console.log(`· ${p.source}`)
  console.log(`    ${p.repo}${p.commit ? ' @ ' + p.commit : ''}`)
  if (p.file) console.log(`    文件 ${p.file}`)
  console.log(`    ⚠ ${p.caveat}`)
}
console.log('· 本次接法：mode=single（把证据会话一次给出）')
console.log('    ⇒ 测的是「给定素材后能否答对」，**不是**「回放全部历史后还记不记得」')
console.log('    ⇒ 不可与官方榜分数直接比较')
console.log('· 判分：规则（字符包含），非官方 GPT-4o 裁判')
console.log('    ⇒ 假阳性风险更高；标注 confidence=low 的条目需人工复核')
