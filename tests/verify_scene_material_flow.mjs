/** 实际宿主记忆注入、单组场景与真实材质出图通路；不连接 Blender。 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WorkMemory } from '../lib/core/work-memory.mjs'
import { buildSceneDetailGuidance } from '../lib/core/detail.mjs'
import { buildReviewerPrompt } from '../lib/core/review.mjs'
import { createHostFixture } from './host_fixture.mjs'
import { buildTools } from '../lib/tools.mjs'
import { makeMesh } from '../lib/core/geometry.mjs'

const memory = new WorkMemory()
const dir = mkdtempSync(path.join(tmpdir(), 'ptc-scene-intent-'))
try {
  const file = path.join(dir, 'memory.json')
  memory.update({ memory_file: file, brief: '构建工厂园区', scope: 'scene',
    layout: '生产区连接运输通道，配套区位于次要一侧，入口保持可达',
    material_intent: '维护正常的涂层与金属，干净底材，纹理按尺度',
    tasks: [{ id: 'zones', title: '先搭各区体块与运输通道' }] })
  memory.update({ tasks: [{ id: 'roof', title: '细化主厂房屋顶', status: 'active' }] })
  const restored = new WorkMemory()
  restored.update({ memory_file: file })
  assert.deepEqual(restored.design(), memory.design())
  assert.match(restored.context(), /整体布局意图：.*运输通道/)
  assert.match(restored.context(), /材质意图：维护正常/)
  assert.equal(restored.snapshot().open, 2)
  const old = path.join(dir, 'old.json')
  writeFileSync(old, JSON.stringify({ schema: 'ptc-work-memory-v1', brief: '旧任务', items: [] }))
  restored.reset()
  restored.update({ memory_file: old })
  assert.deepEqual(restored.design(), { scope: '', layout: '', materialIntent: '' })
  assert.throws(() => restored.update({ scope: 'palace' }), /scope/)
} finally { rmSync(dir, { recursive: true, force: true }) }

const designIntent = memory.design()
for (const groups of [[], [{ name: '主厂房' }]]) {
  const guidance = buildSceneDetailGuidance({ groups, designIntent, round: 12 })
  assert.equal(guidance.active, true, 'scope comes from intent before multiple groups exist')
  assert.match(guidance.next, /运输通道/)
}
const groups = [{ name: '主厂房' }, { name: '配套区' }]
for (const scope of ['single', 'local']) {
  assert.equal(buildSceneDetailGuidance({ groups, designIntent: { scope } }).active, false)
}
assert.equal(buildSceneDetailGuidance({ groups, designIntent, target: '主厂房' }).active, false)
assert.equal(buildSceneDetailGuidance({ groups, designIntent, modelingComplete: true }).active, false)
const prompt = buildReviewerPrompt({ target: '整场景', groups: [groups[0]], designIntent, imageCount: 7 })
assert.match(prompt, /只有一个组时也要核对/)
assert.match(prompt, /生产区连接运输通道/)

const mesh = (id, i = 0) => makeMesh(id, id,
  new Float64Array([i * 3, 0, 0, i * 3 + 1, 0, 0, i * 3, 1, 0]),
  new Uint32Array([0, 1, 2]), { collections: [id] })
const host = await createHostFixture([mesh('主厂房')])
try {
  const source = host.tools.get('model_source')
  await source.execute({ action: 'memory', scope: 'scene', layout: designIntent.layout,
    material_intent: designIntent.materialIntent, tasks: [{ id: 'route', title: '补运输通道' }] }, {})
  assert.match(host.runtime(), /整体布局意图：.*运输通道/)
  assert.match(host.runtime(), /待做：补运输通道/)
  const loop = await host.tools.get('model_loop').execute({ quick_check: true,
    verdict: 'continue', next_improvement: '落实全局体块' }, {})
  assert.equal(loop.sceneDetail.active, true)
  assert.equal(loop.sceneDetail.groupCount, 1)
  assert.match(host.runtime(), /场景级下一步：.*运输通道/)
  // 范围更改后，运行时不能复用旧 loop 的场景指导。
  await source.execute({ action: 'memory', scope: 'single', layout: '' }, {})
  assert.doesNotMatch(host.runtime(), /场景级下一步：/)
  await source.execute({ action: 'memory', reset_memory: true }, {})
  assert.doesNotMatch(host.runtime(), /任务记忆|运输通道/)
} finally { host.dispose() }

const originalFetch = globalThis.fetch
const requests = []
let meshes = [mesh('主厂房')]
let failGlobal = false
let blank = false
globalThis.fetch = async (url, init) => {
  const request = JSON.parse(init.body)
  const args = request.params.arguments
  requests.push({ url, ...args })
  return { json: async () => ({ result: failGlobal && !args.focus
    ? { isError: true, content: [{ type: 'text', text: 'global render unavailable' }] }
    : { content: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }],
      structuredContent: blank ? { warning: '画面疑似全黑' } : {} } }) }
}
const endpoint = 'http://127.0.0.1:9999/mock-only'
try {
  const tools = buildTools({
    sourceFor: () => ({ describe: () => 'fixture', resolve: async () => 'live',
      extract: async () => ({ meshes, skipped: [] }) }),
    config: () => ({ mcpUrl: endpoint }), workMemory: memory,
    hostCtx: { get: () => ({ saveImage: async () => ({ attachmentId: 'fixture', width: 100, height: 100 }) }) },
  })
  const review = tools.find(x => x.name === 'model_review')
  const call = (args = {}) => review.execute({ reviewer: 'self', include_data: false, ...args }, {})
  const material = await call({ mode: 'material' })
  assert.equal(material.visualComplete, true)
  assert.equal(material.imageCount, 7)
  assert.equal(material.sceneReview.imageCount, 2)
  assert.ok(requests.every(x => x.shading === 'rendered' && x.url === endpoint))
  assert.ok(requests.slice(-2).every(x => !x.hide_others && !x.focus))
  assert.match(material.reviewerPrompt, /维护正常的涂层与金属/)
  assert.match(material.reviewerPrompt, /灯光、曝光、采样噪点/)
  assert.equal(material.reviewTasks.length, 1, 'self review does not add parallel agents')
  assert.equal(material.parallelDispatch, false)

  requests.length = 0
  const local = await call({ target: '主厂房' })
  assert.equal(local.imageCount, 5)
  assert.equal(local.sceneReview.active, false)
  assert.ok(requests.every(x => x.shading === 'solid' && x.hide_others))

  failGlobal = true
  const incomplete = await call()
  assert.equal(incomplete.visualComplete, false)
  assert.equal(incomplete.sceneReview.visualComplete, false)
  assert.equal(incomplete.imageCount, 5)
  failGlobal = false
  blank = true
  assert.equal((await call({ mode: 'material' })).visualComplete, false)
  blank = false

  meshes = Array.from({ length: 7 }, (_, i) => mesh('组' + i, i))
  requests.length = 0
  const many = await call({ mode: 'material' })
  assert.equal(many.visualComplete, true, 'selected groups are not silently capped at six')
  assert.equal(many.imageCount, 37)
  assert.equal(many.expectedImageCount, 37)
} finally { globalThis.fetch = originalFetch }
console.log('SCENE_MATERIAL_FLOW_OK: durable intent, live context, one-group scene, rendered review and coverage')
