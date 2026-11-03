/**
 * 模型端点配置 —— **不内置任何中转站**。
 *
 * ═══ 为什么要单独一层 ═══
 * 之前 provider / baseURL / apiKeyEnv / model 全部写死在 `setup/init-profile.mjs`
 * 的 `cordis.patch.yml` 模板里，等于：
 *   ① 使用者必须改源码才能用自己的端点（违反「不改代码就能用」）
 *   ② 那份模板里带着某一家的中转站域名与私有 provider 名 ——
 *      一旦开源就是把别人的内部设施写进公共仓库
 *
 * ═══ 三层取值（后者覆盖前者）═══
 *   ① 中性默认值（本文件 DEFAULT_PROVIDER）：任何 OpenAI 兼容端点都能用
 *   ② 配置文件 `testkit.config.json`（**已 gitignore**，放本机私有信息）
 *   ③ 环境变量 TESTKIT_PROVIDER_*（适合 CI / 临时覆盖）
 *
 * ═══ 支持的协议 ═══
 *   · openai-chat        /v1/chat/completions（最常见）
 *   · openai-responses   /v1/responses
 *   · anthropic          Anthropic Messages API
 * 其余按 DSH 的 `llm-pi-ai` 插件约定透传（`api` 字段原样写进 patch）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { KIT_ROOT } from './config.mjs'

export const CONFIG_FILE = path.posix.join(KIT_ROOT, 'testkit.config.json')
export const CONFIG_EXAMPLE = path.posix.join(KIT_ROOT, 'testkit.config.example.json')

/**
 * 中性默认值。
 *
 * ★ 刻意不写任何具体厂商的域名 —— 默认值必须能在「任何人 clone 下来」的情况下
 *   至少**跑得起来且指向官方端点**，而不是指向某一个第三方中转。
 *   用户想用中转就自己填；填了会覆盖这里。
 */
export const DEFAULT_PROVIDER = Object.freeze({
  // provider 标识：写进 patch 的 providers 键名，也是 agent-default-model.provider
  name: 'main',
  // 协议：openai-chat / openai-responses / anthropic
  api: 'openai-chat',
  // 端点根（不含 /chat/completions）。留空 = 由 DSH 按协议选官方默认
  baseURL: '',
  // 从这个环境变量读 API key（不把 key 本身写进任何文件）
  apiKeyEnv: 'DSH_MODEL_API_KEY',
  // 模型 id（透传给端点）
  model: 'deepseek-chat',
  // 展示名（面板里显示）
  displayName: 'deepseek-chat',
  reasoningEffort: 'medium',
  contextWindow: 128000,
  maxTokens: 8192,
  // 是否支持图片输入
  vision: false,
})

const VALID_APIS = ['openai-chat', 'openai-responses', 'anthropic']

/** 读配置文件（不存在返回空对象） */
export function readConfigFile() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch (_) { return {} }
}

function fromEnv() {
  const g = (k) => process.env['TESTKIT_PROVIDER_' + k]
  const out = {}
  if (g('NAME')) out.name = g('NAME')
  if (g('API')) out.api = g('API')
  if (g('BASE_URL')) out.baseURL = g('BASE_URL')
  if (g('API_KEY_ENV')) out.apiKeyEnv = g('API_KEY_ENV')
  if (g('MODEL')) out.model = g('MODEL')
  if (g('DISPLAY_NAME')) out.displayName = g('DISPLAY_NAME')
  if (g('REASONING_EFFORT')) out.reasoningEffort = g('REASONING_EFFORT')
  if (g('CONTEXT_WINDOW')) out.contextWindow = Number(g('CONTEXT_WINDOW'))
  if (g('MAX_TOKENS')) out.maxTokens = Number(g('MAX_TOKENS'))
  if (g('VISION')) out.vision = /^(1|true|yes)$/i.test(g('VISION'))
  return out
}

/**
 * 解析出最终要用的 provider 配置。
 * @returns {{...DEFAULT_PROVIDER, sources: object, warnings: string[]}}
 */
export function resolveProvider() {
  const file = readConfigFile()
  const fileProv = (file && file.provider) || {}
  const envProv = fromEnv()

  const merged = { ...DEFAULT_PROVIDER }
  const sources = {}
  for (const k of Object.keys(DEFAULT_PROVIDER)) {
    if (envProv[k] !== undefined && envProv[k] !== '') { merged[k] = envProv[k]; sources[k] = 'env' }
    else if (fileProv[k] !== undefined && fileProv[k] !== '') { merged[k] = fileProv[k]; sources[k] = 'file' }
    else sources[k] = 'default'
  }

  const warnings = []
  if (!VALID_APIS.includes(merged.api)) {
    warnings.push(`api="${merged.api}" 不在已知协议 [${VALID_APIS.join(', ')}] 里，将原样透传（可能不被插件支持）`)
  }
  if (!merged.baseURL) {
    warnings.push('baseURL 为空 —— 将使用 DSH 对 ' + merged.api + ' 的官方默认端点')
  }
  if (!merged.model) warnings.push('model 为空，跑不起来')
  if (!merged.apiKeyEnv) warnings.push('apiKeyEnv 为空 —— 需要显式把 key 写进凭证或直接配到插件')

  return { ...merged, sources, warnings }
}

/**
 * 生成 cordis.patch.yml 里的 `agent-default-model` + `llm-pi-ai` 两段。
 *
 * ⚠️ `llm-pi-ai` 的 providers 是**整块替换**（patch 不合并），所以必须完整重述。
 *    这一点是实测的：只写要改的字段会让其余字段丢失。
 */
export function buildProviderPatchYml(p) {
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'"
  const lines = []

  lines.push('- id: agent-default-model')
  lines.push("  name: '@deepseek-ai/dsh-agent-default-model'")
  lines.push('  config:')
  lines.push('    provider: ' + q(p.name))
  lines.push('    model: ' + q(p.model))
  if (p.reasoningEffort) lines.push('    reasoningEffort: ' + q(p.reasoningEffort))
  lines.push('')
  lines.push('- id: llm-pi-ai')
  lines.push("  name: '@deepseek-ai/dsh-llm-pi-ai'")
  lines.push('  config:')
  lines.push('    providers:')
  lines.push('      ' + p.name + ':')
  if (p.apiKeyEnv) lines.push('        apiKeyEnv: ' + q(p.apiKeyEnv))
  lines.push('        api: ' + q(p.api))
  if (p.baseURL) lines.push('        baseURL: ' + q(p.baseURL))
  lines.push('        streamIdleTimeoutMs: 90000')
  lines.push('        retryPolicy:')
  lines.push('          mode: normal')
  lines.push('          maxRetries: 3')
  lines.push('          retryableCodes:')
  for (const c of ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']) {
    lines.push('            - ' + c)
  }
  lines.push('          backoff:')
  lines.push('            initialDelayMs: 500')
  lines.push('            maxDelayMs: 4000')
  lines.push('        models:')
  lines.push('          - id: ' + q(p.model))
  lines.push('            name: ' + q(p.displayName || p.model))
  lines.push('            contextWindow: ' + Number(p.contextWindow || 128000))
  lines.push('            maxTokens: ' + Number(p.maxTokens || 8192))
  lines.push('            input:')
  lines.push('              - text')
  if (p.vision) lines.push('              - image')
  if (p.reasoningEffort) {
    lines.push('            reasoningEfforts:')
    lines.push('              medium: medium')
    lines.push('              high: high')
    lines.push('              max: max')
  }
  return lines.join('\n') + '\n'
}

/**
 * 校验一份 provider 配置（供前端表单与 CLI 共用）。
 * @returns {{ok:boolean, errors:Array<{field,msg}>, warnings:string[]}}
 */
export function validateProvider(p) {
  const errors = []
  const warnings = []

  if (!p.name || !/^[A-Za-z0-9_-]+$/.test(p.name)) {
    errors.push({ field: 'name', msg: 'provider 名只能含字母/数字/下划线/连字符' })
  }
  if (!VALID_APIS.includes(p.api)) {
    errors.push({ field: 'api', msg: '协议必须是 ' + VALID_APIS.join(' / ') + ' 之一' })
  }
  if (!p.model) errors.push({ field: 'model', msg: '模型 id 必填' })
  if (p.apiKeyEnv && !/^[A-Z][A-Z0-9_]*$/.test(p.apiKeyEnv)) {
    errors.push({ field: 'apiKeyEnv', msg: '环境变量名建议全大写（如 MY_API_KEY）' })
  }
  if (!p.apiKeyEnv) {
    warnings.push({ field: 'apiKeyEnv', msg: '没指定环境变量名 —— 需要在凭证文件里显式存 key' })
  }
  if (p.baseURL) {
    try {
      const u = new URL(p.baseURL)
      if (!/^https?:$/.test(u.protocol)) errors.push({ field: 'baseURL', msg: '必须是 http/https' })
      if (/\/chat\/completions$|\/responses$|\/messages$/.test(u.pathname)) {
        warnings.push({ field: 'baseURL', msg: '这里填「根」而不是完整路径，插件会自己拼 /chat/completions 等' })
      }
    } catch (_) {
      errors.push({ field: 'baseURL', msg: '不是合法 URL' })
    }
  }
  for (const k of ['contextWindow', 'maxTokens']) {
    const n = Number(p[k])
    if (!Number.isFinite(n) || n <= 0) errors.push({ field: k, msg: '必须是正整数' })
  }
  return { ok: errors.length === 0, errors, warnings }
}

/** 写配置文件（只写 provider 段，保留其它段） */
export function saveProvider(p) {
  const cur = readConfigFile()
  const next = { ...cur, provider: { ...p } }
  delete next.provider.sources
  delete next.provider.warnings
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

/** 给前端用：当前值 + 来源标注 + 校验结果（**不含任何密钥**） */
export function providerState() {
  const p = resolveProvider()
  const v = validateProvider(p)
  return {
    provider: {
      name: p.name, api: p.api, baseURL: p.baseURL, apiKeyEnv: p.apiKeyEnv,
      model: p.model, displayName: p.displayName, reasoningEffort: p.reasoningEffort,
      contextWindow: p.contextWindow, maxTokens: p.maxTokens, vision: p.vision,
    },
    sources: p.sources,
    // 只报「这个环境变量是否已设」，**绝不回传值**
    keyPresent: !!(p.apiKeyEnv && process.env[p.apiKeyEnv]),
    knownApis: VALID_APIS,
    ok: v.ok,
    errors: v.errors,
    warnings: [...p.warnings.map(w => ({ field: '', msg: w })), ...v.warnings],
    configFile: CONFIG_FILE,
    configExists: fs.existsSync(CONFIG_FILE),
  }
}
