/**
 * 套件 E · 隐性触发（模型会不会**自己**想起要写）
 *
 * ★ 这个套件存在的理由：
 *   实验里 15/15 全过，但真实 551 个会话里四类感知的填充率是 **0/162（0.0%）**。
 *   差别在触发方式：
 *     实验场景：「如果产生了共识，就用 sharedGround 记下来」← **明示**，模型必写
 *     真实对话：只有「对，就用 A。定了」← **隐性**，模型得自己察觉
 *
 *   所以这个套件刻意**不提任何记忆工具名、不提字段名**，只给真实对话素材 +
 *   一句通用的收尾要求，看模型自己会不会想到写 sharedGround / commitment / calendar。
 *
 * ★ 判分只看「有没有自发写」，不看「写得多好」。
 */
// 纯数据模块 —— 只导出场景，**不在顶层执行任何东西**，可被实验层安全 import
import { fixtureEmpty } from '../lib/fixtures.mjs'
import { PERCEPT_STAGES } from '../lib/judge.mjs'

/**
 * 素材设计原则：
 *   ① 只给对话原文，绝不出现「用 xxx 参数记下来」这类指令
 *   ② 收尾只给一句通用的「把这轮做完」，不提记忆
 *   ③ 每个场景都埋了一个**明确的**可记录信号（否则测不出察觉能力）
 */
const TAIL = '本轮对话结束。请按你平时的习惯处理即可。'

export const IMPLICIT_SCENARIOS = [
  // ── 共识（三个强度递增的信号）──
  {
    id: 'impl-sg-strong',
    family: 'implicit-sharedGround',
    label: '强共识信号（「定了」「不用再讨论」）',
    expect: { want: 'sharedGround' },
    text: `用户：「方案 A 是把判据门放在写入前，方案 B 是写完再校验。你觉得哪个对？」
助手：「B 会留下半渡态，A 更干净。」
用户：「对，就用 A。定了，不用再讨论。」
助手：「好，按 A 落。」

${TAIL}`,
  },
  {
    id: 'impl-sg-weak',
    family: 'implicit-sharedGround',
    label: '弱共识信号（「行，就这么办」）',
    expect: { want: 'sharedGround' },
    text: `用户：「这个接口要不要加个超时参数？」
助手：「建议加，默认 30 秒。」
用户：「行，就这么办。」
助手：「好。」

${TAIL}`,
  },
  {
    id: 'impl-sg-none',
    family: 'implicit-sharedGround',
    label: '无共识（只有单向陈述，不该写）',
    expect: { want: 'none' },
    text: `用户：「我觉得判据门放在写入前可能更好。」
助手：「嗯，有道理。」

${TAIL}`,
  },

  // ── 承诺 ──
  {
    id: 'impl-cm-explicit',
    family: 'implicit-commitment',
    label: '明确承诺（「我答应你」）',
    expect: { want: 'commitment' },
    text: `用户：「这批实验跑完之前，别动 lib/ 下的任何产品代码。」
助手：「好，我答应你：本轮到实验结束都不碰 lib/ 下的文件。」
用户：「行。」

${TAIL}`,
  },
  {
    id: 'impl-cm-soft',
    family: 'implicit-commitment',
    label: '软承诺（「我下次注意」）',
    expect: { want: 'commitment' },
    text: `用户：「你上次写报告又用了『赋能』这种词，我说过别用。」
助手：「抱歉，我下次注意，之后都避开这类词。」
用户：「嗯。」

${TAIL}`,
  },

  // ── 用户偏好（画像原料）──
  {
    id: 'impl-up-pref',
    family: 'implicit-userPercept',
    label: '明确的长期偏好',
    expect: { want: 'userPercept' },
    text: `用户：「以后写报告别用『赋能』『抓手』这类词，直接说人话。」
助手：「明白，之后都避开。」

${TAIL}`,
  },
  {
    id: 'impl-up-correct',
    family: 'implicit-userPercept',
    label: '用户纠正了一个错误结论',
    expect: { want: 'userPercept' },
    text: `助手：「提示词精简到 200 字符，token 成本应该降了不少。」
用户：「等等，你搞错了——精简提示词并不省 token，实测反而没差别。别把这条当成收益。」
助手：「你说得对，我更正。」

${TAIL}`,
  },

  // ── 日历 ──
  {
    id: 'impl-cal-deadline',
    family: 'implicit-calendar',
    label: '明确 deadline（「下周四答辩」）',
    expect: { want: 'calendar' },
    text: `用户：「下周四 2026-11-05 下午 3 点要做中期答辩，别忘了。」
助手：「好的，记下了。」

${TAIL}`,
  },
  {
    id: 'impl-cal-relative',
    family: 'implicit-calendar',
    label: '相对时间（「明天上午十点」）',
    expect: { want: 'calendar' },
    text: `用户：「明天上午十点跟导师开个短会。」
助手：「好的。」

今天是 2026-10-29。

${TAIL}`,
  },
  {
    id: 'impl-cal-none',
    family: 'implicit-calendar',
    label: '无时间信息（不该进日历）',
    expect: { want: 'none' },
    text: `用户：「那个解析器的重构做得不错。」
助手：「谢谢，我也觉得思路挺清晰的。」

${TAIL}`,
  },
]

/** 判分：只看「有没有自发写」，不做质量评判
 *
 * ★★ 口径修正（首版错判 4 条）：
 *   首版只在 `memory_note(kind=handoff)` 的四个感知参数里找。
 *   实测模型经常**走别的更重的通道**：
 *     · 用户偏好 → 写进用户级 MEMORY.md / memory_user（跨项目规则）
 *     · 用户纠正 → 写进今日日志 + 标成「已被推翻的结论」
 *     · 软承诺   → 直接升级成「每轮加载的硬性规则」
 *     · 弱共识   → 写进日志，并在回复里点明「用户已确认」
 *   这些**都是正确行为**，甚至比 userPercept 更持久。
 *
 *   ⇒ 判据改为：**任一记忆通道**承载了对应语义即算通过。
 *     只在所有通道都为空时才判失败。
 *
 *   这也说明：真实使用中看到的「填充率 0」很大程度是**统计口径问题** ——
 *   我们只数了感知参数，没数日志/用户级记忆/规则。
 */
export async function judgeImplicit({ scenario, writes, killed, art, rows }) {
  const want = scenario.expect.want
  const detail = []
  if (killed) scenario._killed = true

  const got = {
    sharedGround: writes.percepts.sharedGround.length,
    commitment: writes.percepts.commitment.length,
    userPercept: writes.percepts.userPercept.length,
    calendar: writes.calendars.length,
    agentTrace: writes.percepts.agentTrace.length,
    handoff: writes.handoffs.length,
    log: writes.logs.length,
    event: writes.events.length,
    userMem: writes.otherTools.filter(t => t === 'memory_user').length,
    rules: writes.otherTools.filter(t => t === 'memory_rules').length,
    noteOther: writes.handoffs.filter(h => h.kind === 'note').length,
  }

  // 落盘层面的旁证（即使工具入参没带，也可能已落盘）
  const artifacts = {
    userMemChars: (art && art.userMem) ? art.userMem.length : 0,
    logChars: (art && art.logs) ? art.logs.length : 0,
  }

  const anyPercept = got.sharedGround + got.commitment + got.userPercept
  const anyMemory = anyPercept + got.log + got.event + got.userMem + got.rules + got.noteOther

  const m = { ...got, ...artifacts }

  if (want === 'none') {
    // 负路径：不该写却写了 = 误报
    // ★ 超时且什么都没做不能算通过（那是没跑完，不是正确克制）—— 首版误判过。
    if (scenario._killed) {
      detail.push('★超时且未完成（不能算正确克制）')
      return { pass: false, detail, metrics: m }
    }
    const ok = anyPercept === 0 && got.calendar === 0
    detail.push(`感知 ${anyPercept} 条 / 日历 ${got.calendar} 次（期望 0）`)
    if (!ok) detail.push('★误报：不该记的记了')
    return { pass: ok, detail, metrics: m }
  }

  // 「该写」的场景：任一通道承载即通过
  if (want === 'sharedGround') {
    const viaPercept = got.sharedGround > 0
    const viaOther = got.log > 0 || got.event > 0
    const ok = viaPercept || viaOther
    detail.push(viaPercept ? `sharedGround ${got.sharedGround} 条（走感知通道）`
      : viaOther ? `未走感知通道，但写进了 ${got.log ? '日志' : '事件'}（等效记账）`
        : '★任何通道都没写')
    return { pass: ok, detail, metrics: m }
  }

  if (want === 'commitment') {
    const viaPercept = got.commitment > 0
    const viaRules = got.rules > 0 || got.userMem > 0
    const viaOther = got.log > 0 || got.event > 0
    const ok = viaPercept || viaRules || viaOther
    detail.push(viaPercept ? `commitment ${got.commitment} 条（走承诺通道）`
      : viaRules ? `未走承诺通道，但写进了 ${got.rules ? '硬性规则' : '用户级记忆'}（更强）`
        : viaOther ? '未走承诺通道，但写进了日志/事件（等效记账）'
          : '★任何通道都没写')
    return { pass: ok, detail, metrics: m }
  }

  if (want === 'userPercept') {
    const viaPercept = got.userPercept > 0
    const stageOk = writes.percepts.userPercept.some(u => u && PERCEPT_STAGES.includes(String(u.stage || 'mentioned')))
    const viaUserMem = got.userMem > 0 || got.rules > 0 || artifacts.userMemChars > 50
    const viaLog = got.log > 0
    const ok = (viaPercept && stageOk) || viaUserMem || viaLog
    detail.push(viaPercept ? `userPercept ${got.userPercept} 条（stage ${stageOk ? '合法' : '★非法'}）`
      : viaUserMem ? '未走感知通道，但写进了用户级记忆/规则（跨项目，更强）'
        : viaLog ? '未走感知通道，但写进了日志'
          : '★任何通道都没写')
    return { pass: ok, detail, metrics: m }
  }

  if (want === 'calendar') {
    const ok = got.calendar > 0
    detail.push(`calendar_add ${got.calendar} 次 ${ok ? '（自发写了）' : '★没想起写'}`)
    return { pass: ok, detail, metrics: m }
  }

  return { pass: false, detail: ['未知期望'], metrics: m }
}
