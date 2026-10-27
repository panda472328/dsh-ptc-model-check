/**
 * 验证不同 pattern / 磨损 / 灰尘真的产生不同结果。
 *   node tests/verify_material_variety.mjs
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

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

const ping = await mcp('ping')
if (ping.isError) { console.log('Blender 没连上'); process.exit(2) }
console.log('Blender: ' + ping.text.slice(0, 70))

console.log('\n=== 建高细分平面（置换/法线需要）===')
await mcp('execute_python', {
  code: `
import bpy
for o in list(bpy.data.objects):
    if o.name.startswith('MV_'):
        bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.mesh.primitive_plane_add(size=2)
o = bpy.context.view_layer.objects.active
o.name = 'MV_Plane'
m = o.modifiers.new('sub', 'SUBSURF')
m.subdivision_type = 'SIMPLE'
m.levels = 6
m.render_levels = 6
bpy.ops.object.modifier_apply(modifier='sub')
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project()
bpy.ops.object.mode_set(mode='OBJECT')
print('面数', len(o.data.polygons))
`,
})

console.log('\n=== 用不同 pattern 建 5 个材质 ===')
const variants = [
  { name: 'MV_混凝土', pattern: 'concrete', detail_scale: 3, jitter: 0.11 },
  { name: 'MV_木头', pattern: 'wood', detail_scale: 2, jitter: 0.37, stretch: [1, 8, 1] },
  { name: 'MV_拉丝金属', pattern: 'metal_brushed', detail_scale: 60, jitter: 0.73, metallic: 1 },
  { name: 'MV_织物', pattern: 'fabric', detail_scale: 90, jitter: 1.19 },
  { name: 'MV_锈铁', pattern: 'metal_rust', detail_scale: 5, jitter: 1.61, metallic: 1,
    edge_wear: true, dust: true, wear_metallic: 1 },
]

for (const v of variants) {
  const r = await mcp('make_pbr_node_tree', {
    material: v.name,
    pattern: v.pattern,
    base_color: [0.5, 0.45, 0.4],
    metallic: v.metallic || 0,
    roughness: 0.6,
    detail_scale: v.detail_scale,
    texture_jitter: v.jitter,
    stretch: v.stretch,
    bump_strength: 0.3,
    bump_distance: 0.3,
    displacement_scale: 0.15,
    edge_wear: v.edge_wear || false,
    dust: v.dust || false,
    wear_metallic: v.wear_metallic,
    color_variation: 0.25,
  })
  const out = (() => { try { return JSON.parse(r.text) } catch { return null } })()
  console.log('  ' + v.name.padEnd(12) + ' pattern=' + (out?.pattern || '?')
    + ' 节点=' + (out?.nodes || '?')
    + (out?.wear ? ' 磨损' : '') + (out?.dust ? ' 灰尘' : ''))
  expect(v.name + ' 创建成功', !r.isError, r.text.slice(0, 150))
  expect(v.name + ' pattern 正确记录', out?.pattern === v.pattern, String(out?.pattern))
}

console.log('\n=== 关键验证：不同 pattern 烘出的贴图必须不同 ===')
const baked = {}
for (const v of variants) {
  await mcp('assign_material', { object: 'MV_Plane', material: v.name })
  const out = 'D:/dsh插件制作/_mv_test/' + v.pattern
  const r = await mcp('bake_pbr_set', {
    object: 'MV_Plane', material: v.name,
    filepath: out + '/', size: 256, samples: 4,
    maps: ['color', 'roughness', 'normal'],
  })
  if (r.isError) { console.log('  ' + v.name + ' 烘焙失败'); continue }
  baked[v.pattern] = out
  console.log('  ' + v.pattern + ' 已烘')
}

/* 比较各 pattern 的贴图哈希 */
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'

const hashes = {}
for (const [pat, dir] of Object.entries(baked)) {
  if (!existsSync(dir)) continue
  const files = readdirSync(dir).filter((f) => f.endsWith('_Normal.png') || f.endsWith('_BaseColor.png'))
  const hs = []
  for (const f of files.sort()) {
    hs.push(createHash('sha256').update(readFileSync(dir + '/' + f)).digest('hex').slice(0, 12))
  }
  hashes[pat] = hs.join('|')
  console.log('  ' + pat.padEnd(16) + ' ' + hashes[pat])
}

const uniq = new Set(Object.values(hashes))
console.log('\n  不同哈希数: ' + uniq.size + ' / ' + Object.keys(hashes).length)
expect('不同 pattern 至少产生 4 种不同结果', uniq.size >= 4,
  '只有 ' + uniq.size + ' 种，说明纹理还是同质化')
expect('没有两个 pattern 完全相同', uniq.size === Object.keys(hashes).length,
  '有重复')

console.log('\n' + (failed === 0 ? 'MATERIAL_VARIETY_OK' : 'MATERIAL_VARIETY_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
