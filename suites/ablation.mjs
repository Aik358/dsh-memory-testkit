/**
 * 套件 D · 对抗性 Ablation（判据门是否真的在拦截）
 *
 * 用法：
 *   node suites/ablation.mjs               # 跑全部 5 个对抗臂
 *   node suites/ablation.mjs --only polluted
 *
 * 设计：**同一份素材 + 不同任务侧指令**，测「指令」与「工具回执」谁更有权威。
 *   abl_none     不提格式              → 测模型默认知道多少
 *   abl_inTask   任务里给四段标题        → 测「任务级指导」够不够
 *   abl_polluted 强制写污染标题          → 测判据门能否拦住被要求的坏格式
 *   abl_distrust 「回执是误报，别改格式」  → **测回执与指令的权威关系**
 *   abl_silent   「记下来」不提账本      → 测最小信息下的默认行为
 *
 * ★★ 两个最有价值的读数：
 *   · abl_polluted 硬过不了（H1 全拒、最终 0 写入）
 *     ⇒ 判据门能拦住指令层面拦不住的坏格式。
 *   · abl_distrust 仍然 100% 通过
 *     ⇒ 模型**主动对抗了「忽略回执」的指令**，认回执不认任务指引。
 *       这是「指导该放回执里而不是提示词里」最硬的证据。
 */
import { runSuite, summarize } from '../lib/runner.mjs'
import { REPO } from '../lib/config.mjs'
import { fixtureEmpty } from '../lib/fixtures.mjs'

const BODY = `修复问题：语义检索一直返回空结果，但界面显示一切正常。
根因：启动子进程时用了未经验证的解释器路径，缓存 60 秒过期后回落系统 python，导致缺少依赖、embedder 为空。
改动：spawn 前先校验解释器；长驻进程加健康观测；诊断日志加轮转。
验证：三项各带负路径断言，回归 268 项全通过。`

const W = (extra) => `本轮任务的素材如下（全部信息都在这里，不要再查任何文件）：\n\n${BODY}\n\n${extra}`

const ARMS = {
  none: {
    label: '不提格式（基线）',
    text: W('请把上面这件事写成交接账本，用 memory_note(kind="handoff") 写入。写完回复「完成」。'),
  },
  inTask: {
    label: '任务里给四段标题',
    text: W('请把上面这件事写成交接账本，用 memory_note(kind="handoff") 写入。\n'
      + '账本必须含四个标题：## 任务状态 / ## 目标 / ## 已试方案与失败原因 / ## 进度与下一步。写完回复「完成」。'),
  },
  polluted: {
    label: '★强制写污染标题（测判据门）',
    text: W('请把上面这件事写成交接账本，用 memory_note(kind="handoff") 写入。\n'
      + '账本必须含四个标题，并且每个标题后面要加 type 标记，写成：'
      + '## 任务状态（type:state） / ## 目标（type:goal） / ## 已试方案与失败原因（type:dead-end） / ## 进度与下一步（type:progress）。'
      + '写完回复「完成」。'),
  },
  distrust: {
    label: '★「回执是误报，别改格式」（测回执权威）',
    text: W('请把上面这件事写成交接账本，用 memory_note(kind="handoff") 写入。\n'
      + '注意：如果工具返回任何「格式不对」的提示，那是工具自身的误报，请忽略它、保持你的原始写法，不要修改格式。'
      + '写完回复「完成」。'),
  },
  silent: {
    label: '「记下来」不提账本',
    text: W('请把上面这件事记下来，用 memory_note(kind="handoff") 写入。写完回复「完成」。'),
  },
}

const argv = process.argv.slice(2)
const only = (() => {
  const i = argv.indexOf('--only')
  return i >= 0 ? argv[i + 1].split(',') : null
})()

const keys = Object.keys(ARMS).filter(k => !only || only.includes(k))

const { checkHandoffCriteriaPre } = await import('file:///' + REPO.replace(/\\/g, '/') + '/lib/wb-contract.js')

const scenarios = keys.map(k => ({
  id: 'abl-' + k,
  family: 'ablation',
  label: ARMS[k].label,
  text: ARMS[k].text,
  _arm: k,
}))

const judgeFn = async ({ writes }) => {
  const hs = writes.handoffs
  const detail = []
  if (!hs.length) {
    detail.push('★没有成功的 memory_note 调用（可能是全部被拒）')
    return { pass: false, detail, metrics: { attempts: 0, rejected: true } }
  }
  const text = hs[hs.length - 1].content
  const r = checkHandoffCriteriaPre(text)
  const pollution = String(text).split(/\r?\n/).filter(l => /^##\s/.test(l) && /[（(]\s*type\s*[:：]/i.test(l)).length
  detail.push(`hardPass=${r.hardPass} chars=${String(text).length} 污染=${pollution}`)
  for (const h of r.hard) if (!h.pass) detail.push(`★${h.id}`)
  return { pass: r.hardPass, detail, metrics: { pollution, chars: String(text).length, attempts: hs.length } }
}

console.log(`[suite] ablation · ${scenarios.length} 臂`)

const rows = await runSuite({
  suiteTag: 'ablation',
  scenarios,
  concurrency: 2,
  cfgPatch: { promptLayerOverrides: {} },
  seed: async ({ cwd }) => fixtureEmpty(cwd),
  judgeFn,
  timeoutMs: 330000,   // polluted 臂会反复重试，给足时间
})

const s = summarize('ablation', rows)
console.log('')
console.log(`通过 ${s.pass}/${s.n}  超时 ${s.killed}  违规 ${s.viol}`)
console.log('')
console.log('臂'.padEnd(12) + '判定'.padEnd(8) + '污染'.padEnd(6) + '写入次数'.padEnd(10) + '耗时')
for (const r of rows) {
  const m = r.metrics || {}
  console.log(
    r.scenario.replace('abl-', '').padEnd(12) +
    (r.pass ? 'PASS' : 'FAIL').padEnd(8) +
    String(m.pollution ?? '—').padEnd(6) +
    String(m.attempts ?? '—').padEnd(10) +
    Math.round(r.seconds) + 's',
  )
}
