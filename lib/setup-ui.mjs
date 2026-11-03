/**
 * Setup 向导 + Agent 接口 —— 端口 8893。
 *
 * 与 server.mjs（8899 监控台）分开的理由：
 *   监控台是**跑实验时**看的；向导发生在**跑实验之前**，且失败时要能反复重试。
 *   两者生命周期与读者都不同，合在一起会让「跑实验」和「装环境」互相牵制。
 *
 * ── 设计约束 ──
 *   · 全部 loopback only（与现有 server 一致）
 *   · 每个响应都带 nextAction，Agent 不需要解析中文
 *   · 有状态但可重入：任何一步都可以重复调用，幂等
 *   · needsUserClick: true 表示「这一步我替不了人」，Agent 要能识别而不是无限重试
 *
 * 用法：node lib/setup-ui.mjs [port]
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { getState, buildProfile, installProfile, smoke, STEPS, REQUIREMENTS } from './setup-state.mjs'
import { detectEnv, summarize } from './env.mjs'
import { PATHS, PROFILE, WORK, REPO } from './config.mjs'
import { providerState, saveProvider, resolveProvider, validateProvider } from './provider.mjs'
import {
  listExperiments, loadExperiment, validateExperiment, EXPERIMENTS_DIR,
} from './experiment.mjs'
import { runExperiment, readRun, listRuns } from './experiment-run.mjs'
import { buildProviderPatchYml } from './provider.mjs'

const PORT = Number(process.argv[2] || process.env.TESTKIT_SETUP_PORT || 8893)

/**
 * 保存端点后立刻重写 profile 的 patch 层。
 *
 * 为什么不「下次建 profile 才生效」：使用者会以为存了就生效，
 * 然后跑冒烟仍然连旧端点 —— 那种「界面说成功了但行为没变」最难查。
 */
async function regenerateProfilePatch() {
  try {
    const p = resolveProvider()
    const patchPath = path.posix.join(PATHS.dshHome, 'profiles', PROFILE, 'cordis.patch.yml')
    if (!fs.existsSync(patchPath)) {
      return { ok: false, error: 'profile 尚未创建（先跑 POST /api/setup/profile）' }
    }
    const src = fs.readFileSync(patchPath, 'utf8')
    // 只替换「provider 相关的两段」，保留 webserver 段与文件头注释
    const cut = src.indexOf('- id: agent-default-model')
    const head = cut >= 0 ? src.slice(0, cut) : src
    fs.writeFileSync(patchPath, head + buildProviderPatchYml(p), 'utf8')
    return { ok: true, path: patchPath, name: p.name, model: p.model }
  } catch (e) {
    return { ok: false, error: String(e && e.message || e).slice(0, 240) }
  }
}

/* ─────────────────────────── HTTP 工具 ─────────────────────────── */

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj, null, 2))
}

const readBody = (req) => new Promise((resolve) => {
  let buf = ''
  req.on('data', (c) => { buf += c; if (buf.length > 2_000_000) buf = buf.slice(0, 2_000_000) })
  req.on('end', () => { try { resolve(JSON.parse(buf || '{}')) } catch (_) { resolve({}) } })
  req.on('error', () => resolve({})) 
})

/* ─────────────────────────── 页面 ─────────────────────────── */

const HTML = String.raw`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Testkit · 环境向导</title>
<style>
  :root{
    --bg:#0b0d10; --panel:#12151a; --panel2:#171b22; --line:#242a33;
    --fg:#e6e9ef; --dim:#8b94a3; --dim2:#5f6875;
    --ok:#3fb950; --bad:#f85149; --warn:#d29922; --info:#58a6ff; --accent:#7c5cff;
  }
  @media (prefers-color-scheme: light){
    :root{ --bg:#f4f6f8; --panel:#fff; --panel2:#eef1f4; --line:#dde1e6;
           --fg:#1a1f26; --dim:#5a6572; --dim2:#8b949e; }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
       font:13.5px/1.6 ui-sans-serif,-apple-system,"Segoe UI","Noto Sans CJK SC",sans-serif}
  header{padding:14px 22px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:14px}
  h1{font-size:15px;margin:0;font-weight:650}
  .spacer{flex:1}
  main{max-width:980px;margin:0 auto;padding:26px 22px 80px}
  .badge{padding:2px 10px;border-radius:99px;font-size:11px;font-weight:600;border:1px solid}
  .b-ok{color:var(--ok);border-color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,transparent)}
  .b-bad{color:var(--bad);border-color:var(--bad);background:color-mix(in srgb,var(--bad) 12%,transparent)}
  .b-idle{color:var(--dim);border-color:var(--line)}
  .step{background:var(--panel);border:1px solid var(--line);border-radius:10px;
        padding:14px 16px;margin-bottom:12px;position:relative}
  .step.ok{border-color:color-mix(in srgb,var(--ok) 45%,var(--line))}
  .step.bad{border-color:color-mix(in srgb,var(--bad) 40%,var(--line))}
  .step .hd{display:flex;align-items:center;gap:10px;margin-bottom:6px}
  .step .n{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;
           font-size:11px;font-weight:700;background:var(--panel2);border:1px solid var(--line);color:var(--dim)}
  .step.ok .n{background:color-mix(in srgb,var(--ok) 20%,transparent);border-color:var(--ok);color:var(--ok)}
  .step.bad .n{background:color-mix(in srgb,var(--bad) 18%,transparent);border-color:var(--bad);color:var(--bad)}
  .step .t{font-weight:600;font-size:13.5px}
  .step .d{color:var(--dim);font-size:12.5px;margin:3px 0 0 32px;word-break:break-word}
  .step .act{margin:10px 0 0 32px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  /* 端点表单 */
  .form{margin:12px 0 0 32px;display:grid;grid-template-columns:1fr 1fr;gap:10px 14px}
  .form label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dim)}
  .form label.chkline{flex-direction:row;align-items:center;gap:8px}
  .form input[type=text],.form input:not([type]),.form input[type=number],.form select{
    background:var(--panel2);border:1px solid var(--line);border-radius:6px;
    padding:6px 9px;color:var(--fg);font:inherit;font-size:12.5px;width:100%}
  .form input:focus,.form select:focus{outline:none;border-color:var(--accent)}
  .form .hint{font-style:normal;font-size:10.5px;color:var(--dim2)}
  @media (max-width:760px){ .form{grid-template-columns:1fr} }
  button{font:inherit;cursor:pointer;padding:6px 14px;border-radius:7px;font-size:12.5px;
         background:var(--panel2);border:1px solid var(--line);color:var(--fg)}
  button:hover{border-color:var(--accent)}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
  button:disabled{opacity:.45;cursor:not-allowed}
  code,pre{font-family:ui-monospace,"Cascadia Code",Consolas,monospace;font-size:11.5px}
  pre{background:var(--panel2);border:1px solid var(--line);border-radius:7px;
      padding:10px 12px;overflow:auto;max-height:340px;margin:10px 0 0 32px;white-space:pre-wrap}
  .cp{background:var(--panel2);border:1px solid var(--line);border-radius:6px;
      padding:5px 9px;display:inline-flex;gap:8px;align-items:center;max-width:100%}
  .cp code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cp button{padding:2px 8px;font-size:11px}
  .note{color:var(--dim2);font-size:11.5px;margin-left:32px;margin-top:8px}
  .kbd{font-family:ui-monospace,monospace;font-size:11px;padding:1px 5px;border-radius:4px;
       background:var(--panel2);border:1px solid var(--line)}
  table{width:100%;border-collapse:collapse;font-size:12px;margin-top:10px}
  th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line)}
  th{font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim2)}
  .warn{color:var(--warn)}
  .ok{color:var(--ok)}
  .bad{color:var(--bad)}
  .mono{font-family:ui-monospace,monospace}
  .toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%) translateY(14px);
         background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:9px 16px;
         opacity:0;transition:.2s;pointer-events:none;box-shadow:0 8px 24px rgba(0,0,0,.28);font-size:12.5px}
  .toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
</style>
</head>
<body>
<header>
  <h1>Testkit 环境向导</h1>
  <span id="topBadge" class="badge b-idle">检测中</span>
  <span class="spacer"></span>
  <span class="mono" style="color:var(--dim2);font-size:11px" id="where"></span>
</header>
<main>
  <div id="steps"></div>
  <div id="provider"></div>
  <section style="margin-top:26px">
    <h2 style="font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--dim)">当前探测到的 DSH 安装</h2>
    <div id="cands"></div>
  </section>
  <section style="margin-top:22px">
    <h2 style="font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--dim)">给 Agent 的接口</h2>
    <div class="note" style="margin-left:0">
      同一套逻辑的机器可读形态。<code>nextAction.needsUserClick=true</code> 表示这一步必须人点确认。
    </div>
    <pre style="margin-left:0" id="api"></pre>
  </section>
</main>
<div class="toast" id="toast"></div>
<script>
const $ = (id) => document.getElementById(id)
const esc = (s) => String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
let BUSY = null
// 用户改了端点表单但还没保存时，轮询刷新**不能**覆盖他正在输入的内容
let FORM_DIRTY = false
let LOGS = {}

function toast(msg, kind){
  const t = $('toast'); t.textContent = msg
  t.style.borderColor = kind==='bad' ? 'var(--bad)' : kind==='ok' ? 'var(--ok)' : 'var(--line)'
  t.classList.add('show'); clearTimeout(t._t)
  t._t = setTimeout(()=>t.classList.remove('show'), 2600)
}

function cpBlock(cmd){
  const id = 'cp'+Math.random().toString(36).slice(2,8)
  setTimeout(()=>{ const b=$(id); if(b) b.onclick = () => {
    navigator.clipboard.writeText(cmd).then(()=>toast('已复制','ok'), ()=>toast('复制失败，请手动选中','bad'))
  }},0)
  return '<span class="cp"><code>'+esc(cmd)+'</code><button id="'+id+'">复制</button></span>'
}

function stepHtml(s, i){
  const cls = s.ok ? 'ok' : (s.lastRun ? 'bad' : '')
  let h = '<div class="step '+cls+'">'
  h += '<div class="hd"><span class="n">'+(s.ok?'✓':(i+1))+'</span><span class="t">'+esc(s.title)+'</span>'
  if (s.auto === false) h += '<span class="badge b-idle" style="font-size:10px">需人工</span>'
  h += '</div>'
  h += '<div class="d">'+esc(s.detail)+'</div>'

  if (!s.ok) {
    const na = s.nextAction || {}
    if (na.kind === 'elevate') {
      h += '<div class="act">'
      h += '<button class="primary" onclick="elevate()" '+(BUSY?'disabled':'')+'>提权授予（弹 UAC）</button>'
      h += '</div><div class="note">或复制命令到管理员 PowerShell 手动执行：<br>'+cpBlock(na.command||'')+'</div>'
    } else if (s.id === 'profile') {
      h += '<div class="act">'
      h += '<button class="primary" onclick="mkProfile()" '+(BUSY?'disabled':'')+'>创建 profile</button>'
      h += '<button onclick="pnpmInstall()" '+(BUSY?'disabled':'')+'>跑 pnpm install</button>'
      h += '</div><div class="note">会在 <code>'+esc('__DSHHOME__')+'</code> 下建 <code>profiles/'+esc('__PROFILE__')+'</code>，不改产品代码。</div>'
    } else if (s.id === 'smoke') {
      h += '<div class="act"><button class="primary" onclick="runSmoke()" '+(BUSY?'disabled':'')+'>跑一次冒烟</button></div>'
      h += '<div class="note">起一次 headless 会话问模型「回一个词」，验证 入口 → profile → 凭证 → 模型 整条链。</div>'
    } else if (na.kind === 'install-dsh' || na.kind === 'upgrade-dsh') {
      h += '<div class="act">'+cpBlock(na.command||'npm i -g @deepseek-ai/dsh@latest')+'</div>'
    } else if (na.kind === 'set-plugin') {
      h += '<div class="note warn">'+esc(na.hint||'')+'</div>'
      h += '<div class="act">'+cpBlock('set TESTKIT_REPO=<插件源码目录>')+'</div>'
    }
  }

  if (LOGS[s.id]) {
    h += '<pre>'+esc(LOGS[s.id])+'</pre>'
  }
  h += '</div>'
  return h
}

function render(d){
  $('topBadge').className = 'badge ' + (d.ok ? 'b-ok' : 'b-bad')
  $('topBadge').textContent = d.ok ? '就绪' : '未就绪'
  // ★ env 的形状是 {dsh, plugin, platform, sandbox, profile}，仓库在 plugin.repo 下
  //   （写成 env.repo 会渲染成 undefined —— 实测踩过）
  $('where').textContent = (d.env.profile && d.env.profile.name ? d.env.profile.name : '?')
    + ' · ' + (d.env.plugin && d.env.plugin.repo ? d.env.plugin.repo : '?')
  $('steps').innerHTML = d.steps.map(stepHtml).join('')
  if (d.provider) renderProvider(d.provider)

  const cs = d.env.dsh.candidates || []
  if (!cs.length) $('cands').innerHTML = '<div class="note">未找到任何 DSH 安装</div>'
  else $('cands').innerHTML = '<table><thead><tr><th style="width:120px">版本</th>'+
    '<th style="width:110px">来源</th><th style="width:90px">形态</th><th>入口</th></tr></thead><tbody>'+
    cs.map(c=>'<tr><td class="mono '+(c.meetsRequirement?'ok':'bad')+'">'+esc(c.version||'?')+'</td>'+
      '<td class="mono" style="color:var(--dim)">'+esc(c.source)+'</td>'+
      '<td class="mono" style="color:var(--dim)">'+esc(c.kind)+'</td>'+
      '<td class="mono" style="font-size:11px;color:var(--dim2)">'+esc(c.bin)+'</td></tr>').join('')+
    '</tbody></table>'

  $('api').textContent = [
    'GET  /api/setup/detect        探测环境（完整形状 + nextAction）',
    'GET  /api/setup/requirements  门槛常量',
    'GET  /api/setup/state         四步 + 端点配置（本页数据源）',
    'POST /api/setup/profile       建 profile   {"install":true} 同时跑 pnpm install',
    'POST /api/setup/elevate       触发提权（仅 win32；needsUserClick）',
    'POST /api/setup/smoke         跑一次冒烟',
    'GET  /api/setup/logs?id=X     看某步日志',
    'GET  /api/setup/provider      当前端点配置（**不含密钥**）',
    'POST /api/setup/provider      保存端点配置 {"provider":{…}}',
    'GET  /api/exp/list            列出可用实验',
    'POST /api/exp/validate        只校验实验配置，不跑',
    'POST /api/exp/run             跑实验 {"name":"…"}',
    'GET  /api/exp/run/{id}        轮询进度与结果',
    'POST /api/exp/run/{id}/cancel 中止',
    'GET  /api/exp/runs            历史列表',
    '',
    '门槛：DSH ≥ ' + (d.env.requirements.dsh.min) + ' / 插件 ≥ ' + (d.env.requirements.plugin.min),
  ].join('\n')
}

/* ─────────────── 端点配置（脱敏 + 可填） ───────────────
 *
 * ⚠️ 本段全部用**字符串拼接**，不用反引号模板。
 *    原因：整个页面是一段 String.raw 模板字符串，里面再出现反引号会把
 *    外层模板提前截断 ⇒ 文件语法错误。这个坑踩过两次（PITFALLS #26）。
 */
const SRC_LABEL = { env: '环境变量', file: '私有配置', default: '默认值' }

function provTag(src, k) {
  const s = src[k] || 'default'
  return '<span class="pill" title="取值来源">' + (SRC_LABEL[s] || s) + '</span>'
}

function provField(label, name, value, hint, tagHtml, type) {
  return '<label>' + label + ' ' + (tagHtml || '')
    + '<input name="' + name + '"' + (type ? ' type="' + type + '"' : '')
    + ' value="' + esc(value == null ? '' : value) + '"'
    + (hint ? '' : '') + '>'
    + (hint ? '<em class="hint">' + esc(hint) + '</em>' : '')
    + '</label>'
}

function renderProvider(p) {
  const el = $('provider')
  if (!el) return
  // 用户正在改表单时不能被轮询覆盖（否则打字打到一半内容被冲掉）
  if (FORM_DIRTY) return

  const prov = p.provider || {}
  const src = p.sources || {}
  const errs = p.errors || []
  const warns = p.warnings || []

  let h = '<div class="step ' + (p.ok ? 'ok' : 'bad') + '">'
  h += '<div class="hd"><span class="n">' + (p.ok ? '✓' : '!') + '</span>'
  h += '<span class="t">模型端点</span>'
  h += '<span class="badge ' + (p.keyPresent ? 'b-ok' : 'b-idle') + '" style="font-size:10px">'
    + (p.keyPresent ? '密钥已设' : '密钥未设') + '</span></div>'
  h += '<div class="d">任何 OpenAI 兼容端点都能用（官方 / 自建 / 中转）。'
    + '这里填的内容只写进本机的 <code>testkit.config.json</code>（已 gitignore，不进仓库）。</div>'

  h += '<div class="form">'

  // 端点标识
  h += provField('端点标识', 'name', prov.name, '写进 profile 的 provider 键名', provTag(src, 'name'))
  // 协议
  h += '<label>协议 ' + provTag(src, 'api')
    + '<select name="api">'
    + (p.knownApis || []).map(function (a) {
      return '<option value="' + esc(a) + '"' + (prov.api === a ? ' selected' : '') + '>' + esc(a) + '</option>'
    }).join('')
    + '</select>'
    + '<em class="hint">openai-chat 最常见；中转站按对方说明选</em>'
    + '</label>'
  // Base URL
  h += provField('Base URL', 'baseURL', prov.baseURL, '填「根」，不要带 /chat/completions；留空 = 官方默认', provTag(src, 'baseURL'))
  // 模型
  h += provField('模型 id', 'model', prov.model, '', provTag(src, 'model'))
  // apiKeyEnv
  h += provField('密钥所在环境变量', 'apiKeyEnv', prov.apiKeyEnv, '只填变量名；key 本身不要写在这里', provTag(src, 'apiKeyEnv'))
  // 推理强度
  h += '<label>推理强度 ' + provTag(src, 'reasoningEffort')
    + '<select name="reasoningEffort">'
    + ['', 'medium', 'high', 'max'].map(function (x) {
      return '<option value="' + x + '"' + ((prov.reasoningEffort || '') === x ? ' selected' : '') + '>'
        + (x || '（不设）') + '</option>'
    }).join('')
    + '</select></label>'
  // 数值
  h += provField('上下文窗口', 'contextWindow', prov.contextWindow, '', provTag(src, 'contextWindow'), 'number')
  h += provField('最大输出 token', 'maxTokens', prov.maxTokens, '', provTag(src, 'maxTokens'), 'number')
  // vision
  h += '<label class="chkline"><input name="vision" type="checkbox"'
    + (prov.vision ? ' checked' : '') + '> 支持图片输入 ' + provTag(src, 'vision') + '</label>'

  h += '</div>'

  if (errs.length) {
    h += '<div class="note bad">' + errs.map(function (e) { return esc(e.msg) }).join('<br>') + '</div>'
  }
  if (warns.length) {
    h += '<div class="note warn">' + warns.map(function (w) { return '· ' + esc(w.msg) }).join('<br>') + '</div>'
  }

  h += '<div class="act">'
  h += '<button class="primary" onclick="saveProvider()"' + (BUSY ? ' disabled' : '') + '>保存端点</button>'
  h += '<button onclick="resetProviderForm()">还原</button>'
  h += '<span class="note" style="margin:0 0 0 4px">'
    + (p.configExists ? '已使用 testkit.config.json' : '尚未创建 testkit.config.json（用默认值）')
    + '</span>'
  h += '</div></div>'

  el.innerHTML = h
  el.querySelectorAll('input,select').forEach(function (x) {
    x.addEventListener('input', function () { FORM_DIRTY = true })
    x.addEventListener('change', function () { FORM_DIRTY = true })
  })
}

function readProviderForm() {
  const el = $('provider')
  const val = function (n) {
    const x = el.querySelector('[name="' + n + '"]')
    return x ? x.value : ''
  }
  const chk = function (n) {
    const x = el.querySelector('[name="' + n + '"]')
    return !!(x && x.checked)
  }
  return {
    name: val('name').trim(),
    api: val('api'),
    baseURL: val('baseURL').trim(),
    apiKeyEnv: val('apiKeyEnv').trim(),
    model: val('model').trim(),
    displayName: val('model').trim(),
    reasoningEffort: val('reasoningEffort'),
    contextWindow: Number(val('contextWindow')) || 0,
    maxTokens: Number(val('maxTokens')) || 0,
    vision: chk('vision'),
  }
}

async function saveProvider() {
  const provider = readProviderForm()
  BUSY = 'provider'
  try {
    const r = await fetch('/api/setup/provider', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: provider }),
    })
    const d = await r.json()
    FORM_DIRTY = false
    if (d.ok) {
      const pt = d.patch || {}
      toast(pt.ok ? '端点已保存并写入 profile' : '端点已保存，但 profile 未更新：' + (pt.error || ''), pt.ok ? 'ok' : 'warn')
    } else {
      toast('保存被拒：' + (d.errors || []).map(function (e) { return e.msg }).join('；'), 'bad')
    }
  } catch (e) {
    toast('保存失败：' + e.message, 'bad')
  } finally {
    BUSY = null
    await refresh()
  }
}

function resetProviderForm() { FORM_DIRTY = false; refresh() }

async function refresh(){
  try { render(await (await fetch('/api/setup/state')).json()) } catch(e){}
}

async function post(url, body){
  BUSY = url; await refresh()
  try {
    const r = await fetch(url, { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify(body||{}) })
    return await r.json()
  } finally { BUSY = null; await refresh() }
}

async function elevate(){
  const d = await post('/api/setup/elevate')
  if (d.needsUserClick) toast('已弹出 UAC，请在系统对话框点「是」', 'ok')
  else toast(d.ok ? '提权完成' : '提权未完成：' + (d.detail||''), d.ok?'ok':'bad')
}
async function mkProfile(){
  const d = await post('/api/setup/profile', { install:false })
  if (d.log) LOGS.profile = d.log
  toast(d.ok ? 'profile 已建' : 'profile 创建失败', d.ok?'ok':'bad'); await refresh()
}
async function pnpmInstall(){
  toast('pnpm install 中（可能要一两分钟）…')
  const d = await post('/api/setup/profile', { install:true })
  if (d.log) LOGS.profile = d.log
  toast(d.ok ? 'pnpm install 完成' : 'pnpm install 失败', d.ok?'ok':'bad'); await refresh()
}
async function runSmoke(){
  toast('冒烟中（一次真实会话，约 10–60s）…')
  const d = await post('/api/setup/smoke')
  toast(d.ok ? '冒烟通过' : '冒烟失败：' + (d.error||''), d.ok?'ok':'bad')
}

refresh(); setInterval(refresh, 4000)
</script>
</body>
</html>`

/* ─────────────────────────── 路由 ─────────────────────────── */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  const p = url.pathname

  // loopback only
  const ip = req.socket.remoteAddress || ''
  if (!/^(127\.|::1|::ffff:127\.)/.test(ip)) return json(res, 403, { error: 'loopback only' })

  try {
    if (p === '/' || p === '/index.html') {
      const html = HTML
        .replace("'__DSHHOME__'", JSON.stringify(PATHS.dshHome))
        .replace("'__PROFILE__'", JSON.stringify(PROFILE))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(html)
    }
    if (p === '/favicon.ico') { res.writeHead(204); return res.end() }

    // ── Agent 接口 ──
    if (p === '/api/setup/detect') return json(res, 200, detectEnv({ refresh: url.searchParams.has('refresh') }))

    if (p === '/api/setup/requirements') {
      return json(res, 200, {
        ...REQUIREMENTS,
        platform: process.platform,
        nextAction: { kind: 'ready' },
      })
    }

    if (p === '/api/setup/state') {
      // state 顺带带上端点配置，前端一次请求就能渲染完整页面
      return json(res, 200, { ...getState(), provider: providerState() })
    }

    // ── 端点配置（脱敏：只回传变量名与「是否已设」，绝不回传 key）──
    if (p === '/api/setup/provider' && req.method === 'GET') return json(res, 200, providerState())

    if (p === '/api/setup/provider' && req.method === 'POST') {
      const body = await readBody(req)
      const prov = body.provider || body
      const check = validateProvider(prov)
      if (!check.ok) {
        return json(res, 400, {
          ok: false, errors: check.errors, warnings: check.warnings,
          nextAction: { kind: 'fix-provider', hint: check.errors.map(e => e.field + ': ' + e.msg).join('；') },
        })
      }
      try {
        saveProvider(prov)
        // 保存后**立刻重生成 patch 层**，否则使用者会以为「存了就生效」
        const patched = await regenerateProfilePatch()
        const st = providerState()
        return json(res, 200, {
          ok: true, provider: st,
          patch: patched,
          nextAction: patched.ok
            ? { kind: 'run-smoke', api: 'POST /api/setup/smoke', hint: '端点已写入 profile，建议跑一次冒烟验证连通' }
            : { kind: 'init-profile', api: 'POST /api/setup/profile', hint: patched.error },
        })
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e && e.message || e).slice(0, 300) })
      }
    }

    // ── 实验层 ──
    if (p === '/api/exp/list') {
      const items = listExperiments()
      return json(res, 200, {
        experiments: items, dir: EXPERIMENTS_DIR,
        nextAction: items.length ? { kind: 'validate', api: 'POST /api/exp/validate' }
          : { kind: 'create-experiment', hint: 'experiments/ 下没有配置，参考 percept-sentence-table.mjs' },
      })
    }

    if (p === '/api/exp/validate' && req.method === 'POST') {
      const body = await readBody(req)
      const loaded = await loadExperiment(body.name || body.file || '')
      if (!loaded.ok) {
        return json(res, 404, { ok: false, error: loaded.error, nextAction: { kind: 'fix-experiment' } })
      }
      const v = validateExperiment(loaded.config)
      return json(res, v.ok ? 200 : 400, {
        ok: v.ok, errors: v.errors, warnings: v.warnings, matrix: v.matrix,
        layers: v.registry && v.registry.ok ? {
          total: Object.keys(v.registry.layers).length,
          slim: v.registry.byPath.slim,
          dynamic: v.registry.byPath.dynamic,
          static: v.registry.byPath.static,
          dead: Object.entries(v.registry.layers).filter(([, x]) => x.dead).map(([k]) => k),
        } : null,
        nextAction: v.ok ? { kind: 'run', api: 'POST /api/exp/run' }
          : { kind: 'fix-experiment', hint: v.errors.map(e => e.code).join(', ') },
      })
    }

    if (p === '/api/exp/run' && req.method === 'POST') {
      const body = await readBody(req)
      const loaded = await loadExperiment(body.name || body.file || '')
      if (!loaded.ok) {
        return json(res, 404, { ok: false, error: loaded.error })
      }
      const cfg = { ...loaded.config }
      if (body.reps) cfg.reps = Number(body.reps)
      if (body.concurrency) cfg.concurrency = Number(body.concurrency)
      const v = validateExperiment(cfg)
      if (!v.ok) {
        // ★ 校验不过就**不跑**。跑起来只会得到空转结果，还烧额度。
        return json(res, 400, {
          ok: false, errors: v.errors, warnings: v.warnings,
          nextAction: { kind: 'fix-experiment', hint: '这些错误会让实验空转，必须先修' },
        })
      }
      // 异步跑：立刻返回 runId，进度靠轮询
      const pRun = runExperiment({ config: cfg })
      pRun.then(() => {}).catch(() => {})
      // 等一小会儿让 runId 落盘
      await new Promise(r => setTimeout(r, 120))
      const recent = listRuns()[0]
      return json(res, 202, {
        ok: true, runId: recent && recent.runId,
        nextAction: { kind: 'poll', api: 'GET /api/exp/run/' + (recent && recent.runId) },
      })
    }

    if (p.startsWith('/api/exp/run/') && p.endsWith('/cancel') && req.method === 'POST') {
      const id = p.slice('/api/exp/run/'.length, -'/cancel'.length)
      const st = readRun(id)
      if (!st) return json(res, 404, { ok: false, error: '没有这个 runId' })
      // 取消用「写标记文件」实现：执行器在每个任务前检查它
      const flag = path.posix.join(WORK, 'experiments', '.' + id + '.cancel')
      try { fs.writeFileSync(flag, '1', 'utf8') } catch (_) {}
      return json(res, 200, {
        ok: true, note: '已置取消标记；当前正在跑的那一条会跑完',
        nextAction: { kind: 'poll', api: 'GET /api/exp/run/' + id },
      })
    }

    if (p.startsWith('/api/exp/run/') && req.method === 'GET') {
      const id = p.slice('/api/exp/run/'.length)
      const st = readRun(id)
      if (!st) return json(res, 404, { ok: false, error: '没有这个 runId' })
      return json(res, 200, st)
    }

    if (p === '/api/exp/runs') return json(res, 200, { runs: listRuns() })

    // ── Agent 接口 ──
    if (p === '/api/setup/logs') {
      const id = url.searchParams.get('id') || ''
      try {
        const st = JSON.parse(fs.readFileSync(path.posix.join(WORK, '.setup-state.json'), 'utf8'))
        return json(res, 200, { id, at: st[id] && st[id].at, log: (st[id] && st[id].log) || '' })
      } catch (_) { return json(res, 200, { id, log: '' }) }
    }

    if (p === '/api/setup/elevate' && req.method === 'POST') {
      if (process.platform !== 'win32') {
        return json(res, 200, {
          ok: true, elevated: false, needsUserClick: false,
          detail: '非 Windows：POSIX 权限模型，无需 ACL 编辑',
          nextAction: { kind: 'ready' },
        })
      }
      // ★ 提权必须人点 UAC —— Agent 替不了。这里只起进程，如实回报 needsUserClick。
      const script = path.posix.join(path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))), 'setup/elevate.ps1')
      if (!fs.existsSync(script)) return json(res, 500, { ok: false, detail: '缺 ' + script })
      try {
        const { spawn } = await import('node:child_process')
        spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
          detached: true, stdio: 'ignore', windowsHide: false,
        }).unref()
        const env = detectEnv()
        return json(res, 202, {
          ok: !!env.platform.aclOk,
          elevated: !!env.platform.aclOk,
          needsUserClick: true,
          detail: '已发起提权进程；请在 UAC 对话框点「是」。完成后重新 GET /api/setup/state 确认。',
          nextAction: env.platform.aclOk ? { kind: 'ready' } : {
            kind: 'elevate', command: 'powershell -ExecutionPolicy Bypass -File setup/elevate.ps1',
            needsUserClick: true,
          },
        })
      } catch (e) {
        return json(res, 500, { ok: false, detail: String(e.message).slice(0, 300) })
      }
    }

    if (p === '/api/setup/profile' && req.method === 'POST') {
      const body = await readBody(req)
      const built = await buildProfile({ force: !!body.force })
      if (!built.ok) {
        return json(res, 500, {
          ok: false, phase: 'build', log: built.log, error: built.error || 'init-profile 退出码 ' + built.code,
          nextAction: { kind: 'init-profile', api: 'POST /api/setup/profile' },
        })
      }
      if (!body.install) {
        return json(res, 200, {
          ok: true, phase: 'build', log: built.log,
          nextAction: { kind: 'install-deps', hint: '请在 profile 目录跑 pnpm install，或 POST {"install":true}' },
        })
      }
      const inst = await installProfile()
      return json(res, inst.ok ? 200 : 500, {
        ok: inst.ok, phase: 'install', log: (built.log || '') + '\n' + (inst.log || ''),
        error: inst.error,
        nextAction: inst.ok ? { kind: 'run-smoke', api: 'POST /api/setup/smoke' }
          : { kind: 'install-deps', command: 'cd ' + path.posix.join(PATHS.dshHome, 'profiles', PROFILE) + ' && pnpm install' },
      })
    }

    if (p === '/api/setup/smoke' && req.method === 'POST') {
      const r = await smoke()
      const st = getState()
      return json(res, r.ok ? 200 : 500, {
        ...r,
        state: st.steps.map(s => ({ id: s.id, ok: s.ok })),
        nextAction: r.ok ? { kind: 'ready', monitor: 'http://127.0.0.1:8899' }
          : { kind: 'run-smoke', api: 'POST /api/setup/smoke', hint: r.error },
      })
    }

    return json(res, 404, { error: 'not found', api: 'GET /api/setup/state' })
  } catch (e) {
    return json(res, 500, { error: String(e && e.message || e).slice(0, 400) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('Setup 向导: http://127.0.0.1:' + PORT)
  console.log('  工作目录 ' + WORK)
  console.log('  被测仓库 ' + REPO)
  const env = detectEnv()
  console.log('  ' + summarize(env).split('\n').slice(0, 3).join('\n  '))
  console.log('  Agent 接口 GET /api/setup/state · GET /api/setup/detect')
})
