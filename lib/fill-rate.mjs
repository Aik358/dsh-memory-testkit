// 真实使用中的数据填充率 —— 与实验环境的对照
//
// 为什么要这个：实验里 15/15 全过，但实验场景**明确告诉模型**「如果产生了
// 共识就用 sharedGround 记下来」。真实使用里没有人这么提醒，模型必须自己
// **察觉**到「此刻正在产生共识」，这是完全不同的一种能力。
//
// 本脚本只读真实记忆库，量化两件事：
//   ① 各记忆面在真实数据里的填充率
//   ② 填充率随时间的变化（尤其 2026-10-28 四类感知纪律进静态提示词之后）
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const REAL = path.join(os.homedir(), '.dsh', 'memory', 'workspaces')

function listWs() {
  try {
    return fs.readdirSync(REAL).filter(d => {
      try { return fs.statSync(path.join(REAL, d)).isDirectory() } catch (_) { return false }
    })
  } catch (_) { return [] }
}

const ws = listWs()
const evAll = []
const ledgers = []

for (const w of ws) {
  const hd = path.join(REAL, w, 'handoff')
  // 事件库
  try {
    const p = path.join(hd, 'event-store.json')
    if (fs.existsSync(p)) {
      const st = JSON.parse(fs.readFileSync(p, 'utf8'))
      for (const e of (st.events || [])) evAll.push({ ws: w, ...e })
    }
  } catch (_) {}
  // 账本
  try {
    for (const f of fs.readdirSync(hd)) {
      if (/^handoff-\d{8}.*\.md$/.test(f)) {
        const st = fs.statSync(path.join(hd, f))
        ledgers.push({ ws: w, file: f, mtime: st.mtimeMs })
      }
    }
  } catch (_) {}
}

// 分类：迁移产出 vs 运行时自发（同一分钟内批量创建 ≥5 个 = 迁移）
const byMinute = new Map()
for (const e of evAll) {
  const t = Number(e.createdAt || e.startMs || 0)
  if (!t) continue
  const k = Math.floor(t / 60000)
  byMinute.set(k, (byMinute.get(k) || 0) + 1)
}
const runtime = [], migrated = []
for (const e of evAll) {
  const t = Number(e.createdAt || e.startMs || 0)
  const batch = t ? (byMinute.get(Math.floor(t / 60000)) || 0) : 0
  ;(batch >= 5 ? migrated : runtime).push(e)
}

function stat(list, label) {
  const n = list.length
  const cnt = {
    userPercept: list.filter(e => Array.isArray(e.userPercept) && e.userPercept.length).length,
    agentTrace: list.filter(e => Array.isArray(e.agentTrace) && e.agentTrace.length).length,
    sharedGround: list.filter(e => Array.isArray(e.sharedGround) && e.sharedGround.length).length,
    commitments: list.filter(e => Array.isArray(e.commitments) && e.commitments.length).length,
    anyPercept: list.filter(e =>
      ['userPercept', 'agentTrace', 'sharedGround', 'commitments'].some(k => Array.isArray(e[k]) && e[k].length)).length,
    checkpoints: list.filter(e => Array.isArray(e.checkpoints) && e.checkpoints.length).length,
  }
  console.log('')
  console.log(`── ${label}（${n} 个事件）──`)
  const pct = (a) => n ? ((a / n) * 100).toFixed(1) + '%' : '—'
  console.log(`  有检查点        ${String(cnt.checkpoints).padStart(4)}  ${pct(cnt.checkpoints)}`)
  console.log(`  userPercept     ${String(cnt.userPercept).padStart(4)}  ${pct(cnt.userPercept)}`)
  console.log(`  agentTrace      ${String(cnt.agentTrace).padStart(4)}  ${pct(cnt.agentTrace)}`)
  console.log(`  sharedGround    ${String(cnt.sharedGround).padStart(4)}  ${pct(cnt.sharedGround)}`)
  console.log(`  commitments     ${String(cnt.commitments).padStart(4)}  ${pct(cnt.commitments)}`)
  console.log(`  ≥1 类感知       ${String(cnt.anyPercept).padStart(4)}  ${pct(cnt.anyPercept)}`)
  return cnt
}

console.log('═══ 真实记忆库事件填充率 ═══')
console.log(`工作区 ${ws.length} · 事件 ${evAll.length}（运行时 ${runtime.length} / 迁移 ${migrated.length}）· 账本 ${ledgers.length}`)

stat(evAll, '全部事件')
stat(runtime, '运行时自发事件（不含迁移产出）')

// 各感知类型的条数分布
console.log('')
console.log('── 感知条数（运行时自发事件）──')
const totalCnt = { userPercept: 0, agentTrace: 0, sharedGround: 0, commitments: 0 }
for (const e of runtime) for (const k of Object.keys(totalCnt)) totalCnt[k] += (e[k] || []).length
for (const [k, v] of Object.entries(totalCnt)) console.log(`  ${k.padEnd(14)} ${v} 条`)

// 按月份看演进（运行时事件）
console.log('')
console.log('── 运行时事件按创建月份 × 是否带感知 ──')
const byMonth = new Map()
for (const e of runtime) {
  const t = Number(e.createdAt || e.startMs || 0)
  if (!t) continue
  const d = new Date(t)
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  const rec = byMonth.get(key) || { n: 0, any: 0 }
  rec.n++
  if (['userPercept', 'agentTrace', 'sharedGround', 'commitments'].some(k => Array.isArray(e[k]) && e[k].length)) rec.any++
  byMonth.set(key, rec)
}
for (const [m, v] of [...byMonth.entries()].sort()) {
  const bar = '█'.repeat(Math.round(v.any / Math.max(1, v.n) * 20)).padEnd(20, '·')
  console.log(`  ${m}  事件 ${String(v.n).padStart(3)}  带感知 ${String(v.any).padStart(3)}  ${bar}`)
}

// 日历
console.log('')
console.log('═══ 日历 ═══')
const calPath = path.join(os.homedir(), '.dsh', 'memory', 'CALENDAR.md')
if (fs.existsSync(calPath)) {
  const t = fs.readFileSync(calPath, 'utf8')
  const rows = t.split('\n').filter(l => l.trim().startsWith('|') && /\d{4}-\d{2}-\d{2}/.test(l))
  console.log(`CALENDAR.md ${t.length} 字符 · 条目行 ${rows.length}`)
  for (const r of rows.slice(0, 8)) console.log('  ' + r.trim().slice(0, 110))
  if (rows.length > 8) console.log(`  … 共 ${rows.length} 行`)
} else {
  console.log('文件不存在（从未用过 calendar_add）')
}

// 用户画像：靠 userPercept 的 accepted/used
console.log('')
console.log('═══ 用户画像来源（userPercept 的 accepted/used）═══')
const portraitSrc = []
for (const e of runtime) {
  for (const u of (e.userPercept || [])) {
    if (u && (u.stage === 'accepted' || u.stage === 'used')) portraitSrc.push(u)
  }
}
console.log(`可用作画像的条目 ${portraitSrc.length} 条`)
for (const u of portraitSrc.slice(0, 6)) {
  console.log(`  [${u.stage}/${u.kind || '?'}] ${String(u.text || '').slice(0, 80)}`)
}

// 全局 MEMORY.md（用户级）
console.log('')
console.log('═══ 用户级记忆 ═══')
const userMem = path.join(os.homedir(), '.dsh', 'memory', 'MEMORY.md')
if (fs.existsSync(userMem)) {
  const t = fs.readFileSync(userMem, 'utf8')
  console.log(`MEMORY.md ${t.length} 字符 / ${t.split('\n').length} 行`)
} else {
  console.log('不存在')
}
