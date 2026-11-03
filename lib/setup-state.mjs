/**
 * 四步状态机 —— setup 向导与 Agent 接口**共用这一份**。
 *
 * 设计原则（P3：人用前端、Agent 用接口，同一套逻辑）：
 *   前端只是这个状态机的消费者。任何一步都可以重复调用（幂等），
 *   失败时不阻塞其它步，失败的那步单独重试。
 *
 * 状态落盘在 <WORK>/.setup-state.json —— 进程重启后仍能看到上次进度，
 * 但每次 GET 都会**重新探测**（探测很便宜），所以磁盘只存「人工动作的结果」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { PATHS, PROFILE, WORK, REPO, ensureDirs } from './config.mjs'
import { detectEnv, REQUIREMENTS } from './env.mjs'

const STATE_FILE = path.posix.join(WORK, '.setup-state.json')

/**
 * 步骤定义。
 *   id     稳定标识（Agent 用它拼 URL）
 *   title  人类可读
 *   auto   true = 可以无人值守跑完；false = 必须人点/人确认
 *          （「需人工」这个徽章要按**平台**与**是否已完成**共同决定，
 *            不能按常量 —— 已完成却还挂「需人工」会让审阅者以为还卡着）
 */
export const STEPS = [
  { id: 'detect', title: '环境自检', auto: true },
  { id: 'elevate', title: '沙箱权限', auto: process.platform !== 'win32' },
  { id: 'profile', title: '建实验 profile', auto: true },
  { id: 'smoke', title: '冒烟验证', auto: true },
]

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch (_) { return {} }
}
function saveState(s) {
  try {
    ensureDirs()
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1), 'utf8')
  } catch (_) {}
}

/** 记录某一步的结果 */
function mark(state, id, result) {
  state[id] = { at: Date.now(), ...result }
  saveState(state)
  return state[id]
}

export function getState() {
  const env = detectEnv()
  const st = loadState()
  const steps = STEPS.map(def => {
    let ok = false
    let detail = ''
    let nextAction = null

    if (def.id === 'detect') {
      ok = env.ok
      detail = `DSH ${env.dsh.version || '?'} / 插件 ${env.plugin.version || '?'}`
      nextAction = env.nextAction
    } else if (def.id === 'elevate') {
      if (!env.platform.needsElevation) {
        ok = true
        detail = '非 Windows，无需提权（POSIX 权限模型）'
        nextAction = { kind: 'ready' }
      } else {
        ok = !!env.platform.aclOk
        detail = env.platform.aclOk ? `ACL 已授予（${env.platform.detail}）` : `ACL 未授予（${env.platform.detail}）`
        nextAction = ok ? { kind: 'ready' }
          : { kind: 'elevate', command: 'powershell -ExecutionPolicy Bypass -File setup/elevate.ps1', needsUserClick: true }
      }
    } else if (def.id === 'profile') {
      ok = !!(env.profile.exists && env.profile.isolated && env.profile.hasPlugin && env.profile.hasHeadless)
      detail = !env.profile.exists ? '未建'
        : !env.profile.isolated ? '已建但 memoryRoot 未隔离'
        : !env.profile.hasPlugin ? '已建但未挂载 auto-memory'
        : !env.profile.hasHeadless ? '已建但未挂载 headless'
        : `已建并隔离（${env.profile.bundles.join(' + ')}）`
      nextAction = ok ? { kind: 'ready' } : { kind: 'init-profile', api: 'POST /api/setup/profile' }
    } else if (def.id === 'smoke') {
      const last = st.smoke
      ok = !!(last && last.ok)
      detail = last ? (last.ok ? `通过（${last.seconds}s，返回「${last.text}」）` : `失败：${last.error || ''}`) : '未跑'
      nextAction = ok ? { kind: 'ready' } : { kind: 'run-smoke', api: 'POST /api/setup/smoke' }
    }

    return {
      id: def.id,
      title: def.title,
      ok,
      // 只有在「这一步还没完成、且确实需要人点」时才标「需人工」。
      // 已经做完还挂这个徽章会让审阅者以为卡住了（实测踩过）。
      auto: ok ? null : def.auto,
      detail,
      nextAction,
      lastRun: st[def.id] ? st[def.id].at : null,
    }
  })
  const allOk = steps.every(s => s.ok)
  return {
    ok: allOk,
    at: Date.now(),
    env,
    steps,
    // 第一个未完成、且能自动做的步骤（Agent 直接照这个往下走）
    nextAction: allOk
      ? { kind: 'ready', monitor: 'http://127.0.0.1:8899' }
      : (steps.find(s => !s.ok && s.nextAction) || { kind: 'ready' }).nextAction,
  }
}

/**
 * 建 profile —— 复用 setup/init-profile.mjs（不重写逻辑，避免两套实现漂移）。
 * 然后跑 pnpm install（这一步慢，所以单独流式回传日志）。
 */
export function buildProfile({ force = false } = {}) {
  const script = path.posix.join(path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))), 'setup/init-profile.mjs')
  return new Promise((resolve) => {
    const log = []
    const push = (s) => { log.push(s); if (log.length > 400) log.shift() }
    const child = spawn(process.execPath, [script, ...(force ? ['--force'] : [])], {
      cwd: path.dirname(script), windowsHide: true,
    })
    child.stdout.on('data', b => push(b.toString()))
    child.stderr.on('data', b => push(b.toString()))
    child.on('close', (code) => {
      const state = loadState()
      mark(state, 'profile', { ok: code === 0, code, log: log.join('').slice(-8000) })
      resolve({ ok: code === 0, code, log: log.join('') })
    })
    child.on('error', (e) => {
      const state = loadState()
      mark(state, 'profile', { ok: false, error: e.message })
      resolve({ ok: false, error: e.message, log: log.join('') })
    })
  })
}

/** 在 profile 目录跑 pnpm install */
export function installProfile() {
  const dir = path.posix.join(PATHS.dshHome, 'profiles', PROFILE)
  return new Promise((resolve) => {
    if (!fs.existsSync(path.posix.join(dir, 'package.json'))) {
      return resolve({ ok: false, error: 'profile 未建 —— 先跑 buildProfile()' })
    }
    const log = []
    const push = (s) => { log.push(s); if (log.length > 600) log.shift() }
    const isWin = process.platform === 'win32'
    const child = spawn(isWin ? 'pnpm.cmd' : 'pnpm', ['install'], {
      cwd: dir, windowsHide: true, shell: isWin,
      env: { ...process.env },
    })
    child.stdout.on('data', b => push(b.toString()))
    child.stderr.on('data', b => push(b.toString()))
    child.on('close', (code) => resolve({ ok: code === 0, code, log: log.join('') }))
    child.on('error', (e) => resolve({ ok: false, error: 'pnpm 启动失败：' + e.message + '（装一个：npm i -g pnpm）', log: log.join('') }))
  })
}

/**
 * 冒烟：起一次 headless，只问一个字。
 * 目的不是测能力，而是证明「入口 → profile → 凭证 → 模型」这条链是通的。
 */
export async function smoke() {
  const { runHeadless, parseNdjson, finalText } = await import('./driver.mjs')
  const ws = path.posix.join(PATHS.ws, 'setup-smoke-' + Date.now())
  try { fs.mkdirSync(ws, { recursive: true }) } catch (_) {}
  const res = await runHeadless({ cwd: ws, task: '只回复一个词：OK。不要调用任何工具。', timeoutMs: 180000 })
  const rows = parseNdjson(res.stdout)
  const text = String(finalText(rows) || '').trim()
  const ok = res.code === 0 && text.length > 0
  const rec = {
    ok,
    seconds: Number(res.seconds.toFixed(1)),
    text: text.slice(0, 80),
    tools: 0,
    error: ok ? null : (res.stderr.trim().slice(0, 500) || `exit=${res.code} killed=${res.killed}`),
  }
  const state = loadState()
  mark(state, 'smoke', rec)
  return rec
}

export { REQUIREMENTS }
