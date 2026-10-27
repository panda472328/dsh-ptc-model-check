/**
 * 验证逐 mesh 五视图隔离渲染。
 *   node tests/verify_permesh_views.mjs
 */

const URL = 'http://127.0.0.1:8765/mcp'
let seq = 0
async function mcp(name, args = {}) {
  const r = await fetch(URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } }),
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
if (ping.isError) { console.log('Blender 没连上，跳过'); process.exit(2) }
console.log('Blender: ' + ping.text.slice(0, 70))

console.log('\n=== 建场景：3 个不同形状的物体（有明确正反面）===')
const build = await mcp('execute_python', {
  code: `
import bpy
for o in list(bpy.data.objects):
    if o.name.startswith('PV_'):
        bpy.data.objects.remove(o, do_unlink=True)

# 一个只有正面有细节、背面平的牌子
bpy.ops.mesh.primitive_cube_add(size=1, location=(0,0,1))
a = bpy.context.view_layer.objects.active
a.name = 'PV_牌子'
a.scale = (1.5, 0.1, 1.0)
bpy.ops.object.transform_apply(scale=True)
# 正面加一个凸起（模拟只有一面有细节）
bpy.ops.mesh.primitive_cube_add(size=0.4, location=(0,-0.1,1))
b = bpy.context.view_layer.objects.active
b.name = 'PV_凸起'
b.scale = (1, 0.5, 1)
bpy.ops.object.transform_apply(scale=True)

# 一个完整对称的柱子
bpy.ops.mesh.primitive_cylinder_add(radius=0.3, depth=2, location=(3,0,1))
c = bpy.context.view_layer.objects.active
c.name = 'PV_柱子'

print('三个物体建好')
`,
})
console.log('  ' + build.text.slice(0, 100))
expect('建物体成功', !build.isError, build.text.slice(0, 150))

console.log('\n=== 单对象五视图隔离渲染 ===')
/* 用一个正反面差异明显的物体：一个"L 形"支架，正面看到长边，背面看到短边 */
const lshape = await mcp('execute_python', {
  code: `
import bpy
for o in list(bpy.data.objects):
    if o.name.startswith('L5_'):
        bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.mesh.primitive_cube_add(size=1, location=(0,0,0.5))
a = bpy.context.view_layer.objects.active
a.name = 'L5_主体'
a.scale = (2, 0.3, 1)
bpy.ops.object.transform_apply(scale=True)
# 背面加一个大凸块（只有背面有）
bpy.ops.mesh.primitive_cube_add(size=1, location=(0,0.8,0.5))
b = bpy.context.view_layer.objects.active
b.name = 'L5_背块'
b.scale = (1.2, 0.6, 0.5)
bpy.ops.object.transform_apply(scale=True)
# 合并成一个对象：这样正背面轮廓完全不同
bpy.ops.object.select_all(action='DESELECT')
a.select_set(True)
b.select_set(True)
bpy.context.view_layer.objects.active = a
bpy.ops.object.join()
print('L 形件建好，面数:', len(a.data.polygons))
`,
})
console.log('  ' + lshape.text.slice(0, 120))

const r = await renderFiveViewsIsolated('L5_主体', { width: 320, height: 320 })
console.log('  对象: ' + r.object)
for (const v of r.views) {
  console.log('    ' + v.view + '：' + (v.ok ? '出图 ' + Math.round((v.base64 || '').length / 1024) + 'KB' : '失败 ' + v.error))
}
expect('渲染了 5 个视角', r.views.length === 5, String(r.views.length))
expect('至少 4 个成功', r.views.filter((v) => v.ok).length >= 4,
  r.views.filter((v) => !v.ok).map((v) => v.view + ':' + v.error).join(', '))

/* 关键：正视图和背视图应该不一样（背面有大凸块，轮廓不同） */
const front = r.views.find((v) => v.view === 'front')
const back = r.views.find((v) => v.view === 'back')
if (front?.ok && back?.ok) {
  const same = front.base64 === back.base64
  console.log('  正视图与背视图' + (same ? '相同（异常）' : '不同（正常）'))
  expect('正背面图不同（背块只在背面）', !same, '两图完全相同')
}

console.log('\n=== model_loop 集成：逐 mesh 五视图 ===')
const cfg = {
  source: 'live', blend: '', obj: '', url: '', cdpPort: 0, targetMatch: '', blenderPath: '',
  minDepth: 0.0005, minRatio: 0.005, maxObjects: 3000, maxTriangles: 2000000,
}
const live = new SceneSource({ source: 'live' }, { packageDir: PACKAGE_DIR })
const tools = buildTools({
  sourceFor: () => live,
  config: () => cfg,
  remember: () => {},
  hostCtx: { get: () => undefined },
  getRefState: () => ({ given: false, analyzed: false }),
  markRefAnalyzed: () => {},
})
const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
const exec = { signal: new AbortController().signal }

const loopTool = byName['model_loop']
/* 测试环境没有 attachments 服务，所以图片无法落成 attachment。
 * 这里注入一个假的，验证「有服务时图片确实会附上」。 */
let fakeSaved = 0
const hostCtx = {
  get: (name) => (name === 'attachments'
    ? {
      saveImage: async ({ data, mediaType, name: n }) => {
        fakeSaved++
        return { id: 'fake-' + fakeSaved, name: n, bytes: data.length, mediaType }
      },
    }
    : undefined),
}
const toolsWithAttach = buildTools({
  sourceFor: () => live,
  config: () => cfg,
  remember: () => {},
  hostCtx,
  getRefState: () => ({ given: false, analyzed: false }),
  markRefAnalyzed: () => {},
})
const loopTool2 = toolsWithAttach.find((t) => t.name === 'model_loop')

const v = await loopTool2.execute({
  reset: true, verdict: 'continue', next_improvement: 'X', per_mesh_max: 2, per_mesh_views: true,
}, exec)
const blocks = loopTool2.output.render({}, v)
const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
const imgs = blocks.filter((b) => b.type === 'image')

const idx = text.indexOf('②d 分组五视图')
console.log(text.slice(idx, idx + 700))
expect('含逐 mesh 五视图段落', idx >= 0, '没找到段落')
expect('返回 perMeshViews 元信息', !!v.perMeshViews, JSON.stringify(v.perMeshViews))
expect('实际附了图片', imgs.length > 0, '图片数 ' + imgs.length)
console.log('  附加图片数: ' + imgs.length + '（场景五视图 + 逐 mesh 五视图）')
expect('图片数合理（≤ 20）', imgs.length <= 20, String(imgs.length))
if (v.perMeshViews) {
  expect('至少 2 个 mesh 被单独看了', v.perMeshViews.objects.length >= 2,
    JSON.stringify(v.perMeshViews.objects))
  expect('每个 mesh 5 个视角', v.perMeshViews.views.length >= 10,
    String(v.perMeshViews.views.length))
}

console.log('\n=== 可关闭 ===')
const v2 = await loopTool2.execute({
  reset: true, verdict: 'continue', next_improvement: 'X', per_mesh_views: false,
}, exec)
const text2 = loopTool2.output.render({}, v2).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
expect('per_mesh_views=false 时不渲染', !text2.includes('②d 分组五视图'), '仍然出现了')

console.log('\n' + (failed === 0 ? 'PERMESH_VIEWS_OK' : 'PERMESH_VIEWS_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
