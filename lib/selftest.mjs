/**
 * 套件自检 —— 保证「判分器本身没坏」。
 *
 * 为什么必须有这一层：
 *   判分逻辑在开发期静默失败过 **5 次**，每一次都把完全正确的模型判成 0 分，
 *   而且表面看像是「模型不行」。这种错误靠「再跑一次看数」发现不了 ——
 *   必须用离线的、可复算的断言钉死。
 *
 * 用法：node lib/selftest.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert'
import { PATHS, REPO } from './config.mjs'
import { parseNdjson, extractCalls, isOk, flat } from './driver.mjs'
import { collectWrites, judge, PERCEPT_STAGES, COMMIT_STATES, ENUM_SOURCES } from './judge.mjs'
import { makeEvent, EVENT_KINDS } from './fixtures.mjs'
import {
  parseVer, cmpVer, meets, resolveRunner, REQUIREMENTS, readProviderNeeds, detectEnv,
} from './env.mjs'
import { classify, isAmbient, isAgentSurface, fullSnapshot, compareSnapshot } from './sentinel.mjs'

let pass = 0
const failures = []
const pending = []
/**
 * 注册一个测试。
 *
 * ⚠️ 必须支持异步 —— 早版本是 `try { fn(); pass++ }`，**不 await**。
 *    于是任何 `t('x', async () => { …assert… })` 都会在断言执行前就记成「✓ 通过」，
 *    断言里的失败变成 unhandledRejection（只在进程末尾冒一行 node:internal 噪声）。
 *
 *    实测后果（2026-11-03）：新增的 4 个守卫全标了 async，**一个都没真跑**；
 *    用变异测试（往 suites 注入 gap=0）验证时守卫仍是绿的，才发现这一点。
 *    —— 「测试自己是绿的」是最不可信的一种绿。
 */
function t(name, fn) {
  const run = (v) => {
    if (v && typeof v.then === 'function') pending.push(v.then(
      () => { pass++; console.log('  ✓ ' + name) },
      (e) => {
        failures.push({ name, msg: String(e && e.message || e) })
        console.log('  ✗ ' + name)
        console.log('      ' + String(e && e.message || e).slice(0, 300))
      },
    ))
    else { pass++; console.log('  ✓ ' + name) }
  }
  try { run(fn()) } catch (e) {
    failures.push({ name, msg: String(e && e.message || e) })
    console.log('  ✗ ' + name)
    console.log('      ' + String(e && e.message || e).slice(0, 300))
  }
}

console.log('=== 套件自检 ===')

// ─────────────────────────────────────────────────────────────
// 1. 事件形状兼容（坑 3：NDJSON 平铺 vs 会话日志嵌套）
// ─────────────────────────────────────────────────────────────
t('flat() 同时接受平铺与嵌套两种事件形状', () => {
  assert.equal(flat({ type: 'tool_call', tool: 'x', input: { a: '1' } }).tool, 'x')
  const nested = flat({ type: 'tool/call', data: { name: 'y', arguments: '{}' } })
  assert.equal(nested.name, 'y')
  assert.equal(nested.arguments, '{}')
})

t('extractCalls 能配平 NDJSON 形态的调用与结果', () => {
  const ndjson = [
    { type: 'tool_call', tool: 'memory_note', input: { kind: 'handoff', content: 'x' }, callId: 'c1' },
    { type: 'tool_result', callId: 'c1', status: 'completed', result: '交接账本已写入: /p' },
  ].map(o => JSON.stringify(o)).join('\n')
  const { calls, results } = extractCalls(parseNdjson(ndjson))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].tool, 'memory_note')
  assert.match(results.get('c1'), /已写入/)
})

t('extractCalls 能配平会话日志形态（callId 藏在 message.toolCallId）', () => {
  const rows = [
    { type: 'tool/call', data: { name: 'memory_note', arguments: '{"kind":"handoff","content":"a"}', callId: 'k1' } },
    { type: 'tool/result', data: { message: { toolCallId: 'k1', content: [{ type: 'text', text: '已写入: /q' }] } } },
  ]
  const { calls, results } = extractCalls(rows)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].tool, 'memory_note')
  assert.match(results.get('k1'), /已写入/)
})

// ─────────────────────────────────────────────────────────────
// 2. 成功判定（坑 4：不能全仓搜 "error"）
// ─────────────────────────────────────────────────────────────
t('isOk：成功回执判为成功', () => {
  const r = new Map([['c1', '交接账本已写入: /p']])
  assert.equal(isOk({ callId: 'c1', tool: 'memory_note' }, r), true)
})

t('isOk：被判据门拦截判为失败', () => {
  const r = new Map([['c1', 'memory_note: 写入被判据门拦截（H1），原文件未改动：…']])
  assert.equal(isOk({ callId: 'c1', tool: 'memory_note' }, r), false)
})

t('isOk：无结果记录时按通过（NDJSON 可能缺结果行）', () => {
  assert.equal(isOk({ callId: 'nope', tool: 'memory_note' }, new Map()), true)
})

t('isOk：成功的写入之后跟一个失败的无关命令，写入仍算成功', () => {
  // 关键：模型常在一次成功之后又调一个失败的 pwsh。不能因此否掉成功。
  const r = new Map([
    ['ok1', '交接账本已写入: /p'],
    ['bad1', 'Error: something unrelated'],
  ])
  assert.equal(isOk({ callId: 'ok1', tool: 'memory_note' }, r), true)
  assert.equal(isOk({ callId: 'bad1', tool: 'pwsh' }, r), false)
})

// ─────────────────────────────────────────────────────────────
// 3. 账本选择（坑 1 & 2：取成功的那一版，不是最后一版也不是最终文本）
// ─────────────────────────────────────────────────────────────
t('collectWrites 只收成功的 memory_note，且带出四类感知', () => {
  const rows = [
    { type: 'tool_call', tool: 'memory_note', callId: 'c1', input: { kind: 'handoff', content: 'BAD', sharedGround: { claim: 'a' } } },
    { type: 'tool_result', callId: 'c1', status: 'completed', result: 'memory_note: 写入被判据门拦截（H1）' },
    { type: 'tool_call', tool: 'memory_note', callId: 'c2', input: { kind: 'handoff', content: 'GOOD', userPercept: { stage: 'accepted', kind: 'preference', text: '别用术语' } } },
    { type: 'tool_result', callId: 'c2', status: 'completed', result: '交接账本已写入: /p' },
  ]
  const w = collectWrites(rows)
  assert.equal(w.handoffs.length, 1, '被拒的那次不应计入')
  assert.equal(w.handoffs[0].content, 'GOOD')
  assert.equal(w.percepts.userPercept.length, 1)
  assert.equal(w.percepts.sharedGround.length, 0)
})

// ─────────────────────────────────────────────────────────────
// 4. 按面判分（坑 5：照 schema 判，不照直觉判）
// ─────────────────────────────────────────────────────────────
t('judge/procedure：steps 是 string 换行分隔（不是数组）', () => {
  const sc = { family: 'procedure', expect: { shouldWrite: 'procedure' } }
  const w = { procedures: [{ title: 't', steps: '1. a\n2. b\n3. c', successCriteria: 'x' }], percepts: {} }
  const r = judge(sc, w, { logs: '', calendar: '' })
  assert.equal(r.pass, true, 'steps 为多行 string 应判通过: ' + r.detail.join(' | '))
})

t('judge/procedure：steps 只有一行时判失败', () => {
  const sc = { family: 'procedure', expect: { shouldWrite: 'procedure' } }
  const w = { procedures: [{ title: 't', steps: '只有一步' }], percepts: {} }
  const r = judge(sc, w, { logs: '', calendar: '' })
  assert.equal(r.pass, false)
})

t('judge/event：append 到旧事件 = 误挂（应失败）', () => {
  const sc = { family: 'event', expect: { shouldWrite: 'event_create' } }
  const w = { events: [{ action: 'create' }, { action: 'append', eventId: 'evt_abc12345' }], percepts: {} }
  assert.equal(judge(sc, w, { logs: '', calendar: '' }).pass, false)
})

t('judge/event：create 后 append 到新事件 = 正确（应通过）', () => {
  const sc = { family: 'event', expect: { shouldWrite: 'event_create' } }
  const w = { events: [{ action: 'create' }, { action: 'append', eventId: 'evt_new00001' }], percepts: {} }
  assert.equal(judge(sc, w, { logs: '', calendar: '' }).pass, true)
})

t('judge/calendar：相对时间没换算成具体日期时判失败', () => {
  const sc = { family: 'calendar', expect: { shouldWrite: 'calendar', date: '2026-10-30' } }
  const w = { calendars: [{ date: '明天', time: '10:00', title: '开会' }], percepts: {} }
  assert.equal(judge(sc, w, { logs: '', calendar: '' }).pass, false)
})

t('judge/userPercept：stage 非法时判失败', () => {
  const sc = { family: 'userPercept', expect: { shouldWrite: 'userPercept' } }
  const w = { percepts: { userPercept: [{ stage: 'bogus', kind: 'preference', text: 'abc' }] } }
  assert.equal(judge(sc, w, { logs: '', calendar: '' }).pass, false)
})

t('judge 负路径：期望不写却写了 → 判失败', () => {
  const sc = { family: 'sharedGround', expect: { shouldWrite: 'none' } }
  const w = { percepts: { sharedGround: [{ claim: '硬凑的共识' }] } }
  assert.equal(judge(sc, w, { logs: '', calendar: '' }).pass, false)
})

t('judge 负路径：期望不写且确实没写 → 判通过', () => {
  const sc = { family: 'sharedGround', expect: { shouldWrite: 'none' } }
  const w = { percepts: { sharedGround: [] } }
  assert.equal(judge(sc, w, { logs: '', calendar: '' }).pass, true)
})

// ─────────────────────────────────────────────────────────────
// 5. 夹具合规（产品是 fail-closed 26 字段校验，坏事件会毒死整库）
// ─────────────────────────────────────────────────────────────
t('makeEvent 产出的事件 kind/confidence 合法', () => {
  const e = makeEvent({})
  assert.ok(EVENT_KINDS.includes(e.kind), 'kind 必须合法: ' + e.kind)
  assert.ok(['low', 'medium', 'high'].includes(e.confidence))
  assert.equal(e.skillRef, null, 'skillRef 必须存在（缺失会让整库写入失败）')
})

t('makeEvent 强制把非法 kind 纠正为合法值', () => {
  const e = makeEvent({ kind: 'task' })   // 'task' 不在枚举内
  assert.equal(e.kind, 'ledger', '非法 kind 应被纠正，否则整个 store 的写入都会失败')
})

t('makeEvent 字段数是 26（与 validateEventPre 硬契约一致）', () => {
  const e = makeEvent({})
  assert.equal(Object.keys(e).length, 26, '实际: ' + Object.keys(e).length + ' 个字段')
})

// ─────────────────────────────────────────────────────────────
// 6. 枚举漂移检查（产品改了枚举、套件没跟 → 判分失准）
// ─────────────────────────────────────────────────────────────
t('PERCEPT_STAGES 与产品 contract 一致', async () => {
  const p = path.posix.join(REPO, 'lib/event-store.js')
  if (!fs.existsSync(p)) throw new Error('产品文件不可达，跳过漂移检查')
  const src = fs.readFileSync(p, 'utf8')
  const m = src.match(/PERCEPT_STAGES = Object\.freeze\(\[([^\]]*)\]\)/)
  if (!m) throw new Error('产品里找不到 PERCEPT_STAGES 定义')
  const prod = m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  const same = prod.length === PERCEPT_STAGES.length && prod.every((v, i) => v === PERCEPT_STAGES[i])
  assert.ok(same, `产品=[${prod}] 套件=[${PERCEPT_STAGES}]`)
})

t('判分枚举来源如实标注（product vs local-default）', async () => {
  // 守卫「产品校验的枚举必须来自产品」：一旦有人把 mustRead() 改回硬编码，
  // 来源会从 'product' 变成别的，这条就红。
  assert.strictEqual(ENUM_SOURCES.PERCEPT_STAGES, 'product',
    'PERCEPT_STAGES 必须从产品源码读（产品会 fail-closed 校验它）')
  assert.strictEqual(ENUM_SOURCES.EVENT_KINDS, 'product',
    'EVENT_KINDS 必须从产品源码读（26 字段契约的一部分）')
  // 这两条产品确实没做枚举校验，回落是**如实记录**而不是掩盖
  assert.ok(String(ENUM_SOURCES.PERCEPT_KINDS).startsWith('local-default'),
    'PERCEPT_KINDS 来源变了要同步说明，当前: ' + ENUM_SOURCES.PERCEPT_KINDS)
  assert.ok(String(ENUM_SOURCES.COMMIT_STATES).startsWith('local-default'))
})

t('判分枚举读取形态守卫（产品定义形态变了会红）', async () => {
  const p = path.posix.join(REPO, 'lib/event-store.js')
  if (!fs.existsSync(p)) throw new Error('产品文件不可达，跳过')
  const src = fs.readFileSync(p, 'utf8')
  // readFrozenEnum 的正则只认 `NAME = Object.freeze([...])` 这一种写法。
  // 产品若改成别的形态（比如普通数组、或 Object.freeze 换行），读取会静默返回 null
  // ⇒ mustRead 会抛错（好），但 readWithFallback 会静默回落旧值（坏）。
  // 所以在这里把形态钉死：产品必须保持这个写法，否则本项红。
  for (const name of ['PERCEPT_STAGES', 'EVENT_KINDS']) {
    const re = new RegExp(name + '\\s*=\\s*Object\\.freeze\\(\\[')
    assert.ok(re.test(src), `${name} 的定义形态变了（不再是 Object.freeze([...])），readFrozenEnum 会读不到`)
  }
})

// ─────────────────────────────────────────────────────────────
// 7. 沙箱隔离（最要紧：绝不能写进真实记忆库）
// ─────────────────────────────────────────────────────────────
t('沙箱配置的 memoryRoot 指向沙箱而非真实库', () => {
  const p = path.join(PATHS.dshHome, 'dsh-auto-memory.json')
  if (!fs.existsSync(p)) throw new Error('沙箱配置未建 —— 先跑 setup/init-profile.mjs')
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'))
  const root = String(cfg.memoryRoot || '')
  assert.ok(/^[A-Za-z]:/.test(root), 'memoryRoot 必须是绝对路径，实际: ' + root)
  assert.ok(!root.includes('.dsh/memory') && !root.includes('.dsh\\memory'),
    'memoryRoot 指向了真实库！实际: ' + root)
})

t('沙箱 userMemoryDir 指向沙箱', () => {
  const p = path.join(PATHS.dshHome, 'dsh-auto-memory.json')
  if (!fs.existsSync(p)) throw new Error('沙箱配置未建')
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'))
  const u = String(cfg.userMemoryDir || '')
  assert.ok(/^[A-Za-z]:/.test(u), 'userMemoryDir 必须是绝对路径，实际: ' + u)
})

// ─────────────────────────────────────────────────────────────
// 8. 环境自适应（入口探测 / 版本比较 / 运行形态解析）
//
// 这一层错了会**静默选错版本**：本机 which 解析到 0.2.0-rc.2（旧），
// 实际在用的是桌面版 0.2.1-rc.5。若探测写成「取第一个」，
// 验收入口就会永远报「版本不达标」——而模型、提示词、判据全都正常。
// 所以版本比较的边界值必须逐条钉死。
// ─────────────────────────────────────────────────────────────
t('版本解析：正式版 / 预发布 / 非法串', () => {
  const a = parseVer('0.2.1-rc.5')
  assert.ok(a, '0.2.1-rc.5 应可解析')
  assert.strictEqual(a.major, 0); assert.strictEqual(a.minor, 2); assert.strictEqual(a.patch, 1)
  assert.strictEqual(a.pre, 'rc.5')
  assert.deepStrictEqual(a.preParts, ['rc', 5])
  assert.strictEqual(parseVer('3.4.0-alpha.1').pre, 'alpha.1')
  assert.strictEqual(parseVer('0.2.0').pre, '')
  // v 前缀容错：`v0.2.1-rc.5` 与 `0.2.1-rc.5` 必须等价（which/where 的某些输出带 v）
  const vp = parseVer('v1.2.3')
  assert.ok(vp, 'v 前缀应能解析')
  assert.strictEqual(vp.raw, '1.2.3', 'raw 应是剥掉 v 之后的形态')
  assert.strictEqual(cmpVer('v0.2.1-rc.5', '0.2.1-rc.5'), 0, 'v 前缀不应影响比较结果')
  assert.strictEqual(parseVer('not-a-version'), null, '非法串必须返回 null，不能当 0.0.0')
  assert.strictEqual(parseVer(''), null)
})

t('版本比较：rc 序号 / 预发布 < 正式 / 数值非字典序', () => {
  assert.ok(cmpVer('0.2.1-rc.5', '0.2.1-rc.2') > 0, 'rc.5 > rc.2')
  assert.ok(cmpVer('0.2.1-rc.2', '0.2.1-rc.5') < 0)
  assert.strictEqual(cmpVer('0.2.1-rc.5', '0.2.1-rc.5'), 0)
  // ★ 关键：正式版必须排在同号预发布之后（否则门槛 0.2.1-rc.5 会把正式版 0.2.1 判为不达标）
  assert.ok(cmpVer('0.2.1', '0.2.1-rc.5') > 0, '0.2.1 > 0.2.1-rc.5')
  assert.ok(cmpVer('0.2.1-rc.5', '0.2.1') < 0)
  // 主次版本优先于预发布
  assert.ok(cmpVer('0.2.0', '0.2.1-rc.5') < 0, '0.2.0 < 0.2.1-rc.5')
  assert.ok(cmpVer('0.3.0-rc.1', '0.2.1-rc.5') > 0, '0.3.0-rc.1 > 0.2.1-rc.5')
  // rc.10 > rc.9（数值比较，不是字典序）
  assert.ok(cmpVer('0.2.1-rc.10', '0.2.1-rc.9') > 0, 'rc.10 必须 > rc.9')
  // 数字段 < 字符串段（semver 规则）
  assert.ok(cmpVer('1.0.0-1', '1.0.0-alpha') < 0, '数字预发布段 < 字符串段')
})

t(`门槛判定：${REQUIREMENTS.dsh.min} 的边界`, () => {
  const min = REQUIREMENTS.dsh.min
  assert.ok(meets('0.2.1-rc.5', min), '同版本应达标')
  assert.ok(meets('0.2.1-rc.6', min), '更高 rc 应达标')
  assert.ok(meets('0.2.1', min), '★正式版 0.2.1 必须达标（本机门槛最容易被误判的一条）')
  assert.ok(meets('0.2.2', min))
  assert.ok(meets('1.0.0', min))
  assert.ok(!meets('0.2.1-rc.4', min), '更低 rc 不达标')
  assert.ok(!meets('0.2.0-rc.2', min), '★本机 npm 旧版 0.2.0-rc.2 必须判不达标')
  assert.ok(!meets('0.2.0', min))
  assert.ok(!meets('', min), '空串不达标')
  assert.ok(!meets(null, min), 'null 不达标')
  assert.ok(!meets('garbage', min), '非法串不达标')
})

t('运行形态：bin.js → node；.cmd → 解析出真正入口', () => {
  const r1 = resolveRunner('C:/x/node_modules/@deepseek-ai/dsh/lib/bin.js')
  assert.strictEqual(r1.kind, 'node-bin')
  assert.strictEqual(r1.cmd, process.execPath)

  // .cmd 解析：不存在的文件会退回 cmd.exe /c（不能崩）
  const r2 = resolveRunner('C:/nope/dsh.cmd')
  assert.ok(['desktop', 'cmd-shell'].includes(r2.kind), 'kind=' + r2.kind)
  assert.ok(r2.cmd, '.cmd 必须有可执行命令')
  assert.ok(Array.isArray(r2.baseArgs), 'baseArgs 必须是数组')
})

t('桌面版 .cmd 解析（本机存在时逐项验证）', () => {
  const desktop = process.platform === 'win32'
    ? ['G:/dsh_desktop/resources/runtime/cli/bin/dsh.cmd',
       'C:/Program Files/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd']
      .find(p => fs.existsSync(p))
    : null
  if (!desktop) throw new Error('本机无桌面版 .cmd，跳过（不是失败）')
  const r = resolveRunner(desktop)
  assert.strictEqual(r.kind, 'desktop', '应解析成 desktop 形态')
  assert.ok(/\.exe$/i.test(r.cmd), '必须是 exe，不是 .cmd（否则 spawn EINVAL）')
  assert.ok(fs.existsSync(r.cmd), 'exe 必须真实存在：' + r.cmd)
  assert.ok(r.baseArgs.some(a => /\.js$/i.test(a)), '必须带 cli.js 入口参数')
  assert.ok(r.baseArgs.every(a => !/\u0001|@@DP0@@/.test(a)), '路径占位符必须全部展开')
  assert.strictEqual(r.env.ELECTRON_RUN_AS_NODE, '1', '必须继承 _RUN_AS_NODE')
})

t('provider 需求可从 patch 层读出', () => {
  const n = readProviderNeeds()
  if (!n.apiKeyEnv) throw new Error('profile patch 里没有 apiKeyEnv（属配置缺失，不是本层 bug）')
  assert.ok(/^[A-Z][A-Z0-9_]*$/.test(n.apiKeyEnv), 'apiKeyEnv 应是环境变量名，实际 ' + n.apiKeyEnv)
})

t('detectEnv 返回机器可读的 nextAction', () => {
  const e = detectEnv()
  assert.ok(typeof e.ok === 'boolean')
  assert.ok(e.nextAction && typeof e.nextAction.kind === 'string', 'nextAction.kind 缺失')
  assert.strictEqual(e.requirements.dsh.min, REQUIREMENTS.dsh.min)
  // 候选必须全都带 version 字段（哪怕是 null），前端才不会打 undefined
  for (const c of e.dsh.candidates) {
    assert.ok('version' in c, '候选缺 version 字段')
    assert.ok('bin' in c, '候选缺 bin 字段')
  }
  // 若本地有多个安装，选中的必须是版本最高的那个
  const vs = e.dsh.candidates.map(c => c.version).filter(Boolean)
  if (vs.length > 1) {
    const best = vs.slice().sort((a, b) => cmpVer(b, a))[0]
    assert.ok(cmpVer(e.dsh.version, best) >= 0,
      `选中的 ${e.dsh.version} 不是最高版本 ${best} —— 探测逻辑退化成「取第一个」了`)
  }
})

// ─────────────────────────────────────────────────────────────
// 9. 哨兵分流（白名单 / 宿主活跃降级 / agent 写入面永不放过）
//
// 这一层的错误有两个方向，都很难发现：
//   太宽 → 把宿主正常写入当违规（实测宿主活跃时 44 项假阳性，淹没真信号）
//   太窄 → 把 agent 真越界当噪声吞掉（比假阳性严重得多）
// 所以三类断言都要有：必须放行的、必须拦下的、必须降级但不丢的。
// ─────────────────────────────────────────────────────────────
t('哨兵白名单：Windows 反斜杠路径必须归一后再匹配', () => {
  // ★ 曾经的坑：正则按 `/` 写，Windows 传 `\` ⇒ 心跳文件漏过白名单被记成违规
  assert.ok(isAmbient('C:\\Users\\x\\.dsh\\memory\\update-check-pre.json'),
    '反斜杠路径的心跳文件必须被白名单吃掉')
  assert.ok(isAmbient('C:/Users/x/.dsh/memory/recall-stats.json'), '正斜杠路径同样要吃掉')
  assert.ok(isAmbient('/home/u/.dsh/memory/evidence/events/2026-11-03.jsonl'),
    '事件证据流属宿主运行态')
  assert.ok(isAmbient('C:\\u\\.dsh\\memory\\semantic\\activation-shadow.jsonl'))
  assert.ok(isAmbient('C:\\u\\.dsh\\memory\\hub\\facts.json'))
  // 反向：用户级记忆与日历**绝不能**进白名单（那是被测写入面）
  assert.ok(!isAmbient('C:\\u\\.dsh\\memory\\user\\MEMORY.md'), '用户级记忆不该被白名单放过')
  assert.ok(!isAmbient('C:\\u\\.dsh\\memory\\workspaces\\--A--\\CALENDAR.md'), '日历不该被放过')
  assert.ok(!isAmbient('C:\\u\\.dsh\\.credentials.yaml'), '凭证不该被放过')
})

t('哨兵：agent 写入面即使宿主活跃也判违规', () => {
  assert.ok(isAgentSurface('C:/u/.dsh/memory/workspaces/--A--/CALENDAR.md'), '日历是 agent 面')
  assert.ok(isAgentSurface('C:/u/.dsh/memory/user/MEMORY.md'), '用户级记忆是 agent 面')
  assert.ok(isAgentSurface('C:/u/.dsh/memory/workspaces/--A--/2026-11-03.md'), '每日日志是 agent 面')
  assert.ok(isAgentSurface('C:/u/.dsh/memory/workspaces/--A--/handoff/handoff-20261103-120000.md'))
  // 反向：宿主运行态不算 agent 面（否则会被降到 suspicious 以外的地方）
  assert.ok(!isAgentSurface('C:/u/.dsh/memory/evidence/events/2026-11-03.jsonl'))
  assert.ok(!isAgentSurface('C:/u/.dsh/memory/hub/facts.json'))
})

t('哨兵分类：用户点名的记忆面不能落进「其他」', () => {
  // ★ 曾经的坑：正则写成 `/memory/memory.md$`，而文件在 `memory/user/MEMORY.md`
  //   ⇒ 全部落进「其他」。那不是分类不准，是审计失效（用户看到「其他 N 项」等于没看）。
  assert.strictEqual(classify('C:/u/.dsh/memory/user/MEMORY.md'), '全局记忆(用户级)')
  assert.strictEqual(classify('C:/u/.dsh/memory/workspaces/--A--/CALENDAR.md'), '日历')
  assert.strictEqual(classify('C:/u/.dsh/memory/user/episodes.json'), '共同经历')
  assert.notStrictEqual(classify('C:/u/.dsh/memory/evidence/events/2026-11-03.jsonl'), '其他',
    '宿主证据流要有自己的分类名，不能混进「其他」')
  assert.notStrictEqual(classify('C:/u/.dsh/memory/hub/facts.json'), '其他')
  assert.notStrictEqual(classify('C:/u/.dsh/memory/semantic/activation-shadow.jsonl'), '其他')
  assert.strictEqual(classify('C:/u/.dsh/.credentials.yaml'), '★凭证')
})

t('哨兵：self-compare 必须零差异（快照函数是幂等的）', async () => {
  // 若 fullSnapshot 有不确定性（比如时间戳混进 sha、或遍历顺序影响结果），
  // 一次自比就会报出假违规 —— 那会让所有报告都不可信。
  const snap = await fullSnapshot()
  const r = compareSnapshot(snap, snap)
  assert.strictEqual(r.violations.length, 0, '自比出现违规：' + JSON.stringify(r.violations.slice(0, 3)))
  assert.strictEqual(r.suspicious.length, 0)
  assert.strictEqual(r.promptsSame, true)
})

// ─────────────────────────────────────────────────────────────
// 10. 实验自变量完整性（变体不残留 / 精简版路径可达）
//
// 这一层错了，**所有套件结果都不可信**，而且不会报错：
//   · 变体未提及的键沿用上次实验的值 ⇒ 这一批跑的不是你以为的那组
//   · gap=0 ⇒ 精简版分支不触发 ⇒ 五个 slim 层改了等于没改
// 两件事都表现为「套件全绿」，所以必须在自检里钉死。
// ─────────────────────────────────────────────────────────────
t('patchConfig：变体不残留上次实验的键', async () => {
  const { patchConfig, BASELINE_CFG, currentVariantSurface } = await import('./runner.mjs')
  const fsx = await import('node:fs')

  // 备份，结束时还原
  const p = path.join(PATHS.dshHome, 'dsh-auto-memory.json')
  const orig = fsx.existsSync(p) ? fsx.readFileSync(p, 'utf8') : null
  try {
    // ① 先跑一个「关注入」变体
    patchConfig({ promptLayerOverrides: {}, injectEnabled: false })
    let s = currentVariantSurface()
    assert.strictEqual(s.injectEnabled, false, 'noinject 变体应写 false')
    assert.strictEqual(s.snapshotMinGapRounds, BASELINE_CFG.snapshotMinGapRounds,
      'gap 应回到基线（即使变体没提它）')

    // ② 再跑 default（只改 promptLayerOverrides）
    patchConfig({ promptLayerOverrides: {} })
    s = currentVariantSurface()
    // ★ 核心断言：上一次的 injectEnabled:false 不能残留
    assert.strictEqual(s.injectEnabled, true,
      '★ injectEnabled 残留为 false —— 整批任务会在「注入关闭」下跑完，而报告显示 default')

    // ③ 上层覆盖必须整块替换，不能合并残留
    patchConfig({ promptLayerOverrides: { snapshotSlimMaintain: 'A' } })
    patchConfig({ promptLayerOverrides: { snapshotSlimGuide: 'B' } })
    s = currentVariantSurface()
    assert.deepStrictEqual(s.promptLayerOverrides, ['snapshotSlimGuide'],
      'promptLayerOverrides 必须整块替换，残留会让「测的变量」不纯：' + JSON.stringify(s.promptLayerOverrides))
  } finally {
    if (orig != null) fsx.writeFileSync(p, orig, 'utf8')
  }
})

t('基线：精简版注入节奏必须可达（gap ≠ 0）', async () => {
  const { BASELINE_CFG } = await import('./runner.mjs')
  // ★ gap=0 语义是「每轮都发完整版」⇒ 精简版分支永不触发 ⇒
  //   snapshotSlimMaintain / Guide / Note / RecallHit / RecallNote 五层不渲染。
  //   实测（2026-11-03）：gap=0 时覆盖标记不进上下文；gap=20 时进。
  assert.ok(BASELINE_CFG.snapshotMinGapRounds > 0,
    '★ 基线 gap 必须 >0，否则精简版层全部不可测（当前 ' + BASELINE_CFG.snapshotMinGapRounds + '）')
  assert.ok(BASELINE_CFG.slimEveryRounds > 0,
    'slimEveryRounds 必须 >0，否则精简版也不发')
  assert.strictEqual(BASELINE_CFG.snapshotTieredInject, true,
    'snapshotTieredInject 必须为 true，否则精简版不注入')
  assert.strictEqual(BASELINE_CFG.injectEnabled, true)
})

t('基线：值与产品出厂默认一致（产品改了要能发现）', async () => {
  const { BASELINE_CFG } = await import('./runner.mjs')
  const p = path.posix.join(REPO, 'lib/index.js')
  if (!fs.existsSync(p)) throw new Error('产品文件不可达，跳过')
  const src = fs.readFileSync(p, 'utf8')
  const gap = src.match(/const DEFAULT_SNAPSHOT_MIN_GAP_ROUNDS = (\d+)/)
  const slim = src.match(/const DEFAULT_SLIM_EVERY_ROUNDS = (\d+)/)
  if (!gap || !slim) throw new Error('产品里找不到注入节奏默认值的定义')
  assert.strictEqual(Number(gap[1]), BASELINE_CFG.snapshotMinGapRounds,
    `产品 gap 默认已变成 ${gap[1]}，基线还是 ${BASELINE_CFG.snapshotMinGapRounds} —— 要么同步，要么明确说明为什么故意不同`)
  assert.strictEqual(Number(slim[1]), BASELINE_CFG.slimEveryRounds,
    `产品 slim 默认已变成 ${slim[1]}，基线还是 ${BASELINE_CFG.slimEveryRounds}`)
})

t('套件里不再有人硬编码 gap=0（会静默关掉精简版层）', async () => {
  const fsx = await import('node:fs')
  const kitRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
  const offenders = []
  const scan = (dir) => {
    let ents = []
    try { ents = fsx.readdirSync(dir, { withFileTypes: true }) } catch (_) { return }
    for (const e of ents) {
      const fp = path.join(dir, e.name)
      if (e.isDirectory()) { if (!/node_modules|\.git/.test(e.name)) scan(fp); continue }
      if (!e.name.endsWith('.mjs')) continue
      let src = ''
      try { src = fsx.readFileSync(fp, 'utf8') } catch (_) { continue }
      // selftest 自己会**故意**构造 gap=0 的坏配置来测校验器 —— 那不是违规
      if (e.name === 'selftest.mjs') continue
      // 只查真实代码行，跳过注释里提到它的说明
      for (const line of src.split('\n')) {
        const t2 = line.trim()
        if (t2.startsWith('*') || t2.startsWith('//')) continue
        if (/snapshotMinGapRounds\s*:\s*0\b/.test(t2)) offenders.push(path.relative(kitRoot, fp) + ' :: ' + t2.slice(0, 80))
      }
    }
  }
  for (const sub of ['suites', 'lib', 'setup']) scan(path.join(kitRoot, sub))
  assert.strictEqual(offenders.length, 0,
    '★ 又有人写 gap=0 了 —— 这会静默让 5 个精简版层不可测：\n  ' + offenders.join('\n  '))
})

// ─────────────────────────────────────────────────────────────
// 11. 实验声明层（层注册表 / 空跑拦截）
//
// 这一层的错误是「实验跑完了、报告出了、结论是空的」。
// 所以每条断言都要盯住「能不能静默空跑」。
// ─────────────────────────────────────────────────────────────
t('层注册表：解析出全部层，且只认真正的死键', async () => {
  const { buildLayerRegistry } = await import('./layers.mjs')
  const r = buildLayerRegistry()
  assert.ok(r.ok, '注册表解析失败：' + r.error)
  const n = Object.keys(r.layers).length
  assert.ok(n >= 25, '层数异常偏少（' + n + '），解析可能不完整')

  // ★ 死键集合必须精确。多判一个 ⇒ 明明能改的层被拒；少判一个 ⇒ 改了无效却不报。
  const dead = Object.entries(r.layers).filter(([, v]) => v.dead).map(([k]) => k).sort()
  assert.deepStrictEqual(dead, ['staticHead', 'staticWriteDiscipline'],
    '死键集合变了：' + JSON.stringify(dead)
    + '\n  （产品若新接上了消费点，或新增了未接线的层，都要在这里同步）')

  // 三条注入路径都要有内容
  assert.ok(r.byPath.slim.length >= 5, 'slim 路径层太少：' + r.byPath.slim.length)
  assert.ok(r.byPath.dynamic.length >= 10, 'dynamic 路径层太少：' + r.byPath.dynamic.length)
  assert.ok(r.byPath.static.length >= 1, 'static 路径层太少')
  // 精简版层必须被正确归到 slim
  for (const k of ['snapshotSlimMaintain', 'snapshotSlimGuide', 'snapshotSlimNote']) {
    assert.ok(r.layers[k].paths.includes('slim'), k + ' 应属于 slim 路径，实际 ' + JSON.stringify(r.layers[k].paths))
  }
})

t('层注册表：切分函数体不会被 if/for 提前截断', async () => {
  const { buildLayerRegistry } = await import('./layers.mjs')
  const r = buildLayerRegistry()
  // 曾经的 bug：找「下一行 xxx(...) {」当方法边界，撞上函数体里的
  // `if (...) {` 就提前截断 ⇒ renderMemoryDynamic 只切到 9,299/146,038 字符
  // ⇒ 21 个层被误判成死键（改了会被校验器拒掉）。
  // 判据：dynamic 路径的层里必须包含那些通过 pushPart 间接消费的标题层。
  for (const k of ['snapshotLogsTitle', 'snapshotPlanTitle', 'snapshotCalendarTitle']) {
    assert.ok(r.layers[k].paths.includes('dynamic'),
      k + ' 应属 dynamic 路径（若被判死键，说明函数体切分又提前截断了）')
  }
})

t('校验器：拦截「改了 slim 层但节奏不让精简版出现」的空跑', async () => {
  const { validateExperiment } = await import('./experiment.mjs')
  const bad = {
    name: 'bad', suite: 'families', scenarios: ['sg-strong'], reps: 2,
    arms: {
      base: {},
      broken: { cadence: { snapshotMinGapRounds: 0 }, layers: { snapshotSlimMaintain: 'x' } },
    },
  }
  const v = validateExperiment(bad)
  assert.ok(!v.ok, '★ 这个配置必须被拒（gap=0 让 slim 路径不可达，改了等于没改）')
  const codes = v.errors.map(e => e.code)
  assert.ok(codes.includes('unreachable-layer'), '应报 unreachable-layer，实际 ' + JSON.stringify(codes))

  // 反证：同一层，节奏改成能达就应通过
  const good = JSON.parse(JSON.stringify(bad))
  good.arms.broken.cadence.snapshotMinGapRounds = 20
  const v2 = validateExperiment(good)
  assert.ok(v2.ok, '节奏允许时应通过，实际错误：' + JSON.stringify(v2.errors.map(e => e.msg)))
})

t('校验器：拦截死键 / 不存在的层 / 非字符串值', async () => {
  const { validateExperiment } = await import('./experiment.mjs')
  const cases = [
    [{ arms: { a: { layers: { noSuchLayer: 'x' } }, b: {} } }, 'unknown-layer'],
    [{ arms: { a: { layers: { staticHead: 'x' } }, b: {} } }, 'dead-layer'],
    [{ arms: { a: { layers: { staticPerceptDiscipline: 123 } }, b: {} } }, 'layer-not-string'],
  ]
  for (const [patch, expected] of cases) {
    const v = validateExperiment({
      name: 't', suite: 'families', scenarios: ['sg-strong'], reps: 2, ...patch,
    })
    assert.ok(!v.ok, expected + ' 应当被拒')
    assert.ok(v.errors.some(e => e.code === expected),
      '应含 ' + expected + '，实际 ' + JSON.stringify(v.errors.map(e => e.code)))
  }
})

t('校验器：拦截所有臂完全相同（没有自变量）', async () => {
  const { validateExperiment } = await import('./experiment.mjs')
  const v = validateExperiment({
    name: 't', suite: 'families', scenarios: ['sg-strong'], reps: 2,
    arms: { a: {}, b: {} },
  })
  assert.ok(!v.ok)
  assert.ok(v.errors.some(e => e.code === 'arms-identical'),
    '实际 ' + JSON.stringify(v.errors.map(e => e.code)))
})

t('校验器：拦截拼错的场景 id', async () => {
  const { validateExperiment } = await import('./experiment.mjs')
  const v = validateExperiment({
    name: 't', suite: 'families', scenarios: ['sg-strong', 'sg-strng'], reps: 2,
    arms: { a: {}, b: { layers: { staticPerceptDiscipline: 'x' } } },
  }, { knownScenarios: ['sg-strong', 'sg-weak'] })
  assert.ok(!v.ok)
  assert.ok(v.errors.some(e => e.code === 'unknown-scenario'),
    '实际 ' + JSON.stringify(v.errors.map(e => e.code)))
})

t('纯数据模块：import implicit 场景不会触发运行', async () => {
  // ★ 历史坑：implicit.mjs 顶层直接跑整套，实验层 import 它 ⇒
  //   会在后台启动一个 10 条任务的完整实验（实测发生过，烧了额度）。
  //   现在数据在 implicit-scenarios.mjs，顶层只 export。
  const t0 = Date.now()
  const m = await import('./../suites/implicit-scenarios.mjs')
  const ms = Date.now() - t0
  assert.ok(Array.isArray(m.IMPLICIT_SCENARIOS) && m.IMPLICIT_SCENARIOS.length > 0)
  assert.strictEqual(typeof m.judgeImplicit, 'function')
  assert.ok(ms < 3000, '导入耗时 ' + ms + 'ms —— 疑似顶层有副作用（应当只 export）')
})

// ─────────────────────────────────────────────────────────────
// 12. 外部基准接入（覆盖率诚实性 + 判据不反噬）
//
// 外部基准的价值全在判据。如果判据把参考答案自己判成错，接进来只会制造假信号；
// 如果覆盖率统计虚报，报告会给人「已经测全了」的错觉。这两件都要钉死。
//
// ⚠️ 这一组**不依赖外部数据**：没有 clone / 没有下载时，只验「缺数据会明确说不」，
//    不会因为数据没到就静静地全绿。
// ─────────────────────────────────────────────────────────────
t('外部基准：Ornn8 覆盖率统计不虚报，且每条缺失都有说明', async () => {
  const { coverageReport, ORNN8_CATEGORIES } = await import('./external-ornn8.mjs')
  const r = coverageReport()
  assert.strictEqual(r.total, ORNN8_CATEGORIES.length)
  assert.ok(r.covered > 0 && r.covered < r.total, '应是部分覆盖（全满或全零都说明统计坏了）')
  assert.strictEqual(r.covered + r.missing.length, r.total, '覆盖 + 缺失 应等于总数')
  for (const m of r.missing) assert.ok(m.note && m.note.length > 4, m.id + ' 的缺失说明太短')
})

t('外部基准：LongMemEval 覆盖统计同样不虚报', async () => {
  const { coverageReport } = await import('./external-longmemeval.mjs')
  const r = coverageReport()
  assert.strictEqual(r.total, 7, 'LongMemEval 应有 7 类')
  assert.strictEqual(r.covered + r.missing.length, r.total)
  assert.ok(r.covered < r.total, '★我们本来就缺它多数类型 —— 若统计成全满，说明判定坏了')
})

t('外部判据：判不了时必须返回 null，不能假装通过或失败', async () => {
  const { judgeExternal } = await import('./external-ornn8.mjs')
  assert.strictEqual(judgeExternal(null, 'x').pass, null, '无判据应判不了')
  assert.strictEqual(judgeExternal({ must: [] }, 'x').pass, null, '无必须项应判不了')
  // 空回答必须失败（不能因为「没内容」而放过）
  assert.strictEqual(judgeExternal({ must: ['某物'], forbidden: [] }, '').pass, false)
  assert.strictEqual(judgeExternal({ must: ['某物'], forbidden: [] }, '   ').pass, false)
  // 逐字踩中 forbidden ⇒ 必须失败
  const j = judgeExternal(
    { must: ['活动扳手；演出结束后归还'], forbidden: ['说已经还了'] },
    '借了活动扳手，演出结束后归还。说已经还了。',
  )
  assert.strictEqual(j.pass, false, '逐字踩 forbidden 必须判失败')
})

t('外部判据：LongMemEval 的 abstention 不能只看 question_type', async () => {
  const { normalizeItem } = await import('./external-longmemeval.mjs')
  const a = normalizeItem({
    question_id: 'gpt4_x_abs', question_type: 'temporal-reasoning',
    question: 'q', answer: 'a', haystack_sessions: [],
  })
  assert.strictEqual(a.isAbstention, true, '_abs 结尾必须识别为 abstention')
  assert.strictEqual(a.type, 'abstention', 'type 应被归一，否则判据会用错')
  assert.strictEqual(a.baseType, 'temporal-reasoning', '原类型应保留可查')

  const b = normalizeItem({ question_id: 'gpt4_y', question_type: 'knowledge-update', question: 'q', answer: 'a' })
  assert.strictEqual(b.isAbstention, false)
  assert.strictEqual(b.type, 'knowledge-update')
})

t('外部判据：abstention 的「说不知道又编」必须降置信度', async () => {
  const { judgeLongMemEval } = await import('./external-longmemeval.mjs')
  const item = { isAbstention: true, answer: 'not enough info', type: 'abstention' }
  const good = judgeLongMemEval(item, '记录里没有提到这件事，无法确定。')
  assert.strictEqual(good.pass, true)
  assert.ok(['medium', 'low'].includes(good.confidence))

  const bad = judgeLongMemEval(item, '你先修了篱笆，然后买了三头牛。')
  assert.strictEqual(bad.pass, false, '编造必须判失败')

  const sneaky = judgeLongMemEval(item, '记录里没有购买牛的信息。不过 2023 年 3 月你修了篱笆。')
  assert.strictEqual(sneaky.pass, true, '这种表述仍算承认信息不足')
  assert.strictEqual(sneaky.confidence, 'low',
    '★「说不知道又编」必须降置信度，否则会给出干净的假绿')
})

t('外部基准：数据缺席时明确说不，而不是静默空跑', async () => {
  const { loadOrnn8 } = await import('./external-ornn8.mjs')
  const { loadLongMemEval } = await import('./external-longmemeval.mjs')
  const r1 = loadOrnn8('D:/definitely/not/here')
  assert.strictEqual(r1.ok, false, '★找不到数据必须 ok=false，不能返回空数组让人以为「没有题目」')
  assert.ok(r1.error.includes('clone'), '错误信息里要给出准备数据的具体命令')

  const r2 = loadLongMemEval({ dir: 'D:/definitely/not/here' })
  assert.strictEqual(r2.ok, false)
  assert.ok(/huggingface|curl|下载/.test(r2.error), 'LME 错误信息里要给出下载指令')
})

// ─────────────────────────────────────────────────────────────
// 13. 接线审计（wiring-audit）—— 判据本身不能假绿
//
// 这一组的设计动机与 judge 那 5 次静默失败同源：
//   一个「检测器」如果把真缺陷漏掉（假阴性），比没有检测器更糟 ——
//   因为报告上会写着「已检查，无问题」。
//
// 因此这里**不测产品**，只测「提取器在已知输入上的行为」：
//   ① 正路径：合成一段带 5 种读法的源码，必须全部认出来
//      （这 5 种正是我在真实产品上逐个踩出来的，少一种就会漏报死键）
//   ② 负路径：只有定义、没有任何读法的键，必须判成「未读取」
//   ③ 边界：client.js 的读法**不得**被算作后端读点（否则死开关全部漏报）
//   ④ 废弃键：注释点名了该键才判废弃（不能把相邻键的注释算进来）
// ─────────────────────────────────────────────────────────────
t('接线审计：5 种配置读法必须全部识别（少一种就漏报死键）', async () => {
  const { extractConfigReads } = await import('./wiring-audit.mjs')
  const os = await import('node:os')
  const fsp = await import('node:fs')
  const dir = fsp.mkdtempSync(path.join(os.tmpdir(), 'wa-reads-'))
  const file = path.join(dir, 'fake-backend.js')
  fsp.writeFileSync(file, [
    'const a = this.config.directDot',                    // ① this.config.X
    'const b = engine.config["bracketStr"]',               // ② config['X']
    'const c = cfg.plainCfg',                             // ③ cfg.X
    'const c2 = safeGet(configOf(), \'wrappedKey\')',      // ④ 包装器 + 函数取配置
    'const alias = cfg || {}',                            // ⑤ 别名变量
    'const d = alias.aliasRead',
  ].join('\n'), 'utf8')
  const r = extractConfigReads([file], ['directDot', 'bracketStr', 'plainCfg', 'wrappedKey', 'aliasRead', 'neverRead'])
  fsp.rmSync(dir, { recursive: true, force: true })
  for (const k of ['directDot', 'bracketStr', 'plainCfg', 'wrappedKey']) {
    assert.ok(r.reads.has(k), '读法漏识别：' + k)
  }
  assert.ok(r.reads.has('aliasRead') || r.weak.has('aliasRead'), '别名变量读法漏识别：aliasRead')
  assert.ok(!r.reads.has('neverRead') && !r.weak.has('neverRead'),
    'neverRead 没有任何读法，却被判成已读取 —— 这是假阴性，会让真死键漏报')
})

t('接线审计：仅前端读的键不得出现在后端读点里', async () => {
  const { extractConfigReads } = await import('./wiring-audit.mjs')
  const os = await import('node:os')
  const fsp = await import('node:fs')
  const root = fsp.mkdtempSync(path.join(os.tmpdir(), 'wa-mini-'))
  fsp.mkdirSync(path.join(root, 'lib'))
  fsp.writeFileSync(path.join(root, 'lib/index.js'), [
    'const DEFAULT_CONFIG = { onlyClientReads: 1, backendReads: 2 }',
    'function f(cfg) { return cfg.backendReads }',
  ].join('\n'), 'utf8')
  const backendOnly = extractConfigReads([path.join(root, 'lib/index.js')], ['onlyClientReads', 'backendReads'])
  assert.ok(backendOnly.reads.has('backendReads'), '后端读点应被识别')
  assert.ok(!backendOnly.reads.has('onlyClientReads'), '仅前端读的键不应出现在后端读点里')
  fsp.rmSync(root, { recursive: true, force: true })
})

t('接线审计：废弃标记只看「注释点名了该键」', async () => {
  const { extractDefaultConfig } = await import('./wiring-audit.mjs')
  const src = [
    'const DEFAULT_CONFIG = {',
    '  /** ⚠️ 已废弃：oldA / oldB 曾计划使用 */',
    '  oldA: 1,',
    '  oldB: 2,',
    '  freshKey: 3,',
    '}',
  ].join('\n')
  const r = extractDefaultConfig(src)
  assert.ok(r.ok)
  assert.deepStrictEqual(r.keys, ['oldA', 'oldB', 'freshKey'])
  assert.ok(r.deprecated.has('oldA'), 'oldA 被注释点名且在废弃块里，应判废弃')
  assert.ok(!r.deprecated.has('freshKey'), 'freshKey 没有废弃注释，不得被判废弃')
})

t('接线审计：真实产品上能跑通且不虚报（键数与读点数都合理）', async () => {
  const { auditWiring } = await import('./wiring-audit.mjs')
  const r = auditWiring()
  if (!r.ok) {
    // 产品不可达时明确说明，而不是静静地当成通过
    assert.ok(r.error && r.error.length > 4, '审计失败时必须给出原因')
    return
  }
  assert.ok(r.stats.keys > 50, '配置键数异常少（' + r.stats.keys + '）—— 解析可能坏了')
  assert.ok(r.stats.backendReadKeys > 0,
    '后端读点数为 0 —— 读法匹配失效，会导致所有键被误判死键')
  assert.ok(r.stats.backendReadKeys < r.stats.keys * 3,
    '读点数远超键数（' + r.stats.backendReadKeys + ' vs ' + r.stats.keys
    + '）—— 兜底模式过宽，会掩盖真死键')
})

// ─────────────────────────────────────────────────────────────
// 等所有异步测试真正结束再汇总（否则会把「还没跑完」报成「全绿」）
await Promise.all(pending)
console.log('')
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败 / ${pass + failures.length} 项`)
  for (const f of failures) console.log(`   · ${f.name}`)
  process.exitCode = 1
} else {
  console.log(`✓ 全部 ${pass} 项通过`)
}
