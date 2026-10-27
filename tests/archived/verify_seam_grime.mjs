/**
 * 验证接缝痕迹（seam_grime）。
 *   node tests/verify_seam_grime.mjs
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

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

const ping = await mcp('ping')
if (ping.isError) { console.log('Blender 没连上'); process.exit(2) }

console.log('=== 建场景：两个贴合物体，制造真实接缝 ===')
const setup = await mcp('execute_python', {
  code: `
import bpy
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
# 主体板
bpy.ops.mesh.primitive_cube_add(size=2, location=(0,0,1))
a = bpy.context.view_layer.objects.active
a.name = 'SG_主板'
a.scale = (1, 1, 0.1)
bpy.ops.object.transform_apply(scale=True)
# 贴在上面的块（与主板贴合，形成接缝）
bpy.ops.mesh.primitive_cube_add(size=0.8, location=(0,0,1.1))
b = bpy.context.view_layer.objects.active
b.name = 'SG_块'
b.scale = (1, 1, 0.3)
bpy.ops.object.transform_apply(scale=True)
# 再一块，紧贴第一块侧面 → 垂直接缝
bpy.ops.mesh.primitive_cube_add(size=0.8, location=(0.81,0,1.1))
c = bpy.context.view_layer.objects.active
c.name = 'SG_块2'
c.scale = (1, 1, 0.3)
bpy.ops.object.transform_apply(scale=True)
# 展 UV
for o in (a,b,c):
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project()
    bpy.ops.object.mode_set(mode='OBJECT')
print('建好 3 个物体，有贴合接缝')
`,
})
console.log('  ' + setup.text.slice(0, 100))
expect('建场景成功', !setup.isError, setup.text.slice(0, 150))

console.log('\n=== 写实模式接缝痕迹 ===')
const r1 = await mcp('make_pbr_node_tree', {
  material: 'SG_写实',
  pattern: 'metal_hammered',
  base_color: [0.45, 0.42, 0.38],
  metallic: 0.8, roughness: 0.55,
  detail_scale: 8, texture_jitter: 0.41,
  seam_grime: 'realistic',
  seam_distance: 0.2, seam_strength: 0.85,
  grime_type: 'oil', seam_roughness: 0.22,
  seam_color: [0.06, 0.05, 0.04],
})
const v1 = parse(r1.text)
console.log('  ' + JSON.stringify(v1))
expect('写实接缝创建成功', !r1.isError, r1.text.slice(0, 200))
expect('报告 seam_grime=true', v1?.seam_grime === true, String(v1?.seam_grime))
console.log('  节点数: ' + v1?.nodes)

console.log('\n=== 卡通模式接缝（只加深颜色）===')
const r2 = await mcp('make_pbr_node_tree', {
  material: 'SG_卡通',
  pattern: 'noise',
  base_color: [0.85, 0.75, 0.55],
  metallic: 0, roughness: 0.8,
  detail_scale: 4,
  seam_grime: 'stylized',
  seam_strength: 0.7,
})
const v2 = parse(r2.text)
console.log('  ' + JSON.stringify(v2))
expect('卡通接缝创建成功', !r2.isError, r2.text.slice(0, 200))
expect('报告 stylized', v2?.seam_style === 'stylized', String(v2?.seam_style))
/* 卡通模式节点数应该比写实少（不接 roughness/normal） */
expect('卡通节点数少于写实', (v2?.nodes || 0) < (v1?.nodes || 0),
  '卡通 ' + v2?.nodes + ' vs 写实 ' + v1?.nodes)

console.log('\n=== 验证接缝痕迹真的烘焙出内容 ===')
/* 给主板材质，烘 AO —— AO 图能反映接缝位置 */
await mcp('assign_material', { object: 'SG_主板', material: 'SG_写实' })
await mcp('assign_material', { object: 'SG_块', material: 'SG_写实' })
await mcp('assign_material', { object: 'SG_块2', material: 'SG_写实' })

const bake = await mcp('bake_pbr_set', {
  object: 'SG_主板', material: 'SG_写实',
  filepath: 'D:/dsh插件制作/_sg_test/', size: 256, samples: 8,
  maps: ['color', 'ao'],
})
console.log('  ' + bake.text.slice(0, 300))
expect('烘焙成功', !bake.isError, bake.text.slice(0, 200))

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { decodePngRgb } from '../lib/core/color.mjs'

const dir = 'D:/dsh插件制作/_sg_test'
if (existsSync(dir)) {
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.png'))) {
    const img = decodePngRgb(readFileSync(dir + '/' + f))
    const n = img.width * img.height
    let sum = 0
    let min = 255
    let max = 0
    for (let i = 0; i < n; i++) {
      const l = 0.299 * img.rgb[i * 3] + 0.587 * img.rgb[i * 3 + 1] + 0.114 * img.rgb[i * 3 + 2]
      sum += l
      if (l < min) min = l
      if (l > max) max = l
    }
    const mean = sum / n
    console.log('  ' + f + ' 均值 ' + mean.toFixed(1) + ' 范围 ' + min.toFixed(0) + '~' + max.toFixed(0))
    if (f.includes('AO')) {
      expect('AO 图有明暗变化（反映接缝）', max - min > 20,
        '范围只有 ' + (max - min).toFixed(0))
    }
  }
}

console.log('\n=== 不设 seam_grime 时不该有 ===')
const r3 = await mcp('make_pbr_node_tree', {
  material: 'SG_无接缝', pattern: 'noise', base_color: [0.5, 0.5, 0.5],
})
const v3 = parse(r3.text)
expect('默认不做接缝', v3?.seam_grime === false, String(v3?.seam_grime))

console.log('\n' + (failed === 0 ? 'SEAM_GRIME_OK' : 'SEAM_GRIME_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
