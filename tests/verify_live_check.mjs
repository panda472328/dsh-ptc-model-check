/**
 * 核心验证：检查工具读的是**活场景**，不是磁盘。
 *
 * 步骤：
 *   1. 通过 MCP 建两个会穿透的立方体（不存盘）
 *   2. 用 model_loop（live 源）检查，应该报穿模
 *   3. 通过 MCP 把它们拉开（不存盘）
 *   4. 再检查，应该报干净
 *
 * 如果检查读的是磁盘，第 4 步还会报穿模（因为没存盘）。
 */

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

const MCP = 'http://127.0.0.1:8765/mcp'
let seq = 0
async function mcp(name, args = {}) {
  const r = await fetch(MCP, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } }),
  }).then((x) => x.json())
  const c = (r.result && r.result.content) || []
  return { isError: !!r.result?.isError, text: c.map((x) => x.text || '').join(' ') }
}

const cfg = {
  source: 'live', blend: '', obj: '', url: '', cdpPort: 0, targetMatch: '', blenderPath: '',
  minDepth: 0.0005, minRatio: 0.005, minGap: 0.01, minGapRatio: 0.02,
  maxObjects: 3000, maxTriangles: 2000000,
}
const live = new SceneSource({ source: 'live' }, { packageDir: PACKAGE_DIR })
const tools = buildTools({
  sourceFor: () => live,
  config: () => cfg,
  remember: () => {},
  hostCtx: { get: () => undefined },
})
const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
const exec = { signal: new AbortController().signal }

async function run(name, args) {
  const v = await byName[name].execute(args, exec)
  const b = byName[name].output.render(args, v)
  return { value: v, text: b.filter((x) => x.type === 'text').map((x) => x.text).join('\n') }
}

console.log('=== 0. 确认 live 源可用 ===')
const ping = await mcp('ping')
expect('MCP 连着 Blender', /pong/.test(ping.text), ping.text.slice(0, 150))

console.log('\n=== 1. 建两个互相穿透的立方体（不存盘）===')
const build = await mcp('execute_python', {
  code: `
import bpy
for n in ('LIVE_A', 'LIVE_B'):
    o = bpy.data.objects.get(n)
    if o:
        bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.mesh.primitive_cube_add(size=2.0, location=(0, 0, 0))
a = bpy.context.view_layer.objects.active
a.name = 'LIVE_A'
a['ptc_part'] = 'LIVE_A'
bpy.ops.mesh.primitive_cube_add(size=2.0, location=(1.5, 0, 0))
b = bpy.context.view_layer.objects.active
b.name = 'LIVE_B'
b['ptc_part'] = 'LIVE_B'
print('建好：中心距 1.5，边长 2.0，应穿透 0.5')
`,
})
expect('建物体成功', !build.isError, build.text.slice(0, 200))

/* 清理场景里其他测试残留的物体——否则它们会和 LIVE_A 重叠，
 * 被算进「组间穿模」，导致后面所有断言都错。 */
const clean = await mcp('execute_python', {
  code: `
import bpy
keep = {'LIVE_A', 'LIVE_B'}
removed = 0
for o in list(bpy.data.objects):
    if o.name not in keep:
        bpy.data.objects.remove(o, do_unlink=True)
        removed += 1
print('cleaned ' + str(removed))
`,
})
console.log('清场: ' + clean.text.slice(0, 80))

console.log('\n=== 2. 检查（live）应报穿模 ===')
const c1 = await run('model_loop', { scope: ['LIVE_A', 'LIVE_B'], verdict: 'continue', next_improvement: 'x' })
console.log(c1.text.split('\n').slice(0, 6).join('\n'))
expect('检测到穿模', c1.value.interference.hits > 0,
  'hits=' + c1.value.interference.hits)
const hit = (c1.value.interference.items || [])[0]
if (hit) {
  expect('穿透深度≈0.5', Math.abs(hit.depth - 0.5) < 0.08, 'depth=' + hit.depth)
}

console.log('\n=== 3. 把 LIVE_B 移开（让它真实接触但不穿透，仍不存盘）===')
const move = await mcp('execute_python', {
  code: `
import bpy
b = bpy.data.objects['LIVE_B']
b.location = (2.0, 0, 0)
print('移到 x=2.0：两面正好贴合')
`,
})
expect('移动成功', !move.isError, move.text.slice(0, 150))

console.log('\n=== 4. 再检查——应该没有穿模了 ===')
const c2 = await run('model_loop', { scope: ['LIVE_A', 'LIVE_B'], verdict: 'continue', next_improvement: 'x' })
console.log(c2.text.split('\n').slice(0, 6).join('\n'))
expect('移动后不再报穿模', c2.value.interference.hits === 0,
  'hits=' + c2.value.interference.hits)
expect('贴合的两个件都不算孤立', c2.value.isolation.hits === 0,
  'iso=' + c2.value.isolation.hits
  + ' items=' + JSON.stringify((c2.value.isolation.items || []).map((h) => [h.part, h.gap])))

console.log('\n=== 5. 拉开到不接触——应该报孤立 ===')
const apart = await mcp('execute_python', {
  code: `
import bpy
b = bpy.data.objects['LIVE_B']
b.location = (5.0, 0, 0)
print('移到 x=5.0：间距 2.0')
`,
})
expect('移动成功', !apart.isError, apart.text.slice(0, 150))
const c3 = await run('model_loop', { scope: ['LIVE_A', 'LIVE_B'], verdict: 'continue', next_improvement: 'x' })
console.log(c3.text.split('\n').slice(0, 8).join('\n'))
expect('两个件都成了孤立件', c3.value.isolation.hits === 2,
  'hits=' + c3.value.isolation.hits
  + ' items=' + JSON.stringify((c3.value.isolation.items || []).map((h) => [h.part, h.gap])))

console.log('\n' + (failed === 0 ? 'LIVE_CHECK_OK' : 'LIVE_CHECK_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
