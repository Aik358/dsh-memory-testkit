/**
 * 外部判据的离线验证 —— 不打任何模型调用。
 *
 * 外部基准的价值全在判据上：如果判据把对的判错、把错的判对，
 * 接进来只会制造假信号。所以先用「人工构造的回答」把判据钉死。
 */
import { loadOrnn8, judgeExternal, toSingleTurnScenario } from '../lib/external-ornn8.mjs'
import { loadLongMemEval, judgeLongMemEval } from '../lib/external-longmemeval.mjs'

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ✓ ' + name) } catch (e) {
    fail++
    console.log('  ✗ ' + name + '\n      ' + String(e && e.message || e).slice(0, 240))
  }
}
const eq = (a, b, msg) => { if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a)) }
const ok = (v, msg) => { if (!v) throw new Error(msg || '断言失败') }

const ORNN = process.env.TESTKIT_ORNN8_DIR
const LME = process.env.TESTKIT_LME_DIR

console.log('=== 外部判据离线验证 ===\n')

/* ─────────── Ornn8 ─────────── */
if (!ORNN) {
  console.log('⚠ 未设 TESTKIT_ORNN8_DIR，跳过 Ornn8 部分\n')
} else {
  const r = loadOrnn8(ORNN)
  ok(r.ok, 'Ornn8 载入失败：' + r.error)
  console.log(`Ornn8 载入：${r.items.length} 考点，commit ${r.commit}`)

  t('解析完整性：每考点都有 evidence / must / slots', () => {
    for (const x of r.items) {
      ok(x.evidence.length > 0, x.id + ' 没有历史依据')
      ok(x.must.length > 0, x.id + ' 没有「必须做到」')
      ok(x.slots.length === 4, x.id + ' 时间档应为 4 个，实际 ' + x.slots.length)
      // ⚠️ 不是每个考点都有「不能这样答」（实测 C018 缺）—— 那是数据本身如此，
      //    不是解析 bug。如实统计，不假装全都齐全。
    }
    const noForbidden = r.items.filter(x => !x.forbidden.length).map(x => x.id)
    console.log('      有 forbidden 判据的：' + (r.items.length - noForbidden.length) + '/' + r.items.length
      + (noForbidden.length ? '（缺：' + noForbidden.join(', ') + '）' : ''))
  })

  t('转场景：包含历史与问题，且带 external 判据', () => {
    const sc = toSingleTurnScenario(r.items[0])
    ok(sc.text.includes(r.items[0].question), '场景里没有原问题')
    ok(sc.external.must.length > 0, '没带 must')
    ok(sc.family.startsWith('external:'), 'family 命名不对')
  })

  const c001 = r.items.find(x => x.id.startsWith('PUB01-C001'))
  console.log('\n  C001 判据：must=' + JSON.stringify(c001.must) + ' forbidden=' + JSON.stringify(c001.forbidden))

  t('C001 正确回答 → 通过', () => {
    const j = judgeExternal(c001, '你借了阿岑一把活动扳手，说演出结束后归还。')
    eq(j.pass, true, '应通过。detail=' + j.detail.join('/'))
  })

  t('C001 漏了关键项 → 不判通过（判不了或判错都算，只要不是 true）', () => {
    const j = judgeExternal(c001, '你借了阿岑一把活动扳手。')
    ok(j.pass !== true, '缺关键项时不能判通过。pass=' + j.pass + ' detail=' + j.detail.join('/'))
  })

  t('★C001 逐字复述禁止表述 → 必须判失败', () => {
    // forbidden = 「说已经还了」；逐字复述时必须抓到
    const j = judgeExternal(c001, '你借了阿岑一把活动扳手。说已经还了。')
    eq(j.pass, false, '逐字复述 forbidden 必须判失败。detail=' + j.detail.join('/'))
  })

  t('C001 改写后的禁止表述 → 至少降置信度（规则判分不保证抓到）', () => {
    // 「实际上已经还了」与 forbidden「说已经还了」差一个「说」字。
    // 规则判分不保证抓到这种改写 —— 但**必须**在结果里标记「有未核对的禁止项」，
    // 让调用方知道要人工看，而不是给出一个干净的「通过」。
    const j = judgeExternal(c001, '你借了阿岑一把活动扳手，演出结束后归还。实际上已经还了。')
    const flagged = j.confidence === 'low' || j.pass === false
    ok(flagged, '改写版禁止项既没判失败、也没标低置信度 —— 那会给出干净的假绿。'
      + ' pass=' + j.pass + ' conf=' + j.confidence)
    console.log('      （pass=' + j.pass + ' conf=' + j.confidence + ' —— 已标记需人工确认）')
  })

  t('空回答 → 不通过（不能因无内容而放过）', () => {
    eq(judgeExternal(c001, '').pass, false)
    eq(judgeExternal(c001, '   ').pass, false)
  })

  t('缺判据时返回「不可判」而不是通过', () => {
    eq(judgeExternal({ must: [] }, '随便什么').pass, null)
    eq(judgeExternal(null, 'x').pass, null)
  })

  // 全考点扫一遍：正确回答（= 参考答案）应当通过
  t('★参考答案自检：不得被判为错（允许「判不了」，不允许 false）', () => {
    const wrong = []
    let undecidable = 0
    for (const x of r.items) {
      if (!x.reference) continue
      const j = judgeExternal(x, x.reference)
      if (j.pass === false) wrong.push(x.id + ' ' + j.detail.join('/'))
      if (j.pass === null) undecidable++
    }
    ok(wrong.length === 0, wrong.length + ' 个考点把参考答案判成错: ' + wrong.join(' ; '))
    console.log('      （其中 ' + undecidable + ' 个诚实返回「判不了」—— 同义改写类，需人工判）')
  })

  t('★用「完全不相干」的回答喂判据：不应有任何一个通过', () => {
    const wrong = []
    for (const x of r.items) {
      const j = judgeExternal(x, '这件事情我完全不记得了，换个别的话题吧。')
      if (j.pass === true) wrong.push(x.id)
    }
    ok(wrong.length === 0, wrong.length + ' 个考点把无关回答判成通过：' + wrong.join(', '))
  })
  console.log('')
}

/* ─────────── LongMemEval ─────────── */
if (!LME) {
  console.log('⚠ 未设 TESTKIT_LME_DIR，跳过 LongMemEval 部分')
} else {
  const r = loadLongMemEval({ dir: LME, file: process.env.TESTKIT_LME_FILE || 'lme_oracle.json', limit: 20 })
  ok(r.ok, 'LME 载入失败：' + r.error)
  console.log(`LongMemEval 载入：${r.total} 题，取样 ${r.selected}`)

  t('abstention 识别：只看 question_type 会漏掉全部 30 道', () => {
    const all = loadLongMemEval({ dir: LME, file: process.env.TESTKIT_LME_FILE || 'lme_oracle.json' })
    const abs = all.items.filter(x => x.isAbstention)
    ok(abs.length > 0, '一道 abstention 都没识别出来')
    for (const a of abs) {
      ok(String(a.id).endsWith('_abs'), 'id 应以 _abs 结尾')
      eq(a.type, 'abstention', 'type 应被归一成 abstention')
    }
    console.log(`      识别出 ${abs.length} 道 abstention（官方说明是 30 道）`)
  })

  const abs = r.items.find(x => x.isAbstention)
  if (!abs) {
    console.log('⚠ 取样里没有 abstention，跳过其判据测试')
  } else {
    t('abstention：明说不知道 → 通过', () => {
      const j = judgeLongMemEval(abs, '记录里没有提到这件事，我无法确定。')
      eq(j.pass, true, '应通过。detail=' + j.detail.join('/'))
    })

    t('★abstention：直接编一个答案 → 不通过', () => {
      const j = judgeLongMemEval(abs, '你先修了篱笆，然后买了三头牛。')
      eq(j.pass, false, '必须判失败（该题正确行为是承认不知道）')
      eq(j.confidence, 'high')
    })

    t('★abstention：说不知道但顺带编了年份 → 通过但置信度降为 low', () => {
      const j = judgeLongMemEval(abs, '记录里没有购买牛的信息。不过 2023 年 3 月你修了篱笆。')
      eq(j.pass, true, '这种表述仍算「承认信息不足」')
      eq(j.confidence, 'low', '★必须降置信度，否则会掩盖「说不知道又编」')
      ok(j.detail.some(d => d.includes('⚠')), '应给出编造警示')
    })
  }

  const normal = r.items.find(x => !x.isAbstention && x.answer)
  if (normal) {
    t('普通题：命中 gold → 通过', () => {
      eq(judgeLongMemEval(normal, '答案是 ' + normal.answer).pass, true)
    })
    t('普通题：无关回答 → 不通过，且置信度标 low（规则判分对同义改写不敏感）', () => {
      const j = judgeLongMemEval(normal, '我不知道该怎么回答这个问题。')
      eq(j.pass, false)
      eq(j.confidence, 'low')
    })
    t('普通题：空回答 → 不通过', () => {
      eq(judgeLongMemEval(normal, '').pass, false)
    })
  }

  t('缺 gold 时返回「不可判」而不是通过', () => {
    eq(judgeLongMemEval({ answer: '', isAbstention: false }, '随便').pass, null)
  })
}

console.log('')
console.log(fail ? `✗ ${fail} 项失败 / ${pass + fail} 项` : `✓ 全部 ${pass} 项通过`)
process.exitCode = fail ? 1 : 0
