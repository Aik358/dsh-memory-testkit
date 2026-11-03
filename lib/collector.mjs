/**
 * 逐条输出采集 —— 把 agent 的每一次动作实时落盘。
 *
 * 为什么需要：只看最终文本不足以判断「它有没有越界」。
 * 中途的工具调用、被拒绝的回执、模型的思考，才是直接证据。
 * 实测价值：靠这个抓到了「模型拿不到 eventId 就 pwsh Get-ChildItem -Recurse
 * 翻整个文件系统、读到别的实验工作区」——只看最终输出完全看不到。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PATHS } from './config.mjs'
import { flat } from './driver.mjs'

const KINDS = {
  step: '状态',
  think: '思考',
  text: '正文',
  tool: '工具',
  result: '结果',
  err: '错误',
  user: '用户',
}

function fileOf(key) {
  const safe = String(key).replace(/[^a-zA-Z0-9_.-]/g, '_')
  return path.posix.join(PATHS.liveOutput, safe + '.jsonl')
}

/** 追加一条 */
export function emit(key, kind, v, extra = {}) {
  try {
    fs.mkdirSync(PATHS.liveOutput, { recursive: true })
    const row = {
      t: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      ts: Date.now(),
      kind,
      label: KINDS[kind] || kind,
      v: String(v == null ? '' : v).slice(0, 4000),
      ...extra,
    }
    fs.appendFileSync(fileOf(key), JSON.stringify(row) + '\n', 'utf8')
  } catch (_) {}
}

/** 清空某个 key（重跑同一场景前用） */
export function reset(key) {
  try { fs.unlinkSync(fileOf(key)) } catch (_) {}
}

/** 把一个 NDJSON 事件流展开成逐条记录 */
export function emitFromNdjson(key, stdout) {
  for (const line of String(stdout || '').split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    let r
    try { r = JSON.parse(s) } catch (_) { continue }
    const d = flat(r)

    switch (r.type) {
      case 'session':
        emit(key, 'step', `会话 ${String(d.sessionId || '').slice(0, 22)} · cwd=${d.cwd}`)
        break
      case 'status':
        if (d.phase === 'turn_start') emit(key, 'step', `── turn ${d.turn} 开始 ──`)
        else if (d.phase === 'turn_end') emit(key, 'step', `── turn ${d.turn} 结束：${JSON.stringify(d.reason || {})} ──`)
        else if (d.phase === 'step_end' && d.usage) {
          emit(key, 'step', `step ${d.step} · in=${d.usage.inputTokens} out=${d.usage.outputTokens}`)
        }
        break
      case 'thinking':
        if (String(d.text || '').trim()) emit(key, 'think', d.text)
        break
      case 'text':
        if (String(d.text || '').trim()) emit(key, 'text', d.text)
        break
      case 'tool_call': {
        let brief
        try { brief = typeof d.input === 'string' ? d.input : JSON.stringify(d.input) } catch (_) { brief = String(d.input) }
        emit(key, 'tool', `${d.tool}(${brief})`)
        break
      }
      case 'tool_result':
        emit(key, d.status === 'error' ? 'err' : 'result', `[${d.status || 'ok'}] ${String(d.result || '').slice(0, 1500)}`)
        break
      case 'final':
        emit(key, 'text', '★ FINAL: ' + String(d.text || ''))
        break
      default:
        break
    }
  }
}

/** 读回某个 key 的全部输出（监控台用） */
export function readOutput(key) {
  try {
    return fs.readFileSync(fileOf(key), 'utf8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l) } catch (_) { return null } })
      .filter(Boolean)
  } catch (_) { return [] }
}
