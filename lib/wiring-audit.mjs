/**
 * 接线审计 —— 零成本静态检测「配置键 / 层 / 路由 / CSS 是否真的接通」。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 为什么需要这一层（与 suites/ 的分工）
 * ═══════════════════════════════════════════════════════════════════
 *   suites/     跑模型：花钱、慢、测「模型行为」
 *   本模块      不跑模型：零成本、瞬时、测「代码接线」
 *
 * 它回答的是**跑实验之前**必须先回答的问题：
 *   ① 我改的这个键，后端到底读不读？（死键 ⇒ 改了完全无效）
 *   ② 前端有这个开关，后端有没有消费点？（死开关 ⇒ 用户拨了没反应）
 *   ③ 后端读了某个键，前端有没有入口？（反查 ⇒ 用户碰不到）
 *   ④ client 与 server 的键集合一致吗？（镜像漂移 ⇒ 一处加另一处没加）
 *   ⑤ client 依赖的路由 / CSS 选择器在契约里存在吗？（接线断点）
 *
 * ═══════════════════════════════════════════════════════════════════
 * 三条硬纪律（每条都对应本仓一次真实误判）
 * ═══════════════════════════════════════════════════════════════════
 *   1. **不抄常量，运行时从产品源码解析。**
 *      产品的键名/层名/枚举一直在变，抄下来必然漂移，而漂移是**静默**的。
 *
 *   2. **读法要全。** 实测教训：首版只匹配 `this.config.X`，于是
 *      `engine.config.injectEnabled`（真实读法）被判成「零读取」
 *      ⇒ 43 个假阳性，其中包含 injectEnabled / fullInjectWaterPct 这种**核心开关**。
 *      现在覆盖 this/engine/self/that/host/config 前缀 + 点号与方括号两种取法 + 解构。
 *
 *   3. **读不到就明确报错，不回落。** 空表最危险：所有键都会被判成「无读取点」。
 *
 * 产物是「分级 findings」，不是布尔结论 —— 因为其中一部分（如废弃键）是**合理存在**的，
 * 只有带 deprecated 标记的才降级；其余一律按可疑项报出，由人判断。
 */
import fs from 'node:fs'
import path from 'node:path'
import { REPO } from './config.mjs'

const LIB = path.posix.join(REPO, 'lib')

/**
 * 参与扫描的产品源码（排除 .bak / 历史副本 **以及 client.js**）。
 *
 * ⚠️ 实测教训（假阴性）：首版把 client.js 也纳入「后端读点」扫描，
 *    而前端大量 `cfg.workbenchLoopShort`（读回来**显示**在表单里）被当成后端消费
 *    ⇒ 真实死开关 `workbenchLoopShort` / `settingsEntryInDsSettings` 被判成「有读取点」
 *    ⇒ 死开关检测报 0 条（全部漏报）。
 *
 *    正确口径：**后端 = 除 client.js 与纯 UI 资源外的宿主代码**。
 *    前端读回来渲染 ≠ 后端消费。
 */
function productFiles(opts = {}) {
  const out = []
  let ents = []
  const dir = opts.dir || LIB
  try { ents = fs.readdirSync(dir) } catch (e) {
    return { ok: false, error: '读不到产品 lib/：' + String(e && e.message || e) }
  }
  for (const f of ents) {
    if (!f.endsWith('.js')) continue
    if (/\.(bak|orig|rej|old|copy)/i.test(f) || /~\d*$/.test(f)) continue
    if (f === 'client.js') continue // 前端半边，不算后端读点
    if (opts.includeClient && f === 'client.js') { /* 显式要求时例外 */ }
    out.push(path.posix.join(dir, f))
  }
  return { ok: true, files: out }
}

/**
 * 提取「后端所有配置读取点」。
 *
 * 覆盖的读法（每一条都是实测中真实出现过的形态）：
 *   this.config.X / engine.config.X / self.config.X / that.config.X / host.config.X
 *   cfg.X / config.X / cfg['X']
 *   const { a, b } = this.config   （解构 —— 本仓 memory-writer 一带用过）
 */
export function extractConfigReads(files, knownKeys = []) {
  const reads = new Map() // key -> Set(file)
  const weak = new Map()  // key -> Set(file)：动态键 / 整体传参推导出的「弱读点」
  const add = (m, k, f) => {
    if (!k) return
    if (!m.has(k)) m.set(k, new Set())
    m.get(k).add(f)
  }
  const keySet = new Set(knownKeys)
  const PATTERNS = [
    /(?:this|engine|self|that|host|pre|plugin|ctx)\s*\.\s*config\s*\.\s*([A-Za-z_$][\w$]*)/g,
    /(?:this|engine|self|that|host|pre|plugin|ctx)\s*\.\s*config\s*\[\s*['"]([A-Za-z_$][\w$]*)['"]\s*\]/g,
    /\bcfg\s*\.\s*([A-Za-z_$][\w$]*)/g,
    /\bcfg\s*\[\s*['"]([A-Za-z_$][\w$]*)['"]\s*\]/g,
    /(?:^|[^.\w])config\s*\.\s*([A-Za-z_$][\w$]*)/g,
    // ★动态键：this.config[key] / cfg[key] —— 键由变量给出
    //   实测：noteCapacityChars 只在 `for (const key of [...]) { Number(this.config[key]) }` 里被读
    //   ⇒ 首版漏这类形态，把它误报成死开关（假阳性）。
    //   这里无法静态知道 key 的取值，故采取**保守策略**：出现动态键读取时，
    //   把同文件内**字符串数组字面量里出现的配置键**一律视为「可能被读取」。
    /(?:this|engine|self|that|host)\s*\.\s*config\s*\[\s*([A-Za-z_$][\w$]*)\s*\]/g,
  ]
  // 解构读法：const { a, b } = this.config / = cfg
  const DECOMP = /const\s*\{([^}]{1,400})\}\s*=\s*(?:this|engine|self|that|host)\s*\.\s*config\b/g
  // 整体传参读法：fn(engine.config) / fn(this.config, …) —— 读点在函数内部，静态追不到。
  //   实测：procedureInjectEnabled 由 resolveProcedureInjectEnabledPre(engine.config) 消费。
  //   保守策略：只要文件里出现把 config 整体传出去的调用，就认为该文件「可能消费任意配置键」，
  //   故把该文件内出现的**配置键字面量**（在字符串或注释中被点名的）记为弱读点。
  const WHOLE_CONFIG = /\([^)]*(?:engine|this|self)\.config\b[^)]*\)/g

  for (const f of files) {
    let src = ''
    try { src = fs.readFileSync(f, 'utf8') } catch (_) { continue }
    const base = path.basename(f)
    for (const p of PATTERNS) {
      // 最后一条是动态键（this.config[key]）——不能把所有键都标成可读，
      // 只在同文件里能**找到该键名的字符串字面量**时才算弱读（见下）
      if (p === PATTERNS[5]) continue
      for (const m of src.matchAll(p)) add(reads, m[1], base)
    }
    for (const m of src.matchAll(DECOMP)) {
      for (const part of m[1].split(',')) {
        const name = part.split(':')[0].split('=')[0].trim()
        if (/^[A-Za-z_$][\w$]*$/.test(name)) add(reads, name, base)
      }
    }
    // 弱读点推导：只在**紧邻上下文**里能确立「该键会被动态索引」时才记弱读。
    //
    //   ⚠️ 首版过于宽松：文件里只要出现 `this.config[key]`，就把该文件内
    //      **所有**配置键字面量都算弱读 ⇒ 真缺陷（workbenchLoopShort 等）全被掩盖
    //      ⇒ 报告全绿（假阴性）。这是比误报更危险的失效方向。
    //
    //   收紧后的判据（三者同时满足）：
    //     ① 该键在文件里作为**字符串字面量**出现（不是随便出现标识符）
    //     ② 该键字面量半径 1200 字符内存在 `config[...]` 动态索引
    //     ③ 或该键字面量出现在 `for (const X of [...])` 之类的候选清单里
    //   这样 noteCapacityChars（在 `for (const key of ['note…','user…']) { this.config[key] }`）
    //   能被认出来，而 workbenchLoopShort（只在注释里被点名）不会被误判。
    const dynRe = /(?:this|engine|self|that|host)\s*\.\s*config\s*\[\s*[A-Za-z_$]/g
    const dynAt = []
    for (const m of src.matchAll(dynRe)) dynAt.push(m.index)
    if (dynAt.length) {
      for (const k of keySet) {
        for (const m of src.matchAll(new RegExp("['\"`]" + k + "['\"`]", 'g'))) {
          const near = dynAt.some((d) => Math.abs(d - m.index) <= 1200)
          if (near) { add(weak, k, base); break }
        }
      }
    }
// ★包装器读法：safeGet(cfg, 'teamServerUrl') / safeGet(configOf(), 'teamPushPath')
    //   首参可以是 配置对象名，也可以是返回配置的**函数调用**（configOf() / getConfig()）。
    for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(\s*((?:[A-Za-z_$][\w$]*\s*\(\s*\))|(?:[A-Za-z_$][\w$]*))\s*,\s*['"]([A-Za-z_$][\w$]*)['"]/g)) {
      const [, , objExpr, k] = m
      const head = objExpr.replace(/\s*\(\s*\)$/, '')
      if (!/^(cfg|config|conf|c|opts|o|settings|configOf|getConfig|cfgOf|resolveConfig)$/i.test(head)) continue
      add(reads, k, base)
    }
    // ★动态索引读法（最通用也最隐蔽）：
    //     const laneKey = lane === 'long' ? 'subagentReasoningEffortLong' : …Short
    //     const v = String((config && config[laneKey]) || '')
    //   ⇒ 字符串键先赋给变量，再作为 config[var] 的索引。
    //   判据：找出所有被用作 `config[var]` / `cfg[var]` / `c[var]` 索引的变量名，
    //        然后在**同文件**里把所有「该变量被赋值时提到的字符串字面量」记为弱读。
    //   （不再局限三元两分支：赋值表达式里出现的任意候选字符串都算。）
    const idxVars = new Set()
    for (const m of src.matchAll(/(?:config|cfg|conf|c|settings)\s*\[\s*([A-Za-z_$][\w$]*)\s*\]/g)) idxVars.add(m[1])
    if (idxVars.size) {
      for (const v of idxVars) {
        const assignRe = new RegExp('(?:const|let|var)\\s+' + v + '\\s*=([^\\n]{0,400})', 'g')
        for (const m of src.matchAll(assignRe)) {
          for (const s of m[1].matchAll(/['"]([A-Za-z_$][\w$]*)['"]/g)) {
            if (keySet.has(s[1])) add(weak, s[1], base)
          }
        }
      }
    }
    // ★别名变量读法（最隐蔽的一种）：
    //     const c = cfg || {}
    //     if (typeof c.procedureInjectEnabled === 'boolean') return c.procedureInjectEnabled
    //   实测 lib/procedure-switch.js:27-28 —— 配置对象先被赋给短别名 c，再 c.X 取。
    //   静态通用解法：先收集文件内所有「疑似配置别名」变量名（= cfg / = this.config / = engine.config），
    //   再把这些别名上的 .X 取法当作读点。
    const ALIAS = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\|\|\s*\{\s*\}?/g
    const aliases = new Set()
    for (const m of src.matchAll(ALIAS)) {
      // `const c = cfg || {}` 形态：右侧是疑似配置名就记为别名
      if (/^(cfg|config|conf|settings)$/i.test(m[2])) aliases.add(m[1])
    }
    // 也覆盖 `const c = engine.config` / `const c = this.config`
    for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:this|engine|self|that|host)\s*\.\s*config\b/g)) {
      aliases.add(m[1])
    }
    for (const a of aliases) {
      for (const m of src.matchAll(new RegExp('\\b' + a + '\\s*\\.\\s*([A-Za-z_$][\\w$]*)', 'g'))) {
        add(reads, m[1], base)
      }
    }
  }
  return { reads, weak }
}

/** 解析 DEFAULT_CONFIG 的键清单 + 每个键的注释块（用于识别「已废弃」）。 */
export function extractDefaultConfig(src) {
  const start = src.indexOf('const DEFAULT_CONFIG')
  if (start < 0) return { ok: false, error: '找不到 DEFAULT_CONFIG（产品形态变了）' }
  // 找到对象结束：从 start 起做花括号配平
  const openBrace = src.indexOf('{', start)
  let depth = 0, end = -1
  for (let i = openBrace; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break } }
  }
  if (end < 0) return { ok: false, error: 'DEFAULT_CONFIG 花括号不配平（解析失败）' }
  const body = src.slice(openBrace, end)
  const lines = body.split('\n')
  const keys = []
  const deprecated = new Set()
  let commentBuf = []
  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) { commentBuf.push(t); continue }
    const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(t)
    if (m) {
      keys.push(m[1])
      const ctx = commentBuf.join(' ')
      // ★废弃识别：注释块里点名了**这个键名本身**才算（避免「上一个键的废弃注释
      //   波及下一个键」——实测 slimPlanChars 的注释块里提到了 slimLedgerChars，
      //   若只看关键词不看键名，两个键都会被判废弃，而实际语义应各自判定）。
      const named = new RegExp('\\b' + m[1] + '\\b').test(ctx)
      if (named && /已废弃|废弃|deprecated|DEPRECATED|已删除|不再使用|死键|曾计划/.test(ctx)) {
        deprecated.add(m[1])
      }
      commentBuf = []
    } else if (t && !t.startsWith('}')) {
      if (commentBuf.length > 12) commentBuf = commentBuf.slice(-12)
    }
  }
  return { ok: true, keys, deprecated, total: keys.length }
}

/**
 * 提取前端（client.js）里的配置键：set('k', …) 与 cfg.k 两种读法。
 */
export function extractClientKeys(src) {
  const setKeys = new Set()
  const readKeys = new Set()
  for (const m of src.matchAll(/\bset\s*\(\s*['"]([A-Za-z_$][\w$]*)['"]/g)) setKeys.add(m[1])
  for (const m of src.matchAll(/\bcfg\s*\.\s*([A-Za-z_$][\w$]*)/g)) readKeys.add(m[1])
  for (const m of src.matchAll(/\bcfg\s*\[\s*['"]([A-Za-z_$][\w$]*)['"]\s*\]/g)) readKeys.add(m[1])
  return { setKeys, readKeys }
}

/**
 * 提取两端 API 常量表并按**逻辑名**比对。
 *
 * 为什么不用字符串搜路径（首版做法，实测两处误判）：
 *   ① 前端 `fetch('https://<任意外站>/…/blob/main/docs/…')` 被当成路由 ⇒ 假阳性；
 *   ② 后端路由是 `API.state` 常量间接注册的，路径字面量一条都搜不到
 *      ⇒ 后端 0 条 ⇒ 前端全部判缺失 ⇒ 假阳性一片。
 *
 * 真实契约（实测 lib/index.js:400-470 / lib/client.js:3880-3900）：
 *      服务端 `API = { state: '<prefix>/state', … }`
 *   前端   `ROUTE_PREFIX + '/state'`，其 key 集合与后端**同源**
 * ⇒ 按**逻辑名**（state/list/file…）比对，路径形态差异（前缀拼接）不影响判定。
 */
export function extractApiTables(files, clientSrc) {
  const parseTable = (src, anchor) => {
    const i = src.indexOf(anchor)
    if (i < 0) return null
    const ob = src.indexOf('{', i)
    if (ob < 0) return null
    let depth = 0, end = -1
    for (let k = ob; k < src.length; k++) {
      if (src[k] === '{') depth++
      else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break } }
    }
    if (end < 0) return null
    const body = src.slice(ob, end)
    const out = {}
    // ⚠️ 键有两种形态（实测 lib/index.js:402 与 :440）：
    //      state:        '/api/…/state'      ← 标识符键
    //      'reflect-auto': '/api/…/reflect-auto'  ← 带引号字符串键（连字符不能做标识符）
    //    首版只匹配标识符键 ⇒ 带连字符的路由全部漏掉 ⇒ 前端判 42 条「缺失」（假阳性）。
    for (const m of body.matchAll(/(?:['"]([^'"]+)['"]|([A-Za-z_$][\w$]*))\s*:\s*([^\n,]+)/g)) {
      const key = m[1] || m[2]
      if (!key) continue
      out[key] = m[3].trim().replace(/^['"`]|['"`]$/g, '')
    }
    return Object.keys(out).length ? out : null
  }

  // 服务端：`const API = {`
  let server = null
  for (const f of files) {
    let src = ''
    try { src = fs.readFileSync(f, 'utf8') } catch (_) { continue }
    if (!/\bconst\s+API\s*=/.test(src)) continue
    server = parseTable(src, 'const API =')
    if (server) break
  }

  // 前端：`state: ROUTE_PREFIX + '/state'` —— key 与路径尾段
  const client = {}
  if (clientSrc) {
    for (const m of clientSrc.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*ROUTE_PREFIX\s*\+\s*'([^']+)'/g)) {
      client[m[1]] = m[2]
    }
  }
  return { server, client }
}

/**
 * 主入口：跑全套审计，返回分级 findings。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.frontend=true]  是否做前端检查（client.js 存在才做）
 * @returns {{ok:boolean, error?:string, findings:Array, stats:object}}
 */
export function auditWiring(opts = {}) {
  const findings = []
  const push = (level, code, msg, extra = {}) => findings.push({ level, code, msg, ...extra })

  const pf = productFiles()
  if (!pf.ok) return { ok: false, error: pf.error, findings, stats: {} }

  const indexPath = path.posix.join(LIB, 'index.js')
  let idx = ''
  try { idx = fs.readFileSync(indexPath, 'utf8') } catch (e) {
    return { ok: false, error: '读不到 lib/index.js：' + String(e && e.message || e), findings, stats: {} }
  }

  // ── ① 后端：配置键读取点 ──
  const cfgDef = extractDefaultConfig(idx)
  if (!cfgDef.ok) return { ok: false, error: cfgDef.error, findings, stats: {} }

  const readRes = extractConfigReads(pf.files, cfgDef.keys)
  const reads = readRes.reads
  const weakReads = readRes.weak

  // integrity 守卫：解析出来的键若一个都读不到，说明读法提取坏了（不许静默）
  if (reads.size === 0) {
    return {
      ok: false,
      error: '提取到 0 个配置读取点 —— 读法匹配失效（产品读法变了？）',
      findings, stats: { keys: cfgDef.total },
    }
  }

  const zeroRead = []
  const weakOnly = []
  for (const k of cfgDef.keys) {
    if (reads.has(k)) continue
    if (weakReads.has(k)) { weakOnly.push(k); continue }
    zeroRead.push(k)
  }

  for (const k of zeroRead) {
    if (cfgDef.deprecated.has(k)) {
      push('info', 'deprecated-key',
        `配置键 "${k}" 后端零读取，但注释标了「已废弃」—— 属合理存在，建议最终清理`,
        { key: k })
    } else {
      push('warn', 'server-dead-key',
        `配置键 "${k}" 在 DEFAULT_CONFIG 里定义，但全 lib/ 无任何读取点 —— 改了完全无效`,
        { key: k, hint: '要么接线，要么删键；若它只给前端读，应在注释里标明' })
    }
  }

  // ── ②③④ 前端检查 ──
  let clientSrc = null
  const clientPath = path.posix.join(LIB, 'client.js')
  if (fs.existsSync(clientPath)) {
    try { clientSrc = fs.readFileSync(clientPath, 'utf8') } catch (_) { clientSrc = null }
  }

  const stats = {
    keys: cfgDef.total,
    deprecated: cfgDef.deprecated.size,
    backendReadKeys: reads.size + weakOnly.length,
    weakReadKeys: weakOnly.length,
    serverDeadKeys: zeroRead.filter(k => !cfgDef.deprecated.has(k)).length,
    clientKeys: 0,
    clientDeadSwitches: 0,
    serverOnlyKeys: 0,
    routesClient: 0,
    routesServer: 0,
    missingRoutes: 0,
  }

  if (clientSrc && opts.frontend !== false) {
    const { setKeys, readKeys } = extractClientKeys(clientSrc)
    const clientAll = new Set([...setKeys, ...readKeys])
    stats.clientKeys = clientAll.size

    // ② 死开关：前端有 set()，后端无读取点
    for (const k of setKeys) {
      const inDefaults = cfgDef.keys.includes(k)
      // 弱读点存在时不下「死开关」定论 —— 那是静态追不到的消费形态（如整体传参）
      if (reads.has(k) || weakReads.has(k)) continue
      push('warn', 'dead-switch',
        `前端开关 "${k}" 调 set() 落盘，但后端无任何读取点 —— 用户拨了完全没反应`
          + (inDefaults ? '' : '（且该键不在 DEFAULT_CONFIG 里）'),
        { key: k })
      stats.clientDeadSwitches++
    }

    // ④ 镜像一致性：前端 set() 的键是否都在服务端 DEFAULT_CONFIG 里
    const missing = [...setKeys].filter(k => !cfgDef.keys.includes(k))
    for (const k of missing) {
      push('warn', 'mirror-drift',
        `前端写配置键 "${k}"，但服务端 DEFAULT_CONFIG 没有这个键 —— 未知键可能被静默丢弃`,
        { key: k })
    }

    // ③ 反查：后端有读取点、但前端既无 set 也无读 —— 用户碰不到
    //    排除纯运维键（路径/内部），它们本就该只由配置文件控制
    const OPS_ONLY = /(Path|Dir|Root|File|Url|Url$|Env|Key$|Port|Host|Token|Version|Model$)/i
    for (const k of reads.keys()) {
      if (!cfgDef.keys.includes(k)) continue      // 只审真配置键
      if (clientAll.has(k)) continue
      if (cfgDef.deprecated.has(k)) continue
      if (OPS_ONLY.test(k)) continue              // 路径/凭据类：不要求 UI
      push('info', 'no-ui-entry',
        `配置键 "${k}" 后端有读取点，但前端无任何入口 —— 用户只能改配置文件`,
        { key: k })
      stats.serverOnlyKeys++
    }

    // ⑤ 路由接线（按**路径尾段**比对）
    // ⚠️ 实测：两端同一路由的**键名不同形态** ——
    //      前端  reflectAuto: ROUTE_PREFIX + '/reflect-auto'
    //      后端  'reflect-auto': '<prefix>/reflect-auto'（带引号键）
    //    按逻辑名（camelCase vs kebab）比会全判缺失（实测 42 条全假阳性）。
    //    路径尾段两边**逐字相同** ⇒ 用尾段做比对基准。
    //
    // ⚠️ 纪律：**不硬编码产品路由前缀**。本套件的宗旨是「运行时从产品源码解析」，
    //    抄一个 `/api/<插件名>` 进去，产品改名时套件不会报错、只会静默判全缺失。
    //    ⇒ 前缀从**前端自己的 `ROUTE_PREFIX = '…'` 声明**里取（产品自带，天然同步）。
    const api = extractApiTables(pf.files, clientSrc)
    const prefixM = /var\s+ROUTE_PREFIX\s*=\s*['"]([^'"]+)['"]/.exec(clientSrc || '')
    const routePrefix = prefixM ? prefixM[1] : null
    if (!routePrefix) {
      push('info', 'no-route-prefix',
        '前端没有 `ROUTE_PREFIX = "…"` 声明 —— 跳过路由比对（产品形态变了，需更新解析）')
    }
    const canon = (p) => {
      let s = String(p || '').replace(/^\/+/, '')
      if (routePrefix) {
        const pre = routePrefix.replace(/^\/+/, '')
        if (s.startsWith(pre)) s = s.slice(pre.length)
      }
      return s.replace(/^\/+/, '')
    }
    const srvSet = new Set(api.server ? Object.values(api.server).map(canon) : [])
    const cliPairs = Object.entries(api.client)
    stats.routesServer = srvSet.size
    stats.routesClient = cliPairs.length
    if (!api.server) {
      push('info', 'no-server-api-table',
        '找不到服务端 API 常量表（产品和套件的解析假设不一致）—— 跳过路由比对')
    } else if (routePrefix) {
      for (const [k, p] of cliPairs) {
        const tail = canon(p)
        if (!srvSet.has(tail)) {
          push('warn', 'route-path-missing',
            `前端 API.${k} 指向 "${p}"（尾段 /${tail}），服务端 API 表无此路径 —— 该请求会 404`,
            { route: k, path: p })
          stats.missingRoutes++
        }
      }
    }
  } else if (opts.frontend !== false) {
    push('info', 'no-client',
      'lib/client.js 不存在或不可读 —— 跳过前端检查（只做了后端死键）')
  }

  // ── ⑥ 块级作用域越界（能通过 node --check 与静态断言，却让整条分支静默失效）──
  try {
    const leaks = detectBlockScopeLeaks(pf.files)
    stats.scopeLeaks = leaks.length
    // 默认 info（启发式、可能误报）；只有 --strict-scope 才升级为 warn
    const scopeLevel = opts.strictScope ? 'warn' : 'info'
    for (const L of leaks) {
      push(scopeLevel, 'block-scope-suspect',
        `${L.file}:${L.line} ${L.msg}（启发式提示，需真执行确认，勿直接定缺陷）`,
        { key: L.name, file: L.file, line: L.line })
    }
  } catch (e) {
    // 检测器自身出错不许静默 —— 明确报告"这项没做"
    push('info', 'scope-check-failed', '块级作用域检测未能执行：' + String(e && e.message || e))
    stats.scopeLeaks = null
  }

  return { ok: true, findings, stats }
}

/**
 * ★块级作用域越界检测 —— **启发式，低置信，默认只报 info**。
 *
 * ═══ 诚实声明（这一节的可靠性边界） ═══
 * 试过三种判据，都做不到「零误报」：
 *   ① 固定窗口 6000 字符 ⇒ 越过函数边界 ⇒ 733 条（同名局部变量到处都有）
 *   ② 按函数体收口 + 深度==1 ⇒ 24 条，但抽查仍是误报
 *   ③ 本版（深度==1 + 父块内 + 停在下一个 try 前）⇒ 见下，仍可能误报
 *
 * 实测误报样例（必须写下来，否则后来者会把它们当真）：
 *   · `index.js:5556` 的 `low`：try 内是 `const low = (x) => …`（箭头函数），
 *     catch 之后 30 行外是**另一个函数**里的 `const low = line.toLowerCase()`。
 *   · `index.js:2263` 的 `dir`：`for (const dirName of …) { const dir = … }` 循环内声明。
 *
 * ⇒ 因此本检测器**不用于「定罪」**，只用于「提示去看一眼」。
 *   真缺陷（如 `_rqK`）必须靠**真执行**确认：抽出来 `new Function` 跑一遍，
 *   或按真实作用域形状复现（见 tests 里的负路径用例）。
 *
 * 保留它的价值：即使有误报，它也能把「try 内声明 + catch 后用同名」这个**高危形态**
 * 集中列出来 —— 而这类形态真出问题时，症状是「功能静默不生效」，极难从日志发现。
 */
/**
 * 找到包含 pos 的**最近函数/方法体**起点。
 *
 * 判据：从 pos 往前扫，找「`name(...) {` / `function (...) {` / `=> {`」且其花括号
 *       真正包住 pos 的位置。不做完整 AST，只求把"别的函数里的同名变量"排除掉。
 */
function findEnclosingFunctionStart(src, pos) {
  const re = /(?:function\s+[\w$]*\s*\([^)]*\)\s*\{|(?:async\s+)?[\w$]+\s*\([^)]*\)\s*\{|=>\s*\{)/g
  let best = -1
  for (const m of src.matchAll(re)) {
    if (m.index >= pos) break
    const ob = src.indexOf('{', m.index + m[0].length - 1)
    if (ob < 0 || ob > pos) continue
    let depth = 0, end = -1
    for (let i = ob; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break } }
    }
    if (end > pos) best = m.index // 能包住 pos，继续往后找更靠近的
  }
  return best
}

/** 从函数起点找出其函数体的结束位置 */
function findFunctionEnd(src, fnStart) {
  const ob = src.indexOf('{', fnStart)
  if (ob < 0) return -1
  let depth = 0
  for (let i = ob; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return i }
  }
  return -1
}

/**
 * 构建「每个位置的外层开括号索引」表 —— 单遍 O(n)。
 *
 * outerAt[i] = 覆盖位置 i 的**最近外层** `{` 的索引（顶层为 -1）。
 * 有了它，问「某块在哪结束 / 它的父块是谁」都是 O(1)，不必反复配平。
 */
function buildOuterTable(src) {
  const outerAt = new Int32Array(src.length + 1)
  const stack = []
  for (let i = 0; i < src.length; i++) {
    outerAt[i] = stack.length ? stack[stack.length - 1] : -1
    const c = src[i]
    if (c === '{') stack.push(i)
    else if (c === '}') stack.pop()
  }
  outerAt[src.length] = stack.length ? stack[stack.length - 1] : -1
  return outerAt
}

/**
 * 一次扫描算出全文所有花括号的配对表：`{` 索引 → 对应 `}` 索引。
 *
 * 为什么要这个：作用域检测要反复问「这个块在哪结束」。
 * 逐个 try 从头配平是 O(n²)——实测 index.js（27k 行）单文件 8.5 秒，
 * 直接把 selftest 的 3 秒性能断言挤爆。一次性算表后整体 O(n)。
 */
function buildBraceMap(src) {
  const map = new Map()
  const stack = []
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '{') stack.push(i)
    else if (src[i] === '}') {
      const open = stack.pop()
      if (open !== undefined) map.set(open, i)
    }
  }
  return map
}

export function detectBlockScopeLeaks(files) {
  const out = []
  for (const f of files) {
    let src = ''
    try { src = fs.readFileSync(f, 'utf8') } catch (_) { continue }
    const base = path.basename(f)
    // ★一次算好全文括号配对表（开括号索引 → 对应闭括号索引），供所有 try 共享。
    //   首版每个 try 都从头配平 ⇒ O(n²)，index.js 单文件 8.5 秒。
    const matchBrace = buildBraceMap(src)
    const outerAt = buildOuterTable(src)
    // 行号查询表：pos → 行号（避免每次 slice+split，那是 O(n²)）
    const lineStarts = [0]
    for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1)
    const lineOf = (pos) => {
      let lo = 0, hi = lineStarts.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1
      }
      return lo + 1
    }

    // 逐个 try 块处理：找到 `try {`，配平出块体，再取紧随其后的 catch
    const tryRe = /\btry\s*\{/g
    for (const tm of src.matchAll(tryRe)) {
      const bodyStart = src.indexOf('{', tm.index)
      const bodyEnd = matchBrace.get(bodyStart)
      if (bodyEnd == null) continue
      const block = src.slice(bodyStart, bodyEnd + 1)

      // ★只认 try 块体**最外层**的 const/let —— 循环/嵌套块里的声明不参与。
      //   实测误报根因：`for (const dirName of …) { const dir = … }` 里的 dir
      //   被当成 try 顶层声明 ⇒ 与 catch 之后的 `dir` 撞名 ⇒ 假阳性一片。
      //   判据：声明位置在块内的花括号深度必须 == 1（刚进 try 那一层）。
      const declared = []
      {
        // ★一次扫完块体求深度 + 同趟收集候选声明（首版每遇一个声明就回扫前缀 ⇒ 也是二次方）
        //   ⚠️ block 自身以 `{` 开头 ⇒ 从 i=1 开始扫，且把初始深度设为 1（= 刚进 try 那一层）。
        //      首版从 i=0 开始 ⇒ 第一个 `{` 就把深度推成 1，块内第一层随即变 2 ⇒ 永远认不出声明。
        let dd = 1
        for (let i = 1; i < block.length; i++) {
          const c = block[i]
          if (c === '{') { dd++; continue }
          if (c === '}') { dd--; continue }
          if (dd !== 1) continue
          if (c !== 'c' && c !== 'l') continue
          if (c === 'c' && !/^const\s/.test(block.slice(i, i + 6))) continue
          if (c === 'l' && !/^let\s/.test(block.slice(i, i + 4))) continue
          const m = /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/.exec(block.slice(i, i + 120))
          if (m) declared.push(m[1])
        }
      }
      if (!declared.length) continue

      // 紧随其后的 catch：`} catch (e) { … }`
      const afterBlock = src.slice(bodyEnd + 1, bodyEnd + 400)
      const cm = /^\s*catch\s*(?:\([^)]*\))?\s*\{/.exec(afterBlock)
      if (!cm) continue
      const catchBodyStart = bodyEnd + 1 + cm[0].length - 1
      const catchEnd = matchBrace.get(catchBodyStart)
      if (catchEnd == null) continue
      const catchBody = src.slice(catchBodyStart, catchEnd + 1)

      // 从 catch 结束往后找同名引用，但**不得越过当前封闭块边界**。
      //
      //   ⚠️ 首版固定看 6000 字符 ⇒ 跨过了函数边界，把**别的函数**里的同名局部变量
      //     （rv / req / box / miv 到处都有）全算成越界引用 ⇒ 733 条误报。
      //   ⇒ 用预计算括号表，把搜索限制在 **try 所在的那一层父块**（函数体）内。
      //     ⚠️ 注意别用 bodyStart 的配对（那只是 try 自己的结束，56 行），
      //        必须往外一层：从 bodyStart 的**父块**起算。
      const enclosing = (() => {
        // 父块 = 覆盖 try 开括号的最近外层 `{`；它的终点就是"同一段代码"的边界
        const parentOpen = outerAt[bodyStart]
        if (parentOpen < 0) return src.length
        const pc = matchBrace.get(parentOpen)
        return pc == null ? src.length : pc
      })()
      const tailEnd = enclosing
      const tail = src.slice(catchEnd + 1, tailEnd)
      for (const name of new Set(declared)) {
        // 引用判据：出现该标识符，且**不是**声明
        const refRe = new RegExp('\\b' + name + '\\b', 'g')
        let hit = null
        for (const m of tail.matchAll(refRe)) {
          const segStart = Math.max(0, m.index - 60)
          const seg = tail.slice(segStart, m.index + name.length + 20)
          if (/\b(?:const|let|var)\s+$/.test(tail.slice(segStart, m.index))) continue // 是声明
          hit = m.index
          break
        }
        if (hit === null) continue

        // 该引用是否被一个 try/catch 包着（空 catch ⇒ 高置信：异常会被静默吞掉）
        const absIdx = catchEnd + 1 + hit
        const lineNo = lineOf(absIdx)
        const swallowed = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(src.slice(absIdx, absIdx + 2000))
        out.push({
          file: base, line: lineNo, name,
          declLine: lineOf(bodyStart),
          catchLine: lineOf(catchEnd),
          emptyCatchNearby: swallowed,
          msg: `"${name}" 在 try 块内声明（第 ${lineOf(bodyStart)} 行起的块），`
            + `但 catch 之后第 ${lineNo} 行仍引用它 ⇒ 运行时 ReferenceError`
            + (swallowed ? '，且邻近有空 catch ⇒ 异常被静默吞掉，整条分支永不生效' : ''),
        })
      }
    }
  }
  return out
}

/** 把 findings 按级别汇总成一行人类可读摘要 */
export function summarizeWiring(res) {
  if (!res.ok) return '✗ 接线审计无法完成：' + res.error
  const by = { warn: 0, info: 0 }
  for (const f of res.findings) by[f.level] = (by[f.level] || 0) + 1
  const s = res.stats
  return `键 ${s.keys}（后端可读 ${s.backendReadKeys}）· 服务端死键 ${s.serverDeadKeys}`
    + ` · 前端键 ${s.clientKeys} · 死开关 ${s.clientDeadSwitches}`
    + ` · 后端有前端无 ${s.serverOnlyKeys}`
    + ` · 路由 client ${s.routesClient}/server ${s.routesServer} 缺 ${s.missingRoutes}`
    + ` ⇒ warn ${by.warn} / info ${by.info}`
}