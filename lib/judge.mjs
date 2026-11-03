/**
 * 按「记忆面」判分 —— 每个面用自己的判据。
 *
 * 为什么不能用一把尺子：交接账本有 H1–H4 硬判据，但四类感知、日历、事件、
 * 日志、技能库各有各的形状。用同一套判据量全部，必然假绿或假红。
 *
 * ★★ 五条踩坑纪律（每一条都曾把完全正确的模型判成 0 分）：
 *   1. 评分来源必须是「模型真正交给工具的入参」，不是最终回复文本
 *      —— 模型按纪律调工具写文件，最终文本只是「完成」。
 *   2. 必须取「最后一次 result 为成功」的调用，不是「最后一次调用」
 *      —— 模型常先写一版被拒、读到回执后改对。
 *   3. 字段名必须兼容两种形状（NDJSON 平铺 / 会话日志嵌套）。
 *   4. 判「调用成功」只看该工具自己的回执开头，不能全仓搜 "error"。
 *   5. 判分必须照 **schema 的真实类型**，不能照直觉
 *      —— memory_procedure.steps 是 string（一行一步），不是数组。
 */
/**
 * 判分枚举 —— **运行时从产品源码读**，不抄常量。
 *
 * ═══ 为什么要这么麻烦 ═══
 * 这些枚举是产品的契约，不是套件的知识。抄成常量后必然漂移：
 *
 *   实证 ① PERCEPT_STAGES 曾经只在事件库里有 5 个值，套件抄了一份；
 *          产品后来加了 staticPerceptDiscipline 相关纪律，套件仍按旧的判。
 *   实证 ② 我上一份报告断言「staticPerceptDiscipline 不存在」，隔两天实测它已经存在了 ——
 *          产品在快速演进，任何「我抄下来的事实」都有保质期。
 *
 *   抄常量的后果是**静默错误**：产品加了新枚举值 → 套件把合法值判成非法
 *   → 报告写成「模型不会用」→ 而真相是「套件不认识它」。这比报错更糟。
 *
 * ═══ 读不到时的纪律 ═══
 * **明确报错，不回落旧值。** 旧值最危险的地方是「看起来还能跑」。
 * 只有一种例外：产品里确实没有这个枚举（比如 PERCEPT_KINDS 从未被产品校验过），
 * 那才退回本地默认值，并在返回值里标明来源。
 */
import fs from 'node:fs'
import path from 'node:path'
import { extractCalls, isOk } from './driver.mjs'
import { projectDirOf, PATHS, REPO } from './config.mjs'

const EVENT_STORE = path.posix.join(REPO, 'lib/event-store.js')

/**
 * 从产品源码里读 `export const NAME = Object.freeze([...])`。
 * @returns {string[]|null} null = 产品里没有这个定义
 */
function readFrozenEnum(name) {
  let src = ''
  try { src = fs.readFileSync(EVENT_STORE, 'utf8') } catch (e) {
    throw new Error(`读不到产品源码 ${EVENT_STORE}：${e.message}。判分红线 —— 不能拿旧常量蒙混`)
  }
  const re = new RegExp(name + '\\s*=\\s*Object\\.freeze\\(\\[([^\\]]*)\\]\\)')
  const m = src.match(re)
  if (!m) return null
  return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
}

/**
 * 读一个枚举，读不到就抛。
 * 用于「产品确实校验这个字段」的枚举 —— 缺了说明产品契约变了，必须人工看一眼。
 */
function mustRead(name) {
  const v = readFrozenEnum(name)
  if (!v || !v.length) {
    throw new Error(`产品源码里找不到 ${name} 定义（${EVENT_STORE}）。`
      + `产品契约可能已变 —— 不要用套件里的旧常量继续判分，先核对产品。`)
  }
  return v
}

/**
 * 读一个枚举，读不到时回落本地默认值（并在 _sources 里标明）。
 * 用于「产品从未校验这个字段」的枚举 —— 那些是模型侧的约定，不是产品契约。
 */
function readWithFallback(name, fallback, why) {
  const v = readFrozenEnum(name)
  if (v && v.length) return { value: v, from: 'product' }
  return { value: fallback, from: 'local-default（' + why + '）' }
}

/**
 * PERCEPT_STAGES —— 产品**确实校验**它（event-store.js 的 validateEventPre
 * 与 appendEvent 都会拒非法 stage），所以必须从产品读，读不到直接抛。
 */
export const PERCEPT_STAGES = mustRead('PERCEPT_STAGES')

/** 用户侧观察的 kind —— 产品只做 String() 归一、不做枚举校验 ⇒ 允许回落 */
const _kinds = readWithFallback('PERCEPT_KINDS',
  ['preference', 'state', 'unfinished-goal', 'authorResponse'],
  '产品未枚举校验 userPercept.kind')
export const PERCEPT_KINDS = _kinds.value

/** 承诺状态 —— 产品同样只做 String() 归一 ⇒ 允许回落 */
const _states = readWithFallback('COMMIT_STATES',
  ['open', 'kept', 'dropped'],
  '产品未枚举校验 commitment.state')
export const COMMIT_STATES = _states.value

/** 事件 kind —— 产品 fail-closed 校验（26 字段契约）⇒ 必须一致 */
export const EVENT_KINDS_PRODUCT = mustRead('EVENT_KINDS')

/** 每个枚举的来源，供报告如实标注 */
export const ENUM_SOURCES = Object.freeze({
  PERCEPT_STAGES: 'product',
  PERCEPT_KINDS: _kinds.from,
  COMMIT_STATES: _states.from,
  EVENT_KINDS: 'product',
})

/** 读某个工作区在沙箱里的落盘产物（比只看入参更硬） */
export function readArtifacts(absWsPath) {
  const dir = projectDirOf(absWsPath)
  const a = { dir, handoffs: [], plan: '', events: null, calendar: '', logs: '', procedures: null, userMem: '' }

  const hd = path.join(dir, 'handoff')
  try {
    for (const f of fs.readdirSync(hd)) {
      if (/^handoff-\d{8}.*\.md$/.test(f)) {
        a.handoffs.push({ file: f, text: fs.readFileSync(path.join(hd, f), 'utf8') })
      }
      if (f === 'PLAN.md') a.plan = fs.readFileSync(path.join(hd, f), 'utf8')
      if (f === 'event-store.json') {
        try { a.events = JSON.parse(fs.readFileSync(path.join(hd, f), 'utf8')) } catch (_) {}
      }
    }
  } catch (_) {}

  // ★ 用户级记忆与日历都是**跨工作区共享**的，放在沙箱的 user 目录
  //   实测：模型倾向把「用户偏好/跨项目规则」写进这里而不是 userPercept，
  //   所以判分必须能读到它，否则会把正确行为判成「没写」。
  try {
    const userDir = path.posix.join(PATHS.userMemoryDir)
    const um = path.join(userDir, 'MEMORY.md')
    if (fs.existsSync(um)) a.userMem = fs.readFileSync(um, 'utf8')
    const cal = path.join(userDir, 'CALENDAR.md')
    if (fs.existsSync(cal)) a.calendar = fs.readFileSync(cal, 'utf8')
  } catch (_) {}

  try {
    for (const f of fs.readdirSync(dir)) {
      if (/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) a.logs += fs.readFileSync(path.join(dir, f), 'utf8')
    }
  } catch (_) {}

  try {
    for (const cand of ['procedures.json', 'procedure.json']) {
      const p = path.posix.join(path.posix.dirname(dir), '..', 'user', cand)
      if (fs.existsSync(p)) { a.procedures = JSON.parse(fs.readFileSync(p, 'utf8')); break }
    }
  } catch (_) {}
  return a
}

/**
 * 从工具调用序列里抽各类记忆写入（只留成功的）。
 *
 * 说明：`memory_note(kind=handoff)` 的四类感知参数是**扁平 object**，
 * 不是数组 —— 一次调用最多带一条。这与事件库里的数组形态不同。
 */
export function collectWrites(rows) {
  const { calls, results } = extractCalls(rows)
  const ok = (c) => isOk(c, results)
  const w = {
    handoffs: [],
    percepts: { userPercept: [], agentTrace: [], sharedGround: [], commitment: [] },
    calendars: [],
    events: [],
    logs: [],
    procedures: [],
    recallQueries: [],
    otherTools: [],
  }
  for (const c of calls) {
    const i = c.input || {}
    if (c.tool === 'memory_recall') w.recallQueries.push(String(i.query || ''))
    if (!ok(c)) continue
    switch (c.tool) {
      case 'memory_note':
        if (i.kind === 'handoff' || (!i.kind && typeof i.content === 'string' && /##\s*任务状态/.test(i.content))) {
          w.handoffs.push(i)
          for (const k of ['userPercept', 'agentTrace', 'sharedGround', 'commitment']) {
            if (i[k] && typeof i[k] === 'object') w.percepts[k].push(i[k])
          }
        }
        break
      case 'calendar_add': w.calendars.push(i); break
      case 'memory_event': w.events.push(i); break
      case 'memory_log': w.logs.push(i); break
      case 'memory_procedure': w.procedures.push(i); break
      default: w.otherTools.push(c.tool)
    }
  }
  return w
}

/**
 * 判分主入口。
 * @param {object} scenario 场景定义（含 family 与 expect）
 * @param {object} writes   collectWrites 的结果
 * @param {object} art      readArtifacts 的结果
 */
export function judge(scenario, writes, art) {
  const fam = scenario.family
  const exp = scenario.expect || {}
  const noneExpected = exp.shouldWrite === 'none'
  const detail = []
  let pass = false

  // ── 共识 / 共同经历 ──
  if (fam === 'sharedGround') {
    const list = writes.percepts.sharedGround
    if (noneExpected) {
      pass = list.length === 0
      detail.push(`sharedGround 写入 ${list.length} 条（期望 0：单向陈述不算共识）`)
      if (list.length) detail.push(`误报: ${JSON.stringify(String(list[0].claim || '').slice(0, 50))}`)
    } else {
      const g = list[0]
      const claimOk = !!(g && String(g.claim || '').trim())
      pass = list.length >= 1 && claimOk
      detail.push(`sharedGround ${list.length} 条，claim ${claimOk ? '非空' : '★空/缺'}`)
      if (g) detail.push(`confirmedBy=${JSON.stringify(g.confirmedBy || null)}`)
    }
  }

  // ── 人类侧观察（用户画像的原料）──
  if (fam === 'userPercept') {
    const list = writes.percepts.userPercept
    if (noneExpected) {
      pass = list.length === 0
      detail.push(`userPercept ${list.length} 条（期望 0：纯寒暄不该记）`)
      if (list.length) detail.push(`误报: ${JSON.stringify(String(list[0].text || '').slice(0, 50))}`)
    } else {
      const u = list[0]
      const stageOk = !!(u && PERCEPT_STAGES.includes(String(u.stage || 'mentioned')))
      const textOk = !!(u && String(u.text || '').trim().length >= 4)
      const kindOk = exp.kind ? String(u && u.kind) === exp.kind : true
      pass = list.length >= 1 && stageOk && textOk && kindOk
      detail.push(`userPercept ${list.length} 条 | stage=${JSON.stringify(u && u.stage)} ${stageOk ? '合法' : '★非法'}`)
      detail.push(`kind=${JSON.stringify(u && u.kind)} ${kindOk ? '符合预期' : '★期望 ' + exp.kind}`)
      detail.push(`text ${textOk ? '非空' : '★空'}`)
    }
  }

  // ── 承诺 / 约定 ──
  if (fam === 'commitment') {
    const list = writes.percepts.commitment
    if (noneExpected) {
      pass = list.length === 0
      detail.push(`commitment ${list.length} 条（期望 0：意图不算承诺）`)
      if (list.length) detail.push(`误报: ${JSON.stringify(String(list[0].promise || '').slice(0, 50))}`)
    } else {
      const c = list[0]
      const promiseOk = !!(c && String(c.promise || '').trim().length >= 4)
      const stateOk = !!(c && COMMIT_STATES.includes(String(c.state || 'open')))
      const expState = exp.state ? String(c && c.state) === exp.state : true
      pass = list.length >= 1 && promiseOk && stateOk && expState
      detail.push(`commitment ${list.length} 条 | promise ${promiseOk ? '非空' : '★空'}`)
      detail.push(`state=${JSON.stringify(c && c.state)} ${stateOk ? '合法' : '★非法'}${expState ? '' : '（期望 ' + exp.state + '）'}`)
    }
  }

  // ── 日历 ──
  if (fam === 'calendar') {
    if (noneExpected) {
      pass = writes.calendars.length === 0
      detail.push(`calendar_add ${writes.calendars.length} 次（期望 0：无时间信息不该进日历）`)
      if (writes.calendars.length) detail.push(`误报: ${JSON.stringify(writes.calendars[0]).slice(0, 120)}`)
    } else {
      const c = writes.calendars[0]
      const dateOk = !!(c && /^\d{4}-\d{2}-\d{2}$/.test(String(c.date || '')))
      const titleOk = !!(c && String(c.title || '').trim())
      const expDate = exp.date ? String(c && c.date) === exp.date : true
      pass = writes.calendars.length >= 1 && dateOk && titleOk && expDate
      detail.push(`calendar_add ${writes.calendars.length} 次 | date=${JSON.stringify(c && c.date)} ${dateOk ? '格式合法' : '★非法'}`)
      if (exp.date) detail.push(`期望 ${exp.date} → ${expDate ? '命中' : '★未命中（相对时间要换算）'}`)
      detail.push(`title ${titleOk ? '非空' : '★空'} | CALENDAR.md ${art.calendar.length} 字符`)
    }
  }

  // ── 事件归属 ──
  if (fam === 'event') {
    const ev = writes.events
    const append = ev.filter(e => e.action === 'append')
    const create = ev.filter(e => e.action === 'create')
    const OLD_ID = exp.oldEventId || 'evt_abc12345'

    if (exp.shouldWrite === 'event_append') {
      const a = append[0]
      const idOk = !!(a && String(a.eventId || '') === OLD_ID)
      const cp = (a && a.checkpoint) || {}
      const fourOk = ['goal', 'state', 'dead', 'next'].every(k => typeof cp[k] === 'string')
      pass = idOk
      detail.push(`append ${append.length} 次 | eventId ${idOk ? '正确' : '★' + JSON.stringify(a && a.eventId)}`)
      detail.push(`create ${create.length} 次 ${create.length ? '★不该新建' : '（未误建）'}`)
      detail.push(`检查点四段 ${fourOk ? '齐全' : '★缺'}`)
    } else if (exp.shouldWrite === 'event_create') {
      // ★必须区分「append 到旧事件（误挂）」与「append 到刚建的新事件（正确）」。
      //   首版把所有 append 都算误挂，把教科书式正确行为判成 FAIL。
      const appendOld = append.filter(a => String(a.eventId || '') === OLD_ID)
      pass = create.length >= 1 && appendOld.length === 0
      detail.push(`create ${create.length} 次 ${create.length ? '正确' : '★未新建'}`)
      detail.push(`append 到旧事件 ${appendOld.length} 次 ${appendOld.length ? '★误挂（污染历史边界）' : '（未误挂）'}`)
    }
  }

  // ── 每日日志 ──
  if (fam === 'log') {
    const ls = writes.logs
    const hasNote = ls.some(l => String(l.note || '').trim().length >= 8)
    if (exp.kind) {
      const kindOk = ls.some(l => String(l.kind || '') === exp.kind)
      pass = hasNote && kindOk
      detail.push(`memory_log ${ls.length} 次 | kind=${ls.map(l => l.kind).join(',')} ${kindOk ? '正确' : '★期望 ' + exp.kind}`)
    } else {
      pass = hasNote
      detail.push(`memory_log ${ls.length} 次 | note ${hasNote ? '非空' : '★空'}`)
    }
    detail.push(`日志落盘 ${art.logs.length} 字符`)
  }

  // ── 技能库 ──
  if (fam === 'procedure') {
    const p = writes.procedures[0]
    // ★steps 的 schema 类型是 string（"一行一步，换行分隔"），不是数组。
    //   首版按数组判，把完全正确的调用判成 FAIL。
    const raw = p ? p.steps : ''
    const lines = typeof raw === 'string'
      ? raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
      : (Array.isArray(raw) ? raw : [])
    const stepsOk = lines.length >= 2
    const titleOk = !!(p && String(p.title || '').trim())
    const critLines = String((p && p.successCriteria) || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    pass = !!p && stepsOk && titleOk
    detail.push(`memory_procedure ${writes.procedures.length} 次 | title ${titleOk ? '非空' : '★空'}`)
    detail.push(`steps ${stepsOk ? lines.length + ' 行（string，符合 schema）' : '★不足 2 步'}`)
    detail.push(`successCriteria ${critLines.length ? critLines.length + ' 条' : '★无（结构上永远无法晋升）'}`)
  }

  return { pass, detail }
}
