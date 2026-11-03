/**
 * 示例实验 · 四类感知纪律的句式表改写
 *
 * 这是批次 4 的**验收物**：它把「以前要复制一份套件脚本才能做的事」
 * 写成一份纯声明，并让 validate 在跑之前就拦住两类空跑：
 *   ① 改了不存在的层
 *   ② 改了某条注入路径上的层，但该臂的节奏让那条路径不可达
 *
 * 用法：
 *   node experiments/run.mjs percept-sentence-table --dry-run   # 只校验
 *   node experiments/run.mjs percept-sentence-table             # 真跑
 *
 * 注意 reps 默认 2 —— 只是为了本地跑得快；**要下结论请用 5 以上**。
 */
export default {
  name: 'percept-sentence-table',
  description: '把四类感知的触发条件改写成句式表，看「有明确信号时是否更稳定地写入」',

  suite: 'families',
  // 只选三个有明确正/负信号的四类感知场景：共识 / 承诺 / 用户偏好
  scenarios: ['sg-strong', 'cm-promise', 'up-preference'],

  reps: 2,
  concurrency: 2,

  arms: {
    // 基线：产品默认静态纪律（不覆盖任何层，只声明节奏）
    base: {
      cadence: { snapshotMinGapRounds: 20, slimEveryRounds: 8 },
    },

    // 句式表：把「什么时候该写」写成可对照的句式，而不是描述性规则
    sentenceTable: {
      cadence: { snapshotMinGapRounds: 20, slimEveryRounds: 8 },
      layers: {
        staticPerceptDiscipline:
          '- **★情境化记忆(四类感知)——按句式匹配,命中就写**\n'
          + '  · 用户说了「对 / 就这样 / 定了 / 不用再讨论 / 按这个来」→ `sharedGround{claim, confirmedBy}`\n'
          + '  · 用户说了「我更喜欢 / 以后都 / 别再」→ `userPercept{stage:"accepted", kind:"preference", text}`\n'
          + '  · 我说了「我会 / 我负责 / 接下来我去」→ `commitment{promise, state:"open"}`\n'
          + '  · 用户纠正了我的说法 → `sharedGround.correction` 记下差在哪\n'
          + '  **只在这四类句式命中时写；没命中就不写，不要为了填充而写。**',
      },
    },
  },
}
