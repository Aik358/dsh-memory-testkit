/**
 * 提示词层注册表 —— **运行时从产品源码解析**，不抄常量。
 *
 * ═══ 为什么需要它（这是批次 4 的地基）═══
 * 做声明式实验时，最危险的不是「配置写错」，而是**配置写得完全对、但那个变量
 * 根本不在任何一条会被走到的渲染路径上**。这种实验会跑完、会出报告、会全绿，
 * 唯一的真相是「你测的不是你以为的东西」。
 *
 * 实证（2026-11-03）：`snapshotMinGapRounds: 0` ⇒ 精简版分支不触发 ⇒
 * `snapshotSlimMaintain` 等 5 层根本不渲染，而 `prompt-variants.mjs` 四个变体
 * 改的正是这一层。整批实验的结论都是空转。
 *
 * ⇒ 本模块回答三个问题，供 `validate` 做硬校验：
 *   ① 这一层有没有消费点？（死键改了无效）
 *   ② 它属于哪条注入路径？（slim / dynamic / static）
 *   ③ 给定的注入节奏下，那条路径**会不会被走到**？
 *
 * ═══ 解析策略 ═══
 * 不靠正则猜单行调用，而是**先切出渲染函数体，再在体内找该层的 key**。
 * 这样 `L('x')`、`_lay('x')`、`ov.staticXxx` 三种读法都能覆盖，
 * 且不怕调用被拆成多行。
 *
 * 产品一改渲染函数名，本模块会显式报错（`resolveError`），不会静默返回空表 ——
 * 空表最危险：所有层都会被判成「无消费点」，或被判成「有」，两种都错。
 */
import fs from 'node:fs'
import path from 'node:path'
import { REPO } from './config.mjs'

const INDEX = path.posix.join(REPO, 'lib/index.js')

/** 三条注入路径。名字用于报告与校验错误信息。 */
export const PATHS = Object.freeze({
  SLIM: 'slim',        // renderSlimSnapshotPre —— 只在「非完整版帧」出现
  DYNAMIC: 'dynamic',  // renderMemoryDynamic —— 每轮动态快照
  STATIC: 'static',    // renderMemoryStatic —— system prompt 固定纪律
})

/**
 * 渲染函数 → 它属于哪条路径。
 * 函数名变了就报错，而不是默默少解析一条路径。
 */
const RENDERERS = [
  { fn: 'renderSlimSnapshotPre', path: PATHS.SLIM },
  { fn: 'renderMemoryDynamic', path: PATHS.DYNAMIC },
  { fn: 'renderMemoryStatic', path: PATHS.STATIC },
]

/** 切出 `name(...) {` 到下一个**同级类方法**之间的函数体。
 *
 * ⚠️ 不能简单地找「下一行 `xxx(...) {`」—— 函数体里到处是
 *    `if (...) {` / `for (...) {` / `while (...) {`，实测把 renderMemoryDynamic
 *    在 9,299 字符处就截断了（其中 21 个层因此被误判成「死键」）。
 *    判据必须是「类的同级方法声明」：行首少量缩进 + 标识符 + 参数表 + `{`，
 *    且标识符**不是**控制流关键字。
 */
const CONTROL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'do', 'else', 'try', 'finally',
  'return', 'throw', 'await', 'new', 'typeof', 'delete', 'void', 'yield',
])

function sliceMethod(src, fnName) {
  const head = new RegExp('^[ \\t]{1,4}' + fnName + '\\s*\\([^)]*\\)\\s*\\{', 'm')
  const m = src.match(head)
  if (!m) return null
  // 该方法的缩进量，同级方法必须同缩进
  const indent = m[0].match(/^[ \t]*/)[0].length
  const start = m.index
  const bodyStart = start + m[0].length

  const re = /^([ \t]{1,4})([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm
  re.lastIndex = bodyStart
  let mm
  while ((mm = re.exec(src))) {
    if (mm[1].length !== indent) continue          // 缩进不同 = 不是同级方法
    if (CONTROL_KEYWORDS.has(mm[2])) continue      // 控制流不是方法
    if (mm[2] === 'constructor') return src.slice(start, mm.index)
    return src.slice(start, mm.index)
  }
  return src.slice(start)
}

/**
 * 读产品源码，产出层注册表。
 *
 * @returns {{
 *   ok: boolean, error?: string, at: number,
 *   layers: Record<string, {chars:number, paths:string[], consumers:string[], dead:boolean}>,
 *   byPath: Record<string, string[]>,
 * }}
 */
export function buildLayerRegistry() {
  const out = { ok: false, at: Date.now(), layers: {}, byPath: {}, error: null }

  let src = ''
  try { src = fs.readFileSync(INDEX, 'utf8') } catch (e) {
    out.error = '读不到产品源码 ' + INDEX + '：' + String(e && e.message || e).slice(0, 160)
    return out
  }

  // ① 层清单（从源码里的 DEFAULT_PROMPT_LAYERS 对象字面量解析，而不是 import ——
  //    import 会执行整个插件模块，在套件进程里可能触发副作用）
  const decl = src.match(/const\s+DEFAULT_PROMPT_LAYERS\s*=\s*Object\.freeze\(\{([\s\S]*?)\n\}\)/)
  if (!decl) {
    out.error = '找不到 DEFAULT_PROMPT_LAYERS 的对象字面量（产品定义形态变了，需更新 lib/layers.mjs）'
    return out
  }
  // 只取顶层 key（2 空格缩进 + 标识符 + 冒号）
  const keys = [...decl[1].matchAll(/^ {2}([A-Za-z_$][\w$]*)\s*:/gm)].map(m => m[1])
  if (!keys.length) {
    out.error = 'DEFAULT_PROMPT_LAYERS 里解析不出任何层名（缩进口径可能变了）'
    return out
  }

  // ② 各渲染函数体
  const bodies = {}
  for (const r of RENDERERS) {
    const b = sliceMethod(src, r.fn)
    if (!b) {
      out.error = `找不到渲染函数 ${r.fn}()（产品重构了 —— 本模块要同步，不能静默少解析一条路径）`
      return out
    }
    bodies[r.path] = b
  }

  // ③ 逐层判定消费点
  for (const k of keys) {
    const consumers = []
    for (const r of RENDERERS) {
      // 三种读法：L('k') / _lay('k') / ov.k（对象属性直读，用于静态拆分节）
      const pats = [
        new RegExp("\\bL\\(\\s*'" + k + "'"),
        new RegExp("\\b_lay\\(\\s*'" + k + "'"),
        new RegExp('\\bov\\.' + k + '\\b'),
        new RegExp('\\bov\\[\\s*[\'"]' + k + '[\'"]\\s*\\]'),
      ]
      if (pats.some(p => p.test(bodies[r.path]))) consumers.push(r.fn)
    }
    // 该层默认文本长度（只用于报告参考，不影响判定）
    const lenM = decl[1].match(new RegExp('^ {2}' + k + '\\s*:\\s*([\'"])([\\s\\S]*?)\\1\\s*,', 'm'))
    out.layers[k] = {
      chars: lenM ? lenM[2].length : 0,
      paths: consumers.map(fn => (RENDERERS.find(r => r.fn === fn) || {}).path).filter(Boolean),
      consumers,
      dead: consumers.length === 0,
    }
  }

  for (const p of Object.values(PATHS)) {
    out.byPath[p] = keys.filter(k => out.layers[k].paths.includes(p))
  }
  out.ok = true
  return out
}

/**
 * 给定注入节奏，判断某条路径**会不会被走到**。
 *
 * 依据（产品源码实证）：
 *   · `snapshotMinGapRounds: 0`  ⇒ 每轮都是完整版 ⇒ SLIM 路径**永不触发**
 *   · `snapshotTieredInject: false` ⇒ 不下发精简版 ⇒ SLIM 路径永不触发
 *   · `injectEnabled: false`     ⇒ 整个注入关闭 ⇒ 三条路径都不触发
 *
 * 这是「静态可达性」，不是「这一跑一定发生」—— 精简版还受首帧、gap 计数等影响，
 * 但只要节奏允许，它**可能**出现；节奏不允许就一定不出现。
 * 校验只需要后者（能证明必然空跑的事）。
 *
 * @returns {{reachable:boolean, reason:string}}
 */
export function pathReachable(p, cfg) {
  const inject = cfg.injectEnabled !== false
  if (!inject) return { reachable: false, reason: 'injectEnabled=false，整个记忆注入关闭' }

  if (p === PATHS.STATIC || p === PATHS.DYNAMIC) {
    return { reachable: true, reason: '注入开启即可达' }
  }
  if (p === PATHS.SLIM) {
    if (cfg.snapshotTieredInject === false) {
      return { reachable: false, reason: 'snapshotTieredInject=false，不发精简版' }
    }
    const gap = Number(cfg.snapshotMinGapRounds)
    if (Number.isFinite(gap) && gap === 0) {
      return {
        reachable: false,
        reason: 'snapshotMinGapRounds=0 表示每轮都发完整版 ⇒ 精简版分支永不触发'
          + '（该路径的层改了等于没改，且不会报错）',
      }
    }
    return { reachable: true, reason: '节奏允许精简版出现' }
  }
  return { reachable: false, reason: '未知注入路径 ' + p }
}

/**
 * 「哪些层会因为当前配置而不可达」—— 供监控台与 validate 共用。
 * @returns {Array<{layer:string, paths:string[], reasons:string[]}>}
 */
export function unreachableLayers(registry, cfg) {
  if (!registry.ok) return []
  const out = []
  for (const [k, info] of Object.entries(registry.layers)) {
    if (info.dead) continue // 死键另有校验
    const blocked = []
    for (const p of info.paths) {
      const r = pathReachable(p, cfg)
      if (!r.reachable) blocked.push(p + '：' + r.reason)
    }
    // 只有当该层的**所有**路径都不可达时才真不可达
    if (blocked.length && blocked.length === info.paths.length) {
      out.push({ layer: k, paths: info.paths, reasons: blocked })
    }
  }
  return out
}
