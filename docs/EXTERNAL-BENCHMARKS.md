# 外部基准接入

> 为什么接：本套件的判据是**我们自己设计的**。自己出题自己判分，最大的风险是
> 「只测到了我们想到的东西」。外部基准的考点是从大量真实使用里归纳的，
> 而且带**结构化判据**，正好补这个盲区。

---

## §0 先看覆盖率（这是接入的理由）

```
node suites/external.mjs --dry-run        # 不跑题，只打印覆盖对比
```

输出会明说我们缺什么。当前实测（2026-11-03）：

| 基准 | 我们原本覆盖 | 缺 |
|---|---|---|
| [Ornn8/memory-system-benchmark](https://github.com/Ornn8/memory-system-benchmark) 27 考点 | **7 / 27** | 20 项 |
| [LongMemEval](https://github.com/xiaowu0162/LongMemEval) 7 类 | **2 / 7** | 5 项 |

**缺的 20 项里，最要紧的五类**：

| 缺失能力 | 为什么重要 |
|---|---|
| 第三方事实 | 别人的事记到用户头上，是画像污染的主要来源 |
| 知识更新 | 用户改口后继续用旧安排 |
| 选择性地不回答 | 没有答案时编造 —— 真实使用中代价最高 |
| 助手自己说过的话 | 把助手建议当成用户承诺 |
| 计划 ≠ 已完成 | 把打算记成事实 |

---

## §1 Ornn8 接入

### 准备数据

```bash
git clone --depth 1 https://github.com/Ornn8/memory-system-benchmark
export TESTKIT_ORNN8_DIR=/path/to/memory-system-benchmark
```

### 它是什么

长期、低频的个人聊天场景：**182 天 / 360 轮 / 27 个考点 / 108 个提问实例**
（每考点在当天 / 3 天 / 15 天 / 45 天各问一次）。

每个考点带四段结构化判据：

```
**必须做到：** 活动扳手；演出结束后归还
**可接受：**   演出结束后归还那把活动扳手
**历史未说明：** 具体归还日期
**不能这样答：** 说已经还了
```

这正是它最值得借的地方 —— 比自己写的「看起来对不对」严格得多。

### 跑

```bash
# 只跑我们原本没覆盖的考点（推荐，最省额度）
node suites/external.mjs --bench ornn8 --only-missing --limit 3

# 先看会跑哪些，不真跑
node suites/external.mjs --bench ornn8 --only-missing --dry-run
```

### ⚠️ 边界（必须知道）

1. **只有公开示例，不是正式卷**。官方正式卷（六人物、714 题）不公开。
   示例题自带答案，**不能用来排名**。
2. **我们用单轮接法**。官方要先回放 360 轮再提问 —— 那测的是跨时间遗忘。
   单轮只验「给了素材后能不能答对」。两者结论**不能互相替代**。
3. 跨时间那部分需要 `lib/replay.mjs`（见 §3），目前只做了能力验证，未接进套件。

---

## §2 LongMemEval 接入

### 准备数据

15MB，不随本仓库分发：

```bash
mkdir -p ~/lme && cd ~/lme
curl -LO https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json
export TESTKIT_LME_DIR=~/lme
```

（`longmemeval_s_cleaned.json` 是 277MB 的大版本，需要更完整的 haystack 时再用。）

### 它是什么

500 题，7 类：`single-session-user` / `single-session-assistant` /
`single-session-preference` / `temporal-reasoning` / `knowledge-update` /
`multi-session` / `abstention`。

**`abstention`（30 题）是我们最该接的一类** —— 历史里没有答案，
正确行为是明确说不知道。我们原来完全没测这个。

> ★ **一个容易踩的坑**：`abstention` 的判定依据是 `question_id` 以 `_abs` 结尾，
> 而 `question_type` 仍写着原始类型（如 `temporal-reasoning`）。
> 只看 `question_type` 会把 30 道「该说不知道」的题当成普通题，判据全用错。

### 跑

```bash
# 只跑我们缺的类型
node suites/external.mjs --bench lme --only abstention,knowledge-update --limit 4
```

---

## §3 回放能力（`lib/replay.mjs`）

### 已验证的技术前提

`dsh --profile <p> --json --session-id <sid> "…"` 可以**跨进程续接**同一会话。
实测：第 1 次说「暗号是紫藤 7」→ 退出；第 2 次带 `--session-id` 问 → 答「紫藤 7」。

所以可以把一段历史**逐步喂**进去，不必拼成一个巨型 prompt。

### 三道纪律（写在代码注释里，也写在这里）

1. **不重写历史**：喂进去的是原始用户消息 + 当时已有的助手回复。
   因为 headless 一次调用只有一个输入口，助手回复被包成
   「（当时我的回复是：…）」并入同一条消息。
   **这个格式保真度损失必须写进报告**，不能当成等价。
2. **逻辑时间不靠改系统时钟**：整机时钟不该被改。逻辑时间写进每条消息的前缀。
   —— 这是与 Ornn8 的一处**已知差异**。
3. **考试会话必须独立**：问完就结束，不把题与答喂回历史，避免污染下一题。

### 还没做的

回放架构跑一整套 108 题 ≈ 360 轮 × N 次模型调用，成本高。
目前只验证了能力，**没有接进套件**。要用的话直接调 `replayHistory()` + `askInFreshSession()`。

---

## §4 判分：为什么我们不用 LLM 裁判

LongMemEval 官方用 **GPT-4o 当裁判**做语义等价判定。本套件**不引入外部裁判模型**，
理由：那会让「测什么」依赖于另一个模型的行为，且结果不可复算。

代价是**判得不准**。规则判分的四次修正记录了过程（见 `lib/external-ornn8.mjs` 注释）：

| 版本 | 判法 | 实测结果 |
|---|---|---|
| v1 | must 整条严格包含 | 参考答案 **11/27 被判不过** |
| v2 | 拆义项 + 短窗口匹配 | 宽松过头，正确答案被误判踩线 |
| v3 | 最长公共子串 | 参考答案 2 个被误判 |
| **v4** | **判不了就返回 `null`** | 参考答案 0 个误判，0 个无关回答被误判通过 |

### v4 的核心取舍

中文的同义改写（must「须取得同意」vs 参考「不要代发消息」）**无法靠子串匹配解决**。
硬判只会两类错误各占一半。所以：

- 能对齐 → 给 `true` / `false`
- 对不齐（可能是改写） → **返回 `null`**，从分母剔除，报告里单列「需人工判 N 题」

**假红会误导优化方向，假绿会掩盖真问题。两者都不可接受时，诚实说「判不了」比硬给一个错答案有用。**

每个结果都带 `confidence`：

| 值 | 含义 |
|---|---|
| `high` | 明确失败（一个义项都没命中 / 空回答 / 逐字踩禁止项） |
| `medium` | 全部命中且判据完备 |
| `low` | **有无法自动核对的判据**（抽象禁止项 / 元描述）—— 必须人工看 |
| `none` | 判不了 |

---

## §5 离线自检（不花额度）

```bash
export TESTKIT_ORNN8_DIR=... TESTKIT_LME_DIR=...
node setup/verify-external-judges.mjs
```

18 项断言，钉住四件事：

1. **解析完整**：每考点都有 evidence / must / 4 个时间档
2. **判据不反噬**：参考答案不能被判成错；无关回答不能判成通过
3. **abstention 的识别**：`_abs` 后缀必须覆盖 `question_type`
4. **「说不知道又编」必须降置信度**（这一条最容易被漏，也最危险）

---

## §6 结论怎么写

用外部基准的结果时，报告里**必须**包含：

```
· 数据来源：<repo> @ <commit>  或  文件 + 下载地址
· 接法：mode=single（只给证据会话）—— 不是官方口径
· 判分：rule-based（非 GPT-4o 裁判）
· 判不了的题数：N（需人工判）
· confidence=low 的题数：M（需人工确认）
```

**不能**写成「我们的模型在 LongMemEval 上得了 X 分」——
那会被理解成官方分数，而我们既没跑官方流程，也没用官方裁判。
