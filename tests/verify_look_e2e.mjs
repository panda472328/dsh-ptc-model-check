/**
 * 端到端验证本次改动的核心能力：
 *   look({view:'angles'}) 一次给三个角度
 *   look({shading:'rendered'}) 真的吃场景灯 + 材质色
 */
import fs from 'node:fs'
const URL = 'http://127.0.0.1:8765/mcp'
let seq = 0
async function call(name, args = {}, timeoutMs = 240000) {
  const t0 = Date.now()
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(URL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } }),
      signal: ctl.signal,
    }).then((x) => x.json())
    const c = (r.result && r.result.content) || []
    const img = c.find((x) => x.type === 'image')
    const txt = c.filter((x) => x.type === 'text').map((x) => x.text).join(' ')
    return { ms: Date.now() - t0, ok: !r.result?.isError, b64: img ? img.data : null, txt: txt.slice(0, 260) }
  } catch (e) {
    return { ms: Date.now() - t0, ok: false, b64: null, txt: e.name === 'AbortError' ? '超时' : String(e.message) }
  } finally { clearTimeout(timer) }
}
const py = (code) => call('execute_python', { code })
const md5 = async (b64) => {
  if (!b64) return 'none'
  const { createHash } = await import('node:crypto')
  return createHash('md5').update(Buffer.from(b64, 'base64')).digest('hex').slice(0, 8)
}

let failed = 0
const expect = (label, cond, detail) => {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

console.log('=== ① 建测试场景：不对称物体 + 红材质 + 暖光 + 蓝环境 ===')
console.log('  ' + (await py([
  'import bpy',
  'for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)',
  'for m in list(bpy.data.materials): bpy.data.materials.remove(m)',
  'bpy.ops.mesh.primitive_cube_add(size=1, location=(0,0,0.5))',
  'a=bpy.context.view_layer.objects.active; a.name="主体"; a.scale=(1.7,0.9,0.8)',
  'bpy.ops.mesh.primitive_cube_add(size=0.5, location=(1.5,0,1.0))',
  'b=bpy.context.view_layer.objects.active; b.name="右侧突出"',
  'bpy.ops.mesh.primitive_cylinder_add(radius=0.2, depth=1.8, location=(-1.4,0,0.9))',
  'c=bpy.context.view_layer.objects.active; c.name="左侧柱"',
  'm=bpy.data.materials.new("红"); m.use_nodes=True',
  'bsdf=next((n for n in m.node_tree.nodes if n.type=="BSDF_PRINCIPLED"), None)',
  'if bsdf: bsdf.inputs["Base Color"].default_value=(0.9,0.06,0.06,1)',
  'a.data.materials.append(m)',
  'ld=bpy.data.lights.new("暖光", type="SUN"); ld.energy=5.0; ld.color=(1.0,0.6,0.3)',
  'li=bpy.data.objects.new("暖光", ld); bpy.context.scene.collection.objects.link(li)',
  'li.rotation_euler=(0.9,0.2,0.5)',
  'w=bpy.context.scene.world',
  'if w is None:',
  '    w=bpy.data.worlds.new("W"); bpy.context.scene.world=w',
  'w.use_nodes=True',
  'bg=w.node_tree.nodes.get("Background")',
  'if bg: bg.inputs[0].default_value=(0.15,0.25,0.85,1)',
  'print("READY mesh", sum(1 for o in bpy.context.scene.objects if o.type=="MESH"))',
].join('\n'))).txt)

console.log('\n=== ② look(angles)：一次拿三个角度 ===')
{
  const r = await call('look', { view: 'angles', shading: 'solid', width: 400, height: 300 })
  console.log('  ' + r.ms + ' ms  ' + r.txt)
  expect('angles 出图成功', r.ok && !!r.b64, r.txt)
  if (r.b64) {
    const b = Buffer.from(r.b64, 'base64')
    const w = b.readUInt32BE(16), h = b.readUInt32BE(20)
    console.log('  尺寸 ' + w + 'x' + h + '（应为纵向三倍高）')
    /* angles 的尺寸规则是 **宽度不变、高度 = 单张高度 × 3**（三张纵向拼起来）。
     * 我第一版按 h === w * 3 断言，是测试写错了——实现一直是对的。
     * 这里用「调用时传的 height=300」作为基准，更直白。 */
    expect('是纵向拼接的三视图（高度 = 单张 × 3）', h === 300 * 3, w + 'x' + h)
    fs.writeFileSync('D:/建模测试5/_e2e_angles_solid.png', b)
  }
}

console.log('\n=== ③ rendered 吃材质色（改材质应变图）===')
{
  const before = await call('look', { view: 'angles', shading: 'rendered', width: 340, height: 260 })
  const h1 = await md5(before.b64)
  await py([
    'import bpy',
    'for m in bpy.data.materials:',
    '    b=next((n for n in m.node_tree.nodes if n.type=="BSDF_PRINCIPLED"), None)',
    '    if b: b.inputs["Base Color"].default_value=(0.05,0.9,0.08,1)',
    'print("材质改绿")',
  ].join('\n'))
  const after = await call('look', { view: 'angles', shading: 'rendered', width: 340, height: 260 })
  const h2 = await md5(after.b64)
  console.log('  ' + before.ms + ' ms / ' + after.ms + ' ms')
  console.log('  改材质前 hash=' + h1 + '  后 hash=' + h2)
  expect('rendered 吃材质色', h1 !== h2 && h1 !== 'none', h1 + ' vs ' + h2)
  if (after.b64) fs.writeFileSync('D:/建模测试5/_e2e_angles_rendered.png', Buffer.from(after.b64, 'base64'))
}

console.log('\n=== ④ rendered 吃场景灯（关灯应变图）===')
{
  const on = await call('look', { view: 'front', shading: 'rendered', width: 260, height: 260 })
  const h1 = await md5(on.b64)
  await py([
    'import bpy',
    'for o in bpy.context.scene.objects:',
    '    if o.type=="LIGHT": o.hide_render=True',
    'print("灯已关")',
  ].join('\n'))
  const off = await call('look', { view: 'front', shading: 'rendered', width: 260, height: 260 })
  const h2 = await md5(off.b64)
  console.log('  开灯 hash=' + h1 + '  关灯 hash=' + h2)
  expect('rendered 吃场景灯', h1 !== h2 && h1 !== 'none', h1 + ' vs ' + h2)
  await py([
    'import bpy',
    'for o in bpy.context.scene.objects:',
    '    if o.type=="LIGHT": o.hide_render=False',
    'print("灯已开回")',
  ].join('\n'))
}

console.log('\n=== ⑤ solid 与 rendered 必须不同（证明 rendered 走真引擎）===')
{
  const s = await call('look', { view: 'front', shading: 'solid', width: 240, height: 240 })
  const r = await call('look', { view: 'front', shading: 'rendered', width: 240, height: 240 })
  const hs = await md5(s.b64), hr = await md5(r.b64)
  console.log('  solid=' + hs + '(' + s.ms + 'ms)   rendered=' + hr + '(' + r.ms + 'ms)')
  expect('两种 shading 结果不同', hs !== hr, hs + ' vs ' + hr)
  expect('solid 更快（看形体应更快）', s.ms <= r.ms + 200, s.ms + ' vs ' + r.ms)
}

console.log('\n=== ⑥ 没灯场景 rendered 不应全黑（补光兜底）===')
{
  await py([
    'import bpy',
    'for o in list(bpy.data.objects):',
    '    if o.type=="LIGHT": bpy.data.objects.remove(o, do_unlink=True)',
    'print("灯全删")',
  ].join('\n'))
  const r = await call('look', { view: 'angles', shading: 'rendered', width: 300, height: 240 })
  console.log('  ' + r.ms + ' ms  ' + r.txt)
  expect('无灯时仍出图', r.ok && !!r.b64, r.txt)
  expect('未报空图警告', !/空图|全是同一种颜色/.test(r.txt), r.txt)
  if (r.b64) fs.writeFileSync('D:/建模测试5/_e2e_nofill_light.png', Buffer.from(r.b64, 'base64'))
}

console.log('\n' + (failed === 0 ? 'LOOK_E2E_OK' : 'LOOK_E2E_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
