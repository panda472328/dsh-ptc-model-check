/**
 * 验证分组五视图在**默认 auto 源**下真的会跑（这是之前失效的场景）。
 *   node tests/verify_group_views_live.mjs
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
import { groupMeshesIntoItems } from '../lib/core/grouping.mjs'
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

console.log('=== 建两个物品：桌子(3件) + 椅子(3件) ===')
const setup = await mcp('execute_python', {
  code: `
import bpy
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
for m in list(bpy.data.materials):
    bpy.data.materials.remove(m)

def box(name, loc, dims):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.view_layer.objects.active
    o.name = name
    o.scale = dims
    bpy.ops.object.transform_apply(scale=True)
    return o

# 桌子
box('桌_桌面', (0,0,0.75), (1.4, 0.8, 0.06))
box('桌_腿1', (-0.6,-0.3,0.36), (0.07,0.07,0.72))
box('桌_腿2', (0.6,-0.3,0.36), (0.07,0.07,0.72))

# 椅子（放远一点）
box('椅_座面', (2.2,0,0.45), (0.45,0.45,0.05))
box('椅_靠背', (2.2,0.2,0.75), (0.45,0.05,0.5))
box('椅_腿', (2.2,0,0.2), (0.05,0.05,0.4))
print('6 个 mesh 建好')
`,
})
console.log('  ' + setup.text.slice(0, 90))
expect('建场景成功', !setup.isError, setup.text.slice(0, 150))

console.log('\n=== 分组检查 ===')
const live = new SceneSource({ source: 'auto' }, { packageDir: PACKAGE_DIR })
const { meshes } = await live.extract({})
console.log('  场景 mesh 数: ' + meshes.length)
const groups = groupMeshesIntoItems(meshes)
console.log('  分组数: ' + groups.length)
for (const g of groups) {
  console.log('    「' + g.name + '」' + g.parts.length + ' 件: ' + g.parts.join(', '))
}
expect('分成 2 组', groups.length === 2, String(groups.length))
expect('桌组 3 件', groups.some((g) => g.name === '桌' && g.parts.length === 3),
  JSON.stringify(groups.map((g) => [g.name, g.parts.length])))
expect('椅组 3 件', groups.some((g) => g.name === '椅' && g.parts.length === 3),
  JSON.stringify(groups.map((g) => [g.name, g.parts.length])))

console.log('\n=== 关键：默认 auto 源下 model_loop 必须真的渲染分组五视图 ===')
const cfg = {
  source: 'auto', blend: '', obj: '', url: '', cdpPort: 0, targetMatch: '', blenderPath: '',
  minDepth: 0.0005, minRatio: 0.005, maxObjects: 3000, maxTriangles: 2000000,
}
const autoSrc = new SceneSource({ source: 'auto' }, { packageDir: PACKAGE_DIR })

/* 注入假的 attachments 服务，验证图片真的附上 */
let saved = 0
const hostCtx = {
  get: (n) => (n === 'attachments'
    ? { saveImage: async ({ data, mediaType, name }) => { saved++; return { id: 'img' + saved, name } } }
    : undefined),
}
const tools = buildTools({
  sourceFor: () => autoSrc,
  config: () => cfg,
  remember: () => {},
  hostCtx,
  getRefState: () => ({ given: false, analyzed: false }),
  markRefAnalyzed: () => {},
  getPhaseState: () => ({ modelingComplete: false }),
  markModelingComplete: () => {},
  resetPhase: () => {},
})
const t = tools.find((x) => x.name === 'model_loop')
const v = await t.execute({ reset: true, verdict: 'continue', next_improvement: 'X', per_mesh_max: 2, per_mesh_views: true },
  { signal: new AbortController().signal })
const blocks = t.output.render({}, v)
const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
const imgs = blocks.filter((b) => b.type === 'image')

const idx = text.indexOf('②d 分组五视图')
console.log(text.slice(idx, idx + 700))
expect('出现分组五视图段落', idx >= 0, '没找到（说明 auto 源判断又失效了）')
expect('列出了分组', /按「完整物品 \+ 配件」分成 2 组/.test(text), text.slice(idx, idx + 300))
expect('实际附了图片', imgs.length > 0, '图片数 ' + imgs.length)
console.log('  图片数: ' + imgs.length)
expect('每组 5 张（2 组 = 10 张，加场景五视图会更少/多）',
  imgs.length >= 10, String(imgs.length))

console.log('\n' + (failed === 0 ? 'GROUP_VIEWS_LIVE_OK' : 'GROUP_VIEWS_LIVE_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
