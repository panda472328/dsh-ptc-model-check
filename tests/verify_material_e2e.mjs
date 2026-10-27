/**
 * 端到端：材质阶段实跑一遍，看任务文本对不对。
 */
const URL = 'http://127.0.0.1:8765/mcp'
let seq = 0
async function mcp(n, a = {}) {
  const r = await fetch(URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name: n, arguments: a } }),
  }).then((x) => x.json()).catch(() => null)
  if (!r) return { isError: true, text: '失败' }
  const c = (r.result && r.result.content) || []
  return { isError: !!r.result?.isError, text: c.map((x) => x.text || '').join(' ') }
}

import { SceneSource } from '../lib/adapters/index.mjs'
import { buildTools } from '../lib/tools.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = path.resolve(HERE, '..')

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

console.log('=== 建场景并上材质 ===')
await mcp('execute_python', {
  code: [
    'import bpy',
    'for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)',
    'for c in list(bpy.data.collections): bpy.data.collections.remove(c)',
    'for m in list(bpy.data.materials): bpy.data.materials.remove(m)',
    'bpy.ops.mesh.primitive_cube_add(size=1, location=(0,0,0.5))',
    'o = bpy.context.view_layer.objects.active',
    'o.name = "木箱_主体"',
    'bpy.ops.mesh.primitive_cube_add(size=0.2, location=(0.6,0,0.1))',
    'o2 = bpy.context.view_layer.objects.active',
    'o2.name = "木箱_搭扣"',
    'coll = bpy.data.collections.new("木箱")',
    'bpy.context.scene.collection.children.link(coll)',
    'for n in ["木箱_主体","木箱_搭扣"]:',
    '    ob = bpy.data.objects[n]',
    '    if ob.name in bpy.context.scene.collection.objects:',
    '        bpy.context.scene.collection.objects.unlink(ob)',
    '    coll.objects.link(ob)',
    'm = bpy.data.materials.new("旧木箱")',
    'm.use_nodes = True',
    'o.data.materials.append(m)',
    'print("场景就绪：木箱组 2 件，已赋材质")',
  ].join('\n'),
})

const cfg = { source:'auto', blend:'', obj:'', url:'', cdpPort:0, targetMatch:'', blenderPath:'',
  minDepth:0.0005, minRatio:0.005, maxObjects:3000, maxTriangles:2000000 }

const rs = { pendingActions: [], receivedAt: 0, editsAfterReview: 0, lastPromptAt: 0,
  lastSubagentAt: 0, lastMode: null, lastTarget: null, reviewedGroups: {},
  reviewPromptCount: 0, reviewResultPromptCount: 0, lastPromptImageCount: 0,
  lastPromptExpectedImageCount: 0, lastPromptVisualComplete: false, latestTask: null }
const mst = { touchedGroups: {}, editCount: 0, lastEditAt: 0 }

function makeTools() {
  rs.latestTask = null
  rs.reviewPromptCount = 0
  rs.reviewResultPromptCount = 0
  rs.pendingActions = []
  rs.receivedAt = 0
  return buildTools({
    sourceFor: () => new SceneSource({ source: 'auto' }, { packageDir: PACKAGE_DIR }),
    config: () => cfg, remember: () => {},
    hostCtx: { get: (n) => (n === 'attachments'
      ? { saveImage: async ({ name }) => ({ id: 'att_' + name, name, width: 420, height: 420 }) } : undefined) },
    getRefState: () => ({ given: false, analyzed: false }),
    markRefAnalyzed: () => {},
    getPhaseState: () => ({ modelingComplete: true }),   // 已解锁
    markModelingComplete: () => {},
    resetPhase: () => {},
    getModelingState: () => ({ dirtySinceCheck: false, editCount: 0, lookSinceEdit: 0 }),
    noteCheck: () => {},
    noteReviewResult: (r) => {
      rs.pendingActions = (r.actions || []).slice()
      rs.receivedAt = Date.now()
      rs.lastMode = r.mode
      rs.lastTarget = r.target
      rs.reviewResultPromptCount = rs.reviewPromptCount
      rs.reviewedGroups[r.target || 'scene'] = { mode: r.mode, at: Date.now() }
      if (r.mode === 'material' && mst.touchedGroups[r.target]) {
        mst.touchedGroups[r.target].reviewed = true
      }
    },
    getReviewState: () => ({ ...rs }),
    noteReviewPrompt: (info) => {
      rs.lastPromptAt = Date.now()
      if (info) {
        rs.lastMode = info.mode
        rs.lastTarget = info.target
        rs.reviewPromptCount++
        rs.lastPromptImageCount = info.imageCount
        rs.lastPromptExpectedImageCount = info.expectedImageCount
        rs.lastPromptVisualComplete = info.visualComplete
        rs.latestTask = {
          taskId: info.taskId, mode: info.mode, target: info.target,
          scope: info.scope, coverageComplete: info.coverageComplete,
          groups: info.groups, tasks: info.tasks, outputs: {},
        }
      }
    },
    getMaterialState: () => ({ ...mst, touchedGroups: { ...mst.touchedGroups } }),
    noteMaterialEdit: (tool, target) => {
      mst.editCount++
      const g = target || 'scene'
      mst.touchedGroups[g] = { at: Date.now(), tool, reviewed: false }
    },
  })
}

console.log('\n=== ① 材质模式：任务文本必须是画风导向的 ===')
{
  const tools = makeTools()
  const rt = tools.find((x) => x.name === 'model_review')
  const v = await rt.execute({
    target: '木箱',
    mode: 'material',
    style: '写实',
    scene_note: '末日废墟场景，木箱是仓库里翻出来的旧木箱',
  }, { signal: new AbortController().signal })

  const text = rt.output.render({}, v).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  const imgs = rt.output.render({}, v).filter((b) => b.type === 'image')

  console.log('  组数: ' + v.groupCount + '  图片: ' + v.imageCount + '  模式: ' + v.mode)
  expect('是材质模式', v.mode === 'material', String(v.mode))
  expect('覆盖 1 组', v.groupCount === 1, String(v.groupCount))
  expect('出了 5 张图', v.imageCount === 5, String(v.imageCount))
  expect('图片块进了输出', imgs.length === 5, String(imgs.length))

  const p = v.reviewerPrompt
  console.log('\n  --- 任务文本关键段落 ---')
  const i = p.indexOf('## 这个场景的画风')
  console.log(p.slice(i, i + 460).split('\n').map((l) => '  ' + l).join('\n'))
  console.log('\n  --- 三个问题 ---')
  for (const q of ['这个材质是它该有的画风吗', 'UV 的大小映射对吗', '还有什么可以优化的']) {
    console.log('    ' + (p.includes(q) ? '✓' : '✗') + ' ' + q)
  }
  expect('含画风声明', /\*\*画风：写实\*\*/.test(p), '')
  expect('第一问是画风', /这个材质是它该有的画风吗/.test(p), '')
  expect('不含旧问法', !/这个材质在现实中是这样的吗/.test(p), '')
  expect('告诉它组是什么', /木箱/.test(p), '')
  expect('文案提示派 subagent', /subagent/.test(text), '')
}

console.log('\n=== ② 回传检测结果（没派 subagent）→ 应被拒 ===')
{
  const tools = makeTools()
  const rt = tools.find((x) => x.name === 'model_review')
  await rt.execute({ target: '木箱', mode: 'material', style: '写实' },
    { signal: new AbortController().signal })
  /* 注意：这里没模拟派 subagent */
  let rejected = false, msg = ''
  try {
    await rt.execute({ target: '木箱', mode: 'material', apply_result: '## 必须修的\n1. x' },
      { signal: new AbortController().signal })
  } catch (e) { rejected = true; msg = String(e.message || e) }
  expect('没派 subagent → 被拒', rejected, '竟然通过了')
  expect('拒绝理由要求拿齐本轮结果', /完整的独立检测结果/.test(msg), msg.slice(0, 120))
}

console.log('\n=== ③ 派了之后回传 → 通过，并标记该组已检测 ===')
{
  const tools = makeTools()
  const rt = tools.find((x) => x.name === 'model_review')
  await rt.execute({ target: '木箱', mode: 'material', style: '写实' },
    { signal: new AbortController().signal })
  const answer = '## 必须修的（优先级排序）\n1. [木箱主体] 木纹太均匀 → 加粗糙度扰动\n2. [搭扣] 金属没做旧 → 加边缘磨损'
  rs.latestTask.outputs[rs.latestTask.tasks[0].token] = [answer]
  const v = await rt.execute({
    apply_result: answer,
  }, { signal: new AbortController().signal })
  console.log('  actionCount: ' + v.actionCount + '  模式: ' + v.mode)
  expect('解析出 2 条', v.actionCount === 2, String(v.actionCount))
  expect('模式记录为材质', v.mode === 'material', String(v.mode))
}

console.log('\n=== ④ 材质阶段进度提示（上过材质没检测 → 提示） ===')
{
  const tools = makeTools()
  /* 模拟：上过材质的组 */
  mst.editCount = 3
  mst.touchedGroups = { 木箱: { at: Date.now(), tool: 'assign_material', reviewed: false } }
  const lt = tools.find((x) => x.name === 'model_loop')
  const v = await lt.execute({ reset: true, verdict: 'continue', next_improvement: 'X', per_mesh_views: false },
    { signal: new AbortController().signal })
  const text = lt.output.render({}, v).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  const i = text.indexOf('材质阶段进度')
  console.log(i >= 0 ? text.slice(i - 40, i + 340).split('\n').map((l) => '  ' + l).join('\n') : '  （没找到进度提示）')
  expect('有进度提示', i >= 0, '')
  expect('提示哪个组没检测', /木箱/.test(text.slice(i, i + 400)), '')
  expect('说明不是硬门槛', /不是硬门槛/.test(text), '')
  expect('给出正确调用示例', /mode: 'material'/.test(text), '')
}

console.log('\n' + (failed === 0 ? 'MATERIAL_E2E_OK' : 'MATERIAL_E2E_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
