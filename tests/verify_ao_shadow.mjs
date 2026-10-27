/**
 * 验证「带阴影的 AO」烘焙。
 *   node tests/verify_ao_shadow.mjs
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
function parse(t) { try { return JSON.parse(t) } catch { return null } }

import { readFileSync, existsSync } from 'node:fs'
import { decodePngRgb } from '../lib/core/color.mjs'

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

const ping = await mcp('ping')
if (ping.isError) { console.log('Blender 没连上'); process.exit(2) }

console.log('=== 建带遮挡关系的场景（能产生阴影）===')
const setup = await mcp('execute_python', {
  code: `
import bpy
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)

# 地板
bpy.ops.mesh.primitive_plane_add(size=6, location=(0,0,0))
floor = bpy.context.view_layer.objects.active
floor.name = 'AO_地板'

# 立起的墙（会在地板上投影）
bpy.ops.mesh.primitive_cube_add(size=1, location=(0,0,1))
w = bpy.context.view_layer.objects.active
w.name = 'AO_墙'
w.scale = (0.1, 2, 2)
bpy.ops.object.transform_apply(scale=True)

# 一个遮挡块（在墙边，形成深夹角）
bpy.ops.mesh.primitive_cube_add(size=0.8, location=(0.5,0,0.4))
b = bpy.context.view_layer.objects.active
b.name = 'AO_块'

# 地板展 UV
bpy.ops.object.select_all(action='DESELECT')
floor.select_set(True)
bpy.context.view_layer.objects.active = floor
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project()
bpy.ops.object.mode_set(mode='OBJECT')

# 地板材质
mat = bpy.data.materials.new('AO_地板材质')
mat.use_nodes = True
floor.data.materials.append(mat)

# 加一盏灯，让投影有意义
ld = bpy.data.lights.new('AO_灯', type='SUN')
ld.energy = 3.0
lo = bpy.data.objects.new('AO_灯', ld)
lo.location = (3, -3, 5)
lo.rotation_euler = (0.6, 0.2, 0.8)
bpy.context.scene.collection.objects.link(lo)

print('场景建好：地板 + 墙 + 遮挡块 + 太阳光')
`,
})
console.log('  ' + setup.text.slice(0, 120))
expect('建场景成功', !setup.isError, setup.text.slice(0, 200))

console.log('\n=== 烘纯 AO（不叠加阴影）===')
const pure = await mcp('bake_ao_shadow', {
  object: 'AO_地板', material: 'AO_地板材质',
  filepath: 'D:/dsh插件制作/_ao_test/pure.png',
  size: 256, samples: 16, ao_distance: 1.0,
  ao_with_shadow: false,
})
const pv = parse(pure.text)
console.log('  ' + JSON.stringify(pv))
expect('纯 AO 烘焙成功', !pure.isError, pure.text.slice(0, 200))

console.log('\n=== 烘带阴影的 AO ===')
const shadow = await mcp('bake_ao_shadow', {
  object: 'AO_地板', material: 'AO_地板材质',
  filepath: 'D:/dsh插件制作/_ao_test/with_shadow.png',
  size: 256, samples: 16, ao_distance: 1.0,
  ao_with_shadow: true, ao_shadow_strength: 1.0,
})
const sv = parse(shadow.text)
console.log('  ' + JSON.stringify(sv))
expect('带阴影 AO 烘焙成功', !shadow.isError, shadow.text.slice(0, 200))

console.log('\n=== 对比两张图 ===')
function stats(path) {
  if (!existsSync(path)) return null
  const img = decodePngRgb(readFileSync(path))
  const n = img.width * img.height
  let sum = 0
  let min = 255
  let max = 0
  const hist = new Array(8).fill(0)
  for (let i = 0; i < n; i++) {
    const l = 0.299 * img.rgb[i * 3] + 0.587 * img.rgb[i * 3 + 1] + 0.114 * img.rgb[i * 3 + 2]
    sum += l
    if (l < min) min = l
    if (l > max) max = l
    hist[Math.min(7, Math.floor((l / 256) * 8))]++
  }
  return { mean: sum / n, min, max, hist: hist.map((v) => (v / n * 100).toFixed(1)) }
}

const s1 = stats('D:/dsh插件制作/_ao_test/pure.png')
const s2 = stats('D:/dsh插件制作/_ao_test/with_shadow.png')

if (s1) console.log('  纯 AO   均值 ' + s1.mean.toFixed(1) + ' 范围 ' + s1.min.toFixed(0) + '~' + s1.max.toFixed(0) + ' 直方图 ' + s1.hist.join('/'))
if (s2) console.log('  带阴影  均值 ' + s2.mean.toFixed(1) + ' 范围 ' + s2.min.toFixed(0) + '~' + s2.max.toFixed(0) + ' 直方图 ' + s2.hist.join('/'))

expect('两张图都生成了', !!s1 && !!s2, 's1=' + !!s1 + ' s2=' + !!s2)

if (s1 && s2) {
  expect('带阴影的图更暗（均值更低）', s2.mean < s1.mean,
    s1.mean.toFixed(1) + ' vs ' + s2.mean.toFixed(1))
  /* 暗部占比：最暗那一档（hist[0]）应该明显增加 */
  expect('带阴影的图暗部占比更大', Number(s2.hist[0]) > Number(s1.hist[0]) * 1.5,
    '纯 ' + s1.hist[0] + '% vs 阴影 ' + s2.hist[0] + '%')
  console.log('  最暗档占比: 纯 ' + s1.hist[0] + '% → 阴影 ' + s2.hist[0] + '%')
  console.log('  均值差: ' + (s1.mean - s2.mean).toFixed(1))
  expect('差异足够明显（均值差 > 5）', (s1.mean - s2.mean) > 5,
    '差 ' + (s1.mean - s2.mean).toFixed(1))
}

console.log('\n' + (failed === 0 ? 'AO_SHADOW_OK' : 'AO_SHADOW_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
