/**
 * 端到端：在真实 Blender 场景里验证逐 mesh 隔离检查 + 精度一致性。
 *   node tests/verify_permesh_live.mjs
 *
 * 造三个精度一致的对象 + 一个过密的球，看 model_loop 是否报出来。
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

import { SceneSource } from '../lib/adapters/index.mjs'
import { buildTools } from '../lib/tools.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = path.resolve(HERE, '..')

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

const ping = await mcp('ping')
if (ping.isError) {
  console.log('Blender 没连上，跳过。先调 blender_ready。')
  process.exit(2)
}
console.log('Blender: ' + ping.text.slice(0, 80))

console.log('\n=== 建场景：3 个精度一致的立方体 + 1 个过密球 + 1 个未焊接件 ===')
const build = await mcp('execute_python', {
  code: `
import bpy, bmesh

# **清空整个场景**，不只是 PM_ 前缀的对象。
# 为什么：精度离群是「同尺寸组内比较」，场景里但凡有别的测试留下的
# 过密/过粗对象，就会被算进比较集，导致这个测试误判失败（踩过）。
# 测试之间必须互不影响，所以一开始就清干净。
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
for c in list(bpy.data.collections):
    bpy.data.collections.remove(c)

# 三个精度一致的立方体（细分级别相同，都用 bevel 制造一致的分段）
for i, x in enumerate((-4, 0, 4)):
    bpy.ops.mesh.primitive_cube_add(size=2, location=(x, 0, 0))
    o = bpy.context.view_layer.objects.active
    o.name = 'PM_箱体%d' % i
    # 加倒角让网格密度一致
    m = o.modifiers.new('bev', 'BEVEL')
    m.width = 0.1
    m.segments = 3

# 一个过密的球（面数远超其它）
bpy.ops.mesh.primitive_uv_sphere_add(radius=1, segments=128, ring_count=64, location=(0, 4, 0))
s = bpy.context.view_layer.objects.active
s.name = 'PM_球_过密'

print('建好 4 个对象')
`,
})
console.log('  ' + build.text.slice(0, 150))
expect('建物体成功', !build.isError, build.text.slice(0, 200))

const cfg = {
  source: 'live', blend: '', obj: '', url: '', cdpPort: 0, targetMatch: '', blenderPath: '',
  minDepth: 0.0005, minRatio: 0.005, maxObjects: 3000, maxTriangles: 2000000,
}
const live = new SceneSource({ source: 'live' }, { packageDir: PACKAGE_DIR })
const tools = buildTools({
  sourceFor: () => live,
  config: () => cfg,
  remember: () => {},
  hostCtx: { get: () => undefined },
  getRefState: () => ({ given: false, analyzed: false }),
  markRefAnalyzed: () => {},
})
const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
const exec = { signal: new AbortController().signal }

async function run(name, args) {
  const t = byName[name]
  const v = await t.execute(args, exec)
  const b = t.output.render(args, v)
  return { value: v, text: b.filter((x) => x.type === 'text').map((x) => x.text).join('\n') }
}

console.log('\n=== model_loop：含逐 mesh 与精度 ===')
const chk = await run('model_loop', { verdict: 'continue', next_improvement: 'x' })
const lines = chk.text.split('\n')
const startIdx = lines.findIndex((l) => l.includes('逐 mesh 隔离检查'))
console.log(lines.slice(startIdx, startIdx + 14).join('\n'))

expect('返回 perMesh', !!chk.value.perMesh, JSON.stringify(Object.keys(chk.value)))
const prec = chk.value.perMesh?.precision || {}
console.log('\n  精度中位数：面密度 ' + prec.median?.faceDensityRel
  + '，边长比 ' + prec.median?.edgeRatio)
expect('检出精度离群', (prec.outliers || []).length > 0,
  JSON.stringify((prec.outliers || []).map((o) => o.part)))
expect('过密球被点名',
  (prec.outliers || []).some((o) => o.part && o.part.includes('球')),
  JSON.stringify((prec.outliers || []).map((o) => o.part)))

console.log('\n=== model_loop：精度不一致应导致 pass=false ===')
const loop = await run('model_loop', { reset: true, verdict: 'continue', next_improvement: 'X' })
console.log('  pass=' + loop.value.pass)
expect('model_loop 返回 perMesh', !!loop.value.perMesh, JSON.stringify(Object.keys(loop.value)))
expect('精度不一致时 pass=false', loop.value.pass === false, 'pass=' + loop.value.pass)
/* 断言要和实际文案一致：原文是「过密降细分，过粗加细分」（没有「的」）。 */
expect('文案说明了怎么修', /过密降细分|过粗加细分/.test(loop.text), loop.text.slice(-300))
expect('列出了离群零件', /PM_球_过密/.test(loop.text), loop.text.slice(-500))

console.log('\n=== 清掉过密球后应该恢复 ===')
await mcp('execute_python', {
  code: `import bpy\no=bpy.data.objects.get('PM_球_过密')\nif o: bpy.data.objects.remove(o, do_unlink=True)\nprint('removed')`,
})
const loop2 = await run('model_loop', { reset: true, verdict: 'continue', next_improvement: 'X' })
console.log('  清掉后 pass=' + loop2.value.pass
  + '，离群 ' + (loop2.value.perMesh?.precision?.outliers || []).length + ' 个')
expect('清掉过密件后不再有精度离群',
  (loop2.value.perMesh?.precision?.outliers || []).length === 0,
  JSON.stringify((loop2.value.perMesh?.precision?.outliers || []).map((o) => o.part)))

console.log('\n' + (failed === 0 ? 'PERMESH_LIVE_OK' : 'PERMESH_LIVE_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
