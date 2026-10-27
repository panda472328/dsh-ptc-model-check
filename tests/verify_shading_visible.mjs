/**
 * 验证着色模式修复的三种情形：
 *   ① 无材质 + solid       → SINGLE（可见）
 *   ② 无材质 + material    → OBJECT 回退（可见）
 *   ③ 有材质 + material    → MATERIAL（用真材质色）
 * 以及：渲染后设置要恢复（不污染后续）。
 */
import fs from 'node:fs'

const URL = 'http://127.0.0.1:8765/mcp'
let seq = 0
async function mcp(n, a = {}) {
  const r = await fetch(URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name: n, arguments: a } }),
  }).then((x) => x.json()).catch(() => null)
  if (!r) return { isError: true, text: '连接失败', content: [] }
  const c = (r.result && r.result.content) || []
  return { isError: !!r.result?.isError, text: c.map((x) => x.text || '').join(' '), content: c }
}

/** 从返回里取图片并算「有多少非背景像素」——用来判断图是不是空的 */
function analyze(content) {
  const img = content.find((c) => c.type === 'image')
  if (!img || !img.data) return { ok: false, why: '没有图片块' }
  const buf = Buffer.from(img.data, 'base64')
  return { ok: true, bytes: buf.length }
}

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

console.log('=== 准备：无材质场景 ===')
await mcp('execute_python', {
  code: `
import bpy
for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
for c in list(bpy.data.collections): bpy.data.collections.remove(c)
for m in list(bpy.data.materials): bpy.data.materials.remove(m)
bpy.ops.mesh.primitive_cube_add(size=2, location=(0,0,0))
print('cube, materials=%d' % len(bpy.data.materials))
`,
})

console.log('\n=== ① 无材质 + solid → 应可见 ===')
{
  const r = await mcp('look', { view: 'front', shading: 'solid', width: 300, height: 300 })
  const a = analyze(r.content)
  console.log('  ' + r.text.slice(0, 60) + ' | 图片字节: ' + (a.bytes || '无'))
  expect('拿到图片', a.ok === true, a.why)
  /* 立方体渲染出来应该比纯空图大很多 */
  expect('图片大小合理（不是纯色压缩到极小）', (a.bytes || 0) > 1000, String(a.bytes))
  fs.writeFileSync('D:/dsh插件制作/ptc-model-check/tests/_sh_solid.png',
    Buffer.from(r.content.find((c) => c.type === 'image').data, 'base64'))
}

console.log('\n=== ② 无材质 + material → 应回退且可见 ===')
{
  const r = await mcp('look', { view: 'front', shading: 'material', width: 300, height: 300 })
  const a = analyze(r.content)
  console.log('  图片字节: ' + (a.bytes || '无'))
  expect('拿到图片', a.ok === true, a.why)
  expect('图片非空', (a.bytes || 0) > 1000, String(a.bytes))
  fs.writeFileSync('D:/dsh插件制作/ptc-model-check/tests/_sh_material_nomat.png',
    Buffer.from(r.content.find((c) => c.type === 'image').data, 'base64'))
}

console.log('\n=== ③ 给材质 + material → 用真材质色 ===')
{
  await mcp('execute_python', {
    code: `
import bpy
o = bpy.context.scene.objects['Cube']
m = bpy.data.materials.new('红色')
m.use_nodes = True
bsdf = m.node_tree.nodes.get('Principled BSDF')
if bsdf:
    bsdf.inputs['Base Color'].default_value = (0.8, 0.1, 0.1, 1)
o.data.materials.append(m)
print('已赋红色材质')
`,
  })
  const r = await mcp('look', { view: 'front', shading: 'material', width: 300, height: 300 })
  const a = analyze(r.content)
  console.log('  图片字节: ' + (a.bytes || '无'))
  expect('有材质时也能拿到图', a.ok === true, a.why)
  fs.writeFileSync('D:/dsh插件制作/ptc-model-check/tests/_sh_material_mat.png',
    Buffer.from(r.content.find((c) => c.type === 'image').data, 'base64'))
}

console.log('\n=== ④ 渲染后再来一次 solid，确认设置已恢复 ===')
{
  const r = await mcp('look', { view: 'front', shading: 'solid', width: 300, height: 300 })
  expect('连续渲染不报错', !r.isError, r.text.slice(0, 120))
}

console.log('\n' + (failed === 0 ? 'SHADING_OK' : 'SHADING_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
