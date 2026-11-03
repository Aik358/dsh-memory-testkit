/**
 * 外部基准接入 · 把 Ornn8/memory-system-benchmark 的考点转成可跑场景。
 *
 * ═══ 为什么要接外部基准 ═══
 * 本套件的判据全是我自己设计的。自己出题、自己判分，最大的风险是
 * **只测到了我想到的东西**：15 个场景覆盖 7 个记忆面，但外部基准里
 * 「改口后不用旧安排」「第三方事实不记到用户头上」「没说完要跟进」这些
 * 恰恰是真实使用中最容易出错的，我一条都没测。
 *
 * ═══ 接的是哪部分（明确边界）═══
 * Ornn8 仓库的**公开示例**（`demo/示例题.md`）：1 个虚构人物、182 天、360 轮，
 * 27 个考点、108 个提问实例（每考点当天/3 天/15 天/45 天四档）。
 * 它自带的「必须做到 / 可接受 / 不能这样答 / 历史未说明」是**结构化判据**，
 * 比自由文本答案更适合自动化判分 —— 这是它最值得借的地方。
 *
 * ⚠️ 三条必须声明的事实：
 *   ① 官方**正式卷不公开**，示例题不能用来排名，只能用来校准判据。
 *   ② 本接入是**只读转换**：不改它的文件，不替它发声，结论只代表本套件视角。
 *   ③ 它的评分口径（跨 45 天遗忘）我们**用单轮跑不出来** ——
 *      单轮接法只能验「给了素材后是否写对」，验不出「跨时间还记不记得」。
 *      跨时间那部分走 lib/replay.mjs，另行标注 `mode: 'replay'`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/* ───────────────── 我们已有的能力面（用于算覆盖率） ───────────────── */

/**
 * 本套件当前覆盖的记忆面。新增考点时对照这张表 ——
 * 它存在的意义是**诚实显示还缺什么**，而不是宣称覆盖很全。
 */
export const OUR_COVERAGE = Object.freeze({
  sharedGround: ['共识', '双方对齐'],
  userPercept: ['用户偏好', '用户状态', '用户纠正'],
  commitment: ['承诺', '约定'],
  calendar: ['时间约定', '相对日期', '日程'],
  event: ['事件归属', '事件新建'],
  log: ['每日日志'],
  procedure: ['技能库'],
})

/**
 * Ornn8 的 27 个考点 → 我们的覆盖判定。
 * `covered` 指「本套件已有场景在测同类能力」；`note` 说明差异。
 */
export const ORNN8_CATEGORIES = [
  { id: 'C001', name: '约定和欠账', ours: 'commitment', covered: true, note: '我们有承诺，但缺「谁欠谁」的双方视角' },
  { id: 'C002', name: '用户的基本信息', ours: 'userPercept', covered: true, note: '' },
  { id: 'C003', name: '第三方事实', ours: null, covered: false, note: '★缺：别人的事不能记到用户头上' },
  { id: 'C004', name: '计划假设梦转述猜测', ours: null, covered: false, note: '★缺：区分已发生 / 打算 / 假设 / 转述' },
  { id: 'C005', name: '带条件或期限的偏好和边界', ours: null, covered: false, note: '★缺：条件的适用期' },
  { id: 'C006', name: '相似事件', ours: null, covered: false, note: '★缺：区分相近事件不混淆' },
  { id: 'C007', name: '分散的线索', ours: null, covered: false, note: '★缺：跨轮组合信息' },
  { id: 'C008', name: '改口', ours: 'sharedGround', covered: true, note: '我们有 correction 字段，但没测「不用旧安排」' },
  { id: 'C009', name: '助手自己说过的话', ours: null, covered: false, note: '★缺：区分助手建议与用户承诺' },
  { id: 'C010', name: '没说完要跟进的事', ours: null, covered: false, note: '★缺：待办不能编结果' },
  { id: 'C011', name: '敏感的事', ours: null, covered: false, note: '★缺：信息使用限制' },
  { id: 'C012', name: '共同编的故事', ours: null, covered: false, note: '★缺：虚构不当现实' },
  { id: 'C013', name: '假设', ours: null, covered: false, note: '★缺：保留 if 前提' },
  { id: 'C014', name: '偏好', ours: 'userPercept', covered: true, note: '有，但缺「一次选择 ≠ 永久偏好」' },
  { id: 'C015', name: '时间约定', ours: 'calendar', covered: true, note: '' },
  { id: 'C016', name: '时间题', ours: null, covered: false, note: '★缺：时长 / 先后关系推理' },
  { id: 'C017', name: '没解释的矛盾', ours: null, covered: false, note: '★缺：保留冲突不编原因' },
  { id: 'C018', name: '生日', ours: null, covered: false, note: '★缺：不编没依据的年份' },
  { id: 'C019', name: '相对日期', ours: 'calendar', covered: true, note: '有 cal-relative 场景' },
  { id: 'C020', name: '真实变化', ours: null, covered: false, note: '★缺：事实变化后用新信息' },
  { id: 'C021', name: '称呼条件', ours: null, covered: false, note: '★缺：条件性称呼' },
  { id: 'C022', name: '纠错', ours: 'userPercept', covered: true, note: '有 up-correction' },
  { id: 'C023', name: '职业', ours: null, covered: false, note: '★缺：工作信息不混淆' },
  { id: 'C024', name: '计划', ours: null, covered: false, note: '★缺：打算 ≠ 已完成' },
  { id: 'C025', name: '资料不足', ours: null, covered: false, note: '★缺：明确留空不编' },
  { id: 'C026', name: '转述', ours: null, covered: false, note: '★缺：保留来源' },
  { id: 'C027', name: '边界', ours: null, covered: false, note: '★缺：在边界内回答' },
]

/* ───────────────── 解析公开示例题 ───────────────── */

/**
 * 从 `demo/示例题.md` 解析出结构化题目。
 *
 * 它是人类可读的 Markdown（不是 JSON），但结构很规整：
 *   ## PUB01-C0NN · 考点名
 *   ### 历史依据（每行一条：- 第 N 轮 · 时间 · 用户/助手：内容）
 *   **问题：** …
 *   **必须做到：** / **可接受：** / **历史未说明：** / **不能这样答：** 各带 `- ` 列表
 *   **人工参考答案：** …
 *   **判分说明：** …
 * 另有 4 行时间档表（当天/3天/15天/45天 → 各自 now 与 cutoff 轮）。
 *
 * ⚠️ 解析失败要**响亮报错**，不能返回空数组 ——
 *    空数组会让「0 个外部场景」看起来像「外部基准没有可用内容」。
 */
export function parseOrnn8Markdown(mdPath) {
  let src = ''
  try { src = fs.readFileSync(mdPath, 'utf8') } catch (e) {
    return { ok: false, error: '读不到 ' + mdPath + '：' + String(e && e.message || e).slice(0, 160), items: [] }
  }
  // ⚠️ 这个文件是 **CRLF** 行尾。按 `\n` 切行后每行末尾残留 `\r`，
  //    所有以 `$` 结尾的正则（`…：\s*(.*)$`、`^-\s*…(.*)$`）都会匹配失败。
  //    实测表现：判据（must/accept）能解析，但 evidence 全部为 0 条 ——
  //    因为判据用的是 `[\s\S]` 跨行匹配，而 evidence 是逐行 `^…$` 匹配。
  //    ⇒ 统一先归一化行尾，再解析。这个坑在 Windows 上极常见。
  src = src.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  const blocks = src.split(/^## /m).slice(1)
  const items = []
  for (const b of blocks) {
    const head = b.match(/^(PUB01-[A-Z]\d+)\s*·\s*(\S+)/)
    if (!head) continue
    const [, id, category] = head

    const body = b.slice(head[0].length)

    // ── 历史依据 ──
    // 行格式：`- 第 5 轮 · 2026-01-07T19:10:00+08:00 · 用户：上周阿岑借我…`
    // ⚠️ 那个分隔符是 U+00B7（MIDDLE DOT），不是 ASCII 的 `·`；
    //    用 `[^·]` 这类字符类会因编码差异匹配不到（实测 evidence 全部解析成 0 条）。
    //    所以这里**不用中点做分隔**，改用「第 N 轮」+「日期时间」+「角色：」三段各自匹配。
    const histLines = []
    let inHist = false
    for (const line of body.split('\n')) {
      if (/^###\s*历史依据/.test(line)) { inHist = true; continue }
      if (inHist && /^###|^\*\*/.test(line)) inHist = false
      if (!inHist) continue
      const m = line.match(/^-\s*第\s*(\d+)\s*轮\s*[-–—·•\u00b7\s]*\s*(\d{4}-\d{2}-\d{2}T[\d:+\-]+)\s*[-–—·•\u00b7\s]*\s*(用户|助手)\s*[：:]\s*(.*)$/)
      if (m) histLines.push({ turn: Number(m[1]), time: m[2], who: m[3], text: m[4].trim() })
    }

    const question = (body.match(/\*\*问题：\*\*\s*(.+)/) || [, ''])[1].trim()
    const answer = (body.match(/\*\*人工参考答案：\*\*\s*(.+)/) || [, ''])[1].trim()
    const judgeNote = (body.match(/\*\*判分说明：\*\*\s*(.+)/) || [, ''])[1].trim()

    /** 抽「**X：**」后面的 `- ` 列表 */
    const listOf = (label) => {
      const re = new RegExp('\\*\\*' + label + '：\\*\\*([\\s\\S]*?)(?=\\n\\*\\*|\\n###|$)')
      const m = body.match(re)
      if (!m) return []
      return m[1].split('\n')
        .map(l => l.replace(/^-\s*/, '').trim())
        .filter(l => l && !l.startsWith('#'))
    }

    // ── 时间档表 ──
    // `| 当天（最后提及后 1 秒） | 2026-01-07T19:10:01+08:00 | 5 | 全部 |`
    // ⚠️ 不能先 filter(Boolean) —— 首列前有一个空格，被滤掉后列索引整体左移，
    //    会把 cutoff 读成「全部」那一列（实测 slots 解析成 0 条）。
    const slots = []
    for (const row of body.split('\n')) {
      if (!row.trim().startsWith('|')) continue
      const cells = row.split('|')
      // split 后首尾是空串，去掉它们但**保留中间的空列**
      cells.shift()
      cells.pop()
      const t = cells.map(c => c.trim())
      if (t.length < 4) continue
      if (/^[-:]+$/.test(t[0]) || /间隔/.test(t[0])) continue
      const cutoff = Number(t[2])
      if (!Number.isFinite(cutoff)) continue
      const iso = t[1].match(/^\d{4}-\d{2}-\d{2}T[\d:+\-]+$/)
      if (!iso) continue
      slots.push({ label: t[0], now: t[1], cutoffTurn: cutoff, recentHasFact: t[3] })
    }

    items.push({
      source: 'ornn8',
      id,
      category,
      question,
      must: listOf('必须做到'),
      accept: listOf('可接受'),
      unknown: listOf('历史未说明'),
      forbidden: listOf('不能这样答'),
      reference: answer,
      judgeNote,
      evidence: histLines,
      slots,
    })
  }

  if (!items.length) {
    return { ok: false, error: '解析出 0 个考点 —— Markdown 结构可能变了，需更新 parseOrnn8Markdown()', items: [] }
  }
  return { ok: true, items, at: Date.now() }
}

/* ───────────────── 转换成可跑场景 ───────────────── */

/**
 * 把一条外部考点转成**单轮**场景（A 方案）。
 *
 * 单轮接法的做法：把「历史依据」+ 问题一起给它，看它是否写出符合
 * `必须做到` 的内容。这是**简化**：真实基准要先回放全部历史再问。
 * 所以这种接法只验「给定素材后的表达能力与判据意识」，不验跨时间记忆。
 *
 * @param {object} item parseOrnn8Markdown 的产出
 * @param {object} [opts]
 * @param {boolean} [opts.anchorOnMust] true=把「必须做到」直接写进任务（更容易过，
 *   但测的变成「照着清单做」）；false=只给素材+问题（更接近真实）
 * @returns {object} 场景对象（可交给 runScenario）
 */
export function toSingleTurnScenario(item, opts = {}) {
  const anchor = opts.anchorOnMust === true
  const evidence = item.evidence
    .map(e => `- 第${e.turn}轮 · ${e.time} · ${e.who}：${e.text}`)
    .join('\n')

  const lines = [
    '以下是一段长期对话里的相关记录（节选，按时间顺序）：',
    '',
    evidence || '（无历史依据）',
    '',
    '现在请回答这个问题，并把这次问答里有长期价值的结论写进项目记忆。',
    '',
    '问题：' + item.question,
  ]
  if (anchor) {
    lines.push('', '这次需要做到：')
    for (const m of item.must) lines.push('- ' + m)
  }
  lines.push('', '把记忆用 memory_note 写入即可。完成后回复你的答案与写了什么。')

  return {
    id: 'ornn8-' + item.id.slice('PUB01-'.length).toLowerCase(),
    family: 'external:' + item.category,
    label: `[外部·Ornn8] ${item.category} · ${item.question.slice(0, 40)}`,
    text: lines.join('\n'),
    // 外部判据留给 external judge 用；通用 judge 不认这个字段
    external: {
      source: 'ornn8',
      itemId: item.id,
      category: item.category,
      must: item.must,
      accept: item.accept,
      unknown: item.unknown,
      forbidden: item.forbidden,
      reference: item.reference,
      anchoredOnMust: anchor,
    },
  }
}

/**
 * 判一条外部题。
 *
 * ═══ 四次修正的教训（每次都被实测打回，记在这里免得后人重踩）═══
 *
 * | 版本 | 判法 | 实测结果 |
 * |---|---|---|
 * | v1 | must 整条严格包含 | **参考答案 11/27 被判不过**：must「梦里舞台变成温室」vs 参考「梦见舞台变成温室」 |
 * | v2 | 拆义项 + 2–4 字滑窗 | 参考 26/27 过，但**宽松过头**：无关回答能蒙中窗口，正确答案被误判踩线 |
 * | v3 | 最长公共子串 + 元描述识别 | **参考 2 个被误判**：C020 的 forbidden 与正确表述共享「负责侧台走线」；C027 的 must「须取得同意」与参考「不要代发」是同义改写 |
 * | v4（本版）| **按「能否自动判定」分档，判不了就返回 null** | 见下 |
 *
 * ═══ v4 的核心认识 ═══
 * 中文的同义改写（「须取得同意」vs「不要代发消息」）**无法靠子串匹配解决**。
 * 硬判只会两类错误各占一半。所以本版不追求「判得准」，而是
 * **明确区分「机器能判的」与「必须人看的」**：
 *
 *   · 能判：义项在回答里找得到足够长的连续片段 → 给 true/false
 *   · 判不了：义项部分命中（可能是同义改写）/ 只有抽象判据 → **返回 null**
 *     `null` 会从分母里剔除，报告里单列「需人工判 N 题」。
 *
 * 取舍理由：**假红误导优化方向**（答对了显示失败），**假绿掩盖真问题**。
 * 两者都不可接受时，诚实地报「判不了」比硬给一个错答案有用。
 *
 * ═══ 关于 forbidden 为什么只用整条严格包含 ═══
 * C020 的 forbidden「说许澄过去一直负责侧台走线」与**正确答案**
 * 「以前侧台走线由别人检查…」共享「负责侧台走线」⇒ 片段匹配会误杀正确答案。
 * 整条严格包含只抓「逐字复述了错误表述」（对 abstention 编造特别有效），
 * 其余进 `unverifiable` 标为需人工看。
 *
 * @returns {{
 *   pass: boolean|null,   null = 判不了（不是失败）
 *   decidable: boolean,
 *   needsHuman: boolean,
 *   detail: string[],
 *   confidence: 'high'|'medium'|'low'|'none',
 *   unverifiable: string[],
 * }}
 */
export function judgeExternal(item, answer) {
  const text = String(answer || '')
  const detail = []
  const unverifiable = []
  const mk = (o) => ({
    decidable: o.pass !== null,
    needsHuman: o.pass === null || o.confidence === 'low',
    unverifiable,
    confidence: 'none',
    ...o,
  })

  if (!item) return mk({ pass: null, detail: ['无判据'] })
  if (!item.must || !item.must.length) {
    return mk({ pass: null, detail: ['该题没有「必须做到」条目，无法自动判定'] })
  }
  if (!text.trim()) return mk({ pass: false, detail: ['回答为空'], confidence: 'high' })

  const norm = (s) => String(s).replace(/[。，、；：？！,.;:?!"'“”‘’()（）\[\]\s]/g, '').toLowerCase()
  const STOP = /[的了着过是在有和与及或就都也还又很更最把被让给对从向往到]/g
  const answerN = norm(text)

  /** 最长连续公共子串长度（a=判据义项，b=回答） */
  function lcs(a, b) {
    if (!a || !b) return 0
    let best = 0
    for (let i = 0; i < a.length; i++) {
      for (let j = i + Math.max(best + 1, 2); j <= a.length; j++) {
        const seg = a.slice(i, j)
        if (b.includes(seg)) best = Math.max(best, seg.length)
        else break
      }
    }
    return best
  }

  /**
   * 元描述判据：描述答案的**性质**而非**内容**，如「这是条件计划」「保留来源」。
   * ⚠️ 「不要向任何人转告」看着像元描述，其实是**具体内容**（有动作有对象）——
   *    实测曾因把它当元描述跳过而漏判 C011。所以这里加一条反向排除：
   *    含具体动作词就是内容，不是元描述。
   */
  const isMetaCriterion = (s) => {
    const t = String(s).trim()
    if (/\d/.test(t)) return false
    if (/[一二三四五六七八九十]|天|周|月|日|点|分钟|上午|下午/.test(t)) return false
    if (/发给|转告|取得|同意|告诉|告知|代发|检查|负责|放在|借|还|提醒|催/.test(t)) return false
    return /^(这是|保留|避免|注意)/.test(t)
  }

  // ── ① 禁止项：只用整条严格包含（理由见上方注释）──
  for (const bad of (item.forbidden || [])) {
    const core = norm(bad)
    if (!core) continue
    if (answerN.includes(core)) {
      detail.push(`★踩了「不能这样答」：${bad}`)
      return mk({ pass: false, detail, confidence: 'high' })
    }
    unverifiable.push('forbidden:' + bad)
  }

  // ── ② 必须项 ──
  const clauses = []
  for (const m of item.must) {
    for (const part of String(m).split(/[；;]\s*/)) {
      const p = part.trim()
      if (p) clauses.push(p)
    }
  }

  let hit = 0
  const missed = []
  const soft = []

  for (const c of clauses) {
    if (isMetaCriterion(c)) { soft.push(c); hit++; continue }
    const needle = norm(c).replace(STOP, '')
    if (!needle) { soft.push(c); hit++; continue }

    // 阈值：义项越长要求命中的连续片段越长，但不超过义项长度的一半
    //   ≤4 字 ⇒ 2（「扳手」「温室」这类核心词足够）
    //   ≤8 字 ⇒ 3
    //   >8 字 ⇒ 4
    const cap = Math.max(2, Math.floor(needle.length / 2))
    const need = Math.min(needle.length <= 4 ? 2 : (needle.length <= 8 ? 3 : 4), cap)
    const n = lcs(needle, answerN)
    if (n >= need) hit++
    else missed.push(`${c}（最长命中 ${n} 字，需 ${need}）`)
  }

  // ── 判定 ──
  if (missed.length) {
    /**
     * 什么时候才敢说「答偏了」？
     *
     * v4 第一版用「一个义项都没命中 + 无软判据 + 义项数 ≤2」⇒ 判 false，
     * 实测把 C027 的真参考答案判成错：
     *   must「发给同事前须取得同意」 vs 参考「未经用户同意不要代发消息给同事」
     *   —— 同义改写，最长共现只有「同意」。
     *
     * 所以加一条**内容量判据**：义项必须「足够具体」才值得判死。
     * 含模态词（须/应/不要）而长度又短的义项，改写风险高 ⇒ 判不了。
     */
    const isAbstractRule = (c) => {
      const t = String(c).trim()
      return /(须|应|必须|不要|不得|避免)/.test(t) && t.length <= 12
    }
    const concrete = clauses.filter(c => !isAbstractRule(c))
    const allMissed = hit === 0 && soft.length === 0 && clauses.length <= 2 && concrete.length === clauses.length

    if (allMissed) {
      detail.push(`一个义项都没命中：${missed.join(' | ')}`)
      return mk({ pass: false, detail, confidence: 'medium' })
    }
    detail.push(`缺 ${missed.length}/${clauses.length} 个义项：${missed.join(' | ')}`)
    detail.push('★可能是同义改写 —— 规则判分无法区分「没答」与「换个说法答了」，需人工判')
    return mk({ pass: null, detail })
  }

  detail.push(`${clauses.length} 个义项均命中`)
  if (soft.length) {
    unverifiable.push(...soft.map(s => 'must-meta:' + s))
    detail.push(`（${soft.length} 条抽象判据无法自动核对：${soft.join('；')}）`)
  }
  const hasUncheckedForbidden = unverifiable.some(u => u.startsWith('forbidden:'))
  const conf = (hasUncheckedForbidden || soft.length) ? 'low' : 'medium'
  if (hasUncheckedForbidden) {
    detail.push(`（${unverifiable.filter(u => u.startsWith('forbidden:')).length} 条「不能这样答」未命中但无法排除改写，需人工确认）`)
  }
  return mk({ pass: true, detail, confidence: conf })
}

/** 覆盖率统计 —— 明说我们缺什么 */
export function coverageReport() {
  const total = ORNN8_CATEGORIES.length
  const covered = ORNN8_CATEGORIES.filter(c => c.covered).length
  return {
    total,
    covered,
    missing: ORNN8_CATEGORIES.filter(c => !c.covered).map(c => ({
      id: c.id, name: c.name, note: c.note,
    })),
    byOurs: ORNN8_CATEGORIES.reduce((acc, c) => {
      if (c.ours) (acc[c.ours] = acc[c.ours] || []).push(c.id)
      return acc
    }, {}),
  }
}

/**
 * 从本机克隆里读示例题（不内置数据 —— 外部数据不进本仓库，避免许可与版本漂移）。
 *
 * @param {string} repoPath Ornn8 仓库的克隆路径
 */
export function loadOrnn8(repoPath) {
  const md = path.posix.join(repoPath, 'demo/示例题.md')
  if (!fs.existsSync(md)) {
    return {
      ok: false,
      error: `找不到 ${md}\n`
        + '  接外部基准需要先克隆它的公开示例：\n'
        + '    git clone --depth 1 https://github.com/Ornn8/memory-system-benchmark\n'
        + '  然后设 TESTKIT_ORNN8_DIR 指向该目录。',
      items: [],
    }
  }
  // 顺带记录它的版本，便于报告里写清「测的是哪一版」
  let commit = null
  try {
    commit = execFileSync('git', ['-C', repoPath, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch (_) {}
  const parsed = parseOrnn8Markdown(md)
  return { ...parsed, repoPath, commit, file: md }
}
