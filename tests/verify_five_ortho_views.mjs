/**
 * 验证分组五视图用「五个正交视角」：正/后/左/右/顶。
 *   node tests/verify_five_ortho_views.mjs
 */

const URL = 'http://127.0.0.1:8765/mcp'
let seq = 0
async function mcp(n, a = {}) {
  const r = await fetch(URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name: n, arguments: a } }),
  }).then((x) => x.json())
  const c = (r.result && r.result.content) || []
  return { isError: !!r.result?.isError, text: c.map((x) => x.text || '').join(' ') }
}

import { SceneSource } from '../lib/adapters/index.mjs'
import { buildTools } from '../lib/tools.mjs'
import { renderFiveViewsIsolated } from '../lib/adapters/live.mjs'
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

console.log('=== 建场景：一个不对称的椅子（左边有扶手，右边没有）===')
await mcp('execute_python', {
  code: `
import bpy
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
for c in list(bpy.data.collections):
    bpy.data.collections.remove(c)
def box(name, loc, dims):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.view_layer.objects.active
    o.name = name; o.scale = dims
    bpy.ops.object.transform_apply(scale=True)
# 不对称：只有左侧有扶手 → 左右视图应该不同
box('椅_座面', (0,0,0.5), (0.6,0.6,0.08))
box('椅_靠背', (0,0.25,0.85), (0.6,0.08,0.7))
box('椅_左扶手', (-0.35,0,0.75), (0.08,0.6,0.08))
import bpy as _b
coll = _b.data.collections.new('椅子')
_b.context.scene.collection.children.link(coll)
for n in ['椅_座面','椅_靠背','椅_左扶手']:
    o=_b.data.objects[n]
    if o.name in _b.context.scene.collection.objects:
        _b.context.scene.collection.objects.unlink(o)
    coll.objects.link(o)
print('椅子建好，只有左扶手')
`,
})

console.log('\n=== 1. 直接调 renderFiveViewsIsolated，确认出 5 个正交视角 ===')
const r = await renderFiveViewsIsolated(['椅_座面', '椅_靠背', '椅_左扶手'], {
  width: 300, height: 300, label: '椅子',
})
console.log('  视角: ' + r.views.map((v) => v.view + (v.ok ? '✓' : '✗')).join(' '))
expect('恰好 5 个视角', r.views.length === 5, String(r.views.length))
expect('视角是正/后/左/右/顶',
  JSON.stringify(r.views.map((v) => v.view)) === JSON.stringify(['front', 'back', 'left', 'right', 'top']),
  JSON.stringify(r.views.map((v) => v.view)))
expect('全部出图成功', r.views.every((v) => v.ok),
  JSON.stringify(r.views.filter((v) => !v.ok).map((v) => [v.view, v.error])))
expect('每张都有 base64', r.views.every((v) => v.base64 && v.base64.length > 100),
  r.views.map((v) => v.base64 ? v.base64.length : 0).join(','))

/* 验证左右视图**确实不同**（不对称结构必须能看出来） */
if (r.views.every((v) => v.ok)) {
  const byView = {}
  for (const v of r.views) byView[v.view] = v.base64
  const left = byView.left, right = byView.right
  console.log('  左视图长度 ' + left.length + '，右视图长度 ' + right.length)
  expect('左右视图不是同一张（不对称能看出来）', left !== right,
    left === right ? '左右完全相同——要么渲染没有真的换视角，要么物体左右对称' : '')
}

console.log('\n=== 2. model_loop 应返回这 5 个视角的图 ===')
const cfg = {
  source: 'auto', blend: '', obj: '', url: '', cdpPort: 0, targetMatch: '', blenderPath: '',
  minDepth: 0.0005, minRatio: 0.005, maxObjects: 3000, maxTriangles: 2000000,
}
const src = new SceneSource({ source: 'auto' }, { packageDir: PACKAGE_DIR })
let imgN = 0
const tools = buildTools({
  sourceFor: () => src,
  config: () => cfg,
  remember: () => {},
  hostCtx: {
    get: (n) => (n === 'attachments'
      ? { saveImage: async ({ name }) => ({ id: 'i' + (++imgN), name }) }
      : undefined),
  },
  getRefState: () => ({ given: false, analyzed: false }),
  markRefAnalyzed: () => {},
  getPhaseState: () => ({ modelingComplete: false }),
  markModelingComplete: () => {},
  resetPhase: () => {},
  getModelingState: () => ({ dirtySinceCheck: true, editCount: 1, lookSinceEdit: 3 }),
  noteCheck: () => {},
})
const lt = tools.find((x) => x.name === 'model_loop')
const v = await lt.execute(
  /* 五视图现在是能力而非默认：显式传 per_mesh_views 才出图。 */
  { target: '椅子', reset: true, verdict: 'continue', next_improvement: 'X', per_mesh_views: true },
  { signal: new AbortController().signal },
)
const blocks = lt.output.render({}, v)
const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
const imgs = blocks.filter((b) => b.type === 'image')

const i = text.indexOf('②d 分组五视图')
console.log(text.slice(i, i + 500))
expect('有分组五视图段落', i >= 0, '没找到')
expect('提了 5 个视角', /5\/5 个视角出图成功/.test(text), text.slice(i, i + 400))
expect('附了图片', imgs.length >= 5, String(imgs.length))
console.log('  图片数: ' + imgs.length)

console.log('\n=== 3. 视觉与数据一起返回（这次检查同时有数值和图片）===')
expect('有穿模数据', /① 穿模/.test(text), '')
expect('有孤立数据', /② 未接触/.test(text), '')
expect('有五视图图片', imgs.length > 0, String(imgs.length))
expect('有看图提醒（因为 lookSinceEdit=3）', /看图只带穿模与孤立摘要/.test(text),
  text.slice(0, 600))
const t2 = text.indexOf('看图只带穿模与孤立摘要')
if (t2 >= 0) console.log(text.slice(t2 - 60, t2 + 260))

console.log('\n=== 4. 分组五视图的图片尺寸应是正方形 ===')
const firstImg = imgs[0]
if (firstImg && firstImg.image) {
  console.log('  首图尺寸: ' + firstImg.image.width + 'x' + firstImg.image.height)
  expect('是正方形（正交视图）', firstImg.image.width === firstImg.image.height,
    firstImg.image.width + 'x' + firstImg.image.height)
}

console.log('\n' + (failed === 0 ? 'FIVE_ORTHO_VIEWS_OK' : 'FIVE_ORTHO_VIEWS_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
