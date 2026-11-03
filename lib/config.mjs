/**
 * 配置单源 —— 所有路径 / 常量 / 外部依赖都从这里取。
 *
 * 纪律：任何模块都不许自己拼路径。踩过的坑：
 *   · `memoryRoot` 默认值是字面 `~/.dsh/memory/workspaces`，插件里用 os.homedir() 展开
 *     ⇒ **DSH_HOME 拦不住它**，必须显式覆盖成绝对路径，否则写进真实记忆库。
 *   · Windows 路径在 JS 字符串里 `\n` `\t` 会被当转义（`\npm` → 换行 + "pm"），
 *     所以内部一律用正斜杠，只在传给外部进程时才转。
 */
import path from 'node:path'
import fs from 'node:fs'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

/** 套件根目录（可被 TESTKIT_HOME 覆盖，便于把套件放到别处） */
export const KIT_ROOT = process.env.TESTKIT_HOME
  ? path.resolve(process.env.TESTKIT_HOME)
  : path.resolve(here, '..')

/**
 * 被测仓库（插件源码所在）—— 只读参考，绝不写入。
 *
 * ★ 默认值不写任何人的本机路径。取值顺序：
 *   ① TESTKIT_REPO
 *   ② testkit.config.json 的 repo 字段
 *   ③ 与套件同级、名为 dsh-auto-memory 的目录（最常见布局）
 *   ④ 当前工作目录（若它本身就像一个插件仓库）
 * 都找不到就返回空串，由 preflight 明确报「请设 TESTKIT_REPO」。
 */
function guessRepo() {
  const kitParent = path.resolve(here, '..')
  if (process.env.TESTKIT_REPO) return path.resolve(process.env.TESTKIT_REPO)
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(here, '..', 'testkit.config.json'), 'utf8'))
    if (cfg.repo) return path.resolve(cfg.repo)
  } catch (_) {}
  const sibling = path.join(kitParent, 'dsh-auto-memory')
  if (fs.existsSync(path.join(sibling, 'lib', 'index.js'))) return sibling
  if (fs.existsSync(path.join(process.cwd(), 'lib', 'index.js'))
      && fs.existsSync(path.join(process.cwd(), 'package.json'))) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'))
      if (/auto-memory/.test(pkg.name || '')) return process.cwd()
    } catch (_) {}
  }
  return ''
}

/** 沙箱根：所有实验产物都在这里，真实记忆库零写入 */
function guessWork() {
  if (process.env.TESTKIT_WORK) return path.resolve(process.env.TESTKIT_WORK)
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(here, '..', 'testkit.config.json'), 'utf8'))
    if (cfg.work) return path.resolve(cfg.work)
  } catch (_) {}
  return path.resolve(here, '..', 'run')
}

export const REPO = guessRepo()
export const WORK = guessWork()

/** 子路径 */
export const PATHS = {
  dshHome: path.posix.join(WORK, 'dshhome'),
  memoryRoot: path.posix.join(WORK, 'memory/workspaces'),
  userMemoryDir: path.posix.join(WORK, 'memory/user'),
  tmp: path.posix.join(WORK, 'tmp'),
  ws: path.posix.join(WORK, 'ws'),
  raw: path.posix.join(WORK, 'raw'),
  live: path.posix.join(WORK, 'live'),
  liveOutput: path.posix.join(WORK, 'live/output'),
  sentinel: path.posix.join(WORK, 'sentinel'),
  report: path.posix.join(WORK, 'REPORT.md'),
}

/** 实验 profile 名（setup/ 里会建到 dshHome/profiles/<name>） */
export const PROFILE = process.env.TESTKIT_PROFILE || 'memexp'

/**
 * dsh 入口 —— **不硬编码任何本机路径**。
 *
 * 取值顺序：
 *   ① TESTKIT_DSH_BIN 显式指定（最高优先，连版本都尊重使用者）
 *   ② lib/env.mjs 的探测结果（收集全部候选 → 比版本 → 选达标的最新）
 *
 * ⚠️ 为什么不能在 config 里写默认路径：
 *   本机同时装着两个 dsh（npm 版 0.2.0-rc.2 旧 / 桌面版 0.2.1-rc.5 在用），
 *   而 `which dsh` 恰好解析到旧的那个。写死任何一个都是错的。
 *   用 env.mjs 的延迟解析，才能兼顾「社区用户的机器各不相同」。
 *
 * 注意：这是**同步**的兜底值（只认环境变量），真正解析在 `resolveDshBin()`。
 */
export const DSH_BIN_OVERRIDE = process.env.TESTKIT_DSH_BIN || null

/**
 * @deprecated 兼容旧代码的同步别名。
 *   等于 DSH_BIN_OVERRIDE，没设就是 null —— 使用方必须改走 env.mjs。
 *   新建代码请用 `lib/env.mjs` 的 `detectEnv()` / `pickDshBin()`。
 */
export const DSH_BIN = DSH_BIN_OVERRIDE

/** 单条任务超时（ms）。实测正常任务 15–60s，卡死时靠这个兜住 */
export const TASK_TIMEOUT_MS = Number(process.env.TESTKIT_TIMEOUT_MS || 300000)

/** 并发上限。再高会同时触发多个 grantWrite（目录 ACL 是加锁写的） */
export const CONCURRENCY = Number(process.env.TESTKIT_CONCURRENCY || 3)

/**
 * 沙箱三要素 —— 缺一个整条跑不起来，全部实测过。
 *
 * ① DSH_PERMISSION_MODE=workspace-write
 *    会话 cwd 即写入边界。越界写返回 `Access is denied` +
 *    `[sandbox: file access denied under workspace-write mode]`。
 * ② TEMP/TMP/TMPDIR 指到可写目录
 *    dsh-sandbox 的 writableRoots 含 tmpdir()。**提权后 TEMP 会变成
 *    C:\Windows\System32**，而该目录受 TrustedInstaller 保护 ⇒
 *    grantWrite() 必然 `SetNamedSecurityInfoW failed (Win32 5)` ⇒
 *    整个沙箱初始化失败，表现为「连工作区内都写不了」。
 * ③ 目录 ACL 含 WRITE_DAC + WRITE_OWNER
 *    由 dsh-sandbox-windows-acl 的 grantWrite() 需要；未提权的进程拿不到
 *    （D:\ 下继承的 Authenticated Users:Modify 不含这两项）。
 *    一次性由 setup/elevate.ps1 授予。
 */
export const SANDBOX_ENV = Object.freeze({
  DSH_PERMISSION_MODE: 'workspace-write',
  TEMP: PATHS.tmp,
  TMP: PATHS.tmp,
  TMPDIR: PATHS.tmp,
})

/** 确保所有工作目录存在 */
export function ensureDirs() {
  for (const p of Object.values(PATHS)) {
    if (path.extname(p)) continue // 文件路径跳过
    try { fs.mkdirSync(p, { recursive: true }) } catch (_) {}
  }
}

/** 工作区绝对路径 → 插件的 wsKey 目录名（`--` 包起来、非法字符换 `-`） */
export function wsKeyOf(absWsPath) {
  const abs = path.resolve(absWsPath)
  return '--' + abs.replace(/[\\/:*?"<>|]/g, '-') + '--'
}

/** 某工作区在沙箱记忆库里的目录 */
export function projectDirOf(absWsPath) {
  return path.posix.join(PATHS.memoryRoot, wsKeyOf(absWsPath))
}
