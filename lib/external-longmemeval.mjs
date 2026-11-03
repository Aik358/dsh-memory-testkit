/**
 * 外部基准接入 · LongMemEval（ICLR 2025，MIT）。
 *
 * 仓库：https://github.com/xiaowu0162/LongMemEval
 * 数据：https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned
 *
 * ═══ 为什么接它（与本套件互补的地方）═══
 * 本套件最弱的是「选择性地不回答」与「知识更新」——我只测了「该写的时候写没写对」，
 * 几乎没测「不该说的时候有没有编」。LongMemEval 的 7 类里有两类正好补这个：
 *   · `abstention`（30 题）：历史里没有答案，正确行为是明确说不知道
 *   · `knowledge-update`（72 题）：事实变了，要用新值而不是旧值
 * 这两类的失败方式（编造、用旧值）在真实使用中代价最高，而我们的判据完全没覆盖。
 *
 * ═══ 数据不进本仓库 ═══
 * 15MB（oracle）/ 277MB（S）的 JSON 不适合放仓库，也会带来版本漂移。
 * 由使用者按需下载，本模块只读。下载指令写在 `instructions()` 里。
 *
 * ═══ 两种接法 ═══
 * `mode: 'single'`  把 evidence 会话 + 问题一次给出（跑得快，测「给了素材会不会答对」）
 * `mode: 'replay'`  把 haystack 全部会话回放后再问（测跨会话记忆，慢）
 * 前者是 A 方案的延伸，后者复用 lib/replay.mjs。**报告里必须标明是哪种**，
 * 因为两者结论不能互相替代。
 */
import fs from 'node:fs'
import path from 'node:path'

export const LME_TYPES = Object.freeze({
  'single-session-user': { zh: '单会话·用户陈述', ours: 'userPercept', covered: true },
  'single-session-assistant': { zh: '单会话·助手陈述', ours: null, covered: false, note: '★缺：区分助手自己说过的话' },
  'single-session-preference': { zh: '单会话·偏好', ours: 'userPercept', covered: true },
  'temporal-reasoning': { zh: '时间推理', ours: null, covered: false, note: '★缺：时长/先后/日期关系' },
  'knowledge-update': { zh: '知识更新', ours: null, covered: false, note: '★缺：事实变化后用新值' },
  'multi-session': { zh: '多会话推理', ours: null, covered: false, note: '★缺：跨会话组合信息' },
  abstention: { zh: '选择性不回答', ours: null, covered: false, note: '★缺：没有答案时要明说不知道' },
})

/** 下载指引（数据不随仓库分发） */
export function instructions() {
  return [
    'LongMemEval 数据不随本仓库分发，需要先下载：',
    '',
    '  mkdir -p <某目录>/longmemeval',
    '  cd <某目录>/longmemeval',
    '  curl -LO https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json',
    '  # 可选（更大，277MB）：longmemeval_s_cleaned.json',
    '',
    '然后设 TESTKIT_LME_DIR 指向该目录，或传 --lme-dir。',
    '',
    '建议先用 oracle：它只含证据会话（3~5 个），跑一次成本最低，',
    '适合快速校准「选择性不回答」与「知识更新」这两类判据。',
  ].join('\n')
}

/**
 * 载入 LongMemEval。
 *
 * @param {object} o
 * @param {string} o.dir       数据目录
 * @param {string} [o.file]    文件名（默认 longmemeval_oracle.json）
 * @param {string[]} [o.types] 只取这些类型（含 'abstention'）
 * @param {number} [o.limit]   最多取多少题（按类型均衡取，避免全是 temporal-reasoning）
 */
export function loadLongMemEval(o) {
  const dir = o.dir
  const file = o.file || 'longmemeval_oracle.json'
  const p = path.posix.join(dir, file)
  if (!fs.existsSync(p)) {
    return { ok: false, error: '找不到 ' + p + '\n\n' + instructions(), items: [] }
  }
  let raw = null
  try { raw = JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) {
    return { ok: false, error: '解析失败（文件可能被截断）：' + String(e && e.message || e).slice(0, 160), items: [] }
  }
  if (!Array.isArray(raw) || !raw.length) {
    return { ok: false, error: '数据结构不是非空数组 —— 版本可能变了', items: [] }
  }

  const norm = raw.map(normalizeItem)
  const want = o.types && o.types.length ? new Set(o.types) : null
  const pool = want ? norm.filter(x => want.has(x.type)) : norm

  // 按类型均衡取样：直接 slice(0,N) 会几乎全是 temporal-reasoning（127/500）
  let items = pool
  if (o.limit && o.limit > 0 && pool.length > o.limit) {
    const byType = {}
    for (const x of pool) (byType[x.type] = byType[x.type] || []).push(x)
    const types = Object.keys(byType)
    const per = Math.max(1, Math.floor(o.limit / types.length))
    items = []
    for (const t of types) items.push(...byType[t].slice(0, per))
    // 不够就按顺序补齐
    let i = 0
    while (items.length < o.limit && i < pool.length) {
      if (!items.includes(pool[i])) items.push(pool[i])
      i++
    }
    items = items.slice(0, o.limit)
  }

  return {
    ok: true,
    file: p,
    total: raw.length,
    selected: items.length,
    typeCounts: countTypes(items),
    items,
  }
}

function countTypes(items) {
  const m = {}
  for (const x of items) m[x.type] = (m[x.type] || 0) + 1
  return m
}

/**
 * 归一化一条实例。
 *
 * ★ abstention 的判定：`question_id` 以 `_abs` 结尾（官方 README 明确说明），
 *   而 `question_type` 仍写着原始类型 ⇒ 不能只看 question_type，
 *   否则 30 道「该说不知道」的题会被当成普通题，判据用错（最危险的一类错）。
 */
export function normalizeItem(x) {
  const isAbs = /_abs$/.test(String(x.question_id || ''))
  const type = isAbs ? 'abstention' : String(x.question_type || 'unknown')
  return {
    source: 'longmemeval',
    id: x.question_id,
    type,
    baseType: x.question_type,
    isAbstention: isAbs,
    question: String(x.question || '').trim(),
    // answer 可能是字符串也可能是数字，统一成串
    answer: x.answer == null ? '' : String(x.answer),
    questionDate: x.question_date || '',
    sessions: Array.isArray(x.haystack_sessions) ? x.haystack_sessions : [],
    sessionIds: Array.isArray(x.haystack_session_ids) ? x.haystack_session_ids : [],
    sessionDates: Array.isArray(x.haystack_dates) ? x.haystack_dates : [],
    answerSessionIds: Array.isArray(x.answer_session_ids) ? x.answer_session_ids : [],
    // 证据轮次：标了 has_answer 的那些
    evidenceTurns: (Array.isArray(x.haystack_sessions) ? x.haystack_sessions : [])
      .flatMap((s, si) => (s || []).filter(t => t && t.has_answer)
        .map(t => ({ session: si, role: t.role, content: String(t.content || '').slice(0, 400) }))),
  }
}

/**
 * 转成**单轮**场景（mode='single'）。
 *
 * 只把**证据会话**给它 —— 这与官方 oracle 版的设计意图一致（只含证据）。
 * 注意这不是「跑完整基准」：完整版要把整个 haystack 回放。
 * 这条路径的用途是**快速校准判据**，不是复现官方分数。
 */
export function toSingleTurnScenario(item, opts = {}) {
  const maxChars = opts.maxChars || 6000
  const parts = []
  let used = 0
  for (let si = 0; si < item.sessions.length; si++) {
    const sess = item.sessions[si] || []
    const date = item.sessionDates[si] || ''
    const lines = sess.map(t => (t.role === 'user' ? '用户：' : '助手：') + String(t.content || '').trim())
    const blob = (date ? '【' + date + '】\n' : '') + lines.join('\n')
    if (used + blob.length > maxChars) break
    parts.push(blob)
    used += blob.length
  }

  const text = [
    '以下是我和你在过去一些会话里的原始对话记录（按会话分段，含时间）：',
    '',
    parts.join('\n\n---\n\n') || '（无历史）',
    '',
    '现在是 ' + (item.questionDate || '稍后') + '。请只依据上面的记录回答：',
    item.question,
    '',
    '答题纪律：',
    '- 如果记录里没有足够信息，就明确说「记录里没有」或「不知道」，**不要编造**。',
    '- 如果某个事实后来被更新过，用最新的那次。',
    '',
    '回答完后，把这次问答里值得长期记住的结论用 memory_note 写入。',
  ].join('\n')

  return {
    id: 'lme-' + String(item.id).replace(/[^a-zA-Z0-9_-]/g, '-'),
    family: 'external-lme:' + item.type,
    label: `[外部·LongMemEval] ${item.type} · ${item.question.slice(0, 46)}`,
    text,
    external: {
      source: 'longmemeval',
      itemId: item.id,
      type: item.type,
      isAbstention: item.isAbstention,
      goldAnswer: item.answer,
      questionDate: item.questionDate,
      mode: 'single',
      note: 'singe-turn 只给证据会话；不能等同于官方分数',
    },
  }
}

/** 转成 replay 输入（mode='replay'）—— 交给 lib/replay.mjs */
export function toReplayInput(item) {
  const turns = []
  for (let si = 0; si < item.sessions.length; si++) {
    const date = item.sessionDates[si] || ''
    for (const t of (item.sessions[si] || [])) {
      if (!t || !t.content) continue
      if (t.role === 'user') {
        turns.push({ user: String(t.content), assistant: '', logicalTime: date })
      } else {
        // 助手消息并入上一轮的 assistant 字段（replay 的 packTurn 会合成一条）
        if (turns.length) turns[turns.length - 1].assistant = String(t.content)
        else turns.push({ user: '（对话开始）', assistant: String(t.content), logicalTime: date })
      }
    }
  }
  return { turns, question: item.question, questionDate: item.questionDate }
}

/* ───────────────── 判分 ───────────────── */

/**
 * 判一条 LongMemEval 题。
 *
 * ═══ 判法与其局限（必须如实写进报告）═══
 * 官方的 `evaluate_qa.py` 用 **GPT-4o 当裁判**做语义等价判定（需要 OPENAI_API_KEY）。
 * 本套件不引入外部裁判模型（那会让「测什么」依赖于另一个模型的行为），
 * 所以这里用**保守的规则判**：
 *
 *   · abstention：回答里必须出现「不知道/没有提到/无法确定/记录里没有」这类表述。
 *     ★ 这是最容易假绿的一类：模型可以一边说「记录里没有」一边又编一个答案。
 *       所以同时检查**没有编造**：回答不应含有任何具体年份/日期/数量
 *       与 gold 无关的新事实（粗判，仅作提示，不单独判死）。
 *   · 其他类型：gold 答案的关键片段是否出现在回答里（字符包含，去标点）。
 *
 * ⇒ 这个判法的**假阳性（把错的判成对）风险高于官方裁判**。
 *   报告里必须标注 `judge: 'rule-based'`，并且**不能**据此宣称与官方榜可比。
 *
 * @returns {{pass:boolean|null, detail:string[], judge:string, confidence:string}}
 */
export function judgeLongMemEval(item, answer) {
  const text = String(answer || '').trim()
  const detail = []
  if (!text) return { pass: false, detail: ['回答为空'], judge: 'rule-based', confidence: 'high' }

  const norm = (s) => String(s).replace(/[。，、；：？！.,;:?!'"“”‘’()（）\[\]\s]/g, '').toLowerCase()
  const A = norm(text)

  // ── abstention：必须明确表示不知道 ──
  if (item.isAbstention) {
    const hedges = ['不知道', '没有提到', '没有说', '没有相关', '无法确定', '没有信息', '记录里没有', '没有记录',
      '没有提供', '不清楚', '未见', '无法回答', '没有足够']
    const said = hedges.filter(h => A.includes(norm(h)))
    if (!said.length) {
      detail.push('★该题正确行为是「明确说不知道」，但回答里没有这类表述')
      return { pass: false, detail, judge: 'rule-based', confidence: 'high' }
    }
    detail.push('明确表示信息不足（命中：' + said.slice(0, 2).join('/') + '）')

    // ★ 反制「一边说不知道一边编」：看有没有给出 gold 之外的具体断言
    //   这里只做**提示**，不单独判死 —— 粗判容易误伤
    const years = (text.match(/\b(19|20)\d{2}\b/g) || [])
    if (years.length) detail.push('⚠ 同时给出了年份 ' + years.join(',') + ' —— 需人工确认是否编造')
    return {
      pass: true, detail, judge: 'rule-based',
      confidence: years.length ? 'low' : 'medium',
    }
  }

  // ── 普通题：gold 关键片段包含 ──
  const gold = item.answer
  if (!gold) return { pass: null, detail: ['该题没有 gold 答案，无法判'], judge: 'rule-based', confidence: 'none' }

  // gold 可能是「答案1 / 答案2」这种多选
  const alts = String(gold).split(/\s*[/|]\s*/).map(s => s.trim()).filter(Boolean)
  const hitAlt = alts.find(alt => {
    const pieces = String(alt).split(/[，,、;\s]+/).map(norm).filter(x => x.length >= 2)
    if (!pieces.length) return A.includes(norm(alt))
    // 短答案（≤2 片段）要求全中；长答案允许命中一半以上
    const hits = pieces.filter(p => A.includes(p)).length
    return pieces.length <= 2 ? hits === pieces.length : hits / pieces.length >= 0.6
  })

  if (hitAlt) {
    detail.push('命中 gold：' + (hitAlt.length > 60 ? hitAlt.slice(0, 60) + '…' : hitAlt))
    return { pass: true, detail, judge: 'rule-based', confidence: 'medium' }
  }
  detail.push('未命中 gold：' + (String(gold).slice(0, 80)))
  detail.push('（规则判分对同义改写不敏感 —— 未命中不等于错，需人工复核）')
  return { pass: false, detail, judge: 'rule-based', confidence: 'low' }
}

/** 覆盖率：LongMemEval 的 7 类里我们原本覆盖几类 */
export function coverageReport() {
  const all = Object.entries(LME_TYPES).map(([k, v]) => ({ id: k, ...v }))
  const covered = all.filter(x => x.covered)
  return {
    total: all.length,
    covered: covered.length,
    missing: all.filter(x => !x.covered),
    all,
  }
}
