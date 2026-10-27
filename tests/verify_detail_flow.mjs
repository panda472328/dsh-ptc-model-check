/** 自主细化的工具结果与实时上下文集成验证，不连接或修改 Blender。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildTools } from '../lib/tools.mjs'
import { makeMesh } from '../lib/core/geometry.mjs'
import { buildDetailGuidance, buildSceneDetailGuidance } from '../lib/core/detail.mjs'

const mesh = makeMesh('主体', '主体', new Float64Array([
  -1, -1, -1, 1, -1, -1, -1, 1, -1, 1, 1, -1,
  -1, -1, 1, 1, -1, 1, -1, 1, 1, 1, 1, 1,
]), new Uint32Array([
  0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6,
  0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7,
  0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5,
]))
mesh.meta = { collections: ['物品'] }

// 场景级指导只在整场景有多个物品组时启用，并按轮次轮换重点。
const sceneGroups = [
  { name: '主体', parts: ['主体_壳'], triangles: 100 },
  { name: '环境', parts: ['环境_地面'], triangles: 40 },
]
const sceneStage1 = buildSceneDetailGuidance({ target: 'scene', groups: sceneGroups, round: 1, meshCount: 2 })
const sceneStage2 = buildSceneDetailGuidance({ target: 'scene', groups: sceneGroups, round: 2, meshCount: 2 })
assert.equal(sceneStage1.active, true)
assert.equal(sceneStage1.stage, '构图与层级')
assert.equal(sceneStage2.stage, '空间落点与连接')
assert.notEqual(sceneStage1.next, sceneStage2.next)
assert.equal(buildSceneDetailGuidance({ target: '主体', groups: sceneGroups, round: 1 }).active, false)
const sceneDetail = buildDetailGuidance({
  target: 'scene', sceneGroups, round: 1, quickCheck: true,
  inspectionComplete: true, groupingOk: true, visualReady: false,
})
assert.match(sceneDetail.lines.join('\n'), /场景细化.*构图与层级/)
assert.match(sceneDetail.lines.join('\n'), /不要只给单件物体加零件/)
const imagePath = fileURLToPath(new URL('./subject_fixture.png', import.meta.url))
let attachmentsAvailable = true
let renderCount = 0
let review = {}
const phase = { modelingComplete: false }
const state = { phase, review }
const source = {
  describe: () => 'fake-file',
  resolve: async () => 'file',
  extract: async () => ({ meshes: [mesh], skipped: [] }),
  async renderShots(shots) {
    renderCount++
    return { shots: shots.map((s) => ({ ...s, path: imagePath })) }
  },
}
const tools = buildTools({
  sourceFor: () => source,
  config: () => ({ minDepth: 0.0005, minRatio: 0.005 }),
  hostCtx: {
    get: () => attachmentsAvailable ? {
      saveImage: async ({ name, data }) => ({ attachmentId: name, name,
        mediaType: 'image/png', width: 100, height: 100, bytes: data.length }),
    } : undefined,
  },
  getPhaseState: () => phase,
  markModelingComplete: () => { phase.modelingComplete = true },
  resetPhase: () => { phase.modelingComplete = false },
  getReviewState: () => review,
  remember: (name, value) => { state[name] = value },
})
const loop = tools.find((t) => t.name === 'model_loop')
const call = (args) => loop.execute(args, { signal: new AbortController().signal })
const text = (value) => loop.output.render({}, value)
  .filter((block) => block.type === 'text').map((block) => block.text).join('\n')
const setReview = (value) => { review = value; state.review = value }

// 技术检查通过仍主动细化；快速检查不额外渲染、不冒充视觉判断。
const quick = await call({ quick_check: true, verdict: 'continue', next_improvement: '补主体连接结构' })
assert.equal(quick.pass, true)
assert.equal(renderCount, 0)
assert.equal(quick.detailGuidance.stage, 'prepare_visual')
assert.match(text(quick), /不能据技术通过认定细节到位/)

const full = await call({ verdict: 'continue', next_improvement: '看图补结构缺口' })
assert.equal(renderCount, 1)
assert.equal(full.detailGuidance.stage, 'assess_detail')
assert.match(text(full), /连接与功能结构、表面几何层次/)

attachmentsAvailable = false
const missing = await call({ verdict: 'continue', next_improvement: '恢复视图' })
assert.equal(missing.detailGuidance.stage, 'restore_views')
assert.match(text(missing), /不要编造看图结论/)
attachmentsAvailable = true

// 同一场景从等待复核、修改到复查；指导不得让无关改动自动清掉待办。
setReview({ reviewPromptCount: 1, reviewResultPromptCount: 0,
  lastPromptExpectedImageCount: 5, lastPromptVisualComplete: true })
const waiting = await call({ quick_check: true, verdict: 'continue', next_improvement: '等待复核' })
assert.equal(waiting.detailGuidance.stage, 'await_review')
setReview({ reviewPromptCount: 1, reviewResultPromptCount: 1,
  receivedAt: 1, resultValid: true, pendingActions: ['补连接板'], editsAfterReview: 0 })
const revise = await call({ quick_check: true, verdict: 'continue', next_improvement: '补连接板' })
assert.equal(revise.detailGuidance.stage, 'revise')
review.editsAfterReview = 1
const verify = await call({ quick_check: true, verdict: 'continue', next_improvement: '复查连接板' })
assert.equal(verify.detailGuidance.stage, 'verify_revision')
assert.equal(verify.canStop, false)

// 不导入缺少 peer dependency 的宿主入口，直接执行实际上下文组装函数。
const index = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const runtimeSource = index.slice(index.indexOf('function buildStateText(state) {'))
const buildStateText = new Function('PLUGIN_VERSION', 'buildDetailGuidance',
  runtimeSource + '\nreturn buildStateText')('test', buildDetailGuidance)
state.loop = waiting // 故意保留旧 loop；复核可以在两次 loop 之间结束。
let runtime = buildStateText(state)
assert.match(runtime, /自主细化下一步：已记录复核后的改动/)
assert.doesNotMatch(runtime, /自主细化下一步：先完成当前独立视觉复核/)
setReview({ reviewPromptCount: 1, reviewResultPromptCount: 1,
  receivedAt: 1, resultValid: true, pendingActions: [] })
runtime = buildStateText(state)
assert.match(runtime, /自主细化下一步：本轮未渲图/)
assert.doesNotMatch(runtime, /自主细化下一步：已记录复核后的改动/)

setReview({ reviewPromptCount: 2, reviewResultPromptCount: 1,
  lastPromptExpectedImageCount: 5, lastPromptVisualComplete: false })
const incomplete = await call({ quick_check: true, verdict: 'continue', next_improvement: '补复核图片' })
assert.equal(incomplete.detailGuidance.stage, 'restore_views')
assert.doesNotMatch(incomplete.detailGuidance.next, /不要另起重复复核任务/)

setReview({ reviewPromptCount: 2, reviewResultPromptCount: 2, receivedAt: 1, resultValid: false })
const invalid = await call({ quick_check: true, verdict: 'continue', next_improvement: '重新取得有效复核' })
assert.equal(invalid.detailGuidance.stage, 'repeat_review')

// 正常签收不增加凑细节门槛；材质阶段停止催促几何细化。
setReview({})
const done = await call({ verdict: 'done', stop_reason: '用户要求的简约主体已完整，继续留白' })
assert.equal(done.stopped, true)
assert.equal(done.detailGuidance.stage, 'complete')
assert.equal(done.detailGuidance.next, '')
assert.equal(phase.modelingComplete, true)
assert.doesNotMatch(buildStateText(state), /默认自主细化：|自主细化下一步：/)

// model_loop 会把多组场景的阶段状态写回工具结果，供下一轮上下文继续使用。
const secondMesh = makeMesh('环境_地面', '环境_地面', new Float64Array([
  3, -1, -1, 5, -1, -1, 3, 1, -1, 5, 1, -1,
  3, -1, 1, 5, -1, 1, 3, 1, 1, 5, 1, 1,
]), new Uint32Array([
  0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6,
  0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7,
  0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5,
]))
secondMesh.meta = { collections: ['环境'] }
const multiPhase = { modelingComplete: false }
const multiState = {}
const multiTools = buildTools({
  sourceFor: () => ({
    describe: () => 'fake-multi',
    resolve: async () => 'file',
    extract: async () => ({ meshes: [mesh, secondMesh], skipped: [] }),
    renderShots: async () => ({ shots: [] }),
  }),
  config: () => ({ minDepth: 0.0005, minRatio: 0.005 }),
  hostCtx: { get: () => undefined },
  getPhaseState: () => multiPhase,
  markModelingComplete: () => { multiPhase.modelingComplete = true },
  resetPhase: () => { multiPhase.modelingComplete = false },
  getReviewState: () => ({}),
  remember: (name, value) => { multiState[name] = value },
})
const multiLoop = multiTools.find((t) => t.name === 'model_loop')
const multiResult = await multiLoop.execute({
  quick_check: true, verdict: 'continue', next_improvement: '先处理场景空间关系',
}, { signal: new AbortController().signal })
assert.equal(multiResult.sceneDetail.active, true)
assert.equal(multiResult.sceneDetail.groupCount, 2)
assert.equal(multiState.loop.sceneDetail.stage, '构图与层级')

console.log('DETAIL_FLOW_OK：技术通过、缺图、复核待办、实时状态、签收与材质阶段验证通过')
