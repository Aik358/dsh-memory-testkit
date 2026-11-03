/**
 * 对话回放驱动器 —— 把「一段历史」按轮次喂进一个持久化会话，然后在独立会话里提问。
 *
 * ═══ 为什么需要它（这是我们与外部基准最大的架构差距）═══
 * 现有套件全是**单轮任务**：给一段素材 + 一句要求 → 看模型怎么写。
 * 它测的是「照着要求做」，测不出：
 *   · 45 天前的信息还找不找得到（遗忘曲线）
 *   · 用户改口后会不会继续用旧安排（知识更新）
 *   · 多轮累积后检索还准不准（压力下的召回）
 *
 * ═══ 技术前提（已实测，2026-11-03）═══
 * `dsh --profile <p> --json --session-id <sid> "…"` 可以**跨进程续接**同一会话：
 *   第 1 次说「暗号是紫藤 7」→ 退出；第 2 次带 --session-id 问「暗号是什么」→ 答「紫藤 7」。
 *   所以回放可以逐步喂，不必一次塞完（也不必把 360 轮拼成一个巨型 prompt）。
 *
 * ═══ 三道纪律 ═══
 * 1. **不重写历史**：喂进去的是原始用户消息 + 当时已有的助手回复。
 *    助手回复用「这是当时的回复：…」的形式作为用户消息的一部分送入，
 *    避免扰动被测系统的角色约定（headless 模式下没有第二个用户角色可切）。
 * 2. **逻辑时间不靠改系统时钟**：整机时钟不该被改。这里把逻辑时间写进每条消息的前缀，
 *    并在报告里显式声明「时间是通过消息内容表达的，不是通过时钟」。
 *    —— 这是与 Ornn8 的一处**已知差异**，不能假装等价。
 * 3. **考试会话必须独立**：问完就结束，不把题与答喂回历史，避免污染下一题。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { PATHS, PROFILE, SANDBOX_ENV, TASK_TIMEOUT_MS } from './config.mjs'
import { resolveRunner, pickDshBin, readProviderNeeds, readCredential } from './env.mjs'
import { parseNdjson, finalText, findSessionsFor } from './driver.mjs'

/** 从子进程环境补齐 provider 需要的 key（与 driver.mjs 同口径） */
function credentialEnv(extra) {
  const needs = readProviderNeeds()
  if (!needs.apiKeyEnv) return {}
  if (process.env[needs.apiKeyEnv] || (extra && extra[needs.apiKeyEnv])) return {}
  const v = readCredential(needs.apiKeyEnv)
  return v ? { [needs.apiKeyEnv]: v } : {}
}

/**
 * 起一次 headless 会话（可指定 sessionId 续接）。
 * @returns {Promise<{code,stdout,stderr,seconds,killed}>}
 */
export function runTurn({ cwd, task, sessionId, timeoutMs = TASK_TIMEOUT_MS, extraEnv = {} }) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const bin = pickDshBin()
    if (!bin) {
      return resolve({
        code: -1, stdout: '', killed: false, seconds: 0,
        stderr: '[replay] 未找到 DSH 入口，先跑 setup/preflight.mjs',
      })
    }
    const runner = resolveRunner(bin)
    const args = [...runner.baseArgs, '--profile', PROFILE, '--json']
    if (sessionId) args.push('--session-id', sessionId)
    args.push(task)

    const child = spawn(runner.cmd, args, {
      cwd,
      env: {
        ...process.env, DSH_HOME: PATHS.dshHome, ...SANDBOX_ENV,
        ...runner.env, ...credentialEnv(extraEnv), ...extraEnv,
      },
      windowsHide: true,
    })
    let stdout = '', stderr = '', killed = false
    const timer = setTimeout(() => { killed = true; try { child.kill('SIGKILL') } catch (_) {} }, timeoutMs)
    child.stdout.on('data', b => { stdout += b.toString() })
    child.stderr.on('data', b => { stderr += b.toString() })
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, killed, seconds: (Date.now() - t0) / 1000 }) })
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + '\n' + e.message, killed: false, seconds: (Date.now() - t0) / 1000 }) })
  })
}

/** 从事务性会话文件路径推出 sessionId（目录名形如 session-<uuid>） */
export function sessionIdFromFile(file) {
  const dir = path.basename(path.dirname(file))
  return /^session-/.test(dir) ? dir : null
}

/**
 * 把一轮对话包成一条「用户消息」。
 *
 * 为什么不是发两条（用户 + 助手）：headless 一次调用只有一个输入口，
 * 没有中途切换角色的通道。所以把「当时用户的说法 + 当时助手的回复」
 * 合成一条输入，并明确标注哪句是谁说的 —— 这保留了信息，
 * 代价是相比原生多角色轮次少了一点格式保真。
 * **这个代价必须写进报告**，不能当成等价。
 */
export function packTurn({ user, assistant, logicalTime, turnNo }) {
  const parts = []
  if (logicalTime) parts.push('[' + logicalTime + ']')
  parts.push('用户说：' + String(user || '').trim())
  if (assistant && String(assistant).trim()) {
    parts.push('（当时我的回复是：' + String(assistant).trim() + '）')
  }
  return parts.join(' ')
}

/**
 * 回放一段历史进一个新会话。
 *
 * @param {object} o
 * @param {string} o.cwd            工作区（独占，不能与别的题共用）
 * @param {Array}  o.turns          [{user, assistant, logicalTime}]，已按时间排序
 * @param {number} [o.maxTurns]     只喂前 N 轮（对应考题的 cutoff_turn）
 * @param {number} [o.timeoutMs]    单轮超时
 * @param {function} [o.onProgress] 进度回调（每轮一次）—— 用于「长回放跑到哪了」
 * @param {object} [o.cancelFlag]   {get(): boolean} 返回 true 时中止
 * @returns {Promise<{ok, sessionId, fed, seconds, errors, cappedAt}>}
 */
export async function replayHistory(o) {
  const cwd = o.cwd
  const turns = (o.turns || []).slice(0, o.maxTurns || o.turns.length)
  fs.mkdirSync(cwd, { recursive: true })

  const t0 = Date.now()
  const errors = []
  let sessionId = null
  let fed = 0
  let cappedAt = null

  for (let i = 0; i < turns.length; i++) {
    if (o.cancelFlag && o.cancelFlag.get()) { cappedAt = 'cancelled@' + i; break }
    const t = turns[i]
    const task = packTurn({ ...t, turnNo: i + 1 })

    const res = await runTurn({ cwd, task, sessionId, timeoutMs: o.timeoutMs })
    fed++

    if (res.code !== 0) {
      errors.push({ turn: i + 1, code: res.code, stderr: res.stderr.slice(0, 400) })
      // 单轮失败不中断整段回放：真实使用中某一条网络失败不该让 360 轮全废，
      // 但**必须记录**，否则「喂了 360 轮」和「成功喂了 340 轮」看起来一样。
    }

    // 第 1 轮之后从会话文件反推 sessionId，后续轮续接它
    if (!sessionId) {
      const ss = findSessionsFor(cwd)
      if (ss.length) sessionId = sessionIdFromFile(ss[0].file)
    }

    if (typeof o.onProgress === 'function') {
      o.onProgress({ fed, total: turns.length, turn: i + 1, seconds: (Date.now() - t0) / 1000, errors: errors.length })
    }
  }

  return {
    ok: errors.length === 0,
    sessionId,
    fed,
    planned: turns.length,
    seconds: (Date.now() - t0) / 1000,
    errors,
    cappedAt,
  }
}

/**
 * 在**独立会话**里提问（不复用回放会话，避免把题与答喂回历史）。
 *
 * 注意：这就意味着「答题会话」依赖的是**记忆系统的持久投影**，而不是会话内上下文。
 * 这恰好是我们想测的东西 —— 如果记忆没落盘，答题会话就答不出来。
 *
 * @returns {Promise<{ok, answer, seconds, exit}>}
 */
export async function askInFreshSession(o) {
  const cwd = o.cwd
  const res = await runTurn({ cwd, task: o.question, timeoutMs: o.timeoutMs })
  const rows = parseNdjson(res.stdout)
  return {
    ok: res.code === 0,
    answer: String(finalText(rows) || '').trim(),
    seconds: res.seconds,
    exit: res.code,
    killed: res.killed,
    stderr: res.stderr.slice(0, 400),
  }
}
