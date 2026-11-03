// 交付包一致性检查
// 为什么不用 shell：中文文件名在 Git Bash 管道里会因编码丢失（实测报 No such file）。
import fs from 'node:fs'
import path from 'node:path'

const DIR = 'D:/memory-testkit/research'
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.md')).sort()

console.log('=== 文档清单 ===')
for (const f of files) {
  const s = fs.readFileSync(path.join(DIR, f), 'utf8')
  const lines = s.split('\n').length
  const head = s.split('\n').slice(0, 6).join(' ').slice(0, 90)
  const status = /^> # ⚠️/.test(s) ? '⚠️ 部分有效'
    : /^> # 📋/.test(s) ? '📋 任务书'
      : /状态：✅/.test(s) ? '✅ 有效'
        : '—'
  console.log(`  ${f.padEnd(38)} ${String(lines).padStart(5)} 行  [${status}]`)
}

console.log('')
console.log('=== 过时论断残留检查 ===')
const ACTIVE = files.filter(f => /^(00|01|02|03|06)-/.test(f))
const STALE_PATTERNS = [
  { re: /净变化\s*[−-]\s*1,498/, label: '「净减 1,498」作为结论' },
  { re: /价值主张.{0,20}省\s*1,498/, label: '「省 1,498」作为价值主张' },
  { re: /删到只剩一句.{0,30}0%/, label: '「删到只剩一句就 0%」未经限定' },
]
let bad = 0
for (const f of ACTIVE) {
  const s = fs.readFileSync(path.join(DIR, f), 'utf8')
  for (const p of STALE_PATTERNS) {
    if (p.re.test(s)) {
      const idx = s.search(p.re)
      const ctx = s.slice(Math.max(0, idx - 60), idx + 80).replace(/\n/g, ' ')
      // 允许出现在「已被推翻」的上下文里
      const isRefuted = /推翻|不成立|失效|❌/.test(s.slice(Math.max(0, idx - 200), idx + 200))
      if (!isRefuted) {
        bad++
        console.log(`  ✗ ${f} 残留「${p.label}」`)
        console.log(`      …${ctx}…`)
      } else {
        console.log(`  · ${f} 提到「${p.label}」但在「已推翻」上下文里（可接受）`)
      }
    }
  }
}
if (!bad) console.log('  ✓ 有效文档里没有未标注的过时论断')

console.log('')
console.log('=== 交叉引用有效性检查 ===')
let broken = 0
for (const f of files) {
  const s = fs.readFileSync(path.join(DIR, f), 'utf8')
  const refs = [...s.matchAll(/`(\d{2}-[^`]+\.md)`/g)].map(m => m[1])
  for (const r of new Set(refs)) {
    if (!files.includes(r)) {
      broken++
      console.log(`  ✗ ${f} 引用了不存在的 ${r}`)
    }
  }
}
if (!broken) console.log('  ✓ 所有交叉引用都指向存在的文档')

console.log('')
console.log('=== 关键数字一致性（同一数字在各文档里是否一致）===')
const KEY = [
  { re: /40\/40|40 次/, label: '交接账本 40 次全过' },
  { re: /0\/162/, label: '真实感知 0/162' },
  { re: /551/, label: '真实会话 551' },
  { re: /71,393/, label: '工具调用 71,393' },
  { re: /15%/, label: '仪式 hasEvent 15%' },
  { re: /2,439.{0,10}2,958/, label: 'token 噪声区间' },
]
for (const k of KEY) {
  const hit = files.filter(f => k.re.test(fs.readFileSync(path.join(DIR, f), 'utf8')))
  console.log(`  ${k.label.padEnd(28)} 出现在 ${hit.length} 份：${hit.slice(0, 4).join(', ')}${hit.length > 4 ? '…' : ''}`)
}
