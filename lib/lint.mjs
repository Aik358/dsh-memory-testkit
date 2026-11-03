/**
 * 漂移检查 —— 产品演进后套件是否还准。
 *
 * 为什么要这个：套件把产品的若干**契约**抄成了常量（枚举、字段名、判据）。
 * 产品一改，套件不会报错，只会**静默给出错误判分** —— 那比没套件更糟。
 *
 * 用法：node lib/lint.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { REPO, PATHS } from './config.mjs'
import { PERCEPT_STAGES, COMMIT_STATES } from './judge.mjs'
import { EVENT_KINDS } from './fixtures.mjs'

const findings = []
const add = (level, what, detail) => findings.push({ level, what, detail })

function readSrc(rel) {
  const p = path.posix.join(REPO, rel)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
}

// ── 1. 枚举漂移 ──
const store = readSrc('lib/event-store.js')
if (!store) {
  add('error', '产品文件不可达', path.posix.join(REPO, 'lib/event-store.js'))
} else {
  const grab = (name) => {
    const m = store.match(new RegExp(name + '\\s*=\\s*Object\\.freeze\\(\\[([^\\]]*)\\]\\)'))
    return m ? m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : null
  }
  const cmp = (name, kitVal) => {
    const prod = grab(name)
    if (!prod) { add('warn', `${name} 在产品里找不到`, '产品可能改名了，套件的判据需要跟着改'); return }
    const same = prod.length === kitVal.length && prod.every((v, i) => v === kitVal[i])
    if (!same) add('error', `${name} 漂移`, `产品=[${prod.join(',')}]  套件=[${kitVal.join(',')}]`)
  }
  cmp('PERCEPT_STAGES', PERCEPT_STAGES)

  const kinds = grab('EVENT_KINDS')
  if (!kinds) add('warn', 'EVENT_KINDS 在产品里找不到', '')
  else {
    const same = kinds.length === EVENT_KINDS.length && kinds.every((v, i) => v === EVENT_KINDS[i])
    if (!same) add('error', 'EVENT_KINDS 漂移', `产品=[${kinds.join(',')}]  套件=[${EVENT_KINDS.join(',')}]`)
    // 夹具默认值必须在枚举内，否则会毒死整库
    if (!kinds.includes('ledger')) add('error', '夹具默认 kind=ledger 已不在枚举内', `产品=[${kinds.join(',')}]`)
  }

  // 四类感知的字段白名单是否变了
  const pf = store.match(/PERCEPT_ITEM_FIELDS\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/)
  if (pf) {
    for (const k of ['userPercept', 'agentTrace', 'sharedGround', 'commitments']) {
      if (!pf[1].includes(k)) add('warn', `PERCEPT_ITEM_FIELDS 里没有 ${k}`, '套件的感知判据可能需要改')
    }
  } else {
    add('warn', 'PERCEPT_ITEM_FIELDS 结构变了', '套件按旧结构判分，需复核')
  }

  // 事件字段数（夹具造 26 字段）
  const top = store.match(/EVENT_TOP_FIELDS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/)
  if (top) {
    const n = top[1].split(',').map(s => s.trim()).filter(Boolean).length
    if (n !== 26) add('error', `事件顶层字段数变了（产品 ${n}，夹具造 26）`, '夹具必须同步，否则预置数据会被判非法')
  }
}

// ── 2. 判据函数签名漂移 ──
const wbc = readSrc('lib/wb-contract.js')
if (!wbc) {
  add('error', '找不到 lib/wb-contract.js', '判据函数是套件 A/C 的评分依据')
} else {
  if (!/export function checkHandoffCriteriaPre/.test(wbc)) {
    add('error', 'checkHandoffCriteriaPre 导出改变了', '套件 handoff.mjs 直接 import 它')
  }
  if (!/hardPass/.test(wbc)) add('error', '判据返回值里没有 hardPass', '套件按 hardPass 判定')
}

// ── 3. 工具 schema 漂移（steps 是 string 这一条最容易误判） ──
const idx = readSrc('lib/index.js')
if (idx) {
  // memory_procedure 的 steps 类型
  const m = idx.match(/defineTool\('memory_procedure'[\s\S]{0,4000}?steps:\s*\{\s*type:\s*'(\w+)'/)
  if (m) {
    if (m[1] !== 'string') {
      add('warn', `memory_procedure.steps 类型变成了 ${m[1]}`, '套件按 string（一行一步）判分，需改 judge.mjs')
    }
  } else {
    add('warn', '找不到 memory_procedure 的 steps 定义', '可能工具被改名或重排')
  }

  // memory_note 是否还支持四类感知参数
  for (const k of ['userPercept', 'agentTrace', 'sharedGround', 'commitment']) {
    const re = new RegExp(k + ":\\s*\\{\\s*type:\\s*'object'")
    if (!re.test(idx)) {
      add('warn', `memory_note 可能不支持 ${k} 参数`, '套件场景会写入不进去')
    }
  }

  // 接续仪式提示词是否还在
  if (!/refreshRitualPrompt\(\)\s*\{/.test(idx)) {
    add('error', 'refreshRitualPrompt() 不见了', '套件 B 的被测对象消失')
  }
} else {
  add('error', '找不到 lib/index.js', '')
}

// ── 4. 沙箱配置一致性 ──
const cfgPath = path.join(PATHS.dshHome, 'dsh-auto-memory.json')
if (fs.existsSync(cfgPath)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    const root = String(cfg.memoryRoot || '')
    if (/\.dsh[\\/]memory/.test(root)) add('error', '沙箱配置指向真实记忆库', root)
    if (!/^[A-Za-z]:/.test(root)) add('error', 'memoryRoot 不是绝对路径', root + '（~/ 会被 os.homedir() 展开）')
    if (String(cfg.semanticEngineMode) === 'python') {
      add('warn', 'semanticEngineMode=python', 'Python worker 会引入启动噪声与超时，建议改 lexical')
    }
    if (Array.isArray(cfg.externalSources) && cfg.externalSources.length) {
      add('warn', `externalSources 有 ${cfg.externalSources.length} 项`, '外部记忆源会引入无关变量')
    }
  } catch (e) {
    add('error', '沙箱配置不可解析', e.message)
  }
} else {
  add('warn', '沙箱配置未建', '跑 node setup/init-profile.mjs')
}

// ── 输出 ──
console.log('=== 漂移检查 ===')
console.log(`被测仓库 ${REPO}`)
console.log('')
if (!findings.length) {
  console.log('✓ 无漂移：套件常量与产品契约一致')
} else {
  const errs = findings.filter(f => f.level === 'error')
  const warns = findings.filter(f => f.level === 'warn')
  for (const f of findings) {
    console.log(`  ${f.level === 'error' ? '✗' : '!'} ${f.what}`)
    if (f.detail) console.log(`      ${f.detail}`)
  }
  console.log('')
  console.log(`error ${errs.length} · warn ${warns.length}`)
  if (errs.length) process.exitCode = 1
}
