/**
 * 验证「必须真的派检测智能体」门禁。
 *
 * 背景：
 *   model_review({ apply_result }) 是回传检测结论的入口。
 *   不拦的话，主智能体可以不派 subagent、自己编一段符合格式的回答回传——
 *   那就回到了「自己评判自己」，专职检测机制白设。
 *
 * 检验三种情形：
 *   ① 没派 subagent 就回传 → 拒绝
 *   ② 派了 subagent 之后回传 → 通过
 *   ③ 从没拿过任务文本就回传 → 也拒绝（说明流程没走）
 *
 *   node tests/verify_review_must_dispatch.mjs
 */

import { buildTools } from '../lib/tools.mjs'

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

/* 模拟插件的状态 */
const rs = {
  pendingActions: [],
  receivedAt: 0,
  noChangeNeeded: false,
  conclusions: {},
  editsAfterReview: 0,
  lastSubagentAt: 0,
  subagentCount: 0,
  lastPromptAt: 0,
  latestTask: null,
  lastPromptVisualComplete: true,
  lastPromptImageCount: 5,
  lastPromptExpectedImageCount: 5,
  resultValid: false,
  resultTechnicalOverride: false,
  resultMode: null,
  resultScope: null,
  resultCoverageComplete: false,
  resultVisualComplete: false,
  resultProvenanceComplete: false,
  resultTaskId: null,
  reviewPromptCount: 0,
  reviewResultPromptCount: 0,
}

function makeTools() {
  rs.latestTask = null
  rs.receivedAt = 0
  rs.pendingActions = []
  rs.subagentCount = 0
  rs.reviewPromptCount = 0
  rs.reviewResultPromptCount = 0
  return buildTools({
    sourceFor: () => ({
      describe: () => 'live', async resolve() { return 'live' },
      async info() { return { meshes: 1 } },
      async extract() {
        const mk = (id, cx) => ({
          id, part: id, triangles: 12,
          positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          indices: new Uint32Array([0, 1, 2]),
          bbox: [cx, 0, 0, cx + 1, 1, 1], dims: [1, 1, 1], diag: 1.7,
          meta: { collections: ['测试物品'] },
        })
        return { meshes: [mk('甲', 0), mk('甲伴', 0.9)], skipped: [], source: 'fake' }
      },
      async namingScan() { return { totalMeshes: 2, named: 2, generic: 0, duplicates: [] } },
      async renderShots(s) { return { shots: s.map((x) => ({ ...x, path: null, attached: false })) } },
      async dispose() {},
    }),
    config: () => ({ maxObjects: 100, maxTriangles: 1000, minDepth: 0.0005, minRatio: 0.005 }),
    remember: () => {},
    hostCtx: { get: (n) => (n === 'attachments'
      ? { saveImage: async () => ({ id: 'a1', width: 100, height: 100 }) } : undefined) },
    getRefState: () => ({ given: false, analyzed: false }),
    markRefAnalyzed: () => {},
    getPhaseState: () => ({ modelingComplete: false }),
    markModelingComplete: () => {},
    resetPhase: () => {},
    getModelingState: () => ({ dirtySinceCheck: false, editCount: 0, lookSinceEdit: 0 }),
    noteCheck: () => {},
    noteReviewResult: (r) => {
      rs.pendingActions = (r.actions || []).slice()
      rs.receivedAt = Date.now()
      rs.editsAfterReview = 0
      rs.resultValid = r.valid
      rs.resultTechnicalOverride = r.technicalOverride
      rs.resultMode = r.mode
      rs.resultScope = r.scope
      rs.resultCoverageComplete = r.coverageComplete
      rs.resultVisualComplete = r.visualComplete
      rs.resultProvenanceComplete = r.provenanceComplete
      rs.resultTaskId = r.taskId
      rs.reviewResultPromptCount = rs.reviewPromptCount
    },
    getReviewState: () => ({ ...rs }),
    /* 这里模拟插件在拿到任务文本时记账 */
    noteReviewPrompt: (info) => {
      rs.lastPromptAt = Date.now()
      rs.reviewPromptCount++
      rs.lastPromptVisualComplete = info.visualComplete
      rs.lastPromptImageCount = info.imageCount
      rs.lastPromptExpectedImageCount = info.expectedImageCount
      rs.latestTask = {
        taskId: info.taskId,
        mode: info.mode,
        target: info.target,
        scope: info.scope,
        coverageComplete: info.coverageComplete,
        groups: info.groups,
        tasks: info.tasks,
        outputs: {},
      }
    },
  })
}

const ANSWER = '## 必须修的（优先级排序）\n1. [测试物品] 甲和甲伴没有连接 → 加一块连接板'

async function tryApply(tools, label) {
  const rt = tools.find((x) => x.name === 'model_review')
  try {
    const v = await rt.execute({ apply_result: ANSWER }, { signal: new AbortController().signal })
    return { ok: true, v }
  } catch (e) {
    return { ok: false, msg: String(e.message || e) }
  }
}

console.log('=== ① 从没拿过任务文本就回传 → 拒绝 ===')
{
  const tools = makeTools()
  const r = await tryApply(tools, '从没拿过任务文本')
  console.log('  结果: ' + (r.ok ? '通过了（不该通过）' : '被拒'))
  expect('被拒绝', r.ok === false, '竟然通过了')
  if (!r.ok) console.log('  理由开头: ' + r.msg.split('\n')[0])
}

console.log('\n=== ② 拿了任务文本但没派 subagent → 拒绝 ===')
{
  const tools = makeTools()
  /* 先拿任务文本 */
  const rt = tools.find((x) => x.name === 'model_review')
  await rt.execute({ scene_note: '测试场景' }, { signal: new AbortController().signal })
  console.log('  lastPromptAt: ' + (rs.lastPromptAt ? '已记录' : '未记录'))
  console.log('  lastSubagentAt: ' + (rs.lastSubagentAt || '未记录（没派）'))

  const r = await tryApply(tools, '没派 subagent')
  console.log('  结果: ' + (r.ok ? '通过了（不该通过）' : '被拒'))
  expect('被拒绝', r.ok === false, '竟然通过了')
  if (!r.ok) {
    console.log('\n  --- 拒绝理由 ---')
    console.log('  ' + r.msg.split('\n').slice(0, 14).join('\n  '))
    expect('理由要求按三步完成', /正确顺序是三步/.test(r.msg), r.msg.slice(0, 200))
    expect('理由给出 subagent 调用示例', /subagent\(/.test(r.msg), '')
    expect('理由说明失败启动/空结果会被拒绝', /失败启动|空结果/.test(r.msg), '')
  }
}

console.log('\n=== ③ 派了 subagent 之后回传 → 通过 ===')
{
  const tools = makeTools()
  const rt = tools.find((x) => x.name === 'model_review')
  await rt.execute({ scene_note: '测试场景' }, { signal: new AbortController().signal })
  /* 模拟插件在 subagent 被调用时记账 */
  rs.latestTask.outputs[rs.latestTask.tasks[0].token] = [ANSWER]
  rs.lastSubagentAt = Date.now()
  rs.subagentCount = 1

  const r = await tryApply(tools, '派了 subagent')
  console.log('  结果: ' + (r.ok ? '通过' : '被拒'))
  expect('完整独立结果可回传', r.ok === true, r.msg)
  if (r.ok) {
    console.log('  actionCount: ' + r.v.actionCount)
    expect('解析出修改清单', r.v.actionCount === 1, String(r.v.actionCount))
    expect('记账了 pendingActions', rs.pendingActions.length === 1,
      String(rs.pendingActions.length))
  }
}

console.log('\n=== ④ 派过之后再拿新任务文本（新一轮）→ 又要重派 ===')
{
  const tools = makeTools()
  const rt = tools.find((x) => x.name === 'model_review')
  await rt.execute({ scene_note: '第一轮' }, { signal: new AbortController().signal })
  rs.latestTask.outputs[rs.latestTask.tasks[0].token] = [ANSWER]
  const r1 = await tryApply(tools, '第一轮')
  expect('第一轮通过', r1.ok === true, r1.msg)

  /* 新一轮：又拿了一次任务文本，时间戳更新 */
  await new Promise((res) => setTimeout(res, 15))
  await rt.execute({ scene_note: '第二轮' }, { signal: new AbortController().signal })
  rs.latestTask.outputs = {}
  const r2 = await tryApply(tools, '第二轮（还没派）')
  console.log('  第二轮结果: ' + (r2.ok ? '通过了（不该通过）' : '被拒'))
  expect('新一轮没派 → 又被拒', r2.ok === false, '竟然通过了')
}

console.log('\n=== ⑤ 多组任务漏派/漏回传 → 拒绝 ===')
{
  const tools = makeTools()
  const rt = tools.find((x) => x.name === 'model_review')
  await rt.execute({ scene_note: '多组复核' }, { signal: new AbortController().signal })
  rs.latestTask.tasks = [
    { token: 'review-A', groups: ['A'] },
    { token: 'review-B', groups: ['B'] },
  ]
  rs.latestTask.outputs = {
    'review-A': [ANSWER],
    'review-B': [ANSWER + '\n2. [B] 连接错误 → 修复'],
  }
  const r = await tryApply(tools, '只汇总 A 组')
  expect('另一组完整结果没包含在回传中则拒绝', r.ok === false,
    r.ok ? '漏了 B 组仍通过' : r.msg)
  expect('拒绝信息要求完整结果', !r.ok && /完整的独立检测结果/.test(r.msg), r.msg)
}

console.log('\n' + (failed === 0 ? 'MUST_DISPATCH_OK' : 'MUST_DISPATCH_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
