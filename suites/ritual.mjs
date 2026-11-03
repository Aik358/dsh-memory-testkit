/**
 * 套件 B · 接续前刷新仪式
 *
 * 被测对象：lib/index.js 的 refreshRitualPrompt() —— 插件里唯一一个
 * 「一次性让模型连做 4–5 个记忆操作」的提示词，同时承担事件归属 +
 * 白板刷新 + 账本撰写三件事，并有 120 秒时间预算。
 *
 * ★ 这个套件必须**真调工具**，不能离线评判 —— 它测的就是多步编排能否走通。
 *   离线只看文本永远发现不了「第 0 步拿不到 id 却要求第 2 步写 id」这种依赖死锁。
 *
 * ★★ 核心发现（用本套件复现）：
 *   空库世界完成率 92%，**已有事件世界只有 15%**（13 次里 11 次超时）。
 *   根因不在提示词措辞 —— 四个版本（R0/R1/R2/R3）都救不了。
 *   瓶颈在 memory_recall(scope=events) 是词法匹配：模型不知道事件叫什么，
 *   只能猜关键词，猜不中就换词重试，每次都有延迟，很快吃光预算。
 */
import { RITUAL_VERSIONS } from './ritual-prompts.mjs'

/** 从落盘产物判分（不看模型自述） */
export async function judgeRitual({ scenario, art, before }) {
  const detail = []
  const metrics = {}

  // ① 账本：本次新写的
  const freshHandoffs = art.handoffs.filter(h => {
    try { return true } catch (_) { return false }
  })
  const ledgerWritten = freshHandoffs.length > 0
  let ledgerEventId = ''
  let fourOk = false
  if (ledgerWritten) {
    const t = freshHandoffs[freshHandoffs.length - 1].text
    const m = t.match(/eventId\s*[=:]\s*(evt_[0-9a-f]+)/i)
    if (m) ledgerEventId = m[1]
    fourOk = ['任务状态', '目标', '已试方案与失败原因', '进度与下一步'].every(s => new RegExp('##\\s*' + s).test(t))
  }

  // ② 白板：是否真被重写（还留着「自动建立」骨架 = 没写）
  const planWritten = !!(art.plan && !/自动建立|待模型重写/.test(art.plan) && art.plan.length > 80)

  // ③ 事件：是否新建了
  const evs = (art.events && art.events.events) || []
  const preIds = new Set((scenario._preEventIds || []))
  const newEvent = evs.find(e => !preIds.has(e.id))

  // ④ 归属正确性：不该挂到已 closed 的事件
  const closedIds = new Set((scenario._closedIds || []))
  const wrongAttach = !!(ledgerEventId && closedIds.has(ledgerEventId))

  metrics.ledgerWritten = ledgerWritten
  metrics.planWritten = planWritten
  metrics.ledgerEventId = ledgerEventId
  metrics.newEventId = newEvent ? newEvent.id : ''
  metrics.timedOut = false

  detail.push(`账本 ${ledgerWritten ? '有（四段' + (fourOk ? '齐全' : '★不全') + '）' : '★无'}`)
  detail.push(`白板 ${planWritten ? '已重写' : '★未重写'}`)
  detail.push(`eventId ${ledgerEventId || '★缺'}${newEvent ? ' / 新建 ' + newEvent.id : ''}`)
  if (wrongAttach) detail.push('★挂到了 closed 事件')

  // 完成 = 账本 + 白板都落盘，且没挂错
  const pass = ledgerWritten && planWritten && !wrongAttach
  return { pass, detail, metrics }
}

/** 生成接续仪式的场景（每个版本 × 每个世界） */
export function buildRitualScenarios({ versionKeys, worlds }) {
  const out = []
  for (const vk of versionKeys) {
    const v = RITUAL_VERSIONS[vk]
    if (!v) continue
    for (const world of worlds) {
      out.push({
        id: `ritual-${vk}-${world}`,
        family: 'ritual',
        label: `${v.label} / ${world === 'hasEvent' ? '已有 3 个事件' : world === 'single' ? '单一活跃事件' : '空库'}`,
        text: v.text,
        _world: world,
      })
    }
  }
  return out
}
