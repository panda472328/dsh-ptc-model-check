/**
 * 端到端验证全套 PBR 工具。
 *   node tests/verify_pbr_tools.mjs
 */

import { existsSync, statSync, readdirSync } from 'node:fs'

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

const OUT = 'D:/dsh插件制作/_pbr_test'

const ping = await mcp('ping')
if (ping.isError) {
  console.log('Blender 没连上，跳过。')
  process.exit(2)
}
console.log('Blender: ' + ping.text.slice(0, 80))

console.log('\n=== 0. 工具清单 ===')
const list = await fetch(URL, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
}).then((r) => r.json())
const names = (list.result?.tools || []).map((t) => t.name)
console.log('  工具总数: ' + names.length)
const pbrTools = ['make_pbr_node_tree', 'import_texture_set', 'bake_pbr_map',
  'bake_pbr_set', 'setup_render', 'render_preview']
for (const t of pbrTools) {
  expect('有工具 ' + t, names.includes(t))
}

console.log('\n=== 1. 建测试对象 + 材质 ===')
const setup = await mcp('execute_python', {
  code: `
import bpy
for o in list(bpy.data.objects):
    if o.name.startswith('PBR_'):
        bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.mesh.primitive_cube_add(size=2, location=(0,0,1))
o = bpy.context.view_layer.objects.active
o.name = 'PBR_TestCube'
# 展 UV（烘焙需要）
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project()
bpy.ops.object.mode_set(mode='OBJECT')
print('对象就绪，UV 已展')
`,
})
console.log('  ' + setup.text.slice(0, 120))
expect('建对象并展 UV', !setup.isError, setup.text.slice(0, 200))

console.log('\n=== 2. make_pbr_node_tree（程序化材质）===')
const tree = await mcp('make_pbr_node_tree', {
  material: 'PBR_锈蚀钢',
  base_color: [0.35, 0.22, 0.15],
  metallic: 1.0,
  roughness: 0.55,
  detail: 'noise',
  detail_scale: 12,
  bump_strength: 0.2,
  roughness_variation: 0.2,
})
console.log('  ' + tree.text.slice(0, 250))
expect('节点树创建成功', !tree.isError, tree.text.slice(0, 250))

console.log('\n=== 3. 挂到对象上 ===')
const assign = await mcp('assign_material', { object: 'PBR_TestCube', material: 'PBR_锈蚀钢' })
expect('材质已分配', !assign.isError, assign.text.slice(0, 150))

console.log('\n=== 4. setup_render（光影配置）===')
const rnd = await mcp('setup_render', {
  engine: 'eevee', samples: 32, world_strength: 0.5, add_lights: true,
})
console.log('  ' + rnd.text.slice(0, 400))
expect('渲染配置成功', !rnd.isError, rnd.text.slice(0, 300))
expect('加了灯光', /__pbr_light|lights/.test(rnd.text), rnd.text.slice(0, 300))

console.log('\n=== 5. render_preview（出效果图）===')
const prev = await mcp('render_preview', {
  filepath: OUT + '/preview.png', width: 400, height: 300, samples: 16,
})
console.log('  ' + prev.text.slice(0, 250))
expect('渲染成功', !prev.isError, prev.text.slice(0, 300))
expect('图片文件存在', existsSync(OUT + '/preview.png'),
  existsSync(OUT + '/preview.png') ? '' : '文件没生成')
if (existsSync(OUT + '/preview.png')) {
  const sz = statSync(OUT + '/preview.png').size
  console.log('  图片大小: ' + sz + ' 字节')
  expect('图片不是空的', sz > 1000, sz + ' 字节')
}

console.log('\n=== 6. bake_pbr_set（烘全套贴图）===')
const bake = await mcp('bake_pbr_set', {
  object: 'PBR_TestCube', material: 'PBR_锈蚀钢',
  filepath: OUT + '/baked/', size: 256, samples: 8,
  maps: ['color', 'roughness', 'normal', 'ao'],
})
console.log('  ' + bake.text.slice(0, 600))
expect('烘焙调用成功', !bake.isError, bake.text.slice(0, 400))

/* 检查输出文件 */
let baked = []
try { baked = readdirSync(OUT + '/baked') } catch { /* ignore */ }
console.log('  输出文件: ' + (baked.length ? baked.join(', ') : '（无）'))
expect('产出了贴图文件', baked.length >= 2, baked.join(','))

console.log('\n=== 7. bake_pbr_map（单张通道）===')
const single = await mcp('bake_pbr_map', {
  object: 'PBR_TestCube', material: 'PBR_锈蚀钢',
  bake_type: 'ROUGHNESS', size: 256, samples: 8,
  filepath: OUT + '/single_roughness.png',
})
console.log('  ' + single.text.slice(0, 250))
expect('单通道烘焙成功', !single.isError, single.text.slice(0, 300))
expect('单通道文件存在', existsSync(OUT + '/single_roughness.png'),
  existsSync(OUT + '/single_roughness.png') ? '' : '文件没生成')

console.log('\n' + (failed === 0 ? 'PBR_TOOLS_OK' : 'PBR_TOOLS_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
