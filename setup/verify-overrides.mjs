/**
 * 注入面验收 —— 证明「改了提示词层，它真的进了模型上下文」。
 *
 * 这不是跑实验，是检验**实验的载体本身是否可靠**。两种失败都会静默：
 *   ① 层写了但注入路径不读它（比如精简版层 + gap=0）⇒ 改了等于没改
 *   ② 上次变体的键残留 ⇒ 这一批跑的不是你以为的那组配置
 *
 * 做法：写带唯一标记的多层覆盖 → 起一次**多步**会话（精简版只在非首帧出现）
 *      → 从会话日志里 grep 标记 → 还原配置。
 *
 * 用法：
 *   node setup/verify-overrides.mjs            # 全部层（推荐）
 *   node setup/verify-overrides.mjs --quick    # 只验最基本的 3 层
 */
import fs from 'node:fs'
import path from 'node:path'
import { PATHS } from '../lib/config.mjs'
import { runHeadless, findSessionsFor, readSessionEvents } from '../lib/driver.mjs'
import { BASELINE_CFG, patchConfig } from '../lib/runner.mjs'

const CFG = path.posix.join(PATHS.dshHome, 'dsh-auto-memory.json')
const quick = process.argv.includes('--quick')

/**
 * 标记按「注入路径」分组 —— 这是本脚本的核心，不是随便挑几层：
 *   完整版路径（gap 之外，每轮首次）→ snapshotHead / snapshotInscription
 *   精简版路径（只在非首帧出现）    → snapshotSlimMaintain / snapshotSlimGuide / snapshotSlimNote
 *   静态段拆层（无注入节奏约束）    → staticPerceptDiscipline
 *   动态条件段（仅在有日历条目时）  → 跳过，否则会把「条件不满足」误读成「覆盖失效」
 */
const GROUPS = {
  '完整版路径': {
    snapshotHead: '[MK-HEAD-V1] 记忆定位读法（覆盖验证）。',
    snapshotInscription: '[MK-INSCRIPTION-V1] 铭文（覆盖验证）。',
  },
  '精简版路径': {
    snapshotSlimMaintain: '[MK-SLIM-MAINTAIN-V1] 精简维护段（覆盖验证）。',
    snapshotSlimGuide: '[MK-SLIM-GUIDE-V1] 精简检索指引（覆盖验证）。',
    snapshotSlimNote: '[MK-SLIM-NOTE-V1] 精简注记（覆盖验证）。',
  },
  '静态段拆层': {
    staticPerceptDiscipline: '[MK-PERCEPT-V1] 四类感知纪律（覆盖验证）。',
  },
}

const CASES = quick
  ? {
    '完整版路径': { snapshotHead: GROUPS['完整版路径'].snapshotHead },
    '静态段拆层': GROUPS['静态段拆层'],
  }
  : GROUPS

/**
 * 「走的是哪条注入路径」的判据。
 *
 * ⚠️ 不能用层的默认文本当特征串 —— 那正好会被**覆盖覆盖掉**（实测踩过：
 *    覆盖生效后默认文本消失，于是「路径未出现」被误报成「精简版不可达」）。
 * 要挑**不受覆盖影响的结构性特征**：
 *   · 完整版与精简版都是 <memory_system> 块，区别在块内是否有「精简说明」的**语义**结构
 *   · 最稳的判据是：该块是否含「三层语义分工」（只有完整版有）／
 *     是否含唤回声明与维护段（只有精简版有）
 * 但由于两层都可能被覆盖，这里改看**注入次数与块长度**：
 *   首帧块 ≈ 完整版长度；后续帧若出现更短的块 ⇒ 精简版在用。
 */
const PATH_EVIDENCE = {
  // 完整版专属结构（用户规约 / 三层语义分工 / Tier-0 目录），这些不是任何可覆盖层
  full: ['三层语义分工', '用户规约 — 跨项目通用'],
  // 精简版专属结构：唤醒声明（renderSlimSnapshotPre 里硬编码的这一句）
  slim: ['[记忆唤回]', '本轮为精简版'],
}

function loadCfg() {
  try { return JSON.parse(fs.readFileSync(CFG, 'utf8')) } catch (_) { return null }
}

async function runOnce(label) {
  const ws = path.posix.join(PATHS.ws, 'vov-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6))
  fs.mkdirSync(ws, { recursive: true })
  // 必须多步：精简版要等到首帧之后才可能出现。
  // 任务写成「三步」并显式给命令，避免模型自由发挥导致步数不定。
  const task = '请严格分三步执行：① pwsh 执行 echo a > a.txt ② pwsh 执行 echo b > b.txt '
    + '③ pwsh 执行 dir。然后只回复「完成」。'
  const res = await runHeadless({ cwd: ws, task, timeoutMs: 240000 })
  const ss = findSessionsFor(ws)
  const rows = ss.length ? readSessionEvents(ss[0].file) : []
  const all = JSON.stringify(rows)
  // 抽所有 <memory_system> 块的长度 —— 长度本身就是「完整版 vs 精简版」的强信号
  const blocks = []
  const walk = (o) => {
    if (typeof o === 'string') { if (o.startsWith('<memory_system>')) blocks.push(o.length); return }
    if (!o || typeof o !== 'object') return
    for (const k of Object.keys(o)) walk(o[k])
  }
  walk(rows)
  return {
    label,
    exit: res.code,
    seconds: res.seconds,
    steps: rows.filter(r => r.type === 'step/start').length,
    turns: rows.filter(r => r.type === 'turn/start').length,
    blocks,
    all,
  }
}

function report(run, keys, expectSlim) {
  console.log(`\n──────────────────────────────────────────`)
  console.log(`[${run.label}] exit=${run.exit} ${run.seconds.toFixed(0)}s steps=${run.steps} turns=${run.turns}`)

  const anyOf = (arr) => arr.some(x => run.all.includes(x))
  const ev = { full: anyOf(PATH_EVIDENCE.full), slim: anyOf(PATH_EVIDENCE.slim) }
  const blocks = run.blocks || []
  console.log(`  注入路径：完整版 ${ev.full ? '✓ 出现' : '· 未出现'} | 精简版 ${ev.slim ? '✓ 出现' : '· 未出现'}`)
  if (blocks.length) console.log(`  memory 块长度：[${blocks.join(', ')}]`)

  let bad = 0
  for (const [group, ks] of Object.entries(keys)) {
    console.log(`  ${group}:`)
    for (const [k, v] of Object.entries(ks)) {
      const tag = v.match(/\[[A-Z0-9-]+\]/)[0]
      const hit = run.all.includes(tag)
      if (!hit) bad++
      console.log(`    ${hit ? '✓' : '✗'} ${k.padEnd(28)} ${hit ? '标记已进上下文' : '★标记缺席'}`)
    }
  }
  // 精简版层全部命中 = 精简版路径确实走过（标记本身就在精简版块里），
  // 这一条比任何「特征串」判据都硬 —— 它直接证明渲染发生且读到了覆盖。
  if (expectSlim === true && !ev.slim) {
    const slimHits = Object.keys(keys['精简版路径'] || {})
      .filter(k => run.all.includes(keys['精简版路径'][k].match(/\[[A-Z0-9-]+\]/)[0])).length
    if (slimHits > 0) {
      console.log(`    ✓ 精简版路径已走过（${slimHits} 个精简版层的标记在上下文里；` +
        `特征串判据不适用于覆盖场景）`)
    } else {
      console.log('    ⚠ 精简版路径完全没出现 —— 精简版层的结论不可信（先查 gap 配置）')
      bad++
    }
  }
  return bad
}

const orig = fs.existsSync(CFG) ? fs.readFileSync(CFG, 'utf8') : null
let failures = 0
try {
  // ── 用例 A：所有层一起覆盖（证明多层并行可行）──
  const allMarks = {}
  for (const g of Object.values(CASES)) Object.assign(allMarks, g)
  patchConfig({ promptLayerOverrides: allMarks })
  console.log('用例 A：写入 ' + Object.keys(allMarks).length + ' 层覆盖，'
    + '基线 gap=' + BASELINE_CFG.snapshotMinGapRounds + ' slimEvery=' + BASELINE_CFG.slimEveryRounds)
  const runA = await runOnce('A 多层同时覆盖')
  failures += report(runA, CASES, true)

  // ── 用例 B：只覆盖精简版层 —— 证明不是「靠完整版顺带」进上下文的 ──
  patchConfig({ promptLayerOverrides: CASES['精简版路径'] || {} })
  if (CASES['精简版路径']) {
    console.log('\n用例 B：只覆盖精简版 3 层（隔离验证）')
    const runB = await runOnce('B 仅精简版层')
    failures += report(runB, { '精简版路径': CASES['精简版路径'] }, true)
  }

  // ── 用例 C：变体残留检查 —— 写一次 noinject 再跑 default，必须真的开启注入 ──
  patchConfig({ promptLayerOverrides: {}, injectEnabled: false })
  patchConfig({ promptLayerOverrides: {} })   // 模拟「下一个变体」
  const cfgNow = loadCfg()
  const noLeak = cfgNow.injectEnabled === true
    && cfgNow.snapshotMinGapRounds === BASELINE_CFG.snapshotMinGapRounds
  console.log('\n用例 C：变体残留检查')
  console.log(`  ${noLeak ? '✓' : '✗'} noinject 之后跑 default，注入已回到开启 `
    + `(injectEnabled=${cfgNow.injectEnabled}, gap=${cfgNow.snapshotMinGapRounds})`)
  if (!noLeak) failures++
} finally {
  if (orig != null) fs.writeFileSync(CFG, orig, 'utf8')
  console.log('\n配置已还原')
}

console.log('')
if (failures) {
  console.log(`✗ ${failures} 项未通过 —— 这些层的「覆盖 → 上下文」链路有问题，相关实验结论不可信`)
  process.exitCode = 1
} else {
  console.log('✓ 全部通过：覆盖真的进了模型上下文，且变体之间不残留')
}
