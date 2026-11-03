# 接线审计（零成本 · 不调模型）

**回答一个问题：你要改的那个东西，产品真的读它吗？**

```bash
node suites/wiring-audit.mjs              # 全量报告
node suites/wiring-audit.mjs --json       # 机器可读（供 CI / 监控台）
node suites/wiring-audit.mjs --only dead-switch,server-dead-key
node suites/wiring-audit.mjs --strict     # 有 warn 即退出码 2（CI 门禁）
```

退出码：`0` 审计完成（**不论发现多少 warn**，默认非阻断）· `1` 审计本身跑不起来 · `2` `--strict` 且有 warn。

---

## 它和别的套件是什么关系

| | suites/families 等 | **本套件** |
|---|---|---|
| 调模型 | 是（花钱、慢） | **否（零成本、~0.4s）** |
| 测什么 | 模型的行为 | 代码的接线 |
| 能不能进 CI | 不适合 | **适合** |

它不是"更轻的模型测试"，而是**跑模型测试之前必须先过的关**：
如果注入层改了但那条路径根本走不到，跑一百次实验也都是空转。

本仓历史里，「改了完全无效」比「模型不听话」更常见。所以这一层值得单列。

---

## 检出的五类问题

| code | 含义 | 后果 |
|---|---|---|
| `server-dead-key` | `DEFAULT_CONFIG` 里定义了，但全后端零读取 | 改了**完全无效** |
| `dead-switch` | 前端能拨（`set()` 落盘），后端零读取 | 用户拨了**没反应** |
| `mirror-drift` | 前端写的键，服务端 `DEFAULT_CONFIG` 没有 | 未知键可能被**静默丢弃** |
| `route-path-missing` | 前端 `API.x` 指向的路径，服务端 API 表没有 | 请求 **404** |
| `block-scope-suspect` | try 块内声明、catch 之后又引用 | 运行时 `ReferenceError`，**整条分支静默失效** |

另有两条 `info` 级（不算缺陷）：`no-ui-entry`（后端有读、前端没入口，只能改配置文件）、
`deprecated-key`（注释已标废弃，建议最终清理）。

---

## 三件必须知道的事（否则会误读报告）

### 1 · `warn` 不等于缺陷

`warn` 是**可疑**，要人判断。已知的合理情形：

- 纯运维键（路径、端口、凭据）本就该只由配置文件控制，出现在 `no-ui-entry` 里是正常的；
- 过渡期的废弃键，注释里标了「已废弃」的会被降级成 `info`；
- 某些键**故意**留给未来的功能占位。

报告末尾会提示逐条核对。确认无碍的，建议在 `DEFAULT_CONFIG` 的注释里写明用途 ——
否则下一个人还会再问一遍。

### 2 · `block-scope-suspect` 是启发式的，**不要直接定罪**

这类缺陷（`try{}` 内的 `const` 在块外被引用 ⇒ `ReferenceError` 被空 catch 吞掉）确实会
让整条门控静默失效，且能通过 `node --check` 与所有静态断言 —— 极难发现。

但**静态检测做不到零误报**。实测过的误报样例：

- `const low = (x) => …`（箭头函数局部）与 30 行外另一个函数里的 `const low = …` 撞名；
- `for (const d of …) { const dir = … }` 循环内声明被当成 try 顶层声明。

⇒ 因此它默认报 `info`，并附「需真执行确认」。确认方法是**抽出来真跑**：

```js
// 按真实作用域形状复现，看是不是真的抛
function realShape() {
  try { const leak = 1 } catch (_) {}
  try { if (x !== leak) y = 1 } catch (_e) { /* 空 catch 吞掉 */ }
}
// 会抛 ReferenceError: leak is not defined
```

需要把它当 CI 门禁时用 `--strict-scope`（会升级成 `warn`）。

### 3 · 它只看静态接线，不代表运行期行为

本套件**不启动宿主、不跑模型**。它证明的是「代码层面接通了」，不是「跑起来一定对」。
运行期仍需 `suites/families.mjs`。

---

## 五类读法的由来（维护者必读）

「后端零读取」这个判定，取决于**认不认得出后端的读法**。少认一种，就会把真死键漏报成「已接线」。

当前支持的五种形态，**每一种都是在真实产品上漏报过才补上的**：

```js
this.config.directDot                       // ① 点号直读
engine.config['bracketStr']                 // ② 方括号字符串
cfg.plainCfg                                // ③ cfg 前缀
safeGet(configOf(), 'wrappedKey')           // ④ 包装器 + 返回配置的函数
const alias = cfg || {}; alias.aliasRead    // ⑤ 别名变量
```

另有两类「动态键」按**弱证据**处理（记入 `weakReadKeys`，不单独定罪）：

```js
for (const key of ['noteCapacityChars', …]) this.config[key]   // 动态索引 + 邻近字面量
const laneKey = lane === 'long' ? 'effortLong' : 'effortShort'
config[laneKey]                                                 // 键先赋给变量再索引
```

**产品侧提醒**：新增一种配置读取写法时，请同步更新 `lib/wiring-audit.mjs`，
并在 `lib/selftest.mjs` 的「5 种配置读法」用例里加一行。
否则检测器会开始漏报 —— 而漏报的表现是**报告全绿**，最难察觉。

---

## 结果怎么复算

```bash
node suites/wiring-audit.mjs --json | node -e "…"    # 任意二次处理
```

判定口径（全部可从源码复算）：

- **配置键清单**：解析 `lib/index.js` 的 `const DEFAULT_CONFIG = {…}`（花括号配平，不用正则猜）
- **后端读点**：扫 `lib/` 下**除 `client.js` 外**的全部 `.js`（排除 .bak 等历史副本）
  - ⚠️ `client.js` 必须排除：它大量 `cfg.x` 只是**读回来显示在表单里**，不是消费。
    首版把它算进后端读点 ⇒ 真死开关（`workbenchLoopShort` 等）全部漏报。
- **前端键**：`lib/client.js` 的 `set('k', …)` 与 `cfg.k`
- **路由**：两端 API 常量表按**路径尾段**比对（前端 `ROUTE_PREFIX + '/x'`、后端 `'/api/…/x'`；
  键名两端不同形态 —— camelCase vs kebab，按名字比会全错）

---

## 性能

约 **0.4 秒**（142 个文件、`index.js` 2.7 万行）。

曾因作用域检测写成 O(n²) 只有 8.5 秒，把 `selftest` 的 3 秒性能断言挤爆。
现在用「一次算好的括号配对表 + 外层括号表 + 行号二分表」把整体压到 O(n)。
**不要**在循环里重新配平或 `slice(0,pos).split('\n')`。