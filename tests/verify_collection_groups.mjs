/**
 * 验证 Collection 分组流程：建组 → 检查 → 未分组算失败。
 *   node tests/verify_collection_groups.mjs
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
function parse(t) { try { return JSON.parse(t) } catch { return null } }

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

console.log('=== 0. 分组工具是否可用 ===')
const list = await fetch(URL, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
}).then((r) => r.json())
const names = (list.result?.tools || []).map((t) => t.name)
console.log('  MCP 工具数: ' + names.length)
for (const t of ['group_create', 'group_list', 'group_split', 'group_select', 'group_delete']) {
  expect('有 ' + t, names.includes(t))
}

console.log('\n=== 1. 建场景：桌子 + 椅子，零件命名**不带前缀** ===')
await mcp('execute_python', {
  code: `
import bpy
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
for c in list(bpy.data.collections):
    bpy.data.collections.remove(c)
def box(name, loc, dims):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.view_layer.objects.active
    o.name = name; o.scale = dims
    bpy.ops.object.transform_apply(scale=True)
# 零件命名故意不带前缀，证明 Collection 分组比命名推断可靠
box('TableTop', (0,0,1.0), (2,1.2,0.08))
box('LegA', (-0.85,-0.45,0.95), (0.2,0.2,0.3))
box('LegB', (0.85,0.45,0.95), (0.2,0.2,0.3))
box('Seat', (3,0,0.5), (0.5,0.5,0.05))
box('Backrest', (3,0.3,0.8), (0.5,0.05,0.55))
print('5 个零件建好，命名不带前缀')
`,
})

console.log('\n=== 2. 没建组时，model_groups 应报「退回推断」 ===')
const cfg = {
  source: 'auto', blend: '', obj: '', url: '', cdpPort: 0, targetMatch: '', blenderPath: '',
  minDepth: 0.0005, minRatio: 0.005, maxObjects: 3000, maxTriangles: 2000000,
}
function makeTools() {
  const src = new SceneSource({ source: 'auto' }, { packageDir: PACKAGE_DIR })
  return buildTools({
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
}
let tools = makeTools()
let gt = tools.find((x) => x.name === 'model_groups')
let r = await gt.execute({}, { signal: new AbortController().signal })
const g0 = gt.output.render({}, r).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
console.log(g0.split('\n').slice(0, 12).join('\n'))
expect('报出分组依据不可靠', r.reliable === false, String(r.reliable))
expect('提示要建组', /group_create|group_split/.test(g0), g0.slice(0, 400))

console.log('\n=== 3. 用 group_create 建两个物品组 ===')
const c1 = await mcp('group_create', {
  group: '桌子', objects: ['TableTop', 'LegA', 'LegB'],
})
console.log('  桌子: ' + c1.text.slice(0, 150))
expect('建桌子组成功', !c1.isError, c1.text.slice(0, 200))

const c2 = await mcp('group_create', {
  group: '椅子', objects: ['Seat', 'Backrest'],
})
console.log('  椅子: ' + c2.text.slice(0, 150))
expect('建椅子组成功', !c2.isError, c2.text.slice(0, 200))

console.log('\n=== 4. group_list 应报 2 组、0 散件 ===')
const gl = await mcp('group_list', {})
const glv = parse(gl.text)
console.log('  组数: ' + glv?.group_count + '，散件: ' + glv?.ungrouped_count)
for (const g of (glv?.groups || [])) {
  console.log('    「' + g.name + '」' + g.part_count + ' 件: ' + g.parts.join('、'))
}
expect('2 个组', glv?.group_count === 2, String(glv?.group_count))
expect('没有散件', glv?.ungrouped_count === 0, JSON.stringify(glv?.ungrouped))

console.log('\n=== 5. model_groups 应认到 Collection 分组 ===')
tools = makeTools()
gt = tools.find((x) => x.name === 'model_groups')
r = await gt.execute({}, { signal: new AbortController().signal })
const g1 = gt.output.render({}, r).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
console.log(g1.split('\n').slice(0, 12).join('\n'))
expect('分组依据是 collection', r.groupedBy === 'collection', String(r.groupedBy))
expect('标记为可靠', r.reliable === true, String(r.reliable))
expect('2 个组', r.groupCount === 2, String(r.groupCount))
expect('0 散件', r.ungroupedCount === 0, String(r.ungroupedCount))
expect('文案确认用 Collection', /Collection 分组（可靠）/.test(g1), g1.slice(0, 300))

console.log('\n=== 6. model_loop 的分组状态应为 ok ===')
tools = makeTools()
let lt = tools.find((x) => x.name === 'model_loop')
let lv = await lt.execute(
  { reset: true, verdict: 'continue', next_improvement: 'X', per_mesh_views: false },
  { signal: new AbortController().signal },
)
console.log('  groupingState: ' + JSON.stringify(lv.groupingState))
expect('分组可靠', lv.groupingState?.reliable === true, JSON.stringify(lv.groupingState))
expect('分组 ok', lv.groupingState?.ok === true, JSON.stringify(lv.groupingState))

console.log('\n=== 7. 加一个散件 → 应判失败 ===')
await mcp('execute_python', {
  code: `
import bpy
bpy.ops.mesh.primitive_cube_add(size=0.3, location=(8,8,8))
o = bpy.context.view_layer.objects.active
o.name = 'LoosePart'
print('加了散件 LoosePart')
`,
})
tools = makeTools()
gt = tools.find((x) => x.name === 'model_groups')
r = await gt.execute({}, { signal: new AbortController().signal })
const g2 = gt.output.render({}, r).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
console.log('  散件: ' + JSON.stringify(r.ungrouped))
expect('检出散件', r.ungroupedCount === 1 && r.ungrouped[0] === 'LoosePart',
  JSON.stringify(r.ungrouped))
expect('文案标记散件为错误', /⛔/.test(g2), g2.slice(0, 500))

tools = makeTools()
lt = tools.find((x) => x.name === 'model_loop')
lv = await lt.execute(
  { reset: true, verdict: 'continue', next_improvement: 'X', per_mesh_views: false },
  { signal: new AbortController().signal },
)
console.log('  groupingState: ' + JSON.stringify(lv.groupingState))
console.log('  pass: ' + lv.pass)
expect('散件导致 pass=false', lv.pass === false, String(lv.pass))
expect('groupingState.ok=false', lv.groupingState?.ok === false,
  JSON.stringify(lv.groupingState))
expect('停止条件含散件条目',
  (lv.stopBlockers || []).some((b) => /没有归入任何物品组/.test(b)),
  JSON.stringify(lv.stopBlockers))

console.log('\n=== 8. 把散件补进组 → 恢复正常 ===')
await mcp('group_create', { group: '桌子', objects: ['LoosePart'] })
tools = makeTools()
gt = tools.find((x) => x.name === 'model_groups')
r = await gt.execute({}, { signal: new AbortController().signal })
expect('散件补进组后归零', r.ungroupedCount === 0, JSON.stringify(r.ungrouped))

tools = makeTools()
lt = tools.find((x) => x.name === 'model_loop')
lv = await lt.execute(
  { reset: true, verdict: 'continue', next_improvement: 'X', per_mesh_views: false },
  { signal: new AbortController().signal },
)
expect('分组 ok 恢复', lv.groupingState?.ok === true, JSON.stringify(lv.groupingState))

console.log('\n=== 9. group_split 自动推断（dry_run）===')
await mcp('execute_python', {
  code: `
import bpy
for c in list(bpy.data.collections):
    for o in list(c.objects):
        if o.name not in bpy.context.scene.collection.objects:
            bpy.context.scene.collection.objects.link(o)
    bpy.data.collections.remove(c)
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
def box(name, loc, dims):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.view_layer.objects.active
    o.name = name; o.scale = dims
    bpy.ops.object.transform_apply(scale=True)
box('桌_面', (0,0,1), (2,2,0.1))
box('桌_腿', (-0.8,-0.8,0.5), (0.1,0.1,1))
box('椅_座', (3,0,0.5), (0.5,0.5,0.05))
print('ok')
`,
})
const sp = await mcp('group_split', { mode: 'prefix', dry_run: true })
const spv = parse(sp.text)
console.log('  推断结果: ' + JSON.stringify(spv?.groups?.map((g) => [g.name, g.parts])))
expect('推断出 2 组', spv?.groups?.length === 2, String(spv?.groups?.length))

console.log('\n' + (failed === 0 ? 'COLLECTION_GROUPS_OK' : 'COLLECTION_GROUPS_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
