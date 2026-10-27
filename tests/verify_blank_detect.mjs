/**
 * 验证空图检测：空场景渲染时应给出警告，有物体的场景不该误报。
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

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

console.log('=== ① 空场景 → 应报空图警告 ===')
await mcp('execute_python', {
  code: `
import bpy
for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
print('空场景，objects=%d' % len(bpy.context.scene.objects))
`,
})
{
  const r = await mcp('look', { view: 'front', shading: 'solid', width: 200, height: 200 })
  console.log('  summary: ' + r.text.slice(0, 140))
  expect('检测到空图并给出警告', /⚠/.test(r.text) && /同一种颜色/.test(r.text), r.text.slice(0, 240))
}

console.log('\n=== ② 放一个立方体 → 不应误报 ===')
await mcp('execute_python', {
  code: `
import bpy
bpy.ops.mesh.primitive_cube_add(size=2, location=(0,0,0))
print('加了一个立方体')
`,
})
{
  const r = await mcp('look', { view: 'front', shading: 'solid', width: 200, height: 200 })
  console.log('  summary: ' + r.text.slice(0, 140))
  expect('有物体时不误报', !/⚠/.test(r.text), r.text.slice(0, 200))
  const img = r.content.find((c) => c.type === 'image')
  if (img) {
    const buf = Buffer.from(img.data, 'base64')
    fs.writeFileSync('D:/dsh插件制作/ptc-model-check/tests/_blank_cube.png', buf)
    console.log('  图已存，字节 ' + buf.length)
  }
}

console.log('\n=== ③ 远距离物体（相机框错位置）→ 也应能发现 ===')
await mcp('execute_python', {
  code: `
import bpy
for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
# 物体离原点很远
bpy.ops.mesh.primitive_cube_add(size=1, location=(500,500,500))
print('远处物体')
`,
})
{
  const r = await mcp('look', { view: 'front', shading: 'solid', width: 200, height: 200 })
  console.log('  summary: ' + r.text.slice(0, 140))
  /* 相机是按包围盒自动框的，所以远处物体也应该被框住、不该是空图 */
  expect('远处物体也能被框住（不是空图）', !/⚠/.test(r.text), r.text.slice(0, 200))
}

console.log('\n' + (failed === 0 ? 'BLANK_DETECT_OK' : 'BLANK_DETECT_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
