# 01 · 事件中心记忆架构（心智模型）

> 状态：✅ 有效
> 不读这份，后面所有讨论都会跑偏。

---

## 一、核心模型

```
事件（Event）            = 记忆的第一等单元
  一件事 = 一个事件容器，可中断再捡起，跨天也算同一件
  ├─ name / summary              = L0 总览（模型写）
  ├─ sections{goal, doing, deadend, next}
  │                               = 四段，反映「当前」状态，不是历史累积
  ├─ checkpoints[]                = 检查点，每次进展一条
  │    └─ goal/state/dead/next    = 检查点级四段
  └─ 四类感知
       ├─ userPercept  {stage,kind,text}            人类侧观察
       ├─ agentTrace   {action,result,wasRefuted}   我做了什么
       ├─ sharedGround {claim,confirmedBy,correction} 已达成的共识
       └─ commitments  {promise,boundary,state}     对用户的承诺

白板 PLAN.md   = 事件的【投影视图】，不手写
交接账本 .md   = 动态状态的权威原文载体（append-only）
每日日志       = 日记类，独立，不事件化
每日反思       = 日记类的蒸馏产物，独立

★ 真相源只有一个：事件。白板/账本/笔记都是投影。
```

## 二、为什么"事件"而不是"日志"

日志是线性的：一条一条，没有边界。
事件是有容器的：可以问"这件事做到哪了"，而不只是"那天发生了什么"。

这个区别决定了几件事：

| 能力 | 日志能满足 | 事件才能满足 |
|---|---|---|
| 跨天追踪同一件事 | ❌ | ✅ |
| 中断后捡起 | ❌ | ✅（四段反映当前状态） |
| 问"目标是什么" | ❌ | ✅（sections.goal） |
| 问"试过什么失败了" | 靠全文搜 | ✅（sections.deadend） |
| 用户画像 | ❌ | ✅（userPercept 聚合） |
| 共识沉淀 | ❌ | ✅（sharedGround） |

## 三、四段 vs 四类感知（最容易混的地方）

这是两套完全不同的东西：

| | 四段 | 四类感知 |
|---|---|---|
| 答什么问题 | **这件事到哪了**（工作状态） | **人/我/共识/承诺**（关系与情境） |
| 字段 | goal / doing / deadend / next | userPercept / agentTrace / sharedGround / commitments |
| 更新频率 | 每次变动重写 | 只在实质性进展时写 |
| 用途 | 跨窗口交接 | 用户画像、共识图谱 |
| 谁消费 | 白板、账本、注入面 | 画像注入段、问候、技能库 |

**两者互补，不互相复述。** 混在一起写会导致「四段里讲故事」「感知里写进度」。

## 四、真相源与投影的关系

```
          ┌─────────────┐
          │   事件库     │  ← 唯一真相源
          │ event-store │
          └──────┬──────┘
                 │ 渲染
     ┌───────────┼───────────┬──────────┐
     ↓           ↓           ↓          ↓
  PLAN.md   handoff-*.md  注入快照   面板看板
  （白板）    （账本）     （提示词）  （GUI）
```

**关键纪律**：改事件，投影会跟着变；**不要手写投影**。

但实测有个例外（见 `03-DEFECTS` D5）：`memory_note(kind=plan, fromEvents=true)` 这个自动渲染通路在某段时间里曾经是"零生产调用方"（渲染器写了但没接线）。当前版本已接上。

## 五、写入路径全景

```
模型调用
│
├─ memory_log            → 今日日志（流水账，append-only）
│                          结构上**无法**带四段或感知
│
├─ memory_note
│   ├─ kind=note         → 项目笔记 MEMORY.md
│   ├─ kind=handoff      → 交接账本（四段判据 H1-H4 把关）
│   │                       可同时带 4 个感知参数（★关键通道）
│   └─ kind=plan         → 白板（推荐 fromEvents=true 由事件渲染）
│
├─ memory_event
│   ├─ action=create     → 建事件
│   ├─ action=append     → 加检查点（可带 4 个感知参数）
│   ├─ action=set        → 改 name/summary/status/sections
│   ├─ action=close      → 收口（必须带 outcome）
│   └─ action=rename     → 改名
│
├─ calendar_add/done/remove → 用户级日历
│
├─ memory_procedure      → 技能库
├─ memory_user           → 用户级记忆
├─ memory_rules          → 用户级硬约束（条目级增删改）
└─ memory_reflect        → 每日反思
```

**WAL 半渡态**（已知缺陷，见 `03-DEFECTS`）：

```
memory_note(kind=handoff) 的执行顺序：
  Phase 1  appendHandoffCheckpointPre(...)   ← 先写事件，零内容校验
  Phase 2  writeHandoffLedger(...)           ← 再过判据门，不合格 ok:false
  Phase 3  失败 → 追加 kind='handoff-write-failed' 补偿检查点

后果：账本 .md 被拒（好），但坏内容已作为不可撤销的检查点留在事件库；
      每失败一次多两条（坏内容 + 补偿标记）。
真实数据：write-failed 补偿标记 = 3 条 ⇒ 半渡态真实发生过 3 次。
```

## 六、判据门（唯一真正的质量防线）

只有**账本**有强判据：

```js
// lib/wb-contract.js
H1  四段标题齐全且**逐字**匹配（缺一个就拒）
H2  每段 body 非空（≥1 非空行且合计 ≥20 字符）
H3  无占位符行（(待补充)/TODO/同上/略/N/A）
H4  总长 ≤ 8000 字符
S1-S4  软判据（各段 ≤5 行 / 有「方案→失败原因」箭头 / 下一步可执行 / 无临时信息）
```

**实测效果**：7 个坏账本里拒绝 6 个，且**不落盘**（H1–H4 任一失败即返回 `ok:false`）。

白板有最弱的判据（P-H1 至少一个非空 `##` 节 / P-H2 ≤ 200000 字符）。

**其余所有记忆面无判据** —— 详见 `06-EVIDENCE-校验姿态审计`。

## 七、注入分档（影响「模型看到什么」）

```
INJECT_TIERS 八档：
  human_full     用户发声 → 完整注入
  human_slim     用户发声 → 精简
  run_full       运行中   → 完整
  run_slim       运行中   → 最克制
  post_compact   压缩后重建
  handoff_carry  交接接续（会话首帧）
  hang_compensate 挂机代位补偿（默认关）
  legacy         未判定档位的回退（= 改前行为）
```

**实验控制杠杆**：

```
snapshotMinGapRounds: 0   → 节流关闭 → 每帧完整版
snapshotMinGapRounds: 20  → 默认节流 → 首帧精简版
```

## 八、提示词面的构成（为什么"精简"省不到 token）

```
27 个动态层（DEFAULT_PROMPT_LAYERS）  ← 可被 promptLayerOverrides 覆盖
  ├─ snapshotSlimMaintain   1,149 字符  ← 唯一承载四段规则的动态层
  ├─ snapshotInscription    1,330 字符
  └─ 其余 25 层             合计 < 1,500

renderMemoryStatic()        6,220 字符  ← ★硬编码，改不到
  ├─ 四段规则     ✓
  ├─ 四类感知纪律 ✓
  ├─ 技能库纪律   ✓
  └─ 看板 tag     ✓

21 个工具的 description + schema  20,904 字符  ← 硬编码在 defineTool() 里
```

**结论**：能通过配置改的只有那 27 个动态层；其中 `snapshotSlimMaintain` 只占整体固定成本的一小部分。这就是"删 1,104 字符省不到 token"的结构性原因。

## 九、关键文件索引

| 文件 | 作用 |
|---|---|
| `lib/index.js` (1.35 MB) | 主引擎：21 个工具、注入渲染、pre-step |
| `lib/event-store.js` | 事件存储与投影（26 字段 fail-closed 校验） |
| `lib/event-write.js` | 事件写入（检查点、四段映射） |
| `lib/wb-contract.js` | 账本/白板判据门 H1–H4 |
| `lib/plan-render.js` | 白板渲染器（fromEvents 模式） |
| `lib/handoff-anchor.js` | 账本解析 + memory 锚点 |
| `lib/ev4-adapter.js` | 前端适配 |

## 十、一个容易踩的认知陷阱

**「写进提示词」≠「模型会照做」。**

实测：`renderMemoryStatic()` 里明明写了四类感知的触发条件（2026-10-28 加的），
但真实 551 个会话里，携带四类感知参数的调用是 **0 次**。

这不是提示词写得不好，而是**模型有其他更熟悉的通道**（日志、用户级记忆）会优先走。
详见 `02-FINDINGS` 的"通道选择"层。
