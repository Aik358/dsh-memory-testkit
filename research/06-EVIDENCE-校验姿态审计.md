# 06 · 校验姿态审计（每个工具到底校验什么）

> 状态：✅ 有效
> 复现：`node harness/audit-percept-calendar.mjs`（在 `<work>` 下）
> 方法：读源码 + 调纯函数，**不真调工具**（避免污染真实库）

---

## 总览：校验分布极不均衡

| 记忆面 | 硬判据 | 软判据 | 备注 |
|---|---|---|---|
| **交接账本** | **H1–H4** | S1–S4 | 全仓唯一有强判据的写入面 |
| **白板 PLAN.md** | P-H1 / P-H2 | P-S1 | 判据刻意最弱 |
| 检查点四段 | ❌ 无 | ❌ 无 | 全空也接受 |
| `userPercept.stage` | ✅ 枚举 | — | **感知里唯一被强校验的字段** |
| `userPercept.text` | ❌ | ❌ | 空字符串也收 |
| `userPercept.kind` | ❌ | ❌ | 任意字符串 |
| `agentTrace.action` | ❌ | ❌ | 空也收 |
| `sharedGround.claim` | ❌ | ❌ | 空也收 |
| `commitments.promise` | ❌ | ❌ | 空也收 |
| `commitments.state` | ❌ | ❌ | `open/kept/dropped` 只是文档约定 |
| `calendar_add.title` | ✅ 非空+无换行 | — | |
| `calendar_add.quadrant` | ✅ 5 值枚举 | — | |
| `calendar_add.date` | ❌ | ❌ | **任意字符串都收** |
| `calendar_add.time` | ❌ | ❌ | **任意字符串都收** |
| `memory_log.note` | ❌ | ❌ | |
| `memory_procedure.steps` | ⚠️ 非空 | — | 类型是 string（一行一步） |

---

## 一、交接账本：H1–H4（唯一真正强的）

```js
// lib/wb-contract.js

H1  四段标题齐全且**逐字**匹配
    必须恰好是：## 任务状态 / ## 目标 / ## 已试方案与失败原因 / ## 进度与下一步
    ★加任何后缀都会失败（如 `## 任务状态（type:state）`）

H2  每段 body 非空
    ≥1 个非空行，且合计 ≥20 字符（去掉空白后）

H3  无占位符行
    黑名单：(待补充) / （待补充） / TODO / 同上 / 略 / N/A / n/a
    注意：整行必须是占位符才拒，句中含 TODO 不算

H4  总长 ≤ 8000 字符

S1  每段 ≤5 行（软）
S2  失败项含「方案→失败原因」箭头（软）
S3  下一步含可执行特征（路径/代码/命令动词）（软）
S4  无临时信息（软）
```

### 实测效果

构造 7 个坏账本，**6 个被拒且不落盘**（第 7 个其实合规）。

```
缺段            → H1 拒
段太短（18 字符）→ H2 拒
纯占位符        → H3 拒
超 8000 字符    → H4 拒
```

### 关键细节：H1 是最常被触发的

真实对话里模型**天然想把 `type:state` 标签贴到标题上**（因为仓库里到处都是这种 tag）。

实测：
- 提示词里**单独**写了「标题必须逐字」⇒ 一次写对 15/15
- 提示词里这句话**夹在长散文里** ⇒ 必然先错一次，靠 H1 拒绝 + 重试才对

⇒ **H1 既是防线，也是最频繁的"教师"**。

---

## 二、四类感知：只校验一个字段

### 2.1 契约字段白名单

```js
// lib/event-store.js

export const PERCEPT_ITEM_FIELDS = Object.freeze({
  userPercept:  ['at', 'kind', 'stage', 'text', 'sourceRef'],
  agentTrace:   ['at', 'action', 'result', 'wasRefuted', 'sourceRef'],
  sharedGround: ['at', 'claim', 'confirmedBy', 'correction', 'sourceRef'],
  commitments:  ['at', 'promise', 'boundary', 'state', 'sourceRef'],
})
```

**注意**：这是 `list()` 返回时的**投影白名单**（未知字段会被丢弃），
**不是写入校验**。写进去的任意字段都会存。

### 2.2 唯一的强校验：`userPercept.stage`

```js
export const PERCEPT_STAGES = Object.freeze([
  'retrieved', 'delivered', 'used', 'mentioned', 'accepted'
])

// append() 里
if (!PERCEPT_STAGES.includes(st)) throw new Error('appendEvent: 非法 stage ' + st)
```

**这是四类感知里唯一会抛错的地方。**

### 2.3 其余全部不校验

```js
pushOne('userPercept', userPercept, (u) => ({
  at: Number(u.at) || now0(),
  kind: String(u.kind == null ? '' : u.kind),    // ← 空字符串也收
  stage: st,                                      // ← 唯一校验过的
  text: String(u.text == null ? '' : u.text),     // ← 空也收
  sourceRef: u.sourceRef == null ? null : String(u.sourceRef),
}))

pushOne('agentTrace', agentTrace, (a) => ({
  action: String(a.action == null ? '' : a.action),   // ← 空也收
  result: a.result == null ? null : String(a.result),
  wasRefuted: a.wasRefuted === true,
}))

pushOne('sharedGround', sharedGround, (g) => ({
  claim: String(g.claim == null ? '' : g.claim),      // ← 空也收
  confirmedBy: g.confirmedBy == null ? null : String(g.confirmedBy),
  correction: g.correction == null ? null : String(g.correction),
}))

// commitments 同理：promise / boundary / state 全不校验
```

### 2.4 风险与实测对照

**风险**：一条 `{stage:'accepted', text:''}` 也会被接受，并且会进用户画像注入段（因为 stage 合法）。

**但实测模型写得对**：15 个场景里所有字段都填对了。

⇒ **当前数据质量靠的是提示词和 schema 描述，不是校验。**

一旦提示词被精简，这些面**没有兜底**。

### 2.5 建议

给 `text` / `claim` / `promise` 加**非空软校验**（记警告但接受）。

⚠️ **不要硬拒** —— 参考 `polluted` 臂的教训：硬判据会把正常路径堵死。

---

## 三、日历：标题和象限有校验，日期时间没有

```js
// lib/index.js calendarAdd()

const quadrant = calendarQuadrantPre(item.quadrant)
if (!['重要紧急','重要不紧急','紧急不重要','不重要不紧急','未分类'].includes(quadrant))
  throw Object.assign(new Error('invalid calendar priority'), { statusCode: 400 })  // ✅

const entry = {
  id: item.operationId ? 'cal_' + sha256(...).slice(0,32) : 'cal_' + randomUUID(),
  date: item.date || todayStr(),        // ← 任意字符串都收
  done: !!item.done,
  time: item.time || '--:--',           // ← 任意字符串都收
  quadrant,
  title: String(item.title || '').trim(),
  note: String(item.note || '').trim(),
}

if (!entry.title || /[\r\n]/.test(entry.title))
  throw Object.assign(new Error('calendar title must be one nonempty line'), { statusCode: 400 })  // ✅
```

**三个拒绝点**：
1. `invalid calendar priority`（象限不在白名单）
2. `calendar title must be one nonempty line`（标题空或含换行）
3. `calendar operation identity reused with different content`（幂等键复用但内容不同）

**没有的**：日期格式、时间格式、日期合理性（比如 `2026-13-45` 也能进）。

### 实测模型表现

隐性触发实验里：
- 「下周四 2026-11-05 下午 3 点」→ `date="2026-11-05"` ✅
- 「明天上午十点」（今天是 2026-10-29）→ `date="2026-10-30"` ✅ **正确换算**

⇒ 模型自觉遵守，但没有兜底。

---

## 四、检查点四段：完全不校验

```js
// event-store.append() 构造 checkpoint
// 四段（goal/state/dead/next）全空也接受
```

**实测影响**：白板/详情页会出现空白行。

真实数据：553 个检查点里，四段齐全的只有约 11%。

⇒ 这也是为什么原设计**反对**给检查点加「四段必填硬拒绝」——
89% 的历史数据四段为空，硬拒会让写入节奏断裂。

---

## 五、WAL 半渡态：判据门的时序问题

```
memory_note(kind=handoff) 的执行顺序（lib/index.js:21935-22010）：

  Phase 1  appendHandoffCheckpointPre(...)   ← 先写事件，零内容校验
  Phase 2  writeHandoffLedger(...)           ← 再过判据门，不合格 ok:false
  Phase 3  失败 → 追加 kind='handoff-write-failed' 补偿检查点
```

**问题**：Phase 1 已经把内容写进事件库了（不可撤销），Phase 2 才校验格式。

**实测后果**：
- 账本 `.md` 没写（好）
- 但坏内容作为**不可撤销的检查点**留在了事件库
- 每失败一次多两条（坏内容 + 补偿标记）

**真实数据**：`write-failed` 补偿标记 = **3 条** ⇒ 真实发生过 3 次。

**Phase 3 的文案自己就承认了**：
> 「原内容已作为前一检查点记入事件（可经 memory_recall(scope="events") 取回）。」

---

## 六、审计脚本

```bash
cd <work>
node harness/audit-percept-calendar.mjs
```

输出 6 节：
1. 四类感知的契约字段白名单
2. `PERCEPT_STAGES` 枚举
3. `validateEventPre` 对四类感知做了什么校验（逐项「有/无」）
4. `append()` 的归一化逻辑
5. `calendar_add` 的校验（拒绝点、象限白名单、标题/日期/时间校验）
6. `calendarQuadrantPre` 归一化函数

---

## 七、结论

**校验能力是有的，只是分布极不均衡：**

```
账本         ████████████████████  H1-H4 强判据 + S1-S4 软判据
白板         ██                    P-H1/P-H2（刻意最弱）
日历         ████                  标题 + 象限
userPercept  █                     stage 枚举
检查点        ·                     无
感知其余字段  ·                     无
```

**这不是"没实现"，是"只在对的地方实现了"。**

账本之所以有强判据，是因为它是最重要的原文载体（跨窗口交接的唯一凭据）。
其余面没有，是因为设计上假设「模型会自觉」。

**实测表明模型确实自觉**（15/15、10/10），
但**这正是危险之处** —— 一旦提示词被精简，自觉就失去了依据。
