/** 平面密度差异不能逼迫加面；非 Blender 源不能被要求创建 Collection。 */
import assert from 'node:assert/strict'
import { buildTools } from '../lib/tools.mjs'
import { makeMesh } from '../lib/core/geometry.mjs'
import { fileURLToPath } from 'node:url'

function panel(id, offset, segments, collections) {
  const positions = []
  const indices = []
  for (let x = 0; x <= segments; x++) {
    for (let y = 0; y <= segments; y++) positions.push(offset + x / segments, y / segments, 0)
  }
  const row = segments + 1
  for (let x = 0; x < segments; x++) {
    for (let y = 0; y < segments; y++) {
      const a = x * row + y
      indices.push(a, a + row, a + 1, a + 1, a + row, a + row + 1)
    }
  }
  return makeMesh(id, id, new Float64Array(positions), new Uint32Array(indices), { collections })
}

async function check(kind, collections) {
  const meshes = [1, 1, 1, 20].map((segments, i) => panel('展示板_' + i, i * 3, segments, collections))
  const source = {
    describe: () => kind,
    resolve: async () => kind,
    extract: async () => ({ meshes, skipped: [] }),
  }
  const tools = buildTools({
    sourceFor: () => source,
    config: () => ({ maxObjects: 100, maxTriangles: 10000 }),
    hostCtx: { get: () => undefined },
  })
  return tools.find((tool) => tool.name === 'model_loop').execute({
    quick_check: true, verdict: 'continue', next_improvement: '核对展示效果',
    acknowledge_isolated: meshes.map((mesh) => ({ part: mesh.part, reason: '四块独立展板按设计留有展示间距' })),
  }, {})
}

const blender = await check('blender', ['展板组'])
assert.ok(blender.perMesh.precision.outliers.length > 0, 'the fixture actually triggers density advice')
assert.equal(blender.pass, true, blender.lines.join('\n'))
assert.match(blender.lines.join('\n'), /仅作建议|仅供参考|不.*硬门槛/)
for (const kind of ['obj', 'web']) {
  const result = await check(kind)
  assert.equal(result.pass, true, result.lines.join('\n'))
  assert.equal(result.groupingState.ok, true)
  assert.match(result.lines.join('\n'), /不要求在该源创建 Collection/)
  assert.doesNotMatch(result.stopBlockers.join('\n'), /没有用 Blender Collection/)
}
const imagePath = fileURLToPath(new URL('./subject_fixture.png', import.meta.url))
const source = {
  describe: () => 'offline-reference', resolve: async () => 'blender',
  extract: async () => ({ meshes: [panel('板件', 0, 1, ['物品'])], skipped: [] }),
  renderShots: async (shots) => ({ shots: shots.map((shot) => ({ ...shot, path: imagePath })) }),
}
const loop = buildTools({ sourceFor: () => source, config: () => ({}), hostCtx: { get: () => undefined } })
  .find((tool) => tool.name === 'model_loop')
const silhouette = await loop.execute({ verdict: 'done', stop_reason: '轮廓像素差异按任务视角记录',
  reference_image: fileURLToPath(new URL('./shape_fixture.png', import.meta.url)),
}, {})
assert.equal(silhouette.silhouette.ok, true)
assert.equal(silhouette.silhouette.pass, false, 'the reference must actually miss the silhouette threshold')
assert.equal(silhouette.pass, true, 'a reference-only pixel threshold cannot block a clean technical inspection')
assert.equal(silhouette.stopped, true)
console.log('SOURCE_QUALITY_OK')
