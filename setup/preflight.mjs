/**
 * 环境自检 —— 跑任何套件之前必须先过这一关。
 *
 * 检查项按「踩过的坑」组织，每项都能给出可执行的修法，而不是只说「失败」。
 *
 * ★ 入口探测全部交给 lib/env.mjs（收集全部候选 → 比版本 → 选达标的最新）。
 *   本机实测：which 解析到 0.2.0-rc.2，实际在用的是桌面版 0.2.1-rc.5 ——
 *   「写死路径」或「取第一个找到的」都会选错，那不是防御性过度设计。
 *
 * 用法：
 *   node setup/preflight.mjs            # 人类可读
 *   node setup/preflight.mjs --json     # 机器可读（给 Agent）
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  KIT_ROOT, REPO, WORK, PATHS, PROFILE, ensureDirs,
} from '../lib/config.mjs'
import { detectEnv, summarize, resolveRunner, REQUIREMENTS } from '../lib/env.mjs'

const asJson = process.argv.includes('--json')

const ENV = detectEnv()
const results = []
const check = (name, fn) => {
  try {
    const r = fn()
    results.push({ name, ok: r.ok !== false, detail: r.detail || '' })
  } catch (e) {
    results.push({ name, ok: false, detail: String(e && e.message || e).slice(0, 200) })
  }
}

if (!asJson) {
  console.log('=== 环境自检 ===')
  console.log(`套件根   ${KIT_ROOT}`)
  console.log(`被测仓库 ${REPO}`)
  console.log(`沙箱根   ${WORK}`)
  console.log('')
}

// ① 被测仓库
check('被测仓库存在且含 lib/index.js', () => {
  const f = path.posix.join(REPO, 'lib/index.js')
  if (!fs.existsSync(f)) return { ok: false, detail: `缺 ${f}（设 TESTKIT_REPO 指向插件源码）` }
  const sz = fs.statSync(f).size
  return { ok: sz > 100000, detail: `${(sz / 1024 / 1024).toFixed(2)} MB` }
})

// ② dsh 入口（★多候选探测，不写死路径）
check(`dsh 入口可达且 ≥ ${REQUIREMENTS.dsh.min}`, () => {
  const d = ENV.dsh
  if (!d.bin) {
    return { ok: false, detail: '未找到任何 dsh 安装。装一个：npm i -g @deepseek-ai/dsh@latest，或设 TESTKIT_DSH_BIN' }
  }
  const runner = resolveRunner(d.bin)
  const candNote = d.candidates.length > 1 ? `\n      共 ${d.candidates.length} 个候选，已选版本最高的达标者` : ''
  const detail = `${d.version || '?'}  ${d.bin}${candNote}\n      运行形态：${runner.kind} → ${runner.cmd.split(/[\\/]/).pop()}（${runner.detail}）`
  if (!d.meetsRequirement) {
    return {
      ok: false,
      detail: detail + `\n      ★版本 ${d.version || '?'} 低于门槛 ${REQUIREMENTS.dsh.min}：${REQUIREMENTS.dsh.reason}`
        + `\n      修法：npm i -g @deepseek-ai/dsh@latest`,
    }
  }
  return { detail }
})

// ③ 插件版本
check(`插件版本 ≥ ${REQUIREMENTS.plugin.min}`, () => {
  const p = ENV.plugin
  if (!p.version) return { ok: false, detail: p.error || '读不到版本' }
  if (!p.meetsRequirement) {
    return { ok: false, detail: `${p.version} 低于 ${REQUIREMENTS.plugin.min}：${REQUIREMENTS.plugin.reason}` }
  }
  return { detail: `${p.version}  (${p.repo})` }
})

// ④ 判据函数可导入
check('判据函数可导入（checkHandoffCriteriaPre）', () => {
  const f = path.posix.join(REPO, 'lib/wb-contract.js')
  if (!fs.existsSync(f)) return { ok: false, detail: `缺 ${f}` }
  return { detail: '存在（实际导入在 suites/handoff.mjs 里做）' }
})

// ⑤ 沙箱目录可建
check('沙箱目录可写', () => {
  ensureDirs()
  const probe = path.posix.join(PATHS.tmp, '.probe-' + Date.now())
  fs.writeFileSync(probe, 'x')
  fs.unlinkSync(probe)
  return { detail: PATHS.tmp }
})

// ⑥ 沙箱 profile 已建
check(`实验 profile「${PROFILE}」已建`, () => {
  const pj = path.join(PATHS.dshHome, 'profiles', PROFILE, 'package.json')
  if (!fs.existsSync(pj)) {
    return { ok: false, detail: `缺 ${pj} —— 跑 node setup/init-profile.mjs` }
  }
  const m = JSON.parse(fs.readFileSync(pj, 'utf8'))
  const bundles = (m.dsh && m.dsh.profile && m.dsh.profile.bundles) || []
  const hasPlugin = bundles.some(b => String(b).includes('auto-memory'))
  const hasServer = bundles.includes('@deepseek-ai/dsh-headless')
  if (!hasPlugin) return { ok: false, detail: 'profile 未挂载 dsh-auto-memory' }
  if (!hasServer) return { ok: false, detail: 'profile 未挂载 dsh-headless' }
  return { detail: bundles.join(' + ') }
})

// ⑦ 沙箱配置已建且指向沙箱（不是真实库）
check('沙箱配置已隔离（memoryRoot 指向沙箱）', () => {
  const p = path.join(PATHS.dshHome, 'dsh-auto-memory.json')
  if (!fs.existsSync(p)) return { ok: false, detail: `缺 ${p} —— 跑 node setup/init-profile.mjs` }
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'))
  const root = String(cfg.memoryRoot || '')
  if (!root.includes('memory/workspaces') || root.includes('.dsh/memory')) {
    return { ok: false, detail: `memoryRoot=${root} ★仍指向真实库，必须改成沙箱绝对路径` }
  }
  if (!/^[A-Za-z]:/.test(root)) {
    return { ok: false, detail: `memoryRoot=${root} ★不是绝对路径（~/ 会被 os.homedir() 展开，DSH_HOME 拦不住）` }
  }
  return { detail: root }
})

// ⑧ 目录 ACL 含 WRITE_DAC（沙箱 grantWrite 的前提）
check('工作区 ACL 含 WRITE_DAC/WRITE_OWNER（提权已授予）', () => {
  if (process.platform !== 'win32') return { detail: '非 Windows，跳过（POSIX 权限模型无此要求）' }
  if (ENV.platform.aclOk) return { detail: ENV.platform.detail }
  return {
    ok: false,
    detail: `当前权限=${ENV.platform.detail}，缺 WriteDAC/WriteOwner`
      + `\n      修法：powershell -ExecutionPolicy Bypass -File setup/elevate.ps1`
      + `\n      ★这一步必须人点 UAC 确认，Agent 替不了`,
  }
})

// ⑨ TEMP 不在 System32
check('TEMP 未指向系统保护目录', () => {
  const t = process.env.TEMP || ''
  if (/Windows[\\/]System32/i.test(t)) {
    return { ok: false, detail: `TEMP=${t} ⇒ 沙箱 grantWrite 会 Win32 error 5（运行器会自动改写，但建议先修）` }
  }
  return { detail: t || '(未设)' }
})

// ⑩ 真实记忆库基线（供事后比对）
check('记录真实记忆库基线', () => {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const real = path.join(home, '.dsh', 'memory', 'workspaces')
  if (!fs.existsSync(real)) return { detail: '(无真实记忆库)' }
  const n = fs.readdirSync(real).filter(d => {
    try { return fs.statSync(path.join(real, d)).isDirectory() } catch (_) { return false }
  }).length
  fs.writeFileSync(path.posix.join(WORK, '.real-workspace-count'), String(n), 'utf8')
  return { detail: `${n} 个工作区（已记录到 ${WORK}/.real-workspace-count）` }
})

let bad = 0
for (const r of results) if (!r.ok) bad++

if (asJson) {
  // 给 Agent 的机器可读形态：带 nextAction，不需要解析中文
  console.log(JSON.stringify({ ok: bad === 0, env: ENV, checks: results }, null, 2))
} else {
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}`)
    if (r.detail) console.log(`      ${r.detail}`)
  }
  console.log('')
  console.log(summarize(ENV))
  console.log('')
  if (bad) {
    console.log(`✗ ${bad} 项未通过 —— 按上面的提示修完再跑套件`)
    console.log(`  下一步（机器可读）：${JSON.stringify(ENV.nextAction)}`)
    process.exitCode = 1
  } else {
    console.log('✓ 全部通过，可以跑套件了')
    console.log('')
    console.log('  node suites/families.mjs          # 7 个记忆面')
    console.log('  node suites/handoff.mjs           # 交接账本 20 条')
    console.log('  node suites/ritual-run.mjs        # 接续仪式（真调工具）')
    console.log('  node suites/ablation.mjs          # 对抗性 ablation')
    console.log('  node lib/server.mjs               # 监控台 http://127.0.0.1:8899')
  }
}
