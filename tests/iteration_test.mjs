/**
 * 迭代闭环自测：只测状态机，不需要 Blender。
 *   node tests/iteration_test.mjs
 */
import { LoopTracker, CONSECUTIVE_LANDED_REQUIRED } from '../lib/core/iteration.mjs'

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

console.log('=== 轮次计数 ===')
{
  const t = new LoopTracker()
  expect('初始第 0 轮', t.current('scene') === 0)
  const r1 = t.beginRound('scene')
  expect('第一次 beginRound 后第 1 轮', r1.round === 1, String(r1.round))
  const r2 = t.beginRound('scene')
  expect('第二次后第 2 轮', r2.round === 2, String(r2.round))
  t.reset('scene')
  expect('reset 后回到第 0 轮', t.current('scene') === 0)
  const r3 = t.beginRound('scene')
  expect('reset 后 beginRound 从 1 开始', r3.round === 1, String(r3.round))
}

console.log('\n=== 按 target 分桶，互不干扰 ===')
{
  const t = new LoopTracker()
  t.beginRound('partA')
  t.beginRound('partA')
  t.beginRound('partB')
  expect('partA 第 2 轮', t.current('partA') === 2, String(t.current('partA')))
  expect('partB 第 1 轮', t.current('partB') === 1, String(t.current('partB')))
  expect('scene 不受影响', t.current('scene') === 0, String(t.current('scene')))
}

console.log('\n=== 承诺的改进项要能追踪 ===')
{
  const t = new LoopTracker()
  t.beginRound('scene')
  t.record('scene', { verdict: 'continue', nextImprovement: '把倒角放大到 1.5mm' })
  const r2 = t.beginRound('scene')
  expect('下一轮回显上一轮的改进项', r2.pending === '把倒角放大到 1.5mm', String(r2.pending))
  expect('没声明落实时给出提醒', r2.note !== null, String(r2.note))
  expect('没落实则连续计数为 0', r2.landedStreak === 0, String(r2.landedStreak))

  const r3 = t.beginRound('scene', { landedPrevious: true })
  expect('声明落实后连续计数 +1', r3.landedStreak === 1, String(r3.landedStreak))
}

console.log('\n=== 停止条件：v2.14 降低后，「三问清单落实」是核心判据 ===')
{
  const t = new LoopTracker()

  /* 新门禁的判据：
   *   拦：① 视觉检测清单没改完  ② 分组不可靠  ③ 没有整场景结构复核且技术检测不过
   *   不拦：轮次 / 连续落实 / detail_notes 字数 / remaining / 剪影 */

  /* ① 派了检测员 + 清单改完 → 直接放行，不管轮次 */
  t.beginRound('scene')
  let g = t.canStop('scene', {
    reviewUsed: true, reviewSatisfied: true, clean: true,
    groupingNeeded: false, detailNotes: '',
  })
  expect('派了检测员且清单改完 → 放行（轮次不够也行）', g.allowed === true, JSON.stringify(g.blockers))
  expect('reasons 里说明复核结果已闭环',
    g.reasons.some((r) => /视觉复核结果有效/.test(r)), JSON.stringify(g.reasons))

  /* ② 清单没改完 → 拦 */
  g = t.canStop('scene', {
    reviewUsed: true, reviewSatisfied: false, reviewPending: 4,
    clean: true, groupingNeeded: false, detailNotes: '都改了',
  })
  expect('清单没改完 → 拦', g.allowed === false, JSON.stringify(g.blockers))
  expect('blocker 提到复核确认',
    g.blockers.some((b) => /复核确认/.test(b)), JSON.stringify(g.blockers))

  /* ③ 缺少完整整场景结构复核 + 技术检测不过 → 兜底拦 */
  g = t.canStop('scene', {
    reviewUsed: false, clean: false, groupingNeeded: false, detailNotes: '改了',
  })
  expect('没派检测员且检测不过 → 拦', g.allowed === false, JSON.stringify(g.blockers))
  expect('blocker 提到完整场景结构复核',
    g.blockers.some((b) => /没有覆盖完整场景结构/.test(b)), JSON.stringify(g.blockers))
  g = t.canStop('scene', {
    reviewUsed: true, reviewSatisfied: true, reviewTechnicalOverride: true,
    clean: false, groupingNeeded: false, detailNotes: '已检查',
  })
  expect('完整整场景结构复核后可由视觉判断覆盖技术命中', g.allowed === true,
    JSON.stringify(g.blockers))

  /* 局部或材质复核只关闭自己的待办，不覆盖全场景几何命中。 */
  for (const label of ['局部结构复核', '材质复核', '不完整全场景复核']) {
    g = t.canStop('scene', {
      reviewUsed: true, reviewSatisfied: true, reviewTechnicalOverride: false,
      clean: false, groupingNeeded: false, detailNotes: '已检查',
    })
    expect(label + '不能覆盖技术命中', g.allowed === false, JSON.stringify(g.blockers))
  }

  /* ④ 没派检测员但技术检测全过 → 放行 */
  g = t.canStop('scene', {
    reviewUsed: false, clean: true, silhouetteOk: null,
    groupingNeeded: false, detailNotes: '',
  })
  expect('没派检测员但检测全过 → 放行', g.allowed === true, JSON.stringify(g.blockers))

  /* ⑤ 分组不可靠仍要拦 */
  g = t.canStop('scene', {
    reviewUsed: true, reviewSatisfied: true, clean: true,
    groupingNeeded: true, groupingOk: false, groupedBy: 'prefix',
    detailNotes: '改了',
  })
  expect('分组不可靠 → 拦', g.allowed === false, JSON.stringify(g.blockers))
  expect('blocker 提到 Collection',
    g.blockers.some((b) => /Collection/.test(b)), JSON.stringify(g.blockers))

  /* ⑥ 以前拦、现在不拦的几项 */
  const relaxed = [
    ['轮次不够', {}],
    ['没写 detail_notes', { detailNotes: '' }],
    ['写了 remaining', { remaining: '还有 4 颗螺丝没装' }],
    ['剪影未达标', { silhouetteOk: false }],
  ]
  for (const [label, extra] of relaxed) {
    const tt = new LoopTracker()
    tt.beginRound('scene', { landedPrevious: true })
    const gg = tt.canStop('scene', {
      reviewUsed: true, reviewSatisfied: true, clean: true,
      groupingNeeded: false, detailNotes: '补了倒角', ...extra,
    })
    expect(label + ' → 不再拦', gg.allowed === true, JSON.stringify(gg.blockers))
  }

  /* ⑦ reasons 要能说明为什么放行 */
  const t7 = new LoopTracker()
  t7.beginRound('scene')
  const g7 = t7.canStop('scene', {
    reviewUsed: true, reviewSatisfied: true, clean: true,
    groupingNeeded: true, groupingOk: true, groupedBy: 'collection',
    ungroupedCount: 0, detailNotes: '三问都改完了',
  })
  expect('reasons 非空', g7.reasons.length > 0, JSON.stringify(g7.reasons))
  expect('reasons 提到有效视觉复核',
    g7.reasons.some((r) => /视觉复核结果有效/.test(r)), JSON.stringify(g7.reasons))
}

console.log('\n=== 检测没过时不许停 ===')
{
  const t = new LoopTracker()
  for (let i = 0; i < 5; i++) t.beginRound('scene', { landedPrevious: i > 0 })
  const g = t.canStop('scene', { clean: false, silhouetteOk: true })
  expect('有穿模/孤立时不允许停', g.allowed === false, JSON.stringify(g.blockers))
  expect('blocker 提到检测', g.blockers.some((b) => /检测|穿模|孤立/.test(b)), JSON.stringify(g.blockers))
}

console.log('\n=== 剪影未达标：v2.14 后只提示不拦 ===')
{
  const t = new LoopTracker()
  for (let i = 0; i < 5; i++) t.beginRound('scene', { landedPrevious: i > 0 })
  const g = t.canStop('scene', {
    clean: true, silhouetteOk: false,
    reviewUsed: true, reviewSatisfied: true, groupingNeeded: false,
  })
  expect('剪影未达标不再拦', g.allowed === true, JSON.stringify(g.blockers))
  expect('reasons 里提示剪影', g.reasons.some((r) => /剪影/.test(r)), JSON.stringify(g.reasons))
}

console.log('\n=== 参考图分析提醒，不作硬门槛 ===')
{
  const t = new LoopTracker()
  for (let i = 0; i < 5; i++) t.beginRound('scene', { landedPrevious: i > 0 })
  const rich = {
    clean: true, silhouetteOk: null,
    detailNotes: '外露边都加了 0.5mm 倒角，面板分了三段，金属件粗糙度 0.25',
  }

  /* 给了参考图但没分析 → v2.14 后降级为提示，不再硬拦
   * （用户要求：门禁只留「三问清单」，其余都让路） */
  let g = t.canStop('scene', {
    ...rich, referenceGiven: true, referenceAnalyzed: false,
    reviewUsed: true, reviewSatisfied: true, groupingNeeded: false,
  })
  console.log('    没分析参考图: allowed=' + g.allowed
    + ' reasons=' + JSON.stringify(g.reasons.filter((r) => /参考图/.test(r))))
  expect('没分析参考图不再硬拦', g.allowed === true, JSON.stringify(g.blockers))
  expect('reasons 里提醒参考图未分析',
    g.reasons.some((r) => /参考图/.test(r)), JSON.stringify(g.reasons))

  /* 分析了才放行 */
  g = t.canStop('scene', { ...rich, referenceGiven: true, referenceAnalyzed: true })
  expect('分析过参考图后才允许停', g.allowed === true, JSON.stringify(g.blockers))
  expect('理由里提到已分析参考图',
    g.reasons.some((r) => /参考图/.test(r)), JSON.stringify(g.reasons))

  /* 没给参考图时不受这条约束 */
  g = t.canStop('scene', { ...rich, referenceGiven: false })
  expect('没给参考图时不受约束', g.allowed === true, JSON.stringify(g.blockers))
}

console.log('\n=== done 会清空 pending，continue 会保留 ===')
{
  const t = new LoopTracker()
  t.beginRound('scene')
  t.record('scene', { verdict: 'continue', nextImprovement: 'A' })
  expect('continue 后 pending=A', t.bucket('scene').pending === 'A')
  t.record('scene', { verdict: 'done', stopReason: '够了' })
  expect('done 后 pending 清空', t.bucket('scene').pending === null)
}

console.log('\n=== 轮数不设最低要求，有待办时才提醒落实 ===')
{
  const t = new LoopTracker()
  const g = t.canStop('scene', { reviewUsed: true, reviewSatisfied: true, clean: true })
  expect('第 0 轮不产生最低轮数建议',
    !g.reasons.some((r) => /至少.*轮/.test(r)), JSON.stringify(g.reasons))
  expect('明确轮数不设最低要求',
    g.reasons.some((r) => r.includes('轮数不设最低要求')), JSON.stringify(g.reasons))
  expect('没有承诺待办时不提示落实次数',
    !g.reasons.some((r) => /上一轮承诺/.test(r)), JSON.stringify(g.reasons))
  t.beginRound('scene')
  t.record('scene', { verdict: 'continue', nextImprovement: '给桌腿加倒角' })
  const pending = t.canStop('scene', { reviewUsed: true, reviewSatisfied: true, clean: true })
  expect('存在承诺时指出具体待办',
    pending.reasons.some((r) => r.includes('给桌腿加倒角')), JSON.stringify(pending.reasons))
}

console.log('\n=== 连续落实参数符合设计 ===')
expect('连续落实 >= 1', CONSECUTIVE_LANDED_REQUIRED >= 1, String(CONSECUTIVE_LANDED_REQUIRED))
expect('连续落实不苛刻（<= 2）', CONSECUTIVE_LANDED_REQUIRED <= 2, String(CONSECUTIVE_LANDED_REQUIRED))

console.log('\n=== 没参考图时不该被剪影/参考图门禁拦住 ===')
{
  const t = new LoopTracker()
  const v = t.canStop('scene', {
    clean: true, groupingNeeded: false, reviewSatisfied: true,
    referenceGiven: false, referenceAnalyzed: false,
    silhouetteOk: null, detailNotes: '桌面加了 3mm 倒角，桌腿做了插接', remaining: '',
  })
  /* 轮数不会形成 blocker，也不该有参考图相关 blocker。 */
  const refBlockers = v.blockers.filter((b) => b.includes('参考图'))
  expect('没有参考图相关 blocker', refBlockers.length === 0, refBlockers.join('|'))
  expect('reasons 里说明了没图', v.reasons.some((r) => r.includes('没有参考图')),
    v.reasons.join('|'))
}

console.log('\n' + (failed === 0 ? 'ITERATION_OK' : 'ITERATION_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
