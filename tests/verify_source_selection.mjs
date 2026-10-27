import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { buildTools } from '../lib/tools.mjs'
import { SceneSource } from '../lib/adapters/index.mjs'

let selection = null
const sources = []
const sourceFor = (overrides = {}) => {
  const opts = { ...(selection || {}), ...overrides }
  sources.push(opts)
  return {
    describe: () => opts.source + (opts.url ? ':' + opts.url : ''),
    async info() { return { meshes: 1 } },
    async namingScan() {
      return { totalMeshes: 1, named: 1, generic: 0, duplicates: [], items: [] }
    },
  }
}

const tools = buildTools({
  sourceFor,
  setSourceSelection(value) { selection = value },
  config: () => ({ maxObjects: 100, maxTriangles: 1000, minDepth: 0.0005, minRatio: 0.005 }),
  hostCtx: { get() { return undefined } },
})
const sourceTool = tools.find((tool) => tool.name === 'model_source')
const namingTool = tools.find((tool) => tool.name === 'model_naming')

assert.equal(sourceTool.isConcurrencySafe(), false, 'source switching is serialized with scene operations')
await sourceTool.execute({ action: 'use', source: 'web', url: 'ws://127.0.0.1:9393' }, {})
assert.equal(selection.source, 'web')
assert.equal(selection.url, 'ws://127.0.0.1:9393')

await namingTool.execute({ action: 'scan' }, {})
assert.equal(sources.at(-1).source, 'web', 'later tools inherit the selected source')
assert.equal(sources.at(-1).url, 'ws://127.0.0.1:9393', 'later tools inherit the selected endpoint')

console.log('Source selection checks passed')

let detectCalls = 0
const autoSource = new SceneSource({ source: 'auto' }, {
  probeLive: async () => ({ ok: false, detail: 'offline' }),
  detectBlender: () => { detectCalls += 1; return 'C:/Blender/blender.exe' },
})
await assert.rejects(autoSource.resolve(), (error) => error.code === 'NO_SOURCE')
assert.equal(detectCalls, 0, 'auto mode never opens an empty Blender scene without an explicit .blend')
console.log('Auto-source fallback checks passed')

/* ── 磁盘 .blend 读取模式已下线 ──
 *
 * 背景（真实缺陷）：该模式通过 `blender -b --python runtime/blender_bridge.py` 通信，
 * 而那个桥接脚本从未随包发布（当前包与全部历史备份里都没有）。
 * 结果是：一旦有人用 source:'blender'，就会 spawn 一个参数指向不存在文件的
 * Blender 进程，一直卡到 180s 超时——对分发出去的包是最糟的失败形态。
 *
 * 现在它必须**立刻失败并说清原因**，且 auto 模式不许再把它当读取源。 */
console.log('\n=== 磁盘 .blend 模式已下线 ===')

const blendSource = new SceneSource({ source: 'blender', blend: 'D:/x/a.blend' }, {
  probeLive: async () => ({ ok: false, detail: 'offline' }),
})
await assert.rejects(blendSource.resolve(), (error) => {
  assert.equal(error.code, 'BLEND_MODE_REMOVED', '必须是明确的下线错误码，不能是超时或 BLENDER_NOT_FOUND')
  assert.match(error.message, /已下线/)
  assert.match(error.message, /\.obj|live/, '必须告诉用户替代路径')
  return true
})
console.log('  ✓ source:blender 立即报错，并指出替代方案')

/* 只设了 blend、没有 live/web/obj 时，必须报「没有可用的建模源」，
 * 而不是去打开那个 .blend——这正是「不再作为读取源」的判据。 */
const onlyBlend = new SceneSource({ source: 'auto', blend: 'D:/x/a.blend' }, {
  probeLive: async () => ({ ok: false, detail: 'offline' }),
})
await assert.rejects(onlyBlend.resolve(), (error) => {
  assert.equal(error.code, 'NO_SOURCE', 'blend 不再是可用的读取源')
  assert.doesNotMatch(error.message, /\.blend、/, '报错不该再把 .blend 列为可读来源')
  return true
})
console.log('  ✓ auto + 仅 blend → NO_SOURCE（不再打开它）')

/* 死代码必须真的删掉，否则后人会以为它可用 */
const adapterDir = new URL('../lib/adapters/', import.meta.url)
assert.equal(existsSync(new URL('blender.mjs', adapterDir)), false,
  'lib/adapters/blender.mjs 应已删除（它只服务于已下线的模式）')
console.log('  ✓ blender.mjs 已删除')

/* 工具 schema 不能再宣传这个模式 */
const toolsSrc = readFileSync(new URL('../lib/tools.mjs', import.meta.url), 'utf8')
assert.doesNotMatch(toolsSrc, /blender（读磁盘/, 'source 参数描述不该再宣传磁盘 .blend')
assert.doesNotMatch(toolsSrc, /enum: \['live', 'blender'/, 'source 枚举必须去掉 blender')
assert.match(toolsSrc, /enum: \['live', 'web', 'file'\]/, 'source 枚举应为 live / web / file')

/* README 不能再把桥接脚本列为「包内已有文件」。
 * 注意：下线说明里点它的名字是必要的（要说清为什么下线），
 * 所以只禁止文件树那种「runtime/    blender_bridge.py」的罗列形式。 */
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
assert.doesNotMatch(readme, /runtime\/\s+blender_bridge\.py/, 'README 不该再把桥接脚本列为包内文件')
assert.doesNotMatch(readme, /blender\.mjs/, 'README 不该再列已删除的适配器')
assert.match(readme, /已下线/, 'README 必须写明该模式已下线及原因')
console.log('  ✓ 工具 schema 与 README 已同步')
console.log('\nBLEND_MODE_REMOVED_OK')
