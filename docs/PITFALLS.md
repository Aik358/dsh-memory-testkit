# 踩过的坑（改套件前必读）

每一条都是实测撞出来的，平均花 20–40 分钟才定位。知道这些能省你半天。

---

## 一、环境与驱动

### 1. 插件在 headless 下永远 pending

```
dsh: warning: 1 entry did not activate
auto-memory-pre (@a9i5k4/dsh-auto-memory): pending (waiting for service: webServer)
```

**根因**：插件 `lib/index.js` 里 `export const inject = ['webServer','tools','systemPrompt','subagents','llm']`，而 `dsh-headless` 层不挂 Host/HTTP ⇒ `webServer` 服务不存在。

**修法**：patch 层补一行最小 webserver（`setup/init-profile.mjs` 已自动化）。

**症状的迷惑性**：命令 exit 0、输出正常、模型也回复了 —— 只是**一个记忆工具都没有**。所有相关测试都会静默失败。

### 2. `memoryRoot` 的 `~` 逃出 `DSH_HOME`

```js
// lib/index.js 的默认配置
memoryRoot: '~/.dsh/memory/workspaces',
```

```js
expandUserPath(p) {
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2))  // ← os.homedir()
}
```

**`DSH_HOME` 完全拦不住它** —— 会直接写进真实记忆库。

**修法**：显式覆盖成沙箱绝对路径。`setup/init-profile.mjs` 会做，`lib/lint.mjs` 每次检查。

### 3. 提权后沙箱反而崩

```
Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(C:\Windows\System32)
```

**根因**：`dsh-sandbox` 的 `writableRoots(policy)` 包含 `tmpdir()`。提权后 `TEMP` 变成 `C:\Windows\System32`，而该目录受 TrustedInstaller 保护 ⇒ `grantWrite()` 必然 Win32 error 5。

**症状极具误导性**：**连工作区内的正常写入都失败**，看起来像"沙箱坏了"，实际是"沙箱装不起来"。

**修法**：运行器强制把 `TEMP`/`TMP`/`TMPDIR` 指到可写目录（`lib/config.mjs` 的 `SANDBOX_ENV`）。

### 4. 未提权时 `grantWrite` 失败

`D:\` 下继承的权限是 `Authenticated Users:Modify`，**不含 `WRITE_DAC` / `WRITE_OWNER`**，而 ACL 沙箱要改 DACL + 完整性标签 ⇒ Win32 error 5。

**修法**：`setup/elevate.ps1`（会弹 UAC，一次性）。

### 5. Windows 上 `spawn` 的三个坑

| 写法 | 结果 |
|---|---|
| `spawn('dsh', [...], {shell:true})` | exit 0、0 秒、**无任何输出**（Git Bash 的 sh 把命令吃了） |
| `spawn('dsh.cmd', [...])` | `EINVAL`（Node 24 不允许直接 spawn .cmd） |
| `spawn(process.execPath, [binJs, ...])` | ✅ 唯一稳定路径 |

### 6. 路径里的 `\n` 被当转义

```js
dshCmd: 'C:\Users\...\npm\node_modules\...'
//                ↑ `\n` 在这里是换行符
// 报错：Cannot find module 'C:\Users<user>AppDataRoaming
pm
ode_modules...'
```

**纪律**：内部路径一律用正斜杠。

---

## 二、取数据

### 7. 会话日志是多帧 zstd

`session.v4.jsonl.zstd` 是**一帧一行**追加写的。单次 `zstdDecompressSync` 只能拿到第一行。

**修法**：按 magic `28 b5 2f fd` 切分后逐帧解压（`lib/driver.mjs` 的 `readSessionEvents`）。

### 8. 三种事件形状

| 来源 | 调用 | 结果 | callId 位置 |
|---|---|---|---|
| NDJSON | `{type:'tool_call', tool, input}` **平铺** | `{type:'tool_result', callId, result}` | `d.callId` |
| 会话日志 | `{type:'tool/call', data:{name, arguments}}` **嵌套** | `{type:'tool/result', data:{message:{...}}}` | `d.message.toolCallId` |
| `arguments` 是 **JSON 字符串** | 要 `JSON.parse` | | |

`lib/driver.mjs` 的 `flat(x)` 统一两种形状。

### 9. `usage` 是平铺的

```js
// ✗ 错
rows.filter(x => x.data?.phase === 'step_end').map(x => x.data.usage)
// ✓ 对
rows.filter(x => x.type === 'status' && x.phase === 'step_end').map(x => x.usage)
```

**后果**：token 全记成 0，于是「省了多少 token」这个核心论断没有数据支撑，白跑 45 次。

### 10. 输出采集器读到 `undefined`

同一个根因（形状没兼容）。症状是 `tool | undefined(undefined)` —— 看起来像采集器坏了，实际是字段名不对。

---

## 三、判分（最贵的坑，静默失败过 5 次）

> 这一节每一条都曾把**完全正确的模型**判成 0 分，而且表面看像"模型不行"。
> 这就是为什么 `lib/selftest.mjs` 必须有 22 项断言。

### 11. 拿最终文本评分

模型按纪律调 `memory_note` 把账本写进文件，最终文本只是"完成 / 已写入 handoff-xxx.md"。

⇒ 必须取 **`memory_note` 的 `content` 入参**。

### 12. 取最后一版而不看结果

模型常先写一版被 H1 拒、读到回执后自己改对。

⇒ 必须取**最后一次 `result` 为成功**的那版；一次都没成功才取最后一次调用（这样"始终没改对"会被如实记为失败）。

### 13. `isOk` 全仓搜 "error"

模型在一次成功写入之后又调一个失败的 `pwsh` ⇒ 成功的那次被判成失败。

⇒ 只认「该工具自己的回执开头明确宣告失败」（`lib/driver.mjs` 的 `isOk`）。

### 14. `memory_procedure.steps` 不是数组

```js
// schema 里写的
steps: { type: 'string', description: '流程步骤，**一行一步**（换行分隔）…' }
```

判分器按数组判 ⇒ 一个完全正确的调用被判 FAIL。

⇒ **判分必须照 schema，不能照直觉。**

### 15. `ev-create` 里的 append 要区分目标

模型 `create` 新事件后立刻往里 `append` 检查点是**正确做法**；只有 append 到**旧** eventId 才算误挂。

⇒ 判据必须排除旧 id（`lib/judge.mjs` 的 `appendOld`）。

### 16. 白名单：宿主心跳会被当成 agent 越界

`polling-heartbeat.json` / `notices-cache-pre.json` / `update-check-pre.json` 由**桌面宿主进程**周期性写，与 agent 无关。

⇒ 不加白名单会产生 100% 固定误报（实测 157 份报告里 2 份误报），反而掩盖真问题。

---

## 四、夹具

### 17. 夹具必须写到**沙箱记忆库**，不是 cwd

```js
// ✗ 错：插件根本不读这里
fs.writeFileSync(path.join(cwd, 'handoff', 'PLAN.md'), ...)

// ✓ 对
fs.writeFileSync(path.join(projectDirOf(cwd), 'handoff', 'PLAN.md'), ...)
```

**写错位置的后果链**（实测）：
1. `memory_read(kind=plan)` 返回 `content: ""`、revision 是空串的 sha256
2. `memory_recall(scope=events)` 说「本工作区还没有任何事件」
3. 模型于是去文件系统翻找 —— **39 个工具调用、240 秒超时**
4. 还翻到了别的实验工作区的 `PLAN.md` 和我的实验日志（自指污染）

### 18. 一个坏事件会毒死整个事件库

```
memory_event 失败: 事件写入前校验失败(evt_abc12345): missing:skillRef,bad-kind:task
```

`validateEventPre` 是 fail-closed 的 26 字段校验，但它把「库里所有事件」和「本次写入」混在一起报。

**后果不是「那个事件被拒」，而是整个 store 的每次写入都失败** —— 包括新建另一个事件。模型连续 3 次 create 全被挡住。

⇒ `lib/fixtures.mjs` 的 `makeEvent()` 强制合法化 `kind`/`confidence` 并补齐 26 字段；`lib/selftest.mjs` 有 3 项断言守着。

合法 `kind` 枚举：`ledger / planSnapshot / sessionTranscript / project / mechanical / unknown`

---

## 五、实验设计

### 19. 任务语料必须自包含

首版从真实账本反推任务描述，模型把「帮我写账本」理解成「先去仓库查这件事」，于是 `read <repo>/lib/index.js`、`pwsh Get-ChildItem`、`memory_recall` 去核实，单条跑到 **28 步 / 300 秒超时**。

⇒ 任务里直接给全部素材，并显式禁止调用 `memory_note` 以外的工具。单条耗时 300s → 17–35s。

### 20. 并发不能太高

`grantWrite` 会写目录 ACL（加锁），并发超过 4 会互相干扰；本地 LLM 网关也可能限流。默认 3。

### 21. 提示词只有一个层可改

~~`promptLayerOverrides` 能改 27 个动态层，但 `renderMemoryStatic()`（6,220 字符，含四段规则/四类感知/技能库/看板 tag）是**硬编码**的 —— 改不到。~~

~~⇒ 「精简静态纪律」这个变量测不了。想测必须先改产品代码。这是套件的**已知盲区**。~~

**⚠️ 本坑已过期（2026-10-31 实测）**：产品已把 `staticPerceptDiscipline` /
`staticCalendarDiscipline` 拆成可覆盖层，`DEFAULT_PROMPT_LAYERS` 现在 **29 层**，
`renderMemoryStatic()` 用整行替换读取它们（置空即回落内置文本，字节级不变）。
静态段源码块 7,909 字符，其余仍硬编码。

**真正的教训不是这条坑本身，而是「坑也会过期」**：
上一版文档把 27 层 / 6,220 字符当成事实写下来，隔两天就变成错的，
而它长得像事实、不像待验证项。⇒ **凡是「实测得到的数字」，都要标日期与来源**
（本套件现在的做法：监控面板从 `detectEnv()` / 运行时 import 现读，不把数字缓存进代码）。

---

### 22. 入口有三种形态，`spawn(node, [DSH_BIN])` 只覆盖一种

`driver.mjs` 曾经写死 `spawn(process.execPath, [DSH_BIN, ...])`。它只对 **npm 版**
（`lib/bin.js`）成立。遇到桌面版就在第一跳死：

| 形态 | 入口 | 怎么起 |
|---|---|---|
| npm 版 | `.../@deepseek-ai/dsh/lib/bin.js` | `node bin.js` |
| 桌面版 | `.../resources/runtime/cli/bin/dsh.cmd` | **`.cmd` 里写着 exe + asar 内 cli.js** |
| 裸 shim | `.../npm/dsh`（无扩展名） | 需先解析出它指向哪个 js |

`spawn` 一个 `.cmd` 在 Node 24 下直接 `EINVAL`；经 `shell:true` 又会因引号转义
静默失败（exit 0、零输出 —— 极难查）。

⇒ `lib/env.mjs` 的 `resolveRunner()` 把 `.cmd` **解析**成
`<exe> --expose-internals <cli.js>` + `ELECTRON_RUN_AS_NODE=1`，统一成一次干净 spawn。
实测桌面版 `--version` 0.2–0.3s，`--json` 一次任务 10–15s。

---

### 23. 两个入口对凭证的解析路径不同

实测（同一份沙箱 `DSH_HOME`、同一个 profile）：

| 入口 | 结果 |
|---|---|
| npm 版 0.2.0-rc.2 | 能读 `DSH_HOME/.credentials.yaml` 的 `refs` ⇒ 不用额外注入 |
| 桌面版 0.2.1-rc.5 | `MISSING_CREDENTIAL: … its profile resolves YOUR_API_KEY, which is not set` |

⇒ 必须把 key 以**环境变量**形式注入子进程才认。
`driver.mjs` 现在从 profile 的 patch 层读 `apiKeyEnv`，再去沙箱凭证里取一份注入
（不打印、不落盘）。**两个入口都要能跑**，否则「换台机器就废」。

---

### 24. 哨兵会把「宿主自己在写」当成 agent 越界

第一版哨兵的白名单只有 5 个心跳文件。那是在**宿主空闲**时验证的，所以「真实库零变化」成立。

后来用户在实验期间正常使用桌面宿主（跑对话、写日志、跑语义索引），同一个哨兵
一次套件报出 **44 项违规** —— 全部是宿主自己的 `evidence/` `semantic/` `hub/`
`global-brief/` 写入，与被测 agent 无关。

**两个方向的错都会致命**：
- 白名单太宽 ⇒ 把真越界当噪声吞掉（比假阳性严重得多）
- 白名单太窄 ⇒ 宿主活跃时几十条假阳性，把真信号淹掉

现在的做法是**三级分流**，每级在报告里单独计数：

| 级别 | 判据 | 去向 |
|---|---|---|
| 白名单 | `AMBIENT` 正则（含反斜杠归一，见坑 #25） | `ambientSkipped` |
| 可疑 | 宿主活跃 **且** 不在 agent 写入面 | `suspicious`（需人工确认） |
| 违规 | 其余，**含所有 agent 写入面** | `violations`（红线） |

`AGENT_WRITE_SURFACE`（workspaces / user / CALENDAR / episodes / 反思 / 每日日志）
**永远不会**因为「宿主活跃」而降级 —— 那正是被测的地方。

---

### 25. Windows 路径不归一，白名单全部失效

```js
// 改前 —— 正则按 / 写，Windows 传 \
const isAmbient = (p) => AMBIENT.some(re => re.test(p))
```

`C:\Users\…\.dsh\memory\update-check-pre.json` 因此漏过白名单，被记成违规
（184 份报告里 2 份假阳性，让「零违规」这个结论不再干净）。

⇒ 所有路径判定前先 `.replace(/\\/g, '/')`。同一个坑在 `classify()` 里有第二现场：
它曾写成 `/memory/memory.md$/`，而实际文件在 `memory/user/MEMORY.md`
⇒ **全部落进「其他」**。那不是分类不准，是**审计失效** ——
用户在报告里看到「其他 N 项」等于什么都没看到。

---

### 26. 写进模板字符串的代码不能带反引号

监控面板的 HTML 是 `String.raw` 模板。我往里加了一行
``p.count ? `当时快照；当前实测 ${p.count} 层` : …``，反引号直接把整个模板截断
⇒ 文件语法错误，服务起不来。

**为什么这条特别危险**：我先用**旧的**服务进程截了一组图、看起来「改好了」，
实际新代码根本没加载（新进程 EADDRINUSE 起不来，旧进程还在服务）。
是后来发现「改了三轮页面还是旧文案」才查出来。

⇒ 两条纪律：
1. 往模板字符串里写代码，用字符串拼接（`'…' + x + '…'`），不要用反引号/`${}`
2. **改完必须 `node --check`，并确认服务是新进程**（比日志时间戳，别信「页面看起来对了」）

---

### 27. `snapshotMinGapRounds: 0` 会让 5 个精简版层静默失效

这是本套件最严重的一处**自变量失效**，而且表现是「套件全绿」。

`0` 的语义不是「关闭节流」而是 **每轮都发完整版**（`parseGapRoundsPre` 里 0 是合法值）。
于是精简版（slim）分支永不触发，而下面这 5 层**只存在于精简版路径**
（`renderSlimSnapshotPre` 内，见 `lib/index.js` 的 L9888/L9901 附近）：

```
snapshotSlimMaintain    snapshotSlimGuide    snapshotSlimNote
snapshotSlimRecallHit   snapshotSlimRecallNote
```

⇒ `promptLayerOverrides` 改这 5 层**等于没改**，不报错、不告警。

**实证（2026-11-03，同一多步任务、4 step）**

| 配置 | 覆盖标记是否进上下文 | 精简版是否出现 |
|---|---|---|
| `gap: 0`（**当时套件的默认**） | ✗ | ✗ |
| `gap: 20`（产品默认） | ✓ | ✓（块长 675 vs 完整版 5,161） |

**影响面**：`suites/prompt-variants.mjs` 里 `slim` / `tiny` / `nosuffix` / `receipt`
四个变体改的都是 `snapshotSlimMaintain` —— 在 `gap: 0` 下它们测的**不是提示词差异**。

**修法**：`BASELINE_CFG` 钉产品默认 20 / 8，自检里加 4 项守卫
（基线 >0、与产品默认一致、套件里不许再写 0、`patchConfig` 不残留）。
守卫做过变异测试：往任意套件注入 `gap: 0`，自检立刻红。

---

### 28. 变体补丁必须从「完整基线」出发，不能叠加当前配置

`patchConfig` 曾写成「读当前配置 → 覆盖变体提到的键 → 写回」。
未提到的键于是**沿用上一次实验的值**。

实证：跑过一次 `--noinject`（写 `injectEnabled: false`）之后，
下一次 `default` 变体的补丁里没有 `injectEnabled` ⇒ 沿用 `false` ⇒
整批任务都在「注入关闭」下跑完，而报告写着 `variant=default`、**套件全绿**。

⇒ 改为：每次先把 `BASELINE_CFG` 里的每个键重置为基线，再叠变体补丁；
`promptLayerOverrides` 走**整块替换**（合并会让上一个变体的某层残留，测的就不是纯变体）。

配套 `currentVariantSurface()` 可在报告里如实打出「这次实际生效的那组配置」。

---

### 29. `t()` 不 await ⇒ 异步测试从未执行，却报「通过」

自检的测试运行器原本是：

```js
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name) } catch (e) { … }
}
```

对 `async () => { … assert … }` 这样的函数，`fn()` 只启动 Promise 就返回，
`pass++` 立刻执行 —— **断言一个都没跑**，失败降级成进程末尾一行 unhandledRejection 噪声。

**怎么发现的**：给新守卫做变异测试（故意注入 `gap: 0`），守卫照样绿。
不查变异，这个 bug 会一直把「没跑的测试」报成「通过」。

⇒ 现在收集 Promise，末尾 `await Promise.all(pending)` 再汇总；
变异测试对每个新守卫都验过真阳性（注入错误 → 红，还原 → 绿）。

**纪律**：任何「测试框架自身的正确性」，都要用**变异测试**证实它抓得到错。
「测试自己是绿的」是最不可信的一种绿。

---

## 附：诊断顺序

环境跑不通时，按这个顺序查，能最快定位：

```
1. node setup/env-report.mjs         ← 只读探测：选了哪个入口、为什么选它
2. node setup/preflight.mjs          ← 10 项检查，每项给可执行的修法
3. node lib/selftest.mjs             ← 判分器 + 环境层 + 自变量完整性（39 项）
4. node setup/verify-overrides.mjs   ← 改了提示词层？先证明它真进了上下文（含 3 个用例）
5. node lib/lint.mjs                 ← 产品改了、套件还准吗
6. 打开向导：node lib/setup-ui.mjs   ← 四步可视化，失败可单独重试
7. 单条手跑（换了入口形态时先试这条）：
   DSH_HOME=<work>/dshhome TEMP=<work>/tmp \
   node <dsh-bin> --profile memexp --json "回复 OK"
   期望看到：[dsh-auto-memory] ready: engine + 21 tools + ...
8. 看逐条输出：<work>/live/output/<tag>.jsonl
```

看到 `pending (waiting for service: webServer)` ⇒ 坑 #1。
看到 `SetNamedSecurityInfoW failed (Win32 5)` ⇒ 坑 #3 或 #4。
看到 `MISSING_CREDENTIAL` ⇒ 坑 #23（入口形态差异）。
看到模型在 `pwsh Get-ChildItem -Recurse` ⇒ 坑 #17（夹具放错位置）。
看到「发现 N 个 DSH 安装」⇒ 正常，坑 #22 说明为什么这是必要的。
**提示词实验「没有差异」** ⇒ 先跑坑 #27/#28 的验证：变量可能根本没进上下文。
