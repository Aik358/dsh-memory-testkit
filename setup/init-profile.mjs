/**
 * 初始化实验 profile —— 把「手工踩过的坑」全部自动化。
 *
 * 用法：node setup/init-profile.mjs [--force]
 *
 * 三个坑（都不看代码发现不了，全部实测过）：
 *
 * ① 插件在 headless 下永远 pending
 *    原因：dsh-auto-memory 的 node 半声明 inject: ['webServer','tools','systemPrompt',
 *    'subagents','llm']，而 dsh-headless 不挂 Host/HTTP ⇒ webServer 服务不存在
 *    ⇒ 插件停在 `pending (waiting for service: webServer)` 永不激活。
 *    修法：patch 层补一行最小 webserver（回环 + 端口 0 = OS 分配，不占 3080）。
 *
 * ② memoryRoot 的 `~` 逃出 DSH_HOME
 *    默认值是字面 `~/.dsh/memory/workspaces`，插件用 os.homedir() 展开
 *    ⇒ **DSH_HOME 拦不住它**，会直接写进真实记忆库。
 *    修法：显式覆盖成沙箱绝对路径。
 *
 * ③ 沙箱 ACL
 *    见 setup/elevate.ps1。
 *
 * ★ 模型端点**不再写死在这里**。provider / baseURL / apiKeyEnv / model 全部来自
 *   `lib/provider.mjs`（配置文件 testkit.config.json 或 TESTKIT_PROVIDER_* 环境变量）。
 *   改动理由：写死等于「使用者必须改源码才能用自己的端点」，而且会把某一家的
 *   中转站域名带进公共仓库 —— 那既是使用障碍也是泄密。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PATHS, PROFILE, REPO, ensureDirs } from '../lib/config.mjs'
import { resolveProvider, buildProviderPatchYml, validateProvider } from '../lib/provider.mjs'

const force = process.argv.includes('--force')
ensureDirs()

const profileDir = path.join(PATHS.dshHome, 'profiles', PROFILE)
fs.mkdirSync(profileDir, { recursive: true })

// 先解析端点：配置不合法就别往下走（否则会写出一个连不通的 profile，
// 等到跑实验时才报认证/404，排查成本高得多）
const prov = resolveProvider()
const provCheck = validateProvider(prov)
if (!provCheck.ok) {
  console.error('✗ 模型端点配置不合法：')
  for (const e of provCheck.errors) console.error(`   · [${e.field}] ${e.msg}`)
  console.error('')
  console.error('  修法：复制 testkit.config.example.json 为 testkit.config.json 并填好，')
  console.error('        或用环境变量 TESTKIT_PROVIDER_NAME / _API / _BASE_URL / _MODEL 等覆盖。')
  process.exit(1)
}

// ── 1. package.json（最小 profile：base + headless + 本插件）──
const pkgPath = path.join(profileDir, 'package.json')
const pkg = {
  name: 'dsh-profile-' + PROFILE,
  private: true,
  dependencies: {
    '@a9i5k4/dsh-auto-memory': 'link:' + REPO.replace(/\\/g, '/'),
  },
  dsh: {
    profile: {
      bundles: [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-headless',
        '@a9i5k4/dsh-auto-memory',
      ],
    },
  },
}
if (!fs.existsSync(pkgPath) || force) {
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  console.log('✓ ' + pkgPath)
} else {
  console.log('· 已存在，跳过 ' + pkgPath)
}

// ── 2. pnpm-workspace.yaml（hoisted 布局，与官方 profile 一致）──
const wsPath = path.join(profileDir, 'pnpm-workspace.yaml')
if (!fs.existsSync(wsPath) || force) {
  fs.writeFileSync(wsPath, 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n', 'utf8')
  console.log('✓ ' + wsPath)
}

// ── 3. cordis.patch.yml（坑① + 模型端点）──
const patchPath = path.join(profileDir, 'cordis.patch.yml')
const patchHeader = `# 测试套件专用 profile 的 patch 层。
#
# ① 补最小 webserver —— 原因见下。
#    dsh-auto-memory 的 node 半声明了 inject: ['webServer','tools','systemPrompt','subagents','llm']，
#    而 headless 层不挂 Host/HTTP ⇒ webServer 服务不存在 ⇒ 插件停在
#    "pending (waiting for service: webServer)" 永不激活（工具一个都不会出现）。
#    这里补一行回环 + 端口 0（OS 分配，不占 3080、不对外开放）。
#
# ② 模型端点 —— 由 lib/provider.mjs 按下面三层取值生成（不写死任何一家中转）：
#      ① 中性默认（任何 OpenAI 兼容端点都能用）
#      ② testkit.config.json        本机私有，已 gitignore
#      ③ TESTKIT_PROVIDER_* 环境变量
#    本次实际取值：name=${prov.name} api=${prov.api} model=${prov.model}
#                 baseURL=${prov.baseURL || '(官方默认)'} apiKeyEnv=${prov.apiKeyEnv}
#
#    ⚠️ llm-pi-ai 的 providers 是**整块替换**（patch 不合并），所以下面必须完整重述。
- insert:
    - id: webserver
      name: '@deepseek-ai/dsh-host-webserver'
      config:
        host: '127.0.0.1'
        port: 0
        compression: none
        compressionLevel: 1
        compressionThresholdBytes: 1024

`

const patchYml = patchHeader + buildProviderPatchYml(prov)
if (!fs.existsSync(patchPath) || force) {
  fs.writeFileSync(patchPath, patchYml, 'utf8')
  console.log('✓ ' + patchPath)
} else {
  console.log('· 已存在，跳过 ' + patchPath)
}

// ── 4. 沙箱插件配置（坑②）──
const cfgPath = path.join(PATHS.dshHome, 'dsh-auto-memory.json')
if (!fs.existsSync(cfgPath) || force) {
  // 从真实配置继承「键集」，但把三处路径覆盖成沙箱绝对路径。
  // 为什么要继承键集：产品有 160+ 个配置键，缺键会走默认值，而默认值的
  // memoryRoot 就是那个会逃出 DSH_HOME 的 `~/.dsh/...`。
  let base = {}
  const realCfg = path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'dsh-auto-memory.json')
  try { base = JSON.parse(fs.readFileSync(realCfg, 'utf8')) } catch (_) {}

  const cfg = {
    ...base,
    // ★★ 三处路径必须显式覆盖成绝对路径
    memoryRoot: PATHS.memoryRoot,
    userMemoryDir: PATHS.userMemoryDir,
    projectMemoryDir: '.dsh-memory',
    // 砍掉外部记忆源与语义 worker：它们会引入无关变量与启动噪声
    externalSources: [],
    semanticEngineMode: 'lexical',
    pythonBackendEnabled: false,
    workspaceDiscoverMax: 0,
    // 注入保持开启（套件 A 会用 noinject 变体做对照）
    injectEnabled: true,
    promptLayerOverrides: {},
    // ★★ 注入节奏必须用**产品出厂默认**，不能图省事写 0。
    //
    // 踩过的坑（2026-11-03 实测）：这里原本写 snapshotMinGapRounds: 0，
    // 注释理由是「排除无关变量」，但 0 的语义是**每轮都发完整版** ⇒
    // 精简版（slim）分支永不触发 ⇒ DEFAULT_PROMPT_LAYERS 里的
    // snapshotSlimMaintain / snapshotSlimGuide / snapshotSlimNote /
    // snapshotSlimRecallHit / snapshotSlimRecallNote **这 5 层根本没被渲染**。
    //
    // 后果：任何想通过 promptLayerOverrides 调精简版措辞的实验，
    // 在 gap=0 下改了等于没改，而且**不会报错**（最坏的一类实验错误）。
    //
    // 实证（同一任务，4 step）：
    //   gap=0  → 覆盖标记没进上下文，完整版/精简版都只有完整版
    //   gap=20 → 覆盖标记进上下文，精简版出现
    //
    // 20 / 8 是产品 DEFAULT_SNAPSHOT_MIN_GAP_ROUNDS / DEFAULT_SLIM_EVERY_ROUNDS
    // 的当前值（见 lib/index.js:534,546）。要测「精简版层」就必须保留它们。
    snapshotMinGapRounds: 20,
    slimEveryRounds: 8,
    snapshotTieredInject: true,
  }
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8')
  console.log('✓ ' + cfgPath)
  console.log(`    memoryRoot    = ${cfg.memoryRoot}`)
  console.log(`    userMemoryDir = ${cfg.userMemoryDir}`)
} else {
  console.log('· 已存在，跳过 ' + cfgPath)
}

// ── 5. 凭证（复制到沙箱 home，供 dsh 读取 apiKeyEnv）──
const credDst = path.join(PATHS.dshHome, '.credentials.yaml')
if (!fs.existsSync(credDst)) {
  const credSrc = path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', '.credentials.yaml')
  try {
    fs.copyFileSync(credSrc, credDst)
    console.log('✓ 凭证已复制到沙箱 (' + credSrc + ')')
  } catch (e) {
    console.log('✗ 凭证复制失败：' + e.message)
    console.log('  请手动把 ~/.dsh/.credentials.yaml 复制到 ' + credDst)
  }
} else {
  console.log('· 凭证已存在，跳过')
}

console.log('')
console.log('下一步：')
console.log('  1) cd "' + PROFILE.replace(/\\/g, '/') + '" ... 不，直接在 profile 目录跑 pnpm install：')
console.log('     cd "' + profileDir.replace(/\\/g, '/') + '" && pnpm install')
console.log('  2) node setup/preflight.mjs      # 复检')
console.log('  3) 若 ACL 检查不过：powershell -ExecutionPolicy Bypass -File setup/elevate.ps1')
