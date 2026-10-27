/**
 * 验证「每个组都出图」在真实多组场景下的表现。
 *   node tests/verify_all_groups_render.mjs
 */

const URL = 'http://127.0.0.1:8765/mcp'
let seq = 0
async function mcp(n, a = {}) {
  const r = await fetch(URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name: n, arguments: a } }),
  }).then((x) => x.json()).catch(() => null)
  if (!r) return { isError: true, text: '连接失败' }
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

const ping = await mcp('ping')
if (ping.isError) { console.log('Blender 没连上'); process.exit(2) }

console.log('=== 建 6 个物品组（模拟真实场景）===')
await mcp('execute_python', {
  code: `
import bpy
for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
for c in list(bpy.data.collections): bpy.data.collections.remove(c)
def box(name, loc, dims):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.view_layer.objects.active
    o.name = name; o.scale = dims
    bpy.ops.object.transform_apply(scale=True)
items = [
    ('房子', [(0,0,1),(0.5,0,0.5),(1,0,0.5)]),
    ('卡车', [(10,0,1),(10.5,0,0.5)]),
    ('路灯', [(20,0,2),(20,0,0.5)]),
    ('瓦砾A', [(30,0,0.5),(30.5,0,0.3)]),
    ('瓦砾B', [(40,0,0.5),(40.5,0,0.3)]),
    ('枯树', [(50,0,1),(50,0,0.2)]),
]
for gi,(gname,parts) in enumerate(items):
    coll = bpy.data.collections.new(gname)
    bpy.context.scene.collection.children.link(coll)
    for pi,(loc) in enumerate(parts):
        n = '%s_%d' % (gname, pi)
        box(n, loc, (0.4,0.4,0.4))
        o = bpy.data.objects[n]
        if o.name in bpy.context.scene.collection.objects:
            bpy.context.scene.collection.objects.unlink(o)
        coll.objects.link(o)
print('6 组建好')
`,
})

const cfg = { source:'auto', blend:'', obj:'', url:'', cdpPort:0, targetMatch:'', blenderPath:'',
  minDepth:0.0005, minRatio:0.005, maxObjects:3000, maxTriangles:2000000 }
const src = new SceneSource({ source: 'auto' }, { packageDir: PACKAGE_DIR })

let saved = 0
const tools = buildTools({
  sourceFor: () => src, config: () => cfg, remember: () => {},
  hostCtx: { get: (n) => (n === 'attachments'
    ? { saveImage: async ({ name }) => { saved++; return { id: 'i' + saved, name } } } : undefined) },
  getRefState: () => ({ given: false, analyzed: false }),
  markRefAnalyzed: () => {},
  getPhaseState: () => ({ modelingComplete: false }),
  markModelingComplete: () => {},
  resetPhase: () => {},
  getModelingState: () => ({ dirtySinceCheck: false, editCount: 0, lookSinceEdit: 0 }),
  noteCheck: () => {},
  noteReviewResult: () => {},
  getReviewState: () => ({ pendingActions: [], receivedAt: 0, editsAfterReview: 0 }),
})

console.log('\n=== 1. model_loop：不传 per_mesh_max → 6 组全出图 ===')
{
  const lt = tools.find((x) => x.name === 'model_loop')
  const v = await lt.execute(
    /* per_mesh_views 现在是**显式开关**：默认 false（看图交给 look），
     * 想验证「每组都出图」这条能力就得显式打开。 */
    { reset: true, verdict: 'continue', next_improvement: 'X', per_mesh_views: true },
    { signal: new AbortController().signal },
  )
  const text = lt.output.render({}, v).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  const imgs = lt.output.render({}, v).filter((b) => b.type === 'image')
  console.log('  分组数: ' + v.groupCount + '  perMeshViews: ' + JSON.stringify(v.perMeshViews && {
    count: v.perMeshViews.count, attached: v.perMeshViews.attached,
  }))
  console.log('  图片总数: ' + imgs.length + '（6 组 × 5 + 5 场景 = 35）')
  expect('每组的 5 张都渲染了', (v.perMeshViews && v.perMeshViews.count) === 30,
    String(v.perMeshViews && v.perMeshViews.count))
  expect('图片总数是 35', imgs.length === 35, String(imgs.length))
  expect('文案说「每组都出图」', /每组都出图/.test(text), text.slice(0, 400))
  /* 每组都应该在文案里出现 */
  for (const g of ['房子', '卡车', '路灯', '瓦砾A', '瓦砾B', '枯树']) {
    if (!text.includes(g)) { failed++; console.log('  ✗ 文案缺组「' + g + '」') }
  }
  console.log('  ✓ 六个组都在文案里列出')
}

console.log('\n=== 2. model_review：派检测智能体的任务文本 ===')
{
  const rt = tools.find((x) => x.name === 'model_review')
  const v = await rt.execute(
    { scene_note: '做一个末日废墟场景', resolution: 320 },
    { signal: new AbortController().signal },
  )
  const text = rt.output.render({}, v).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  const imgs = rt.output.render({}, v).filter((b) => b.type === 'image')
  console.log('  检测覆盖组数: ' + v.groupCount + '  附着图片: ' + v.imageCount)
  console.log('  图片块数: ' + imgs.length)
  expect('6 组都覆盖', v.groupCount === 6, String(v.groupCount))
  expect('30 张图都附上', v.imageCount === 30, String(v.imageCount))
  /* 图片块必须真的出现在输出里——否则检测智能体看不到图，只能靠数据猜 */
  expect('30 个图片块真的进了输出', imgs.length === 30, String(imgs.length))
  expect('任务文本含三个问题', /结构对吗/.test(v.reviewerPrompt)
    && /现实中是这样吗/.test(v.reviewerPrompt) && /还能更好吗/.test(v.reviewerPrompt), '')
  expect('任务文本含场景背景', v.reviewerPrompt.includes('末日废墟'), '')
  expect('任务文本含检测数据', /穿模/.test(v.reviewerPrompt), '')
  expect('要求输出必须修的清单', /必须修的（优先级排序）/.test(v.reviewerPrompt), '')
  expect('文案提示派 subagent', /subagent/.test(text), text.slice(0, 400))
  console.log('\n  --- 任务文本开头 ---')
  console.log('  ' + v.reviewerPrompt.split('\n').slice(0, 8).join('\n  '))
}

console.log('\n=== 3. 显式限制数量时给出警告 ===')
{
  const lt = tools.find((x) => x.name === 'model_loop')
  const v = await lt.execute(
    /* per_mesh_views 需要显式打开；per_mesh_max 是打开后的数量限制。 */
    { reset: true, verdict: 'continue', next_improvement: 'X', per_mesh_max: 2, per_mesh_views: true },
    { signal: new AbortController().signal },
  )
  const text = lt.output.render({}, v).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  console.log('  perMeshViews.count: ' + (v.perMeshViews && v.perMeshViews.count))
  expect('限制后只渲染 2 组', (v.perMeshViews && v.perMeshViews.count) === 10,
    String(v.perMeshViews && v.perMeshViews.count))
  expect('给出「没出图的组等于没检查过」警告', /等于没检查过/.test(text), text.slice(0, 600))
}

console.log('\n' + (failed === 0 ? 'ALL_GROUPS_RENDER_OK' : 'ALL_GROUPS_RENDER_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
