# Agent 接口契约

> 面向：自动化 Agent（也面向想写脚本的人）
> 服务：`node lib/setup-ui.mjs` → `http://127.0.0.1:8893`
> 全部 loopback only；非 `127.*` / `::1` 直接 403。

---

## §0 三条使用纪律

1. **每个响应都带 `nextAction`**。照 `nextAction.kind` 决定下一步，不要解析中文 `detail`。
2. **`nextAction.needsUserClick === true` 表示这一步 Agent 替不了人**（弹 UAC、点确认）。
   遇到它应当**停下来等人**，而不是重试 —— 重试一万次也不会通过。
3. **任何一步都可重入**。同一步重复调用是安全的（幂等或幂等式覆盖），
   失败后可以单独重试那一步，不必从头开始。

---

## §1 接口表

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/setup/detect` | 探测环境（完整形状 + nextAction） |
| GET | `/api/setup/requirements` | 门槛常量 |
| GET | `/api/setup/state` | 四步各自状态（向导页数据源） |
| POST | `/api/setup/profile` | 建 profile（body 可选 `{install:true}` 同时跑 pnpm install） |
| POST | `/api/setup/elevate` | 触发提权（仅 win32） |
| POST | `/api/setup/smoke` | 跑一次真实会话冒烟 |
| GET | `/api/setup/logs?id=X` | 看某步的日志 |

`detect` 支持 `?refresh=1` 忽略版本缓存重新问子进程。

---

## §2 `/api/setup/detect` 完整形状

```jsonc
{
  "ok": true,                       // 三个必要条件都满足
  "at": 1793669530591,
  "requirements": {
    "dsh":    { "min": "0.2.1-rc.5",    "reason": "…" },
    "plugin": { "min": "3.4.0-alpha.1", "reason": "…" }
  },
  "dsh": {
    "bin": "G:/dsh_desktop/resources/runtime/cli/bin/dsh.cmd",
    "version": "0.2.1-rc.5",
    "source": "where",              // env / where / which / global-npm / desktop-scan / …
    "kind": "cmd-shim",             // node-bin / cmd-shim / desktop
    "meetsRequirement": true,
    "candidates": [                 // ★全部候选，不只是选中的那个
      { "bin": "…", "version": "0.2.1-rc.5", "source": "where", "kind": "cmd-shim",
        "versionHow": "subprocess", "meetsRequirement": true },
      { "bin": "…", "version": "0.2.0-rc.2", "source": "where", "kind": "node-bin",
        "versionHow": "package.json", "meetsRequirement": false }
    ]
  },
  "plugin": { "repo": "<repo>", "version": "3.4.0-alpha.5", "meetsRequirement": true },
  "platform": { "os": "win32", "needsElevation": true, "elevated": true, "aclOk": true, "detail": "FullControl" },
  "sandbox": { "writable": true, "tempOk": true, "tmpPath": "<work>/tmp" },
  "profile": { "name": "memexp", "exists": true, "isolated": true, "hasPlugin": true, "hasHeadless": true,
               "memoryRoot": "<work>/memory/workspaces", "bundles": ["…"] },
  "warnings": ["发现 3 个 DSH 安装，已选用 0.2.1-rc.5（where），其余：0.2.0-rc.2 (where)、…"],
  "nextAction": { "kind": "ready", "smoke": "POST /api/setup/smoke" }
}
```

### 为什么 `candidates` 是数组

本机实测：`which -a dsh` 只返回 npm 版（0.2.0-rc.2，旧），
`where dsh` 把桌面版（0.2.1-rc.5，在用）排第一，两者**列表不同**。

如果探测写成「取第一个找到的」，会选中旧版并错误报「版本不达标」。
所以本模块**收集全部候选 → 比较版本 → 选达标的最新**，
并把完整候选列表交给调用方 —— Agent 需要能看出「为什么选了这个」。

---

## §3 `nextAction` 的全部形态

| `kind` | 含义 | 关键字段 |
|---|---|---|
| `ready` | 一切就绪 | `smoke?` `monitor?` |
| `install-dsh` | 没有任何 DSH | `command` `url` |
| `upgrade-dsh` | 版本低于门槛 | `have` `need` `command` |
| `set-plugin` | 找不到插件仓库 | `hint`（设 `TESTKIT_REPO`） |
| `upgrade-plugin` | 插件版本低于门槛 | `have` `need` `hint` |
| `fix-temp` | TEMP 指向系统保护目录 | `reason` |
| `elevate` | 需要 Windows ACL 提权 | `command` **`needsUserClick: true`** |
| `init-profile` | profile 未建 | `api` |
| `fix-profile` | profile 存在但配置不对 | `reason` |
| `install-deps` | 需要 pnpm install | `command` 或 `hint` |
| `run-smoke` | 该跑冒烟了 | `api` |

---

## §4 典型自动化流程

```
GET /api/setup/state
  → ok=true   ⇒ 直接跑套件，完事
  → ok=false  ⇒ 看 steps[].nextAction，取第一个未完成步骤的 kind：

     install-dsh / upgrade-dsh   → 执行 command（装完再 GET）
     set-plugin                  → 停下来问人（或设 TESTKIT_REPO 后重启服务）
     fix-temp                    → 修 TEMP 后重试
     elevate                     → POST /api/setup/elevate，然后**等人点 UAC**
                                   再 GET /api/setup/state 确认
     init-profile                → POST /api/setup/profile {"install":true}
     install-deps                → 执行 command
     run-smoke                   → POST /api/setup/smoke
```

### 一个能跑完的最小脚本

```js
const BASE = 'http://127.0.0.1:8893'
const get = (p) => fetch(BASE + p).then(r => r.json())
const post = (p, b) => fetch(BASE + p, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(b || {}),
}).then(r => r.json())

let s = await get('/api/setup/state')
while (!s.ok) {
  const step = s.steps.find(x => !x.ok)
  const na = step.nextAction || {}

  if (na.needsUserClick) {
    console.error(`需要人工：${na.command || na.kind} —— 请完成后重试`)
    process.exit(2)                      // ★不要在这里死循环
  }
  if (na.kind === 'elevate') { await post('/api/setup/elevate'); /* 等人点 UAC */ }
  else if (na.kind === 'init-profile') { await post('/api/setup/profile', { install: true }) }
  else if (na.kind === 'run-smoke') { await post('/api/setup/smoke') }
  else { console.error('需要人工处理：', na); process.exit(2) }

  const before = JSON.stringify(s.steps.map(x => x.ok))
  s = await get('/api/setup/state')
  if (JSON.stringify(s.steps.map(x => x.ok)) === before) {
    console.error('状态没变化，停止以免空转：', s.steps.filter(x => !x.ok))
    process.exit(3)
  }
}
console.log('就绪，监控台：', s.nextAction.monitor)
```

---

## §5 常见失败与处置

| 症状 | 原因 | 处置 |
|---|---|---|
| `smoke` 返回 `MISSING_CREDENTIAL` | 桌面版入口不读 `DSH_HOME/.credentials.yaml` | driver 已自动从沙箱凭证注入；若仍失败，检查 profile 的 `apiKeyEnv` 与凭证文件是否都有该键 |
| `detect` 里 `dsh.version` 是 `0.2.0-rc.2` | 环境里只有一个 npm 旧版 | `npm i -g @deepseek-ai/dsh@latest` |
| `elevate` 一直 `ok:false` | UAC 没点「是」，或 TEMP 指向 System32 | 先看 `env.platform.detail` 与 `env.sandbox.tempOk` |
| `profile.ok=false` 且 `detail` 含「未隔离」 | `memoryRoot` 不是沙箱绝对路径 | `POST /api/setup/profile {"force":true}` 重建（会覆盖 patch 层） |

---

## §6 与监控台的关系

| 服务 | 端口 | 何时用 |
|---|---|---|
| 向导 `lib/setup-ui.mjs` | 8893 | 跑实验**之前**，装环境 |
| 监控台 `lib/server.mjs` | 8899 | 跑实验**期间**，看逐条输出与完整性哨兵 |

两者都是 loopback only。实验数据目录由 `TESTKIT_WORK` 决定（默认 `<work>`），
`GET /api/setup/state` 的 `env` 里能看到实际的 profile 与仓库路径。
