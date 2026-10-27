/**
 * 验证「逐物品推进」流程：单个物品检查 + 全局检查。
 *   node tests/verify_per_item_flow.mjs
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

console.log('=== 建场景：桌子正常，椅子穿进桌子 ===')
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
# 桌子：腿**真的插进**桌面（组内插接，正常做法）
box('桌_桌面', (0,0,1.0), (2,1.2,0.08))
box('桌_腿1', (-0.85,-0.45,0.55), (0.09,0.09,1.0))
box('桌_腿2', (0.85,0.45,0.55), (0.09,0.09,1.0))
# 椅子：座面故意穿进桌面右边缘（组间穿模）
box('椅_座面', (0.85,0,1.0), (0.5,0.5,0.05))
box('椅_靠背', (1.05,0.2,1.3), (0.5,0.05,0.55))
print('ok')
`,
})

const cfg = {
  source: 'auto', blend: '', obj: '', url: '', cdpPort: 0, targetMatch: '', blenderPath: '',
  minDepth: 0.0005, minRatio: 0.005, maxObjects: 3000, maxTriangles: 2000000,
}
function makeTools() {
  const src = new SceneSource({ source: 'auto' }, { packageDir: PACKAGE_DIR })
  let imgN = 0
  return buildTools({
    sourceFor: () => src,
    config: () => cfg,
    remember: () => {},
    hostCtx: {
      get: (n) => (n === 'attachments'
        ? { saveImage: async ({ name }) => ({ id: 'i' + (++imgN), name }) }
        : undefined),
    },
    getRefState: () => ({ given: false, analyzed: false }),
    markRefAnalyzed: () => {},
    getPhaseState: () => ({ modelingComplete: false }),
    markModelingComplete: () => {},
    resetPhase: () => {},
  })
}
const tools = makeTools()
const loopTool = tools.find((x) => x.name === 'model_loop')

async function runLoop(args) {
  const v = await loopTool.execute(args, { signal: new AbortController().signal })
  const blocks = loopTool.output.render(args, v)
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  return { v, text, imgs: blocks.filter((b) => b.type === 'image').length }
}

console.log('\n=== 步骤 1：先检查单个物品「桌」 ===')
const zhuo = await runLoop({
  target: '桌', reset: true, verdict: 'continue', next_improvement: 'X',
})
console.log(zhuo.text.split('\n').slice(0, 12).join('\n'))
expect('桌面组名能被识别', /物品「桌」/.test(zhuo.text), zhuo.text.slice(0, 200))
expect('只检查 3 个 mesh', zhuo.v.meshes === 3, String(zhuo.v.meshes))
expect('报告组内插接（腿插进桌面）', zhuo.v.interference.internalCount > 0,
  String(zhuo.v.interference.internalCount))
/* 注意：「桌」这一轮的组间穿模会报出「桌 vs 椅」——
 * 这是**正确行为**：虽然只检查桌子，但穿模在全场景里查过，
 * 所以桌椅碰撞会从桌子这侧也被发现。 */
expect('组间穿模报告的是桌和椅',
  zhuo.v.interference.crossGroup.every(
    (c) => c.aGroup === '桌' || c.bGroup === '桌'),
  JSON.stringify(zhuo.v.interference.crossGroup.map((c) => [c.aGroup, c.bGroup])))
expect('只有 1 个组', zhuo.v.groupCount === 1, String(zhuo.v.groupCount))
expect('附了五视图', zhuo.imgs >= 5, String(zhuo.imgs))

console.log('\n=== 步骤 2：再检查单个物品「椅」——应发现它穿进桌子 ===')
const yi = await runLoop({ target: '椅', verdict: 'continue', next_improvement: 'Y' })
console.log(yi.text.split('\n').slice(0, 16).join('\n'))
expect('椅子组名能被识别', /物品「椅」/.test(yi.text), yi.text.slice(0, 200))
expect('只检查 2 个 mesh', yi.v.meshes === 2, String(yi.v.meshes))
expect('检出组间穿模（椅 vs 桌）', yi.v.interference.crossCount > 0,
  String(yi.v.interference.crossCount))
expect('组间数据含桌和椅', yi.v.interference.crossGroup.some(
  (c) => (c.aGroup === '椅' || c.bGroup === '椅') && (c.aGroup === '桌' || c.bGroup === '桌')),
  JSON.stringify(yi.v.interference.crossGroup.map((c) => [c.aGroup, c.bGroup])))
expect('椅子这一轮不通过', yi.v.pass === false, String(yi.v.pass))

console.log('\n=== 步骤 3：最后做一次全局检查 ===')
const all = await runLoop({ target: 'scene', verdict: 'continue', next_improvement: 'Z' })
console.log(all.text.split('\n').slice(0, 10).join('\n'))
expect('全局检查 5 个 mesh', all.v.meshes === 5, String(all.v.meshes))
expect('全局 2 个组', all.v.groupCount === 2, String(all.v.groupCount))
expect('全局检出组间穿模', all.v.interference.crossCount > 0,
  String(all.v.interference.crossCount))
expect('全局不通过', all.v.pass === false, String(all.v.pass))

console.log('\n=== 步骤 4：错误组名应给出可用列表 ===')
try {
  await runLoop({ target: '不存在的物品' })
  expect('错误组名应报错', false, '竟然没报错')
} catch (e) {
  const msg = String(e.message || e)
  console.log('  ' + msg.split('\n').slice(0, 3).join('\n  '))
  expect('报错列出可用组', /现有物品组/.test(msg), msg.slice(0, 200))
  expect('报错含桌和椅', /桌/.test(msg) && /椅/.test(msg), msg.slice(0, 200))
}

console.log('\n' + (failed === 0 ? 'PER_ITEM_FLOW_OK' : 'PER_ITEM_FLOW_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
