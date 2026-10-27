/**
 * 验证精度一致性与单 mesh 隔离检查。
 *   node tests/verify_precision.mjs
 */

import { makeMesh } from '../lib/core/geometry.mjs'
import { inspectEachMesh, precisionOf, isolatedMeshCheck } from '../lib/core/precision.mjs'

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

/* ── 构造几何 ── */

function cubeMesh(id, size, segments) {
  /* 细分立方体：每面 segments×segments 格 */
  const pos = []
  const idx = []
  const s = size / 2
  const faces = [
    { axis: 0, sign: 1 }, { axis: 0, sign: -1 },
    { axis: 1, sign: 1 }, { axis: 1, sign: -1 },
    { axis: 2, sign: 1 }, { axis: 2, sign: -1 },
  ]
  for (const f of faces) {
    const base = pos.length / 3
    for (let i = 0; i <= segments; i++) {
      for (let j = 0; j <= segments; j++) {
        const u = (i / segments) * 2 - 1
        const v = (j / segments) * 2 - 1
        const p = [0, 0, 0]
        p[f.axis] = f.sign * s
        p[(f.axis + 1) % 3] = u * s
        p[(f.axis + 2) % 3] = v * s
        pos.push(p[0], p[1], p[2])
      }
    }
    for (let i = 0; i < segments; i++) {
      for (let j = 0; j < segments; j++) {
        const a = base + i * (segments + 1) + j
        const b = a + 1
        const c = a + (segments + 1)
        const d = c + 1
        idx.push(a, c, b, b, c, d)
      }
    }
  }
  return makeMesh(id, id, new Float32Array(pos), new Uint32Array(idx))
}

function sphereMesh(id, radius, seg, rings) {
  const pos = []
  const idx = []
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI
    for (let s = 0; s <= seg; s++) {
      const theta = (s / seg) * Math.PI * 2
      pos.push(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.cos(phi),
        radius * Math.sin(phi) * Math.sin(theta),
      )
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < seg; s++) {
      const a = r * (seg + 1) + s
      const b = a + 1
      const c = a + (seg + 1)
      const d = c + 1
      idx.push(a, c, b, b, c, d)
    }
  }
  return makeMesh(id, id, new Float32Array(pos), new Uint32Array(idx))
}

console.log('=== 单个 mesh 精度指标 ===')
const cube8 = cubeMesh('Cube8', 2, 1)      // 6 面
const cube8x = cubeMesh('Cube8x', 2, 8)    // 384 面
console.log('  立方体 1×1 细分：' + cube8.triangles + ' 面，面积 ' + precisionOf(cube8).area)
console.log('  立方体 8×8 细分：' + cube8x.triangles + ' 面，面积 ' + precisionOf(cube8x).area)
const p1 = precisionOf(cube8)
const p2 = precisionOf(cube8x)
console.log('  粗：面密度 ' + p1.faceDensity + '，相对密度 ' + p1.faceDensityRel + '，边长比 ' + p1.edgeRatio)
console.log('  细：面密度 ' + p2.faceDensity + '，相对密度 ' + p2.faceDensityRel + '，边长比 ' + p2.edgeRatio)

expect('两者面积相同（同为 2×2×2 立方体）', Math.abs(p1.area - p2.area) < 0.01,
  p1.area + ' vs ' + p2.area)
expect('细分的面密度更高', p2.faceDensity > p1.faceDensity * 10,
  p1.faceDensity + ' vs ' + p2.faceDensity)
expect('细分的相对边长更小', p2.edgeRatio < p1.edgeRatio,
  p1.edgeRatio + ' vs ' + p2.edgeRatio)

console.log('\n=== 精度一致性：同场景混入一个过密的 ===')
/* 需要足够多的同尺寸样本，组内比较才有意义（minGroup=4）。
 * 造 6 个同尺寸的立方体 + 1 个同尺寸但过密的球。 */
const scene = [
  cubeMesh('箱体', 2, 1),
  cubeMesh('盖板', 2, 1),
  cubeMesh('支架', 2, 1),
  cubeMesh('底板', 2, 1),
  cubeMesh('侧板', 2, 1),
  cubeMesh('背板', 2, 1),
  sphereMesh('球_过密', 1.5, 64, 32), // 同尺寸但面数爆炸
]
const result = inspectEachMesh(scene)
console.log('  检查 ' + result.count + ' 个 mesh')
console.log('  中位数：相对粒度 ' + result.median.relativeEdge)
console.log('  分组：' + (result.groups || []).length + ' 个')
for (const g of (result.groups || [])) {
  console.log('    组' + g.group + ': ' + g.size + ' 个' + (g.note ? '（' + g.note + '）' : ''))
}
console.log('  离群：' + result.outliers.length + ' 个')
for (const o of result.outliers) {
  console.log('    · ' + o.part + '（' + o.issues.map((i) => i.kind).join(',') + '）')
  for (const i of o.issues) console.log('      ' + i.detail.slice(0, 90))
}
expect('检出过密的球体', result.outliers.some((o) => o.part === '球_过密'),
  JSON.stringify(result.outliers.map((o) => o.part)))
expect('离群原因是 denser-than-peers',
  result.outliers.some((o) => o.issues.some((i) => i.kind === 'denser-than-peers')),
  JSON.stringify(result.outliers))

console.log('\n=== 多块但合法：两个分离的立方体（不该报错）===')
const twoCubes = (() => {
  const a = cubeMesh('tmp', 2, 1)
  const pos = new Float32Array([...a.positions, ...a.positions.map((v, i) => (i % 3 === 0 ? v + 10 : v))])
  const idx = new Uint32Array([...a.indices, ...Array.from(a.indices, (v) => v + a.vertices)])
  return makeMesh('两体', '两体', pos, idx)
})()
const iso = isolatedMeshCheck(twoCubes)
console.log('  块数：' + iso.islands + '，平均每块 ' + iso.avgIsland + ' 面')
expect('多块本身不报错（合法拼接）', iso.issues.filter((i) => i.kind === 'fragmented').length === 0,
  JSON.stringify(iso.issues.map((i) => i.kind)))
expect('记录块数供参考', iso.islands === 2, String(iso.islands))

console.log('\n=== 碎渣：大量极小碎片（该报错）===')
const shredded = (() => {
  /* 造 100 个独立三角形，每个都是分离的 */
  const pos = []
  const idx = []
  for (let i = 0; i < 100; i++) {
    const x = i * 3
    const base = pos.length / 3
    pos.push(x, 0, 0, x + 1, 0, 0, x, 1, 0)
    idx.push(base, base + 1, base + 2)
  }
  return makeMesh('碎渣', '碎渣', new Float32Array(pos), new Uint32Array(idx))
})()
const isoShred = isolatedMeshCheck(shredded)
console.log('  块数：' + isoShred.islands + '，平均每块 ' + isoShred.avgIsland + ' 面，碎渣=' + isoShred.fragmented)
expect('检出碎渣', isoShred.issues.some((i) => i.kind === 'fragmented'),
  JSON.stringify(isoShred.issues.map((i) => i.kind)))
expect('标记 fragmented', isoShred.fragmented === true, String(isoShred.fragmented))

console.log('\n=== 隔离检查：退化面 ===')
{
  /* 少量退化面不该报（圆锥极点、针叶都合法）。
   * 造一个退化面占比超过 25% 的，才应该报。 */
  const fewDegen = (() => {
    const a = cubeMesh('tmp', 2, 4) // 384 面
    const pos = new Float32Array([...a.positions, 1, 1, 1, 1, 1, 1, 1, 1, 1])
    const base = a.vertices
    const idx = new Uint32Array([...a.indices, base, base + 1, base + 2])
    return makeMesh('少量退化', '少量退化', pos, idx)
  })()
  const isoFew = isolatedMeshCheck(fewDegen)
  console.log('  少量退化面：' + isoFew.degenerate + '/' + fewDegen.triangles
    + '（' + (isoFew.degenerate / fewDegen.triangles * 100).toFixed(1) + '%）')
  expect('少量退化面不报错', !isoFew.issues.some((i) => i.kind === 'degenerate'),
    JSON.stringify(isoFew.issues.map((i) => i.kind)))

  /* 大量退化面：一半的三角形都退化 */
  const manyDegen = (() => {
    const pos = []
    const idx = []
    /* 50 个正常三角 + 50 个退化三角 */
    for (let i = 0; i < 100; i++) {
      const base = pos.length / 3
      const x = i * 3
      if (i < 50) {
        pos.push(x, 0, 0, x + 1, 0, 0, x, 1, 0)
      } else {
        /* 三个顶点完全重合 → 零面积 */
        pos.push(x, 0, 0, x, 0, 0, x, 0, 0)
      }
      idx.push(base, base + 1, base + 2)
    }
    return makeMesh('大量退化', '大量退化', new Float32Array(pos), new Uint32Array(idx))
  })()
  const isoMany = isolatedMeshCheck(manyDegen)
  console.log('  大量退化面：' + isoMany.degenerate + '/' + manyDegen.triangles
    + '（' + (isoMany.degenerate / manyDegen.triangles * 100).toFixed(1) + '%）')
  expect('大量退化面要报错', isoMany.issues.some((i) => i.kind === 'degenerate'),
    JSON.stringify(isoMany.issues.map((i) => i.kind)))
}

console.log('\n=== 隔离检查：重复顶点 ===')
const withDup = (() => {
  const a = cubeMesh('tmp', 2, 1)
  const pos = new Float32Array([...a.positions, a.positions[0], a.positions[1], a.positions[2]])
  return makeMesh('重复', '重复', pos, a.indices)
})()
const iso3 = isolatedMeshCheck(withDup)
console.log('  重复顶点：' + iso3.duplicateVerts)
expect('检出重复顶点', iso3.duplicateVerts >= 1, String(iso3.duplicateVerts))

console.log('\n=== 一致场景不该报错 ===')
const uniform = [
  cubeMesh('A', 2, 4),
  cubeMesh('B', 2, 4),
  cubeMesh('C', 2, 4),
]
const r2 = inspectEachMesh(uniform)
expect('精度一致时没有离群', r2.outliers.length === 0,
  JSON.stringify(r2.outliers.map((o) => o.part)))
expect('没有问题 mesh', r2.problems.length === 0,
  JSON.stringify(r2.problems.map((p) => p.mesh.part)))

console.log('\n' + (failed === 0 ? 'PRECISION_OK' : 'PRECISION_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
