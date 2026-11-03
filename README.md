# dsh-memory-testkit

**DSH 记忆插件的遵循能力测试套件** —— 隔离沙箱 + 完整性哨兵 + 按面判分 + 实时监控台。

给社区贡献者用：**批量设计实验、跑实验、看模型到底写了什么**。
不做的事：不改产品代码、不碰你真实的记忆库。

> **第一次用？直接看 [docs/USAGE-GUIDE.md](docs/USAGE-GUIDE.md)** ——
> 从配端点、装环境、跑基线，到做第一次提示词实验，按步骤走。

## 前提

装好两个包 + 配一个模型端点就能用，不需要手填 DSH 路径：

| 依赖 | 门槛 | 说明 |
|---|---|---|
| DeepSeek Harness | `≥ 0.2.1-rc.5` | 插件 3.4.0-alpha.1 依赖 0.2.1 的 profile/bundle 机制 |
| dsh-auto-memory | `≥ 3.4.0-alpha.1` | 套件的判据与工具面按此版本编写 |
| 模型端点 | 任何 OpenAI 兼容端点 | 官方 / 自建 / 中转都行，**你自己填** |

DSH 入口会**自动探测**（收集全部候选 → 比版本 → 选达标的最新），
所以同时装着桌面版和 npm 版也不会选错。详见 [docs/AGENT-API.md](docs/AGENT-API.md) §2。

### 配端点（唯一必须手填的东西）

```bash
cp testkit.config.example.json testkit.config.json
# 编辑 provider 段：baseURL / model / apiKeyEnv / api
```

`testkit.config.json` 已 gitignore —— 私有域名写在这里不会进仓库。
也可以用 `TESTKIT_PROVIDER_*` 环境变量覆盖。密钥只填**变量名**，不写进文件。

## 快速开始

```bash
node setup/preflight.mjs         # ① 环境自检（10 项，每项都给可执行的修法）
node lib/setup-ui.mjs            # ② 打开向导 http://127.0.0.1:8893
```

向导里四步：环境自检 → 沙箱权限 → 建 profile → 冒烟。
**任一步失败可单独重试**，失败时给可复制的命令。
端点配置也在向导页上（可视化填，保存后立刻写入 profile）。

跑通了以后：

```bash
node suites/families.mjs --cc 2  # 先建立基线（不改任何提示词）
node lib/server.mjs              # 监控台 http://127.0.0.1:8899
```

## 先跑接线审计（零成本，不调模型）

在花钱跑实验之前，先确认「你要改的那个键，产品真的读它吗」：

```bash
node suites/wiring-audit.mjs            # ~0.4 秒，不需要端点和沙箱
node suites/wiring-audit.mjs --strict   # 有 warn 即非零退出（可进 CI）
```

它查五类「改了完全无效」的形态：后端死键 / 前端死开关 / 两端键镜像漂移 /
路由缺失 / try 块作用域越界。**这是本仓历史上最常见的缺陷形态**，
而它们都能通过 `node --check` 与静态断言 —— 只能靠这种审计发现。

详见 [docs/WIRING-AUDIT.md](docs/WIRING-AUDIT.md)（含「warn 不等于缺陷」的判读纪律）。

## 做一次提示词实验

```bash
node experiments/run.mjs <name> --dry-run   # ★ 先校验（会拦下会让你白跑的配置）
node experiments/run.mjs <name>             # 再跑
```

校验器拦三类「实验跑完、报告出了、结论是空的」情况：

| 错误 | 含义 |
|---|---|
| `dead-layer` | 该层没有消费点，改了完全无效 |
| `unreachable-layer` | **该层所在的注入路径被你设的节奏关掉了** |
| `unknown-scenario` | 场景 id 拼错（会静默少跑） |

示例见 [experiments/percept-sentence-table.mjs](experiments/percept-sentence-table.mjs)。

## 环境变量（全部可选）

| 变量 | 默认 | 用途 |
|---|---|---|
| `TESTKIT_REPO` | *自动探测* | 被测插件源码（只读）。依次试：本变量 → 配置文件 `repo` → 套件同级的 `dsh-auto-memory/` |
| `TESTKIT_WORK` | `<套件>/run` | 沙箱根，所有实验产物在这里 |
| `TESTKIT_DSH_BIN` | *自动探测* | 显式指定 dsh 入口（**会用你指定的那个版本，哪怕不达标**） |
| `TESTKIT_PROFILE` | `memexp` | 实验 profile 名 |
| `TESTKIT_CONCURRENCY` | `3` | 并发上限（再高会同时触发多个 grantWrite，ACL 是加锁写的） |
| `TESTKIT_TIMEOUT_MS` | `300000` | 单条任务超时 |
| `TESTKIT_PROVIDER_*` | *无* | 覆盖端点配置（`_NAME` `_API` `_BASE_URL` `_MODEL` `_API_KEY_ENV` 等） |

## 文档

| 文件 | 内容 |
|---|---|
| [docs/USAGE-GUIDE.md](docs/USAGE-GUIDE.md) | **从零跑通一次实验**（配端点 → 装环境 → 基线 → 实验 → 读结果） |
| [docs/AGENT-API.md](docs/AGENT-API.md) | **给 Agent 的接口契约**：`nextAction` 全部形态 + 可跑完的最小脚本 |
| [docs/README.md](docs/README.md) | 完整用法、架构、扩展指南 |
| [docs/FINDINGS.md](docs/FINDINGS.md) | 实测结论 + 6 个产品缺陷（含证据） |
| [docs/PITFALLS.md](docs/PITFALLS.md) | **改套件前必读**：29 个踩过的坑（含 3 个已过期的 —— 过期本身也是教训） |
| [docs/REAL-CORPUS.md](docs/REAL-CORPUS.md) | **真实语料实测**：为什么实际使用中很少看到共识/画像/日历 |

## 五个套件

| 套件 | 命令 | 测什么 |
|---|---|---|
| 记忆面 | `node suites/families.mjs` | 共识 / 人侧观察 / 承诺 / 日历 / 事件归属 / 日志 / 技能库，含 4 个负路径（**明示触发**） |
| 交接账本 | `node suites/handoff.mjs` | 20 条自包含任务 × 产品判据 H1–H4 |
| 接续仪式 | `node suites/ritual-run.mjs` | 多步工具编排（**必须真调工具**） |
| 对抗 ablation | `node suites/ablation.mjs` | 指令 vs 工具回执，谁更有权威 |
| **隐性触发** | `node suites/implicit.mjs` | **不给任何工具名提示，看模型会不会自己想起要写** |

### 外部基准校准（新增）

本套件的判据是自己设计的 —— 最大的盲区是「只测到了我们想到的东西」。
外部基准补这个：它们的考点从真实使用归纳，且带结构化判据。

| 基准 | 我们原本覆盖 | 跑法 |
|---|---|---|
| [Ornn8](https://github.com/Ornn8/memory-system-benchmark)（27 考点） | **7 / 27** | `node suites/external.mjs --bench ornn8 --only-missing` |
| [LongMemEval](https://github.com/xiaowu0162/LongMemEval)（7 类） | **2 / 7** | `node suites/external.mjs --bench lme --only abstention,knowledge-update` |

数据不随仓库分发（许可/体积/版本漂移）。准备方式与全部边界见
[docs/EXTERNAL-BENCHMARKS.md](docs/EXTERNAL-BENCHMARKS.md)。

⚠️ 三条硬边界：只接**公开示例**（正式卷不公开）、用**单轮**接法（不是官方的回放口径）、
用**规则判分**（官方是 GPT-4o 裁判）⇒ **不能宣称与官方榜可比**。

### 诊断工具

| 命令 | 用途 |
|---|---|
| `node lib/selftest.mjs` | 判分器 + 环境层 + **自变量完整性**（39 项，改判分逻辑前后必跑） |
| `node setup/verify-overrides.mjs` | **改了提示词层后必跑**：证明覆盖真的进了模型上下文（3 个用例） |
| `node setup/verify-external-judges.mjs` | 外部判据离线自检（18 项，不花额度） |
| `node lib/lint.mjs` | 产品契约漂移检查 |
| `node lib/corpus-real.mjs` | 扫真实会话，统计各类记忆写入的实际频率 |
| `node lib/fill-rate.mjs` | 按事件统计各记忆面的结构化填充率 |
| `node lib/report.mjs` | 汇总所有套件结果 + 哨兵违规 |

### 三个层次的测试

```
表达层   families / handoff      给了明确指令，能不能按格式写对    → 100%
察觉层   implicit                不给指令，会不会自己想起要记      → 100%
通道层   corpus-real             记住了，但走哪个通道              → 几乎不走感知参数（0/162）
```

**第三层是当前的真正缺口** —— 详见 [docs/REAL-CORPUS.md](docs/REAL-CORPUS.md)。

## 安全边界

**最高纪律：绝不写真实记忆库。** 四层防线：

1. 配置隔离（`memoryRoot` 显式改成沙箱绝对路径 —— `~` 会被 `os.homedir()` 展开，`DSH_HOME` 拦不住）
2. 文件系统沙箱（`workspace-write`，越界写被拒）
3. 升级路径封死（headless 无审批通道，`danger-full-access` 失败关闭）
4. 完整性哨兵（每次任务前后全量 sha256，真实库 / 产品代码 / 提示词面任何变化都记为违规）

## 已验证

- 套件自检 **52/52 通过**（环境层 + 判分层 + 自变量完整性；关键守卫做过**变异测试**）
- 产品契约漂移检查 **无漂移**
- 入口自适应：桌面版（`.cmd` → exe + asar 内 cli.js）与 npm 版（`node bin.js`）**都能跑通**
- **提示词覆盖链验证**：6 层同时覆盖 → 标记全部进入模型上下文；变体之间不残留
- 端到端实跑：`families --only calendar,sharedGround` → **5/5 通过**，违规 0
- 历史完整运行：约 120 次 headless 会话，**违规 0**（哨兵白名单覆盖宿主心跳）
