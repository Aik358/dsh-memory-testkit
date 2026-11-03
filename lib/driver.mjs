/**
 * dsh 驱动 —— 起 headless 会话、收 NDJSON、解会话日志。
 *
 * 为什么走「外部进程」而不是宿主内部子代理：
 *   子代理本身跑在被注入记忆提示词的环境里 ⇒ 自变量被污染（观察者效应）。
 *   外部 `dsh --profile <p> --json` 是被测模型唯一能看到实验设定的通道。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { PATHS, PROFILE, SANDBOX_ENV, TASK_TIMEOUT_MS } from './config.mjs'
import { resolveRunner, pickDshBin, readProviderNeeds, readCredential } from './env.mjs'

/**
 * 补上 provider 需要的 API key。
 *
 * ★ 实测的入口差异（2026-10-31）：
 *   npm 版 0.2.0-rc.2 会读 DSH_HOME/.credentials.yaml 的 refs ⇒ 不用额外注入
 *   桌面版 0.2.1-rc.5  同样的沙箱 DSH_HOME 下报 MISSING_CREDENTIAL ⇒ 必须注入环境变量
 * 两个入口都要能跑，所以这里统一：如果 profile 声明了 apiKeyEnv 而进程环境里没有，
 * 就从沙箱凭证文件里取一份注入子进程。**不打印、不落盘、不外传。**
 */
function credentialEnv(extraEnv) {
  const needs = readProviderNeeds()
  if (!needs.apiKeyEnv) return {}
  if (process.env[needs.apiKeyEnv] || extraEnv[needs.apiKeyEnv]) return {}
  const v = readCredential(needs.apiKeyEnv)
  return v ? { [needs.apiKeyEnv]: v } : {}
}

/**
 * 跑一次 headless 会话。
 * @returns {Promise<{code:number,stdout:string,stderr:string,seconds:number,killed:boolean}>}
 */
export function runHeadless({ cwd, task, timeoutMs = TASK_TIMEOUT_MS, extraEnv = {} }) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    // ⚠️ 入口形态可能是三种之一（npm bin.js / 桌面 .cmd / 裸 exe），
    //    所以**不能写死 spawn(process.execPath, [DSH_BIN])**：
    //    · `.cmd` 在 Node 24 下 spawn 直接 EINVAL
    //    · 经 shell:true 时参数不转义，且 Git Bash 的 sh 会把命令吃掉
    //      （实测 exit 0、0 秒、无输出 —— 极难查）
    //    resolveRunner() 把 .cmd 解析成「exe + asar 内 cli.js」（桌面版，
    //    实测 0.2s 出 --version）或「node + bin.js」（npm 版），统一成一次干净 spawn。
    //    DSH_BIN 由 env.mjs 探测（多候选比版本），不再是 config 里的硬编码路径。
    const bin = pickDshBin()
    if (!bin) {
      return resolve({
        code: -1, stdout: '', killed: false, seconds: 0,
        stderr: '[testkit] 未找到 DSH 入口。装一个：npm i -g @deepseek-ai/dsh@latest，'
          + '或设 TESTKIT_DSH_BIN 指向 bin.js / dsh.cmd（详见 node setup/preflight.mjs）',
      })
    }
    const runner = resolveRunner(bin)
    const child = spawn(
      runner.cmd,
      [...runner.baseArgs, '--profile', PROFILE, '--json', task],
      {
        cwd,
        env: {
          ...process.env,
          DSH_HOME: PATHS.dshHome,
          ...SANDBOX_ENV,
          ...runner.env,
          ...credentialEnv(extraEnv),
          ...extraEnv,
        },
        windowsHide: true,
      },
    )
    let stdout = ''
    let stderr = ''
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      try { child.kill('SIGKILL') } catch (_) {}
    }, timeoutMs)
    child.stdout.on('data', (b) => { stdout += b.toString() })
    child.stderr.on('data', (b) => { stderr += b.toString() })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, killed, seconds: (Date.now() - t0) / 1000 })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + '\n' + e.message, killed: false, seconds: (Date.now() - t0) / 1000 })
    })
  })
}

/** 解析 NDJSON stdout（非 JSON 行静默跳过 —— 启动横幅会混在 stdout） */
export function parseNdjson(stdout) {
  const rows = []
  for (const l of String(stdout).split('\n')) {
    const s = l.trim()
    if (!s.startsWith('{')) continue
    try { rows.push(JSON.parse(s)) } catch (_) {}
  }
  return rows
}

/**
 * 统一「平铺」与「包在 data 里」两种事件形状。
 *
 * ⚠️ 踩过三次，每次都让判分静默取到空：
 *   NDJSON     : { type:'tool_call', tool, input, callId }        ← 顶层
 *   会话日志   : { type:'tool/call', data:{ name, arguments } }   ← 嵌套
 *   结果 callId: NDJSON 在 d.callId；会话日志在 d.message.toolCallId
 */
export const flat = (x) => ({ ...(x || {}), ...((x && x.data) || {}) })

/**
 * 从事件流里抽出所有工具调用与结果。
 * @returns {{calls:Array<{tool,input,callId}>, results:Map<string,string>}}
 */
export function extractCalls(rows) {
  const calls = []
  const results = new Map()
  for (const x of rows) {
    const d = flat(x)
    if (x.type === 'tool_call') {
      calls.push({ tool: d.tool, input: d.input || {}, callId: d.callId })
    } else if (x.type === 'tool/call') {
      let inp = d.arguments
      if (typeof inp === 'string') { try { inp = JSON.parse(inp) } catch (_) { inp = {} } }
      calls.push({ tool: d.name, input: inp || {}, callId: d.callId })
    }
    if (x.type === 'tool_result' || x.type === 'tool/result') {
      const cid = d.callId || d.toolCallId || (d.message && d.message.toolCallId) || ''
      let text = d.result
      if (text == null && d.message) text = (d.message.content || []).map(c => c.text || '').join('')
      if (cid) results.set(cid, String(text == null ? '' : text))
    }
  }
  return { calls, results }
}

/**
 * 工具调用是否成功。
 *
 * ⚠️ 不能全仓搜 "error" 二字：模型常在一次成功写入之后又调一个无关的失败命令，
 *    那样会把成功的写入判成失败（实测 ev-create 假红）。
 *    只认「该工具自己的回执开头明确宣告失败」。
 */
export function isOk(call, results) {
  const res = String(call.callId ? (results.get(call.callId) || '') : '')
  if (!res) return true
  if (/^\s*memory_\w+: .*(拦截|失败|拒绝)/.test(res)) return false
  if (/^\s*(Error|error):/.test(res)) return false
  if (/\[拦截\]|\[拒绝\]/.test(res)) return false
  return true
}

/** 提取最终回复文本 */
export function finalText(rows) {
  const r = rows.filter(x => x.type === 'final').pop()
  if (!r) return ''
  return String((r.data && r.data.text) ?? r.text ?? '')
}

// ── 会话日志（zstd 多帧）──────────────────────────────────────────────
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 解多帧 zstd 会话日志。
 *
 * ⚠️ 单帧解压只能拿到第一行。真实会话是**一帧一行**追加写的，
 *    必须按 magic 切分后逐帧解压再拼。
 */
export function readSessionEvents(file) {
  let buf
  try { buf = fs.readFileSync(file) } catch (_) { return [] }
  const idx = []
  let i = 0
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) { idx.push(i); i += 4 }
  const chunks = []
  for (let k = 0; k < idx.length; k++) {
    const s = idx[k]
    const e = k + 1 < idx.length ? idx[k + 1] : buf.length
    try { chunks.push(zlib.zstdDecompressSync(buf.slice(s, e)).toString('utf8')) } catch (_) {}
  }
  const rows = []
  for (const l of chunks.join('').split('\n')) {
    const s = l.trim()
    if (!s) continue
    try { rows.push(JSON.parse(s)) } catch (_) {}
  }
  return rows
}

/** 找某工作区目录下的全部会话文件（按 mtime 降序） */
export function findSessionsFor(absWsPath) {
  const key = '--' + path.resolve(absWsPath).replace(/[\\/:*?"<>|]/g, '-') + '--'
  const base = path.join(PATHS.dshHome, 'sessions')
  // 会话目录的命名与记忆库略有不同（`--D-dam-exp-ws-x--` vs `--D--dam-exp-ws-x--`），
  // 所以用「包含 workshop 名主干」来模糊匹配。
  const stem = key.replace(/^--/, '').replace(/--$/, '').replace(/--/g, '-')
  let dirs = []
  try { dirs = fs.readdirSync(base) } catch (_) { return [] }
  const out = []
  for (const d of dirs) {
    if (!d.includes(stem.slice(0, 24)) && !d.includes(stem)) continue
    const dir = path.join(base, d)
    let subs = []
    try { subs = fs.readdirSync(dir) } catch (_) { continue }
    for (const sid of subs) {
      const f = path.join(dir, sid, 'session.v4.jsonl.zstd')
      try {
        if (fs.existsSync(f)) out.push({ file: f, mtime: fs.statSync(f).mtimeMs })
      } catch (_) {}
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}
