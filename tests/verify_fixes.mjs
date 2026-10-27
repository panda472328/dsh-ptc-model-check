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

console.log('=== 修复验证 1：中文界面下创建材质 ===')
const mat = await call('create_material', {
  name: '测试金属', base_color: [0.8, 0.3, 0.1], metallic: 0.9, roughness: 0.2,
})
console.log('  ' + mat.text.slice(0, 200))
expect('create_material 成功（中文节点名不再是问题）', !mat.isError, mat.text.slice(0, 200))
expect('返回 has_bsdf: true', /has_bsdf.*true/.test(mat.text), mat.text.slice(0, 200))

console.log('\n=== 修复验证 2：改材质属性 ===')
const upd = await call('set_material_property', { material: '测试金属', roughness: 0.7 })
console.log('  ' + upd.text.slice(0, 150))
expect('set_material_property 成功', !upd.isError, upd.text.slice(0, 150))

console.log('\n=== 修复验证 3：列出材质 ===')
const list = await call('list_materials')
console.log('  ' + list.text.slice(0, 250))
expect('list_materials 成功', !list.isError, list.text.slice(0, 150))
expect('能读出 roughness', /测试金属/.test(list.text) && /roughness/.test(list.text), list.text.slice(0, 250))

console.log('\n=== 修复验证 4：报错要带行号和源码 ===')
const bad = await call('execute_python', {
  code: `import bpy
x = 1
y = 2
raise ValueError("故意的错误")
`,
})
console.log('  ' + bad.text.slice(0, 400))
expect('报错被捕获', bad.isError || /故意的错误/.test(bad.text))
expect('带「第 N 行」定位', /第 \d+ 行/.test(bad.text), bad.text.slice(0, 300))
expect('带源码片段', /raise ValueError/.test(bad.text), bad.text.slice(0, 300))
expect('带完整 traceback', /Traceback/.test(bad.text), bad.text.slice(0, 300))

console.log('\n=== 修复验证 5：bmesh faces 常见错误也能定位 ===')
const bmErr = await call('execute_python', {
  code: `import bpy, bmesh
bpy.ops.mesh.primitive_cube_add()
o = bpy.context.view_layer.objects.active
bm = bmesh.new()
bm.from_mesh(o.data)
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
bm.free()
`,
})
console.log('  ' + bmErr.text.slice(0, 400))
if (bmErr.isError) {
  expect('bmesh 错误带行号', /第 \d+ 行/.test(bmErr.text), bmErr.text.slice(0, 300))
  console.log('  （说明：bm.faces 要转 list，模型看到行号能自己改）')
} else {
  expect('这版 Blender 接受 bm.faces 直接传入', true)
}

console.log('\n=== 修复验证 6：capture_output=false 不报 NameError ===')
const nocap = await call('execute_python', {
  code: 'result = 1 + 1',
  capture_output: false,
})
console.log('  ' + nocap.text.slice(0, 150))
expect('capture_output=false 正常', !nocap.isError && /2/.test(nocap.text), nocap.text.slice(0, 150))

console.log('\n' + (failed === 0 ? 'FIXES_OK' : 'FIXES_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
