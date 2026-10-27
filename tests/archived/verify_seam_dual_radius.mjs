/**
 * 验证双半径接缝检测。
 *   node tests/verify_seam_dual_radius.mjs
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

console.log('=== 建双尺度场景：细缝 + 大凹角（真实建模带间隙）===')
const setup = await mcp('execute_python', {
  code: `
import bpy
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
for m in list(bpy.data.materials):
    bpy.data.materials.remove(m)

# 地面
bpy.ops.mesh.primitive_plane_add(size=12, location=(0,0,0))
floor = bpy.context.view_layer.objects.active
floor.name = 'DR_地面'

# 大墙：抬离地面 1.5cm，形成**真实缝隙**（这就是正确的装配做法）
bpy.ops.mesh.primitive_cube_add(size=1, location=(-3,0,1.51))
w = bpy.context.view_layer.objects.active
w.name = 'DR_大墙'
w.scale = (0.1, 3, 3)
bpy.ops.object.transform_apply(scale=True)

# 细柱：抬离地面 2mm，形成极细缝
bpy.ops.mesh.primitive_cylinder_add(radius=0.01, depth=0.5, location=(3,0,0.252))
bpy.context.view_layer.objects.active.name = 'DR_细柱'

# 小方块：抬离 2mm
bpy.ops.mesh.primitive_cube_add(size=0.1, location=(1.5,0,0.052))
bpy.context.view_layer.objects.active.name = 'DR_小块'

# 地面展 UV + 材质
bpy.ops.object.select_all(action='DESELECT')
floor.select_set(True)
bpy.context.view_layer.objects.active = floor
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project()
bpy.ops.object.mode_set(mode='OBJECT')
mat = bpy.data.materials.new('DR_地面材质')
mat.use_nodes = True
floor.data.materials.append(mat)
print('建好：大墙(缝1.5cm) + 细柱(缝2mm) + 小块(缝2mm)')
`,
})
console.log('  ' + setup.text.slice(0, 120))
expect('建场景成功', !setup.isError, setup.text.slice(0, 150))

console.log('\n=== 单半径：只能抓到一种缝 ===')
const single = await mcp('make_pbr_node_tree', {
  material: 'DR_单半径', pattern: 'concrete',
  base_color: [0.5, 0.48, 0.45], roughness: 0.7,
  detail_scale: 3, texture_jitter: 0.31,
  seam_grime: 'realistic',
  seam_distance: 0.05,   // 只抓细节缝
  seam_strength: 0.9,
})
const vs = parse(single.text)
console.log('  单半径(0.05) 节点数: ' + vs?.nodes)
expect('单半径创建成功', !single.isError, single.text.slice(0, 150))

console.log('\n=== 双半径：同时抓细节缝和结构缝 ===')
const dual = await mcp('make_pbr_node_tree', {
  material: 'DR_双半径', pattern: 'concrete',
  base_color: [0.5, 0.48, 0.45], roughness: 0.7,
  detail_scale: 3, texture_jitter: 0.31,
  seam_grime: 'realistic',
  seam_distance: 0.05,        // 细节缝
  seam_distance2: 1.5,        // 结构缝
  seam_strength: 0.9,
  seam_strength2: 0.5,        // 结构缝淡一点
})
const vd = parse(dual.text)
console.log('  双半径 节点数: ' + vd?.nodes)
expect('双半径创建成功', !dual.isError, dual.text.slice(0, 150))
expect('双半径比单半径多节点', (vd?.nodes || 0) > (vs?.nodes || 0),
  '单 ' + vs?.nodes + ' vs 双 ' + vd?.nodes)
console.log('  节点名: ' + (vd?.node_names || []).slice(-8).join(', '))
/* 双半径应该有 2 个 AO 节点 */
const aoCount = (vd?.node_names || []).filter((n) => n.includes('环境光遮蔽')).length
console.log('  AO 节点数: ' + aoCount)
expect('有 2 个 AO 节点', aoCount === 2, String(aoCount))

console.log('\n=== 烘焙对比：双半径应该覆盖更多区域 ===')
import { readFileSync, existsSync } from 'node:fs'
import { decodePngRgb } from '../lib/core/color.mjs'

const results = {}
for (const [label, matName] of [['单半径', 'DR_单半径'], ['双半径', 'DR_双半径']]) {
  await mcp('assign_material', { object: 'DR_地面', material: matName })
  const b = await mcp('bake_pbr_set', {
    object: 'DR_地面', material: matName,
    filepath: 'D:/dsh插件制作/_dr_test/' + matName + '/',
    size: 512, samples: 8, maps: ['color'],
  })
  const outDir = 'D:/dsh插件制作/_dr_test/' + matName
  const colorFile = outDir + '/' + matName + '_BaseColor.png'
  if (existsSync(colorFile)) {
    const img = decodePngRgb(readFileSync(colorFile))
    const n = img.width * img.height
    let dark = 0
    let sum = 0
    let min = 255
    for (let i = 0; i < n; i++) {
      const l = 0.299 * img.rgb[i * 3] + 0.587 * img.rgb[i * 3 + 1] + 0.114 * img.rgb[i * 3 + 2]
      sum += l
      if (l < min) min = l
      if (l < 100) dark++
    }
    results[label] = { mean: sum / n, darkPct: dark / n * 100, min }
    console.log('  ' + label + ': 均值 ' + (sum / n).toFixed(1)
      + ' 最暗 ' + min.toFixed(0)
      + ' 暗部(<100) ' + (dark / n * 100).toFixed(2) + '%')
  }
}

if (results['单半径'] && results['双半径']) {
  /* 关键断言：敞开面必须干净。
   * 单半径只抓细缝（0.05），大墙的 1.5cm 缝抓不到 → 暗部更少
   * 双半径加了 1.5，能同时抓细缝和大缝 → 暗部更多 */
  console.log('  单半径暗部 ' + results['单半径'].darkPct.toFixed(3) + '%'
    + ' vs 双半径 ' + results['双半径'].darkPct.toFixed(3) + '%')

  /* 两者都应该是「少量暗部」——如果敞开面也脏了，暗部会占绝大多数 */
  expect('单半径：敞开面基本干净（暗部 < 20%）',
    results['单半径'].darkPct < 20,
    results['单半径'].darkPct.toFixed(2) + '% 都被判成脏')
  expect('双半径：敞开面基本干净（暗部 < 20%）',
    results['双半径'].darkPct < 20,
    results['双半径'].darkPct.toFixed(2) + '% 都被判成脏')

  /* 双半径应该覆盖更多（因为它多了大半径能抓结构缝） */
  expect('双半径暗部不少于单半径',
    results['双半径'].darkPct >= results['单半径'].darkPct * 0.99,
    '单 ' + results['单半径'].darkPct.toFixed(3) + '% vs 双 ' + results['双半径'].darkPct.toFixed(3) + '%')
  expect('双半径有更暗的像素（结构缝更深）',
    results['双半径'].min <= results['单半径'].min,
    '单 ' + results['单半径'].min + ' vs 双 ' + results['双半径'].min)
}

console.log('\n=== 不传 seam_distance2 时行为不变（向后兼容）===')
const compat = await mcp('make_pbr_node_tree', {
  material: 'DR_兼容', pattern: 'concrete',
  seam_grime: 'realistic', seam_distance: 0.1,
})
const vc = parse(compat.text)
const aoCount2 = (vc?.node_names || []).filter((n) => n.includes('环境光遮蔽')).length
expect('只有 1 个 AO 节点', aoCount2 === 1, String(aoCount2))

console.log('\n' + (failed === 0 ? 'SEAM_DUAL_OK' : 'SEAM_DUAL_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
