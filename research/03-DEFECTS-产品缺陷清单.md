# 03 · 产品缺陷清单

> 状态：✅ 有效
> 每条都带实测证据与负路径。按严重度排序。
> 复现：`node suites/ritual-run.mjs` / `node lib/corpus-real.mjs` / `node lib/lint.mjs`

---

## 缺陷总表

| # | 缺陷 | 严重度 | 会让用户做不成事? |
|---|---|---|---|
| **D1** | 接续仪式在「有事件」时几乎做不成 | **P0** | ✅ 是 |
| **D2** | 一个坏事件毒死整个事件库 | **P0** | ✅ 是 |
| D3 | 四类感知只校验 `stage` 一个字段 | P1 | 否（数据质量隐患） |
| D4 | `calendar_add` 的 date/time 完全不校验 | P1 | 否（数据质量隐患） |
| D5 | `renderMemoryStatic()` 硬编码不可配置 | P2 | 否（可维护性） |
| D6 | 拿不到上下文就翻整个文件系统 | P2 | 否（性能与安全） |

---

## D1 · 接续仪式在「有事件」时几乎做不成 【P0】

### 现象

```
empty 世界（事件库为空）      n=12  完成 11  超时 2   平均  82s  → 92%
hasEvent 世界（已有 3 个事件） n=13  完成  2  超时 11  平均 217s  → 15%
```

**有事件时完成率只有 15%，空库时 92%。差 77 个百分点。**

### 复现

```bash
node suites/ritual-run.mjs --versions R0_current,R3_revision --worlds hasEvent,empty --reps 2
```

### 根因链（会话日志实测）

```
① 模型调 memory_recall(scope="events", query="<猜的关键词>")
   ↓ 词法匹配：事件被拼成文本再比关键词
② 猜不中 → 换词重试
   实测最多次数：6 次 recall
   查询过的词：刷新仪式/交接/白板/账本/实验/demo/ritual/R3/正在做的这件事…
③ 每次 recall 都有延迟 → 6 次吃光 240s 预算 → 超时
④ 拿不到 eventId → 白板重写无法确定 revision
   → 模型转去 pwsh Get-ChildItem -Recurse 翻文件系统
⑤ 翻到 <work>\log-*.txt（实验日志）
   和别的实验工作区的 PLAN.md —— 实验脚手架被当成任务上下文
```

一次性最多跑了 **41 个工具调用**（正常路径 5–6 个）。

### 为什么改提示词没用

试过三个方向，都不管用：

| 版本 | 改动 | empty | hasEvent |
|---|---|---|---|
| R0 现款 | — | 1/1 | 2/13 |
| R1 修死锁 | 把 create 挪到第 2 步之前 + 三路分支 | 2/2 | **0/2** |
| R3 加判据 | 明确选事件判据 + revision 取法 + 冲突重试 | 1/1 | **0/2** |

**瓶颈不在措辞，在 `memory_recall(scope=events)` 的检索方式。**

### 原判断被推翻（重要）

我最初读 `lib/index.js:7111-7114` 时判断缺陷是 **F1 顺序死锁**：

```
第 0 步：查不到事件就在第 2 步之后补 create
第 2 步：账本首行必须写 eventId=<第 0 步拿到的 id>
⇒ 查不到时第 0 步拿不到 id，账本无从写，而 create 却排在账本之后
```

**实测死锁 0/25 次。** 模型在空库世界会**自己把 create 提前**，正确产出 id。

### 建议修法

**方案 A（推荐）：给仪式一个零猜测入口**

```
memory_recall(scope="events", query="")   # 空 query ⇒ 列出全部 active 事件
# 或新增
memory_event(action="list", status="active")
```

**理由**：仪式要的是「我这个会话属于哪个事件」，这是个**枚举题**，不是检索题。
用关键词检索去解枚举题，必然靠猜。

**方案 B（不改工具面）**：让 `memory_recall(scope=events)` 在 `query` 为空或 `*` 时返回全部 active 事件列表。

**方案 C（兜底）**：把仪式的默认超时从 120s 提到 300s。这只是缓解，不解决根因。

---

## D2 · 一个坏事件毒死整个事件库 【P0】

### 现象

```
memory_event 失败: 事件写入前校验失败(evt_abc12345): missing:skillRef,bad-kind:task
```

**后果不是「那个事件被拒」，而是整个 store 的每次写入都失败 —— 包括新建另一个事件。**

实测：模型连续 3 次 `create` 全被同一个错误挡住，第 4 次才绕过。

### 触发条件

我在预置夹具时把 `kind` 写成了 `'task'`（合法枚举是
`ledger / planSnapshot / sessionTranscript / project / mechanical / unknown`），
且漏了 `skillRef` 字段。

### 根因

`validateEventPre` 是 fail-closed 的 26 字段校验，但它把
**「库里所有事件」**和**「本次写入」**放在一起报：

```js
bad.push('missing:skillRef')     // ← 这是存量事件的字段
bad.push('bad-kind:task')        // ← 这是存量事件的枚举
```

错误信息里没有指明「是哪条事件坏了」，模型完全看不出该改什么。

### 为什么危害大

- 用户不会自己修 —— 他看不到 event-store.json
- 一旦库里有一个坏事件，**所有后续写入永久失败**
- 表现为「记忆系统突然不工作了」，很难归因

### 建议修法

1. **错误信息区分来源**：
   ```
   存量事件 evt_abc12345 非法：missing:skillRef, bad-kind:task
   ⇒ 该事件会导致全部写入失败，请用 memory_event(action="repair") 修复或删除
   ```
2. **坏事件降级为跳过**：校验时跳过非法事件并记录警告，而不是全局 fail
3. **写入路径加保护**：`create` 前先验证「库里有没有坏事件」，有则先提示修复

### 复现

```js
// 在 event-store.json 里放一个 kind:'task' 的事件
// 然后调任意 memory_event(action="create")
```

---

## D3 · 四类感知只校验 `stage` 一个字段 【P1】

### 审计结果

| 记忆面 | 校验强度 |
|---|---|
| 交接账本 | **H1–H4 硬判据** + S1–S4 软判据 |
| `userPercept.stage` | 枚举校验（`retrieved/delivered/used/mentioned/accepted`） |
| `userPercept.text` | **不校验**（空字符串也收） |
| `userPercept.kind` | **不校验**（任意字符串） |
| `agentTrace.action` | **不校验** |
| `sharedGround.claim` | **不校验** |
| `commitments.state` | **不校验**（`open/kept/dropped` 只是文档约定） |
| `commitments.promise` | **不校验** |

### 但模型目前写得对

15 个场景里所有字段都填对了（`stage="accepted"`、`kind="preference"/"authorResponse"`、`state="open"`）。

⇒ 这是**靠提示词和 schema 描述**，不是靠校验。

### 风险

一旦提示词被精简（这是原方案的目标），这些面就**没有兜底**了。

### 建议

给 `text` / `claim` / `promise` 加**非空校验（软警示，不硬拒）**。

⚠️ 不要硬拒 —— 参考 `polluted` 臂的教训：硬判据会把正常路径堵死。

---

## D4 · `calendar_add` 的 date/time 完全不校验 【P1】

### 审计结果

```js
// lib/index.js calendarAdd()
if (!['重要紧急','重要不紧急','紧急不重要','不重要不紧急','未分类'].includes(quadrant))
  throw ... 'invalid calendar priority'                        // ✅ 象限有校验
if (!entry.title || /[\r\n]/.test(entry.title))
  throw ... 'calendar title must be one nonempty line'         // ✅ 标题有校验
// date / time: 无任何校验                                        ❌
```

**任意字符串都能写进 `date` 和 `time`。**

### 实测模型行为

隐性触发实验里，模型正确把「明天」换算成了 `2026-10-30`，
把「下周四 2026-11-05 下午 3 点」写成了 `date="2026-11-05"`。

⇒ **模型目前表现良好**，但这是靠它自觉。

### 建议

加**软校验**：日期不符合 `YYYY-MM-DD` 时给出提示（但接受写入），
并提示「相对时间需要换算成具体日期」。

---

## D5 · `renderMemoryStatic()` 硬编码不可配置 【P2】

### 现象

```
renderMemoryStatic()  6,220 字符   ← 硬编码字符串
  ├─ 四段规则
  ├─ 四类感知纪律
  ├─ 技能库纪律
  └─ 看板 tag 规则
```

`promptLayerOverrides`（用户可配置的 27 个动态层）**改不到它**。

### 影响

1. 想调这四条纪律的措辞 → 必须改代码
2. 「精简静态纪律」这个实验变量**测不了**
3. 用户没法关掉不关心的部分（比如不用技能库的人也得看那 400 字符）

### 建议

至少拆出两个独立层给配置：
- `staticPerceptDiscipline`（四类感知，约 640 字符）
- `staticCalendarDiscipline`（日历，约 100 字符）

不要一次全拆 —— 拆了会破坏 system prompt 的字节稳定性（前缀缓存锚）。

---

## D6 · 拿不到上下文就翻整个文件系统 【P2】

### 现象

D1 的连锁反应：模型拿不到 eventId → 转去 `pwsh Get-ChildItem -Recurse`。

实测一次跑了 **41 个工具调用**，其中大量是：

```
Get-ChildItem -Force -Recurse -Depth 2
Get-ChildItem -Force -Recurse '<work>\memory' -Depth 4
Get-ChildItem -Force -Recurse '<work>\dshhome\profiles\memexp' -Depth 3
Get-Content '<work>\log-ritual-fix.txt' -Tail 60
```

**它读到了我的实验日志和别的实验工作区。**

### 风险

1. **性能**：递归搜索大目录会拖垮会话
2. **信息泄漏**：模型会读到不该读的内容（虽然沙箱拦住了写，但读没拦）
3. **自指污染**：实验脚手架被当成了任务上下文

### 建议

1. 沙箱在 `workspace-write` 模式下，**读取也应该限制**在 cwd 内（当前只限制了写）
2. 或在系统提示里明确：「不要用递归搜索；需要记忆内容请用 memory_* 工具」

---

## 附：已确认的既有缺陷（非本轮发现）

### WAL 半渡态

`memory_note(kind=handoff)` 的执行顺序：

```
Phase 1  appendHandoffCheckpointPre(...)   ← 先写事件，零内容校验
Phase 2  writeHandoffLedger(...)           ← 再过判据门，不合格 ok:false
Phase 3  失败 → 追加 kind='handoff-write-failed' 补偿检查点
```

**后果**：账本 `.md` 被拒（好），但坏内容已作为**不可撤销的检查点**留在事件库。

真实数据：`write-failed` 补偿标记 = **3 条** ⇒ 半渡态真实发生过 3 次。

**建议**：把判据门前置到 Phase 1 之前。这会改变「事件优先」语义，需要重新表述为
「先验证格式，再原子写入事件 + 账本」。

---

## 修复优先级建议

```
第一批（P0，会让用户做不成事）
  D1  给仪式零猜测入口：memory_recall(scope="events", query="") 列全部 active
  D2  错误信息区分「本次入参」vs「库存存量」+ 坏事件降级跳过

第二批（P1，数据质量）
  D3  感知的 text/claim/promise 加非空软校验
  D4  calendar 的 date/time 加格式软校验

第三批（P2，可维护性）
  D5  拆出两个静态层给配置
  D6  限制沙箱内的递归读取

独立
  WAL 半渡态：判据门前置
```
