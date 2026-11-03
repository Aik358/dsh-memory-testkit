> **状态：✅ 有效** — 测试套件的使用说明
>
> 套件本身在 `D:\memory-testkit`，本文是 docs/README.md 的副本。

---

# DSH 记忆插件测试套件

> 一套用于评测 `dsh-auto-memory` 插件「记忆操作遵循能力」的测试基础设施。
> 隔离沙箱 + 完整性哨兵 + 按面判分 + 实时监控台。

## 30 秒上手

```bash
cd D:\memory-testkit

node setup/init-profile.mjs      # 一次性：建最小 profile + 沙箱配置
# （若 ACL 检查不过）powershell -ExecutionPolicy Bypass -File setup\elevate.ps1
node setup/preflight.mjs         # 环境自检

node lib/selftest.mjs            # 套件自检（判分器没坏吧？）
node lib/lint.mjs                # 漂移检查（产品改了、套件还准吗？）

node suites/families.mjs         # 跑套件：7 个记忆面
node lib/server.mjs              # 监控台 http://127.0.0.1:8899
```

## 它解决什么问题

测「模型会不会正确使用记忆工具」这件事，有四个反复踩的坑：

| 坑 | 本套件的解法 |
|---|---|
| **观察者污染** —— 在宿主内部起子代理，子代理本身就被注入了记忆提示词 | 外部进程驱动 `dsh --profile <p> --json`，被测模型只看到实验设定 |
| **污染真实记忆库** —— 插件按 cwd 派生工作区，配置与 `DSH_HOME` 都拦不住 | 独立 `DSH_HOME` + 显式覆盖 `memoryRoot` 为沙箱绝对路径 |
| **判分自欺** —— 拿最终回复文本、人工目测、LLM 自评 | 生产判据函数 + 落盘产物核验 + 22 项判分器自检 |
| **静默漂移** —— 产品改了枚举/字段/判据，套件不报错只给错分 | `lib/lint.mjs` 逐项比对产品契约 |

## 四个套件

### `suites/families.mjs` · 7 个记忆面

15 个场景覆盖共识 / 人侧观察 / 承诺 / 日历 / 事件归属 / 日志 / 技能库，其中 **4 个是负路径**（专测误报）。

```bash
node suites/families.mjs                    # 默认提示词
node suites/families.mjs --slim             # 127 字符版本
node suites/families.mjs --tiny             # 45 字符版本
node suites/families.mjs --noinject         # 关掉记忆注入（极限对照）
node suites/families.mjs --only calendar,event --n 3
```

### `suites/handoff.mjs` · 交接账本

20 条自包含任务 × 14 个任务类型，判据用产品的 `checkHandoffCriteriaPre`（H1–H4）。

```bash
node suites/handoff.mjs --slim --n 5
```

### `suites/ritual-run.mjs` · 接续前刷新仪式

**必须真调工具** —— 它测的是多步编排能否走通，离线评判测不出来。

```bash
node suites/ritual-run.mjs --versions R0_current,R3_revision --worlds hasEvent,empty --reps 2
```

关键读数是「**有事件世界的完成率**」：实测空库 92%、已有事件 15%。这是产品真实缺陷所在（详见 `docs/FINDINGS.md`）。

### `suites/ablation.mjs` · 对抗性 ablation

同一份素材 × 5 种任务侧指令，测「指令」与「工具回执」谁更有权威。

```bash
node suites/ablation.mjs
node suites/ablation.mjs --only polluted,distrust
```

## 目录结构

```
memory-testkit/
├─ lib/
│  ├─ config.mjs        所有路径/常量/沙箱三要素（单源）
│  ├─ driver.mjs        起 headless 会话、解 NDJSON、解 zstd 会话日志
│  ├─ sentinel.mjs      完整性哨兵（真实库/产品代码/提示词面 全量 sha256）
│  ├─ judge.mjs         按记忆面判分（schema 驱动，不是直觉驱动）
│  ├─ collector.mjs     逐条输出采集（工具调用/结果/文本/思考）
│  ├─ runner.mjs        统一执行器（单场景生命周期 + 并发）
│  ├─ fixtures.mjs      夹具工厂（合规事件/白板/预置世界）
│  ├─ server.mjs        监控台（5 页签）
│  ├─ selftest.mjs      判分器自检（22 项）
│  ├─ lint.mjs          漂移检查（产品契约 vs 套件常量）
│  └─ report.mjs        结果汇总
├─ suites/
│  ├─ families.mjs      入口：7 个记忆面
│  ├─ scenarios.mjs     15 个场景定义
│  ├─ prompt-variants.mjs  提示词变体（一处定义）
│  ├─ handoff.mjs       入口：交接账本
│  ├─ corpus-handoff.mjs   20 条自包含任务
│  ├─ ritual-run.mjs    入口：接续仪式
│  ├─ ritual.mjs        仪式判分 + 场景构造
│  └─ ritual-prompts.mjs   4 个仪式版本
├─ setup/
│  ├─ init-profile.mjs  建最小 profile + 沙箱配置
│  ├─ preflight.mjs     环境自检
│  └─ elevate.ps1       提权授予 ACL
└─ docs/
   ├─ README.md         本文件
   ├─ FINDINGS.md       跑出来的产品缺陷与实测结论
   └─ PITFALLS.md       踩过的坑（改套件前必读）
```

## 安全边界

**套件的最高纪律：绝不写真实记忆库。**

四层防线：

1. **配置隔离** —— `memoryRoot` / `userMemoryDir` 指向沙箱绝对路径（`~` 会被 `os.homedir()` 展开，`DSH_HOME` 拦不住）
2. **文件系统沙箱** —— `DSH_PERMISSION_MODE=workspace-write`，越界写被拒
3. **升级路径封死** —— headless 无审批通道，`danger-full-access` 请求会被"失败关闭"
4. **完整性哨兵** —— 每次任务前后全量 sha256，真实库/产品代码/提示词面任何变化都会记为违规

跑完可用 `node lib/report.mjs` 查看违规汇总；真实库工作区数基线记在 `<WORK>/.real-workspace-count`。

## 环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `TESTKIT_WORK` | `<work>` | 沙箱根（所有实验产物） |
| `TESTKIT_REPO` | `<repo>` | 被测插件源码（只读） |
| `TESTKIT_DSH_BIN` | npm 全局装的位置 | dsh 的 bin.js |
| `TESTKIT_PROFILE` | `memexp` | 实验 profile 名 |
| `TESTKIT_TIMEOUT_MS` | `300000` | 单条任务超时 |
| `TESTKIT_CONCURRENCY` | `3` | 并发上限 |
| `TESTKIT_PORT` | `8899` | 监控台端口 |

## 已知边界

| # | 边界 | 影响 |
|---|---|---|
| 1 | `renderMemoryStatic()`（6,220 字符）硬编码，`promptLayerOverrides` 改不到 | 「精简静态纪律」这个变量**测不了**，除非改产品代码 |
| 2 | 样本量小（仪式 12–13 次，记忆面每组 1–5 次） | 「100%」不是统计意义上的 100% |
| 3 | 任务语料是自包含的 | 真实场景里「先查资料再写」那条链路未覆盖 |
| 4 | 单轮新会话 | 多轮累积效果、首轮学习都测不了 |
| 5 | 只测了一个模型（`deepseek-v4.1-flash`） | 换模型结论可能不同 |

## 扩展指南

**加一个记忆面**：在 `suites/scenarios.mjs` 里加场景（必须带 `family` 与 `expect`），在 `lib/judge.mjs` 里加对应分支，在 `lib/selftest.mjs` 里加至少一条正路径 + 一条负路径断言。

**加一个提示词变体**：在 `suites/prompt-variants.mjs` 的 `PROMPT_TEXTS` 与 `PROMPT_VARIANTS` 各加一项，`families.mjs` 与 `handoff.mjs` 会自动认。

**加一个夹具世界**：在 `lib/fixtures.mjs` 里加 `fixtureXxx(cwd)`，用 `seedWorkspace` 写入——**必须写到 `projectDirOf(cwd)`，不是 cwd**。
