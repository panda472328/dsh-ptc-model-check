/**
 * 门禁降低后的行为验证。
 *
 * 用户要求：**三问（结构对吗/现实中是这样吗/还能更好吗）的问题全改完，就放行。**
 *
 * 所以现在的判据是：
 *   拦：① 视觉检测清单没改完  ② 分组不可靠  ③（兜底）没派检测员且技术检测不过
 *   不拦：穿模命中、孤立命中、剪影未达标、轮次不够、连续落实不够、detail_notes 太短
 *
 *   node tests/verify_gate_relaxed.mjs
 */
import { LoopTracker } from '../lib/core/iteration.mjs'

let failed = 0
const expect = (label, cond, detail) => {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 160) : '')) }
}

/* 一个「分组可靠」的基础 facts，其余全是最差情况 */
const base = {
  groupingNeeded: true,
  groupingOk: true,
  groupedBy: 'collection',
  ungroupedCount: 0,
  referenceGiven: false,
  referenceAnalyzed: false,
}

console.log('=== ① 派了检测员 + 清单全改完 → 放行（即使技术检测有命中）===')
{
  const t = new LoopTracker()
  const v = t.canStop('scene', {
    ...base,
    reviewUsed: true,
    reviewTechnicalOverride: true,
    reviewSatisfied: true,
    reviewPending: 0,
    reviewEdits: 5,
    /* 故意让技术检测不过 */
    clean: false,
    silhouetteOk: false,
    detailNotes: '',
  })
  console.log('  blockers: ' + (v.blockers.length ? v.blockers.join(' | ') : '无'))
  expect('放行', v.allowed === true, v.blockers.join(' | '))
  expect('理由里说明以检测员判断为准',
    v.reasons.some((r) => /视觉检测/.test(r)), v.reasons.join(' | '))
}

console.log('\n=== ② 派了检测员但清单没改完 → 拦 ===')
{
  const t = new LoopTracker()
  const v = t.canStop('scene', {
    ...base,
    reviewUsed: true,
    reviewSatisfied: false,
    reviewPending: 3,
    reviewEdits: 0,
    clean: true,
    detailNotes: '补了倒角',
  })
  console.log('  blockers: ' + v.blockers.join(' | '))
  expect('拦住', v.allowed === false, '')
  expect('理由提到等待复核确认', v.blockers.some((b) => /复核确认/.test(b)), v.blockers.join(' |'))
}

console.log('\n=== ②a 局部或材质复核不能覆盖整场景技术命中 ===')
{
  for (const label of ['局部结构复核', '材质复核', '范围不完整的结构复核']) {
    const t = new LoopTracker()
    const v = t.canStop('scene', {
      ...base,
      reviewUsed: true,
      reviewSatisfied: true,
      reviewTechnicalOverride: false,
      clean: false,
      detailNotes: '已检查',
    })
    expect(label + '仍需技术检查兜底', v.allowed === false,
      v.blockers.join(' | '))
  }
}

console.log('\n=== ③ 没派检测员 + 技术检测不过 → 兜底拦 ===')
{
  const t = new LoopTracker()
  const v = t.canStop('scene', {
    ...base,
    reviewUsed: false,
    clean: false,
    detailNotes: '补了倒角补了接缝',
  })
  console.log('  blockers: ' + v.blockers.join(' | '))
  expect('拦住（不能靠不派检测员绕过）', v.allowed === false, '')
  expect('理由指出视觉复核范围不足', v.blockers.some((b) => /没有覆盖完整场景结构/.test(b)), v.blockers.join(' |'))
}

console.log('\n=== ④ 没派检测员 + 技术检测全过 → 放行 ===')
{
  const t = new LoopTracker()
  const v = t.canStop('scene', {
    ...base,
    reviewUsed: false,
    clean: true,
    silhouetteOk: null,
    detailNotes: '',
  })
  console.log('  blockers: ' + (v.blockers.length ? v.blockers.join(' | ') : '无'))
  expect('放行', v.allowed === true, v.blockers.join(' | '))
}

console.log('\n=== ⑤ 分组不可靠仍要拦（唯一保留的技术前提）===')
{
  const t = new LoopTracker()
  const v = t.canStop('scene', {
    ...base,
    groupingOk: false,
    groupedBy: 'prefix',
    reviewUsed: true,
    reviewSatisfied: true,
    clean: true,
    detailNotes: '补了倒角',
  })
  console.log('  blockers: ' + v.blockers.join(' | '))
  expect('拦住', v.allowed === false, '')
  expect('理由提到 Collection', v.blockers.some((b) => /Collection/.test(b)), v.blockers.join(' | '))
}

console.log('\n=== ⑥ 各项「以前拦、现在不拦」逐条验证 ===')
{
  const cases = [
    ['穿模有命中', { clean: false }],
    ['孤立有命中', { clean: false }],
    ['剪影未达标', { silhouetteOk: false }],
    ['detail_notes 为空', { detailNotes: '' }],
    ['remaining 非空', { remaining: '还想加个烟囱' }],
  ]
  for (const [label, extra] of cases) {
    const t = new LoopTracker()
    const v = t.canStop('scene', {
      ...base,
      reviewUsed: true,
      reviewTechnicalOverride: true,
      reviewSatisfied: true,
      clean: true,
      silhouetteOk: null,
      detailNotes: '补了倒角',
      ...extra,
    })
    expect(label + ' → 不拦', v.allowed === true,
      v.blockers.join(' | '))
  }
}

console.log('\n=== ⑦ 轮次不够不再拦 ===')
{
  const t = new LoopTracker()
  /* 一轮都不跑，直接 done */
  const v = t.canStop('scene', {
    ...base,
    reviewUsed: true,
    reviewSatisfied: true,
    clean: true,
    detailNotes: '三问都改完了',
  })
  expect('第 0 轮也能放行', v.allowed === true, v.blockers.join(' | '))
  expect('不建议为了凑数再迭代',
    !v.reasons.some((r) => /建议至少 .*轮/.test(r)), v.reasons.join(' | '))
  expect('说明轮数不设最低要求',
    v.reasons.some((r) => /轮数不设最低要求/.test(r)), v.reasons.join(' | '))
}

console.log('\n=== ⑧ reasons 要能说明「为什么放行」===')
{
  const t = new LoopTracker()
  const v = t.canStop('scene', {
    ...base, reviewUsed: true, reviewSatisfied: true, clean: true, detailNotes: '都改完了',
  })
  console.log('  reasons:')
  for (const r of v.reasons) console.log('    · ' + r)
  expect('reasons 非空', v.reasons.length > 0, '')
}

console.log('\n' + (failed === 0 ? 'GATE_RELAXED_OK' : 'GATE_RELAXED_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
