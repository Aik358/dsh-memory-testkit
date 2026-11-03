/**
 * 统一执行器 —— 单一场景的完整生命周期。
 *
 * 一次 runScenario = 预置夹具 → 快照 → 起会话 → 收输出 → 快照比对 → 判分。
 * 所有 suite 都复用它，保证「控制变量真的被控制住了」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { runHeadless, parseNdjson, finalText } from './driver.mjs'
import { fullSnapshot, compareSnapshot, saveReport, saveBaseline } from './sentinel.mjs'
import { emit, reset, emitFromNdjson } from './collector.mjs'
import { collectWrites, readArtifacts, judge } from './judge.mjs'
import { PATHS, TASK_TIMEOUT_MS } from './config.mjs'

/** 实时任务事件（监控台读它） */
export function liveEvent(suiteTag, obj) {
  try {
    fs.mkdirSync(PATHS.live, { recursive: true })
    fs.appendFileSync(
      path.posix.join(PATHS.live, String(suiteTag).replace(/[^a-zA-Z0-9_.-]/g, '_') + '.jsonl'),
      JSON.stringify({ ts: Date.now(), ...obj }) + '\n',
      'utf8',
    )
  } catch (_) {}
}

/**
 * 跑一个场景。
 * @param {object} scenario  { id, family, label, text, expect, setup? }
 * @param {object} opts      { suiteTag, timeoutMs? }
 */
export async function runScenario(scenario, opts = {}) {
  const suiteTag = opts.suiteTag || 'run'
  const tag = suiteTag + '-' + String(scenario.id).replace(/[^a-z0-9-]/gi, '')
  const cwd = path.posix.join(PATHS.ws, tag)

  fs.rmSync(cwd, { recursive: true, force: true })
  fs.mkdirSync(cwd, { recursive: true })

  // ① 夹具预置（必须在起会话之前，且要预置到**沙箱记忆库**而不是 cwd）
  if (typeof opts.seed === 'function') {
    await opts.seed({ cwd, scenario })
  }

  reset(tag)
  emit(tag, 'step', `=== ${scenario.id}：${scenario.label || ''} ===`)
  emit(tag, 'user', scenario.text)

  // ② 跑前快照
  const before = await fullSnapshot()
  saveBaseline(before)

  // ③ 真跑
  const res = await runHeadless({ cwd, task: scenario.text, timeoutMs: opts.timeoutMs || TASK_TIMEOUT_MS })

  // ④ 逐条输出
  emitFromNdjson(tag, res.stdout)
  if (res.stderr && res.stderr.trim()) emit(tag, 'err', res.stderr.slice(0, 2000))
  if (res.killed) emit(tag, 'err', `超时被杀（${Math.round(res.seconds)}s）`)

  // ⑤ 跑后快照 + 比对
  const after = await fullSnapshot()
  const guard = compareSnapshot(before, after)
  saveReport(tag, guard)

  // ⑥ 判分
  const rows = parseNdjson(res.stdout)
  const writes = collectWrites(rows)
  const art = readArtifacts(cwd)

  // 自定义判分优先（仪式这类多步编排不适合通用判据）
  const verdict = typeof opts.judgeFn === 'function'
    ? await opts.judgeFn({ scenario, writes, art, rows, before, after, res, killed: res.killed, seconds: res.seconds })
    : judge(scenario, writes, art)

  return {
    scenario: scenario.id,
    family: scenario.family,
    label: scenario.label || '',
    pass: !!verdict.pass,
    detail: verdict.detail || [],
    metrics: verdict.metrics || null,
    seconds: res.seconds,
    killed: res.killed,
    exit: res.code,
    violations: guard.violations.length,
    // ★ 宿主活跃时真实库的变化 —— 证据强度弱于 violations，单独计数
    suspicious: guard.suspicious ? guard.suspicious.length : 0,
    hostActive: guard.hostActive || null,
    ambientSkipped: guard.ambientSkipped.length,
    promptsSame: guard.promptsSame,
    sandboxWrites: guard.sandboxWrites.length,
    toolCount: writes.handoffs.length + writes.calendars.length + writes.events.length
      + writes.logs.length + writes.procedures.length + writes.otherTools.length,
    recallQueries: writes.recallQueries,
    finalHead: finalText(rows).slice(0, 200),
    writes: {
      handoff: writes.handoffs.length,
      userPercept: writes.percepts.userPercept.length,
      agentTrace: writes.percepts.agentTrace.length,
      sharedGround: writes.percepts.sharedGround.length,
      commitment: writes.percepts.commitment.length,
      calendar: writes.calendars.length,
      event: writes.events.length,
      log: writes.logs.length,
      procedure: writes.procedures.length,
    },
  }
}

/**
 * 跑一组场景（带并发）。
 *
 * @param {object} a
 * @param {string} a.suiteTag
 * @param {Array}  a.scenarios
 * @param {number} [a.concurrency]
 * @param {object} [a.cfgPatch]      要写进沙箱 dsh-auto-memory.json 的配置补丁
 * @param {function} [a.seed]
 * @param {function} [a.judgeFn]
 */
export async function runSuite(a) {
  const suiteTag = a.suiteTag
  const list = a.scenarios || []
  const cc = Math.max(1, Math.min(4, a.concurrency || 3))

  if (a.cfgPatch) patchConfig(a.cfgPatch)

  // 清空本 suite 的实时流
  try {
    fs.mkdirSync(PATHS.live, { recursive: true })
    fs.writeFileSync(path.posix.join(PATHS.live, suiteTag + '.jsonl'), '', 'utf8')
  } catch (_) {}

  const out = new Array(list.length)
  let cursor = 0
  const worker = async () => {
    while (true) {
      const i = cursor++
      if (i >= list.length) return
      const sc = list[i]
      liveEvent(suiteTag, { phase: 'start', taskId: sc.id, type: sc.family, taskHead: (sc.label || sc.text || '').slice(0, 90) })
      process.stderr.write(`  [${suiteTag}] ${sc.id} ...\n`)
      try {
        const r = await runScenario(sc, { suiteTag, seed: a.seed, judgeFn: a.judgeFn, timeoutMs: a.timeoutMs })
        out[i] = r
        liveEvent(suiteTag, { phase: 'done', ...r })
        process.stderr.write(
          `  [${suiteTag}] ${sc.id} → ${r.pass ? 'PASS' : 'FAIL'} | ${r.family} | ` +
          `${Math.round(r.seconds)}s | ${r.killed ? '★超时 ' : ''}${r.detail.join(' / ').slice(0, 130)}\n`,
        )
      } catch (e) {
        out[i] = {
          scenario: sc.id, family: sc.family, pass: false,
          detail: ['异常: ' + String(e && e.message || e).slice(0, 300)],
          seconds: 0, violations: 0,
        }
        liveEvent(suiteTag, { phase: 'done', ...out[i] })
        process.stderr.write(`  [${suiteTag}] ${sc.id} → ERROR ${e && e.message}\n`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(cc, list.length) }, worker))

  const clean = out.filter(Boolean)
  fs.mkdirSync(PATHS.raw, { recursive: true })
  fs.writeFileSync(path.posix.join(PATHS.raw, suiteTag + '.json'), JSON.stringify(clean, null, 2), 'utf8')
  return clean
}

/**
 * 沙箱配置的「出厂基线」—— 每个变体都从这里出发，未提及的键一律回到这里。
 *
 * ═══ 为什么必须是完整基线而不是「用当前的」 ═══
 * 变体写的是一份**增量补丁**（只列它要改的键）。如果未提及的键沿用磁盘上现值，
 * 那么上一次实验的改动就会泄漏进这一次 —— 而报告上仍写着 variant=default。
 * 那不是显示错误，是**自变量被上一次实验污染**，最严重的一类实验错误。
 *
 * 实证（2026-11-03）：
 *   跑过一次 `--noinject`（写 injectEnabled:false）之后，下一次 default 变体
 *   的 cfg 里没有 injectEnabled ⇒ 沿用 false ⇒ 整批任务都在「注入关闭」下跑完，
 *   而报告显示 variant=default、套件全绿。**全绿是假的。**
 *
 * ═══ 数值为什么是 20 / 8 而不是 0 ═══
 * 早先这里写 `snapshotMinGapRounds: 0`，注释理由是「排除无关变量」。
 * 但 0 的语义是**每轮都发完整版** ⇒ 精简版分支永不触发 ⇒
 * snapshotSlimMaintain / snapshotSlimGuide / snapshotSlimNote /
 * snapshotSlimRecallHit / snapshotSlimRecallNote **5 层根本不渲染**。
 * 于是「覆盖精简版措辞」这类实验改了等于没改，且不报错。
 * 实测：同一任务 4 step，gap=0 时覆盖标记不进上下文，gap=20 时才进。
 *
 * 20 / 8 = 产品 DEFAULT_SNAPSHOT_MIN_GAP_ROUNDS / DEFAULT_SLIM_EVERY_ROUNDS
 * （lib/index.js:534,546）。显式写死而不是「不写让它走默认」——
 * 因为套件要能复现，不能跟着产品默认值悄悄漂移。
 */
export const BASELINE_CFG = Object.freeze({
  injectEnabled: true,
  promptLayerOverrides: {},
  snapshotMinGapRounds: 20,
  slimEveryRounds: 8,
  snapshotTieredInject: true,
})

/** 把补丁写进沙箱配置（**只动沙箱那份**，不碰真实配置） */
export function patchConfig(patch) {
  const p = path.join(PATHS.dshHome, 'dsh-auto-memory.json')
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')) } catch (_) {}

  // ① 先回到基线（覆盖所有「变体控制面」的键）
  for (const [k, v] of Object.entries(BASELINE_CFG)) {
    cfg[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? { ...v } : v
  }
  // ② 再叠变体补丁（promptLayerOverrides 是**整块替换**，不合并 ——
  //    合并会让上一个变体的某一层残留下来，测的就不是纯变体了）
  for (const k of Object.keys(patch)) {
    cfg[k] = k === 'promptLayerOverrides' ? { ...(patch[k] || {}) } : patch[k]
  }

  try { fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8') } catch (e) {
    throw new Error('写沙箱配置失败（先跑 setup/preflight.mjs 初始化）: ' + e.message)
  }
  return cfg
}

/** 当前生效的「变体控制面」—— 供报告与自检核对「这次跑的真是我以为的那组」 */
export function currentVariantSurface() {
  const p = path.join(PATHS.dshHome, 'dsh-auto-memory.json')
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')) } catch (_) {}
  const out = {}
  for (const k of Object.keys(BASELINE_CFG)) {
    out[k] = k === 'promptLayerOverrides'
      ? Object.keys(cfg[k] || {})
      : cfg[k]
  }
  return out
}

/** 汇总一组结果 */
export function summarize(suiteTag, rows) {
  const n = rows.length
  const pass = rows.filter(r => r.pass).length
  const killed = rows.filter(r => r.killed).length
  const viol = rows.reduce((s, r) => s + (r.violations || 0), 0)
  const avgSec = n ? Math.round(rows.reduce((s, r) => s + (r.seconds || 0), 0) / n) : 0

  const byFam = {}
  for (const r of rows) {
    byFam[r.family] = byFam[r.family] || { p: 0, n: 0 }
    byFam[r.family].n++
    if (r.pass) byFam[r.family].p++
  }
  return { suiteTag, n, pass, killed, viol, avgSec, byFam }
}
