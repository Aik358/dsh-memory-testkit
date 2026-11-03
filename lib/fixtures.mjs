/**
 * 夹具工厂 —— 预置工作区状态。
 *
 * ★★ 铁律：必须写到**沙箱记忆库**（config.projectDirOf(cwd)），不是 cwd。
 *   插件 resolvePaths 把 projectDir 解析到 memoryRoot 下的 wsKey 目录，
 *   cwd 里的 handoff/ 它根本不读。
 *
 *   首版写错位置的后果（实测）：
 *     · memory_read(kind=plan) 返回 content:""、revision 是空串的 sha256
 *     · memory_recall(scope=events) 说「本工作区还没有任何事件」
 *     · 模型于是去文件系统翻找 —— 39 个工具调用、240 秒超时，
 *       还读到了别的实验工作区的 PLAN.md（自指污染）
 */
import fs from 'node:fs'
import path from 'node:path'
import { projectDirOf } from './config.mjs'

/** 合法枚举 —— 与 lib/event-store.js 的 EVENT_KINDS 同源 */
export const EVENT_KINDS = ['ledger', 'planSnapshot', 'sessionTranscript', 'project', 'mechanical', 'unknown']
export const EVENT_CONFIDENCES = ['low', 'medium', 'high']
export const EVENT_STATUSES = ['active', 'paused', 'closed']

/**
 * 造一个逐字段合规的事件。
 *
 * ★★ 必须 26 字段齐全且枚举合法：validateEventPre 是 fail-closed 的，
 *   一个坏事件会让**整个 store 的每次写入都失败**（实测：
 *   `missing:skillRef,bad-kind:task` 挡住 3 次连续 create）。
 *   这是产品缺陷 D2，夹具侧必须避开。
 */
export function makeEvent(over = {}) {
  const now = Date.now()
  return {
    id: over.id || 'evt_' + Math.random().toString(16).slice(2, 10),
    name: over.name || '测试事件',
    summary: over.summary || '测试用事件总览',
    outcome: over.outcome || '',
    skillRef: over.skillRef === undefined ? null : over.skillRef,
    status: over.status || 'active',
    pausedReason: over.pausedReason || null,
    createdAt: over.createdAt || now,
    updatedAt: over.updatedAt || now,
    startMs: over.startMs === undefined ? now : over.startMs,
    endMs: over.endMs === undefined ? 0 : over.endMs,
    kind: EVENT_KINDS.includes(over.kind) ? over.kind : 'ledger',
    confidence: EVENT_CONFIDENCES.includes(over.confidence) ? over.confidence : 'medium',
    ordinal: over.ordinal || 1,
    sections: over.sections || { goal: '目标', doing: '进行中', deadend: '', next: '下一步' },
    checkpoints: over.checkpoints || [],
    userPercept: over.userPercept || [],
    agentTrace: over.agentTrace || [],
    sharedGround: over.sharedGround || [],
    commitments: over.commitments || [],
    constraints: over.constraints || [],
    members: over.members || ['测试预置'],
    rationale: over.rationale || '夹具预置',
    outcomes: over.outcomes || [],
    skills: over.skills || {},
    idemTag: over.idemTag === undefined ? null : over.idemTag,
  }
}

/** 造一个带 memory 锚点的白板（真实格式） */
export function makePlan({ title = '项目白板 · 测试', sections = [] } = {}) {
  const secs = sections.length ? sections : [
    { anchor: 'mem_aaaa1111', tag: 'type:state', body: '测试工作区，正在进行实验。' },
    { anchor: 'mem_bbbb2222', tag: 'type:progress', body: '继续推进测试。' },
  ]
  const blocks = secs.map((s, i) => [
    `## ${['当前状态', '待办', '约束', '备注'][i] || '小节' + (i + 1)}`,
    `<!-- memory:${s.anchor} -->`,
    s.tag || '',
    s.body || '',
  ].filter(Boolean).join('\n'))
  return `# ${title}\n\n` + blocks.join('\n\n') + '\n'
}

/**
 * 把夹具写进沙箱记忆库。
 * @param {string} cwd            会话工作目录
 * @param {object} fixture
 * @param {Array}  [fixture.events]   预置事件
 * @param {string} [fixture.plan]     白板全文（不给则不写）
 * @param {Array}  [fixture.handoffs] 预置账本 [{date:'20261020', text}]
 */
export function seedWorkspace(cwd, fixture = {}) {
  const dir = projectDirOf(cwd)
  const hd = path.join(dir, 'handoff')
  fs.mkdirSync(hd, { recursive: true })

  if (fixture.plan !== undefined) {
    fs.writeFileSync(path.join(hd, 'PLAN.md'), fixture.plan, 'utf8')
  }
  if (fixture.events !== undefined) {
    fs.writeFileSync(
      path.join(hd, 'event-store.json'),
      JSON.stringify({ version: 1, events: fixture.events }, null, 2),
      'utf8',
    )
  }
  for (const h of (fixture.handoffs || [])) {
    fs.writeFileSync(path.join(hd, `handoff-${h.date}-000000.md`), h.text, 'utf8')
  }
  return dir
}

/**
 * 「已有活跃事件」世界的标准夹具。
 *
 * 用途：测接续仪式「找得到事件」这条路径 —— 这是产品的真实缺陷区
 * （实测 hasEvent 世界完成率只有 15%，而空库 92%）。
 */
export function fixtureWithEvents(cwd) {
  const now = Date.now()
  return seedWorkspace(cwd, {
    plan: makePlan(),
    events: [
      makeEvent({ id: 'evt_act11111', name: '正在做的这件事', status: 'active', updatedAt: now - 3600e3, createdAt: now - 3600e3 }),
      makeEvent({ id: 'evt_old22222', name: '上周已经做完的旧事', status: 'closed', outcome: '已完成', updatedAt: now - 7 * 864e5, createdAt: now - 7 * 864e5, endMs: now - 864e5 }),
      makeEvent({ id: 'evt_act33333', name: '另一件也在进行的事', status: 'active', updatedAt: now - 1800e3, createdAt: now - 1800e3 }),
    ],
  })
}

/** 「空库」世界：测「查不到事件」这条路径 */
export function fixtureEmpty(cwd) {
  return seedWorkspace(cwd, { plan: makePlan(), events: [] })
}

/** 单个活跃事件的世界（最容易的路径，用于对照） */
export function fixtureSingleEvent(cwd) {
  return seedWorkspace(cwd, {
    plan: makePlan(),
    events: [makeEvent({ id: 'evt_single01', name: '唯一在做的这件事', status: 'active' })],
  })
}
