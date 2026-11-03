/**
 * 环境自适应层 —— 把「装好两个包就能跑」变成事实，而不是使用说明里的一句话。
 *
 * 本模块**不写任何东西**（除了缓存文件），只做探测与判定，
 * 让 preflight / 向导 / Agent 接口共享同一份事实。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 为什么必须「收集全部候选 → 比版本 → 选最优」
 * ═══════════════════════════════════════════════════════════════════
 * 实测（本机 2026-10-31）：
 *
 *   which -a dsh   →  /c/Users/…/AppData/Roaming/npm/dsh        ← 只有 npm 版
 *   where dsh      →  G:\dsh_desktop\…\cli\bin\dsh.cmd          ← 桌面版排第一
 *                     C:\Users\…\AppData\Roaming\npm\dsh
 *
 *   npm 版   0.2.0-rc.2   ← 旧安装，已不用
 *   桌面版   0.2.1-rc.5   ← 实际在用的
 *
 * 两条命令给出的列表**并不相同**（Git Bash 的 which 不认 .cmd 作为可执行），
 * 而 `which dsh` 取第一个命中恰好命中旧版。
 * 所以：
 *   · 必须合并 which -a 与 where 的结果，不能只跑一个；
 *   · 必须比版本取最优，不能取第一个；
 *   · 找不到达标版本时要**明说找到了哪些、各自什么版本**，而不是笼统说「未找到」。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 三种安装形态，取版本的方式不同
 * ═══════════════════════════════════════════════════════════════════
 *   ① npm 全局/本地包   .../@deepseek-ai/dsh/lib/bin.js
 *                       ⇒ 读同目录 package.json 的 version（快，无副作用）
 *   ② Windows .cmd 包壳 .../resources/runtime/cli/bin/dsh.cmd
 *                       ⇒ .cmd 里写着真正入口，但入口在 app.asar 内，读不到
 *                         package.json ⇒ 只能跑 `dsh.cmd --version`
 *                         （实测 0.31s，不是早前估计的 15s）
 *   ③ 裸 bin.js         ⇒ 同 ①
 *
 * 版本探测结果缓存在 <WORK>/.env-cache.json（按入口路径 + mtime 作键），
 * 避免每次进 preflight 都起子进程。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { PATHS, REPO, WORK, DSH_BIN } from './config.mjs'

/* ─────────────────────────── 门槛 ─────────────────────────── */

/**
 * 门槛常量集中一处。
 *
 * dsh 门槛的理由：插件 3.4.0-alpha.1 依赖 0.2.1 的 profile / bundle 机制；
 * 0.2.0 的 profile 布局不同，patch 层的 insert 语法在那边不生效。
 */
export const REQUIREMENTS = Object.freeze({
  dsh: {
    min: '0.2.1-rc.5',
    reason: '插件 3.4.0-alpha.1 依赖 0.2.1 的 profile/bundle 机制',
  },
  plugin: {
    min: '3.4.0-alpha.1',
    reason: '套件的判据与工具面按此版本编写',
  },
})

/* ─────────────────────────── 版本比较 ─────────────────────────── */

/**
 * 解析版本串。
 *   0.2.1-rc.5   → { major:0, minor:2, patch:1, pre:'rc.5', preParts:['rc',5] }
 *   3.4.0-alpha.1→ { … pre:'alpha.1', preParts:['alpha',1] }
 *   0.2.0        → { major:0, minor:2, patch:0, pre:'', preParts:[] }
 * 不合法返回 null（调用方必须显式处理，不要当 0.0.0 混过去）。
 */
export function parseVer(v) {
  const s = String(v || '').trim().replace(/^v/i, '')
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/)
  if (!m) return null
  const pre = m[4] || ''
  const preParts = pre ? pre.split('.').map(x => (/^\d+$/.test(x) ? Number(x) : x)) : []
  return { major: +m[1], minor: +m[2], patch: +m[3], pre, preParts, raw: s }
}

/**
 * 比较两个版本。a > b 返回 >0，a < b 返回 <0，相等 0。
 *
 * 语义按 semver 预发布的直觉：**有预发布号的 < 同版本号的无预发布号**
 * （0.2.1-rc.5 < 0.2.1）。这条在本项目里很重要 —— 门槛写 0.2.1-rc.5 时，
 * 正式版 0.2.1 必须判为达标。
 */
export function cmpVer(a, b) {
  const A = typeof a === 'string' ? parseVer(a) : a
  const B = typeof b === 'string' ? parseVer(b) : b
  // 解析不了的一律判「更小」，并由调用方报错；不要静默当成相等
  if (!A && !B) return 0
  if (!A) return -1
  if (!B) return 1
  for (const k of ['major', 'minor', 'patch']) {
    if (A[k] !== B[k]) return A[k] > B[k] ? 1 : -1
  }
  // 主版本号相同：无预发布 > 有预发布
  if (!A.pre && !B.pre) return 0
  if (!A.pre) return 1
  if (!B.pre) return -1
  // 都是预发布：逐段比，数字段按数值、字符串段按字典序、数字 < 字符串（semver 规则）
  const n = Math.max(A.preParts.length, B.preParts.length)
  for (let i = 0; i < n; i++) {
    const x = A.preParts[i], y = B.preParts[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x > y ? 1 : -1
    } else if (typeof x === 'number') return -1
    else if (typeof y === 'number') return 1
    else if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

export const meets = (have, min) => {
  const h = parseVer(have)
  if (!h) return false
  return cmpVer(h, parseVer(min) || min) >= 0
}

/* ─────────────────────────── 候选收集 ─────────────────────────── */

const isWin = process.platform === 'win32'
const norm = (p) => String(p || '').replace(/\\/g, '/')

function tryExec(cmd, args, timeout = 8000) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (_) { return '' }
}

/**
 * 从一条 PATH 命中还原出「可运行的入口 + 可读版本的来源」。
 *
 * 返回 { kind, bin, pkgDir }：
 *   kind='node-bin'  bin 是 bin.js，可直接 node bin.js（首选 —— 无 spawn 怪癖）
 *   kind='cmd-shim'  bin 是 .cmd / 无扩展名的 shell 包装，只能起子进程问版本
 *   kind='electron'  桌面版 exe + asar 内 cli.js（本机形态）
 */
function classifyHit(hit) {
  const p = norm(hit)
  const dir = path.dirname(p)
  const base = path.basename(p).toLowerCase()
  // npm 包内：.../@deepseek-ai/dsh/lib/bin.js
  if (/\/@deepseek-ai\/dsh\/lib\/bin\.js$/i.test(p) || /\/dsh\/lib\/bin\.js$/i.test(p)) {
    return { kind: 'node-bin', bin: hit, pkgDir: path.dirname(dir) }
  }
  // Windows .cmd 包壳
  if (base === 'dsh.cmd') return { kind: 'cmd-shim', bin: hit, pkgDir: null }
  if (base === 'dsh' || base === 'dsh.ps1') {
    // 无扩展名的 shim：旁边若真有 bin.js 优先用它
    const cand = path.posix.join(norm(dir), 'node_modules/@deepseek-ai/dsh/lib/bin.js')
    if (fs.existsSync(cand)) return { kind: 'node-bin', bin: cand, pkgDir: path.posix.join(norm(dir), 'node_modules/@deepseek-ai/dsh') }
    return { kind: 'cmd-shim', bin: hit, pkgDir: null }
  }
  return null
}

/**
 * 收集**全部**候选入口。
 *
 * 顺序只影响「同版本时谁优先」，不影响「选哪个版本」——
 * 后者由 cmpVer 决定。grade 越小越优先。
 */
function collectCandidates() {
  const out = []
  const push = (hit, source, grade) => {
    if (!hit) return
    const p = norm(hit)
    if (!fs.existsSync(p)) return
    if (out.some(c => norm(c.bin).toLowerCase() === p.toLowerCase())) return
    const c = classifyHit(p)
    if (!c) return
    out.push({ ...c, source, grade })
  }

  // ① 显式覆盖 —— 最高优先，即便版本更低也用（使用者明确指定就该尊重）
  if (process.env.TESTKIT_DSH_BIN) push(process.env.TESTKIT_DSH_BIN, 'env', 0)

  // ② which -a（Git Bash / POSIX）与 where（cmd）**都要跑**
  //    实测两者结果不同：which 漏掉桌面版 .cmd，where 把它排第一。
  if (isWin) {
    for (const line of tryExec('where', ['dsh']).split('\n')) {
      const t = line.trim()
      if (t) push(t, 'where', 10)
    }
  } else {
    for (const line of tryExec('which', ['-a', 'dsh']).split('\n')) {
      const t = line.trim()
      if (t) push(t, 'which', 10)
    }
  }
  // 无论哪个平台都再跑一次另一个（跨 shell 补齐）
  for (const line of tryExec('which', ['-a', 'dsh']).split('\n')) {
    const t = line.trim()
    if (t && !t.startsWith('which:')) push(t, 'which', 11)
  }

  // ③ npm 全局根
  const npmRoot = tryExec(isWin ? 'npm.cmd' : 'npm', ['root', '-g'], 15000).trim()
  if (npmRoot) {
    push(path.posix.join(norm(npmRoot), '@deepseek-ai/dsh/lib/bin.js'), 'global-npm', 20)
  }

  // ④ 套件自己 node_modules（若有人把 dsh 装成本地依赖）
  push(path.posix.join(norm(WORK), '../memory-testkit/node_modules/@deepseek-ai/dsh/lib/bin.js'), 'kit-local', 30)

  // ⑤ 已知安装前缀
  const home = os.homedir()
  const prefixes = []
  if (isWin) {
    // 桌面版：<盘>/<任意目录>/resources/runtime/cli/bin/dsh.cmd
    // 从 PATH 里找（上面 where 已覆盖），再兜底扫常见盘根
    for (const drive of ['C', 'D', 'E', 'F', 'G', 'H']) {
      for (const name of ['dsh_desktop', 'DeepSeek Harness', 'DeepSeekHarness']) {
        const p = `${drive}:/${name}/resources/runtime/cli/bin/dsh.cmd`
        if (fs.existsSync(p)) push(p, 'desktop-scan', 40)
      }
    }
    const la = process.env.LOCALAPPDATA || ''
    if (la) {
      push(path.posix.join(norm(la), 'Programs/@deepseek-ai/dsh/lib/bin.js'), 'localappdata', 45)
    }
    push(path.posix.join(norm(home), 'AppData/Roaming/npm/@deepseek-ai/dsh/lib/bin.js'), 'roaming-npm', 46)
  } else {
    for (const p of [
      '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
      '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
      path.posix.join(norm(home), '.npm-global/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'),
    ]) push(p, 'common-prefix', 40)
  }

  // ⑥ config.mjs 里那个历史默认值（可能指向旧版，但作为候选列入，让版本比较说话）
  if (DSH_BIN) push(DSH_BIN, 'config-default', 50)

  return out
}

/* ─────────────────────────── 取版本 ─────────────────────────── */

const CACHE_FILE = path.posix.join(WORK, '.env-cache.json')

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) } catch (_) { return {} }
}
function writeCache(obj) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true })
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 1), 'utf8')
  } catch (_) {}
}

/** 从 package.json 读版本（最快，无子进程） */
function versionFromPkg(pkgDir) {
  if (!pkgDir) return null
  try {
    const m = JSON.parse(fs.readFileSync(path.posix.join(norm(pkgDir), 'package.json'), 'utf8'))
    return m.version ? { version: m.version, how: 'package.json' } : null
  } catch (_) { return null }
}

/**
 * 起子进程问版本。
 *
 * .cmd 在 Node 24 下 spawn 会 EINVAL（同 driver.mjs 的注释），
 * 所以 Windows 上必须走 cmd.exe /c。实测 0.31s。
 */
function versionFromSubprocess(bin) {
  const p = norm(bin)
  const isCmd = /\.cmd$/i.test(p)
  try {
    let out
    if (isWin && isCmd) {
      out = execFileSync('cmd.exe', ['/c', p.replace(/\//g, '\\'), '--version'],
        { encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } else if (/\.(js|mjs|cjs)$/i.test(p)) {
      out = execFileSync(process.execPath, [p, '--version'],
        { encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } else {
      // 裸可执行（POSIX shim / 桌面 exe）
      out = execFileSync(p, ['--version'],
        { encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], shell: isWin })
    }
    // 输出可能混着横幅，取第一行像版本号的
    for (const line of String(out).split('\n')) {
      const t = line.trim()
      if (/^\d+\.\d+\.\d+/.test(t)) return { version: t.split(/\s+/)[0], how: 'subprocess' }
    }
    return null
  } catch (e) {
    return { error: String(e && e.message || e).slice(0, 160) }
  }
}

function readVersion(c, cache) {
  // ① 包目录里的 package.json
  const fromPkg = versionFromPkg(c.pkgDir)
  if (fromPkg) return { ...fromPkg, cached: false }

  // ② 缓存（按入口路径 + mtime 作键；文件变了就重新问）
  let mtime = 0
  try { mtime = fs.statSync(c.bin).mtimeMs } catch (_) {}
  const key = norm(c.bin).toLowerCase()
  const hit = cache[key]
  if (hit && hit.mtime === mtime && hit.version) return { version: hit.version, how: hit.how + '+cache', cached: true }

  // ③ 子进程问（慢路径）
  const got = versionFromSubprocess(c.bin)
  if (got && got.version) {
    cache[key] = { mtime, version: got.version, how: got.how, at: Date.now() }
    return { ...got, cached: false }
  }
  return got || { error: '未取到版本' }
}

/* ─────────────────────────── 插件侧 ─────────────────────────── */

function probePlugin() {
  const pj = path.posix.join(norm(REPO), 'package.json')
  if (!fs.existsSync(pj)) {
    return { repo: REPO, version: null, error: '缺 package.json（REPO 指错了？）', meetsRequirement: false }
  }
  let m = {}
  try { m = JSON.parse(fs.readFileSync(pj, 'utf8')) } catch (e) {
    return { repo: REPO, version: null, error: 'package.json 解析失败：' + String(e.message).slice(0, 120), meetsRequirement: false }
  }
  const v = m.version || null
  return { repo: REPO, name: m.name || '', version: v, meetsRequirement: meets(v, REQUIREMENTS.plugin.min) }
}

/* ─────────────────────────── 平台与沙箱 ─────────────────────────── */

function probePlatform() {
  const isWindows = process.platform === 'win32'
  const res = {
    os: process.platform,
    arch: process.arch,
    // Windows 的沙箱走 dsh-sandbox-windows-acl，grantWrite 需要 WRITE_DAC/WRITE_OWNER
    needsElevation: isWindows,
    elevated: null,
    aclOk: null,
    detail: '',
  }
  if (!isWindows) {
    res.detail = 'POSIX 权限模型，无需 ACL 编辑'
    res.aclOk = true
    return res
  }
  try {
    const out = tryExec('powershell', ['-NoProfile', '-Command',
      `$a=(Get-Acl '${WORK.replace(/'/g, "''")}').Access | Where-Object {$_.IdentityReference -like '*${(process.env.USERNAME || '').replace(/'/g, "''")}*'} | Select-Object -First 1; if($a){$a.FileSystemRights}else{'NONE'}`,
    ], 20000)
    const t = out.trim()
    res.elevated = /FullControl|WriteDac|WriteOwner/i.test(t)
    res.aclOk = res.elevated
    res.detail = t || '查询返回空'
  } catch (e) {
    res.detail = '查询失败：' + String(e && e.message || e).slice(0, 120)
  }
  return res
}

function probeSandbox() {
  const out = { writable: false, tempOk: true, tmpPath: PATHS.tmp, detail: '' }
  try {
    fs.mkdirSync(PATHS.tmp, { recursive: true })
    const probe = path.posix.join(PATHS.tmp, '.probe-' + process.pid)
    fs.writeFileSync(probe, 'x')
    fs.unlinkSync(probe)
    out.writable = true
  } catch (e) {
    out.detail = String(e && e.message || e).slice(0, 140)
  }
  const t = process.env.TEMP || ''
  if (/Windows[\\/]System32/i.test(t)) {
    out.tempOk = false
    out.detail = (out.detail ? out.detail + '；' : '') +
      'TEMP 指向系统保护目录 ⇒ 沙箱 grantWrite 会 Win32 error 5（运行器会自动改写，但建议先修）'
  }
  return out
}

function probeProfile() {
  const PROFILE_NAME = process.env.TESTKIT_PROFILE || 'memexp'
  const dir = path.posix.join(norm(PATHS.dshHome), 'profiles', PROFILE_NAME)
  const pj = path.posix.join(dir, 'package.json')
  if (!fs.existsSync(pj)) return { name: PROFILE_NAME, dir, exists: false }
  let bundles = []
  try {
    const m = JSON.parse(fs.readFileSync(pj, 'utf8'))
    bundles = (m.dsh && m.dsh.profile && m.dsh.profile.bundles) || []
  } catch (_) {}
  const cfgPath = path.posix.join(norm(PATHS.dshHome), 'dsh-auto-memory.json')
  let memoryRoot = null
  try { memoryRoot = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).memoryRoot || null } catch (_) {}
  const isolated = !!memoryRoot && /^[A-Za-z]:|^\//.test(memoryRoot) && !/\.dsh[\\/]memory/i.test(memoryRoot)
  return {
    name: PROFILE_NAME,
    dir,
    exists: true,
    bundles,
    hasPlugin: bundles.some(b => String(b).includes('auto-memory')),
    hasHeadless: bundles.some(b => String(b).includes('headless')),
    memoryRoot,
    isolated,
  }
}

/* ─────────────────────────── 主入口 ─────────────────────────── */

/**
 * 完整探测。**只读**，可被向导 / API / preflight 反复调用。
 *
 * @param {{refresh?: boolean}} opts refresh=true 时忽略缓存重新问版本
 */
export function detectEnv(opts = {}) {
  const cache = opts.refresh ? {} : readCache()

  const candidates = collectCandidates()
  const withVer = candidates.map(c => {
    const v = readVersion(c, cache)
    return {
      bin: norm(c.bin),
      kind: c.kind,
      source: c.source,
      grade: c.grade,
      version: v.version || null,
      versionHow: v.how || null,
      versionError: v.error || null,
      meetsRequirement: v.version ? meets(v.version, REQUIREMENTS.dsh.min) : false,
    }
  })
  writeCache(cache)

  // 选优：先满足门槛的，再按版本降序，再按 source 优先级
  const byVersion = (a, b) => cmpVer(b.version || '0.0.0', a.version || '0.0.0')
  const qualifying = withVer.filter(c => c.meetsRequirement).sort((a, b) => byVersion(a, b) || a.grade - b.grade)
  const all = withVer.slice().sort((a, b) => byVersion(a, b) || a.grade - b.grade)
  // TESTKIT_DSH_BIN 显式指定时，尊重指定 —— 但若它不达标，仍如实报出来
  const explicit = withVer.find(c => c.source === 'env')
  const picked = explicit || qualifying[0] || all[0] || null

  const plugin = probePlugin()
  const platform = probePlatform()
  const sandbox = probeSandbox()
  const profile = probeProfile()

  const warnings = []
  if (withVer.length > 1) {
    const others = withVer.filter(c => c !== picked)
      .map(c => `${c.version || '?'} (${c.source})`)
    warnings.push(`发现 ${withVer.length} 个 DSH 安装，已选用 ${picked.version || '?'}（${picked.source}），其余：${others.join('、')}`)
  }
  if (explicit && !explicit.meetsRequirement) {
    warnings.push(`TESTKIT_DSH_BIN 指定的版本 ${explicit.version || '?'} 低于门槛 ${REQUIREMENTS.dsh.min}，已按指定使用（若要自动选优，清掉该环境变量）`)
  }
  if (picked && !picked.meetsRequirement) {
    warnings.push(`所选 DSH ${picked.version || '?'} 低于门槛 ${REQUIREMENTS.dsh.min}：${REQUIREMENTS.dsh.reason}`)
  }
  if (withVer.some(c => c.versionError)) {
    warnings.push(`部分候选取版本失败：` + withVer.filter(c => c.versionError).map(c => `${c.source}=${c.versionError}`).join('；'))
  }

  const ok = !!(picked && picked.meetsRequirement) && plugin.meetsRequirement && sandbox.writable
  return {
    ok,
    at: Date.now(),
    requirements: REQUIREMENTS,
    dsh: picked ? {
      bin: picked.bin,
      version: picked.version,
      source: picked.source,
      kind: picked.kind,
      meetsRequirement: picked.meetsRequirement,
      candidates: withVer,
    } : {
      bin: null, version: null, source: null, meetsRequirement: false, candidates: [],
    },
    plugin,
    platform,
    sandbox,
    profile,
    warnings,
    nextAction: decideNextAction({ picked, plugin, platform, sandbox, profile }),
  }
}

/**
 * 机器可读的「下一步」。
 *
 * 这是给 Agent 用的关键字段 —— 让 Agent 知道该调哪个接口，
 * 而不是去解析中文错误文案。needsUserClick 为 true 表示这一步 Agent 替不了人。
 */
function decideNextAction({ picked, plugin, platform, sandbox, profile }) {
  if (!picked) {
    return { kind: 'install-dsh', command: 'npm i -g @deepseek-ai/dsh@latest', url: 'https://www.npmjs.com/package/@deepseek-ai/dsh' }
  }
  if (!picked.meetsRequirement) {
    return { kind: 'upgrade-dsh', have: picked.version, need: REQUIREMENTS.dsh.min, command: 'npm i -g @deepseek-ai/dsh@latest' }
  }
  if (!plugin.version) {
    return { kind: 'set-plugin', reason: plugin.error || '未找到插件仓库', hint: '设 TESTKIT_REPO 指向 dsh-auto-memory 源码目录' }
  }
  if (!plugin.meetsRequirement) {
    return { kind: 'upgrade-plugin', have: plugin.version, need: REQUIREMENTS.plugin.min, hint: '拉取插件新版本或切到对应 tag' }
  }
  if (!sandbox.tempOk) {
    return { kind: 'fix-temp', reason: sandbox.detail }
  }
  if (platform.needsElevation && !platform.aclOk) {
    return {
      kind: 'elevate',
      command: 'powershell -ExecutionPolicy Bypass -File setup/elevate.ps1',
      needsUserClick: true,
      reason: platform.detail,
    }
  }
  if (!profile.exists) return { kind: 'init-profile', api: 'POST /api/setup/profile' }
  if (!profile.isolated) return { kind: 'fix-profile', reason: 'profile 的 memoryRoot 未指向沙箱绝对路径' }
  if (!profile.hasPlugin || !profile.hasHeadless) {
    return { kind: 'fix-profile', reason: 'profile 未挂载 ' + [!profile.hasPlugin && 'auto-memory', !profile.hasHeadless && 'headless'].filter(Boolean).join(' + ') }
  }
  return { kind: 'ready', smoke: 'POST /api/setup/smoke' }
}

/**
 * 解析 profile 的 patch 层，读出 provider 声明的 apiKeyEnv 与凭证需求。
 *
 * 为什么需要：**桌面版入口与 npm 版入口对凭证的解析路径不同**（实测）。
 *   npm 版 0.2.0-rc.2 ：读 DSH_HOME/.credentials.yaml 的 refs，能拿到 YOUR_API_KEY
 *   桌面版 0.2.1-rc.5 ：同样的沙箱 DSH_HOME 下报 MISSING_CREDENTIAL，
 *                       必须把 key 以环境变量形式注入进程才认
 * 所以 driver 需要知道「这个 profile 要哪个环境变量」，再去沙箱凭证里取。
 *
 * @returns {{apiKeyEnv:string|null, provider:string|null, model:string|null, baseURL:string|null}}
 */
export function readProviderNeeds() {
  const out = { apiKeyEnv: null, provider: null, model: null, baseURL: null }
  const patch = path.posix.join(norm(PATHS.dshHome), 'profiles', process.env.TESTKIT_PROFILE || 'memexp', 'cordis.patch.yml')
  let src = ''
  try { src = fs.readFileSync(patch, 'utf8') } catch (_) { return out }
  // ★ YAML 里的值可能带引号（lib/provider.mjs 生成时统一加单引号，防止特殊字符出问题）
  //   —— 解析时必须剥掉，否则 apiKeyEnv 会变成 "'YOUR_API_KEY'"（含引号字符），
  //   拿去 process.env[...] 取不到值。实测踩过。
  const unq = (s) => {
    const t = String(s == null ? '' : s).trim()
    if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
      return t.slice(1, -1).replace(/''/g, "'")
    }
    return t
  }
  const l = (re) => { const m = src.match(re); return m ? unq(m[1]) : null }
  out.apiKeyEnv = l(/^\s*apiKeyEnv:\s*(.+)$/m)
  out.provider = l(/^\s*provider:\s*(.+)$/m)
  out.model = l(/^\s*model:\s*(.+)$/m)
  out.baseURL = l(/^\s*baseURL:\s*(.+)$/m)
  return out
}

/**
 * 从沙箱凭证文件里读某个 refs 键的值（只读，不打印）。
 * 结构：version: 1 / refs: { KEY: value } / records: …
 */
export function readCredential(key) {
  if (!key) return null
  const f = path.posix.join(norm(PATHS.dshHome), '.credentials.yaml')
  let src = ''
  try { src = fs.readFileSync(f, 'utf8') } catch (_) { return null }
  const m = src.match(new RegExp('^\\s{2}' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*(\\S+)\\s*$', 'm'))
  return m ? m[1] : null
}

/**
 * 轻量版本：只解析出「该用哪个入口」，不探 ACL / profile / 沙箱。
 *
 * driver.mjs 每条任务都要用，所以这里：
 *   · 命中缓存就直接返回（<WORK>/.env-cache.json，按入口路径 + mtime 作键）
 *   · 只在缓存缺失时才起子进程问一次版本
 *
 * @returns {string|null} 入口绝对路径；null = 一个都没找到
 */
export function pickDshBin() {
  // 显式指定最优先（使用者说了算）
  if (process.env.TESTKIT_DSH_BIN) return process.env.TESTKIT_DSH_BIN
  const cache = readCache()
  const cands = collectCandidates().map(c => {
    const v = readVersion(c, cache)
    return { ...c, version: v.version || null, meetsRequirement: v.version ? meets(v.version, REQUIREMENTS.dsh.min) : false }
  })
  writeCache(cache)
  const byVer = (a, b) => cmpVer(b.version || '0.0.0', a.version || '0.0.0') || a.grade - b.grade
  const ok = cands.filter(c => c.meetsRequirement).sort(byVer)
  const any = cands.slice().sort(byVer)
  const picked = ok[0] || any[0]
  return picked ? norm(picked.bin) : null
}

/**
 * 给人类看的一句话摘要（CLI 用）
 */
export function summarize(env) {
  const lines = []
  lines.push(`DSH      ${env.dsh.version || '未找到'}${env.dsh.source ? '  (' + env.dsh.source + ')' : ''}` +
    (env.dsh.meetsRequirement ? '  ✓' : '  ✗ 需 ≥ ' + REQUIREMENTS.dsh.min))
  lines.push(`插件     ${env.plugin.version || '未找到'}  (${env.plugin.repo})` +
    (env.plugin.meetsRequirement ? '  ✓' : '  ✗ 需 ≥ ' + REQUIREMENTS.plugin.min))
  lines.push(`平台     ${env.platform.os}${env.platform.needsElevation ? ' · 需要提权' : ' · 无需提权'}` +
    (env.platform.aclOk === false ? '  ✗ ACL 未授予' : env.platform.aclOk ? '  ✓' : ''))
  lines.push(`沙箱     ${env.sandbox.writable ? '可写' : '★不可写'}  ${env.sandbox.tmpPath}`)
  lines.push(`profile  ${env.profile.name} ${env.profile.exists ? (env.profile.isolated ? '✓ 已隔离' : '★未隔离') : '★未建'}`)
  if (env.dsh.candidates.length > 1) {
    lines.push('候选：')
    for (const c of env.dsh.candidates) {
      lines.push(`  ${String(c.version || '?').padEnd(14)} ${c.source.padEnd(14)} ${c.bin}`)
    }
  }
  for (const w of env.warnings) lines.push('⚠ ' + w)
  return lines.join('\n')
}

/* ─────────────────────────── 运行形态解析 ─────────────────────────── */

/**
 * 把一个「入口」解析成**可直接 spawn 的命令**。
 *
 * driver.mjs 的约束（实测）：Node 24 下 spawn 一个 `.cmd` 直接 EINVAL，
 * 经 shell:true 又会因参数转义/引号丢失而静默失败（exit 0、零输出——极难查）。
 * 所以统一归一成 `spawn(process.execPath | exe, [args...])`。
 *
 * 三种形态：
 *   ① node-bin    → node bin.js --profile …          （npm 版，首选）
 *   ② desktop     → <exe> --expose-internals <cli.js> --profile …
 *                   .cmd 里写着这两条路径；`%~dp0` 是 .cmd 自己的目录。
 *                   实测直接 spawn exe + ELECTRON_RUN_AS_NODE=1 可行（0.2s 出 --version）。
 *   ③ cmd-shim    → cmd.exe /c <shim> …              （兜底，仅在解析不出 exe 时用）
 *
 * @returns {{cmd:string, baseArgs:string[], env:object, kind:string, detail:string}}
 */
export function resolveRunner(bin) {
  const p = norm(bin)
  const ext = path.extname(p).toLowerCase()

  // ① 直接是 JS 入口
  if (/\.(js|mjs|cjs)$/i.test(p)) {
    return { cmd: process.execPath, baseArgs: [p], env: {}, kind: 'node-bin', detail: 'node ' + path.basename(p) }
  }

  // ② Windows .cmd：解析出真正的 exe 与 cli.js
  if (isWin && ext === '.cmd') {
    const parsed = parseCmdShim(p)
    if (parsed) return parsed
    return {
      cmd: 'cmd.exe', baseArgs: ['/c', p.replace(/\//g, '\\')],
      env: {}, kind: 'cmd-shell',
      detail: '未能解析 .cmd 内容，退回 cmd.exe /c（参数含空格时可能丢引号）',
    }
  }

  // ③ 裸可执行
  if (isWin) {
    return { cmd: 'cmd.exe', baseArgs: ['/c', p.replace(/\//g, '\\')], env: {}, kind: 'cmd-shell', detail: 'cmd /c' }
  }
  return { cmd: p, baseArgs: [], env: {}, kind: 'exec', detail: p }
}

/**
 * 解析 Windows .cmd 包壳。
 *
 * 实测的 dsh.cmd 内容（桌面版）：
 *   @echo off
 *   setlocal DisableDelayedExpansion
 *   set "ELECTRON_RUN_AS_NODE=1"
 *   "%~dp0..\..\..\..\DeepSeek Harness.exe" --expose-internals "%~dp0..\..\..\app.asar\...\cli.js" %*
 *   exit /b %errorlevel%
 *
 * 要点：
 *   · `%~dp0` = .cmd 所在目录（**带尾部分隔符**）
 *   · 引号里的路径要按段拆开再 resolve —— 直接 path.resolve 会把 `..\..\` 当文件名
 *   · `%*` 是调用方参数占位，不参与解析
 *   · `set "ELECTRON_RUN_AS_NODE=1"` 要抽出来作为额外环境变量
 */
export function parseCmdShim(cmdPath) {
  let src = ''
  try { src = fs.readFileSync(cmdPath, 'utf8') } catch (_) { return null }
  const dir = path.dirname(norm(cmdPath))

  const extraEnv = {}
  for (const m of src.matchAll(/^\s*set\s+"([A-Za-z_][A-Za-z0-9_]*)=(.*)"\s*$/gim)) {
    extraEnv[m[1]] = m[2]
  }

  // 找那一行「引号路径 + 参数」的调用行（排除 set / echo / if 等）
  for (const raw of src.split('\n')) {
    const line = raw.trim()
    if (!line || /^@?(echo|set|rem|exit|if|goto|cd|endlocal)\b/i.test(line)) continue
    const tokens = tokenizeCmdLine(line)
    if (tokens.length < 2) continue
    const exeTok = tokens[0]
    if (!/\.exe$/i.test(exeTok)) continue

    const exe = resolveShimPath(exeTok, dir)
    if (!exe || !fs.existsSync(exe)) continue

    // 第一个 .js/.mjs/.cjs 参数是真正入口
    const baseArgs = []
    for (const t of tokens.slice(1)) {
      if (t === '%*') continue
      if (/^--/.test(t)) { baseArgs.push(t); continue }
      if (/\.(js|mjs|cjs)$/i.test(t)) { baseArgs.push(resolveShimPath(t, dir) || t); continue }
      baseArgs.push(t)
    }
    return { cmd: exe, baseArgs, env: extraEnv, kind: 'desktop', detail: path.basename(exe) + ' + ' + (baseArgs.filter(a => /\.js$/i.test(a)).map(a => path.basename(a))[0] || '?') }
  }

  // npm 生成的 shim 没有 exe 行，形态是：
  //   "%_prog%" "%dp0%\node_modules\@deepseek-ai\dsh\lib\bin.js" %*
  // ⇒ 直接从整份文本里捞出指向 node_modules 的 .js 路径，用 .cmd 所在目录解析。
  for (const m of src.matchAll(/(["']?)([^"'\r\n]*node_modules[\\/][^"'\r\n]*?\.js)\1/g)) {
    const js = resolveShimPath(m[2].trim(), dir)
    if (!js || !fs.existsSync(js)) continue
    return { cmd: process.execPath, baseArgs: [js], env: extraEnv, kind: 'node-bin', detail: 'node ' + path.basename(js) }
  }
  return null
}

/** 按 Windows cmd 规则切 tokens（引号内不切；`%~dp0` 先展开） */
function tokenizeCmdLine(line) {
  // 先把 %~dp0 替换成一个不含空格的占位符，避免被空格切开
  const PH = '\u0001DP0\u0001'
  const s = line.replace(/%~dp0/gi, PH)
  const out = []
  const re = /"([^"]*)"|(\S+)/g
  let m
  while ((m = re.exec(s))) out.push((m[1] !== undefined ? m[1] : m[2]).replace(new RegExp(PH, 'g'), '@@DP0@@'))
  return out
}

/** 把 token 里的 %~dp0 / %dp0% 与 .. 段还原成绝对路径 */
function resolveShimPath(tok, dir) {
  let t = String(tok || '')
  if (!t) return null
  // 三种都指 .cmd 自己的目录：%~dp0（逐行展开）、%dp0%（npm shim 先 CALL :find_dp0 存进变量）
  t = t.replace(/@@DP0@@/g, dir + '/')
  t = t.replace(/%~?dp0%?|%dp0%/gi, dir + '/')
  t = t.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, k) => process.env[k] || '')
  if (/\$\(|\$\{|%_prog%/.test(t)) return null
  t = t.replace(/^["']|["']$/g, '').trim()
  if (!t) return null
  if (/^[A-Za-z]:[\\/]/.test(t) || t.startsWith('/')) return path.resolve(t.replace(/\\/g, '/'))
  return path.resolve(dir, t.replace(/\\/g, '/'))
}

