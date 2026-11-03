// 全量记忆操作语料：覆盖用户点名的四类 + 其他关键记忆面
//
// 设计原则（与首轮 handoff-only 实验的区别）：
//   ① 每个场景给出**真实会触发该记忆操作**的对话素材，而不是干巴巴的指令
//   ② 场景本身包含「该不该记」的判断点（有的素材明确不该记，测误报）
//   ③ 判分不只看「有没有写」，还看**写对没写对**（字段/枚举/语义）
//
// 用户点名的四类：
//   1 共同记忆（sharedGround / episode）
//   2 共识性记忆（sharedGround）
//   3 情感记忆（userPercept / commitment / 共同经历）
//   4 Calendar（日历）

export const SCENARIOS = [
  // ══════════ 场景 1：共同经历 / 共识（用户点名 ①②）══════════
  {
    id: 'sg-strong',
    family: 'sharedGround',
    label: '双方明确拍板同一结论（强共识信号）',
    expect: { shouldWrite: 'sharedGround', minCount: 1 },
    text: `以下是一段真实的对话：

用户：「我们试了两个方案：方案 A 是把判据门放在写入前，方案 B 是写完再校验。你觉得哪个对？」
助手：「B 会留下半渡态，A 更干净。」
用户：「对，就用 A。定了，不用再讨论。」
助手：「好，按 A 落。」

请把这段对话里的记忆价值写进项目记忆：
- 如果产生了「双方真正对齐的结论」，用 memory_note(kind="handoff") 的 sharedGround 参数记下来（形状 {claim, confirmedBy, correction}）；
- 如果只是一方陈述、没有对方确认，就不要写 sharedGround。

账本文本用 memory_note 写入即可。完成后回复一句你写了什么。`,
  },
  {
    id: 'sg-weak',
    family: 'sharedGround',
    label: '只有单向陈述（不该写 sharedGround，测误报）',
    expect: { shouldWrite: 'none', reason: '用户只单向陈述，没有双方对齐' },
    text: `以下是一段真实的对话：

用户：「我觉得判据门放在写入前会更好。」
助手：「明白，我记一下。」

请把这段对话里的记忆价值写进项目记忆，用 memory_note(kind="handoff")。

重要判据：sharedGround 只在**双方真的对齐**时写（对方确认/拍板）。单向陈述不算共识。
如果这里没有真正的共识，就不要为了填满而编造 sharedGround。

完成后回复一句你写了什么、为什么这么判断。`,
  },

  // ══════════ 场景 2：用户画像 / 人类侧观察（用户点名 ③）══════════
  {
    id: 'up-preference',
    family: 'userPercept',
    label: '用户给出明确偏好（应写 userPercept, kind=preference）',
    expect: { shouldWrite: 'userPercept', kind: 'preference' },
    text: `以下是一段真实的对话：

用户：「以后写报告别用「赋能」「抓手」这类词，我看着难受，直接说人话。」
助手：「明白，之后都避开这类词。」

请把这段对话里的记忆价值写进项目记忆，用 memory_note(kind="handoff")：
- 用户明确表态偏好时，用 userPercept 参数记下来（形状 {stage, kind, text}）；
- stage 只能取 retrieved/delivered/used/mentioned/accepted 之一；
- kind 取 preference/state/unfinished-goal/authorResponse 之一；
- 只有 accepted/used 会进用户画像注入段，其余是噪声。

完成后回复一句你写了什么。`,
  },
  {
    id: 'up-correction',
    family: 'userPercept',
    label: '用户纠正（应写 authorResponse 类型的 userPercept）',
    expect: { shouldWrite: 'userPercept', kind: 'authorResponse' },
    text: `以下是一段真实的对话：

助手：「我已经把提示词从 1149 字符精简到 200 字符了，token 成本应该降了不少。」
用户：「等等，你搞错了——精简提示词并不省 token，实测反而多 4.6%。别把这条当成收益写进去。」
助手：「你说得对，我更正。」

请把这段对话里的记忆价值写进项目记忆，用 memory_note(kind="handoff")。
用户在这里**纠正了一个错误结论**，这类「作者回应」应当被记住。

完成后回复一句你写了什么。`,
  },
  {
    id: 'up-chitchat',
    family: 'userPercept',
    label: '寒暄（不该写任何感知，测误报）',
    expect: { shouldWrite: 'none', reason: '闲聊无实质内容' },
    text: `以下是一段真实的对话：

用户：「早啊，今天天气不错。」
助手：「早上好。」
用户：「嗯，先这样。」

请把这段对话里的记忆价值写进项目记忆，用 memory_note(kind="handoff")。

判据：只有**实质性进展**才写感知（新结论/验收结果/交付物落盘/用户新裁定）。
纯寒暄、纯等待、重复确认都不写。如果这段对话没有值得记的，就不要编。

完成后回复一句你写了什么、为什么。`,
  },

  // ══════════ 场景 3：承诺 / 约定（用户点名 ③ 情感面）══════════
  {
    id: 'cm-promise',
    family: 'commitment',
    label: '助手明确承诺（应写 commitment, state=open）',
    expect: { shouldWrite: 'commitment', state: 'open' },
    text: `以下是一段真实的对话：

用户：「这批实验跑完之前，别动 lib/ 下的任何产品代码。」
助手：「好，我答应你：本轮到实验结束都不碰 lib/ 下的文件，只写实验区的脚本。」
用户：「行。」

请把这段对话里的记忆价值写进项目记忆，用 memory_note(kind="handoff")：
- 助手**真的答应过**的事，用 commitment 参数记下来（形状 {promise, boundary, state}）；
- state 取 open/kept/dropped；
- 计划或意图不算承诺，只有明确答应才算。

完成后回复一句你写了什么。`,
  },
  {
    id: 'cm-intent',
    family: 'commitment',
    label: '只是计划/意图（不该写 commitment，测误报）',
    expect: { shouldWrite: 'none', reason: '助手只表达意图，没有对用户做出承诺' },
    text: `以下是一段真实的对话：

用户：「接下来做什么？」
助手：「我打算先看看日志，然后可能重构一下解析器。」
用户：「好。」

请把这段对话里的记忆价值写进项目记忆，用 memory_note(kind="handoff")。

判据：commitment 只记**你真的答应过用户的事**。计划、意图、可能要做的事都不算。
如果这里没有真正的承诺，就不要为了填满而编造。

完成后回复一句你写了什么、为什么这么判断。`,
  },

  // ══════════ 场景 4：Calendar（用户点名 ④）══════════
  {
    id: 'cal-explicit',
    family: 'calendar',
    label: '明确的 deadline（应写 calendar_add）',
    expect: { shouldWrite: 'calendar', date: '2026-11-05' },
    text: `以下是一段真实的对话：

用户：「下周四 2026-11-05 下午 3 点要做一次中期答辩，你帮我记一下。」
助手：「好的。」

请把这件事记入日历：调用 calendar_add，参数包括 date、time、title、quadrant、note。
参考象限：重要紧急 / 重要不紧急 / 紧急不重要 / 不重要不紧急 / 未分类。

完成后回复一句你记了什么。`,
  },
  {
    id: 'cal-relative',
    family: 'calendar',
    label: '相对时间（应换算成具体日期）',
    expect: { shouldWrite: 'calendar', note: '需要把「明天」换算成日期' },
    text: `以下是一段真实的对话：

用户：「明天上午十点要跟导师开个短会，别让我忘了。」
助手：「好的。」

今天是 2026-10-29。

请把这件事记入日历：调用 calendar_add，参数包括 date、time、title、quadrant、note。
★「明天」必须换算成具体日期（2026-10-30），不能原样写「明天」。

完成后回复一句你记了什么。`,
  },
  {
    id: 'cal-none',
    family: 'calendar',
    label: '无任何时间信息（不该写 calendar，测误报）',
    expect: { shouldWrite: 'none', reason: '没有日期/时刻/deadline，不该进日历' },
    text: `以下是一段真实的对话：

用户：「那个解析器的重构做得不错。」
助手：「谢谢，我也觉得思路挺清晰的。」

请把这段对话里的记忆价值写进项目记忆。如果适合记入日历，就调 calendar_add；如果不适合，就不要调用。

判据：日历只记有**明确时间点/期限/约定时间**的事。没有时间信息的内容不属于日历。

完成后回复一句你做了什么、为什么。`,
  },

  // ══════════ 场景 5：事件归属（关键：宁建勿挂）══════════
  {
    id: 'ev-append',
    family: 'event',
    label: '延续既有事件（应 append 到指定 eventId）',
    expect: { shouldWrite: 'event_append' },
    setup: 'event',
    text: `工作区里已有一个事件：eventId=evt_abc12345，名称「记忆工具校验契约改造」，状态 active。

以下是本轮进展：
把判据门的拒绝文案从「只说期望」改成「对比实际 vs 期望」，实测模型一次改对率从 0/5 提到 5/5。

请把这轮进展记进事件：用 memory_event(action="append", eventId="evt_abc12345", checkpoint={...})。
检查点必须带四段：goal/state/dead/next（只有 text 会被判流水账）。

完成后回复一句你写了什么。`,
  },
  {
    id: 'ev-create',
    family: 'event',
    label: '新方向（应 create 而非挂到旧事件）',
    expect: { shouldWrite: 'event_create' },
    setup: 'event',
    text: `工作区里已有一个事件：eventId=evt_abc12345，名称「记忆工具校验契约改造」，状态 active。

以下是本轮做的事：
把 CI 从 GitHub Actions 迁到自建 runner，配好了缓存与并发。

请把这轮工作记进记忆。
判据：**宁建勿挂** —— 对得上现有事件才 append，对不上就 memory_event(action="create")。
挂错会污染历史边界。

完成后回复一句你怎么判断的、做了什么。`,
  },

  // ══════════ 场景 6：日志与反思（基础但不该漏）══════════
  {
    id: 'log-basic',
    family: 'log',
    label: '实质性工作（应写 memory_log）',
    expect: { shouldWrite: 'log' },
    text: `以下是本轮实际做的事：
1. 修了注入档位的 post_compact 断链，实测三档真机可达；
2. 跑了全量回归 531 项，全绿；
3. 更新了设计文档第 9 节。

请把本轮工作记进今日日志：调用 memory_log，note 写清做了什么。

完成后回复一句写了什么。`,
  },
  {
    id: 'log-kind',
    family: 'log',
    label: '用户约束（kind 应选 rule 而不是 fact）',
    expect: { shouldWrite: 'log', kind: 'rule' },
    text: `以下是本轮发生的事：
用户明确要求：「以后所有实验都不许用官方 API key，只用自建的兼容端点。」

请把这件事记进今日日志：调用 memory_log。
★kind 要按性质选：rule=用户约束/约定、preference=偏好、fact=事实、todo=待办。

完成后回复一句你选了哪个 kind、为什么。`,
  },

  // ══════════ 场景 7：技能库（procedure）══════════
  {
    id: 'proc-new',
    family: 'procedure',
    label: '跑通了可复用流程（应写 memory_procedure）',
    expect: { shouldWrite: 'procedure' },
    text: `以下是本轮跑通的流程（下次遇到同类场景会想照做）：
给一个 dsh 插件建最小实验 profile 的步骤：
1. 在 profiles/<name>/package.json 写 dependencies + dsh.profile.bundles；
2. 写 pnpm-workspace.yaml（nodeLinker: hoisted）；
3. pnpm install；
4. 若插件声明了 webServer 依赖而 headless 不提供，在 cordis.patch.yml 补一行 host-webserver；
5. 用 dsh --profile <name> --dump-config 确认插件进了树。

请把这个流程记进技能库：memory_procedure(action="write", title=..., steps=[...], successCriteria=...)。

完成后回复一句你写了什么。`,
  },
]
