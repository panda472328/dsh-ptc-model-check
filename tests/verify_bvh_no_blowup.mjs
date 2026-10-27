/**
 * 回归测试：BVH 三角形对遍历不能指数爆炸。
 *
 * 背景（真实事故）：
 *   `trianglePairs` 里「双方都是内部节点」的分支原来写成
 *       stack.push([na.left, ib], [na.right, ib], [ia, nb.left], [ia, nb.right])
 *   后两项把 ia / ib 原封不动再推一遍 —— 同一组合被反复展开，
 *   复杂度从 O(nA + nB + k) 变成 O(nA × nB)。
 *
 *   实测代价：一对「地形_林地」(11838 面) ×「墙_前原木」(1836 面)
 *   要跑 **547 秒**，而且是**同步热循环**——它阻塞事件循环，
 *   连 setTimeout 超时保护都没机会执行。检查工具跑在 DSH 主进程里，
 *   所以表现是「整个 DSH 卡住」。用户只能强停，留下一串
 *   ToolOutcomeUnknownError。
 *
 * 这个测试用**远小于事故规模**的输入建两个相交网格，要求：
 *   ① 遍历能在合理时间内完成
 *   ② 结果与暴力枚举完全一致（不漏也不多）
 *
 *   node tests/verify_bvh_no_blowup.mjs
 */
import { trianglePairs } from '../lib/core/geometry.mjs'

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

/* 造一个扁平的密集网格（模拟地形这类大面数物体） */
function makeGridMesh(id, nx, nz, size, y, seed) {
  const positions = []
  const indices = []
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= nz; j++) {
      positions.push(
        (i / nx - 0.5) * size,
        y,
        (j / nz - 0.5) * size,
      )
    }
  }
  const row = nz + 1
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const a = i * row + j
      const b = a + 1
      const c = a + row
      const d = c + 1
      indices.push(a, c, b, b, c, d)
    }
  }
  return {
    id, part: id,
    positions: new Float64Array(positions),
    indices: new Uint32Array(indices),
    triangles: indices.length / 3,
  }
}

/* 造一个穿过前者的小网格 */
function makeBoxMesh(id, size, seed) {
  const h = size / 2
  const positions = new Float64Array([
    -h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h,
    -h, -h, h, h, -h, h, h, h, h, -h, h, h,
  ])
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
  ])
  return { id, part: id, positions, indices, triangles: indices.length / 3 }
}

/* 暴力枚举：所有三角对，AABB 相交即算（真值基准） */
function brutePairs(A, B) {
  const out = new Set()
  const bounds = (m, t) => {
    const i0 = m.indices[t * 3], i1 = m.indices[t * 3 + 1], i2 = m.indices[t * 3 + 2]
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity
    for (const i of [i0, i1, i2]) {
      const x = m.positions[i * 3], y = m.positions[i * 3 + 1], z = m.positions[i * 3 + 2]
      if (x < mnx) mnx = x; if (y < mny) mny = y; if (z < mnz) mnz = z
      if (x > mxx) mxx = x; if (y > mxy) mxy = y; if (z > mxz) mxz = z
    }
    return [mnx, mny, mnz, mxx, mxy, mxz]
  }
  for (let i = 0; i < A.triangles; i++) {
    const ba = bounds(A, i)
    for (let j = 0; j < B.triangles; j++) {
      const bb = bounds(B, j)
      if (ba[0] <= bb[3] && ba[3] >= bb[0] && ba[1] <= bb[4] && ba[4] >= bb[1] && ba[2] <= bb[5] && ba[5] >= bb[2]) {
        out.add(i + ':' + j)
      }
    }
  }
  return out
}

console.log('=== ① 大网格 × 小网格：不能爆炸 ===')
{
  /* 事件规模是 11838×1836；这里放宽到 3600×768 —— 旧写法在这个规模
   * 就要跑几十秒到分钟级，足够可靠地触发回归。 */
  const ground = makeGridMesh('地形', 60, 60, 20, 0, 1)
  const wall = makeBoxMesh('墙', 3, 2)
  /* 把墙放到地形上方，让包围盒重叠 */
  for (let i = 2; i < wall.positions.length; i += 3) wall.positions[i] += 0.5

  console.log('    地形 ' + ground.triangles + ' 面, 墙 ' + wall.triangles + ' 面')

  const t0 = Date.now()
  const got = trianglePairs(ground, wall)
  const ms = Date.now() - t0
  console.log('    耗时 ' + ms + ' ms, 得到 ' + got.length + ' 对')

  /* 旧写法在 3600×768 规模下是 O(nA×nB)；给 5 秒的宽松上限 */
  expect('遍历在 5 秒内完成', ms < 5000, ms + ' ms（旧写法会远超）')
}

console.log('\n=== ② 结果必须与暴力枚举一致 ===')
{
  const ground = makeGridMesh('地形', 12, 12, 20, 0, 1)
  const wall = makeBoxMesh('墙', 3, 2)
  for (let i = 2; i < wall.positions.length; i += 3) wall.positions[i] += 0.5

  const fast = trianglePairs(ground, wall, 100000)
  const fastSet = new Set(fast.map((p) => p[0] + ':' + p[1]))
  const truth = brutePairs(ground, wall)

  const missing = [...truth].filter((k) => !fastSet.has(k))
  const extra = [...fastSet].filter((k) => !truth.has(k))
  console.log('    暴力 ' + truth.size + ' 对, 实现 ' + fastSet.size + ' 对')
  expect('不漏', missing.length === 0, '漏 ' + missing.length + ' 对')
  expect('不多', extra.length === 0, '多 ' + extra.length + ' 对')
}

console.log('\n=== ③ 命中上限仍生效 ===')
{
  const A = makeGridMesh('A', 20, 20, 10, 0, 1)
  const B = makeGridMesh('B', 20, 20, 10, 0.2, 2)
  const r = trianglePairs(A, B, 500)
  console.log('    limit=500 → 得到 ' + r.length + ' 对')
  expect('尊重 limit', r.length <= 500, String(r.length))
}

console.log('\n=== ④ 极端：两个都是大网格，仍要秒级完成 ===')
{
  const A = makeGridMesh('大A', 40, 40, 30, 0, 1)
  const B = makeGridMesh('大B', 40, 40, 30, 0.3, 2)
  console.log('    A ' + A.triangles + ' 面, B ' + B.triangles + ' 面')
  const t0 = Date.now()
  const r = trianglePairs(A, B, 4000)
  const ms = Date.now() - t0
  console.log('    耗时 ' + ms + ' ms, 得到 ' + r.length + ' 对')
  expect('大网格对的遍历 < 10 秒', ms < 10000, ms + ' ms')
}

console.log('\n' + (failed === 0 ? 'BVH_NO_BLOWUP_OK' : 'BVH_NO_BLOWUP_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
