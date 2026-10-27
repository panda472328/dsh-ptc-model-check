/**
 * 验证 UV 工具。
 *   node tests/verify_uv_tools.mjs
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

function parse(t) { try { return JSON.parse(t) } catch { return null } }

const ping = await mcp('ping')
if (ping.isError) { console.log('Blender 没连上'); process.exit(2) }

console.log('=== 工具清单 ===')
const list = await fetch(URL, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
}).then((r) => r.json())
const names = (list.result?.tools || []).map((t) => t.name)
console.log('  总数: ' + names.length)
for (const t of ['uv_inspect', 'uv_unwrap', 'uv_pack', 'uv_scale', 'uv_auto_all']) {
  expect('有 ' + t, names.includes(t))
}

console.log('\n=== 建测试场景：3 个不同尺寸的物体，都没有 UV ===')
const setup = await mcp('execute_python', {
  code: `
import bpy
for o in list(bpy.data.objects):
    if o.name.startswith('UVT_'):
        bpy.data.objects.remove(o, do_unlink=True)
# 小件
bpy.ops.mesh.primitive_cylinder_add(radius=0.1, depth=0.3, location=(0,0,0))
a = bpy.context.view_layer.objects.active; a.name = 'UVT_螺丝'
# 中件
bpy.ops.mesh.primitive_cube_add(size=1, location=(3,0,0))
b = bpy.context.view_layer.objects.active; b.name = 'UVT_箱子'
# 大件
bpy.ops.mesh.primitive_plane_add(size=10, location=(0,0,-1))
c = bpy.context.view_layer.objects.active; c.name = 'UVT_地面'
for o in (a,b,c):
    while o.data.uv_layers:
        o.data.uv_layers.remove(o.data.uv_layers[0])
print('3 个物体建好，已移除 UV')
`,
})
console.log('  ' + setup.text.slice(0, 100))
expect('建场景成功', !setup.isError, setup.text.slice(0, 150))

console.log('\n=== uv_inspect：应该报"没有 UV" ===')
const insp0 = await mcp('uv_inspect', {})
const i0 = parse(insp0.text)
const uvObjs = (i0?.objects || []).filter((o) => o.object.startsWith('UVT_'))
console.log('  检查 ' + (i0?.count || 0) + ' 个对象')
for (const o of uvObjs) {
  console.log('    ' + o.object + '：has_uv=' + o.has_uv + ' 问题=' + o.issues.length)
}
expect('检出无 UV', uvObjs.every((o) => o.has_uv === false),
  JSON.stringify(uvObjs.map((o) => [o.object, o.has_uv])))
expect('报告了问题', uvObjs.every((o) => o.issues.length > 0), 'issues 为空')

console.log('\n=== uv_auto_all：批量处理 ===')
const auto = await mcp('uv_auto_all', {
  objects: ['UVT_螺丝', 'UVT_箱子', 'UVT_地面'],
  texel_density: 512, texture_size: 1024, method: 'smart_project',
})
const a1 = parse(auto.text)
console.log('  total=' + a1?.total + ' ok=' + a1?.ok)
for (const r of (a1?.results || [])) {
  if (r.error) console.log('    ' + r.object + ' 错误: ' + r.error)
  else if (r.skipped) console.log('    ' + r.object + ' 跳过: ' + r.skipped)
  else console.log('    ' + r.object + ' 利用率 ' + r.uv?.utilization + ' 缩放 ' + r.scale_factor)
}
expect('全部处理成功', a1?.ok === 3, 'ok=' + a1?.ok)

console.log('\n=== uv_inspect：现在应该有 UV 且利用率合理 ===')
const insp1 = await mcp('uv_inspect', { object: 'UVT_箱子' })
const i1 = parse(insp1.text)
const box = (i1?.objects || [])[0]
console.log('  ' + JSON.stringify(box, null, 2).slice(0, 400))
expect('箱子有 UV', box?.has_uv === true, String(box?.has_uv))
expect('利用率 > 10%', (box?.utilization || 0) > 0.1,
  '利用率 ' + box?.utilization)
expect('没有严重问题', (box?.issues || []).length <= 1,
  JSON.stringify(box?.issues))

console.log('\n=== 密度一致性：大件应该比小件的 UV 面积大 ===')
const inspAll = await mcp('uv_inspect', {})
const ia = parse(inspAll.text)
const areas = {}
for (const o of (ia?.objects || [])) {
  if (o.object.startsWith('UVT_')) areas[o.object] = o.uv_area
}
console.log('  UV 面积:', JSON.stringify(areas))
if (areas['UVT_地面'] && areas['UVT_螺丝']) {
  expect('地面 UV 面积 > 螺丝', areas['UVT_地面'] > areas['UVT_螺丝'],
    JSON.stringify(areas))
}

console.log('\n=== uv_pack 单独调用 ===')
const pack = await mcp('uv_pack', { object: 'UVT_箱子', margin: 0.002 })
const pk = parse(pack.text)
console.log('  重排后利用率: ' + pk?.uv?.utilization)
expect('pack 成功', !pack.isError, pack.text.slice(0, 200))

console.log('\n' + (failed === 0 ? 'UV_TOOLS_OK' : 'UV_TOOLS_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
