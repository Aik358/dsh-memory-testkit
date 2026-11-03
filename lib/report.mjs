/**
 * 结果汇总 —— 把 raw/*.json + sentinel/*.json 汇成一张可复算的表。
 *
 * 用法：node lib/report.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { PATHS } from './config.mjs'

const dirs = { raw: PATHS.raw, sentinel: PATHS.sentinel }

/**
 * 统一「判定」字段。
 * ⚠️ 历史产物有两套口径：早期用 hardPass（只测交接账本那一种写入），
 *    后来统一成 pass（按记忆面判分）。读旧文件时不能一律当 false，
 *    否则会把整批历史结果显示成 0%（实测踩过）。
 */
const isPass = (r) => {
  if (typeof r.pass === 'boolean') return r.pass
  if (typeof r.hardPass === 'boolean') return r.hardPass
  return false
}

function readAll(dir, prefix) {
  const out = []
  let files = []
  try { files = fs.readdirSync(dir) } catch (_) { return out }
  for (const f of files.sort()) {
    if (!f.endsWith('.json')) continue
    if (prefix && !f.startsWith(prefix)) continue
    try {
      const body = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      if (Array.isArray(body)) out.push({ name: f.replace(/\.json$/, ''), rows: body })
    } catch (_) {}
  }
  return out
}

const groups = readAll(dirs.raw)
const sentinelReports = readAll(dirs.sentinel, 'report-')

console.log('═══ 套件结果 ═══')
console.log('')
if (!groups.length) {
  console.log('（还没有结果 —— 先跑一个套件）')
} else {
  console.log('套件'.padEnd(28) + 'N'.padStart(4) + '通过'.padStart(12) + '超时'.padStart(6) + '违规'.padStart(6) + '平均秒'.padStart(8))
  for (const g of groups) {
    const n = g.rows.length
    const p = g.rows.filter(isPass).length
    const k = g.rows.filter(r => r.killed).length
    const v = g.rows.reduce((s, r) => s + (r.violations || 0), 0)
    const avg = n ? Math.round(g.rows.reduce((s, r) => s + (r.seconds || 0), 0) / n) : 0
    const pct = n ? Math.round(p / n * 100) : 0
    console.log(g.name.padEnd(28) + String(n).padStart(4) + `${p}/${n} (${pct}%)`.padStart(12)
      + String(k).padStart(6) + String(v).padStart(6) + String(avg).padStart(8))
  }

  // 按记忆面拆（有 family 的才有意义）
  console.log('')
  console.log('═══ 按记忆面 ═══')
  const byFam = {}
  for (const g of groups) {
    for (const r of g.rows) {
      // 早期产物没有 family 字段：
      //   · 只测交接账本那批 → 有 hardPass/H1
      //   · 仪式那批          → 有 world/version
      const f = r.family
        || (r.hardPass !== undefined || r.H1 !== undefined ? 'handoff(早期)'
          : r.world !== undefined ? 'ritual(早期)'
          : '?')
      byFam[f] = byFam[f] || { p: 0, n: 0 }
      byFam[f].n++
      if (isPass(r)) byFam[f].p++
    }
  }
  for (const [f, v] of Object.entries(byFam).sort((a, b) => b[1].n - a[1].n)) {
    const pct = Math.round(v.p / v.n * 100)
    const bar = '█'.repeat(Math.round(pct / 5)).padEnd(20, '·')
    console.log(`  ${f.padEnd(14)} ${String(v.p + '/' + v.n).padStart(8)} ${String(pct).padStart(3)}%  ${bar}`)
  }

  // 失败明细
  const fails = groups.flatMap(g => g.rows.filter(r => !isPass(r)).map(r => ({ suite: g.name, ...r })))
  if (fails.length) {
    console.log('')
    console.log('═══ 失败明细 ═══')
    for (const r of fails) {
      // 历史产物用 taskId，新产物用 scenario；两者都认，否则打出一片 undefined
      const name = r.scenario || r.taskId || (r.version ? `${r.version}/${r.world || ''}` : '?')
      const det = Array.isArray(r.detail) ? r.detail.join(' / ')
        : Array.isArray(r.hardDetail) ? r.hardDetail.join(' / ')
        : (r.detail || '')
      console.log(`  [${r.suite}] ${String(name).padEnd(30)} ${r.killed ? '★超时 ' : ''}${String(det).slice(0, 140)}`)
    }
  }
}

console.log('')
console.log('═══ 完整性哨兵 ═══')

/**
 * 哨兵报告有两种形态：
 *   · 单场景：{ at, violations:[], ambientSkipped:[], sandboxWrites:[] }  ← 本套件
 *   · 早期批次：数组
 * 读取时必须都认，否则统计恒为 0（实测踩过）。
 */
function loadSentinel() {
  const out = []
  let files = []
  try { files = fs.readdirSync(dirs.sentinel) } catch (_) { return out }
  for (const f of files) {
    if (!f.startsWith('report-') || !f.endsWith('.json')) continue
    try {
      const body = JSON.parse(fs.readFileSync(path.join(dirs.sentinel, f), 'utf8'))
      if (Array.isArray(body)) out.push(...body)
      else if (body && typeof body === 'object') out.push(body)
    } catch (_) {}
  }
  return out
}

const reps = loadSentinel()
if (!reps.length) {
  console.log('（还没有哨兵报告 —— 跑一个套件后会生成）')
} else {
  let checks = 0, withViol = 0, violTotal = 0, ambient = 0, promptsChanged = 0
  const areas = {}
  for (const r of reps) {
    if (!r || typeof r !== 'object') continue
    checks++
    const v = Array.isArray(r.violations) ? r.violations : []
    violTotal += v.length
    if (v.length) withViol++
    ambient += Array.isArray(r.ambientSkipped) ? r.ambientSkipped.length : 0
    if (r.promptsSame === false) promptsChanged++
    for (const x of v) areas[x.area || '?'] = (areas[x.area || '?'] || 0) + 1
  }
  console.log(`报告 ${checks} 份 · 违规 ${violTotal} 项 · 有违规的报告 ${withViol} · 白名单豁免 ${ambient} · 提示词面被改 ${promptsChanged}`)
  if (Object.keys(areas).length) {
    console.log('违规面：')
    for (const [k, n] of Object.entries(areas).sort((a, b) => b[1] - a[1])) console.log(`  ${k} x${n}`)
  } else {
    console.log('✓ 无违规（真实库 / 产品代码 / 提示词面 全部未变）')
  }
}
