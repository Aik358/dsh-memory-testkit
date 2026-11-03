/**
 * 只用 HTTP 接口把环境跑通的示例 Agent。
 *
 * 这个文件是**批次 3 的验收物**：它不 import 套件里任何模块，
 * 只靠 `lib/setup-ui.mjs` 暴露的 7 个接口就把四步走完。
 * 如果哪天接口契约变了，这个脚本会先坏 —— 那就是它存在的意义。
 *
 * 用法：
 *   node lib/setup-ui.mjs           # 另一个终端
 *   node examples/demo-agent.mjs
 *
 * 退出码：
 *   0  环境就绪
 *   2  需要人工介入（提权 / 设插件路径等），已完成能自动做的部分
 *   3  状态卡住不动（防空转）
 */
const BASE = process.env.TESTKIT_SETUP_URL || 'http://127.0.0.1:8893'

const get = async (p) => {
  const r = await fetch(BASE + p)
  if (!r.ok && r.status !== 500) throw new Error(`GET ${p} → ${r.status}`)
  return r.json()
}
const post = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  return r.json()
}

const log = (...a) => console.log(...a)
const fmt = (steps) => steps.map(s => `${s.ok ? '✓' : '✗'}${s.id}`).join(' ')

async function main() {
  log('=== demo-agent：只用 HTTP 接口装环境 ===')
  log('服务', BASE)

  // ① 先看门槛，确认自己对版本的预期没搞错
  const req = await get('/api/setup/requirements')
  log(`门槛  DSH ≥ ${req.dsh.min} / 插件 ≥ ${req.plugin.min}`)

  let state = await get('/api/setup/state')
  log('初始 ', fmt(state.steps))
  if (state.ok) {
    log('已就绪 →', state.nextAction.monitor || '')
    return 0
  }

  let manualNeeded = null
  let rounds = 0

  while (!state.ok) {
    if (++rounds > 8) {
      log('✗ 超过 8 轮仍未就绪，停止以免空转')
      return 3
    }

    const step = state.steps.find(s => !s.ok)
    if (!step) break
    const na = step.nextAction || {}
    log(`\n[${rounds}] 待办：${step.id}（${step.title}）→ kind=${na.kind}`)
    if (step.detail) log('     ', step.detail.split('\n')[0])

    const before = JSON.stringify(state.steps.map(s => s.ok))

    if (na.needsUserClick) {
      // ★ 关键纪律：这一步 Agent 替不了人。记录下来，别死循环重试。
      log('      ⚠ 需要人工：', na.command || na.kind)
      manualNeeded = manualNeeded || { step: step.id, na }
      // 如果是提权，仍可发起（会弹 UAC），然后继续往下看别的步
      if (na.kind === 'elevate') {
        const r = await post('/api/setup/elevate')
        log('      已发起提权进程，请在 UAC 对话框点「是」：', r.detail || '')
      }
    } else if (na.kind === 'init-profile' || step.id === 'profile') {
      log('      建 profile + pnpm install（可能要一两分钟）…')
      const r = await post('/api/setup/profile', { install: true })
      log('      →', r.ok ? 'ok' : '失败：' + (r.error || ''))
      if (!r.ok && r.log) log(String(r.log).split('\n').slice(-4).join('\n'))
    } else if (na.kind === 'run-smoke') {
      log('      跑冒烟（一次真实会话）…')
      const r = await post('/api/setup/smoke')
      log('      →', r.ok ? `通过（${r.seconds}s，返回「${r.text}」）` : '失败：' + (r.error || ''))
    } else if (na.kind === 'install-dsh' || na.kind === 'upgrade-dsh') {
      log('      需要安装/升级（本示例不代跑 npm install，避免改动你的全局环境）：')
      log('      ' + (na.command || 'npm i -g @deepseek-ai/dsh@latest'))
      manualNeeded = manualNeeded || { step: step.id, na }
    } else if (na.kind === 'set-plugin' || na.kind === 'upgrade-plugin') {
      log('      需要人工处理：', na.hint || na.kind)
      manualNeeded = manualNeeded || { step: step.id, na }
    } else if (na.kind === 'fix-temp' || na.kind === 'fix-profile') {
      log('      配置问题：', na.reason || na.kind)
      manualNeeded = manualNeeded || { step: step.id, na }
    } else {
      log('      未知 nextAction：', JSON.stringify(na))
      return 3
    }

    state = await get('/api/setup/state')
    log('      现在 ', fmt(state.steps))

    // 防空转：状态没变就停（除非刚发起了需要人点的动作）
    const after = JSON.stringify(state.steps.map(s => s.ok))
    if (before === after && !na.needsUserClick) {
      log('\n✗ 状态没有变化 —— 停止。仍需处理的步骤：')
      for (const s of state.steps.filter(x => !x.ok)) {
        log(`   · ${s.id} ${s.title}：${String(s.detail).split('\n')[0]}`)
      }
      return 3
    }
    if (before === after && na.needsUserClick) {
      log('\n⏸ 已发起需要人工确认的动作，等待人完成后重跑本脚本')
      return 2
    }
  }

  log('\n=== 完成 ===')
  for (const s of state.steps) log(`  ${s.ok ? '✓' : '✗'} ${s.title}  ${String(s.detail).split('\n')[0]}`)
  log('')
  log('监控台：', state.nextAction.monitor || 'http://127.0.0.1:8899')
  log('下一步：node suites/families.mjs')
  return 0
}

// ⚠️ 不要用 process.exit()：
//    fetch 的 keep-alive socket 还开着时，Node 24 在 Windows 上会触发
//    `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`（libuv async.c）。
//    改设 exitCode 让事件循环自己收尾 —— 观察到的唯一区别就是不再有那条断言噪声。
main().then(c => { process.exitCode = c }).catch(e => {
  console.error('✗ ' + (e && e.message || e))
  process.exitCode = 1
})
