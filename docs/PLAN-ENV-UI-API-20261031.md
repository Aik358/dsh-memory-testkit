# 规划 · Testkit 环境自适应 + 引导前端 + Agent 接口

> 生成：2026-10-31
> 目标：让社区开发者在「装好 DSH 0.2.1-rc.5+ 与插件 3.4.0-alpha.1+」之后，无需手填路径即可使用；
> 并提供前端向导与完整 HTTP 接口，供人和 Agent 两条腿使用。

---

## §0 一句话

**把「4–5 步手工前置」压成「装好两个包 → 打开一个页面 → 点开始」**，
同时把同样的能力以 HTTP 接口暴露，让 Agent 能全自动跑实验。

---

## §1 现状与差距（实测）

### 1.1 现在必须手填的东西

| 项 | 现状 | 谁来提供 |
|---|---|---|
| `DSH_BIN` | **硬编码我本机绝对路径** | 使用者必须设 `TESTKIT_DSH_BIN` |
| `REPO`（插件仓库） | 默认 `<repo>` | 使用者必须设 `TESTKIT_REPO` |
| DSH 运行时 | **完全没有** | 使用者自己 `npm i -g` |
| profile 目录结构 | 没有 | `init-profile.mjs` 往里填 |
| Windows ACL | 没有 | 使用者手动跑提权脚本 |

### 1.2 实测探测可用的事实

```
DSH 入口（桌面版）  G:/dsh_desktop/resources/runtime/cli/bin/dsh.cmd
                     └ 内部转调 app.asar 里的 dsh-desktop-host/lib/cli.js
                     └ --version 实测 = 0.2.1-rc.5   ← 实际在用的版本

DSH 入口（npm 版）  ~/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js
                     └ package.json version 实测 = 0.2.0-rc.2  ← 旧的、已不用

which dsh           /c/Users/<user>/AppData/Roaming/npm/dsh    ← ★解析到旧版本
npm root -g         C:\Users\<user>\AppData\Roaming\npm\node_modules
```

### 1.2bis ★关键坑：`which dsh` 会解析到旧版本

实测 PATH 顺序：

```
第 29 位  /g/dsh_desktop/resources/runtime/cli/bin     ← 新（0.2.1-rc.5）
第 45 位  /c/Users/<user>/AppData/Roaming/npm            ← 旧（0.2.0-rc.2）
```

**但 `which dsh` 只返回第一个命中 —— 也就是旧的那个。**

⇒ **探测不能「取第一个找到的」，必须「找出所有候选 + 比较版本 + 优先选满足门槛的最新版」。**

这条是我上一版规划里的真缺陷：如果按「which 优先」实现，在你的机器上会选中 0.2.0-rc.2，然后错误地报告「版本不达标」。

### 1.3 已知不合规（你的本机）

```
要求        DSH >= 0.2.1-rc.5
实测本机    DSH = 0.2.0-rc.2      ← 未达门槛
要求        插件 >= 3.4.0-alpha.1
实测本机    插件 = 3.4.0-alpha.1   ← 达标
```

⇒ 向导第一屏就要把这条摆出来，而不是等跑实验时才炸。

---

## §2 设计原则

| # | 原则 | 理由 |
|---|---|---|
| P1 | **先探测、再询问、最后才要求手填** | 能自动拿到的绝不让人填 |
| P2 | **版本不达标要「早失败 + 可执行修法」** | 不要等 20 分钟后才报 `pending (waiting for service: webServer)` |
| P3 | **人用前端、Agent 用接口，同一套逻辑** | 避免两套实现漂移；前端只是接口的消费者 |
| P4 | **不内置 DSH** | 用 `0.2.1-rc.5+` 这种 RC 版本做 pin 会造成版本冲突；探测比内置稳 |
| P5 | **每个接口返回机器可读的 `nextAction`** | Agent 需要知道「下一步该调哪个接口」，而不是解析中文错误 |

---

## §3 环境自适应层（`lib/env.mjs`）

### 3.1 探测策略：**收集所有候选 → 比较版本 → 选最优**

⚠️ 不能「取第一个找到的」。实测本机 `which dsh` 解析到的正是旧版本（0.2.0-rc.2），
而实际在用的是桌面版（0.2.1-rc.5）。

```js
// 阶段 1：收集（不判断，全都找出来）
const candidates = []

1. process.env.TESTKIT_DSH_BIN            显式覆盖 → 标记 source:'env'，最高优先
2. which -a dsh / where dsh               遍历**所有**命中（不是只取第一个）
3. npm root -g + '/@deepseek-ai/dsh'
4. 套件自己 node_modules
5. 已知桌面/常见安装前缀：
   - %LOCALAPPDATA%/*/resources/runtime/cli
   - ~/AppData/Roaming/npm
   - /usr/local/lib/node_modules
   - /opt/homebrew/lib/node_modules

// 每个候选取版本
readVersion(c) = 从 package.json 读 version
                ↳ 桌面版是 .cmd 包壳，读不到 package.json ⇒ 用 `--version` 子进程探测

// 阶段 2：选优
sortBy(candidates, (a,b) => cmpVer(b.version, a.version))   // 版本降序
picked = candidates.find(c => cmpVer(c.version, REQUIREMENTS.dsh.min) >= 0)  // 优先满足门槛的最新
      ?? candidates[0]                                       // 都不满足则取最新，标记不达标

// 阶段 3：诚实报告
if (candidates.length > 1) {
  warn('发现多个 DSH 安装，已选用 <picked>，其余：<列表及版本>')
}
```

### 3.2 桌面版与 npm 版的探测差异

| 形态 | 入口 | 怎么取版本 |
|---|---|---|
| npm 全局/本地包 | `.../@deepseek-ai/dsh/lib/bin.js` | 读同目录 `package.json.version` |
| 桌面版（Electron 打包） | `.../runtime/cli/bin/dsh.cmd` | **读不到 package.json**（在 app.asar 内）⇒ 跑 `dsh.cmd --version`（实测输出 `0.2.1-rc.5`，约 15s） |

⇒ 探测要支持「子进程问版本」这条路径，并缓存结果（避免每次 preflight 都等 15 秒）。

### 3.2 版本解析与门槛

```js
function parseVer(v)  // '0.2.1-rc.5' → { major:0, minor:2, patch:1, pre:'rc.5', preNum:5 }
function cmpVer(a, b) // 支持预发布号比较（rc.5 > rc.2 > beta）
```

**门槛常量集中一处**：

```js
export const REQUIREMENTS = {
  dsh: { min: '0.2.1-rc.5', reason: '插件 3.4.0-alpha.1 依赖 0.2.1 的 profile/bundle 机制' },
  plugin: { min: '3.4.0-alpha.1', reason: '套件的判据与工具面按此版本编写' },
}
```

### 3.3 探测结果形状（人机共用）

```js
{
  ok: true,
  dsh: {
    bin: 'C:/Users/.../dsh/lib/bin.js',
    version: '0.2.1-rc.5',
    source: 'global-npm',        // 说明从哪找到的
    meetsRequirement: true,
  },
  plugin: {
    repo: 'D:/my-fork/dsh-auto-memory',
    version: '3.4.0-alpha.1',
    meetsRequirement: true,
  },
  platform: { os: 'win32', needsElevation: true, elevated: false },
  sandbox: { writable: true, tempOk: true, aclOk: true },
  installCommand: null,
  warnings: [],
  nextAction: { kind: 'ready' },   // 或 { kind:'install', command:'…' }
}
```

### 3.4 平台分支

| 平台 | 沙箱机制 | 提权 |
|---|---|---|
| Windows | `dsh-sandbox-windows-acl`（需 `WRITE_DAC`） | **需要**，`elevate.ps1` |
| macOS / Linux | POSIX 权限，无需 ACL 编辑 | 不需要 |

⇒ `needsElevation` 为 `false` 时，前端跳过提权步骤并说明原因。

---

## §4 前端向导（`lib/setup-ui.mjs`，端口 8893）

### 4.1 为什么单独一个进程

现有 `server.mjs` 是**跑实验时**的监控台（8899）。
装环境发生在**跑实验之前**，且失败时要能反复重试。分开放更清晰。

### 4.2 四步向导

```
┌─ 步骤 1 · 环境自检 ────────────────────────────┐
│ ✓ DSH 0.2.1-rc.5   （自动发现：全局 npm）      │
│ ✓ 插件 3.4.0-alpha.1（D:/my-fork/…）           │
│ ✗ Windows 沙箱权限：需要提权                    │
│   [ 提权授予 ]  ← 弹 UAC                        │
│   └ 或：复制命令手动执行                        │
│ 平台：Windows · 提权仅 Windows 需要             │
└────────────────────────────────────────────────┘
              ↓
┌─ 步骤 2 · 建实验 profile ───────────────────────┐
│ profile 名  [memexp        ]                    │
│ 会用你的插件副本：D:/my-fork/dsh-auto-memory    │
│ [ 创建并安装 ]                                   │
│ ▸ 实时日志：pnpm install …                      │
└────────────────────────────────────────────────┘
              ↓
┌─ 步骤 3 · 沙箱与隔离验证 ───────────────────────┐
│ ✓ 记忆库已隔离到 <work>/memory              │
│ ✓ 越界写入被拒                                  │
│ ✓ 插件已激活（21 tools）                        │
│ [ 跑一次冒烟 ]                                   │
└────────────────────────────────────────────────┘
              ↓
┌─ 步骤 4 · 开始 ────────────────────────────────┐
│ [ 打开监控台 ]  [ 看快速上手 ]                   │
└────────────────────────────────────────────────┘
```

### 4.3 交互要点

- **每一步可单独重试**（不要求从头来）
- **失败时给可复制的命令**，而不只是红叉
- **所有路径都可改**（探测给默认值，人可覆盖）
- 版本不达标时**首页就红**，并给出升级命令

---

## §5 Agent 接口（`/api/setup/*`）

### 5.1 设计约束

- 全部 **loopback only**（与现有 server 一致）
- 每个响应都带 `nextAction`，Agent 不需要解析中文
- **有状态但可重入**：任何一步都可以重复调用，幂等

### 5.2 接口表

| 方法 | 路径 | 作用 | 关键返回 |
|---|---|---|---|
| GET | `/api/setup/detect` | 探测环境 | 见 §3.3 的完整形状 |
| GET | `/api/setup/requirements` | 门槛常量 | `{ dsh:{min}, plugin:{min} }` |
| POST | `/api/setup/elevate` | 触发提权（仅 win32） | `{ ok, elevated }` |
| POST | `/api/setup/profile` | 建 profile + `pnpm install` | `{ ok, profileDir, log }` |
| POST | `/api/setup/smoke` | 冒烟（起一次 headless） | `{ ok, tools, seconds }` |
| GET | `/api/setup/state` | 四步各自状态 | `{ steps:[{id,ok,detail}] }` |
| GET | `/api/setup/plan` | **机器可执行的动作计划** | 见下 |

### 5.3 `nextAction` 的几种形态

```js
{ kind: 'ready' }
{ kind: 'install-dsh',  command: 'npm i -g @deepseek-ai/dsh@latest', url: '…' }
{ kind: 'upgrade-dsh',  have: '0.2.0-rc.2', need: '0.2.1-rc.5', command: '…' }
{ kind: 'set-plugin',   reason: '未找到插件仓库', hint: '设 TESTKIT_REPO' }
{ kind: 'elevate',      command: 'powershell -File setup/elevate.ps1', needsUserClick: true }
{ kind: 'init-profile' }
{ kind: 'run-smoke' }
```

**`needsUserClick: true` 是关键** —— Agent 要能识别「这一步我替不了人」，而不是无限重试。

---

## §6 实验接口（面向提示词工程）

### 6.1 声明式实验配置

```js
// experiments/percept-tuning.mjs
export default {
  name: 'percept-discipline-tuning',
  description: '把四类感知的触发条件换成句式表，看填充率是否上升',

  // ★多变量：每个臂可以改多个提示词层
  arms: {
    base: {},
    sentenceTable: {
      staticPerceptDiscipline: '…句式表文本…',
      snapshotSlimMaintain: '…',
    },
    longPrompt: {
      staticPerceptDiscipline: '…更长的版本…',
    },
  },

  scenarios: ['sg-strong', 'sg-weak', 'cm-promise', 'cm-intent'],
  judge: 'families',           // 内置判据名，或 { file: './my-judge.mjs' }
  reps: 5,
  concurrency: 3,
}
```

### 6.2 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/exp/list` | 列出 `experiments/*.mjs` |
| POST | `/api/exp/validate` | 只校验配置，不跑 |
| POST | `/api/exp/run` | 跑，返回 `runId` |
| GET | `/api/exp/run/{id}` | 轮询进度与结果 |
| GET | `/api/exp/run/{id}/stream` | SSE 逐条推送 |
| POST | `/api/exp/run/{id}/cancel` | 中止 |
| GET | `/api/exp/runs` | 历史列表 |

### 6.3 结果形状（Agent 可直接算显著性）

```js
{
  runId, name, status: 'running'|'done'|'failed',
  progress: { done: 12, total: 25 },
  arms: {
    base:           { pass: 4, n: 5, rate: 0.8, detail: [...] },
    sentenceTable:  { pass: 5, n: 5, rate: 1.0, detail: [...] },
  },
  // ★预先算好的对比，Agent 不必自己统计
  comparisons: [
    { a:'base', b:'sentenceTable', delta: +0.2, n:5, note:'样本量小，仅供参考' },
  ],
  violations: 0,
}
```

---

## §7 实施批次

> **进度（2026-11-03 更新）**：批次 1 / 2 / 3 / 5 已完成并实测通过；
> 批次 4 未做（见下方「为什么批次 4 暂缓」）。

### 批次 1 · 环境自适应 ✅ 已完成

- [x] `lib/env.mjs`：入口探测 + 版本解析 + 门槛判断 + 平台分支
- [x] `lib/config.mjs` 改成调用 `env.mjs`（`DSH_BIN` 不再硬编码）
- [x] `setup/preflight.mjs` 改用 `env.mjs`，输出结构化结果（`--json` 给 Agent）
- [x] `lib/selftest.mjs` 加 8 项断言（比原计划多 2 项）
- [x] **额外**：`lib/driver.mjs` 支持三种入口形态（原计划未预见 —— 见下）

**验收**：删掉所有 `TESTKIT_*` 环境变量，`node setup/preflight.mjs` 仍能找到 DSH 并正确报出版本。**已实测通过。**

#### 实施中与原计划的差异（都是实测后才发现的）

| 原计划假设 | 实测真相 |
|---|---|
| 子进程问版本约 15s，要缓存 | **0.22–0.31s**。缓存仍然做（避免每次进 preflight 都起进程），但不是性能刚需 |
| `which -a dsh` 能列出全部候选 | **不能**。Git Bash 的 `which` 不认 `.cmd` 为可执行 ⇒ 只见 npm 旧版；`where` 才是全的。**两者都要跑** |
| 探测到入口后，`spawn(node, [bin])` 即可 | **不够**。桌面版入口是 `.cmd`，里面有 exe + asar 内 cli.js；Node 24 spawn `.cmd` 直接 EINVAL。新增 `resolveRunner()` 解析 `.cmd` 内容 |
| 同一份沙箱 `DSH_HOME` 两个入口凭证行为一致 | **不一致**。npm 版读 `.credentials.yaml`；桌面版报 `MISSING_CREDENTIAL`，必须注入环境变量。新增 `credentialEnv()` |
| 原计划只列 6 项自检 | 实做 **8 项**：多出「`.cmd` 解析逐项验证」与「provider 需求可读出」 |

### 批次 2 · Setup 向导前端 ✅ 已完成

- [x] `lib/setup-ui.mjs`：HTTP 服务 + 四步向导页面（端口 8893）
- [x] `lib/setup-state.mjs`：四步状态机（可重入、可重试）—— 文件名与计划不同
- [x] 提权按钮（Windows）与非 Windows 的跳过分支
- [x] 每步失败给**可复制的命令**，不只红叉

**验收**：浏览器四步走完能跑出一次冒烟；任一步失败可单独重试。**已实测通过（冒烟 9.1s 返回 OK）。**

### 批次 3 · Agent 接口 ✅ 已完成

- [x] `/api/setup/*` 七个接口（detect / requirements / state / profile / elevate / smoke / logs）
- [x] 每个响应带 `nextAction`（11 种形态，含 `needsUserClick`）
- [x] `docs/AGENT-API.md`：给 Agent 读的接口契约 + 可跑完的最小脚本 + 常见失败处置

**验收**：`AGENT-API.md` §4 里的最小脚本可直接跑。**已手工核对该脚本与本实现的响应形状一致。**

### 批次 4 · 实验声明层 ⏸ 暂缓（前置条件已修好）

- [ ] `experiments/` 目录 + 配置加载器
- [ ] 多变量 → 多臂执行
- [ ] `judge` 可插拔
- [ ] `/api/exp/*` 六个接口

#### 补做的前置修复（2026-11-03，用户要求）

原计划写「先跑一次真实多变量实验看清可调面，再抽象配置格式」。
我跳过了「看清可调面」这一步就下了「变量不够多」的结论 —— 实测证明只有一半成立：

| 我原来的说法 | 实测 |
|---|---|
| 可改的层太少 | **错**。29 层里 26 层有消费点，占 98% 字符（4,424/4,518）；死键只有 `staticHead`(79) + `staticWriteDiscipline`(15) |
| 一半变量改不动 | **对，而且更糟**。`snapshotMinGapRounds: 0` 让 5 个精简版层**根本不渲染**，改了等于没改且不报错 |

已修三处（详见 PITFALLS #27/#28/#29）：

1. **`BASELINE_CFG`（lib/runner.mjs）**：钉产品默认 `gap=20 / slim=8 / tiered=true / inject=true`，
   取代各套房各自硬编码的 `snapshotMinGapRounds: 0`（9 处已清）
2. **`patchConfig` 从基线出发**：每次先重置全部变体控制键再叠补丁，
   `promptLayerOverrides` 整块替换。新增 `currentVariantSurface()` 供报告核对实际生效配置
3. **`setup/verify-overrides.mjs`**：改提示词层后的强制验收 —— 写标记 → 多步会话 → 从会话日志 grep，
   3 个用例（多层同时覆盖 / 仅精简版层隔离 / 变体不残留）

**验收数据**（同一多步任务 4 step）：

| 用例 | 结果 |
|---|---|
| A 六层同时覆盖 | 6/6 标记进上下文，完整版 + 精简版路径都出现 |
| B 仅精简版 3 层 | 3/3 命中；块长 675 vs 完整版 5,161 ⇒ 精简版确实在跑 |
| C 变体残留 | noinject 后跑 default，`injectEnabled` 回到 true |

**顺带发现并修复的测试框架缺陷**：`t()` 不 await ⇒ 所有 `async` 测试从未执行却报「通过」。
用变异测试才发现（注入 `gap:0` 后守卫仍是绿的）。见 PITFALLS #29。

#### 批次 4 现在可以开工了，但要带一个约束

声明层必须能表达「**层 × 注入档位**」的配对关系，不能只写层名：
`snapshotSlimMaintain` 只在精简版帧出现，若臂配置里改了它却没让该臂产生精简版帧，
这次实验就是空跑。建议配置形态：

```js
arms: {
  base: {},
  sentenceTable: {
    // 显式声明节奏，让「哪些层会被渲染」成为实验设计的一部分
    cadence: { snapshotMinGapRounds: 20, slimEveryRounds: 8 },
    layers: { staticPerceptDiscipline: '…', snapshotSlimMaintain: '…' },
  },
}
```

并在 `POST /api/exp/validate` 里加一条硬校验：
**臂引用的层必须有消费点 + 该臂的注入节奏必须能让这条路径被走到**，
否则 validate 直接拒（把 PITFALLS #27 那类「静默空跑」变成启动即错）。

### 批次 5 · 文档 ✅ 已完成

- [x] 社区版 README（「装好两个包就能跑」）
- [x] `docs/AGENT-API.md`
- [x] 版本门槛说明与不合规时的处理
- [x] `docs/PITFALLS.md` 补 5 条新坑（#22–#26），并把已过期的 #21 明确标注
- [x] `docs/FINDINGS.md` 补 §4.1「判分枚举漂移」（套件自身缺陷）
- [x] `setup/env-report.mjs`：只读探测报告（排查「为什么选了这个入口」）

### 额外完成（计划外）

- [x] `lib/judge.mjs` 枚举改为**运行时从产品源码读**（§8.1 的阻塞项，已提前解决）
- [x] 哨兵**三级分流**（违规 / 可疑 / 白名单）+ 宿主存活判别（见 PITFALLS #24）
- [x] 监控面板三处字段适配 bug 修复（合规率、陈旧「运行中」、提示词面运行时探测）
- [x] 自检从 22 项增至 **35 项**

---

## §8 必须先解决的两个隐患

### 8.1 枚举常量会漂移（阻塞批次 4）

`judge.mjs` 把产品枚举抄成了常量：

```js
export const PERCEPT_STAGES = ['retrieved','delivered','used','mentioned','accepted']
```

**实证**：我上次报告说 `staticPerceptDiscipline` 不存在，今天实测它已经存在了。
产品在快速演进，抄常量必然漂移。

⇒ 改成**运行时从产品源码读**：

```js
export async function readPerceptStages() {
  const src = fs.readFileSync(path.join(REPO, 'lib/event-store.js'), 'utf8')
  const m = src.match(/PERCEPT_STAGES\s*=\s*Object\.freeze\(\[([^\]]*)\]\)/)
  return m ? m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')) : null
}
```

读不到时**明确报错**，而不是用旧常量蒙混。

> **✅ 已落地（2026-11-03）**：`lib/judge.mjs` 现在用 `mustRead()` 读
> `PERCEPT_STAGES` / `EVENT_KINDS`（读不到抛错），用 `readWithFallback()` 读
> 产品不校验的 `PERCEPT_KINDS` / `COMMIT_STATES`（回落但如实标注来源）。
> 三个来源都通过 `ENUM_SOURCES` 暴露，自检有 3 项守卫盯着它。
> 详见 [FINDINGS §4.1](FINDINGS.md)。

### 8.2 本机版本：已达标（早前判断有误）

```
要求 DSH >= 0.2.1-rc.5
实测 桌面版 0.2.1-rc.5  ✅ 达标
     npm 版  0.2.0-rc.2  （旧安装，已不用）
```

**我最初误读了 npm 全局那份，报成 0.2.0-rc.2。实际在用的是桌面版，版本达标。**

⇒ 批次 2/3 的端到端验收**可以直接做**，不需要降门槛。

但这条也反过来证明 §3.1 的「多候选 + 选最优」不是多余的防御 ——
**本机就同时存在一个达标和一个不达标的安装，而 `which` 恰好指向不达标的那个。**
如果探测写成「取第一个」，验收入口就会选错。

---

## §9 不做的事

| 不做 | 理由 |
|---|---|
| 内置 DSH 运行时 | RC 版本做依赖会冲突；探测更稳 |
| 自动执行提权 | 必须人点 UAC，Agent 替不了（接口如实回 `needsUserClick: true`） |
| 支持 macOS/Linux 的完整沙箱验证 | 我无法实测；只做分支判断与提示，标注「未验证」 |
| 把实验配置做成 GUI 表单 | 提示词本身是长文本，代码编辑器比表单合适；GUI 只做「选配置 + 跑 + 看结果」 |
| 自动改用户的产品代码 | 违反「套件不改产品」的纪律 |
| ~~用 `shell:true` 兜底 `.cmd`~~ | 实测参数转义会静默失败（exit 0、零输出）。必须解析后直接 spawn exe |

---

## §10 一句话提醒

**这套东西的价值在于「让提示词工程的实验可复现」，而不是「让环境安装更省事」。**
因此批次的优先级是：环境自适应（必须）→ Agent 接口（核心价值）→ 实验声明层（真正解决批量问题）→ 向导前端（体验）。

如果只能做两批，选 1 和 4。

---

## §11 实施后记（2026-11-03）

做了 1 / 2 / 3 / 5，没做 4。三条值得记下来的判断：

**① 「多候选比版本」不是过度设计，是本机的必需品。**
`which -a dsh` 只给出 npm 旧版，`where dsh` 才是全的 —— 两条命令的列表不同。
若按「取第一个」实现，验收入口会永远报「版本不达标」，而模型、提示词、判据全都正常。

**② 「抄下来的事实」有保质期。**
上一份报告断言 `staticPerceptDiscipline` 不存在，两天后它已存在（产品加了 2 层）。
所以判分枚举改成运行时读、监控面板改成运行时 import ——
**不把数字写进代码，只写「去哪里读」**。

**③ 宿主活跃时哨兵会误报，而误报会淹掉真信号。**
一次套件报 44 项「违规」，全是宿主自己的 evidence/semantic/hub 写入。
修法不是加白名单了事（那会掩盖真越界），而是**三级分流 + 宿主存活判别**，
并让 agent 写入面永不降级。

**为什么批次 4 值得等**：声明层的价值取决于「有多少变量真的能改」。
现在能改的提示词层刚刚从 27 涨到 29（两节静态纪律拆出来），
剩下的静态段（7,909 字符里的大头）仍然硬编码。
先做声明层，很可能做出「配置写得很漂亮、一半变量改不动」的壳。
**建议路径**：先用现有 `suites/` 跑一次真正的多变量实验（四类感知 × 日历 × 技能库），
看清哪些层真的能调，再回来抽象 `experiments/*.mjs` 的格式。
