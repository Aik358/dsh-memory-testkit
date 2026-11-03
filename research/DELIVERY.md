# 交付说明 · 怎么把这个研究喂给其他 Agent

> 生成：2026-10-29

---

## 一、这个包里有三种交付形态，按场景选

| 形态 | 文件 | 大小 | 用在哪 |
|---|---|---|---|
| **单文件（推荐）** | `CORE.md` | 66K 字符 | 一次性粘给 Agent，只含有效内容 |
| 全套文档 | `00-` ~ `13-` 共 14 份 | 155K 字符 | Agent 能自己读文件时 |
| 全量合并 | `ALL-IN-ONE.md` | 157K 字符 | 需要完整历史（含过时文档）时 |

**建议**：先给 `CORE.md`。如果对方需要看被推翻的细节，再单独给对应文档。

---

## 二、三个必须告诉对方的事

### ① 这个研究自己推翻了自己三次

时间顺序读会把过时结论当事实。所以每份文档开头都标了状态：

```
✅ 有效          → 可直接采信
⚠️ 部分有效      → 读时看「已被修正的部分」
📋 任务书        → 是需求不是结论
```

**必须提醒对方**：看到 `07-DESIGN` 的「省 1,498 字符 + 提高合规率」**不要采信**，
那是已被实测推翻的主张（详见 `CORE.md` 的 00-INDEX §三）。

### ② 「100%」的样本量很小

| 结论 | 样本 |
|---|---|
| 交接账本 8 版本全过 | 40 次调用 |
| 7 个记忆面全过 | 15 场景 × 4 环境 |
| 隐性触发全过 | 10 次 |
| 接续仪式 | 12–13 次（每格） |

**这些不是统计意义上的 100%**，置信区间很宽。换模型、换语料都可能不同。

### ③ 最大的空白：不知道为什么不用感知通道

已确认：
- 模型会写（表达层 100%）
- 模型想得到要记（察觉层 100%）
- 但它走日志/用户级记忆，**几乎不走 `userPercept` / `sharedGround` / `commitment`**（真实 0/162）

**没确认的是「为什么」。** 三个假设待验证（见 `CORE.md` 的 02-FINDINGS §3.3）。

如果想要一个「下一步做什么」的建议，就是这个。

---

## 三、给对方的开场话术（可直接复制）

```
这是一个关于 DSH 记忆插件的实测研究包，约 155K 字符（核心版 66K）。

先读 CORE.md，它按「心智模型 → 核心结论 → 缺陷清单 → 证据 → 工具」的顺序组织。

三个重要前提：
1. 这个研究推翻了自己三次。每份文档开头有状态标注，
   标 ⚠️ 或 📋 的不要当结论采信，具体见 00-INDEX 的「已被推翻的结论」一节。
2. 所有「100%」的样本量都很小（10–40 次），不是统计意义。
3. 最大空白是：已确认模型不用结构化感知通道，但没确认原因。

所有结论都能用 D:\memory-testkit 里的套件复现，命令在 CORE.md 末尾。
```

---

## 四、如果对方要动手改代码

先跑这两个：

```bash
cd D:\memory-testkit
node lib/selftest.mjs      # 判分器自检 22 项 —— 确认判分逻辑没坏
node lib/lint.mjs          # 产品契约漂移检查 —— 确认套件常量与产品一致
```

**为什么必须先跑**：判分逻辑在开发期静默失败过 5 次，每次都把完全正确的模型判成 0 分。
`lint.mjs` 会在产品枚举/字段/判据漂移时报警 —— 否则套件不会报错，只会静默给出错误判分。

改完后用对应套件回归：

| 改了什么 | 跑哪个 |
|---|---|
| 提示词（`snapshotSlimMaintain` 等动态层） | `node suites/families.mjs` + `node suites/handoff.mjs` |
| 提示词（`renderMemoryStatic` 硬编码段） | 改完必须重跑 `families` + `implicit` |
| 判据门（`wb-contract.js`） | `node suites/handoff.mjs` + `node suites/ablation.mjs` |
| 感知字段校验 | `node suites/families.mjs`（7 面里有 3 个测感知） |
| 接续仪式（`refreshRitualPrompt`） | `node suites/ritual-run.mjs` |
| 任何工具 schema | `node lib/lint.mjs` 会先报漂移 |

---

## 五、目录结构

```
D:\memory-testkit\
├─ research\                      ← 研究交付包
│  ├─ DELIVERY.md                 ← 本文件
│  ├─ CORE.md                     ← ★ 单文件精简版（66K）
│  ├─ ALL-IN-ONE.md               ← 全量合并（157K）
│  ├─ 00-INDEX.md                 ← 阅读索引 + 已被推翻的结论
│  ├─ 01-MODEL-...                ✅ 心智模型
│  ├─ 02-FINDINGS-...             ✅ 核心结论
│  ├─ 03-DEFECTS-...              ✅ 6 个产品缺陷
│  ├─ 04-EVIDENCE-实验报告.md      ✅ 两轮实验
│  ├─ 05-EVIDENCE-真实语料.md      ✅ 551 会话
│  ├─ 06-EVIDENCE-校验姿态审计.md   ✅ 每工具校验什么
│  ├─ 07-DESIGN-...               ⚠️ 价值主张已被推翻
│  ├─ 08-PLAN-...                 ⚠️ §1.2 结论已被推翻
│  ├─ 09~11-BRIEF-...             📋 任务书
│  ├─ 12-TESTKIT-套件说明.md
│  └─ 13-PITFALLS-踩坑清单.md      ← 改套件前必读
├─ lib\                           ← 套件核心（判分/哨兵/驱动/自检/漂移检查）
├─ suites\                        ← 4 个套件 + 隐性触发
├─ setup\                         ← 环境初始化与自检
└─ docs\                          ← 套件自身的 README/FINDINGS/PITFALLS
```

---

## 六、这套研究的可复算性

**每一个数字都能重跑出来**：

```bash
# 第一轮：交接账本（40 次调用）
node suites/handoff.mjs --slim --n 5

# 第二轮：7 个记忆面 × 4 个提示词环境
node suites/families.mjs
node suites/families.mjs --slim
node suites/families.mjs --tiny
node suites/families.mjs --noinject

# 隐性触发（不提工具名）
node suites/implicit.mjs

# 接续仪式（真调工具，必须真跑）
node suites/ritual-run.mjs --worlds hasEvent,empty --reps 2

# 对抗 ablation
node suites/ablation.mjs

# 真实语料（只读，不写任何东西）
node lib/corpus-real.mjs

# 汇总
node lib/report.mjs
```

原始数据在 `<work>\raw\`，哨兵报告在 `<work>\sentinel\`，
逐条 agent 输出在 `<work>\live\output\`。
