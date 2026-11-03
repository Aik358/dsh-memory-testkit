// 实验监控室 —— 本地 HTTP 服务 + 单页前端
//
// 数据源：
//   <work>/raw/*.json      每臂汇总
//   <work>/live/*.jsonl    逐条任务的开始/结束（实时）
//   <work>/live/output/*.jsonl  每个 agent 的**逐条输出**（工具调用/工具结果/文本/思考）
//   <work>/sentinel/*.json 哨兵快照与违规报告
//
// 用法：node harness/server.mjs [port]
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { PATHS, REPO, PROFILE } from './config.mjs'

const PORT = Number(process.argv[2] || process.env.TESTKIT_PORT || 8899)
const RAW = PATHS.raw
const LIVE = PATHS.live
const OUT = PATHS.liveOutput
const SEN = PATHS.sentinel
const WSROOT = PATHS.memoryRoot

/** 超过这个时长还没等到 done 的 start 事件视为「已中断」而非「运行中」 */
const STALE_MS = Number(process.env.TESTKIT_STALE_MS || 1800000)

for (const d of [LIVE, OUT, SEN, RAW]) fs.mkdirSync(d, { recursive: true })

/**
 * 提示词面 —— **运行时向产品模块要**，不抄常量。
 *
 * 抄常量必然漂移：这里曾经写死「27 层 / 静态段不可覆盖」，
 * 而产品在 2026-10-29 之后已把 staticPerceptDiscipline / staticCalendarDiscipline
 * 拆成可覆盖层（29 层）。面板显示旧数字等于给审阅者一个错误前提。
 */
let PROMPT_NOW = { error: '未探测' }
try {
  const url = 'file:///' + path.posix.join(REPO, 'lib/index.js') + '?t=' + Date.now()
  const mod = await import(url)
  const L = mod.DEFAULT_PROMPT_LAYERS || {}
  // ★ 只有这两节是「从 renderMemoryStatic 里拆出来、置空即回落到内置文本」。
  //   不能按 /^static/ 判：staticHead / staticWriteDiscipline 是常态有值的独立层，
  //   把它们算进「已拆出」会让面板谎报能力（实测已踩）。
  const SPLIT_KEYS = new Set(['staticPerceptDiscipline', 'staticCalendarDiscipline'])
  const layers = Object.entries(L).map(([k, v]) => ({
    key: k,
    chars: String(v || '').length,
    split: SPLIT_KEYS.has(k),
  }))
  // 静态段：源码块快照（整体仍不可覆盖，但两节已拆出）
  let staticChars = null
  try {
    const src = fs.readFileSync(path.posix.join(REPO, 'lib/index.js'), 'utf8')
    const i = src.indexOf('renderMemoryStatic() {')
    const j = src.indexOf('renderReflectionRequest()', i)
    if (i >= 0 && j > i) staticChars = j - i
  } catch (_) {}
  PROMPT_NOW = {
    at: Date.now(),
    count: layers.length,
    splitCount: layers.filter(l => l.split).length,
    layers,
    staticChars,
  }
} catch (e) {
  PROMPT_NOW = { error: String(e && e.message || e).slice(0, 300) }
}

/** 当前生效的 promptLayerOverrides —— 从沙箱配置读，不靠基线快照（基线是历史时点） */
function readOverrides() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(PATHS.dshHome, 'dsh-auto-memory.json'), 'utf8'))
    const ov = cfg.promptLayerOverrides || {}
    return { keys: Object.keys(ov).filter(k => typeof ov[k] === 'string' && ov[k].trim()), chars: JSON.stringify(ov).length }
  } catch (_) { return { keys: [], chars: 0 } }
}

const readDir = (dir, ext) => {
  const out = []
  try {
    for (const f of fs.readdirSync(dir)) {
      if (ext && !f.endsWith(ext)) continue
      try { out.push({ file: f, body: fs.readFileSync(path.join(dir, f), 'utf8') }) } catch (_) {}
    }
  } catch (_) {}
  return out
}

const parseJsonl = (body) => body.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch (_) { return null } }).filter(Boolean)

/**
 * 统一判定口径 —— 历史产物有两套写法，混算会把整批结果显示成 0%。
 *
 *   · 早期（交接账本批次）   : hardPass / H1..H4
 *   · 后来（记忆面 / 隐式）  : pass
 *   · 仪式批次               : version/world + ledgerWritten/planWritten（无 pass 字段）
 *
 * 「判定」这个语义在各批里的**判据不同**，所以不能用一个布尔硬套：
 * 这里统一成 pass 字段 + 一个 verdict 标签，供前端如实显示口径来源。
 */
function normalizeRow(r) {
  if (!r || typeof r !== 'object') return r || {}
  const out = { ...r }
  if (typeof out.pass !== 'boolean') {
    if (typeof out.hardPass === 'boolean') { out.pass = out.hardPass; out.verdictFrom = 'hardPass' }
    else if (out.ledgerWritten !== undefined || out.planWritten !== undefined) {
      // 仪式：完成 = 账本 + 白板都落盘，且没挂错（与 suites/ritual.mjs 的 judgeRitual 同口径）
      out.pass = !!out.ledgerWritten && !!out.planWritten && !out.wrongAttach
      out.verdictFrom = 'ritual'
    } else out.pass = null
  } else out.verdictFrom = out.verdictFrom || 'pass'

  // 字符数：只有早期账本批次有；其余批次没有这个量，如实留空（不要用别的字段硬凑）
  if (typeof out.chars !== 'number') out.chars = null

  // 写入条数：新批次用 writes / writesSummary 记「往各记忆面写了几条」
  const w = out.writes || out.writesSummary
  out.writesN = (w && typeof w === 'object')
    ? Object.values(w).reduce((s, v) => s + (Number(v) || 0), 0)
    : null

  // 标题：账本开头 / 场景标签 / 最终回复，三选一
  out.head = out.ledgerHead || out.finalHead || out.label || out.taskHead || ''
  out.id = out.taskId || out.scenario || (out.version ? out.version + '/' + (out.world || '') : '')
  return out
}

function tailFile(f, maxBytes = 200000) {
  try {
    const st = fs.statSync(f)
    const start = Math.max(0, st.size - maxBytes)
    const fd = fs.openSync(f, 'r')
    const buf = Buffer.alloc(st.size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    return buf.toString('utf8')
  } catch (_) { return '' }
}

function collect() {
  const arms = readDir(RAW, '.json').map(({ file, body }) => {
    let rows = []
    try { rows = JSON.parse(body) } catch (_) {}
    if (!Array.isArray(rows)) rows = []
    return { arm: file.replace(/^arm-|^family-|^implicit-|^ritual-|^verify-|\.json$/g, ''), rows: rows.map(normalizeRow) }
  })

  const live = []
  for (const { file, body } of readDir(LIVE, '.jsonl')) {
    const tag = file.replace(/\.jsonl$/, '')
    for (const r of parseJsonl(body)) live.push({ arm: tag, ...normalizeRow(r) })
  }
  // ★ 陈旧 start 事件降级：2 天前被中断的任务，其 start 行如果原样渲染成
  //   「运行中」，会让审阅者以为实验还在跑（实测踩过）。这里显式标记。
  const now0 = Date.now()
  const doneKeys = new Set(live.filter(r => r.phase !== 'start').map(r => r.arm + '\u0000' + (r.taskId || r.scenario)))
  for (const r of live) {
    if (r.phase !== 'start') continue
    const key = r.arm + '\u0000' + (r.taskId || r.scenario)
    const ageMs = now0 - (r.ts || 0)
    if (doneKeys.has(key)) r.stale = 'done-elsewhere'
    else if (ageMs > STALE_MS) r.stale = 'interrupted'
    else r.stale = null
  }

  // 逐条输出（最需要看的部分）
  const outputs = {}
  for (const { file, body } of readDir(OUT, '.jsonl')) {
    const key = file.replace(/\.jsonl$/, '')
    outputs[key] = parseJsonl(body)
  }

  // 哨兵报告
  const sentinel = []
  for (const { file, body } of readDir(SEN, '.json')) {
    if (!file.startsWith('report-')) continue
    try { sentinel.push({ file, ...JSON.parse(body) }) } catch (_) {}
  }
  // 最新基线快照（只报元数据）
  let baselineMeta = null
  try {
    const b = JSON.parse(tailFile(path.join(SEN, 'baseline.json'), 5_000_000))
    baselineMeta = {
      at: b.at,
      promptLayers: Object.keys(b.prompts?.layers || {}).length,
      staticChars: b.prompts?.static?.chars,
      staticMarkers: b.prompts?.static?.markers,
      // 历史基线用的是 expStore；新版 fullSnapshot() 改叫 sandboxStore
      expStoreFiles: Object.keys(b.sandboxStore || b.expStore || {}).length,
      realHomeFiles: Object.keys(b.realHome || {}).length,
      productFiles: Object.keys(b.product || {}).length,
    }
  } catch (_) {}

  const now = Date.now()
  const running = live.filter(r => r.phase === 'start' && !r.stale && now - r.ts < STALE_MS)

  return {
    now, arms, live, outputs, sentinel, baselineMeta,
    promptsNow: { ...PROMPT_NOW, overrides: readOverrides() },
    env: { profile: PROFILE, repo: REPO, work: PATHS.dshHome.replace(/[\\/]dshhome$/, '') },
    runningCount: running.length,
  }
}

const HTML = String.raw`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>记忆实验 · 监控室</title>
<style>
  :root{
    --bg:#08090c; --panel:#101318; --panel2:#161a21; --line:#232932;
    --fg:#e8ecf2; --dim:#8b94a3; --dim2:#59616e;
    --ok:#3fb950; --bad:#f85149; --warn:#d29922; --info:#58a6ff; --accent:#7c5cff; --term:#0c1014;
  }
  @media (prefers-color-scheme: light){
    :root{ --bg:#f4f6f8; --panel:#fff; --panel2:#eef1f4; --line:#dde1e6;
           --fg:#1a1f26; --dim:#5a6572; --dim2:#8b949e; --term:#0c1014; }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
       font:13px/1.5 ui-sans-serif,-apple-system,"Segoe UI","Noto Sans CJK SC",sans-serif}
  header{padding:11px 18px;border-bottom:1px solid var(--line);display:flex;
         align-items:center;gap:14px;position:sticky;top:0;background:var(--bg);z-index:20}
  h1{font-size:14px;margin:0;font-weight:600}
  .spacer{flex:1}
  .badge{padding:2px 9px;border-radius:99px;font-size:11px;font-weight:600;border:1px solid}
  .b-run{color:var(--info);border-color:var(--info);background:color-mix(in srgb,var(--info) 12%,transparent)}
  .b-idle{color:var(--dim);border-color:var(--line)}
  .b-ok{color:var(--ok);border-color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,transparent)}
  .b-bad{color:var(--bad);border-color:var(--bad);background:color-mix(in srgb,var(--bad) 14%,transparent)}
  nav{display:flex;gap:2px;padding:0 18px;border-bottom:1px solid var(--line);
      position:sticky;top:47px;background:var(--bg);z-index:19}
  nav button{background:none;border:none;border-bottom:2px solid transparent;color:var(--dim);
             padding:9px 14px;font-size:13px;cursor:pointer;font-weight:500}
  nav button.on{color:var(--fg);border-bottom-color:var(--accent)}
  nav button .n{display:inline-block;margin-left:5px;padding:0 5px;border-radius:5px;
                background:var(--panel2);font-size:10px;color:var(--dim2)}
  main{padding:16px 18px 60px;max-width:1700px;margin:0 auto}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin-bottom:18px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:11px 13px}
  .card .k{font-size:10px;text-transform:uppercase;letter-spacing:.7px;color:var(--dim2);margin-bottom:5px}
  .card .v{font-size:21px;font-weight:650;font-variant-numeric:tabular-nums}
  .card .s{font-size:11px;color:var(--dim);margin-top:2px}
  .card.alarm{border-color:var(--bad);background:color-mix(in srgb,var(--bad) 8%,var(--panel))}
  .card.good{border-color:var(--ok);background:color-mix(in srgb,var(--ok) 7%,var(--panel))}
  section{margin-bottom:22px}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--dim);
     margin:0 0 9px;font-weight:600}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  th,td{text-align:left;padding:6px 9px;border-bottom:1px solid var(--line);vertical-align:top}
  th{font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim2);font-weight:600}
  tr:hover td{background:var(--panel2)}
  code,.mono{font-family:ui-monospace,"Cascadia Code",Consolas,monospace;font-size:11.5px}
  .pass{color:var(--ok);font-weight:600}
  .fail{color:var(--bad);font-weight:600}
  .warn{color:var(--warn)}
  .bar{height:5px;border-radius:3px;background:var(--panel2);overflow:hidden;min-width:70px}
  .bar>i{display:block;height:100%;background:var(--ok)}
  .bar.mid>i{background:var(--warn)} .bar.low>i{background:var(--bad)}
  .empty{color:var(--dim2);font-style:italic;padding:16px 0}
  .live-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--info);
            animation:pulse 1.2s ease-in-out infinite;margin-right:5px;vertical-align:middle}
  @keyframes pulse{0%,100%{opacity:.2}50%{opacity:1}}
  /* 终端窗格 */
  .term{background:var(--term);border:1px solid var(--line);border-radius:8px;
        padding:10px 12px;max-height:520px;overflow:auto;
        font-family:ui-monospace,"Cascadia Code",Consolas,monospace;font-size:11.5px;
        line-height:1.55;color:#c9d1d9}
  .term .row{display:flex;gap:8px;padding:1px 0;border-bottom:1px solid rgba(255,255,255,.03)}
  .term .t{color:#6e7681;flex-shrink:0;width:52px}
  .term .k{flex-shrink:0;font-weight:600;width:88px}
  .term .c{word-break:break-word;white-space:pre-wrap;flex:1;min-width:0}
  .k-think{color:#8b949e} .k-text{color:#7ee787} .k-tool{color:#79c0ff}
  .k-result{color:#ffa657} .k-err{color:#ff7b72} .k-user{color:#d2a8ff}
  .k-step{color:#484f58}
  .toolbar{display:flex;gap:7px;margin-bottom:9px;flex-wrap:wrap;align-items:center}
  .toolbar button,.toolbar select{background:var(--panel);border:1px solid var(--line);color:var(--dim);
    padding:4px 10px;border-radius:6px;font-size:11.5px;cursor:pointer}
  .toolbar button.on{color:var(--fg);border-color:var(--accent);
    background:color-mix(in srgb,var(--accent) 15%,transparent)}
  .split{display:grid;grid-template-columns:230px 1fr;gap:14px}
  .agentlist{border:1px solid var(--line);border-radius:8px;overflow:hidden;max-height:560px;overflow-y:auto}
  .agentlist .it{padding:8px 10px;border-bottom:1px solid var(--line);cursor:pointer;font-size:12px}
  .agentlist .it:hover{background:var(--panel2)}
  .agentlist .it.on{background:color-mix(in srgb,var(--accent) 16%,transparent);
                    border-left:2px solid var(--accent)}
  .agentlist .it .nm{font-family:ui-monospace,monospace;font-size:11px;color:var(--fg);
                     white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .agentlist .it .mt{font-size:10px;color:var(--dim2);margin-top:2px}
  .pill{display:inline-block;padding:0 6px;border-radius:5px;font-size:10px;
        background:var(--panel2);border:1px solid var(--line);color:var(--dim);white-space:nowrap}
  .scroll{max-height:420px;overflow:auto;border:1px solid var(--line);border-radius:8px}
  .head{font-size:11px;color:var(--dim);white-space:pre-wrap;word-break:break-word;
        max-height:60px;overflow:hidden;mask-image:linear-gradient(#000 55%,transparent)}
  .hide{display:none}
</style>
</head>
<body>
<header>
  <h1>记忆实验 · 监控室</h1>
  <span id="runBadge" class="badge b-idle">加载中</span>
  <span id="alarmBadge" class="badge b-ok hide">无违规</span>
  <span class="spacer"></span>
  <span class="mono" id="clock" style="color:var(--dim2);font-size:11px"></span>
</header>
<nav id="tabs">
  <button data-t="overview" class="on">总览</button>
  <button data-t="agents">Agent 实时输出<span class="n" id="nAgents">0</span></button>
  <button data-t="tasks">任务流<span class="n" id="nTasks">0</span></button>
  <button data-t="guard">完整性哨兵<span class="n" id="nGuard">0</span></button>
  <button data-t="prompts">提示词面</button>
</nav>
<main>
  <div id="v-overview"></div>
  <div id="v-agents" class="hide"></div>
  <div id="v-tasks" class="hide"></div>
  <div id="v-guard" class="hide"></div>
  <div id="v-prompts" class="hide"></div>
</main>
<script>
const $ = (id) => document.getElementById(id)
const esc = (s) => String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
let TAB = 'overview', CUR = null, FILTER = 'all', DATA = null

document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => {
  TAB = b.dataset.t
  document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x === b))
  for (const k of ['overview','agents','tasks','guard','prompts'])
    $('v-' + k).classList.toggle('hide', k !== TAB)
  render()
})

function renderOverview(d){
  const all = d.arms.flatMap(a => a.rows.map(r => ({...r, arm:a.arm})))
  const judged = all.filter(r => typeof r.pass === 'boolean')
  const n = judged.length, pass = judged.filter(r=>r.pass).length
  const unjudged = all.length - n
  const pol = all.filter(r=>(r.pollution||0)>0).length
  const viol = d.sentinel.reduce((s,r)=>s+((r.violations||[]).length), 0)
  const susp = d.sentinel.reduce((s,r)=>s+((r.suspicious||[]).length), 0)
  const withChars = all.filter(r => typeof r.chars === 'number' && r.chars > 0)
  const avg = withChars.length ? Math.round(withChars.reduce((s,r)=>s+r.chars,0)/withChars.length) : '—'
  const fams = [...new Set(all.map(r=>r.family).filter(Boolean))]

  const cards = [
    ['已完成调用', n, n ? (d.arms.length+' 套件 · '+fams.length+' 记忆面') : '等待首批', ''],
    ['合规率', n ? Math.round(pass/n*100)+'%' : '—', pass+' / '+n+(unjudged?' （另有 '+unjudged+' 条无判定字段）':''), pass===n&&n?'good':''],
    ['格式污染', pol, pol ? '标题带 (type:xxx)' : '暂无', pol?'':''],
    ['平均账本字符', avg, withChars.length ? withChars.length+' 条有字符数' : '暂无可用数据', ''],
    ['违规告警', viol, viol ? '★真实库/产品代码被改，请立刻查完整性子哨兵'
      : (susp ? susp + ' 项可疑（宿主活跃）另计，非红线' : '真实库/产品代码零改动'), viol?'alarm':(susp?'':'good')],
    ['任务流记录', d.live.length, '含已中断的 start 行（下面标注）', ''],
  ]
  let h = '<div class="grid">' + cards.map(([k,v,s,cls])=>
    '<div class="card '+cls+'"><div class="k">'+k+'</div><div class="v">'+v+'</div><div class="s">'+(s||'')+'</div></div>').join('') + '</div>'

  h += '<section><h2>各套件汇总</h2>'
  if (!d.arms.length) h += '<div class="empty">尚无套件落盘</div>'
  else {
    h += '<table><thead><tr><th style="width:170px">套件</th><th style="width:150px">合规</th>'+
      '<th style="width:70px">污染</th><th style="width:80px">平均字符</th><th style="width:80px">平均input</th>'+
      '<th style="width:80px">H1/H2</th><th>失败明细</th></tr></thead><tbody>'
    for (const a of d.arms.slice().sort((x,y)=>x.arm.localeCompare(y.arm))) {
      const rowsJ = a.rows.filter(r => typeof r.pass === 'boolean')
      const m = rowsJ.length, p = rowsJ.filter(r=>r.pass).length
      const pl=a.rows.filter(r=>(r.pollution||0)>0).length
      const aCh=a.rows.filter(r=>typeof r.chars==='number'&&r.chars>0)
      const ac=aCh.length?Math.round(aCh.reduce((s,r)=>s+r.chars,0)/aCh.length):null
      const aTok=a.rows.filter(r=>r.inputTokens>0)
      const at=aTok.length?Math.round(aTok.reduce((s,r)=>s+r.inputTokens,0)/aTok.length):null
      const h1=a.rows.filter(r=>r.H1===true).length, h2Rows=a.rows.filter(r=>r.H2!==undefined)
      const rc=m?Math.round(p/m*100):0
      // 失败明细：优先 detail（新口径），退回 hardDetail（旧口径）
      const fails=a.rows.filter(r=>r.pass===false)
        .map(r=>r.id+': '+[].concat(r.detail||r.hardDetail||[]).join(';'))
        .filter(s=>s.length>3).slice(0,3).join('<br>')
      h += '<tr><td class="mono">'+esc(a.arm)+'</td>'+
        '<td>'+(m?('<div class="bar '+(rc>=95?'':(rc>=60?'mid':'low'))+'"><i style="width:'+rc+'%"></i></div>'+
          '<span class="mono" style="font-size:10px;color:var(--dim)">'+p+'/'+m+' ('+rc+'%)</span>'):'<span style="color:var(--dim2)">无判定字段</span>')+'</td>'+
        '<td class="'+(pl?'warn':'pass')+'">'+pl+'/'+a.rows.length+'</td>'+
        '<td class="mono">'+(ac==null?'—':ac)+'</td><td class="mono">'+(at==null?'—':at)+'</td>'+
        '<td class="mono '+(h2Rows.length&&h1===m?'pass':'')+'" style="color:var(--dim)">'+(h2Rows.length?h1+'/'+m:'—')+'</td>'+
        '<td class="mono" style="color:var(--dim);font-size:10px">'+(fails||'—')+'</td></tr>'
    }
    h += '</tbody></table>'
  }
  h += '</section>'

  // 最近违规
  h += '<section><h2>最近违规事件（真实库 / 产品代码 / 提示词）</h2>'
  const recent = d.sentinel.slice(-6).reverse()
  if (!recent.length) h += '<div class="empty">尚无哨兵报告。每跑完一条任务会产出一份。</div>'
  else {
    h += '<table><thead><tr><th style="width:100px">时间</th><th style="width:80px">违规</th>'+
      '<th style="width:80px">可疑</th><th style="width:110px">提示词</th><th>涉及面</th></tr></thead><tbody>'
    for (const r of recent) {
      const vs = r.violations||[]
      const sus = r.suspicious||[]
      const all = vs.concat(sus)
      const areas = [...new Set(all.map(v=>v.area))].join('、') || '无'
      h += '<tr><td class="mono">'+new Date(r.at).toLocaleTimeString('zh-CN',{hour12:false})+'</td>'+
        '<td class="'+(vs.length?'fail':'pass')+'">'+(vs.length||0)+'</td>'+
        '<td class="'+(sus.length?'warn':'')+'">'+(sus.length||0)+'</td>'+
        '<td class="'+(r.promptsSame?'pass':'fail')+'">'+(r.promptsSame?'未变':'★有变')+'</td>'+
        '<td class="mono" style="font-size:11px">'+esc(areas)+'</td></tr>'
    }
    h += '</tbody></table>'
  }
  h += '</section>'
  $('v-overview').innerHTML = h
}

function renderAgents(d){
  const keys = Object.keys(d.outputs || {})
  if (!keys.length) { $('v-agents').innerHTML = '<div class="empty">尚无 agent 输出流。任务一开始跑就会出现。</div>'; return }
  if (!CUR || !d.outputs[CUR]) CUR = keys[keys.length-1]

  let h = '<div class="split"><div><h2>Agent 运行实例</h2><div class="agentlist">'
  for (const k of keys.slice().reverse()) {
    const rows = d.outputs[k]
    const last = rows[rows.length-1] || {}
    const nTool = rows.filter(r=>r.kind==='tool').length
    h += '<div class="it '+(k===CUR?'on':'')+'" onclick="pick(\''+esc(k).replace(/'/g,"\\'")+'\')">'+
      '<div class="nm">'+esc(k)+'</div>'+
      '<div class="mt"><span class="pill">'+rows.length+' 条</span> '+
      '<span class="pill">'+nTool+' 工具</span></div></div>'
  }
  h += '</div></div><div>'

  // 过滤器
  h += '<div class="toolbar">'
  for (const [k,label] of [['all','全部'],['tool','工具'],['result','结果'],['text','文本'],['think','思考']])
    h += '<button class="'+(FILTER===k?'on':'')+'" onclick="setFilter(\''+k+'\')">'+label+'</button>'
  h += '<span class="spacer" style="flex:1"></span>'
  h += '<span class="mono" style="color:var(--dim2);font-size:11px">'+esc(CUR)+'</span></div>'

  const rows = (d.outputs[CUR]||[]).filter(r => FILTER==='all' || r.kind===FILTER)
  h += '<div class="term" id="term">'
  for (const r of rows) {
    const kindCls = {think:'k-think',text:'k-text',tool:'k-tool',result:'k-result',err:'k-err',user:'k-user',step:'k-step'}[r.kind]||'k-text'
    const kindLabel = {think:'思考',text:'正文',tool:'工具',result:'结果',err:'错误',user:'用户',step:'状态'}[r.kind]||r.kind
    h += '<div class="row"><span class="t">'+(r.t||'')+'</span>'+
         '<span class="k '+kindCls+'">'+kindLabel+'</span>'+
         '<span class="c">'+esc(r.v)+'</span></div>'
  }
  h += '</div></div></div>'
  $('v-agents').innerHTML = h
  const t = $('term'); if (t) t.scrollTop = t.scrollHeight
}

function renderTasks(d){
  // ★ 陈旧 start 行：若同一 (套件,任务) 已有 done 行，start 行是纯冗余 —— 隐藏。
  //   若没有 done 行（真被中断），保留并标「已中断」，那是需要人看的信息。
  const rows = d.live
    .filter(r => !(r.phase === 'start' && r.stale === 'done-elsewhere'))
    .filter(r=>FILTER==='all'||r.arm===FILTER)
    .slice().reverse()
  const arms = [...new Set(d.live.map(r=>r.arm))]
  let h = '<div class="toolbar"><button class="'+(FILTER==='all'?'on':'')+'" onclick="setFilter(\'all\')">全部</button>'
  for (const a of arms) h += '<button class="'+(FILTER===a?'on':'')+'" onclick="setFilter(\''+esc(a).replace(/'/g,"\\'")+'\')">'+esc(a)+'</button>'
  h += '</div>'
  if (!rows.length) { $('v-tasks').innerHTML = h + '<div class="empty">尚无任务</div>'; return }
  h += '<div class="scroll"><table><thead><tr><th style="width:130px">套装</th><th style="width:120px">任务</th>'+
    '<th style="width:64px">判定</th><th style="width:60px">写入</th><th style="width:60px">字符</th><th style="width:50px">污染</th>'+
    '<th style="width:52px">耗时</th><th>账本开头</th></tr></thead><tbody>'
  for (const r of rows) {
    if (r.phase==='start') {
      // 走到这里的只有「真被中断」（有 done 行的已在上面过滤掉）
      h += '<tr><td class="mono">'+esc(r.arm)+'</td><td class="mono" style="color:var(--dim)">'+esc(r.id||'')+'</td>'+
        '<td><span class="pill" style="color:var(--warn);border-color:var(--warn)">已中断</span></td>'+
        '<td class="mono">—</td><td class="mono">—</td><td class="mono">—</td><td class="mono">—</td>'+
        '<td style="color:var(--dim2)">'+esc(String(r.taskHead||'').slice(0,120))+'</td></tr>'
      continue
    }
    const pass = r.pass
    const vcls = pass===true?'pass':(pass===false?'fail':'')
    const vtxt = pass===true?'PASS':(pass===false?'FAIL':'—')
    // 只显示真实存在的量：账本字符（早期批次）/ 写入条数（新批次），没有就打 —
    const ch = typeof r.chars === 'number' ? r.chars
      : (r.ledgerWritten!==undefined ? (r.ledgerWritten?'有':'无') : '—')
    const wn = r.writesN==null ? '—' : r.writesN
    h += '<tr><td class="mono">'+esc(r.arm)+'</td><td class="mono" style="color:var(--dim)">'+esc(r.id||'')+'</td>'+
      '<td class="'+vcls+'">'+vtxt+'</td>'+
      '<td class="mono">'+wn+'</td>'+
      '<td class="mono">'+esc(ch)+'</td><td class="mono '+(r.pollution?'warn':'')+'">'+(r.pollution===undefined?'—':r.pollution)+'</td>'+
      '<td class="mono">'+(typeof r.seconds==='number'?Math.round(r.seconds)+'s':'—')+'</td>'+
      '<td><div class="head mono">'+esc(r.head||'')+'</div></td></tr>'
  }
  $('v-tasks').innerHTML = h + '</tbody></table></div>'
}

function renderGuard(d){
  const b = d.baselineMeta
  const p = d.promptsNow || {}
  // ★ 三级分流要分别计数：违规（红线）/ 可疑（宿主活跃时的真实库变化）/ 白名单
  //   混成一个数字会让「有违规」这件事失去分辨力（实测宿主活跃时报 44 项假阳性）。
  //   另外把「最近一次任务的违规数」单独列出 —— 历史报告可能来自旧版哨兵，
  //   混在一起会让人以为当前还在违规（实测确实造成了误读）。
  const agg = d.sentinel.reduce((a, r) => {
    a.viol += (r.violations || []).length
    a.susp += (r.suspicious || []).length
    a.amb += (r.ambientSkipped || []).length
    if (r.hostActive && r.hostActive.active === false) a.hostIdle++
    return a
  }, { viol: 0, susp: 0, amb: 0, hostIdle: 0 })
  const sorted = d.sentinel.slice().sort((x, y) => (y.at || 0) - (x.at || 0))
  const latest = sorted[0] || null
  const latestViol = latest ? (latest.violations || []).length : 0

  let h = '<section><h2>基线快照（哨兵覆盖面）</h2><div class="grid">'
  if (b) {
    h += card('真实 home 文件', b.realHomeFiles, '任何增删改都要有解释')
    h += card('产品代码文件', b.productFiles, 'D:\\dsh-auto-memory\\lib 全量 sha256')
    h += card('实验库文件', b.expStoreFiles, '允许写入，但逐条审计')
    // ★ 基线是历史快照（2026-10-29），层数会落后于产品现状 —— 不能当现状显示
    h += card('提示词层（基线快照）', b.promptLayers,
      p.count ? ('当时快照；当前实测 ' + p.count + ' 层') : '当时快照')
  } else h += '<div class="empty">尚无基线快照</div>'
  h += '</div>'
  h += '<div class="grid" style="margin-top:-6px">' +
    card('最近一次任务违规', latestViol, latest ? (latestViol ? '★真实库/产品代码被改' : '无越界（' + new Date(latest.at).toLocaleTimeString('zh-CN',{hour12:false}) + '）') : '无报告') +
    card('历史累计违规', agg.viol, agg.viol ? '★含旧版哨兵产生的记录，见下表' : '无') +
    card('可疑变化', agg.susp, agg.susp ? '宿主活跃期间的写入，需人工确认' : '无') +
    card('白名单豁免', agg.amb, '宿主心跳/证据流/索引等运行态') +
    '</div>'
  if (b) {
    h += '<div class="empty" style="font-size:11px">基线时间 ' +
      new Date(b.at).toLocaleString('zh-CN',{hour12:false}) +
      ' —— 之后产品若有改动，这份快照的层数/字符数就不代表现状；以「提示词面」页签的运行时探测为准。</div>'
  }
  h += '</section>'

  if (b && b.staticMarkers) {
    const m = b.staticMarkers
    h += '<section><h2>关键规则串在位检查（静态纪律段，不可被配置覆盖）</h2><table><thead><tr>'+
      '<th style="width:200px">规则</th><th style="width:70px">在位</th><th>说明</th></tr></thead><tbody>'
    const defs = [['fourSections','四段标题（任务状态/目标/已试/进度）'],
                  ['percept','四类感知（userPercept）'],
                  ['procedure','技能库（memory_procedure）'],
                  ['typeTags','看板 tag（type:goal 等）']]
    for (const [k,label] of defs)
      h += '<tr><td>'+label+'</td><td class="'+(m[k]?'pass':'fail')+'">'+(m[k]?'✓':'✗')+'</td>'+
           '<td class="mono" style="color:var(--dim2);font-size:11px">'+k+'</td></tr>'
    h += '</tbody></table></section>'
  }

  h += '<section><h2>逐条任务完整性审计</h2>'
  // ★ 只渲染最近 40 条：完整历史有近 200 份，全铺出来会把页面拉成几十屏
  //   （实测 fullPage 截图变成一条无法阅读的窄带）。需要全量请看 sentinel/ 目录。
  const reps = d.sentinel.slice(-40).reverse()
  if (!reps.length) h += '<div class="empty">尚无报告</div>'
  else {
    if (d.sentinel.length > reps.length) {
      h += '<div class="empty" style="font-size:11px">共 ' + d.sentinel.length +
        ' 份报告，这里显示最近 ' + reps.length + ' 份（全量在 sentinel/ 目录）</div>'
    }
    h += '<table><thead><tr><th style="width:88px">时间</th><th style="width:56px">违规</th>'+
      '<th style="width:60px">可疑</th><th style="width:70px">白名单</th><th style="width:110px">提示词</th>'+
      '<th style="width:190px">实验库写入面</th><th>真实库/代码越界</th></tr></thead><tbody>'
    for (const r of reps) {
      const vs = (r.violations||[])
      const sus = (r.suspicious||[])
      const expAreas = {}
      for (const w of (r.expStoreWrites||r.sandboxWrites||[])) expAreas[w.area] = (expAreas[w.area]||0)+1
      const expStr = Object.entries(expAreas).map(([k,v])=>k+'×'+v).join('、')
      const fmt = (arr) => arr.map(v=>v.kind+' '+v.area+' '+String(v.path||'').split(/[\\/]/).pop()).join('<br>')
      const vStr = vs.length ? fmt(vs) : (sus.length ? '<span class="warn">'+fmt(sus)+'</span>' : '—')
      const hostTag = r.hostActive && r.hostActive.active
        ? '<span class="pill" title="宿主进程在运行，真实库变化可能来自它">宿主活跃</span>' : ''
      h += '<tr><td class="mono">'+new Date(r.at).toLocaleTimeString('zh-CN',{hour12:false})+'</td>'+
        '<td class="'+(vs.length?'fail':'pass')+'">'+(vs.length||0)+'</td>'+
        '<td class="'+(sus.length?'warn':'')+'">'+(sus.length||0)+'</td>'+
        '<td class="mono" style="color:var(--dim2)">'+((r.ambientSkipped||[]).length||0)+'</td>'+
        '<td class="'+(r.promptsSame?'pass':'fail')+'">'+(r.promptsSame?'未变':'★有变')+' '+hostTag+'</td>'+
        '<td class="mono" style="font-size:11px;color:var(--dim)">'+esc(expStr||'—')+'</td>'+
        '<td class="mono" style="font-size:11px">'+vStr+'</td></tr>'
    }
    h += '</tbody></table>'
  }
  h += '</section>'
  $('v-guard').innerHTML = h
}

function card(k,v,s){ return '<div class="card"><div class="k">'+k+'</div><div class="v">'+v+'</div><div class="s">'+(s||'')+'</div></div>' }

function renderPrompts(d){
  const p = d.promptsNow || {}
  const b = d.baselineMeta
  let h = '<section><h2>提示词注入面（运行时探测）</h2>'
  if (p.error) {
    $('v-prompts').innerHTML = h + '<div class="empty" style="color:var(--bad);font-style:normal">' +
      '★ 探测失败：' + esc(p.error) + '<br>检查 TESTKIT_REPO 是否指向插件源码。</div></section>'
    return
  }
  const split = (p.layers||[]).filter(l=>l.split)
  h += '<div class="grid">' +
       card('动态层数', p.count, '全部可通过 promptLayerOverrides 覆盖') +
       card('已拆出的静态节', p.splitCount || 0, '置空即回落内置文本（字节不变）') +
       card('静态段字符', p.staticChars==null?'—':p.staticChars, 'renderMemoryStatic() 源码块（其余仍硬编码）') +
       card('基线快照层数', b?b.promptLayers:'—', '哨兵基线（历史快照，可能较旧）') +
       '</div>'

  if (split.length) {
    h += '<div class="card good" style="margin-bottom:16px">' +
      '<div class="k">已从静态段拆出的可覆盖节</div>' +
      '<div style="font-size:12px;color:var(--dim);margin-top:4px">' +
      esc(split.map(l=>l.key+' ('+l.chars+' 字符)').join(' · ')) +
      '<br>这两节原本硬编码在 renderMemoryStatic() 里，promptLayerOverrides 改不到 ⇒ 实验无法在不改产品代码的前提下测它们。现已拆层：置空 = 用内置文本（字节级不变）。</div></div>'
  } else {
    h += '<div class="empty" style="color:var(--warn);font-style:normal">' +
      '★ 未发现 static* 层：静态纪律段全部硬编码，promptLayerOverrides 改不到它 ⇒ ' +
      '「精简静态纪律」这个自变量无法在不改代码的前提下测。</div>'
  }

  // 层清单（真实字数，不是抄来的常量）
  h += '<h2 style="margin-top:18px">层清单</h2><div class="scroll"><table><thead><tr>' +
       '<th style="width:260px">层名</th><th style="width:90px">字符</th><th style="width:90px">类型</th>' +
       '<th>生效值来源</th></tr></thead><tbody>'
  const ovKeys = new Set((p.overrides && p.overrides.keys) || [])
  for (const l of (p.layers||[]).slice().sort((x,y)=>x.key.localeCompare(y.key))) {
    h += '<tr><td class="mono">'+esc(l.key)+'</td>' +
      '<td class="mono">'+(l.chars==null?'—':l.chars)+'</td>' +
      '<td>'+(l.split?'<span class="pill">静态拆层</span>':'<span class="pill">动态</span>')+'</td>' +
      '<td class="mono" style="font-size:11px;color:var(--dim)">'+
      (ovKeys.has(l.key)?'<span class="warn">被 promptLayerOverrides 覆盖</span>':(l.chars?'product 默认':'★空值'))+'</td></tr>'
  }
  h += '</tbody></table></div>'
  h += '<div class="empty" style="font-size:11px">探测时间 ' +
       new Date(p.at).toLocaleString('zh-CN',{hour12:false}) + ' · 数据源 ' + esc(d.env.repo) + '/lib/index.js · ' +
       '当前覆盖 ' + ovKeys.size + ' 层</div>'
  h += '</section>'
  $('v-prompts').innerHTML = h
}

function render(){
  const d = DATA; if (!d) return
  if (TAB==='overview') renderOverview(d)
  else if (TAB==='agents') renderAgents(d)
  else if (TAB==='tasks') renderTasks(d)
  else if (TAB==='guard') renderGuard(d)
  else renderPrompts(d)
}
function pick(k){ CUR = k; render() }
function setFilter(k){ FILTER = k; render() }

async function tick(){
  let d
  try { d = await (await fetch('/api/state')).json() } catch(e){ return }
  DATA = d
  $('clock').textContent = new Date(d.now).toLocaleTimeString('zh-CN',{hour12:false})
  const rb = $('runBadge')
  if (d.runningCount>0){ rb.className='badge b-run'; rb.innerHTML='<span class="live-dot"></span>运行中 '+d.runningCount }
  else { rb.className='badge b-idle'; rb.textContent='空闲' }

  const viol = d.sentinel.reduce((s,r)=>s+((r.violations||[]).length),0)
  const ab = $('alarmBadge')
  if (viol>0){ ab.className='badge b-bad'; ab.classList.remove('hide'); ab.textContent='★ '+viol+' 项违规' }
  else { ab.className='badge b-ok'; ab.classList.remove('hide'); ab.textContent='无违规' }

  $('nAgents').textContent = Object.keys(d.outputs||{}).length
  $('nTasks').textContent = d.live.length
  $('nGuard').textContent = d.sentinel.length
  render()
}
tick(); setInterval(tick, 2500)
</script>
</body>
</html>`

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0]
  if (url === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(collect()))
    return
  }
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(HTML)
    return
  }
  // 浏览器自动请求 favicon —— 不处理会在控制台留一条 404（截图验收时会误以为是页面 bug）
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return }
  res.writeHead(404); res.end('not found')
})

server.listen(PORT, '127.0.0.1', () => console.log('监控室: http://127.0.0.1:' + PORT))
