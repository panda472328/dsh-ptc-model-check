/** 离线验证自查、独立证据、多组清单与局部复查，不创建真实子代理。 */
import assert from 'node:assert/strict'
import { buildTools } from '../lib/tools.mjs'
import { makeMesh } from '../lib/core/geometry.mjs'
import { ReviewProvenance } from '../lib/core/review-provenance.mjs'
import { mergeReviewActions, parseReviewResults } from '../lib/core/review.mjs'

const originalFetch = globalThis.fetch
let imagesAvailable = true
globalThis.fetch = async (_url, init) => ({
  ok: true,
  json: async () => ({ jsonrpc: '2.0', id: JSON.parse(init.body).id,
    result: imagesAvailable
      ? { content: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }] }
      : { isError: true, content: [{ type: 'text', text: 'no image' }] },
  }),
})

const meshes = ['A', 'B'].map((id, i) => makeMesh(id, id,
  new Float64Array([i * 3, 0, 0, i * 3 + 1, 0, 0, i * 3, 1, 0]),
  new Uint32Array([0, 1, 2]), { collections: [id] }))
const provenance = new ReviewProvenance()
const state = { reviewPromptCount: 0, reviewResultPromptCount: 0 }
let applied = null
const tools = buildTools({
  sourceFor: () => ({
    describe: () => 'fake-live', resolve: async () => 'live',
    extract: async () => ({ meshes, skipped: [] }),
  }),
  config: () => ({ minDepth: 0.0005, minRatio: 0.005 }),
  hostCtx: { get: () => ({ saveImage: async () => ({ id: 'image', width: 100, height: 100 }) }) },
  getReviewState: () => ({ ...state, latestTask: provenance.snapshot() }),
  noteReviewPrompt(info) {
    state.reviewPromptCount++
    state.lastPromptExpectedImageCount = info.expectedImageCount
    state.lastPromptImageCount = info.imageCount
    state.lastPromptVisualComplete = info.visualComplete
    provenance.begin(info)
  },
  noteReviewResult(result) {
    applied = result
    state.reviewResultPromptCount = state.reviewPromptCount
  },
})
const tool = tools.find((item) => item.name === 'model_review')
const call = (args) => tool.execute(args, {})
const answer = (action) => '## 问题 1：结构对吗\n结论：结构符合要求\n'
  + '## 问题 2：现实中是这样吗\n结论：符合任务设定\n'
  + '## 问题 3：还能更好吗\n结论：' + (action ? '需修改所列位置' : '已到位') + '\n'
  + '## 必须修的（优先级排序）\n' + (action ? '1. ' + action : '无需修改\n依据：逐组检查所附视图与结构')

try {
  const self = await call({ reviewer: 'self', include_data: false })
  assert.equal(self.reviewer, 'self')
  assert.equal(self.parallelDispatch, false)
  assert.equal(self.dispatchPolicy, 'self')
  assert.equal(self.reviewTasks.length, 1, 'self-review uses a single task without subagent dispatch')
  assert.equal(self.visualComplete, true)
  await assert.rejects(call({ apply_result: answer() }), /没有收到完整/)
  const selfResult = await call({ apply_result: answer() + '\n' + self.reviewTasks[0].token })
  assert.equal(selfResult.valid, true)
  assert.equal(selfResult.provenanceComplete, false)
  assert.equal(selfResult.technicalOverride, false, 'self-review never overrides technical findings')
  assert.equal(applied.reviewer, 'self')
  await assert.rejects(call({ apply_result: answer() + '\n' + self.reviewTasks[0].token }), /没有收到完整/)

  const independent = await call({ include_data: false })
  assert.equal(independent.reviewTasks.length, 2)
  assert.equal(independent.parallelDispatch, true, 'independent groups can be dispatched in parallel')
  assert.equal(independent.parallelRequired, false, 'parallel capability does not require simultaneous dispatch')
  assert.equal(independent.dispatchPolicy, 'available_concurrency')
  assert.ok(independent.reviewTasks.every((t) => t.prompt.includes('不把参考实例的尺寸、数量或比例当成默认硬要求')))
  await assert.rejects(call({ reviewer: 'self', apply_result: answer() + '\n' + independent.reviewTasks[0].token }),
    /没有收到完整/, 'changing the apply arguments cannot bypass independent provenance')
  const outputs = independent.reviewTasks.map((task, i) => {
    const text = answer(i === 1 ? '[B] 开口过浅 → 加深开口' : null)
    provenance.register(task.prompt, 'simulated-' + i)
    assert.equal(provenance.complete('simulated-' + i, 'completed', text), true)
    return text
  })
  const result = await call({ apply_result: outputs.join('\n\n') })
  assert.equal(result.valid, true)
  assert.deepEqual(result.actions, ['[B] 开口过浅 → 加深开口'], 'the second group action is retained')
  assert.equal(result.noChangeNeeded, false)
  assert.equal(applied.groupActions[1].groups[0], 'B')
  assert.equal(parseReviewResults([answer(), 'incomplete response']).valid, false,
    'one well-formed group cannot hide another malformed result')

  const blocks = tool.output.render({}, independent)
  const summary = blocks.find((block) => block.type === 'text' && block.text.startsWith('{'))
  const payload = JSON.parse(summary.text)
  assert.equal(payload.reviewerPrompt, undefined)
  assert.equal(payload.reviewTasks[0].prompt, undefined, 'task text is not repeated in the JSON summary')

  imagesAvailable = false
  const missing = await call({ reviewer: 'self', include_data: false })
  const missingResult = await call({ apply_result: answer() + '\n' + missing.reviewTasks[0].token })
  assert.equal(missingResult.valid, false, 'self-review without images cannot claim visual validation')
} finally {
  globalThis.fetch = originalFetch
}

const initial = mergeReviewActions({}, { valid: true, scope: 'scene', coverageComplete: true,
  groups: ['A', 'B'], groupActions: [{ groups: ['A'], actions: ['修 A'] }, { groups: ['B'], actions: ['修 B'] }] })
const afterA = mergeReviewActions(initial, { valid: true, scope: 'group', groups: ['A'], actions: [] })
assert.deepEqual(afterA, { B: ['修 B'] }, 'a local clean review preserves other pending groups')
assert.deepEqual(mergeReviewActions(afterA, { valid: false, scope: 'scene', coverageComplete: true,
  groups: ['A', 'B'], actions: [] }), afterA, 'invalid results do not clear pending work')
assert.deepEqual(mergeReviewActions(afterA, { valid: true, scope: 'scene', coverageComplete: true,
  groups: ['A', 'B'], actions: [] }), {})
console.log('REVIEW_MODES_OK')
