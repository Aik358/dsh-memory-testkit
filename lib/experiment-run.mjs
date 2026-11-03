/**
 * 实验执行器 —— 把声明式配置跑成一张可算显著性的结果表。
 *
 * ═══ 与 suites/*.mjs 的分工 ═══
 *   suites/  手写套件：一次一个变量，参数用命令行开关
 *   lib/experiment.mjs + 本文件：声明式实验，一次多个臂 × 多个场景
 *
 * 两者共用 runScenario（同一套沙箱/哨兵/判分），所以结果可比。
 *
 * ═══ 关键纪律 ═══
 * 1. **每个臂跑之前重写配置**（patchConfig 从完整基线出发）——
 *    否则上一个臂的覆盖会漏进下一个臂。这是 PITFALLS #28 的直接应用。
 * 2. **臂 × 场景用固定顺序展开后打乱**（round-robin 交错），
 *    否则「先跑完 A 臂再跑 B 臂」会让时间因素（缓存、限流、宿主负载）
 *    全部混进臂间差异里 —— 那是无法用统计补救的混杂。
 * 3. **comparisons 预先算好**，Agent 不需要自己遍历计数。
 */
import fs from 'node:fs'
import path from 'node:path'
import { runScenario } from './runner.mjs'
import { patchConfig, currentVariantSurface } from './runner.mjs'
import { PATHS, KIT_ROOT, WORK } from './config.mjs'
import { SCENARIOS } from '../suites/scenarios.mjs'
import { IMPLICIT_SCENARIOS, judgeImplicit } from '../suites/implicit-scenarios.mjs'
import { fixtureEmpty, fixtureWithEvents } from './fixtures.mjs'

/* ─────────────────── 实验运行态仓库（供 API 轮询） ─────────────────── */

const RUNS_DIR = path.posix.join(WORK, 'experiments')

function runsDir() {
  try { fs.mkdirSync(RUNS_DIR, { recursive: true }) } catch (_) {}
  return RUNS_DIR
}

function runFile(id) { return path.posix.join(runsDir(), id + '.json') }

export function readRun(id) {
  try { return JSON.parse(fs.readFileSync(runFile(id), 'utf8')) } catch (_) { return null }
}

export function listRuns() {
  let files = []
  try { files = fs.readdirSync(runsDir()) } catch (_) { return [] }
  return files.filter(f => /^exp-.*\.json$/.test(f)).map(f => {
    let meta = { runId: f.replace(/\.json$/, '') }
    try {
      const j = JSON.parse(fs.readFileSync(path.posix.join(runsDir(), f), 'utf8'))
      Object.assign(meta, {
        name: j.name, status: j.status, startedAt: j.startedAt, endedAt: j.endedAt,
        progress: j.progress, arms: Object.keys(j.arms || {}),
      })
    } catch (_) {}
    return meta
  }).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
}

function saveRun(state) {
  try { fs.writeFileSync(runFile(state.runId), JSON.stringify(state, null, 2), 'utf8') } catch (_) {}
}

/* ─────────────────── 场景解析 ─────────────────── */

function scenarioPool(suite) {
  if (suite === 'implicit') return IMPLICIT_SCENARIOS.map(s => ({ ...s, family: s.family || 'implicit' }))
  if (suite === 'handoff') {
    // handoff 语料是「任务文本」列表，需要包成场景
    return null // 由调用方注入（异步 import 避免顶层 await 破坏 require 场景）
  }
  return SCENARIOS
}

/** 按 id 选场景；id 也可以是 family 名（整面全选） */
function pickScenarios(pool, ids) {
  const set = new Set(ids)
  return pool.filter(s => set.has(s.id) || set.has(s.family))
}

/* ─────────────────── 执行 ─────────────────── */

/**
 * 跑一个实验。
 *
 * @param {object} cfgOrOpts
 * @param {object} cfgOrOpts.config   已校验的实验配置
 * @param {function} [cfgOrOpts.onProgress] 进度回调（每条完成时）
 * @param {string}   [cfgOrOpts.cancelFile] 出现该文件则中止（供 /cancel）
 * @returns {Promise<object>} 结果对象（也落盘）
 */
export async function runExperiment(cfgOrOpts) {
  const cfg = cfgOrOpts.config
  const onProgress = cfgOrOpts.onProgress || (() => {})
  const cancelFile = cfgOrOpts.cancelFile || null

  const runId = 'exp-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    + '-' + Math.random().toString(36).slice(2, 6)
  const suite = cfg.suite || 'families'

  // 场景池
  let pool = scenarioPool(suite)
  if (!pool && suite === 'handoff') {
    const { TASKS } = await import('../suites/corpus-handoff.mjs')
    pool = TASKS.map((t, i) => ({
      id: typeof t === 'string' ? 'handoff-' + i : (t.id || 'handoff-' + i),
      family: 'handoff',
      label: typeof t === 'string' ? t.slice(0, 60) : (t.label || ''),
      text: typeof t === 'string' ? t : t.text,
    }))
  }
  const uses = pickScenarios(pool || [], cfg.scenarios || [])
  if (!uses.length) {
    return { runId, status: 'failed', error: '场景 id 一个都没匹配上：' + (cfg.scenarios || []).join(', ') }
  }

  const reps = Math.max(1, Number(cfg.reps) || 1)
  const cc = Math.max(1, Math.min(4, Number(cfg.concurrency) || 2))
  const arms = Object.keys(cfg.arms || {})

  // ★ 交错展开：按 (rep, scenario, arm) 三层展开，再交错成执行序。
  //   这样同一时刻相邻的任务分属不同臂，时间因素被平摊到各臂。
  const tasks = []
  for (let r = 1; r <= reps; r++) {
    for (const sc of uses) {
      for (const armName of arms) tasks.push({ arm: armName, scenario: sc, rep: r })
    }
  }

  const state = {
    runId,
    name: cfg.name || path.basename(String(cfg.file || ''), '.mjs'),
    description: cfg.description || '',
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    config: {
      suite,
      reps,
      concurrency: cc,
      scenarios: cfg.scenarios,
      resolvedScenarios: uses.map(s => s.id),
      arms,
    },
    progress: { done: 0, total: tasks.length },
    arms: {},
    rows: [],
    violations: 0,
    suspicious: 0,
    nextAction: { kind: 'poll', api: 'GET /api/exp/run/' + runId },
    log: [],
  }
  for (const a of arms) state.arms[a] = { pass: 0, n: 0, rate: 0, seconds: [], detail: [] }
  saveRun(state)

  const log = (msg) => {
    state.log.push(String(msg).slice(0, 300))
    if (state.log.length > 200) state.log.shift()
  }

  let cancelled = false
  let cursor = 0
  const worker = async () => {
    while (true) {
      if (cancelled) return
      if (cancelFile && fs.existsSync(cancelFile)) { cancelled = true; return }
      const i = cursor++
      if (i >= tasks.length) return
      const t = tasks[i]

      // ★ 每个任务都按**它所属的臂**重写配置。
      //   同一臂内重复设置是幂等的；跨臂切换则必须重置 —— 否则会残留。
      const arm = cfg.arms[t.arm] || {}
      patchConfig({
        promptLayerOverrides: arm.layers || arm.promptLayerOverrides || {},
        ...(arm.cadence || {}),
        ...(arm.injectEnabled !== undefined ? { injectEnabled: arm.injectEnabled } : {}),
      })

      const tag = `exp-${t.arm}-${t.scenario.id}-r${t.rep}`.replace(/[^a-zA-Z0-9_.-]/g, '_')
      const seed = async ({ cwd }) => {
        if (t.scenario.setup === 'event') fixtureWithEvents(cwd)
        else fixtureEmpty(cwd)
      }

      let row
      try {
        const r = await runScenario({ ...t.scenario, id: tag }, {
          suiteTag: 'exp', seed,
          judgeFn: await pickJudge(cfg, suite),
        })
        row = { ...r, arm: t.arm, scenarioId: t.scenario.id, rep: t.rep, family: t.scenario.family }
      } catch (e) {
        row = {
          arm: t.arm, scenario: tag, scenarioId: t.scenario.id, rep: t.rep,
          family: t.scenario.family, pass: false,
          detail: ['异常：' + String(e && e.message || e).slice(0, 300)],
          seconds: 0, violations: 0, suspicious: 0,
        }
      }

      // 统计
      const A = state.arms[t.arm]
      A.n++
      if (row.pass) A.pass++
      A.rate = A.n ? Number((A.pass / A.n).toFixed(4)) : 0
      A.seconds.push(Number(row.seconds) || 0)
      if (!row.pass) A.detail.push({ scenario: t.scenario.id, rep: t.rep, detail: row.detail })
      state.violations += Number(row.violations) || 0
      state.suspicious += Number(row.suspicious) || 0
      state.rows.push(row)
      state.progress.done++

      saveRun(state)
      onProgress(state)
      process.stderr.write(`  [${runId}] ${t.arm}/${t.scenario.id} r${t.rep} → ${row.pass ? 'PASS' : 'FAIL'}`
        + ` ${Math.round(row.seconds || 0)}s\n`)
    }
  }

  await Promise.all(Array.from({ length: Math.min(cc, tasks.length) }, worker))

  state.endedAt = Date.now()
  state.status = cancelled ? 'cancelled' : 'done'
  state.comparisons = compareArms(state.arms, state.rows)
  state.warnings = buildWarnings(state, reps)
  state.nextAction = cancelled
    ? { kind: 'cancelled' }
    : { kind: 'ready', report: 'GET /api/exp/run/' + runId, monitor: 'http://127.0.0.1:8899' }
  saveRun(state)
  onProgress(state)
  return state
}

/** 自定义判据（judge.file）—— 约定 export default async ({scenario,writes,art}) => {pass,detail} */
async function loadJudge(spec) {
  const f = path.resolve(path.posix.join(KIT_ROOT, 'experiments'), String(spec.file || ''))
  const mod = await import('file:///' + f + '?t=' + Date.now())
  const fn = mod.default || mod.judge
  if (typeof fn !== 'function') throw new Error('judge.file 必须 export default async function')
  return fn
}

/**
 * 选判据：自定义 > 套件内置 > 通用 judge。
 *
 * ⚠️ 「套件内置」不能省。implicit 套件的判分逻辑与通用 judge 不同：
 *    它判的是「有没有**自发**写」，而通用 judge 按 expect 判字段形状。
 *    用错判据的后果是**结果看起来正常但含义全错**。
 *    历史上 implicit.mjs 与它的判据混在一个文件里，实验层只能整体 import，
 *    而那个文件顶层会直接开跑 —— 现在拆成 implicit-scenarios.mjs（纯数据）。
 */
async function pickJudge(cfg, suite) {
  if (cfg.judge && typeof cfg.judge === 'object') return await loadJudge(cfg.judge)
  if (typeof cfg.judge === 'string') {
    // 内置名：目前只支持 'families'（= 通用 judge）与 'implicit'
    if (cfg.judge === 'implicit' || suite === 'implicit') return judgeImplicit
    if (cfg.judge === 'families') return undefined
  }
  if (suite === 'implicit') return judgeImplicit
  return undefined
}

/**
 * 臂间对比 —— 预先算好，Agent 不必自己统计。
 *
 * 以**第一个臂**为基线，其余每个臂对它算 delta；同时给出经过的样本量与
 * 一个诚实的噪声提示（reps 少时不要当真）。
 */
function compareArms(arms, rows) {
  const names = Object.keys(arms)
  if (names.length < 2) return []
  const base = names[0]
  const out = []
  for (const other of names.slice(1)) {
    const A = arms[base], B = arms[other]
    // 同名场景上配对比较（同场景不同臂才是真配对）
    const byScene = {}
    for (const r of rows) {
      if (r.arm !== base && r.arm !== other) continue
      const k = r.scenarioId
      byScene[k] = byScene[k] || { [base]: { p: 0, n: 0 }, [other]: { p: 0, n: 0 } }
      byScene[k][r.arm].n++
      if (r.pass) byScene[k][r.arm].p++
    }
    const pairs = Object.entries(byScene)
      .filter(([, v]) => v[base].n > 0 && v[other].n > 0)
      .map(([scene, v]) => ({
        scenario: scene,
        [base]: v[base].p / v[base].n,
        [other]: v[other].p / v[other].n,
        delta: Number((v[other].p / v[other].n - v[base].p / v[base].n).toFixed(4)),
      }))
    const disc = pairs.filter(p => p.delta !== 0)
    out.push({
      a: base,
      b: other,
      rateA: A.rate,
      rateB: B.rate,
      delta: Number((B.rate - A.rate).toFixed(4)),
      nA: A.n,
      nB: B.n,
      pairedScenarios: pairs.length,
      discordantScenarios: disc.length,
      detail: pairs,
      note: pairs.length === 0 ? '没有共同场景，无法配对比较'
        : (disc.length === 0 ? '所有共同场景上无差异' : `${disc.length}/${pairs.length} 个场景有差异`),
    })
  }
  return out
}

function buildWarnings(state, reps) {
  const w = []
  if (reps < 3) w.push({ code: 'low-reps', msg: `reps=${reps}：单次/少量重复受采样噪声影响，差异不足以支撑结论` })
  if (state.violations > 0) w.push({ code: 'violations', msg: `有 ${state.violations} 项完整性违规，先查哨兵报告` })
  if (state.suspicious > 0) w.push({ code: 'suspicious', msg: `有 ${state.suspicious} 项可疑变化（宿主活跃期间的写入）` })
  const perArm = state.config.arms.map(a => ({ a, n: state.arms[a].n }))
  if (perArm.some(x => x.n === 0)) w.push({ code: 'empty-arm', msg: '有臂一条数据都没跑出来' })
  if (state.progress.done < state.progress.total) {
    w.push({ code: 'incomplete', msg: `只完成 ${state.progress.done}/${state.progress.total} 条` })
  }
  return w
}
