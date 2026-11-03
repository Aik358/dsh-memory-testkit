/**
 * 套件 · 接线审计（零成本）—— 不做模型调用，只查「代码真的接通了吗」。
 *
 * 用法：
 *   node suites/wiring-audit.mjs                # 全量
 *   node suites/wiring-audit.mjs --json         # 机器可读（供监控台 / CI 消费）
 *   node suites/wiring-audit.mjs --strict       # 有 warn 即退出码非零（CI 门禁用）
 *   node suites/wiring-audit.mjs --only dead-switch,server-dead-key
 *
 * 退出码（默认**非阻断**）：
 *   0  审计完成（无论发现多少 warn）
 *   1  审计本身无法完成（解析失败 / 产品源码读不到）—— 这是"套件坏了"，不是"产品坏了"
 *   2  --strict 且存在 warn
 *
 * ═══ 为什么它是 suites/ 里的异类 ═══
 * 其他套件都调模型（花钱、慢、测行为）。本套件**完全不调**：
 *   · 它回答的是"跑实验之前必须先知道的事"——你要改的那个键，产品到底读不读。
 *   · 在本仓历史上，「改了完全无效」比「模型不听话」更常见（死键 / 死开关 / 未接线）。
 *   · 因此它可以高频跑、进 CI、当 pre-commit 用。
 *
 * ═══ 与 lib/experiment.mjs 的 dead-layer / unreachable-layer 的分工 ═══
 *   experiment.mjs  管**提示词层**（DEFAULT_PROMPT_LAYERS）有没有消费点、路径可不可达
 *   本套件          管**配置键 / 前端开关 / 路由**有没有读点、两端键集合是否镜像
 *   两者同一家族（"改了没效果"），覆盖面互补。
 */
import { auditWiring, summarizeWiring } from '../lib/wiring-audit.mjs'
import { REPO } from '../lib/config.mjs'

const argv = process.argv.slice(2)
const has = (n) => argv.includes('--' + n)
const arg = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}

const only = (() => {
  const v = arg('only', '')
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : null
})()

const res = auditWiring({ strictScope: has('strict-scope') })

if (has('json')) {
  const filtered = only ? res.findings.filter((f) => only.includes(f.code)) : res.findings
  process.stdout.write(JSON.stringify({ ...res, findings: filtered }, null, 2) + '\n')
  if (!res.ok) process.exit(1)
  if (has('strict') && filtered.some((f) => f.level === 'warn')) process.exit(2)
  process.exit(0)
}

console.log('═══ 接线审计（零成本 · 不调模型）═══')
console.log('被测仓库  ' + (REPO || '(未探测到)'))
if (!REPO) {
  console.error('✗ 未探测到被测仓库。设 TESTKIT_REPO 指向插件源码。')
  process.exit(1)
}

if (!res.ok) {
  console.error('✗ 审计无法完成：' + res.error)
  console.error('  这不是「产品有缺陷」，而是「套件解析不了产品」—— 需要更新 lib/wiring-audit.mjs。')
  process.exit(1)
}

const s = res.stats
console.log('')
console.log('配置键        ' + s.keys + '（其中注释标废弃 ' + s.deprecated + '）')
console.log('后端有读点    ' + s.backendReadKeys + (s.weakReadKeys ? '（含动态/包装器推导 ' + s.weakReadKeys + '）' : ''))
console.log('服务端死键    ' + s.serverDeadKeys)
console.log('前端键        ' + s.clientKeys)
console.log('前端死开关    ' + s.clientDeadSwitches)
console.log('后端有·前端无 ' + s.serverOnlyKeys)
console.log('路由          client ' + s.routesClient + ' / server ' + s.routesServer + ' / 缺失 ' + s.missingRoutes)
console.log('')

const shown = only ? res.findings.filter((f) => only.includes(f.code)) : res.findings
const warns = shown.filter((f) => f.level === 'warn')
const infos = shown.filter((f) => f.level === 'info')

/** 按 code 分组打印 —— 人看的是"哪一类问题"，不是"一条条流水" */
const byCode = new Map()
for (const f of shown) {
  if (!byCode.has(f.code)) byCode.set(f.code, [])
  byCode.get(f.code).push(f)
}
const CODE_TITLE = {
  'server-dead-key': '★ 服务端死键（DEFAULT_CONFIG 有、全后端零读取 ⇒ 改了完全无效）',
  'dead-switch': '★ 前端死开关（前端能拨、后端零读取 ⇒ 用户拨了没反应）',
  'mirror-drift': '★ 镜像漂移（前端写的键、服务端没有 ⇒ 可能被静默丢弃）',
  'route-path-missing': '★ 路由缺失（前端请求、后端没注册 ⇒ 404）',
  'block-scope-suspect': '· 块作用域可疑点（启发式，可能误报 —— 需真执行确认）',
  'no-ui-entry': '· 后端有读取、前端无入口（只能改配置文件）',
  'deprecated-key': '· 已废弃键（注释标注，建议最终清理）',
  'no-client': '· 未找到 client.js（跳过前端检查）',
  'no-server-api-table': '· 未找到服务端 API 表（跳过路由比对）',
}
const ORDER = ['server-dead-key', 'dead-switch', 'mirror-drift', 'route-path-missing',
  'block-scope-suspect',
  'no-ui-entry', 'deprecated-key', 'no-server-api-table', 'no-client']

for (const code of ORDER) {
  if (!byCode.has(code)) continue
  const list = byCode.get(code)
  console.log((CODE_TITLE[code] || code) + '  —— ' + list.length + ' 条')
  for (const f of list) console.log('   · ' + (f.key || f.route || '') + (f.key || f.route ? '：' : '') + f.msg)
  console.log('')
}
// 未知 code 兜底（不静默丢弃）
for (const [code, list] of byCode) {
  if (ORDER.includes(code)) continue
  console.log(code + '  —— ' + list.length + ' 条')
  for (const f of list) console.log('   · ' + f.msg)
  console.log('')
}

console.log('—'.repeat(60))
console.log(summarizeWiring(res))
console.log('')

if (warns.length) {
  console.log('⚠ ' + warns.length + ' 项 warn（可疑，需人判断）')
  // 至少一条已知真缺陷的复述，避免"报告完就没人看"
  console.log('  提示：warn 里既有真缺陷也有设计如此（如 deprecated 键）。')
  console.log('        逐条核对后，修掉的写进 CHANGELOG，确认无碍的请在 DEFAULT_CONFIG 注释里标注用途。')
} else {
  console.log('✓ 无 warn')
}
console.log('   本次只做静态接线判定，不代表运行期行为 —— 运行期请配 suites/families.mjs。')

if (has('strict') && warns.length) process.exit(2)
process.exit(0)