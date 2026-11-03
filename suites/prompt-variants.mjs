/**
 * 提示词变体 —— 实验的自变量集中在这里，一处定义、全域复用。
 *
 * 旧实现为每个变量复制一份 199 行的套件脚本（三份近似副本），
 * 改一处要改三处，且很容易只改了其中两份 —— 那会让「控制变量」失效。
 *
 * ★ 唯一能通过配置改动的层是 `snapshotSlimMaintain`。
 *   `renderMemoryStatic()`（6,220 字符，含四段规则/四类感知/技能库/看板 tag）
 *   是**硬编码**的，promptLayerOverrides 改不到它 ⇒ 想测「精简静态纪律」
 *   必须先改产品代码。这是本套件的已知盲区，报告里必须声明。
 *
 * ★ 实测结论（用本套件的 default / slim / tiny / noinject 四档跑出来的）：
 *   四档全部 100% 通过 ⇒ 提示词对「合规率」的影响远小于预期；
 *   决定遵循能力的是**工具 schema**。同时 token 成本不变（变化落在采样噪声内）。
 */

/** V0 完整款（= 产品默认值全文，1,149 字符） */
export const V0_FULL = `[记忆结构 · 先读懂再动手] 你的记忆是**以事件为中心**的：一个「事件」= 一件事，跨天也算同一件（可中断再捡起）。事件里有：**name/summary**（L0 总览，你写）、**sections{goal,doing,deadend,next}**（四段，反映**当前**状态不是历史累积）、**checkpoints[]**（每次进展一条，一个检查点=一个证据点）。白板 PLAN.md **不是手写的**，它是**事件渲染出来的投影**——你改事件，白板自己会变；不要去手写白板正文。 [注入的这些段是什么意思] 你看到的「当前事件」段/事件卡片 = 从事件库渲染的**情境**（正在做什么）；「用户画像」段 = 对人的印象（他是什么样、在意什么）；「用户规约」段 = 必须遵守的硬约束；白板段 = 事件的投影视图。**它们都是同一份事件数据的不同视角**，不是四份互不相干的记忆。 [接下来的记忆怎么写] ① 开工先判归属：对得上现有事件带 eventId，对不上 memory_event(action=create)（**宁建勿挂**，挂错污染历史边界）；② 写检查点**必填四段** goal/state/dead/next（只有 text 会被判流水账；dead 无则空串，别写「无」）；③ 写检查点**必带溯源** quoteRef（这条结论的原话）/ quoteLine（源文件行号）/ rel（文件路径）/ bytes + sha256（文件指纹）—— 没有溯源的检查点等于无法审计的传闻；④ 每次变动后**重写事件四段**（sections 用 memory_event action=set），否则四段变陈年快照；⑤ 事件收口用 close（带 outcome）。 [底线] 多步任务前先 memory_procedure_list 查技能库；有实质产出 → 写事件检查点；需要历史 → memory_recall(scope="events")；查某件事全经过用 memory_recall。 memory_log 写今日日志；memory_note 写项目笔记/账本/白板；需历史与召回用 memory_recall；跑通新流程写 memory_procedure；事件索引看 memory_recall(scope="events")；查状态用 memory_status。 七项底线计数：这七项是底线。事件动作四选一写全：create/append/set/close。事件的 name/summary 是 L0 总览，要按时重写。事件只是索引。 分工：事件只是**索引**，原文载体仍是 memory_note(kind=handoff)，两者都要写。`

/** V1 最小集（127 字符）—— 实测「一次写对率」从 0/5 提到 5/5 */
export const V1_MIN = `[记忆结构] 记忆以事件为中心。写记忆用 memory_* 工具。交接账本用 memory_note(kind=handoff)，标题必须逐字为 ## 任务状态 / ## 目标 / ## 已试方案与失败原因 / ## 进度与下一步，每段至少 20 字符。`

/** V2 = V1 + 明确禁止标题加后缀（针对最常见的污染形态） */
export const V2_NOSUFFIX = `[记忆结构] 记忆以事件为中心。写记忆用 memory_* 工具。交接账本用 memory_note(kind=handoff)，标题必须逐字为 ## 任务状态 / ## 目标 / ## 已试方案与失败原因 / ## 进度与下一步。★标题行只写这四个词，**不要在标题后加任何后缀**（不要写 （type:state） 这类标记——type 标记只能写在标题下面的正文行）。每段至少 20 字符。`

/** V3 极简（45 字符）—— 极限对照 */
export const V3_TINY = `记忆用 memory_* 工具。交接账本格式见 memory_note 的 schema。`

/** V4 = V2 + 指向回执（测「提示词 + 回执」协同） */
export const V4_WITH_RECEIPT = `[记忆结构] 记忆以事件为中心。写记忆用 memory_* 工具。交接账本用 memory_note(kind=handoff)。★标题行必须逐字为 ## 任务状态 / ## 目标 / ## 已试方案与失败原因 / ## 进度与下一步，只写这四个词，**不要加任何后缀**。每段至少 20 字符。若写入被拒绝，请仔细阅读回执里的具体差异并按其修正后重试。`

export const PROMPT_TEXTS = {
  V0: V0_FULL,
  V1: V1_MIN,
  V2: V2_NOSUFFIX,
  V3: V3_TINY,
  V4: V4_WITH_RECEIPT,
}

/**
 * 命令行变体 → 配置补丁
 *
 * ═══ 纪律：补丁只写「本变体要改的键」，未提及的键由 runner 的 BASELINE_CFG 补齐 ═══
 * 这样每个变体的意图一眼可见，也不会因为漏写某个键而沿用上次实验的残留。
 *
 * ═══ 为什么不再写 snapshotMinGapRounds: 0 ═══
 * 所有变体曾统一钉 `snapshotMinGapRounds: 0`，理由是「排除无关变量」。
 * 但 0 = **每轮都发完整版** ⇒ 精简版分支永不触发 ⇒
 * `snapshotSlimMaintain` **根本不渲染** ⇒ 下面 slim / tiny / nosuffix / receipt
 * 四个变体改的那一层**从来没进过模型上下文**，而报告显示「变体已应用、全部通过」。
 *
 * 实测（2026-11-03，同一多步任务）：
 *   gap=0  → 覆盖标记不进上下文，精简版证据（[记忆检索指引]）完全缺席
 *   gap=20 → 覆盖标记进上下文，精简版出现
 *
 * ⇒ 现在统一走产品默认 20，精简版可达，这些变体才是真的在测「精简版措辞」。
 */
export const PROMPT_VARIANTS = {
  default: {
    label: '产品默认（1,149 字符）',
    cfg: { promptLayerOverrides: {} },
  },
  slim: {
    label: 'V1 最小集（127 字符）',
    cfg: { promptLayerOverrides: { snapshotSlimMaintain: V1_MIN } },
  },
  tiny: {
    label: 'V3 极简（45 字符）',
    cfg: { promptLayerOverrides: { snapshotSlimMaintain: V3_TINY } },
  },
  noinject: {
    label: '关掉记忆注入（极限对照）',
    cfg: { promptLayerOverrides: {}, injectEnabled: false },
  },
  nosuffix: {
    label: 'V2 最小集+禁后缀（198 字符）',
    cfg: { promptLayerOverrides: { snapshotSlimMaintain: V2_NOSUFFIX } },
  },
  receipt: {
    label: 'V4 V2+指向回执（177 字符）',
    cfg: { promptLayerOverrides: { snapshotSlimMaintain: V4_WITH_RECEIPT } },
  },
}

if (process.argv[1] && process.argv[1].endsWith('prompt-variants.mjs')) {
  for (const [k, v] of Object.entries(PROMPT_TEXTS)) {
    console.log(String(v.length).padStart(5), k, '-', v.slice(0, 40) + '…')
  }
}
