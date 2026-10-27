/**
 * 脚本通道端到端测试：通过 MCP 让 Blender 跑一段 Python。
 *   node tests/script_channel.mjs
 */

const URL = 'http://127.0.0.1:8765/mcp'
let seq = 0

async function post(body) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

async function call(name, args = {}) {
  const r = await post({
    jsonrpc: '2.0', id: ++seq, method: 'tools/call',
    params: { name, arguments: args },
  })
  const content = (r.result && r.result.content) || []
  return {
    isError: !!(r.result && r.result.isError),
    text: content.map((c) => c.text || '').join(' '),
    raw: r,
  }
}

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

console.log('=== 连通性 ===')
const ping = await call('ping')
console.log('  ' + ping.text.slice(0, 100))
if (ping.isError) {
  console.log('\nBlender 没连上，请先启动 Blender。跳过后续测试。')
  process.exit(2)
}
expect('ping 通', /pong/.test(ping.text), ping.text.slice(0, 150))

console.log('\n=== 基线存盘 ===')
const base = await call('save_blend', { filepath: 'D:/dsh插件制作/_mcp_script_test.blend' })
expect('save_blend 成功', !base.isError, base.text.slice(0, 150))

console.log('\n=== 跑脚本：批量建 5 个部件 ===')
const code = `
import bpy

# 先删同名旧对象，保证可重复执行
for o in list(bpy.data.objects):
    if o.name.startswith('柜体_'):
        bpy.data.objects.remove(o, do_unlink=True)

for i in range(5):
    bpy.ops.mesh.primitive_cube_add(size=0.4, location=(i * 0.5, 0, 0))
    o = bpy.context.view_layer.objects.active
    o.name = '柜体_%d' % i
    o['ptc_part'] = o.name

made = [x.name for x in bpy.data.objects if x.name.startswith('柜体_')]
print('建好了 %d 个: %s' % (len(made), ', '.join(made)))
result = len(made)
`
const run = await call('execute_python', { code })
console.log('  ' + run.text.slice(0, 300))
expect('脚本执行成功', !run.isError, run.text.slice(0, 200))
expect('脚本报告建了 5 个', /建好了 5 个/.test(run.text), run.text.slice(0, 200))

console.log('\n=== 验证场景里真的有这 5 个 ===')
const info = await call('get_scene_info', { detail: 'brief' })
const names = (() => {
  try { return (JSON.parse(info.text).objects || []).map((o) => o.name) } catch { return [] }
})()
console.log('  场景对象: ' + names.join(', '))
expect('5 个柜体都在', ['柜体_0', '柜体_1', '柜体_2', '柜体_3', '柜体_4'].every((n) => names.includes(n)),
  JSON.stringify(names))

console.log('\n=== 脚本可重复执行（再跑一次不应变成 10 个）===')
const run2 = await call('execute_python', { code })
expect('第二次仍是 5 个', /建好了 5 个/.test(run2.text), run2.text.slice(0, 200))

console.log('\n=== 脚本里报错要能读出来 ===')
const bad = await call('execute_python', { code: 'raise ValueError("故意报错测试")' })
console.log('  ' + bad.text.slice(0, 200))
expect('报错被返回', bad.isError || /故意报错测试/.test(bad.text), bad.text.slice(0, 200))

console.log('\n=== 脚本里做几何编辑（bmesh）===')
const geo = `
import bpy, bmesh
obj = bpy.data.objects.get('柜体_0')
bm = bmesh.new()
bm.from_mesh(obj.data)
bmesh.ops.bevel(bm, geom=list(bm.edges), offset=0.03, segments=2)
bm.to_mesh(obj.data)
obj.data.update()
bm.free()
print('倒角完成，面数 %d' % len(obj.data.polygons))
`
const geoRun = await call('execute_python', { code: geo })
console.log('  ' + geoRun.text.slice(0, 200))
expect('bmesh 编辑成功', !geoRun.isError && /倒角完成/.test(geoRun.text), geoRun.text.slice(0, 200))

console.log('\n' + (failed === 0 ? 'SCRIPT_CHANNEL_OK' : 'SCRIPT_CHANNEL_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
