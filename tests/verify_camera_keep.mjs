/**
 * 验证 render_preview 不再覆盖用户摆好的相机。
 *
 * 报告里的问题：
 *   「它每次都把相机改成自动框选全场景，渲出来是一整张黑」
 * 根因：addon 里 auto_frame 默认为 True，所以场景有相机也被重定位。
 */
import fs from 'node:fs'
import zlib from 'node:zlib'

const URL = 'http://127.0.0.1:8765/mcp'
let seq = 0
async function mcp(n, a = {}) {
  const r = await fetch(URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name: n, arguments: a } }),
  }).then((x) => x.json()).catch(() => null)
  if (!r) return { isError: true, text: '失败' }
  const c = (r.result && r.result.content) || []
  return { isError: !!r.result?.isError, text: c.map((x) => x.text || '').join(' ') }
}

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

/** 粗检一张 PNG：返回尺寸和「占比最大的颜色」的比例。
 * 用来判断图是不是空的（全是同一种颜色 = 没内容）。 */
function analyzePng(data) {
  let pos = 8, w = 0, h = 0, ct = 0
  const idat = []
  while (pos + 8 <= data.length) {
    const len = data.readUInt32BE(pos)
    const type = data.subarray(pos + 4, pos + 8).toString('latin1')
    const body = data.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); ct = body[9] }
    else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  const ch = { 0: 1, 2: 3, 6: 4 }[ct] || 4
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * ch
  let prev = Buffer.alloc(stride)
  const hist = {}
  let total = 0, off = 0
  for (let y = 0; y < Math.min(h, 120) && off < raw.length; y++) {
    const f = raw[off]; off++
    const line = Buffer.from(raw.subarray(off, off + stride)); off += stride
    if (f === 1) for (let i = ch; i < stride; i++) line[i] = (line[i] + line[i - ch]) & 255
    else if (f === 2) for (let i = 0; i < stride; i++) line[i] = (line[i] + prev[i]) & 255
    else if (f === 3) for (let i = 0; i < stride; i++) { const a = i >= ch ? line[i - ch] : 0; line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255 }
    else if (f === 4) for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
      line[i] = (line[i] + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 255
    }
    prev = line
    for (let x = 0; x < stride; x += ch) {
      const k = (line[x] >> 4) + '_' + (line[x + 1] >> 4)
      hist[k] = (hist[k] || 0) + 1
      total++
    }
  }
  return { w, h, topRatio: Math.max(...Object.values(hist)) / total }
}

console.log('=== 建场景：远处一个大物体 + 近处一个小物体 + 灯光 ===')
await mcp('execute_python', {
  code: [
    'import bpy',
    'for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)',
    '# 远处的大物体（离原点 100）',
    'bpy.ops.mesh.primitive_cube_add(size=40, location=(100,0,20))',
    'bpy.context.view_layer.objects.active.name = "远处大件"',
    '# 近处的小物体（原点附近）—— 用户想拍这个',
    'bpy.ops.mesh.primitive_cube_add(size=2, location=(0,0,1))',
    'bpy.context.view_layer.objects.active.name = "近处小件"',
    '# **必须有灯光**：Eevee 无灯会全黑，那不是相机的问题',
    'ld = bpy.data.lights.new("主光", type="SUN")',
    'ld.energy = 5',
    'li = bpy.data.objects.new("主光", ld)',
    'bpy.context.scene.collection.objects.link(li)',
    'li.rotation_euler = (0.7, 0.3, 0.5)',
    'w = bpy.context.scene.world',
    'if w is None:',
    '    w = bpy.data.worlds.new("World")',
    '    bpy.context.scene.world = w',
    'w.use_nodes = True',
    'bg = w.node_tree.nodes.get("Background")',
    'if bg:',
    '    bg.inputs[0].default_value = (0.4, 0.45, 0.5, 1)',
    '    bg.inputs[1].default_value = 1.0',
    '# 用户摆好的相机：正对近处小件',
    'cd = bpy.data.cameras.new("机位")',
    'cam = bpy.data.objects.new("机位", cd)',
    'bpy.context.scene.collection.objects.link(cam)',
    'cam.location = (0, -8, 1.5)',
    'import mathutils',
    'd = mathutils.Vector((0,0,1)) - cam.location',
    'cam.rotation_euler = d.to_track_quat("-Z","Y").to_euler()',
    'cd.lens = 50',
    'bpy.context.scene.camera = cam',
    'print("相机就位，位置:", [round(v,2) for v in cam.location])',
  ].join('\n'),
})

console.log('\n=== ① 渲染：相机位置必须保持不变 ===')
const before = await mcp('execute_python', {
  code: 'import bpy\nc=bpy.context.scene.camera\nprint("LOC", [round(v,4) for v in c.location])',
})
const locBefore = (before.text.match(/LOC \[([^\]]+)\]/) || [])[1]
console.log('  渲染前相机位置: ' + locBefore)

const outPath = 'D:/dsh插件制作/ptc-model-check/tests/_cam_keep.png'
const r1 = await mcp('render_preview', { filepath: outPath, width: 320, height: 240 })
console.log('  渲染返回: ' + r1.text.slice(0, 140))
expect('渲染成功', !r1.isError, r1.text.slice(0, 200))

const after = await mcp('execute_python', {
  code: 'import bpy\nc=bpy.context.scene.camera\nprint("LOC", [round(v,4) for v in c.location])',
})
const locAfter = (after.text.match(/LOC \[([^\]]+)\]/) || [])[1]
console.log('  渲染后相机位置: ' + locAfter)
expect('相机位置没被改动', locBefore === locAfter, '前 ' + locBefore + ' → 后 ' + locAfter)

console.log('\n=== ② 渲染出来的图应该有内容（读的是第 ① 步的图）===')
{
  /* 注意：必须在第 ③ 步**之前**读图 —— 第 ③ 步会用 auto_frame 再渲一次，
   * 覆盖同一个文件（踩过这个顺序坑：读到的是后一次的图）。 */
  const p1 = 'D:/dsh插件制作/ptc-model-check/tests/_cam_keep1.png'
  await mcp('render_preview', { filepath: p1, width: 320, height: 240 })
  if (fs.existsSync(p1)) {
    const buf = fs.readFileSync(p1)
    console.log('  图片大小: ' + buf.length + ' 字节')
    expect('出了图', buf.length > 1000, String(buf.length))
    const a = analyzePng(buf)
    console.log('  尺寸: ' + a.w + 'x' + a.h + '  最多颜色占比: ' + (a.topRatio * 100).toFixed(1) + '%')
    expect('不是全同色（有内容）', a.topRatio < 0.98, (a.topRatio * 100).toFixed(1) + '%')
  } else {
    expect('出了图', false, '文件不存在')
  }
}

console.log('\n=== ③ 传 auto_frame: true 时才允许重定位 ===')
const r2 = await mcp('render_preview', { filepath: outPath, auto_frame: true, width: 320, height: 240 })
const after2 = await mcp('execute_python', {
  code: 'import bpy\nc=bpy.context.scene.camera\nprint("LOC", [round(v,4) for v in c.location])',
})
const locAfter2 = (after2.text.match(/LOC \[([^\]]+)\]/) || [])[1]
console.log('  相机位置: ' + locAfter + ' → ' + locAfter2)
expect('auto_frame:true 时才重定位', locAfter !== locAfter2,
  '没变（说明 auto_frame 没生效）')

console.log('\n' + (failed === 0 ? 'CAMERA_KEEP_OK' : 'CAMERA_KEEP_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
