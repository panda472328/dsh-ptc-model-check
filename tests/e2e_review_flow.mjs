/**
 * 端到端验证：我自己看图得出检测结论 → 喂回工具 → 验证解析 + 门禁。
 *
 * 这部分等价于「检测智能体返回了回答」，验证的是**下游链路**：
 *   ① 解析成清单
 *   ② 门禁拦住「没改就想停」
 *   ③ 改过之后放行
 */
import { buildTools } from '../lib/tools.mjs'

const originalFetch = globalThis.fetch
globalThis.fetch = async (_url, init) => {
  const request = JSON.parse(init.body)
  return {
    ok: true,
    async json() {
      return {
        jsonrpc: '2.0', id: request.id,
        result: { content: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }] },
      }
    },
  }
}

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

const cfg = { source:'live', blend:'', obj:'', url:'', cdpPort:0, targetMatch:'', blenderPath:'',
  minDepth:0.0005, minRatio:0.005, maxObjects:3000, maxTriangles:2000000 }

const reviewState = {
  pendingActions: [], receivedAt: 0, editsAfterReview: 0,
  lastPromptAt: 0, lastSubagentAt: 0, lastSubagentPromptCount: 0,
  reviewPromptCount: 0, reviewResultPromptCount: 0,
  lastPromptImageCount: 0, lastPromptExpectedImageCount: 0, lastPromptVisualComplete: false,
  resultValid: false, resultParsed: false, subagentCount: 0,
  latestTask: null,
}
const seg = { count: 0 }
let resolvedKind = 'live'
const meshes = ['椅_座面', '椅_靠背'].map((id, i) => ({
  id, part: id, triangles: 1,
  positions: new Float32Array([i * 2, 0, 0, i * 2 + 1, 0, 0, i * 2, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
  bbox: [i * 2, 0, 0, i * 2 + 1, 1, 0], dims: [1, 1, 0], diag: Math.sqrt(2),
  meta: { collections: ['椅子'] },
}))
const source = {
  describe: () => 'fake-live',
  async resolve() { return resolvedKind },
  async info() { return { meshes: meshes.length } },
  async extract() { return { meshes, skipped: [], source: 'fake-live' } },
  async renderShots(shots) { return { shots: shots.map((s) => ({ ...s, path: null, attached: false })) } },
  async namingScan() { return { totalMeshes: meshes.length, named: meshes.length, generic: 0, duplicates: [] } },
}

const tools = buildTools({
  sourceFor: () => source,
  config: () => cfg, remember: () => {},
  hostCtx: { get: (n) => (n === 'attachments'
    ? { saveImage: async () => ({ id: 'a' + (++seg.count) }) } : undefined) },
  getRefState: () => ({ given: false, analyzed: false }),
  markRefAnalyzed: () => {},
  getPhaseState: () => ({ modelingComplete: false }),
  markModelingComplete: () => {},
  resetPhase: () => {},
  getModelingState: () => ({ dirtySinceCheck: false, editCount: 5, lookSinceEdit: 0 }),
  noteCheck: () => {},
  noteReviewResult: (r) => {
    reviewState.pendingActions = (r.actions || []).slice()
    reviewState.receivedAt = Date.now()
    reviewState.editsAfterReview = 0
    reviewState.noChangeNeeded = !!r.noChangeNeeded
    reviewState.resultParsed = !!r.parsed
    reviewState.resultValid = !!r.valid
    reviewState.resultTechnicalOverride = !!r.technicalOverride
    reviewState.resultMode = r.mode
    reviewState.resultScope = r.scope
    reviewState.resultCoverageComplete = r.coverageComplete
    reviewState.resultVisualComplete = r.visualComplete
    reviewState.resultProvenanceComplete = r.provenanceComplete
    reviewState.resultTaskId = r.taskId
    reviewState.reviewResultPromptCount = reviewState.reviewPromptCount
  },
  getReviewState: () => ({ ...reviewState }),
  noteReviewPrompt: (info) => {
    reviewState.lastPromptAt = Date.now()
    reviewState.reviewPromptCount++
    reviewState.lastPromptImageCount = info.imageCount
    reviewState.lastPromptExpectedImageCount = info.expectedImageCount
    reviewState.lastPromptVisualComplete = info.visualComplete
    reviewState.latestTask = {
      taskId: info.taskId, mode: info.mode, target: info.target,
      scope: info.scope, coverageComplete: info.coverageComplete,
      groups: info.groups, tasks: info.tasks, outputs: {},
    }
  },
})

async function run(name, args) {
  const t = tools.find((x) => x.name === name)
  const v = await t.execute(args, { signal: new AbortController().signal })
  const blocks = t.output.render(args, v)
  return { v, text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n') }
}

/* ── 这份回答模拟检测智能体看完五视图后的输出 ──
 * 结论来自我实际看图看到的：
 *   正视：靠背和座面之间有明显缝隙
 *   左视：靠背竖板悬空，底部离座面有距离
 *   顶视：只有左侧有扶手，右侧没有 */
const reviewerAnswer = [
'## 问题 1：结构对吗',
'结论：不对，有 2 处结构问题',
'问题清单：',
'  - [椅_靠背] 靠背底部悬空，和座面之间有约 0.125 的缝，没有连接 → 把靠背下移 0.13 让它插进座面',
'  - [椅_腿4] 这条腿比其他三条短 0.05，悬空没落地 → 加长到和其余三条一样',
'',
'## 问题 2：现实中是这样吗',
'结论：不是，有 1 处不合理',
'问题清单：',
'  - [椅_左扶手] 只有左边有扶手，右边没有，椅子左右不对称 → 补一个右扶手，或者两个都去掉',
'',
'## 问题 3：还能更好吗',
'结论：还能改',
'改进清单：',
'  - [椅_座面] [顶视图] 座面是整块光板，没有分缝 → 分成 3 段各留 2mm 缝',
'  - [椅_靠背] [正视] 靠背是平板，没有倒角 → 四边加 5mm 倒角',
'',
'## 必须修的（优先级排序）',
'1. [椅_靠背] 悬空没连接 → 下移 0.13 插进座面',
'2. [椅_腿4] 短了 0.05 悬空 → 加长到与其余三条一致',
'3. [椅_左扶手] 只做了一边 → 补右扶手或两边都去掉',
].join('\n')

console.log('=== 1. 回传检测结果 → 解析成清单 ===')
const prompt = await run('model_review', { scene_note: '测试：结构合理的椅子' })
expect('先取得复核任务文本', !!prompt.v.reviewerPrompt, '')
reviewState.latestTask.outputs[reviewState.latestTask.tasks[0].token] = [reviewerAnswer]
reviewState.subagentCount++
const applied = await run('model_review', { apply_result: reviewerAnswer })
console.log(applied.text.split('\n').slice(0, 16).join('\n'))
expect('解析成功', applied.v.parsed === true, String(applied.v.parsed))
expect('抽出 3 条必改', applied.v.actionCount === 3, String(applied.v.actionCount))
expect('三个结论都抽到', Object.keys(applied.v.conclusions || {}).length === 3,
  JSON.stringify(applied.v.conclusions))
expect('记账了 pendingActions', reviewState.pendingActions.length === 3,
  String(reviewState.pendingActions.length))
expect('指令说必须修改', /必须修改/.test(applied.text), '')

console.log('\n=== 2. 一条没改就想 done → 应被拦 ===')
{
  const lt = tools.find((x) => x.name === 'model_loop')
  const exec = { signal: new AbortController().signal }
  await lt.execute({ reset: true, verdict: 'continue', next_improvement: 'X' }, exec)
  await lt.execute({ verdict: 'continue', landed_previous: true, next_improvement: 'Y' }, exec)
  await lt.execute({ verdict: 'continue', landed_previous: true, next_improvement: 'Z' }, exec)
  const v = await lt.execute({
    verdict: 'done', landed_previous: true,
    stop_reason: '外形完成', detail_notes: '加了倒角和分缝，结构检查通过',
  }, exec)
  const text = lt.output.render({}, v).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  console.log('  canStop: ' + v.canStop)
  console.log('  相关阻断: ' + JSON.stringify(v.stopBlockers.filter((b) => /视觉检测/.test(b))))
  expect('没改就停 → 被拦', v.canStop === false, String(v.canStop))
  expect('阻断语提到视觉检测', v.stopBlockers.some((b) => /视觉检测/.test(b)), '')
  expect('文案列出待改条目', /椅_靠背/.test(text) && /椅_腿4/.test(text), text.slice(-500))
}

console.log('\n=== 3. 改过之后 → 放行 ===')
{
  reviewState.editsAfterReview = 3
  const followup = await run('model_review', { scene_note: '复查椅子改动后的结构' })
  expect('生成改动后的复查任务', !!followup.v.reviewerPrompt, '')
  const lt = tools.find((x) => x.name === 'model_loop')
  const exec = { signal: new AbortController().signal }
  const waiting = await lt.execute({ verdict: 'done', stop_reason: '等待复查' }, exec)
  expect('复查结果回传前不能放行', waiting.stopped === false,
    JSON.stringify(waiting.stopBlockers))
  const clearedAnswer = [
      '## 问题 1：结构对吗', '结论：连接完整',
      '## 问题 2：现实中是这样吗', '结论：比例合理',
      '## 问题 3：还能更好吗', '结论：已到位',
      '## 必须修的（优先级排序）', '无需修改', '依据：正后左右顶视图均已检查。',
    ].join('\n')
  reviewState.latestTask.outputs[reviewState.latestTask.tasks[0].token] = [clearedAnswer]
  reviewState.subagentCount++
  const followupApplied = await run('model_review', {
    apply_result: clearedAnswer,
  })
  expect('复查结果被有效解析', followupApplied.v.valid === true, JSON.stringify(followupApplied.v))
  const v = await lt.execute({
    verdict: 'done', landed_previous: true,
    stop_reason: '按检测清单改完了', detail_notes: '靠背下移插进座面、腿4加长、补了右扶手',
  }, exec)
  const text = lt.output.render({}, v).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  console.log('  canStop: ' + v.canStop + '  blockers: ' + JSON.stringify(v.stopBlockers))
  expect('改过之后放行', v.canStop === true, JSON.stringify(v.stopBlockers))
  expect('文案确认视觉复核有效', /视觉复核结果有效，且没有未处理的修改项/.test(text), text.slice(-400))
}

console.log('\n' + (failed === 0 ? 'E2E_REVIEW_FLOW_OK' : 'E2E_REVIEW_FLOW_FAILED ' + failed))
globalThis.fetch = originalFetch
process.exitCode = failed === 0 ? 0 : 1
