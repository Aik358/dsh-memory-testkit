/**
 * 脱敏扫描 —— 发布前必须跑。
 *
 * ═══ 为什么需要一个独立脚本，而不是「我记得检查一下」 ═══
 * 泄露通常不是因为「忘了删某个文件」，而是因为：
 *   · 某个配置模板里带着真实域名（我自己的 init-profile 就曾写死过一家中转站）
 *   · 文档里引用了真实路径 / 用户名 / 机器名
 *   · 测试夹具复用了真实语料
 *   · 密钥被粘进了不显眼的位置（注释、示例值、日志样例）
 * 「人眼过一遍」在这些地方最不可靠 —— 因为要找的东西**长得像正常内容**。
 *
 * ═══ 检查什么 ═══
 *   ① 已知敏感串（从私有配置与凭证文件里**提取**，不硬编码 —— 硬编码本身也是泄露）
 *   ② 通用模式：API key 形态、私有域名、Windows 用户目录、机器特定路径
 *   ③ 文件类型：不允许 .env / 凭证文件 / 个人配置进仓库
 *
 * 用法：
 *   node setup/scan-secrets.mjs           # 扫描，发现即非零退出
 *   node setup/scan-secrets.mjs --verbose # 同时打印已通过的文件数
 */
import fs from 'node:fs'
import path from 'node:path'
import { KIT_ROOT, WORK, REPO, DSH_BIN } from '../lib/config.mjs'
import { readConfigFile, CONFIG_FILE } from '../lib/provider.mjs'

const verbose = process.argv.includes('--verbose')

/** 不算源码的目录 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.editor-backups', 'dist', '__pycache__', '.vscode'])

/**
 * 从 .gitignore 读忽略规则，**扫描时跳过它们**。
 *
 * 为什么必须这样：`testkit.config.json` 本来就该含真实域名 —— 它被 gitignore 了，
 * 不会进仓库。若不跳过，扫描器会天天报它、真问题反而被淹没。
 * 但要注意：**跳过 ≠ 不检查**。真正要防的是「本该忽略却没忽略」，
 * 所以下面还会单独核验 .gitignore 里确实有这些规则。
 */
function readGitignore() {
  const out = []
  try {
    const txt = fs.readFileSync(path.join(KIT_ROOT, '.gitignore'), 'utf8')
    for (const line of txt.split('\n')) {
      const s = line.trim()
      if (!s || s.startsWith('#')) continue
      out.push(s)
    }
  } catch (_) {}
  return out
}

/** 极简 gitignore 匹配（够用即可：支持 `name`、`dir/`、`*.ext`、`.prefix*`） */
function ignoredBy(rel, rules) {
  const p = rel.replace(/\\/g, '/')
  const base = path.basename(p)
  for (const r of rules) {
    if (r.endsWith('/')) {
      if (p === r.slice(0, -1) || p.startsWith(r)) return true
    } else if (r.startsWith('*.')) {
      if (base.endsWith(r.slice(1))) return true
    } else if (r.startsWith('.')) {
      // .tmp-* / .env / .credentials*
      if (base === r || (r.endsWith('*') && base.startsWith(r.slice(0, -1)))) return true
    } else if (r.includes('*')) {
      const re = new RegExp('^' + r.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
      if (re.test(base) || re.test(p)) return true
    } else if (base === r || p === r) {
      return true
    }
  }
  return false
}

/**
 * 这些**必须**在 .gitignore 里 —— 缺一条就意味着「本机私有信息会被推到 GitHub」。
 *
 * ⚠️ 只列「无论如何都不该进仓库」的。像 research/ 这种取决于发布策略的，
 *    放到 OPTIONAL_IGNORE 里，缺了只提示不报错（否则想公开时会被自己拦住）。
 */
const MUST_IGNORE = [
  { rule: 'testkit.config.json', why: '本机私有端点配置' },
]
/** 可选忽略：缺了会提示，但不判为错误 */
const OPTIONAL_IGNORE = [
  { rule: 'research/', why: '内部研究档案（若决定公开则不需要）' },
]

/**
 * 从**本机私有文件**里提取真实敏感串（域名、主机、用户名）。
 * 这样规则会跟着本机实际情况变，而不是靠我在源码里再写一遍（那本身就是泄露）。
 */
function collectKnownSecrets() {
  const out = []
  const add = (v, why) => {
    if (!v || typeof v !== 'string') return
    const s = String(v).trim()
    if (s.length < 4) return
    if (out.some(x => x.v === s)) return
    // ★ 目录名本身常常也是产品名/包名（如 dsh-auto-memory），单独匹配会满篇误报。
    //   这类只允许「带盘符或斜杠的完整路径形态」命中。
    const base = s.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
    out.push({ v: s, why, requirePathLike: PRODUCT_NAMES.has(base) })
  }

  // ① 私有端点配置里的域名与 provider 名
  try {
    const prov = readConfigFile().provider || {}
    if (prov.baseURL) {
      try {
        const u = new URL(prov.baseURL)
        add(u.hostname, '私有端点主机名（来自 testkit.config.json）')
      } catch (_) { add(prov.baseURL, '私有端点（来自 testkit.config.json）') }
    }
    if (prov.name && prov.name !== 'main') add(prov.name, '私有 provider 名（来自 testkit.config.json）')
    if (prov.apiKeyEnv && !/^(DSH_MODEL_API_KEY|MY_API_KEY)$/i.test(prov.apiKeyEnv)) {
      add(prov.apiKeyEnv, '私有密钥变量名（来自 testkit.config.json）')
    }
  } catch (_) {}

  // ② 工作目录/仓库路径里出现的用户名与机器特定段
  const home = process.env.USERPROFILE || process.env.HOME || ''
  // 用户名本身太短会误报（比如 "j"），只收 3 字符以上且不是常见词的
  const user = path.basename(home || '')
  if (user && user.length >= 3 && !/^(users|home|root|admin)$/i.test(user)) {
    add(user, '本机用户名（来自 HOME 路径）')
  }
  add(WORK, '本机实验沙箱路径')
  add(REPO, '本机插件仓库路径')
  add(DSH_BIN, '本机 DSH 入口路径')
  return out
}

/**
 * 「含这些子串的行可以放过」—— 用来压掉产品名/包名造成的误报。
 *
 * 例：`dsh-auto-memory` 既是本机目录名也是**插件包名**。
 * 我若把 `D:/dsh-auto-memory` 整体当敏感串，那么文档里正常的
 * `@a9i5k4/dsh-auto-memory`、`[dsh-auto-memory] ready` 全会被误报。
 * ⇒ 敏感串若**只有最后一段是独特的**（比如仓库目录名），就只匹配「带盘符的完整形态」。
 */
const PRODUCT_NAMES = new Set(['dsh-auto-memory', 'dam-exp'])

/** 通用模式（不依赖本机） */
const PATTERNS = [
  { re: /sk-[A-Za-z0-9]{16,}/g, why: '看起来像 API key（sk-…）' },
  { re: /\bghp_[A-Za-z0-9]{20,}/g, why: 'GitHub PAT' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, why: 'GitHub fine-grained PAT' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, why: 'Slack token' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, why: '私钥' },
  { re: /[Aa]uthorization:\s*Bearer\s+[A-Za-z0-9._-]{16,}/g, why: 'Bearer token' },
]

/** 允许出现的「安全占位」—— 命中这些不算泄露 */
const ALLOW = [
  /sk-XXX/i, /sk-\.\.\./i, /sk-…/i, /<your[-_ ]?key>/i, /YOUR_API_KEY/i,
  /EXAMPLE/i, /placeholder/i, /redacted/i, /<redacted>/i,
  // 文档里演示「长什么样」用的形态说明（不含真实字符）
  /sk-\[A-Za-z0-9\]/, /sk-\{/, /sk-\$\{/,
]

function walk(dir, out, depth = 0) {
  if (depth > 8) return
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return }
  for (const e of ents) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(path.join(dir, e.name), out, depth + 1)
    } else if (e.isFile()) out.push(path.join(dir, e.name))
  }
}

/** 不该进仓库的文件名 */
const FORBIDDEN_FILES = [
  { re: /^\.env(\..*)?$/, why: '环境变量文件' },
  { re: /^\.credentials/, why: '凭证文件' },
  { re: /testkit\.config\.json$/, why: '本机私有配置（应在 .gitignore 里）' },
  { re: /\.(pem|key|p12|pfx)$/i, why: '证书/私钥' },
]

const TEXT_EXT = new Set(['.mjs', '.js', '.cjs', '.json', '.md', '.yml', '.yaml', '.ps1', '.txt', '.html', '.css', '.sh', '.example'])

function main() {
  const secrets = collectKnownSecrets()
  const files = []
  walk(KIT_ROOT, files)
  const ignoreRules = readGitignore()

  const problems = []
  let scanned = 0

  // ① 先验「该忽略的真的被忽略了」—— 这一条错了，后面扫得再干净也没用
  for (const m of MUST_IGNORE) {
    if (!ignoreRules.some(r => r === m.rule || r === m.rule.replace(/\/$/, ''))) {
      problems.push({
        file: '.gitignore', line: 0,
        why: '★ 缺少忽略规则：' + m.rule + '（' + m.why + '）—— 会被推到 GitHub',
        sample: '',
      })
    }
  }
  // 反向核验：gitignore 里写了，但文件其实在仓库根且没被匹配
  for (const f of files) {
    const rel = path.relative(KIT_ROOT, f).replace(/\\/g, '/')
    if (rel === 'testkit.config.json' && !ignoredBy(rel, ignoreRules)) {
      problems.push({ file: rel, line: 0, why: '★ 私有配置未被 .gitignore 覆盖', sample: '' })
    }
  }
  const notes = []
  for (const m of OPTIONAL_IGNORE) {
    if (!ignoreRules.some(r => r === m.rule || r === m.rule.replace(/\/$/, ''))) {
      notes.push('· ' + m.rule + ' 未被 gitignore（' + m.why + '）—— 确认这是有意的即可')
    }
  }

  for (const f of files) {
    const rel = path.relative(KIT_ROOT, f).replace(/\\/g, '/')

    // ★ 被 gitignore 的文件**跳过内容扫描**（它们本来就不进仓库）
    if (ignoredBy(rel, ignoreRules)) continue

    // ② 禁止文件名（含 .gitignore 里本该排掉的）
    for (const r of FORBIDDEN_FILES) {
      if (r.re.test(path.basename(f))) {
        // 唯一例外：示例文件本身允许存在（它是给人复制的模板，内容已脱敏）
        if (!/\.example\.json$/.test(f)) {
          problems.push({ file: rel, line: 0, why: r.why, sample: '(文件名命中)' })
        }
      }
    }

    // ② 内容扫描（只扫文本）
    const ext = path.extname(f).toLowerCase()
    if (!TEXT_EXT.has(ext) && ext !== '') continue
    let text = ''
    try { text = fs.readFileSync(f, 'utf8') } catch (_) { continue }
    if (text.length > 3_000_000) {
      problems.push({ file: rel, line: 0, why: '文件过大，跳过内容扫描（请人工确认）', sample: '' })
      continue
    }
    scanned++

    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (ALLOW.some(re => re.test(line))) continue

      // 已知敏感串（本机实值）
      for (const s of secrets) {
        if (!line.includes(s.v)) continue
        // 产品名/包名形态：只有「带盘符或路径分隔符」才算本机路径泄露
        if (s.requirePathLike) {
          const asPath = line.match(/[A-Za-z]:[\\/][^\s`'"）)]*|[\\/](?:[^\s`'"）)]*\/)?/g) || []
          const hit = asPath.some(seg => seg.includes(s.v) || seg === s.v)
          if (!hit) continue
        }
        problems.push({
          file: rel, line: i + 1, why: s.why,
          sample: line.trim().slice(0, 120),
        })
      }
      // 通用模式
      for (const p of PATTERNS) {
        p.re.lastIndex = 0
        const m = line.match(p.re)
        if (m) {
          problems.push({
            file: rel, line: i + 1, why: p.why,
            sample: line.trim().slice(0, 120),
          })
        }
      }
    }
  }

  // 去重（同一行可能同时命中多条规则）
  const seen = new Set()
  const uniq = []
  for (const p of problems) {
    const k = p.file + ':' + p.line + ':' + p.why
    if (seen.has(k)) continue
    seen.add(k)
    uniq.push(p)
  }

  console.log('=== 脱敏扫描 ===')
  console.log('根目录 ' + KIT_ROOT)
  console.log('扫描文件 ' + scanned + ' 个（跳过 node_modules/.git 等）')
  console.log('敏感词表 ' + secrets.length + ' 条（从本机私有配置提取，未硬编码）')
  if (verbose) {
    console.log('')
    console.log('敏感词表内容（**只显示前 6 字符**）:')
    for (const s of secrets) {
      console.log('  · ' + s.v.slice(0, 6) + '…  ← ' + s.why)
    }
  }
  console.log('')

  if (!uniq.length) {
    console.log('✓ 未发现敏感信息')
    return 0
  }

  // 按文件聚合，便于阅读
  const byFile = {}
  for (const p of uniq) (byFile[p.file] = byFile[p.file] || []).push(p)
  console.log('✗ 发现 ' + uniq.length + ' 处可疑内容，分布在 ' + Object.keys(byFile).length + ' 个文件：')
  for (const [file, list] of Object.entries(byFile)) {
    console.log('')
    console.log('  ' + file)
    for (const p of list.slice(0, 8)) {
      console.log(`    L${p.line}  [${p.why}]`)
      if (p.sample) console.log('         ' + p.sample)
    }
    if (list.length > 8) console.log('    …还有 ' + (list.length - 8) + ' 处')
  }
  console.log('')
  console.log('处置：')
  console.log('  · 真实域名/用户名 → 改成占位符，真实值放 testkit.config.json（已 gitignore）')
  console.log('  · 密钥 → 立刻吊销并换新；不要只是删掉再提交（历史里仍有）')
  console.log('  · 确实是示例 → 在 setup/scan-secrets.mjs 的 ALLOW 里加白名单并注明原因')
  return 1
}

process.exit(main())
