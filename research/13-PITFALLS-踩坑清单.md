> **状态：✅ 有效** — 21 条踩过的坑，改套件前必读
>
> 每一条都是实测撞出来的，平均花 20–40 分钟才定位。

---

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

首版从真实账本反推任务描述，模型把「帮我写账本」理解成「先去仓库查这件事」，于是 `read <repo>\lib\index.js`、`pwsh Get-ChildItem`、`memory_recall` 去核实，单条跑到 **28 步 / 300 秒超时**。

⇒ 任务里直接给全部素材，并显式禁止调用 `memory_note` 以外的工具。单条耗时 300s → 17–35s。

### 20. 并发不能太高

`grantWrite` 会写目录 ACL（加锁），并发超过 4 会互相干扰；本地 LLM 网关也可能限流。默认 3。

### 21. 提示词只有一个层可改

`promptLayerOverrides` 能改 27 个动态层，但 `renderMemoryStatic()`（6,220 字符，含四段规则/四类感知/技能库/看板 tag）是**硬编码**的 —— 改不到。

⇒ 「精简静态纪律」这个变量测不了。想测必须先改产品代码。这是套件的**已知盲区**。

---

## 附：诊断顺序

环境跑不通时，按这个顺序查，能最快定位：

```
1. node setup/preflight.mjs          ← 9 项检查，每项给可执行的修法
2. node lib/selftest.mjs             ← 判分器坏了吗
3. node lib/lint.mjs                 ← 产品改了、套件还准吗
4. 单条手跑：
   DSH_HOME=<work>/dshhome TEMP=<work>/tmp \
   node <dsh-bin> --profile memexp --json "回复 OK"
   期望看到：[dsh-auto-memory] ready: engine + 21 tools + ...
5. 看逐条输出：<work>/live/output/<tag>.jsonl
```

看到 `pending (waiting for service: webServer)` ⇒ 坑 #1。
看到 `SetNamedSecurityInfoW failed (Win32 5)` ⇒ 坑 #3 或 #4。
看到模型在 `pwsh Get-ChildItem -Recurse` ⇒ 坑 #17（夹具放错位置）。
