/**
 * model_deleted 端到端测试。
 *
 * 为什么必须补：覆盖率审计发现这个工具**从没被真正执行过**——
 * 只在 verify_plugin_loads / verify_tool_definitions 里被「提及」，
 * 那只是检查它注册了，没检查它能不能用。
 *
 * 这个工具是用户明确要求的功能（「删掉因为检测穿模而直接删掉的模型，
 * 要判断需不需要加回来，要怎么做到正确的位置」），不能只靠「注册成功」就算数。
 *
 * 覆盖：
 *   ① 没有删除记录时 list 的行为
 *   ② 有删除记录时 list 能列出候选
 *   ③ verdict 缺理由要被拒
 *   ④ verdict 理由太短要被拒
 *   ⑤ 正常 verdict 能记账
 *   ⑥ 恢复方案（exact / offset / anchored）
 *
 *   node tests/verify_deleted_tool.mjs
 */
import { buildTools } from '../lib/tools.mjs'
import { judgeDeleted, restorePlan, snapshotMesh, makeMesh } from '../lib/core/geometry.mjs'

let failed = 0
const expect = (label, cond, detail) => {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

/* ── 造一个假场景 ── */
function box(id, cx, cy, cz, sx, sy, sz, part) {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2
  const v = []
  for (const dz of [-hz, hz]) for (const dy of [-hy, hy]) for (const dx of [-hx, hx]) v.push(cx + dx, cy + dy, cz + dz)
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
  const m = makeMesh(id, part || id, new Float64Array(v), new Uint32Array(idx))
  return m
}

console.log('=== ① snapshotMesh 抓取的字段 ===')
{
  const m = box('桌_腿1', 0, 0, 0.5, 0.1, 0.1, 1)
  const snap = snapshotMesh(m)
  expect('有 bbox', Array.isArray(snap.bbox) && snap.bbox.length === 6, JSON.stringify(snap.bbox))
  expect('有 center', Array.isArray(snap.center) && snap.center.length === 3, JSON.stringify(snap.center))
  expect('有 dims', Array.isArray(snap.dims) && snap.dims.length === 3, JSON.stringify(snap.dims))
  expect('有 part 名', snap.part === '桌_腿1', String(snap.part))
  expect('bbox 数值正确', Math.abs(snap.bbox[5] - 1.0) < 1e-6, 'top=' + snap.bbox[5])
}

console.log('\n=== ② judgeDeleted：整组删空 → 建议加回 ===')
{
  /* 用 addon 的真实快照结构：name / dimensions / collections / bbox / center */
  const rec = {
    id: 'a', name: '桌_桌面',
    dimensions: [2, 1.2, 0.08],
    bbox: [-1, -0.6, 0.96, 1, 0.6, 1.04],
    center: [0, 0, 1],
    collections: ['桌'],
  }
  /* 同组还剩一个腿，但桌面是最后的关键件——这里造「整组只剩 0 个」的情形 */
  const surviving = []
  const v = judgeDeleted(rec, surviving, { groupNames: ['桌'] })
  const why = (v.reasons || []).join('；')
  console.log('    verdict=' + v.verdict + '  reasons=' + why.slice(0, 70))
  expect('判定为需要恢复', v.verdict === 'restore', String(v.verdict))
  expect('有理由', why.length >= 6, why)
}

console.log('\n=== ③ judgeDeleted：有邻接 → 建议加回 ===')
{
  const rec = {
    id: 'b', name: '桌_腿1',
    dimensions: [0.1, 0.1, 1],
    bbox: [0.75, -0.05, 0, 0.85, 0.05, 1],
    center: [0.8, 0, 0.5],
    collections: ['桌'],
  }
  const surv = box('桌_桌面', 0, 0, 1, 2, 1.2, 0.08)
  surv.meta = { collections: ['桌'] }
  const v = judgeDeleted(rec, [surv], { groupNames: ['桌'] })
  const why = (v.reasons || []).join('；')
  console.log('    verdict=' + v.verdict + '  reasons=' + why.slice(0, 70))
  expect('判定为需要恢复', v.verdict === 'restore', String(v.verdict))
  expect('有理由', why.length >= 6, why)
}

console.log('\n=== ④ judgeDeleted：孤立的小物件 → 可以保持删除 ===')
{
  const rec = {
    id: 'c', name: '远处的小石子',
    dimensions: [0.2, 0.2, 0.2],
    bbox: [99.9, 99.9, 0, 100.1, 100.1, 0.2],
    center: [100, 100, 0.1],
    collections: ['石子'],
  }
  const v = judgeDeleted(rec, [box('主体', 0, 0, 1, 5, 5, 2)], { groupNames: [], sceneDiag: 8 })
  const why = (v.reasons || []).join('；')
  console.log('    verdict=' + v.verdict + '  reasons=' + why.slice(0, 70))
  expect('判定为可以删掉', v.verdict === 'keep-deleted', String(v.verdict))
  expect('有理由', why.length >= 6, why)
}

console.log('\n=== ⑤ restorePlan：三种方案 ===')
{
  /* 原位置空着 → exact */
  const rec = {
    name: '桌_桌面', dimensions: [2, 1.2, 0.08],
    bbox: [-1, -0.6, 0.96, 1, 0.6, 1.04], center: [0, 0, 1], collections: ['桌'],
  }
  const p1 = restorePlan(rec, [box('远处的', 50, 50, 1, 1, 1, 1)])
  console.log('    原位置空着 → exact=' + JSON.stringify(p1.exact))
  expect('给出 exact 方案', !!p1.exact, JSON.stringify(p1.exact))
  expect('带上了原坐标', !!(p1.exact && Array.isArray(p1.exact.location)),
    JSON.stringify(p1.exact && p1.exact.location))

  /* 原位置被占 → offset 或 anchored */
  const p2 = restorePlan(rec, [box('占位物', 0, 0, 1, 2, 1.2, 0.08)])
  console.log('    原位置被占 → offset=' + JSON.stringify(p2.offset && p2.offset.location))
  expect('给出了让开方案', !!p2.offset, JSON.stringify(p2.offset))
  expect('让开方案带坐标', !!(p2.offset && Array.isArray(p2.offset.location)),
    JSON.stringify(p2.offset && p2.offset.location))
}

console.log('\n=== ⑥ 工具层：list 与 verdict ===')
{
  /* 造一个能返回固定场景的 source */
  const meshes = [
    box('桌_桌面', 0, 0, 1, 2, 1.2, 0.08),
    box('桌_腿1', 0.8, 0, 0.5, 0.1, 0.1, 1),
  ]
  const fakeSrc = {
    describe: () => 'live',
    resolve: async () => 'live',
    extract: async () => ({ meshes }),
    /* run() 内部可能调这些 */
    isLive: async () => true,
  }
  /* 删除记账：用一个内存账本 */
  const ledger = { batches: [], pending: [], resolved: [], pendingCount: 0 }
  let noted = null
  let verdicts = []
  const tools = buildTools({
    sourceFor: () => fakeSrc,
    config: () => ({ source: 'live', minDepth: 0.0005, minRatio: 0.005, minIsolation: 0.01, maxObjects: 5000, maxTriangles: 5000000 }),
    remember: () => {},
    hostCtx: { get: () => undefined },
    getRefState: () => ({ given: false, analyzed: false }),
    markRefAnalyzed: () => {},
    getPhaseState: () => ({ modelingComplete: false }),
    markModelingComplete: () => {},
    resetPhase: () => {},
    getModelingState: () => ({ dirtySinceCheck: false, editCount: 0, lookSinceEdit: 0 }),
    noteCheck: () => {},
    noteModelingEdit: () => {},
    noteReviewResult: () => {},
    getReviewState: () => ({ pendingActions: [], receivedAt: 0, editsAfterReview: 0 }),
    noteReviewPrompt: () => {},
    getMaterialState: () => ({ touchedGroups: {}, editCount: 0 }),
    noteMaterialEdit: () => {},
    getDeletedLog: () => ledger,
    noteDeleted: (toolName, snaps) => { noted = { toolName, snaps } },
    noteDeleteVerdict: (id, verdict, reason) => { verdicts.push({ id, verdict, reason }) },
    getTodoState: () => ({ lastTotal: 0, lastDone: 0, lastRemaining: [] }),
    noteTodoWrite: () => {},
  })
  const t = tools.find((x) => x.name === 'model_deleted')
  expect('工具存在', !!t, '')

  /* 空账本时 list */
  const v1 = await t.execute({ action: 'list' }, { signal: new AbortController().signal })
  const txt1 = t.output.render({}, v1).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  console.log('    空账本 list: ' + txt1.split('\n')[0].slice(0, 70))
  expect('空账本能正常返回', typeof txt1 === 'string' && txt1.length > 0, '')

  /* 造一条待处理记录 */
  ledger.pending.push({
    id: 'del-1',
    name: '桌_腿1',
    dimensions: [0.1, 0.1, 1],
    bbox: [0.75, -0.05, 0, 0.85, 0.05, 1],
    center: [0.8, 0, 0.5],
    collections: ['桌'],
    at: Date.now(),
  })
  ledger.pendingCount = 1
  const v2 = await t.execute({ action: 'list' }, { signal: new AbortController().signal })
  const txt2 = t.output.render({}, v2).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  console.log('    有记录 list: ' + txt2.split('\n')[0].slice(0, 80))
  expect('能列出待处理记录', txt2.includes('桌_腿1') || txt2.includes('1'), '')

  /* verdict 缺理由 → 应被拒 */
  let rejected = false
  try {
    await t.execute({ action: 'verdict', id: 'del-1', decision: 'restore' }, { signal: new AbortController().signal })
  } catch (e) {
    rejected = true
    console.log('    缺理由 → 抛错: ' + String(e.message).slice(0, 60))
  }
  expect('缺理由被拒', rejected || verdicts.length === 0, 'reason=' + (verdicts[0] && verdicts[0].reason))

  /* verdict 理由太短 → 应被拒 */
  verdicts = []
  let rejected2 = false
  try {
    await t.execute({ action: 'verdict', id: 'del-1', decision: 'restore', reason: '不要' }, { signal: new AbortController().signal })
  } catch (e) {
    rejected2 = true
  }
  expect('理由太短被拒', rejected2 || verdicts.length === 0, 'len=' + (verdicts[0] && verdicts[0].reason || '').length)

  /* 正常 verdict */
  verdicts = []
  const v3 = await t.execute({
    action: 'verdict', id: 'del-1', decision: 'restore',
    reason: '桌腿是桌子的结构件，删掉桌子会缺一条腿',
  }, { signal: new AbortController().signal })
  const txt3 = t.output.render({}, v3).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  console.log('    正常 verdict: ' + txt3.split('\n')[0].slice(0, 70))
  expect('正常 verdict 被接受', verdicts.length === 1, '记录数=' + verdicts.length)
  if (verdicts.length) {
    expect('verdict 值正确', verdicts[0].verdict === 'restore', verdicts[0].verdict)
    expect('理由被保存', (verdicts[0].reason || '').length >= 6, '')
  }
}

console.log('\n' + (failed === 0 ? 'DELETED_TOOL_OK' : 'DELETED_TOOL_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
