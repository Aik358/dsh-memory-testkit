# 使用指导 · 从零跑通一次提示词实验

> 面向：给 DSH Auto Memory 做提示词工程的社区贡献者
> 前提：你**已经装好** DeepSeek Harness 插件并会用它（本套件不教你用 DSH）

---

## 0. 这套东西解决什么问题

提示词改一句，效果变好还是变坏？凭感觉说没用。要回答它，至少需要：

| 需要 | 本套件提供 |
|---|---|
| 隔离环境（不能写到你真实记忆库） | 沙箱 + 完整性哨兵，逐文件 sha256 比对 |
| 可复现的判定 | 按记忆面判分，判据可复算 |
| 批量多臂对比 | 声明式实验，一次跑多个提示词版本 |
| 看得见模型到底做了什么 | 逐条输出监控台 + 完整会话日志 |

**为什么不能直接在自己用的 DSH 里试**：宿主本身会往记忆库写东西（日志、反思、索引），
你的提示词改动会和这些写入混在一起，事后分不清是改动的效果还是噪声。
更重要的是：一旦提示词让模型写坏了真实记忆，那个损失不可逆。

---

## 1. 你需要的三样东西

| 依赖 | 门槛 | 说明 |
|---|---|---|
| DeepSeek Harness | ≥ `0.2.1-rc.5` | 低于这个版本 profile/patch 机制不同，跑不起来 |
| dsh-auto-memory | ≥ `3.4.0-alpha.1` | 套件的判据与工具面按此版本编写 |
| 一个模型端点 | 任何 OpenAI 兼容端点 | 官方 / 自建 / 中转都行，见 §2 |

Node.js ≥ 22。

### 入口不用你手填

套件会**自动探测**：收集全部候选 → 比较版本 → 选达标的最新。

如果你机器上同时装了桌面版和 npm 版，它会选版本高的那个，并把其余候选列出来。
想强制指定就设 `TESTKIT_DSH_BIN`（会用你指定的那个，哪怕版本不达标）。

---

## 2. 配模型端点（唯一必须手填的东西）

复制模板：

```bash
cp testkit.config.example.json testkit.config.json
```

然后编辑 `testkit.config.json` 的 `provider` 段：

```json
{
  "provider": {
    "name": "main",
    "api": "openai-chat",
    "baseURL": "https://api.deepseek.com/v1",
    "apiKeyEnv": "DSH_MODEL_API_KEY",
    "model": "deepseek-chat",
    "contextWindow": 128000,
    "maxTokens": 8192
  }
}
```

| 字段 | 含义 | 注意 |
|---|---|---|
| `name` | provider 标识 | 字母数字下划线连字符，会写进 profile |
| `api` | 协议 | `openai-chat` / `openai-responses` / `anthropic` |
| `baseURL` | 端点根 | **填根，不要带 `/chat/completions`**；留空用官方默认 |
| `apiKeyEnv` | 密钥所在环境变量名 | 只填变量名，**不要把 key 写进这个文件** |
| `model` | 模型 id | 透传给端点 |
| `contextWindow` / `maxTokens` | 容量 | 按端点实际情况填 |

**`testkit.config.json` 已 gitignore**，你可以在里面写私有域名。

不想用文件也行，改用环境变量：

```bash
export TESTKIT_PROVIDER_NAME=main
export TESTKIT_PROVIDER_API=openai-chat
export TESTKIT_PROVIDER_BASE_URL=https://your-endpoint/v1
export TESTKIT_PROVIDER_MODEL=your-model
export TESTKIT_PROVIDER_API_KEY_ENV=YOUR_API_KEY
```

> 优先级：环境变量 > 配置文件 > 中性默认值。
> 界面上每个字段旁边的小标签会告诉你这个值是从哪来的。

### 密钥放哪

套件**不存密钥**，只记「去哪个环境变量取」。两种做法：

1. 直接在 shell 里 `export YOUR_API_KEY=...`
2. 让 DSH 的凭证服务管（`dsh` 的 `.credentials.yaml` 的 `refs` 段）

第二种的好处是换机器不用重配；`lib/driver.mjs` 会在起子进程时自动从沙箱凭证里取。

---

## 3. 四步装好环境

```bash
node lib/setup-ui.mjs          # 打开 http://127.0.0.1:8893
```

页面上有四个步骤，**任一步失败可以单独重试**，失败时会给你可复制的命令：

| 步骤 | 做什么 | 需要人做什么 |
|---|---|---|
| ① 环境自检 | 探测 DSH、插件版本、沙箱目录 | 无 |
| ② 沙箱权限 | Windows 需要目录 ACL 含 `WRITE_DAC` | **要你点 UAC 确认**（Agent 替不了） |
| ③ 建 profile | 建 `profiles/memexp` + `pnpm install` | 无 |
| ④ 冒烟验证 | 起一次真实会话问模型「回一个词」 | 无 |

第 ④ 步很重要：它验证「入口 → profile → 凭证 → 模型」整条链。
跳过它直接跑实验，可能在跑了 20 分钟后才发现认证是错的。

**非 Windows 用户**：不需要第 ② 步，页面会自动跳过并说明原因。

### 也可以纯命令行

```bash
node setup/preflight.mjs                    # 10 项检查，每项给修法
node setup/env-report.mjs                   # 只看探测到了什么（只读，可反复跑）
node setup/init-profile.mjs                 # 建 profile
node setup/verify-overrides.mjs             # 验证提示词覆盖真的生效
```

---

## 4. 跑第一批套件（建立基线）

先别急着做实验，先确认「在**不改任何提示词**的情况下，模型表现如何」：

```bash
node suites/families.mjs --only sharedGround,calendar --cc 2
```

看到类似这样的输出就是对的：

```
families-default  通过 5/5 (100%)  超时 0  违规 0  平均 32s
```

**`违规 0` 是硬要求。** 如果不为 0，先看 `sentinel/` 下的报告，别往下走 —— 那意味着
有东西改到了不该改的地方。

五个套件分别测什么：

| 套件 | 命令 | 测什么 |
|---|---|---|
| 记忆面 | `suites/families.mjs` | 共识 / 用户画像 / 承诺 / 日历 / 事件 / 日志 / 技能库 |
| 交接账本 | `suites/handoff.mjs` | 20 条任务 × 产品判据 H1–H4 |
| 接续仪式 | `suites/ritual-run.mjs` | 多步工具编排（真调工具） |
| 对抗 ablation | `suites/ablation.mjs` | 指令 vs 工具回执，谁更有权威 |
| 隐性触发 | `suites/implicit.mjs` | 不给工具名提示，模型会不会自己想起要写 |

---

## 5. 做一次提示词实验

### 5.1 先搞清楚「哪些层能改」

```bash
node setup/env-report.mjs
```

或直接看向导页面，它会显示：

```
提示词层注册表（29 层）
  slim     8 层 —— 仅在精简版帧出现
  dynamic 21 层 —— 每轮动态快照
  static   1 层 —— 固定纪律
  死键     staticHead, staticWriteDiscipline
```

**死键改了完全无效**（代码里没有读取点）。套件会在校验阶段直接拦下这类配置。

### 5.2 写一份实验配置

在 `experiments/` 下新建 `.mjs`：

```js
export default {
  name: 'my-first-experiment',
  suite: 'families',
  scenarios: ['sg-strong', 'cm-promise', 'cal-explicit'],
  reps: 5,
  concurrency: 2,
  arms: {
    base: {},                                  // 不覆盖任何层 = 基线
    mine: {
      cadence: { snapshotMinGapRounds: 20, slimEveryRounds: 8 },
      layers: {
        staticPerceptDiscipline: '你的改写文本…',
      },
    },
  },
}
```

### 5.3 ★关键：先校验，不跑

```bash
node experiments/run.mjs my-first-experiment --dry-run
```

校验器会拦下三类**会让你白跑**的配置：

| 错误码 | 含义 |
|---|---|
| `unknown-layer` | 层名拼错了 |
| `dead-layer` | 这一层没有消费点，改了无效 |
| `unreachable-layer` | **该层所在的注入路径，被你设的节奏关掉了** |
| `unknown-scenario` | 场景 id 拼错了（会静默少跑） |
| `arms-identical` | 所有臂配置一样，没有自变量 |

`unreachable-layer` 值得单独说明：

```
臂 mine：层 "snapshotSlimMaintain" 只属于 [slim] 路径，
而该臂节奏让这条路径不可达 —— 改了等于没改
  → slim：snapshotMinGapRounds=0 表示每轮都发完整版 ⇒ 精简版分支永不触发
```

这类错误如果不拦，实验会跑完、会出报告、会全绿，但**你测的不是你以为的东西**。

### 5.4 跑

```bash
node experiments/run.mjs my-first-experiment
```

结果会打印每个臂的通过率，以及**预先算好的臂间对比**：

```
臂间对比（以第一个臂为基线）:
  base → mine: +20.0 pp（10 vs 10 条；2/5 个场景有差异）
      sg-strong        60% → 80%
      cm-promise       40% → 60%
```

### 5.5 读结论前先看这些警告

结果里会带 `warnings`，**不要忽略**：

| 警告 | 为什么重要 |
|---|---|
| `low-reps` | `reps < 3` 时差异可能全是采样噪声 |
| `single-rep` | 单次重复不足以支撑结论 |
| `suspicious` | 宿主活跃期间真实库有写入，需人工确认是否干扰 |
| `incomplete` | 有条目没跑完，比例不可比 |

`reps=5` 是能开始谈差异的起步值。

---

## 6. 看模型到底做了什么

```bash
node lib/server.mjs        # http://127.0.0.1:8899
```

五个页签：

| 页签 | 看什么 |
|---|---|
| 总览 | 各套件通过率、污染、违规计数 |
| **Agent 实时输出** | **逐条输出：思考 / 工具调用 / 工具结果 / 正文** |
| 任务流 | 每条任务的判定与账本开头 |
| 完整性哨兵 | 真实库 / 产品代码 / 提示词面有没有被改 |
| 提示词面 | 运行时探测到的层清单与实际字数 |

**「Agent 实时输出」是最有用的**。模型写了什么、为什么没写、被拒绝后怎么改 ——
全在这里。判分只给你一个 PASS/FAIL，这里是理由。

---

## 7. 安全边界：你能确认什么

每次任务前后，哨兵会对三处做全量 sha256 快照：

| 面 | 变化意味着 |
|---|---|
| 真实 home（`~/.dsh/memory` 等） | 见下面三级分类 |
| 产品代码（`<repo>/lib`） | 红线，任何改动都报 |
| 沙箱记忆库 | 合法，但逐条列出供你审计 |

真实 home 的变化分三级，**报告里分别计数**：

| 级别 | 判据 |
|---|---|
| 白名单 | 宿主心跳 / 证据流 / 语义索引等运行态 |
| 可疑 | 宿主进程活着，且变化不落在 agent 写入面 |
| **违规** | 其余（含所有 agent 写入面：workspaces / user / CALENDAR / episodes / 反思 / 日志） |

为什么要分级：宿主本身一直在写（用户正开着它用），不区分会报几十条假警报，
把真信号淹掉。但 **agent 写入面永远不会因为「宿主活跃」而降级** —— 那正是被测的地方。

---

## 8. 常见问题

**Q：跑出来 `违规 > 0` 怎么办**
先看 `sentinel/` 下对应报告里的 `violations` 明细。如果是产品代码被改，那是硬问题。
如果是真实库，看 `hostActive` —— 宿主活着的话很多写入是它干的（会记在 `suspicious`）。

**Q：实验跑完两个臂完全一样**
先跑 `--dry-run` 看有没有 `unreachable-layer`。其次是 `reps` 太小 —— 单次重复很容易完全相同。

**Q：改了提示词但模型行为没变**
先跑 `node setup/verify-overrides.mjs`。它会写带标记的覆盖，起一次多步会话，
再从会话日志里 grep 那些标记 —— 能确凿回答「覆盖到底进没进模型上下文」。

**Q：能不能在不改产品代码的前提下测任意层**
能，但只有**有消费点**的层。`staticPerceptDiscipline` / `staticCalendarDiscipline`
是产品专门拆出来供实验的；其余静态段（`renderMemoryStatic` 里约 7,900 字符）仍硬编码。
想测那些，必须改产品代码 —— 那超出本套件的纪律范围。

**Q：判分器自己是准的吗**
`node lib/selftest.mjs`（46 项）覆盖判分逻辑、环境探测、自变量完整性。
关键守卫做过**变异测试**（故意注入错误，确认它真会红）—— 因为「测试自己是绿的」
是最不可信的一种绿。

---

## 9. 一页速查

```bash
# 装环境
node lib/setup-ui.mjs                 # 向导 8893
node setup/preflight.mjs              # 体检（10 项）
node setup/env-report.mjs             # 只读探测

# 跑套件
node suites/families.mjs --cc 2       # 7 个记忆面
node suites/handoff.mjs               # 交接账本
node suites/implicit.mjs              # 隐性触发

# 做实验
node experiments/run.mjs <name> --dry-run    # 先校验
node experiments/run.mjs <name>              # 再跑

# 看结果
node lib/server.mjs                   # 监控台 8899
node lib/report.mjs                   # 汇总表

# 自检（改任何东西之前/之后都该跑）
node lib/selftest.mjs                 # 46 项
node setup/verify-overrides.mjs       # 提示词覆盖链
node setup/scan-secrets.mjs           # 发布前脱敏
```
