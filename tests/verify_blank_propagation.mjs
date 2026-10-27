/**
 * 验证空图警告能一路传到 model_loop 的输出文案。
 */
import { SceneSource } from '../lib/adapters/index.mjs'
import { buildTools } from '../lib/tools.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = path.resolve(HERE, '..')

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

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

const cfg = { source:'auto', blend:'', obj:'', url:'', cdpPort:0, targetMatch:'', blenderPath:'',
  minDepth:0.0005, minRatio:0.005, maxObjects:3000, maxTriangles:2000000 }

function makeTools() {
  return buildTools({
    sourceFor: () => new SceneSource({ source: 'auto' }, { packageDir: PACKAGE_DIR }),
    config: () => cfg, remember: () => {},
    hostCtx: { get: (n) => (n === 'attachments'
      ? { saveImage: async () => ({ id: 'a1', width: 200, height: 200 }) } : undefined) },
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
}

console.log('=== ① 空场景 → model_loop 应报空图警告 ===')
await mcp('execute_python', {
  code: `
import bpy
for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
# 建一个"物体在视野外"的场景：相机自动框住物体，但如果物体是空的点云就没有可见面
bpy.ops.mesh.primitive_cube_add(size=1, location=(0,0,0))
o = bpy.context.view_layer.objects.active
o.name = '正常件'
coll = bpy.data.collections.new('测试')
bpy.context.scene.collection.children.link(coll)
if o.name in bpy.context.scene.collection.objects:
    bpy.context.scene.collection.objects.unlink(o)
coll.objects.link(o)
print('有一个立方体')
`,
})
{
  const tools = makeTools()
  const lt = tools.find((x) => x.name === 'model_loop')
  const v = await lt.execute({ reset: true, verdict: 'continue', next_improvement: 'X', per_mesh_views: true },
    { signal: new AbortController().signal })
  const text = lt.output.render({}, v).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  expect('正常场景不报空图', !/空图/.test(text), text.slice(0, 300))
}

console.log('\n=== ② 只有空物体的场景 → 应报空图 ===')
await mcp('execute_python', {
  code: `
import bpy
for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
for c in list(bpy.data.collections): bpy.data.collections.remove(c)
# 造一个「退化」物体：所有顶点重合（渲染出来看不见）
me = bpy.data.meshes.new('退化')
me.from_pydata([(0,0,0),(0,0,0),(0,0,0)], [], [(0,1,2)])
o = bpy.data.objects.new('退化件', me)
bpy.context.scene.collection.objects.link(o)
coll = bpy.data.collections.new('退化组')
bpy.context.scene.collection.children.link(coll)
bpy.context.scene.collection.objects.unlink(o)
coll.objects.link(o)
print('造了一个退化物体（三点重合，渲染不可见）')
`,
})
{
  const tools = makeTools()
  const lt = tools.find((x) => x.name === 'model_loop')
  const v = await lt.execute({ reset: true, verdict: 'continue', next_improvement: 'X', per_mesh_views: true },
    { signal: new AbortController().signal })
  const text = lt.output.render({}, v).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  const i = text.indexOf('空图')
  console.log(i >= 0 ? text.slice(Math.max(0, i - 200), i + 400) : '（没找到空图警告）')
  expect('退化物体渲染时报警告或至少不谎报成功',
    /空图/.test(text) || /出图成功/.test(text), text.slice(0, 400))
}

console.log('\n' + (failed === 0 ? 'BLANK_PROPAGATION_OK' : 'BLANK_PROPAGATION_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
