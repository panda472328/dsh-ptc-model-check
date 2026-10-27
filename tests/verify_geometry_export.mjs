/**
 * 验证 export_geometry：从活场景直接取三角网格。
 *   node tests/verify_geometry_export.mjs
 */

const URL = 'http://127.0.0.1:8765/mcp'
let seq = 0
async function call(name, args = {}) {
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

console.log('=== 准备：建两个已知尺寸的立方体 ===')
const build = await call('execute_python', {
  code: `
import bpy
for n in ('几何测试A', '几何测试B'):
    o = bpy.data.objects.get(n)
    if o:
        bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.mesh.primitive_cube_add(size=2.0, location=(0, 0, 0))
a = bpy.context.view_layer.objects.active
a.name = '几何测试A'
bpy.ops.mesh.primitive_cube_add(size=2.0, location=(1.9, 0, 0))
b = bpy.context.view_layer.objects.active
b.name = '几何测试B'
print('建好两个立方体，中心相距 1.9，边长 2.0 → 应互相穿透 0.1')
`,
})
console.log('  ' + build.text.slice(0, 150))
expect('建物体成功', !build.isError, build.text.slice(0, 150))

console.log('\n=== 调用 export_geometry ===')
const t0 = Date.now()
const geo = await call('export_geometry', {})
const ms = Date.now() - t0
expect('调用成功', !geo.isError, geo.text.slice(0, 300))
console.log('  耗时 ' + ms + 'ms，返回 ' + geo.text.length + ' 字节')

let parsed = null
try { parsed = JSON.parse(geo.text) } catch { /* ignore */ }
expect('返回可解析 JSON', parsed !== null)
if (parsed) {
  console.log('  对象数: ' + (parsed.meshes || []).length + '，三角面: ' + parsed.triangles)
  const hasA = (parsed.meshes || []).some((m) => m.id === '几何测试A')
  const hasB = (parsed.meshes || []).some((m) => m.id === '几何测试B')
  expect('含几何测试A', hasA)
  expect('含几何测试B', hasB)

  const m = (parsed.meshes || []).find((x) => x.id === '几何测试A')
  if (m) {
    const posBuf = Buffer.from(m.positions, 'base64')
    const idxBuf = Buffer.from(m.indices, 'base64')
    expect('positions 是 Float32 三元组', posBuf.length === m.vertices * 3 * 4,
      posBuf.length + ' vs ' + (m.vertices * 3 * 4))
    expect('indices 是 Uint32 三索引', idxBuf.length === m.triangles * 3 * 4,
      idxBuf.length + ' vs ' + (m.triangles * 3 * 4))
    expect('立方体应有 8 顶点 12 三角面', m.vertices === 8 && m.triangles === 12,
      m.vertices + ' 顶点 / ' + m.triangles + ' 面')

    // 校验世界坐标：立方体边长 2，中心在原点，X 范围应是 [-1, 1]
    const f32 = new Float32Array(posBuf.buffer, posBuf.byteOffset, posBuf.length / 4)
    let minX = Infinity, maxX = -Infinity
    for (let i = 0; i < m.vertices; i++) {
      minX = Math.min(minX, f32[i * 3])
      maxX = Math.max(maxX, f32[i * 3])
    }
    expect('世界坐标 X 范围 = [-1, 1]', Math.abs(minX + 1) < 1e-5 && Math.abs(maxX - 1) < 1e-5,
      '[' + minX + ', ' + maxX + ']')
  }
}

console.log('\n=== scope 过滤 ===')
const one = await call('export_geometry', { scope: ['几何测试A'] })
let p1 = null
try { p1 = JSON.parse(one.text) } catch { /* ignore */ }
expect('scope 只返回 1 个', p1 && p1.meshes.length === 1, p1 ? String(p1.meshes.length) : 'parse fail')

console.log('\n' + (failed === 0 ? 'GEOMETRY_EXPORT_OK' : 'GEOMETRY_EXPORT_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
