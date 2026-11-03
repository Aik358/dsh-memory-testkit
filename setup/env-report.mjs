/**
 * 环境报告 —— 只看「探测到了什么」，不跑任何检查。
 *
 * 与 preflight 的区别：
 *   preflight  会写探针文件、记录基线、判「能不能跑」→ 有副作用
 *   本脚本     纯只读 → 可以随便反复跑，用来排查「为什么选了这个入口」
 *
 * 用法：
 *   node setup/env-report.mjs            # 人类可读
 *   node setup/env-report.mjs --json     # 机器可读（完整 detectEnv 结果）
 *   node setup/env-report.mjs --refresh  # 忽略版本缓存，重新问每个候选
 */
import { detectEnv, summarize, resolveRunner, REQUIREMENTS } from '../lib/env.mjs'

const asJson = process.argv.includes('--json')
const env = detectEnv({ refresh: process.argv.includes('--refresh') })

if (asJson) {
  // 补上「这个入口要怎么起」—— Agent 需要它才能自己 spawn
  const runner = env.dsh.bin ? resolveRunner(env.dsh.bin) : null
  console.log(JSON.stringify({ ...env, runner }, null, 2))
} else {
  console.log('=== 环境探测（只读） ===')
  console.log('')
  console.log(summarize(env))
  console.log('')
  if (env.dsh.bin) {
    const r = resolveRunner(env.dsh.bin)
    console.log('运行形态：')
    console.log(`  命令   ${r.cmd}`)
    console.log(`  参数   ${r.baseArgs.join(' ') || '(无)'}`)
    console.log(`  额外环境 ${JSON.stringify(r.env) || '{}'}`)
    console.log(`  说明   ${r.detail}`)
    console.log('')
  }
  console.log(`门槛  DSH ≥ ${REQUIREMENTS.dsh.min}`)
  console.log(`      ${REQUIREMENTS.dsh.reason}`)
  console.log(`      插件 ≥ ${REQUIREMENTS.plugin.min}`)
  console.log(`      ${REQUIREMENTS.plugin.reason}`)
  console.log('')
  console.log(`结论  ${env.ok ? '✓ 可以跑' : '✗ 有阻塞项'}`)
  console.log(`下一步 ${JSON.stringify(env.nextAction)}`)
}
