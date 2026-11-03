/**
 * 声明式实验层 —— 一份配置描述「跑哪些臂 × 哪些场景 × 怎么判」。
 *
 * ═══ 它要解决的问题 ═══
 * 之前每次做提示词实验都要**复制一份套件脚本改开关**。三个后果：
 *   ① 改一处要改三处（历史上真有三份 199 行的近似副本）
 *   ② 多变量实验没法表达（一次只能改一层）
 *   ③ 最危险的：改了不生效也看不出来（见 PITFALLS #27）
 *
 * ═══ 设计约束（都是踩出来的）═══
 * 1. **臂必须声明注入节奏**，不能只声明层。
 *    `snapshotSlimMaintain` 只在精简版帧出现；若该臂节奏让精简版永不触发，
 *    这次实验就是空跑。所以 `cadence` 是 arm 的一等公民，且 validate 会硬校验。
 * 2. **校验在跑之前做**，且默认 fail-fast。
 *    跑 30 条任务 × 20 分钟才发现「变量没生效」是最贵的错误。
 * 3. **配置只描述差异**，基线由 runner 的 BASELINE_CFG 提供（避免跨臂残留）。
 *
 * ═══ 形状 ═══
 * ```js
 * export default {
 *   name: 'percept-tuning',
 *   description: '把四类感知的触发条件换成句式表',
 *   scenarios: ['sg-strong', 'sg-weak'],      // 场景 id，来自 suites/scenarios.mjs
 *   suite: 'families',                         // 或 'handoff' / 'implicit'
 *   reps: 3,
 *   arms: {
 *     base: {},
 *     sentenceTable: {
 *       cadence: { snapshotMinGapRounds: 20, slimEveryRounds: 8 },
 *       layers: { staticPerceptDiscipline: '…' },
 *     },
 *   },
 *   judge: 'families',                         // 内置名，或 { file: './my-judge.mjs' }
 * }
 * ```
 */
import fs from 'node:fs'
import path from 'node:path'
import { KIT_ROOT } from './config.mjs'
import { BASELINE_CFG } from './runner.mjs'
import { buildLayerRegistry, pathReachable, PATHS as INJECT_PATHS } from './layers.mjs'

/** 实验配置目录 */
export const EXPERIMENTS_DIR = path.posix.join(KIT_ROOT, 'experiments')

/** 基线的注入开关（单独提出来，供 matrix 报告用） */
const BASE_INJECT = BASELINE_CFG.injectEnabled

/* ─────────────────────────── 加载 ─────────────────────────── */

/**
 * 列出可用实验配置。
 * 排除不是实验的文件：CLI 入口（run.mjs）、模板（.example.mjs）、辅助文件（_ 开头）。
 */
export function listExperiments() {
  let files = []
  try { files = fs.readdirSync(EXPERIMENTS_DIR) } catch (_) { return [] }
  return files
    .filter(f => f.endsWith('.mjs'))
    .filter(f => f !== 'run.mjs' && !f.endsWith('.example.mjs') && !f.startsWith('_'))
    .map(f => {
      let meta = {}
      try {
        const p = path.posix.join(EXPERIMENTS_DIR, f)
        const st = fs.statSync(p)
        meta = { file: f, id: f.replace(/\.mjs$/, ''), mtime: st.mtimeMs, size: st.size }
      } catch (_) { meta = { file: f, id: f.replace(/\.mjs$/, '') } }
      return meta
    })
}

/** 载入一个实验配置（`id` 或文件名）。返回 {ok, config, error, file} */
export async function loadExperiment(idOrFile) {
  const name = String(idOrFile || '').trim()
  if (!name || /[\\/]|\.\./.test(name)) {
    return { ok: false, error: '非法实验名：' + name }
  }
  const file = path.posix.join(EXPERIMENTS_DIR, name.endsWith('.mjs') ? name : name + '.mjs')
  if (!fs.existsSync(file)) return { ok: false, error: '实验配置不存在：' + file, file }
  try {
    const mod = await import('file:///' + file + '?t=' + Date.now())
    const cfg = mod.default || mod.experiment
    if (!cfg || typeof cfg !== 'object') {
      return { ok: false, error: '配置必须 export default { … }（或 export const experiment）', file }
    }
    return { ok: true, config: cfg, file }
  } catch (e) {
    return { ok: false, error: '加载失败：' + String(e && e.message || e).slice(0, 400), file }
  }
}

/* ─────────────────────────── 校验 ─────────────────────────── */

/**
 * 校验一个实验配置。
 *
 * 分两级：
 *   errors   —— 跑了一定拿不到可信结论（必须拒）
 *   warnings —— 能跑，但读结论时要打折
 *
 * @param {object} cfg
 * @param {object} [opts]
 * @param {object} [opts.registry]     复用层注册表（API 里缓存一份）
 * @param {string[]} [opts.knownScenarios] 已知场景 id（用于抓拼错的场景名）
 * @returns {{ok:boolean, errors:Array, warnings:Array, matrix?:object}}
 */
export function validateExperiment(cfg, opts = {}) {
  const errors = []
  const warnings = []
  const reg = opts.registry || buildLayerRegistry()

  if (!reg.ok) {
    errors.push({
      code: 'registry-unavailable',
      msg: '读不到提示词层注册表：' + reg.error,
      hint: '产品重构了渲染函数或 DEFAULT_PROMPT_LAYERS，先修 lib/layers.mjs',
    })
  }

  const push = (list, code, msg, extra) => list.push({ code, msg, ...(extra || {}) })

  // ① 基本形状
  if (!cfg.name || typeof cfg.name !== 'string') push(errors, 'no-name', '缺 name')
  if (!cfg.arms || typeof cfg.arms !== 'object' || !Object.keys(cfg.arms).length) {
    push(errors, 'no-arms', '缺 arms（至少要有一个臂）')
  }
  const armNames = Object.keys(cfg.arms || {})
  if (armNames.length === 1) push(warnings, 'single-arm', '只有一个臂 —— 没有对照，算不出差异')

  // ② 场景
  const scens = cfg.scenarios
  if (!Array.isArray(scens) || !scens.length) {
    push(errors, 'no-scenarios', 'scenarios 必须是非空数组（场景 id）')
  } else if (opts.knownScenarios && opts.knownScenarios.length) {
    // ★ 拼错的场景名如果不抓，会静默变成「0 条任务」或只跑了一半
    const known = new Set(opts.knownScenarios)
    const unknown = scens.filter(s => !known.has(s))
    if (unknown.length) {
      push(errors, 'unknown-scenario',
        `这些场景 id 在套件 ${cfg.suite || 'families'} 里不存在：${unknown.join(', ')}`,
        { unknown, hint: '拼错的话实验会少跑场景，而结果看起来完全正常' })
    }
  }
  const suiteName = cfg.suite || 'families'
  if (!['families', 'handoff', 'implicit'].includes(suiteName)) {
    push(errors, 'bad-suite', 'suite 只支持 families / handoff / implicit，收到 ' + suiteName)
  }

  // ③ 逐臂校验
  const matrix = {}
  for (const [armName, arm] of Object.entries(cfg.arms || {})) {
    if (arm == null) { matrix[armName] = { layers: [], cadence: {}, problems: [] }; continue }
    if (typeof arm !== 'object') {
      push(errors, 'bad-arm', `臂 ${armName} 必须是对象（空对象 = 纯基线）`, { arm: armName })
      continue
    }
    const layers = arm.layers || arm.promptLayerOverrides || {}
    const cadence = arm.cadence || {}
    const problems = []

    // ③a 层名必须存在
    for (const [k, v] of Object.entries(layers)) {
      const info = reg.ok ? reg.layers[k] : null
      if (reg.ok && !info) {
        problems.push(`层 ${k} 不在 DEFAULT_PROMPT_LAYERS 里（拼错了？）`)
        push(errors, 'unknown-layer', `臂 ${armName}：层 "${k}" 不存在`, { arm: armName, layer: k })
        continue
      }
      if (typeof v !== 'string') {
        problems.push(`层 ${k} 的值必须是字符串（真实换行要用多行字符串）`)
        push(errors, 'layer-not-string', `臂 ${armName}：层 "${k}" 的值不是字符串`, { arm: armName, layer: k })
        continue
      }
      if (v.trim() === '') {
        push(warnings, 'empty-override', `臂 ${armName}：层 "${k}" 是空串 —— 等于「用内置文本」，不是「清空」`,
          { arm: armName, layer: k })
      }
      // ③b 死键：改了完全无效
      if (info && info.dead) {
        push(errors, 'dead-layer',
          `臂 ${armName}：层 "${k}" 没有任何消费点（改了完全无效）`,
          { arm: armName, layer: k, hint: '它不是可覆盖层，或者产品的读取点改名了' })
        problems.push(`层 ${k} 是死键`)
      }
    }

    // ③c ★核心校验：该臂的节奏能不能走到它改的那条路径
    const effCfg = { ...BASELINE_CFG, ...cadence, injectEnabled: (arm.injectEnabled !== undefined ? arm.injectEnabled : BASELINE_CFG.injectEnabled) }
    if (arm.injectEnabled === false && Object.keys(layers).length) {
      push(errors, 'inject-off-with-layers',
        `臂 ${armName}：injectEnabled=false 却还改了 ${Object.keys(layers).length} 层 —— 这些都进不了上下文`,
        { arm: armName })
    }
    for (const [k] of Object.entries(layers)) {
      const info = reg.ok ? reg.layers[k] : null
      if (!info || info.dead) continue
      const blocked = info.paths
        .map(p => ({ p, r: pathReachable(p, effCfg) }))
        .filter(x => !x.r.reachable)
      if (blocked.length && blocked.length === info.paths.length) {
        push(errors, 'unreachable-layer',
          `臂 ${armName}：层 "${k}" 只属于 [${info.paths.join(', ')}] 路径，`
          + `而该臂节奏让这条路径不可达 —— 改了等于没改`,
          { arm: armName, layer: k, reasons: blocked.map(b => b.p + '：' + b.r.reason) })
        problems.push(`层 ${k} 不可达`)
      }
    }

    matrix[armName] = {
      layers: Object.keys(layers),
      cadence: { ...BASELINE_CFG, ...cadence },
      injectEnabled: arm.injectEnabled !== undefined ? arm.injectEnabled : BASE_INJECT,
      problems,
    }
  }

  // ④ 臂之间必须有差异（否则整场实验白跑）
  const sigs = Object.entries(cfg.arms || {}).map(([k, a]) => {
    const layers = (a && (a.layers || a.promptLayerOverrides)) || {}
    return [k, JSON.stringify({ l: Object.keys(layers).sort(), v: layers, c: (a && a.cadence) || {} })]
  })
  if (sigs.length > 1 && new Set(sigs.map(s => s[1])).size === 1) {
    push(errors, 'arms-identical', '所有臂的配置完全相同 —— 这次实验没有任何自变量')
  }

  // ⑤ reps / 判据
  const reps = Number(cfg.reps || 1)
  if (!(reps >= 1)) push(errors, 'bad-reps', 'reps 必须是 ≥1 的整数，收到 ' + cfg.reps)
  if (reps === 1) push(warnings, 'single-rep', 'reps=1：单次结果受采样噪声影响，不足以支撑结论')
  if (cfg.judge && typeof cfg.judge === 'object') {
    const f = path.resolve(EXPERIMENTS_DIR, String(cfg.judge.file || ''))
    if (!fs.existsSync(f)) push(errors, 'judge-missing', 'judge.file 不存在：' + f)
  }

  return { ok: errors.length === 0, errors, warnings, matrix, registry: reg }
}

