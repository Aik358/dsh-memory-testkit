/**
 * 真实语料分析 —— 从真实会话记录里，看模型**自发**写了什么记忆。
 *
 * 与实验的区别（这是关键）：
 *   实验里的场景会明确说「如果产生了共识就用 sharedGround 记下来」；
 *   真实对话里没人这么提醒，模型必须自己**察觉**此刻正在产生共识。
 *   所以实验测的是「能不能写对」，这里测的是「会不会想到写」。
 *
 * 数据源：~/.dsh/sessions/* / * / session.v4.jsonl.zstd（真实会话，只读）
 *
 * 用法：
 *   node lib/corpus-real.mjs                 # 全量统计
 *   node lib/corpus-real.mjs --days 7        # 只看最近 N 天
 *   node lib/corpus-real.mjs --samples       # 打印典型样本
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { readSessionEvents, extractCalls, isOk } from './driver.mjs'

const SESS_ROOT = process.env.TESTKIT_SESSIONS || path.join(os.homedir(), '.dsh', 'sessions')

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const days = Number(arg('days', '0'))
const showSamples = argv.includes('--samples')

// ── 收集会话文件 ──
function listSessionFiles() {
  const out = []
  let dirs = []
  try { dirs = fs.readdirSync(SESS_ROOT) } catch (_) { return out }
  for (const d of dirs) {
    const dp = path.join(SESS_ROOT, d)
    let subs = []
    try { subs = fs.readdirSync(dp) } catch (_) { continue }
    for (const sid of subs) {
      const f = path.join(dp, sid, 'session.v4.jsonl.zstd')
      try {
        if (!fs.existsSync(f)) continue
        const st = fs.statSync(f)
        if (days > 0 && Date.now() - st.mtimeMs > days * 864e5) continue
        out.push({ file: f, ws: d, sid, mtime: st.mtimeMs, size: st.size })
      } catch (_) {}
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

const files = listSessionFiles()
console.log(`═══ 真实会话语料 ═══`)
console.log(`会话文件 ${files.length}${days ? `（最近 ${days} 天）` : ''}`)
console.log('')

// ── 扫描每个会话里的记忆写入 ──
const totals = {
  sessions: 0,
  withAnyMemoryTool: 0,
  byTool: {},
  byPerceptParam: { userPercept: 0, agentTrace: 0, sharedGround: 0, commitment: 0 },
  calendarCalls: 0,
  eventCalls: 0,
  eventAppend: 0,
  eventCreate: 0,
  handoffWrites: 0,
  logWrites: 0,
  procedureWrites: 0,
  // 「有感知参数的 handoff 调用」占比
  handoffCalls: 0,
  handoffWithPercept: 0,
  // 每次会话的工具调用总数（看模型整体活跃度）
  toolCallTotal: 0,
}

const samples = {
  userPercept: [], sharedGround: [], commitment: [], agentTrace: [], calendar: [],
}
const perSession = []

for (const f of files) {
  const rows = readSessionEvents(f.file)
  if (!rows.length) continue
  totals.sessions++

  const { calls, results } = extractCalls(rows)
  totals.toolCallTotal += calls.length

  const memTools = calls.filter(c => c.tool && c.tool.startsWith('memory_'))
  if (memTools.length) totals.withAnyMemoryTool++

  let touched = false
  for (const c of calls) {
    if (!c.tool) continue
    totals.byTool[c.tool] = (totals.byTool[c.tool] || 0) + 1

    // ★★ 工具名要归一化：历史版本的工具带 `_pre` 后缀
    //   （实测真实会话里 memory_log_pre / memory_note_pre / calendar_add_pre 都在用）。
    //   不归一化会漏统计 —— 首版因此把「日历调用 0 次」算错了，
    //   实际有 calendar_add_pre 调用，虽然只有 1 次。
    const base = c.tool.replace(/_pre$/, '')
    const ok = isOk(c, results)
    const i = c.input || {}

    if (base === 'calendar_add' && ok) { totals.calendarCalls++; touched = true; samples.calendar.push({ file: f.sid, input: i }) }
    if (base === 'memory_event' && ok) {
      totals.eventCalls++
      if (i.action === 'append') totals.eventAppend++
      if (i.action === 'create') totals.eventCreate++
      // 事件级的感知参数
      for (const k of ['userPercept', 'agentTrace', 'sharedGround', 'commitment']) {
        if (i[k] && typeof i[k] === 'object') {
          totals.byPerceptParam[k]++
          if (samples[k]) samples[k].push({ file: f.sid, input: i[k] })
          touched = true
        }
      }
    }
    if (base === 'memory_note' && ok) {
      if (i.kind === 'handoff') {
        totals.handoffCalls++
        let hasP = false
        for (const k of ['userPercept', 'agentTrace', 'sharedGround', 'commitment']) {
          if (i[k] && typeof i[k] === 'object') {
            totals.byPerceptParam[k]++
            hasP = true
            touched = true
            if (samples[k]) samples[k].push({ file: f.sid, input: i[k] })
          }
        }
        if (hasP) totals.handoffWithPercept++
        if (/##\s*任务状态/.test(String(i.content || ''))) totals.handoffWrites++
      }
    }
    if (base === 'memory_log' && ok) totals.logWrites++
    if (base === 'memory_procedure' && ok && (i.action === 'write' || i.action === 'activate')) totals.procedureWrites++
  }
  perSession.push({ sid: f.sid.slice(0, 22), ws: f.ws.slice(0, 28), calls: calls.length, mem: memTools.length, touched, mtime: f.mtime })
}

// ── 输出 ──
const pct = (a, b) => b ? ((a / b) * 100).toFixed(1) + '%' : '—'

console.log('── 记忆写入总量（全部真实会话）──')
console.log(`  会话总数                     ${totals.sessions}`)
console.log(`  出现过任意 memory_* 工具      ${totals.withAnyMemoryTool}  ${pct(totals.withAnyMemoryTool, totals.sessions)}`)
console.log(`  工具调用总数                 ${totals.toolCallTotal}`)
console.log('')
console.log('── 各类写入调用次数 ──')
console.log(`  memory_note(kind=handoff)     ${totals.handoffCalls} 次（其中成功写出四段账本 ${totals.handoffWrites}）`)
console.log(`  memory_event create           ${totals.eventCreate}`)
console.log(`  memory_event append           ${totals.eventAppend}`)
console.log(`  memory_log                    ${totals.logWrites}`)
console.log(`  memory_procedure(write/activate) ${totals.procedureWrites}`)
console.log(`  calendar_add                  ${totals.calendarCalls}`)
console.log('')
console.log('── ★ 四类感知的携带次数 ──')
for (const k of ['userPercept', 'agentTrace', 'sharedGround', 'commitment']) {
  console.log(`  ${k.padEnd(14)} ${String(totals.byPerceptParam[k]).padStart(4)} 次`)
}
console.log('')
console.log('── ★ handoff 调用里带感知的比例 ──')
console.log(`  ${totals.handoffWithPercept} / ${totals.handoffCalls}  ${pct(totals.handoffWithPercept, totals.handoffCalls)}`)

// ── 有记忆写入的会话列表 ──
const touchedList = perSession.filter(s => s.touched)
console.log('')
console.log(`── 有感知/日历写入的会话：${touchedList.length} / ${perSession.length} ──`)
for (const s of touchedList.slice(0, 20)) {
  console.log(`  ${s.sid.padEnd(24)} ${s.ws.padEnd(30)} 调用 ${String(s.calls).padStart(3)} · memory ${String(s.mem).padStart(2)}`)
}

// ── 样本 ──
if (showSamples) {
  for (const [k, list] of Object.entries(samples)) {
    if (!list.length) continue
    console.log('')
    console.log(`═══ ${k} 样本（前 ${Math.min(5, list.length)} 条，共 ${list.length}）═══`)
    for (const s of list.slice(0, 5)) console.log('  ' + JSON.stringify(s.input).slice(0, 240))
  }
}

// ── 写入率对照 ──
console.log('')
console.log('═══ 关键比值 ═══')
console.log(`  每次 handoff 写账本，带感知的：${pct(totals.handoffWithPercept, totals.handoffCalls)}`)
console.log(`  日历调用 / 会话数：            ${pct(totals.calendarCalls, totals.sessions)}（${totals.calendarCalls} 次 / ${totals.sessions} 会话）`)
console.log(`  共识（sharedGround）调用：     ${totals.byPerceptParam.sharedGround} 次`)
console.log(`  承诺（commitment）调用：       ${totals.byPerceptParam.commitment} 次`)
