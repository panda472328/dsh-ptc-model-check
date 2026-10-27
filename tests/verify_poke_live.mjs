/**
 * 端到端验证：桌上的腿穿出桌面，应被检出并导致失败。
 *   node tests/verify_poke_live.mjs
 */

const URL = 'http://127.0.0.1:8765/mcp'
let seq = 0
async function mcp(n, a = {}) {
  const r = await fetch(URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name: n, arguments: a } }),
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
if (ping.isError) { console.log('Blender 没连上'); process.exit(2) }

console.log('=== 场景 A：腿穿出桌面（错误）===')
await mcp('execute_python', {
  code: `
import bpy
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
for m in list(bpy.data.materials):
    bpy.data.materials.remove(m)
def box(name, loc, dims):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.view_layer.objects.active
    o.name = name; o.scale = dims
    bpy.ops.object.transform_apply(scale=True)
# 桌面 z 0.96~1.04；腿 z 0.04~1.08 → 腿从桌面上表面穿出
box('桌_桌面', (0,0,1.0), (2,1.2,0.08))
box('桌_腿1', (-0.85,-0.45,0.56), (0.09,0.09,1.04))
box('桌_腿2', (0.85,0.45,0.56), (0.09,0.09,1.04))
# 建物品组（新规则要求 Collection 分组）
import bpy as _b
for c in list(_b.data.collections):
    _b.data.collections.remove(c)
print('ok')
`,
})

const cfg = {
  source: 'auto', blend: '', obj: '', url: '', cdpPort: 0, targetMatch: '', blenderPath: '',
  minDepth: 0.0005, minRatio: 0.005, maxObjects: 3000, maxTriangles: 2000000,
}
const src = new SceneSource({ source: 'auto' }, { packageDir: PACKAGE_DIR })
const tools = buildTools({
  sourceFor: () => src,
  config: () => cfg,
  remember: () => {},
  hostCtx: { get: () => undefined },
  getRefState: () => ({ given: false, analyzed: false }),
  markRefAnalyzed: () => {},
  getPhaseState: () => ({ modelingComplete: false }),
  markModelingComplete: () => {},
  resetPhase: () => {},
})
await mcp('group_create', { group: '桌', objects: ['桌_桌面', '桌_腿1', '桌_腿2'] })
const t = tools.find((x) => x.name === 'model_loop')
const v = await t.execute(
  { target: '桌', reset: true, verdict: 'continue', next_improvement: 'X', per_mesh_views: false },
  { signal: new AbortController().signal },
)
const blocks = t.output.render({}, v)
const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')

console.log(text.split('\n').slice(0, 20).join('\n'))
console.log('\n--- 结构化数据 ---')
console.log('internalPokeCount: ' + v.interference.internalPokeCount)
console.log('byState: ' + JSON.stringify(v.interference.byState))
console.log('groups[0].internalPokeCount: ' + v.groups[0]?.internalPokeCount)
console.log('pass: ' + v.pass)

expect('检出穿出', (v.interference.internalPokeCount || 0) > 0,
  String(v.interference.internalPokeCount))
expect('穿出导致 pass=false', v.pass === false, String(v.pass))
expect('文案标记 ⛔', /⛔/.test(text), text.slice(0, 500))
expect('文案含「穿出」字样', /穿出/.test(text), text.slice(0, 600))
expect('文案说明穿出必须修', /必须修/.test(text), text.slice(0, 600))
expect('byState 统计了状态', !!v.interference.byState && Object.keys(v.interference.byState).length > 0,
  JSON.stringify(v.interference.byState))
expect('groups 也统计穿出', (v.groups[0]?.internalPokeCount || 0) > 0,
  String(v.groups[0]?.internalPokeCount))

console.log('\n=== 场景 B：腿正确插入（不穿出）→ 应通过 ===')
await mcp('execute_python', {
  code: `
import bpy
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
def box(name, loc, dims):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.view_layer.objects.active
    o.name = name; o.scale = dims
    bpy.ops.object.transform_apply(scale=True)
# 桌面 z 0.96~1.04；腿 z 0.04~1.0 → 腿顶藏在桌面内部
box('桌_桌面', (0,0,1.0), (2,1.2,0.08))
box('桌_腿1', (-0.85,-0.45,0.52), (0.09,0.09,0.96))
print('ok')
`,
})

const src2 = new SceneSource({ source: 'auto' }, { packageDir: PACKAGE_DIR })
const tools2 = buildTools({
  sourceFor: () => src2,
  config: () => cfg,
  remember: () => {},
  hostCtx: { get: () => undefined },
  getRefState: () => ({ given: false, analyzed: false }),
  markRefAnalyzed: () => {},
  getPhaseState: () => ({ modelingComplete: false }),
  markModelingComplete: () => {},
  resetPhase: () => {},
})
await mcp('group_create', { group: '桌', objects: ['桌_桌面', '桌_腿1'] })
const t2 = tools2.find((x) => x.name === 'model_loop')
const v2 = await t2.execute(
  { target: '桌', reset: true, verdict: 'continue', next_improvement: 'X', per_mesh_views: false },
  { signal: new AbortController().signal },
)
const text2 = t2.output.render({}, v2).filter((b) => b.type === 'text').map((b) => b.text).join('\n')

console.log('internalCount: ' + v2.interference.internalCount
  + ' internalPokeCount: ' + v2.interference.internalPokeCount
  + ' pass: ' + v2.pass)
console.log(text2.split('\n').slice(0, 12).join('\n'))
expect('有组内插入', (v2.interference.internalCount || 0) > 0,
  String(v2.interference.internalCount))
expect('没有穿出', (v2.interference.internalPokeCount || 0) === 0,
  String(v2.interference.internalPokeCount))
expect('插入不阻止通过', v2.pass === true,
  'pass=' + v2.pass + ' blockers=' + JSON.stringify(v2.stopBlockers))

console.log('\n' + (failed === 0 ? 'POKE_LIVE_OK' : 'POKE_LIVE_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
