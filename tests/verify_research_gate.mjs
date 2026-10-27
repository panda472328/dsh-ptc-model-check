/**
 * 结构调研门禁回归测试。
 *
 * 背景（真实事故，用户亲自分析出来的）：
 *   一个「1:1 还原哥特式大教堂」的任务，模型在清单里写了
 *   「调研：查哥特式大教堂结构」，然后直接标成 completed——
 *   一次 model_reference 都没调。插件完全没拦住。
 *
 * 根因不是疏忽，是机制：
 *   **Agent 会对着有度量的门禁优化，对没有度量的一律降优先级。**
 *   调研之前是唯一零可验证产出的条目，所以必然被跳过。
 *
 * 这个测试守住三件事：
 *   ① 明确要求高保真复刻的任务，缺少有效结构资料就拒绝 done
 *   ② 普通场景、单件小物件和仅提到真实对象时不强制调研
 *   ③ 任务规模识别能认出专有名词
 *
 *   node tests/verify_research_gate.mjs
 */
import { LoopTracker } from '../lib/core/iteration.mjs'
import { researchRequired, resetResearchProgress } from '../lib/core/research.mjs'

let failed = 0
const expect = (label, cond, detail) => {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 160) : '')) }
}

const base = {
  groupingNeeded: false,
  groupingOk: true,
  reviewUsed: true,
  reviewSatisfied: true,
  clean: true,
  detailNotes: '都改了',
}

console.log('=== ① 高保真复刻真实建筑：调研不够 → 拒绝 done ===')
{
  const t = new LoopTracker()
  t.beginRound('scene', { landedPrevious: true })
  const v = t.canStop('scene', {
    ...base,
    researchRequired: 1,
    researchCalls: 0,
    researchSubject: '巴黎圣母院',
  })
  console.log('  blockers: ' + (v.blockers.join(' | ') || '无'))
  expect('拒绝 done', v.allowed === false, '')
  expect('理由提到结构调研', v.blockers.some((b) => /结构调研/.test(b)), v.blockers.join('|'))
  expect('理由提到任务名', v.blockers.some((b) => /巴黎圣母院/.test(b)), v.blockers.join('|'))
  expect('理由给出补救方法', v.blockers.some((b) => /model_reference/.test(b)), v.blockers.join('|'))
}

console.log('\n=== ② 查够了 → 放行 ===')
{
  const t = new LoopTracker()
  t.beginRound('scene', { landedPrevious: true })
  const v = t.canStop('scene', {
    ...base,
    researchRequired: 1,
    researchCalls: 1,
    researchSubject: '巴黎圣母院',
  })
  console.log('  blockers: ' + (v.blockers.join(' | ') || '无'))
  expect('放行', v.allowed === true, v.blockers.join('|'))
  expect('reasons 里说明调研完成', v.reasons.some((r) => /结构调研已完成/.test(r)), v.reasons.join('|'))
}

console.log('\n=== ③ 一条有效结构资料即可满足最低要求 ===')
{
  const t = new LoopTracker()
  t.beginRound('scene', { landedPrevious: true })
  const v = t.canStop('scene', {
    ...base,
    researchRequired: 1,
    researchCalls: 1,
    researchSubject: null,
  })
  expect('放行，不要求为次数重复搜索', v.allowed === true, v.blockers.join('|'))
}

console.log('\n=== ④ 普通场景/单件/对象提及（required=0）不强制调研 ===')
{
  const t = new LoopTracker()
  t.beginRound('scene', { landedPrevious: true })
  const v = t.canStop('scene', {
    ...base,
    researchRequired: 0,
    researchCalls: 0,
    researchSubject: null,
  })
  console.log('  blockers: ' + (v.blockers.join(' | ') || '无'))
  expect('放行', v.allowed === true, v.blockers.join('|'))
  expect('reasons 说明调研按需进行', v.reasons.some((r) => /按需查询/.test(r)), v.reasons.join('|'))
}

console.log('\n=== ⑤ 调研门禁优先级最高（其他都过也不行）===')
{
  const t = new LoopTracker()
  t.beginRound('scene', { landedPrevious: true })
  const v = t.canStop('scene', {
    groupingNeeded: true, groupingOk: true, groupedBy: 'collection', ungroupedCount: 0,
    reviewUsed: true, reviewSatisfied: true,
    clean: true, detailNotes: '完美',
    researchRequired: 1, researchCalls: 0, researchSubject: '科隆大教堂',
  })
  expect('只有调研一项就足以拒绝', v.allowed === false && v.blockers.length === 1, v.blockers.join('|'))
  expect('这条 blocker 就是调研', /结构调研/.test(v.blockers[0] || ''), v.blockers.join('|'))
}

console.log('\n=== ⑥ 任务规模识别 ===')
{
  const cases = [
    ['1:1复刻巴黎圣母院', 1, '巴黎圣母院'],
    ['高保真复刻科隆大教堂', 1, '科隆大教堂'],
    ['高保真复刻故宫', 1, '故宫'],
    ['做一个AK-47模型', 0, null],
    ['高保真复刻一座中式城堡场景', 1, null],
    ['做一个酒馆场景', 0, null],
    ['还原场景氛围，但不要求复刻具体建筑', 0, null],
    ['不需要高保真复刻科隆大教堂', 0, null],
    ['一模一样复刻一把AK-47', 1, 'AK-47'],
    ['高保真复刻一台工业离心泵', 1, null],
    ['严格还原这款手持测量仪', 1, null],
    ['1:1复刻未知型号的控制箱', 1, null],
    ['做一个写实高保真的原创机器人', 0, null],
    ['不需要高保真复刻工业离心泵', 0, null],
    ['做一个杯子', 0, null],
    ['做一个简单的椅子', 0, null],
  ]
  for (const [text, want, subject] of cases) {
    const r = researchRequired(text)
    expect('「' + text + '」→ required=' + want,
      r.required === want, 'got ' + r.required)
    if (subject) expect('  识别出「' + subject + '」', r.subject === subject, String(r.subject))
  }
}

console.log('\n=== ⑦ reset 保留当前高保真要求并清理旧任务门槛 ===')
{
  const current = {
    calls: 1, effectiveCount: 0, emptyCount: 1, offTopicCount: 0, queries: ['空结果'],
    required: 0, subject: null, why: '', lastAt: 1, lastGoodAt: 0, log: [{ effective: false }],
    resetRequirement: researchRequired('高保真复刻一座哥特式教堂场景'),
  }
  resetResearchProgress(current)
  expect('首次 reset 保留刚识别的门槛', current.required === 1, String(current.required))
  expect('首次 reset 清空旧查询进度', current.calls === 0 && current.emptyCount === 0, JSON.stringify(current))
  const tracker = new LoopTracker()
  tracker.beginRound('scene')
  const blocked = tracker.canStop('scene', { ...base, researchRequired: current.required, researchCalls: 0 })
  expect('reset 后立即 done 仍被调研门槛拦住', blocked.allowed === false, blocked.blockers.join('|'))

  current.required = 1
  current.subject = '巴黎圣母院'
  current.why = '旧任务'
  current.resetRequirement = researchRequired('做一个杯子')
  resetResearchProgress(current)
  expect('新任务 reset 清除旧任务门槛', current.required === 0 && current.subject === null,
    JSON.stringify({ required: current.required, subject: current.subject }))

  current.required = 1
  current.subject = '巴黎圣母院'
  current.resetRequirement = null
  resetResearchProgress(current)
  expect('没有新请求分类时保留当前门槛', current.required === 1 && current.subject === '巴黎圣母院',
    JSON.stringify({ required: current.required, subject: current.subject }))
}

console.log('\n' + (failed === 0 ? 'RESEARCH_GATE_OK' : 'RESEARCH_GATE_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
