import assert from 'node:assert/strict'
import { makeMesh, interferencePairs, scanTrianglePairs, trianglesOverlap } from '../lib/core/geometry.mjs'

function plane(id, segments) {
  const positions = []
  const indices = []
  for (let x = 0; x <= segments; x++) {
    for (let y = 0; y <= segments; y++) {
      positions.push(x / segments, y / segments, 0)
    }
  }
  const row = segments + 1
  for (let x = 0; x < segments; x++) {
    for (let y = 0; y < segments; y++) {
      const a = x * row + y
      const b = a + 1
      const c = a + row
      const d = c + 1
      indices.push(a, b, c, b, d, c)
    }
  }
  return makeMesh(id, id, new Float32Array(positions), new Uint32Array(indices))
}

const dense = [plane('dense-a', 72), plane('dense-b', 72)]
const complete = interferencePairs(dense, {
  ignoreGround: false,
  minDepth: 1,
  minRatio: 1,
})
assert.equal(complete.hits.length, 0, 'coplanar meshes do not produce a penetration hit')
assert.ok(complete.triangleCandidateCount > 4000, 'fixture exceeds the former candidate storage cap')
assert.equal(complete.trianglePairsCapped, 0, 'sample storage limit does not truncate the scan')
assert.equal(complete.complete, true, 'full traversal completes without reducing geometry')

const capped = interferencePairs(dense, {
  ignoreGround: false, minDepth: 1, minRatio: 1, maxTriangleWorkPerPair: 64,
})
assert.equal(capped.hits.length, 0, 'coplanar meshes do not produce a penetration hit')
assert.equal(capped.trianglePairsCapped, 1, 'an actual computation limit is reported')
assert.equal(capped.complete, false, 'a capped traversal is never reported as complete')
assert.equal(capped.incompletePairs[0].aId, 'dense-a', 'incomplete pairs identify actual objects')
assert.equal(capped.incompletePairs[0].reason, 'pair_work_limit')
assert.ok(capped.triangleWork <= 64, 'budget covers node visits, broad and narrow tests')

const sceneCap = interferencePairs(dense, { ignoreGround: false, maxTriangleWork: 0 })
assert.equal(sceneCap.complete, false)
assert.equal(sceneCap.incompletePairs[0].reason, 'scene_work_limit')
assert.equal(sceneCap.triangleWork, 0)

function repeatedTriangle(id, count, vertices = [0, 0, 0, 2, 0, 0, 0, 2, 0]) {
  return makeMesh(id, id, new Float64Array(vertices),
    new Uint32Array(Array.from({ length: count * 3 }, (_, i) => i % 3)))
}
const samples = scanTrianglePairs(repeatedTriangle('A', 64), repeatedTriangle('B', 64))
assert.equal(samples.pairs.length, 4000, 'stored samples remain bounded')
assert.equal(samples.candidateCount, 4096, 'candidate counting continues after sample storage fills')
assert.equal(samples.complete, true)
const exactBoundary = scanTrianglePairs(repeatedTriangle('A', 1), repeatedTriangle('B', 4000))
assert.equal(exactBoundary.candidateCount, 4000)
assert.equal(exactBoundary.complete, true, 'exactly 4000 candidates is complete when traversal exhausted')
const exactWork = scanTrianglePairs(repeatedTriangle('A', 1), repeatedTriangle('B', 1), { maxWork: 2 })
assert.equal(exactWork.complete, true, 'using exactly the budget is complete if no work remains')
assert.equal(scanTrianglePairs(repeatedTriangle('A', 1), repeatedTriangle('B', 1), { maxWork: 1 }).complete, false)
assert.equal(scanTrianglePairs(repeatedTriangle('A', 1), repeatedTriangle('B', 1), {
  maxWork: 3, exact: true,
}).complete, true, 'the final narrow-phase test can consume the exact remaining budget')
assert.equal(scanTrianglePairs(repeatedTriangle('A', 1), repeatedTriangle('B', 1), {
  maxWork: 2, exact: true,
}).complete, false, 'an untested narrow-phase candidate keeps coverage incomplete')

// 共面分离、真实交叉、接触和不同尺度，防止把宽阶段候选误当真实相交。
const tri = (points) => repeatedTriangle('triangle', 1, points.flat())
const cases = [
  [[[0, 0, 0], [2, 0, 0], [0, 2, 0]], [[2, 2, 0], [1, 2, 0], [2, 1, 0]], false],
  [[[0, 0, 0], [2, 0, 0], [0, 2, 0]], [[0.5, 0.5, -1], [0.5, 0.5, 1], [1, 0.5, 0]], true],
  [[[0, 0, 0], [2, 0, 0], [0, 2, 0]], [[2, 0, 0], [3, 0, 0], [2, 1, 0]], true],
  [[[0, 0, 0], [2, 0, 1], [0, 2, 1]], [[2, 2, 0], [1, 2, 1], [2, 1, 1]], false],
]
for (const [a, b, expected] of cases) {
  for (const scale of [1e-6, 1, 1e3]) {
    const transform = (p) => p.map((v) => v * scale + 10)
    const A = tri(a.map(transform)), B = tri(b.map(transform))
    assert.equal(trianglesOverlap(A, 0, B, 0), expected)
    assert.equal(trianglesOverlap(B, 0, A, 0), expected, 'narrow phase is symmetric')
  }
}

// 两个封闭四面体的包围盒大面积重叠，实际位于对角的两侧。
function tetra(id, upper) {
  const p = upper ? [2, 2, 2, 0.8, 2, 2, 2, 0.8, 2, 2, 2, 0.8]
    : [0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2]
  const faces = upper ? [0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2]
    : [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]
  return makeMesh(id, id, new Float64Array(p), new Uint32Array(Array.from({ length: 32 }, () => faces).flat()))
}
const emptyOverlap = interferencePairs([tetra('roof-like-a', false), tetra('roof-like-b', true)], { ignoreGround: false })
assert.ok(emptyOverlap.triangleCandidateCount >= 4000)
assert.equal(emptyOverlap.triangleOverlapCount, 0)
assert.equal(emptyOverlap.hits.length, 0, 'AABB overlap alone is never a penetration hit')
assert.equal(emptyOverlap.complete, true)

// 无表面相交的真实包含仍要检出；重复面不能重复计算射线穿越次数。
for (const scale of [1e-3, 1, 1e3]) {
  const transform = (mesh, shrink = 1, inset = 0) => makeMesh(mesh.id, mesh.part,
    Float64Array.from(mesh.positions, (v) => (v * shrink + inset) * scale + 10), mesh.indices)
  const outer = transform(tetra('outer', false))
  const inner = transform(tetra('inner', false), 0.125, 0.25)
  for (const meshes of [[outer, inner], [inner, outer]]) {
    const contained = interferencePairs(meshes, { ignoreGround: false, minDepth: 1e-8, minRatio: 1e-5 })
    assert.equal(contained.complete, true)
    assert.equal(contained.triangleOverlapCount, 0, 'nested tetrahedra have disjoint surfaces')
    assert.equal(contained.hits.length, 1, 'actual containment remains detectable at different scales and orderings')
    assert.equal(contained.hits[0].containment, true)
    assert.equal(contained.hits[0].state, 'contained')
    assert.ok(contained.hits[0].insideSamples > 0)
    assert.ok(contained.hits[0].depth > 0)
  }
}

const skipped = interferencePairs([plane('small-a', 1), plane('small-b', 1)], {
  ignoreGround: false,
  maxCandidates: 0,
})
assert.equal(skipped.skipped, 1, 'candidate-pair budget is reported')
assert.equal(skipped.complete, false, 'a skipped mesh pair is never reported as complete')

console.log('Interference completeness checks passed')
