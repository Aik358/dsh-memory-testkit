// 子实验 4 · 接续前刷新仪式的提示词版本
//
// 为什么单独做：这是插件里**唯一**「一次性让模型连做 4–5 个记忆操作」的提示词，
// 它同时承担事件归属 + 白板刷新 + 账本撰写三件事，且有时间预算（默认 120 秒）。
// 它已暴露的缺陷全部来自「步骤之间的依赖关系没写清」，不是措辞问题。
//
// 已确认的 4 处缺陷（读 lib/index.js:7111-7114 原文得出）：
//   F1 顺序死锁：第 0 步说「查不到事件就在**第 2 步之后**补 create」，
//      但第 2 步要求「账本首行必须写 eventId=<第 0 步拿到的 id>」
//      ⇒ 查不到时第 0 步拿不到 id，账本无从写，而 create 却排在账本之后。**逻辑不可执行**。
//   F2 自相矛盾：末句「不要在调用其他工具」，但 F1 要求在账本之后补一次 create。
//   F3 revision 歧义：memory_read(kind=plan) 返回含多个 revision（plan 本体 + 每张卡各一个），
//      提示词没说该填哪个。
//   F4 第 0 步无法唯一命中：memory_recall(scope=events) 可能返回多个事件，
//      其中还有已 closed 的，提示词没给选择判据。

/** R0 现款原文（从源码抽取，未改一字） */
export const R0 = [
  '[接续前刷新仪式] 即将把本会话交接给新会话。请在本轮内只做下面三件事,不要执行其他操作、不要推进任务:',
  '0. ★【先确认事件归属】调用 memory_recall(scope="events", query="<本会话正在做的事的关键词>") 查回本会话对应的事件；若确有对应事件，记下它的 eventId —— 第 2 步的账本必须写上这个 eventId。若查不到任何对应事件，就在第 2 步之后补一次 memory_event(action="create", name=<一句话事件名>, summary=<一段话总览>)，并把新 eventId 写进账本。**不要跳过这一步**（跳过会导致同一件事在新会话被建成第二个事件）。',
  '1. 先 memory_read(kind=plan) 取得当前版本，再调用 memory_note(kind=plan, expectedRevision=所读revision, content=<项目白板的最新完整全貌:项目全貌/当前目标/下一步,旧版会自动归档>) 重写 PLAN.md;',
  '2. 调用 memory_note(kind=handoff, content=<四段式交接账本:## 任务状态 / ## 目标 / ## 已试方案与失败原因 / ## 进度与下一步,每段≤5行,下一步必须是可以直接执行的第一步,带文件路径或命令；**账本首行必须写 eventId=<第0步拿到的事件 id>**，它是新会话认领这件事的唯一凭据>) 写一篇新账本。',
  '完成后只回复一句「已刷新」,不要再调用其他工具。',
].join('\n')

/** R1 修死锁：把 create 挪到第 2 步之前，且第 0 步变成三路分支（每路都保证有 id） */
export const R1 = [
  '[接续前刷新仪式] 即将把本会话交接给新会话。只做下面的准备动作，不推进任务本身。',
  '第 0 步 · 确定事件（必须先完成，后面两步都依赖它的结果）：',
  '  调 memory_recall(scope="events", query="<本会话正在做的事的关键词>")。',
  '  · 命中 1 个 active 事件 → 用它，记下 eventId。',
  '  · 命中多个 → 只选 status=active 且 updatedAt 最新的那个；若都是 closed，走下一行。',
  '  · 一个可用的都没有 → 立刻 memory_event(action="create", name=<一句话事件名>, summary=<一段话总览>) 建新事件，用回执里的 eventId。',
  '  ★这一步行完必须手里有一个具体 eventId，否则停下并回复「事件确定失败」。',
  '第 1 步 · 刷新白板：先 memory_read(kind=plan)，记下回执**最外层**那一个 revision（不是卡片里的 revision），',
  '  再 memory_note(kind=plan, expectedRevision=<那个 revision>, content=<白板最新完整全貌>) 重写。',
  '第 2 步 · 写账本：memory_note(kind=handoff, content=<四段式账本：## 任务状态 / ## 目标 / ## 已试方案与失败原因 / ## 进度与下一步，每段 ≤5 行；',
  '  账本首行写 eventId=<第 0 步确定的那个 id>>)。',
  '三步都做完后，回复一句「已刷新」。',
].join('\n')

/** R2 = R1 + 给「选事件」的完整判据（含 closed 排除、多命中时的二选一规则） */
export const R2 = R1.replace(
  '  · 命中多个 → 只选 status=active 且 updatedAt 最新的那个；若都是 closed，走下一行。',
  '  · 命中多个 → 按序筛选：①只留 status=active 的；②只留 updatedAt 在最近 7 天内的；'
  + '③仍多于 1 个就选 updatedAt 最新的那个，并在账本里注明被排除的同名事件。若筛完为空，说明这件事确实没有活跃事件，走下一行建新的。'
).replace(
  '  · 命中 1 个 active 事件 → 用它，记下 eventId。',
  '  · 命中 1 个 active 事件 → 用它，记下 eventId（若该事件 status=closed，不能 append，必须新建）。'
)

/** R3 = R2 + 明确 revision 取法与冲突处理 */
export const R3 = R2.replace(
  '  再 memory_note(kind=plan, expectedRevision=<那个 revision>, content=<白板最新完整全貌>) 重写。',
  '  再 memory_note(kind=plan, expectedRevision=<那个 revision>, content=<白板最新完整全貌>) 重写。'
  + '若返回 revision 冲突：重新 memory_read 取最新 revision 后再写一次，最多重试 1 次；仍冲突就跳过白板、继续第 2 步（白板失败不阻塞交接）。'
)

export const RITUAL_VERSIONS = {
  R0_current: { label: 'R0 现款（有死锁）', text: R0 },
  R1_nolock: { label: 'R1 修死锁（三路分支）', text: R1 },
  R2_criteria: { label: 'R2 +选事件判据', text: R2 },
  R3_revision: { label: 'R3 +revision 取法', text: R3 },
}

if (process.argv[1] && process.argv[1].endsWith('ritual-prompts.mjs')) {
  for (const [k, v] of Object.entries(RITUAL_VERSIONS)) {
    console.log(String(v.text.length).padStart(5), k, '-', v.label)
  }
}
