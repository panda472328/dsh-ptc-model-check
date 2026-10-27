/**
 * 引擎无关的三角网格几何核心：BVH、穿模深度、孤立距离。
 * 输入统一是「世界坐标下的三角网格」，所以 Blender / 网页 three.js / 磁盘上的 OBJ·GLB 走同一套判定。
 */

export const EPS = 1e-9

export function makeMesh(id, part, positions, indices, meta = {}) {
  const nv = Math.floor(positions.length / 3)
  const nt = Math.floor(indices.length / 3)
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < nv; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2]
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (z < minZ) minZ = z
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    if (z > maxZ) maxZ = z
  }
  if (nv === 0) {
    minX = minY = minZ = maxX = maxY = maxZ = 0
  }
  const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ
  return {
    id, part, positions, indices,
    vertices: nv, triangles: nt,
    bbox: [minX, minY, minZ, maxX, maxY, maxZ],
    dims: [dx, dy, dz],
    diag: Math.hypot(dx, dy, dz),
    meta,
    _bvh: null,
  }
}

/* ───────────────────────────── BVH ───────────────────────────── */

const LEAF = 8

function triBounds(positions, indices, tri) {
  const i0 = indices[tri * 3], i1 = indices[tri * 3 + 1], i2 = indices[tri * 3 + 2]
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (const i of [i0, i1, i2]) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2]
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z
  }
  return [minX, minY, minZ, maxX, maxY, maxZ]
}

function buildBVH(mesh) {
  const { positions, indices, triangles } = mesh
  if (triangles === 0) return null
  const centroids = new Float64Array(triangles * 3)
  const bounds = new Float64Array(triangles * 6)
  for (let t = 0; t < triangles; t++) {
    const b = triBounds(positions, indices, t)
    for (let k = 0; k < 6; k++) bounds[t * 6 + k] = b[k]
    centroids[t * 3] = (b[0] + b[3]) / 2
    centroids[t * 3 + 1] = (b[1] + b[4]) / 2
    centroids[t * 3 + 2] = (b[2] + b[5]) / 2
  }
  const order = new Uint32Array(triangles)
  for (let i = 0; i < triangles; i++) order[i] = i
  const nodes = []

  const build = (start, count) => {
    let minX = Infinity, minY = Infinity, minZ = Infinity
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (let i = start; i < start + count; i++) {
      const t = order[i]
      const b = t * 6
      if (bounds[b] < minX) minX = bounds[b]
      if (bounds[b + 1] < minY) minY = bounds[b + 1]
      if (bounds[b + 2] < minZ) minZ = bounds[b + 2]
      if (bounds[b + 3] > maxX) maxX = bounds[b + 3]
      if (bounds[b + 4] > maxY) maxY = bounds[b + 4]
      if (bounds[b + 5] > maxZ) maxZ = bounds[b + 5]
    }
    const index = nodes.length
    nodes.push({ min: [minX, minY, minZ], max: [maxX, maxY, maxZ], start, count, left: -1, right: -1 })
    if (count <= LEAF) return index
    const ex = maxX - minX, ey = maxY - minY, ez = maxZ - minZ
    const axis = ex >= ey && ex >= ez ? 0 : (ey >= ez ? 1 : 2)
    const slice = Array.from(order.subarray(start, start + count))
    slice.sort((a, b) => centroids[a * 3 + axis] - centroids[b * 3 + axis])
    order.set(slice, start)
    const half = count >> 1
    const l = build(start, half)
    const r = build(start + half, count - half)
    nodes[index].left = l
    nodes[index].right = r
    return index
  }
  build(0, triangles)
  return { nodes, order, bounds, mesh }
}

function bvhOf(mesh) {
  if (!mesh._bvh) mesh._bvh = buildBVH(mesh)
  return mesh._bvh
}

export function aabbOverlap(a, b) {
  return a[0] <= b[3] && a[3] >= b[0] && a[1] <= b[4] && a[4] >= b[1] && a[2] <= b[5] && a[5] >= b[2]
}

/** 仅限制保存的三角对样本数，不代表检查覆盖上限。 */
export const TRIANGLE_PAIR_LIMIT = 4000
export const TRIANGLE_WORK_LIMIT = 1000000
export const SCENE_TRIANGLE_WORK_LIMIT = 5000000

function workBudget(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

/** 三角形 SAT 窄阶段：排除仅 AABB 重叠、表面实际分离的候选。 */
export function trianglesOverlap(meshA, ta, meshB, tb) {
  const point = (m, t, k) => {
    const i = m.indices[t * 3 + k] * 3
    return [m.positions[i], m.positions[i + 1], m.positions[i + 2]]
  }
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  // 局部坐标避免大世界坐标的投影相减误差。
  const origin = point(meshA, ta, 0)
  const A = [origin, point(meshA, ta, 1), point(meshA, ta, 2)].map((p) => sub(p, origin))
  const B = [0, 1, 2].map((k) => sub(point(meshB, tb, k), origin))
  const edges = (p) => [sub(p[1], p[0]), sub(p[2], p[1]), sub(p[0], p[2])]
  const ea = edges(A), eb = edges(B)
  const na = cross(ea[0], ea[1]), nb = cross(eb[0], eb[1])
  // 退化面交给网格诊断，不能把零面积面当成可靠接触证据。
  if (Math.hypot(...na) === 0 || Math.hypot(...nb) === 0) return false
  const scale = Math.max(...ea.map((e) => Math.hypot(...e)), ...eb.map((e) => Math.hypot(...e)))
  const separated = (axis) => {
    const length = Math.hypot(...axis)
    if (length === 0) return false
    const a = A.map((p) => dot(p, axis)), b = B.map((p) => dot(p, axis))
    const tolerance = Math.max(scale * 1e-10, Number.EPSILON * scale * 32) * length
    return Math.max(...a) < Math.min(...b) - tolerance || Math.max(...b) < Math.min(...a) - tolerance
  }
  if (separated(na) || separated(nb)) return false
  for (const a of ea) for (const b of eb) if (separated(cross(a, b))) return false
  // 共面三角形还需要平面内分离轴；只有边叉积会漏掉这一种情况。
  for (const e of ea) if (separated(cross(na, e))) return false
  for (const e of eb) if (separated(cross(nb, e))) return false
  return true
}

const sub3 = (a, b) => a.map((v, k) => v - b[k])
const dot3 = (a, b) => a.reduce((s, v, k) => s + v * b[k], 0)
const cross3 = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
const trianglePoints = (m, t) => [0, 1, 2].map(k => {
  const i = m.indices[t * 3 + k] * 3
  return Array.from(m.positions.subarray(i, i + 3))
})

function edgeNeighbors(mesh, triangle, edge) {
  if (!mesh._triangleEdges) {
    const keyOf = i => Array.from(mesh.positions.subarray(i*3, i*3+3)).join(',')
    const keys = Array.from({length:mesh.vertices}, (_, i) => keyOf(i))
    const table = new Map()
    for (let t=0; t<mesh.triangles; t++) for (let k=0; k<3; k++) {
      const key = [keys[mesh.indices[t*3+k]], keys[mesh.indices[t*3+(k+1)%3]]].sort().join('|')
      if (!table.has(key)) table.set(key, [])
      table.get(key).push(t)
    }
    mesh._triangleEdges = { keys, table }
  }
  const {keys,table} = mesh._triangleEdges
  const key = edge.map(k => keys[mesh.indices[triangle*3+k]]).sort().join('|')
  return table.get(key) || []
}

/** 严格横穿双方三角面平面；共面或仅沿边贴合不算横穿。 */
function trianglesCross(meshA, ta, meshB, tb) {
  const A = trianglePoints(meshA, ta), B = trianglePoints(meshB, tb)
  const straddles = (points, plane, mesh, triangle) => {
    const n = cross3(sub3(plane[1], plane[0]), sub3(plane[2], plane[0]))
    const len = Math.hypot(...n)
    if (!len) return false
    const ds = points.map(p => dot3(sub3(p, plane[0]), n) / len)
    const eps = Math.max(meshA.diag, meshB.diag) * 1e-10
    let negative = Math.min(...ds) < -eps, positive = Math.max(...ds) > eps
    if (negative && positive) return true
    const onPlane = ds.map((d,k) => Math.abs(d) <= eps ? k : -1).filter(k => k >= 0)
    // 交线恰好落在网格内部三角边上时，检查相邻面的另一侧，避免结果依赖三角剖分方向。
    if (onPlane.length !== 2 || (!negative && !positive)) return false
    for (const next of edgeNeighbors(mesh, triangle, onPlane)) {
      if (next === triangle) continue
      for (const p of trianglePoints(mesh, next)) {
        const d = dot3(sub3(p, plane[0]), n) / len
        negative ||= d < -eps; positive ||= d > eps
      }
      if (negative && positive) return true
    }
    return false
  }
  return straddles(A, B, meshA, ta) && straddles(B, A, meshB, tb)
}

/** 线段最近距离包含边内部，避免只有顶点采样时漏掉带面/斜杆接触。 */
function segmentDistanceSq(p, q, r, s) {
  const u = sub3(q, p), v = sub3(s, r), w = sub3(p, r)
  const a = dot3(u, u), b = dot3(u, v), c = dot3(v, v), d = dot3(u, w), e = dot3(v, w)
  const clamp = x => Math.max(0, Math.min(1, x))
  let t = 0, h = 0
  if (!a && !c) return dot3(w, w)
  if (!a) h = clamp(e / c)
  else if (!c) t = clamp(-d / a)
  else {
    const den = a*c-b*b
    t = den > a*c*1e-14 ? clamp((b*e-c*d)/den) : 0
    h = (b*t+e)/c
    if (h < 0) { h = 0; t = clamp(-d/a) }
    else if (h > 1) { h = 1; t = clamp((b-d)/a) }
  }
  const delta = w.map((x, k) => x + t*u[k] - h*v[k])
  return dot3(delta, delta)
}

function triangleDistanceSq(ma, ta, mb, tb) {
  const A = trianglePoints(ma, ta), B = trianglePoints(mb, tb)
  let best = Infinity
  for (const p of A) best = Math.min(best, closestOnTriangle(mb.positions, mb.indices, tb, ...p).dist)
  for (const p of B) best = Math.min(best, closestOnTriangle(ma.positions, ma.indices, ta, ...p).dist)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    best = Math.min(best, segmentDistanceSq(A[i], A[(i+1)%3], B[j], B[(j+1)%3]))
  }
  return best
}

/** 流式遍历全部候选，样本存满后继续检查；独立工作预算保护宿主主线程。 */
export function scanTrianglePairs(meshA, meshB, opts = {}) {
  const A = bvhOf(meshA), B = bvhOf(meshB)
  const pairs = []
  let candidateCount = 0, overlapCount = 0, crossingCount = 0, work = 0, nodeVisits = 0, leafTests = 0, narrowTests = 0
  const gap = Math.max(0, Number(opts.contactGap) || 0)
  let witness = null
  const sampleLimit = workBudget(opts.sampleLimit, TRIANGLE_PAIR_LIMIT)
  const maxWork = workBudget(opts.maxWork, TRIANGLE_WORK_LIMIT)
  const finish = (reason = null) => ({ pairs, candidateCount, overlapCount, crossingCount, witness, work,
    nodeVisits, leafTests, narrowTests, complete: reason === null, reason })
  if (!A || !B) return finish()
  const stack = [[0, 0]]
  while (stack.length) {
    if (work >= maxWork) return finish('work_limit')
    work++; nodeVisits++
    const [ia, ib] = stack.pop()
    const na = A.nodes[ia], nb = B.nodes[ib]
    if (!(na.min[0] <= nb.max[0]+gap && na.max[0]+gap >= nb.min[0] &&
          na.min[1] <= nb.max[1]+gap && na.max[1]+gap >= nb.min[1] &&
          na.min[2] <= nb.max[2]+gap && na.max[2]+gap >= nb.min[2])) continue
    const leafA = na.left < 0, leafB = nb.left < 0
    if (leafA && leafB) {
      for (let i = na.start; i < na.start + na.count; i++) {
        const ta = A.order[i]
        const ai = ta * 6, ba = A.bounds
        for (let j = nb.start; j < nb.start + nb.count; j++) {
          if (work >= maxWork) return finish('work_limit')
          work++; leafTests++
          const tb = B.order[j]
          const bi = tb * 6, bb = B.bounds
          if (ba[ai] <= bb[bi + 3]+gap && ba[ai + 3]+gap >= bb[bi] && ba[ai + 1] <= bb[bi + 4]+gap
            && ba[ai + 4]+gap >= bb[bi + 1] && ba[ai + 2] <= bb[bi + 5]+gap && ba[ai + 5]+gap >= bb[bi + 2]) {
            candidateCount++
            if (opts.exact) {
              if (work >= maxWork) return finish('work_limit')
              work++; narrowTests++
              const overlaps = trianglesOverlap(meshA, ta, meshB, tb)
              const distance = overlaps ? 0 : gap > 0 ? Math.sqrt(triangleDistanceSq(meshA, ta, meshB, tb)) : Infinity
              if (!Number.isFinite(distance) || distance > gap) continue
              const crossing = overlaps && opts.classifyCrossings && trianglesCross(meshA, ta, meshB, tb)
              if (crossing) crossingCount++
              if (!witness || crossing) witness = { triangleA: ta, triangleB: tb, distance,
                aCenter: triCentroid(meshA.positions, meshA.indices, ta),
                bCenter: triCentroid(meshB.positions, meshB.indices, tb) }
            }
            overlapCount++
            if (pairs.length < sampleLimit) pairs.push([ta, tb])
            if (opts.stopAtSampleLimit && pairs.length >= sampleLimit) return finish('sample_limit')
          }
        }
      }
    } else if (leafA) {
      stack.push([ia, nb.left], [ia, nb.right])
    } else if (leafB) {
      stack.push([na.left, ib], [na.right, ib])
    } else {
      /* 双方都是内部节点：必须推入**四个真组合**，让两侧同时下降。
       *
       * 踩过的坑（真实事故，会让整个 DSH 卡住）：
       * 这里原来写的是
       *     stack.push([na.left, ib], [na.right, ib], [ia, nb.left], [ia, nb.right])
       * 后两项把 ia / ib **原封不动**再推一遍 —— A 的子树已经分解过了，
       * 却又和 B 的另一侧重新配对，于是同一组合被反复展开，组合数从
       * O(nA + nB + k) 变成 O(nA × nB)。
       *
       * 实测：一对「地形_林地」(11838 面) × 「墙_前原木」(1836 面)，
       * 用旧写法要跑 **547 秒**（而且是同步热循环，会卡住整个事件循环，
       * 连 setTimeout 都没机会执行，所以超时保护也失效）；
       * 改成四个真组合后同样的输入 **0 ms**，迭代次数 977。
       *
       * 正确性已用暴力枚举比对验证：4 组不同规模的随机网格，
       * 结果集合与原实现完全一致（不漏也不多）。 */
      stack.push([na.left, nb.left], [na.left, nb.right],
        [na.right, nb.left], [na.right, nb.right])
    }
  }
  return finish()
}

/** 兼容旧数组 API：只取限量的 AABB 候选样本；覆盖判定使用 scanTrianglePairs。 */
export function trianglePairs(meshA, meshB, limit = TRIANGLE_PAIR_LIMIT) {
  if (limit <= 0) return []
  return scanTrianglePairs(meshA, meshB, { sampleLimit: limit, stopAtSampleLimit: true }).pairs
}

/** 最近点查询：返回 {dist, point, normal, tri} 或 null；dist 是**真实距离**。 */
export function nearestPoint(mesh, px, py, pz) {
  const B = bvhOf(mesh)
  if (!B) return null
  let best = Infinity, bestTri = -1, bx = 0, by = 0, bz = 0
  const stack = [0]
  const pos = mesh.positions, idx = mesh.indices
  while (stack.length) {
    const ni = stack.pop()
    const n = B.nodes[ni]
    if (distToNode(n, px, py, pz) > best) continue
    if (n.left < 0) {
      for (let i = n.start; i < n.start + n.count; i++) {
        const t = B.order[i]
        const r = closestOnTriangle(pos, idx, t, px, py, pz)
        if (r.dist < best) { best = r.dist; bestTri = t; bx = r.x; by = r.y; bz = r.z }
      }
      continue
    }
    const dl = distToNode(B.nodes[n.left], px, py, pz)
    const dr = distToNode(B.nodes[n.right], px, py, pz)
    if (dl < dr) { stack.push(n.right); stack.push(n.left) } else { stack.push(n.left); stack.push(n.right) }
  }
  if (bestTri < 0) return null
  const nrm = triNormal(pos, idx, bestTri)
  return { dist: Math.sqrt(best), point: [bx, by, bz], normal: nrm, tri: bestTri }
}

function distToNode(n, px, py, pz) {
  const dx = Math.max(n.min[0] - px, 0, px - n.max[0])
  const dy = Math.max(n.min[1] - py, 0, py - n.max[1])
  const dz = Math.max(n.min[2] - pz, 0, pz - n.max[2])
  return dx * dx + dy * dy + dz * dz
}

export function triNormal(pos, idx, t) {
  const i0 = idx[t * 3] * 3, i1 = idx[t * 3 + 1] * 3, i2 = idx[t * 3 + 2] * 3
  const ax = pos[i1] - pos[i0], ay = pos[i1 + 1] - pos[i0 + 1], az = pos[i1 + 2] - pos[i0 + 2]
  const bx = pos[i2] - pos[i0], by = pos[i2 + 1] - pos[i0 + 1], bz = pos[i2 + 2] - pos[i0 + 2]
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx
  const len = Math.hypot(nx, ny, nz) || 1
  return [nx / len, ny / len, nz / len]
}

export function triCentroid(pos, idx, t) {
  const i0 = idx[t * 3] * 3, i1 = idx[t * 3 + 1] * 3, i2 = idx[t * 3 + 2] * 3
  return [
    (pos[i0] + pos[i1] + pos[i2]) / 3,
    (pos[i0 + 1] + pos[i1 + 1] + pos[i2 + 1]) / 3,
    (pos[i0 + 2] + pos[i1 + 2] + pos[i2 + 2]) / 3,
  ]
}

/** 点到三角形的最近点（Ericson, Real-Time Collision Detection）。 */
export function closestOnTriangle(pos, idx, t, px, py, pz) {
  const i0 = idx[t * 3] * 3, i1 = idx[t * 3 + 1] * 3, i2 = idx[t * 3 + 2] * 3
  const ax = pos[i0], ay = pos[i0 + 1], az = pos[i0 + 2]
  const bx = pos[i1], by = pos[i1 + 1], bz = pos[i1 + 2]
  const cx = pos[i2], cy = pos[i2 + 1], cz = pos[i2 + 2]
  const abx = bx - ax, aby = by - ay, abz = bz - az
  const acx = cx - ax, acy = cy - ay, acz = cz - az
  const apx = px - ax, apy = py - ay, apz = pz - az
  const d1 = abx * apx + aby * apy + abz * apz
  const d2 = acx * apx + acy * apy + acz * apz
  let qx, qy, qz
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az }
  else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz
    const d3 = abx * bpx + aby * bpy + abz * bpz
    const d4 = acx * bpx + acy * bpy + acz * bpz
    if (d3 >= 0 && d4 <= d3) { qx = bx; qy = by; qz = bz }
    else {
      const vc = d1 * d4 - d3 * d2
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3)
        qx = ax + abx * v; qy = ay + aby * v; qz = az + abz * v
      } else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz
        const d5 = abx * cpx + aby * cpy + abz * cpz
        const d6 = acx * cpx + acy * cpy + acz * cpz
        if (d6 >= 0 && d5 <= d6) { qx = cx; qy = cy; qz = cz }
        else {
          const vb = d5 * d2 - d1 * d6
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6)
            qx = ax + acx * w; qy = ay + acy * w; qz = az + acz * w
          } else {
            const va = d3 * d6 - d5 * d4
            if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
              const w = (d4 - d3) / ((d4 - d3) + (d5 - d6))
              qx = bx + (cx - bx) * w; qy = by + (cy - by) * w; qz = bz + (cz - bz) * w
            } else {
              const denom = 1 / (va + vb + vc)
              const v = vb * denom, w = vc * denom
              qx = ax + abx * v + acx * w
              qy = ay + aby * v + acy * w
              qz = az + abz * v + acz * w
            }
          }
        }
      }
    }
  }
  const dx = px - qx, dy = py - qy, dz = pz - qz
  return { dist: dx * dx + dy * dy + dz * dz, x: qx, y: qy, z: qz }
}

/* ─────────────────────────── 判定 ─────────────────────────── */

/**
 * 两个包围盒的重叠厚度（三轴**最小**重叠）。
 *
 * 为什么取最小：这一维代表「它们互相嵌入的实际深度上限」。
 * 两个薄板平行叠在一起时，重叠区在长宽方向很大、厚度方向很小，
 * 实际穿透深度就是那个小值——取最大会算出荒谬的数。
 *
 * 任一方向不重叠说明根本没相交，返回 0。
 */
export function bboxOverlapMin(a, b) {
  const dx = Math.min(a[3], b[3]) - Math.max(a[0], b[0])
  const dy = Math.min(a[4], b[4]) - Math.max(a[1], b[1])
  const dz = Math.min(a[5], b[5]) - Math.max(a[2], b[2])
  if (dx <= 0 || dy <= 0 || dz <= 0) return 0
  return Math.min(dx, dy, dz)
}

/**
 * 两个包围盒的重叠厚度（三轴**最大**重叠）。
 * 只用于「判断是否相交」，不作为深度。
 */
function bboxOverlapExtent(a, b) {
  return bboxOverlapMin(a, b) > 0 ? Math.max(
    Math.min(a[3], b[3]) - Math.max(a[0], b[0]),
    Math.min(a[4], b[4]) - Math.max(a[1], b[1]),
    Math.min(a[5], b[5]) - Math.max(a[2], b[2]),
  ) : 0
}

/**
 * 分类两个物体的穿模**状态**。
 *
 * 穿模不是一种东西，不同状态的严重程度完全不同：
 *
 * | 状态 | 含义 | 例子 | 该不该修 |
 * |---|---|---|---|
 * | `poke-through` 穿出 | 一方从另一方的**另一侧露出来** | 桌腿从桌面上表面钻出来 | **必须修**——肉眼能直接看到突破口 |
 * | `contained` 完全嵌入 | 一方整个在另一方内部 | 小方块完全埋在薄板里 | 看设计：暗埋的螺母可以，明显不合理的要修 |
 * | `inserted` 插入 | 部分重叠但没露出来 | 桌腿插进桌面 3mm（藏在里面） | 通常正常，插接比对接牢固 |
 * | `mutual` 互相穿过 | 两边都超出对方的范围 | 两根杆斜着交叉穿过 | 必须修，除非本来就是要交叉的结构 |
 * | `coincident` 重合 | 两件几乎完全重叠 | 同一个部件建了两遍 | 必须修，重复建模 |
 *
 * 判断方法：找三轴里**重叠最小**的那一轴作为穿透方向，
 * 然后看双方在该轴上的跨度关系。
 *
 * @returns {{state:string, axis:number, axisName:string, detail:string}}
 */
export function classifyInterference(ma, mb) {
  const ov = [
    Math.min(ma.bbox[3], mb.bbox[3]) - Math.max(ma.bbox[0], mb.bbox[0]),
    Math.min(ma.bbox[4], mb.bbox[4]) - Math.max(ma.bbox[1], mb.bbox[1]),
    Math.min(ma.bbox[5], mb.bbox[5]) - Math.max(ma.bbox[2], mb.bbox[2]),
  ]
  const axisName = ['X', 'Y', 'Z']
  if (ov[0] <= 0 || ov[1] <= 0 || ov[2] <= 0) {
    return { state: 'none', axis: -1, axisName: '', detail: '包围盒不相交' }
  }
  /* 穿透方向 = 重叠最小的轴（最容易被穿透的那一维） */
  let axis = 0
  if (ov[1] < ov[axis]) axis = 1
  if (ov[2] < ov[axis]) axis = 2

  const eps = 1e-5

  /* ── 重合判定（放在最前）──
   * **三轴都几乎完全重叠，且双方尺寸量级相近**。
   *
   * 只看「重叠占较小尺寸的比例」不够——薄板与细杆在 X/Y 方向的重叠占比
   * 天然就大（板比杆宽得多），会把「杆穿过板」误判成「重合」。
   * 所以要求双方三轴尺寸都接近（比值 > 0.8），才算同一个部件建了两遍。 */
  const coincidentSizeA = [ma.dims[0], ma.dims[1], ma.dims[2]]
  const coincidentSizeB = [mb.dims[0], mb.dims[1], mb.dims[2]]
  let coincidentAxes = 0
  let sizeSimilarAxes = 0
  for (let k = 0; k < 3; k++) {
    const smaller = Math.max(EPS, Math.min(coincidentSizeA[k], coincidentSizeB[k]))
    const larger = Math.max(EPS, Math.max(coincidentSizeA[k], coincidentSizeB[k]))
    if (ov[k] / smaller > 0.9) coincidentAxes++
    if (smaller / larger > 0.8) sizeSimilarAxes++
  }
  if (coincidentAxes === 3 && sizeSimilarAxes === 3) {
    return {
      state: 'coincident', axis, axisName: axisName[axis],
      detail: '三个方向都几乎完全重叠且尺寸相近，疑似同一个部件建了两遍',
    }
  }

  /* ── 先判包含关系，再判穿出 ──
   *
   * 顺序很重要：一个物体整个在另一个内部时，
   * 「它在对方范围内」和「它超出对方」是互斥的，
   * 但如果先按「重叠最小的轴」去判穿出，会得出错误结论。
   * 所以先看包含。 */
  const aInsideAll = [0, 1, 2].every((k) =>
    ma.bbox[k] >= mb.bbox[k] - eps && ma.bbox[k + 3] <= mb.bbox[k + 3] + eps)
  const bInsideAll = [0, 1, 2].every((k) =>
    mb.bbox[k] >= ma.bbox[k] - eps && mb.bbox[k + 3] <= ma.bbox[k + 3] + eps)

  if (aInsideAll && !bInsideAll) {
    return {
      state: 'contained', axis, axisName: axisName[axis],
      detail: 'A 完全嵌在 B 内部（暗埋，是否合理看设计）',
      by: 'A',
    }
  }
  if (bInsideAll && !aInsideAll) {
    return {
      state: 'contained', axis, axisName: axisName[axis],
      detail: 'B 完全嵌在 A 内部（暗埋，是否合理看设计）',
      by: 'B',
    }
  }

  /* ── 穿出判定 ──
   *
   * 语义是「**贯穿**」：物体沿某个方向穿过对方，从**另一侧**露出来。
   * 判定要求两个条件同时成立：
   *
   *   ① 该物体在穿透轴上**双向超出**对方（两端都在对方范围外）
   *   ② 该物体在**另外两轴**的横截面**落在对方范围内**
   *      —— 这一条才是「穿过去」的物理含义：它得从对方body里穿出去，
   *         而不是从旁边绕过去。
   *
   * 为什么必须加 ②（**实测过的误判**）：
   *   「钢筋从断墙里伸出来」——杆沿 Z 插进高墙，杆底埋在墙里、杆顶露在墙外。
   *   三轴重叠里最小的是**杆的直径**（X/Y），于是旧代码选 X 为「穿透轴」，
   *   然后在 X 上发现「杆的双侧超出墙」……但那个轴上是**墙包着杆**，
   *   根本不是穿出。结果整类「支柱/钢筋/管道从结构里伸出」的正常模型，
   *   全被判成必须修的严重错误，pass 恒为 false。
   *
   * 加上 ② 之后：
   *   钢筋沿 X 轴虽然在墙范围内（截面被包住）——等等，这里 X 是「杆超出墙」吗?
   *   不是：墙宽 3、杆径 0.06，杆的 X 范围完全在墙内。旧代码错在**选错了轴**。
   *   正确做法是**逐轴试**：对每个轴检查「这一轴上是否真是贯穿」。
   *
   * 所以改成：遍历三个轴，对每个轴用 ①+② 判断，任一轴成立才算穿出。
   */
  const crossInside = (obj, other, ax) => {
    /* obj 在「除 ax 之外的另外两轴」上的范围是否落在 other 范围内 */
    for (let k = 0; k < 3; k++) {
      if (k === ax) continue
      if (obj.bbox[k] < other.bbox[k] - eps) return false
      if (obj.bbox[k + 3] > other.bbox[k + 3] + eps) return false
    }
    return true
  }

  /** 在某一轴上是否构成「贯穿对方」。 */
  const throughOn = (obj, other, ax) => {
    const oMin = obj.bbox[ax], oMax = obj.bbox[ax + 3]
    const tMin = other.bbox[ax], tMax = other.bbox[ax + 3]
    /* ① 双向超出 */
    if (!(oMin < tMin - eps && oMax > tMax + eps)) return false
    /* ② 横截面被对方包住（而不是从旁边绕过去） */
    return crossInside(obj, other, ax)
  }

  /* 逐轴找「谁贯穿了谁」。注意一个物体可能只在某一轴上贯穿。 */
  const aThruAxis = [0, 1, 2].find((k) => throughOn(ma, mb, k))
  const bThruAxis = [0, 1, 2].find((k) => throughOn(mb, ma, k))

  if (aThruAxis !== undefined && bThruAxis !== undefined && aThruAxis === bThruAxis) {
    /* 同一轴上双方互相超出 → 真互穿（两根杆对穿） */
    return {
      state: 'mutual', axis: aThruAxis, axisName: axisName[aThruAxis],
      detail: '双方沿 ' + axisName[aThruAxis] + ' 轴互相穿过对方',
    }
  }
  if (aThruAxis !== undefined) {
    return {
      state: 'poke-through', axis: aThruAxis, axisName: axisName[aThruAxis],
      detail: 'A 沿 ' + axisName[aThruAxis] + ' 轴贯穿 B，从另一侧伸出（突破口可见）',
      by: 'A',
    }
  }
  if (bThruAxis !== undefined) {
    return {
      state: 'poke-through', axis: bThruAxis, axisName: axisName[bThruAxis],
      detail: 'B 沿 ' + axisName[bThruAxis] + ' 轴贯穿 A，从另一侧伸出（突破口可见）',
      by: 'B',
    }
  }

  /* 没构成贯穿 → 是「插入」。
   *
   * 注意这个分支现在覆盖了「钢筋从墙里伸出来」：杆在 Z 上确实超出墙
   * （杆顶在墙外），但 Z 方向的横截面没被墙包住（杆是细的，
   * 它在 X/Y 上完全在墙内——等等，这是「杆在 Z 上超出、但 Z 不是穿透方向」）。
   * 关键点：杆**没有沿任何轴贯穿**墙，它只是**插进去一部分**，
   * 另一端露在外面。这正是「插入」的语义。
   *
   * 保留一个提示：如果一方在某个轴上单向超出（露头但不贯穿），
   * 记下来供上层判断。 */
  const aPeeks = [0, 1, 2].some((k) =>
    ma.bbox[k] < mb.bbox[k] - eps || ma.bbox[k + 3] > mb.bbox[k + 3] + eps)
  const bPeeks = [0, 1, 2].some((k) =>
    mb.bbox[k] < ma.bbox[k] - eps || mb.bbox[k + 3] > ma.bbox[k + 3] + eps)

  return {
    state: 'inserted', axis, axisName: axisName[axis],
    detail: '部分插入，没有贯穿对方'
      + (aPeeks || bPeeks ? '（有一端露在外面，属于正常的伸出结构）' : '（插接结构，通常正常）'),
  }
}

/** 这些状态属于「必须修」——肉眼可见的结构错误。 */
export const SEVERE_STATES = new Set(['poke-through', 'mutual', 'coincident'])

/**
 * 删除记录：把「被删掉的物体」记下来，供之后判断「该不该加回来」。
 *
 * 为什么需要它（真实事故）：
 *   模型遇到穿模时，最省事的做法是**把碍事的物体删掉**——
 *   树扎进地面就删树，栅栏插进土里就删栅栏。
 *   删完穿模当然清零了，但场景也空了。更糟的是：
 *   它删完之后**没有回头确认那些东西是不是本来就该在那儿**。
 *
 *   这个模块不阻止删除（有时确实该删），但要求：
 *     ① 删之前记下它的位置、尺寸、材质、所属组
 *     ② 之后必须**显式交代**：这个删掉的是「确实多余」还是「误删要加回」
 *     ③ 如果要加回，用记录里的位置精确复原，而不是凭印象随便放
 *
 * 为什么不直接禁止删除：
 *   建模过程中删辅助对象、删做错的部件是完全正常的。
 *   一刀切禁止会逼模型用别的方式绕过（比如把物体缩到极小藏起来），
 *   那比删除更难发现。
 */

/** 一条删除记录里保留的字段——够用来复原，也不至于太大。 */
export function snapshotMesh(mesh, extra = {}) {
  if (!mesh) return null
  const b = mesh.bbox || [0, 0, 0, 0, 0, 0]
  return {
    id: mesh.id,
    part: mesh.part || mesh.id,
    /* 世界坐标包围盒：复原时用它定位 */
    bbox: b.slice(),
    /* 中心点与尺寸：最常用的两个量 */
    center: [
      Number(((b[0] + b[3]) / 2).toFixed(6)),
      Number(((b[1] + b[4]) / 2).toFixed(6)),
      Number(((b[2] + b[5]) / 2).toFixed(6)),
    ],
    dims: [
      Number((b[3] - b[0]).toFixed(6)),
      Number((b[4] - b[1]).toFixed(6)),
      Number((b[5] - b[2]).toFixed(6)),
    ],
    triangles: mesh.triangles || 0,
    vertices: mesh.vertices || 0,
    materials: Array.isArray(mesh.meta && mesh.meta.materials) ? mesh.meta.materials.slice() : [],
    collection: (mesh.meta && mesh.meta.collection) || null,
    at: Date.now(),
    ...extra,
  }
}

/**
 * 判断一个删除记录「该不该加回来」。
 *
 * 判据（按优先级）：
 *   ① 它是否在某个物品组里，且那个组现在还缺件？
 *      —— 组里少了东西通常是误删
 *   ② 它的体量是否显著（大到肉眼可见）？
 *      —— 删掉一个 3 米高的树是大事，删掉一个 2cm 的螺丝是小事
 *   ③ 它是否和现存的物体「本该相连」？
 *      —— 比如桌腿被删了，桌面还在，那桌腿该加回
 *   ④ 它是否挡住了别的物体？
 *      —— 如果它是被删来解决穿模的，要确认穿模现在真的消失了
 *
 * @param {object} rec 删除记录
 * @param {Array} survivingMeshes 当前还活着的 mesh
 * @param {object} ctx { sceneDiag, groupNames }
 * @returns {{ verdict: 'restore'|'review'|'keep-deleted', reasons: string[], where: object|null }}
 */
/**
 * 把「删除快照」归一化成内部统一的结构。
 *
 * 为什么需要这个函数（真实 bug）：
 *   快照是 **Blender addon** 造的（Python 那边），字段名和 JS 这边不一致：
 *
 *     addon 实际返回            内部想用的
 *     ──────────────────────    ──────────────
 *     name                      part
 *     dimensions: [x,y,z]       dims
 *     bbox: [minx..maxz]        bbox        （碰巧一致）
 *     center: [x,y,z]           center      （碰巧一致）
 *     collections: ['组名']      collection  （复数 vs 单数）
 *
 *   原来 judgeDeleted / restorePlan 直接读 rec.dims、rec.collection，
 *   一调用就抛 TypeError（读 undefined[0]）。
 *   而这个路径只在「真有删除记录」时才走到，所以一直没被发现——
 *   直到补了 model_deleted 的端到端测试才暴露。
 *
 * @param {object} rec 原始记录（可能是 addon 结构，也可能是内部结构）
 * @returns {{name:string, dims:number[]|null, bbox:number[]|null, center:number[]|null, collection:string|null, raw:object}}
 */
export function normalizeDeletedRecord(rec) {
  const r = rec || {}
  const s = r.snapshot || {}
  const dims = r.dims || r.dimensions || s.dimensions || s.dims || null
  const bbox = r.bbox || s.bbox || null
  /* center 可能没存，从 bbox 推 */
  let center = r.center || s.center || null
  if (!center && bbox) center = [(bbox[0] + bbox[3]) / 2, (bbox[1] + bbox[4]) / 2, (bbox[2] + bbox[5]) / 2]
  /* 尺寸也没有就从 bbox 推 */
  let d = dims
  if (!d && bbox) d = [bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2]]
  const cols = r.collections || r.collection || s.collections || (s.collection ? [s.collection] : null)
  const collection = Array.isArray(cols) ? (cols[0] || null) : (cols || null)
  const name = r.part || r.name || s.name || s.part || '(未命名)'
  return { name, dims: d, bbox, center, collection, raw: r }
}

export function judgeDeleted(rec, survivingMeshes, ctx = {}) {
  const reasons = []
  const list = survivingMeshes || []
  const sceneDiag = ctx.sceneDiag || 0
  const groupNames = new Set(ctx.groupNames || [])

  if (!rec) return { verdict: 'keep-deleted', reasons: ['记录不完整，无法判断'], where: null }

  /* 字段归一化：兼容 addon 的快照结构（name/dimensions/collections） */
  const norm = normalizeDeletedRecord(rec)
  const dims = norm.dims
  const bbox = norm.bbox
  const collection = norm.collection
  const partName = norm.name

  if (!dims && !bbox) {
    return { verdict: 'keep-deleted', reasons: ['记录里没有尺寸和包围盒，无法判断'], where: null }
  }

  const diag = dims
    ? Math.hypot(dims[0] || 0, dims[1] || 0, dims[2] || 0)
    : Math.hypot((bbox[3] - bbox[0]) || 0, (bbox[4] - bbox[1]) || 0, (bbox[5] - bbox[2]) || 0)
  const relativeSize = sceneDiag > 0 ? diag / sceneDiag : 0

  /* ① 组里缺件 */
  const inKnownGroup = collection && groupNames.has(collection)
  if (inKnownGroup) {
    const remain = list.filter((m) => {
      const cs = (m.meta && (m.meta.collections || m.meta.collection)) || null
      if (Array.isArray(cs)) return cs.includes(collection)
      return cs === collection
    }).length
    if (remain === 0) {
      reasons.push('它所属的组「' + collection + '」现在一个件都不剩了——整组被删空，几乎一定是误删')
      return { verdict: 'restore', reasons, where: restorePlan(rec, list) }
    }
    reasons.push('它属于组「' + collection + '」，该组还剩 ' + remain + ' 件')
  }

  /* ② 体量 */
  if (relativeSize > 0.12) {
    reasons.push('体量较大（对角线 ' + diag.toFixed(2) + '，占场景 '
      + (relativeSize * 100).toFixed(1) + '%）——删掉会明显缺东西')
  } else if (relativeSize < 0.01) {
    reasons.push('体量很小（对角线 ' + diag.toFixed(3) + '），删掉通常无关紧要')
  } else {
    reasons.push('体量中等（对角线 ' + diag.toFixed(2) + '，占场景 '
      + (relativeSize * 100).toFixed(1) + '%）')
  }

  /* ③ 和现存物体「本该相连」：有没有物体的表面正好贴着它原来的位置 */
  let neighbours = 0
  let nearest = null
  let nearestGap = Infinity
  for (const m of list) {
    const b = m.bbox
    if (!b || !bbox) continue
    /* 到删除框的距离（各轴分离量） */
    const gapX = Math.max(b[0] - bbox[3], bbox[0] - b[3], 0)
    const gapY = Math.max(b[1] - bbox[4], bbox[1] - b[4], 0)
    const gapZ = Math.max(b[2] - bbox[5], bbox[2] - b[5], 0)
    const gap = Math.hypot(gapX, gapY, gapZ)
    if (gap < nearestGap) { nearestGap = gap; nearest = m }
    const nearTol = Math.max(diag * 0.15, sceneDiag * 0.01, 1e-4)
    if (gap <= nearTol) neighbours++
  }
  if (neighbours > 0) {
    reasons.push('它原来的位置旁边还有 ' + neighbours + ' 个物体贴着（最近的是「'
      + (nearest.part || nearest.id) + '」，距离 ' + nearestGap.toFixed(3) + '）'
      + '——像是从一组结构里缺了一块')
  }

  /* ④ 综合判定
   *
   * 优先级（从强到弱）：
   *   整组删空          → restore（在第 ① 步已返回）
   *   同组 + 有邻接      → restore。这两个信号同时成立，基本可以确定
   *                      它是某个结构的一部分。**不要因为「体量中等」
   *                      就降级成 review** —— 一棵 8 米高的树在 80 米
   *                      场景里只占 10%，按体量算永远到不了「大件」阈值，
   *                      但它显然是该有的。
   *   只有体量大        → review（可能是独立背景件）
   *   只有邻接          → review（可能是有功能的零件）
   *   都没有            → keep-deleted */
  const big = relativeSize > 0.12
  const structural = neighbours > 0 && inKnownGroup

  if (structural) {
    reasons.push('**建议加回**：它属于组「' + collection + '」，'
      + '而且原来的位置旁边还挨着 ' + neighbours + ' 个现存物体'
      + '（最近「' + (nearest ? (nearest.part || nearest.id) : '?') + '」）'
      + '——这是从一组结构里缺了一块，不是多余的零件')
    return { verdict: 'restore', reasons, where: restorePlan(rec, list) }
  }
  if (big && neighbours > 0) {
    reasons.push('**建议加回**：体量大、且原本和现在还有的东西相连')
    return { verdict: 'restore', reasons, where: restorePlan(rec, list) }
  }
  if (big) {
    reasons.push('体量大但周围没东西挨着——可能是本来就独立的背景件，删了也行；'
      + '但要说清「它为什么不该在」')
    return { verdict: 'review', reasons, where: restorePlan(rec, list) }
  }
  if (neighbours > 0) {
    reasons.push('周围有邻接但不在已知组里——如果它是有功能的零件（螺丝、栏杆、台阶），应该加回')
    return { verdict: 'review', reasons, where: restorePlan(rec, list) }
  }
  reasons.push('体量小、周围也没东西依赖它，删掉可以接受')
  return { verdict: 'keep-deleted', reasons, where: null }
}

/**
 * 复原方案：算出「放回哪里、怎么放」。
 *
 * 不是简单「放回原处」——原处可能已经被别的东西占了，或者整个场景的
 * 尺度变过。所以给三种候选，让人/模型挑：
 *   · exact —— 原位置（最理想）
 *   · offset —— 原位置附近稍微挪开（如果原处被占）
 *   · anchored —— 贴着最近的现存物体（保证不悬空）
 */
export function restorePlan(rec, survivingMeshes) {
  if (!rec) return null
  const list = survivingMeshes || []
  /* 用归一化后的字段：兼容 addon 快照结构（name/dimensions/collections）。
   * 没有 center / dims 时从 bbox 推出来，所以这里不会是 undefined。 */
  const norm = normalizeDeletedRecord(rec)
  const rBbox = norm.bbox
  const rDims = norm.dims
  const rCenter = norm.center
  if (!rBbox || !rCenter || !rDims) {
    return { exact: null, offset: null, anchored: null, bbox: null, dims: null,
      note: '记录里缺少位置信息，无法给出复原方案' }
  }
  const [cx, cy, cz] = rCenter
  const plan = {
    exact: { location: [cx, cy, cz], note: '原位置，直接用' },
    offset: null,
    anchored: null,
    bbox: rBbox.slice(),
    dims: rDims.slice(),
  }

  /* 原处有没有被占？ */
  let occupied = null
  for (const m of list) {
    const b = m.bbox
    if (!b) continue
    const ox = Math.min(b[3], rBbox[3]) - Math.max(b[0], rBbox[0])
    const oy = Math.min(b[4], rBbox[4]) - Math.max(b[1], rBbox[1])
    const oz = Math.min(b[5], rBbox[5]) - Math.max(b[2], rBbox[2])
    if (ox > 0 && oy > 0 && oz > 0) { occupied = m; break }
  }
  if (occupied) {
    /* 沿「重叠最小」的那个轴让开，挪的距离 = 需要的最小分离量 + 一点余量 */
    const b = occupied.bbox
    const ovX = Math.min(b[3], rBbox[3]) - Math.max(b[0], rBbox[0])
    const ovY = Math.min(b[4], rBbox[4]) - Math.max(b[1], rBbox[1])
    const ovZ = Math.min(b[5], rBbox[5]) - Math.max(b[2], rBbox[2])
    const axis = ovX <= ovY && ovX <= ovZ ? 0 : (ovY <= ovZ ? 1 : 2)
    const push = (axis === 0 ? ovX : axis === 1 ? ovY : ovZ) + Math.max(rDims[axis] * 0.05, 1e-3)
    const loc = [cx, cy, cz]
    loc[axis] += push
    plan.offset = {
      location: loc.map((v) => Number(v.toFixed(4))),
      note: '原处被「' + (occupied.part || occupied.id) + '」占了，沿 ' + 'XYZ'[axis] + ' 轴让开 ' + push.toFixed(3),
      blockedBy: occupied.part || occupied.id,
    }
  }

  /* 贴着最近的现存物体：保证不悬空 */
  let nearest = null
  let best = Infinity
  for (const m of list) {
    const b = m.bbox
    if (!b) continue
    const gx = Math.max(b[0] - rBbox[3], rBbox[0] - b[3], 0)
    const gy = Math.max(b[1] - rBbox[4], rBbox[1] - b[4], 0)
    const gz = Math.max(b[2] - rBbox[5], rBbox[2] - b[5], 0)
    const g = Math.hypot(gx, gy, gz)
    if (g < best) { best = g; nearest = m }
  }
  if (nearest) {
    plan.anchored = {
      location: [cx, cy, cz],
      note: '最近的是「' + (nearest.part || nearest.id) + '」，距离 ' + best.toFixed(3)
        + '——放回去时对准让它和那个物体贴合',
      nearest: nearest.part || nearest.id,
      nearestGap: Number(best.toFixed(4)),
    }
  }
  return plan
}

/**
 * 识别「承托面」：地面、地形、地板、桌面这类大平板。
 *
 * 为什么需要它（真实事故）：
 *   一个森林小屋场景报了 **287 对穿模**，但其中绝大多数是
 *   「树干扎进地面」「栅栏立柱插进土里」——物理上必然如此。
 *   旧判定把这算成严重错误，于是这类场景**永远不可能通过门禁**。
 *   模型为了往下走只能绕门禁（在脚本里直接调渲染和存盘），
 *   或者干脆把树删掉/合并掉。
 *
 *   这不是模型偷懒，是判定本身不成立。地面不是「被穿模的物体」，
 *   它是**承托面**：东西扎进去是正常的。
 *
 * 判据（三个条件同时满足，缺一不可）：
 *   ① 极扁：厚度 / 水平尺寸 < 0.1。地面、地板、桌面都是这个形状。
 *   ② 够宽：水平方向覆盖场景的一半以上（任一轴）。
 *   ③ 承托关系：场景里 30% 以上的物体，其底部落在它的顶面附近或更低。
 *      这一条是关键——它把「地面上方的薄板」和「真正托着东西的地面」
 *      区分开。比如天花板的扁平比也小，但没什么东西「坐在它上面」。
 *
 * 反例（不会被误判）：
 *   · 钢筋（扁平比 0.038 够扁）→ 但只覆盖 1%，承托率 9% → 不是地面
 *   · 墙面（覆盖 8%）→ 不是地面
 *   · 天花板（承托率低）→ 不是地面
 *
 * @param {Array} meshes 场景里所有 mesh
 * @returns {{ground: Set<string>, details: Array}} ground 是 mesh.id 的集合
 */
export function detectGroundSurfaces(meshes) {
  const list = (meshes || []).filter((m) => m && m.bbox && m.bbox.length === 6)
  const out = { ground: new Set(), details: [] }
  /* 场景太小就别识别承托面了。
   *
   * 为什么：一个「桌面 + 两条腿」的测试场景里，桌面就是 100% 宽、
   * 高度也小，按尺寸判据会被认成地面——但它是家具，不是地面。
   * 真正的场景（有地面的）至少也有十几个物体。
   * 少于 8 个物体时一律不识别，宁可漏豁免也不误豁免。 */
  if (list.length < 8) return out

  /* 场景包围盒 */
  const minX = Math.min(...list.map((m) => m.bbox[0]))
  const minY = Math.min(...list.map((m) => m.bbox[1]))
  const minZ = Math.min(...list.map((m) => m.bbox[2]))
  const maxX = Math.max(...list.map((m) => m.bbox[3]))
  const maxY = Math.max(...list.map((m) => m.bbox[4]))
  const maxZ = Math.max(...list.map((m) => m.bbox[5]))
  const sceneW = Math.max(maxX - minX, 1e-9)
  const sceneD = Math.max(maxY - minY, 1e-9)
  const sceneH = Math.max(maxZ - minZ, 1e-9)

  for (const m of list) {
    const [x0, y0, z0, x1, y1, z1] = m.bbox
    const w = x1 - x0
    const d = y1 - y0
    const h = z1 - z0
    const horiz = Math.max(w, d, 1e-9)
    const flatness = h / horiz
    const covX = w / sceneW
    const covY = d / sceneD
    const top = z1

    /* ① 极扁 */
    const flat = flatness < 0.1
    /* ② 够宽：相对 + 绝对两道门槛。
     *
     * 只靠相对覆盖不够——小场景里一张桌面就是 100% 宽。
     * 所以要再加绝对门槛：水平尺寸至少是**场景高度的 3 倍**。
     * 真正的承托面（地面、地板、大平台）总是远远宽于场景高度；
     * 桌面、书架隔板这类明显是同一量级。
     *
     * 为什么是 3 倍而不是 2 倍：一张 2×1.2 的桌面放在 1 米高的腿上面，
     * 水平 2 : 高度 1 = 2 倍，正好卡在 2 倍门槛上就会被误判。
     * 3 倍能把这类「家具尺度」的板全部排除。 */
    const wideRel = covX > 0.5 || covY > 0.5
    const wideAbs = horiz >= sceneH * 3
    const wide = wideRel && wideAbs
    if (!flat || !wide) continue

    /* ③ 承托关系：多少物体的底部落在它顶面附近或更低，且水平有重叠。
     *
     * 还要**托着足够多的东西**：真正的承托面托着一堆物体，
     * 桌面只托着 4 条腿。要求至少 4 个（场景物体太少时按总数放宽）。
     * 这一条是最后的保险——即使尺寸判据被绕过，
     * 「只托着一条腿的板」也不会被当成地面。 */
    let supports = 0
    let others = 0
    const tol = Math.max(sceneH * 0.35, 0.5)
    for (const o of list) {
      if (o === m) continue
      others++
      const ob = o.bbox
      const ox = Math.min(x1, ob[3]) - Math.max(x0, ob[0])
      const oy = Math.min(y1, ob[4]) - Math.max(y0, ob[1])
      if (ox <= 0 || oy <= 0) continue
      if (Math.abs(ob[2] - top) < tol || ob[2] < top) supports++
    }
    const supportRatio = others > 0 ? supports / others : 0
    /* 托着的数量：至少 4 个；场景太小（<8 个物体）时要求 ≥ 60% */
    const minSupports = others >= 8 ? 4 : Math.ceil(others * 0.6)
    if (supportRatio <= 0.3) continue
    if (supports < minSupports) continue

    out.ground.add(m.id)
    out.details.push({
      id: m.id,
      part: m.part || m.id,
      flatness: Number(flatness.toFixed(3)),
      coverage: [Number((covX * 100).toFixed(0)), Number((covY * 100).toFixed(0))],
      supports,
      others,
    })
  }
  return out
}

/** 状态的中文标签，用于输出文案。 */
export const STATE_LABELS = {
  'poke-through': '穿出',
  contained: '完全嵌入',
  inserted: '插入',
  mutual: '互相穿过',
  coincident: '重合',
  none: '不相交',
}

function sampleTriangles(mesh, tris, cap) {
  const n = tris.length
  if (n === 0) return []
  const step = Math.max(1, Math.ceil(n / cap))
  const out = []
  for (let i = 0; i < n && out.length < cap; i += step) out.push(triCentroid(mesh.positions, mesh.indices, tris[i]))
  return out
}

/**
 * 采样落在某个包围盒内的三角形质心。
 *
 * 用途：算穿透深度时，只关心对方包围盒范围内的那些面——
 * 那才是可能插进去的部分。范围外的面采样了也算不出深度，
 * 白白浪费性能。
 *
 * @param {object} mesh
 * @param {number[]} box [minX,minY,minZ,maxX,maxY,maxZ]
 * @param {number} cap 采样上限
 */
function sampleTrianglesInBox(mesh, box, cap) {
  const { positions, indices, triangles } = mesh
  const out = []
  const step = Math.max(1, Math.ceil(triangles / Math.max(1, cap * 4)))
  for (let t = 0; t < triangles && out.length < cap; t += step) {
    const c = triCentroid(positions, indices, t)
    if (c[0] < box[0] || c[0] > box[3]) continue
    if (c[1] < box[1] || c[1] > box[4]) continue
    if (c[2] < box[2] || c[2] > box[5]) continue
    out.push(c)
  }
  return out
}

/** 封闭实体的射线奇偶判定；包含关系不能只依赖最近单面的法线。 */
function isClosedMesh(mesh) {
  if (mesh._closed !== undefined) return mesh._closed
  const edges = new Map(), faces = new Set()
  const keys = Array.from({ length: mesh.vertices }, (_, i) => Array.from(mesh.positions.subarray(i*3, i*3+3)).join(','))
  for (let t = 0; t < mesh.triangles; t++) {
    const v = [0, 1, 2].map(k => keys[mesh.indices[t*3+k]])
    if (new Set(v).size < 3) continue
    const face = [...v].sort().join('|')
    if (faces.has(face)) continue
    faces.add(face)
    for (let k = 0; k < 3; k++) {
      const key = [v[k], v[(k+1)%3]].sort().join('|')
      edges.set(key, (edges.get(key) || 0) + 1)
    }
  }
  return (mesh._closed = faces.size >= 4 && [...edges.values()].every(n => n === 2))
}

function pointInsideClosedMesh(mesh, p) {
  if (!isClosedMesh(mesh)) return false
  const bvh = bvhOf(mesh)
  if (!bvh) return false
  const direction = [1, 0.3713906763541037, 0.5292235823398234]
  const tolerance = Math.max(mesh.diag * 1e-10, Number.EPSILON * mesh.diag * 32)
  const distances = []
  const stack = [0]
  while (stack.length) {
    const node = bvh.nodes[stack.pop()]
    let near = 0, far = Infinity
    for (let k = 0; k < 3; k++) {
      near = Math.max(near, (node.min[k] - p[k]) / direction[k])
      far = Math.min(far, (node.max[k] - p[k]) / direction[k])
    }
    if (near > far || far <= tolerance) continue
    if (node.left >= 0) { stack.push(node.left, node.right); continue }
    for (let i = node.start; i < node.start + node.count; i++) {
      const tri = bvh.order[i]
      const a = mesh.indices[tri * 3] * 3, b = mesh.indices[tri * 3 + 1] * 3, c = mesh.indices[tri * 3 + 2] * 3
      const pos = mesh.positions
      const e1 = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]]
      const e2 = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]]
      const h = [direction[1] * e2[2] - direction[2] * e2[1],
        direction[2] * e2[0] - direction[0] * e2[2], direction[0] * e2[1] - direction[1] * e2[0]]
      const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2]
      const det = dot(e1, h)
      if (Math.abs(det) <= Math.hypot(...e1) * Math.hypot(...e2) * 1e-12) continue
      const s = [p[0] - pos[a], p[1] - pos[a + 1], p[2] - pos[a + 2]]
      const u = dot(s, h) / det
      if (u < -1e-10 || u > 1 + 1e-10) continue
      const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]]
      const v = dot(direction, q) / det
      if (v < -1e-10 || u + v > 1 + 1e-10) continue
      const distance = dot(e2, q) / det
      if (distance > tolerance) distances.push(distance)
    }
  }
  distances.sort((a, b) => a - b)
  let crossings = 0, previous = -Infinity
  for (const d of distances) {
    // 同一表面的三角接缝/重复面只算一次穿越。
    if (d - previous > tolerance) { crossings++; previous = d }
  }
  return crossings % 2 === 1
}

/** 穿透深度是样本估计；无表面交线的包含分支额外验证实体内部。 */
function penetration(bvhMesh, points, verifyInside = false) {
  let maxDepth = 0, sum = 0, inside = 0
  for (const p of points) {
    // 最近边/顶点处单个三角面法线不能证明在体内；包围盒外的点必然不在体内。
    if (p[0] < bvhMesh.bbox[0] || p[0] > bvhMesh.bbox[3]
      || p[1] < bvhMesh.bbox[1] || p[1] > bvhMesh.bbox[4]
      || p[2] < bvhMesh.bbox[2] || p[2] > bvhMesh.bbox[5]) continue
    const r = nearestPoint(bvhMesh, p[0], p[1], p[2])
    if (!r) continue
    const sign = (p[0] - r.point[0]) * r.normal[0] + (p[1] - r.point[1]) * r.normal[1] + (p[2] - r.point[2]) * r.normal[2]
    if (verifyInside ? r.dist > Math.max(bvhMesh.diag * 1e-10, EPS) && pointInsideClosedMesh(bvhMesh, p) : sign < -1e-7) {
      inside++
      if (r.dist > maxDepth) maxDepth = r.dist
      sum += r.dist
    }
  }
  return { maxDepth, meanDepth: inside ? sum / inside : 0, inside }
}

export function interferencePairs(meshes, opts = {}) {
  const minDepth = opts.minDepth ?? 0.0005
  const minRatio = opts.minRatio ?? 0.005
  const maxPairs = opts.maxPairs ?? 30
  const maxCandidates = opts.maxCandidates ?? 5000
  const triangleWorkLimit = workBudget(opts.maxTriangleWork, SCENE_TRIANGLE_WORK_LIMIT)
  const triangleWorkPerPairLimit = workBudget(opts.maxTriangleWorkPerPair, TRIANGLE_WORK_LIMIT)
  const hits = []
  const groundContacts = []

  /* ── 地面豁免 ──
   *
   * 为什么要豁免：森林/废墟这类场景里，「树干扎进地面」「栅栏插进土里」
   * 是物理必然。旧判定把它们算成严重穿模，一个森林场景能报 287 对，
   * 于是这类场景**永远过不了门禁**——模型只能绕门禁或者删树。
   *
   * 处理方式：和承托面（地面/地形/地板）相交的对，单独归为
   * 「接地」，不算 severe，单独计数并在文案里说明。
   *
   * 可以用 opts.ignoreGround === false 关掉（想看全部原始数据时）。 */
  const ground = (opts.ignoreGround === false)
    ? { ground: new Set(), details: [] }
    : detectGroundSurfaces(meshes)
  let grounded = 0

  let candidates = 0, checked = 0, skipped = 0, trianglePairsCapped = 0
  let triangleWork = 0, triangleCandidateCount = 0, triangleOverlapCount = 0
  const incompletePairs = []
  for (let a = 0; a < meshes.length; a++) {
    const ma = meshes[a]
    for (let b = a + 1; b < meshes.length; b++) {
      const mb = meshes[b]
      if (!aabbOverlap(ma.bbox, mb.bbox)) continue
      candidates++
      if (candidates > maxCandidates) { skipped++; continue }

      /* 包围盒重叠厚度（三轴最小重叠）。任一轴不重叠 = 没相交。 */
      const bboxOv = bboxOverlapMin(ma.bbox, mb.bbox)

      // 承托面也必须经过窄阶段；包围盒重叠不能证明接地。

      const remainingWork = Math.max(0, triangleWorkLimit - triangleWork)
      const scan = scanTrianglePairs(ma, mb, {
        maxWork: Math.min(triangleWorkPerPairLimit, remainingWork), exact: true, classifyCrossings: true,
      })
      if (opts.pairScans) opts.pairScans.set(JSON.stringify([ma.id, mb.id].sort()), {
        overlapCount: scan.overlapCount, witness: scan.witness, complete: scan.complete,
      })
      const pairs = scan.pairs
      triangleWork += scan.work
      triangleCandidateCount += scan.candidateCount
      triangleOverlapCount += scan.overlapCount
      if (!scan.complete) {
        trianglePairsCapped++
        if (incompletePairs.length < 60) incompletePairs.push({
          a: ma.part, aId: ma.id, b: mb.part, bId: mb.id,
          reason: remainingWork <= triangleWorkPerPairLimit ? 'scene_work_limit' : 'pair_work_limit',
          work: scan.work, candidateCount: scan.candidateCount, overlapCount: scan.overlapCount,
        })
      }

      const groundMesh = ground.ground.has(ma.id) ? ma : ground.ground.has(mb.id) ? mb : null
      const other = groundMesh === ma ? mb : ma
      if (groundMesh && scan.overlapCount > 0 && other.bbox[5] > groundMesh.bbox[5]
        && other.bbox[2] >= groundMesh.bbox[5] - Math.max(EPS, other.dims[2] * 0.25)) {
        grounded++
        groundContacts.push({ a: ma.part, aId: ma.id, b: mb.part, bId: mb.id,
          ground: groundMesh.part, overlapFaces: scan.overlapCount, witness: scan.witness,
          evidence: 'surface-contact', interpretation: '可能是承托或浅埋，需核对用途；不是自动认可的装配' })
        continue
      }

      /* ── 情况一：真实三角形表面相交，继续判断接触或穿入深度 ── */
      /* ── 情况二：没有交线，但可能**完全包含** ──
       * 典型：小方块整个落在薄板内部，两条表面线根本不相交，
       * 窄阶段返回空。这时靠「顶点是否落在对方封闭实体内部」判断。 */
      if (pairs.length === 0) {
        if (!scan.complete) continue // 没检查完不能拿空样本证明没有表面相交。
        if (bboxOv <= 0) continue
        /* 用顶点采样快速判断是否一方包含另一方 */
        const va = sampleVertices(ma, 64)
        const vb = sampleVertices(mb, 64)
        const ab = penetration(mb, va, true)
        const ba = penetration(ma, vb, true)
        if (ab.inside === 0 && ba.inside === 0) continue
        checked++
        const depth = Math.max(ab.maxDepth, ba.maxDepth, bboxOv)
        const insideTotal = ab.inside + ba.inside
        const mean = insideTotal > 0
          ? (ab.meanDepth * ab.inside + ba.meanDepth * ba.inside) / insideTotal
          : 0
        const base = Math.max(EPS, Math.min(ma.diag, mb.diag))
        const ratio = depth / base
        if (depth < minDepth || ratio < minRatio) continue
        /* 状态分类（这个分支里单独算一次，cls 的通用定义在下面） */
        const clsC = classifyInterference(ma, mb)
        hits.push({
          a: ma.part, aId: ma.id, b: mb.part, bId: mb.id,
          depth, depthMean: mean, ratio,
          overlapFaces: 0,
          overlapCapped: false,
          insideSamples: insideTotal,
          /* 标记判定方式：0 交线、靠包含关系判断 */
          containment: true,
          evidence: 'inside-closed-solid', depthEstimated: true,
          /* 状态分类 */
          state: clsC.state,
          stateLabel: STATE_LABELS[clsC.state] || clsC.state,
          axisName: clsC.axisName,
          stateDetail: clsC.detail + '；分类是空间形态提示，不证明装配合理',
          pokeThrough: clsC.state === 'poke-through',
        })
        continue
      }

      checked++

      /* 穿透深度必须采样**整个物体里落在对方内部的点**，
       * 不能只采样「相交的那几个三角形」。
       *
       * 为什么：细杆穿过薄板时（桌腿插进桌面），杆的侧面与板的上下表面相交，
       * 但那些交点正好在交线上，到两个表面的距离都是 0——
       * 只采样它们算出的深度 ≈ 0，会被 minDepth 过滤掉，造成**漏判**。
       *
       * 正确做法：采样杆身中位于板内部的部分（那里距板表面最远，
       * 深度约等于板厚的一半），那才是真实穿透深度。
       *
       * 性能：只在包围盒重叠区内采样，总量封顶。 */
      const pa = sampleTrianglesInBox(ma, mb.bbox, 256)
      const pb = sampleTrianglesInBox(mb, ma.bbox, 256)
      const ab = penetration(mb, pa, true)
      const ba = penetration(ma, pb, true)

      /* 兜底：再加相交三角形的采样点（薄片/共面情况） */
      const triA = [...new Set(pairs.map((p) => p[0]))]
      const triB = [...new Set(pairs.map((p) => p[1]))]
      const ab2 = penetration(mb, sampleTriangles(ma, triA, 64), true)
      const ba2 = penetration(ma, sampleTriangles(mb, triB, 64), true)

      /* 穿模状态分类：穿出 / 完全嵌入 / 插入 / 互相穿过 / 重合 */
      const cls = classifyInterference(ma, mb)
      const surfaceCrossing = scan.crossingCount > 0
      const duplicateSolid = cls.state === 'coincident' && isClosedMesh(ma) && isClosedMesh(mb)
        && sampleVertices(ma, 32).every(p => nearestPoint(mb, ...p)?.dist <= Math.max(EPS, ma.diag*1e-9))
        && sampleVertices(mb, 32).every(p => nearestPoint(ma, ...p)?.dist <= Math.max(EPS, mb.diag*1e-9))

      const depthSamples = Math.max(ab.maxDepth, ba.maxDepth, ab2.maxDepth, ba2.maxDepth)

      /* 深度估算的第二条路径：包围盒重叠厚度。
       *
       * 有些穿透形态**没有任何内部采样点**——典型是「细杆穿过薄板」：
       * 桌腿（z 0.36~1.08）穿过桌面（z 0.72~0.78），
       * 腿的顶点在 0.36 和 1.08 都在桌面外，桌面顶点的 x/y 也在腿外。
       * 两边都没有点落在对方内部。
       *
       * 但三角形确实相交（腿的侧面穿过桌面上下表面），说明真的插在一起。
       * 这时用包围盒的**三轴最小重叠**作为穿透深度：
       * 那是它们互相嵌入的深度上限，正好等于薄板的厚度。
       *
       * 表面贴合不会被误判：两个盒子并排时某轴重叠为 0，深度就是 0。 */
      let depth = depthSamples
      if (depth <= 0 && (surfaceCrossing || duplicateSolid)) {
        const ov = bboxOverlapMin(ma.bbox, mb.bbox)
        if (ov > 0) {
          /* 不超过较小物体的对角线（防止一个薄板包住整个物体时报出荒谬深度） */
          depth = Math.min(ov, Math.min(ma.diag, mb.diag))
        }
      }
      const insideTotal = ab.inside + ba.inside + ab2.inside + ba2.inside
      const mean = insideTotal > 0
        ? (ab.meanDepth * ab.inside + ba.meanDepth * ba.inside
          + ab2.meanDepth * ab2.inside + ba2.meanDepth * ba2.inside) / insideTotal
        : 0
      const base = Math.max(EPS, Math.min(ma.diag, mb.diag))
      const ratio = depth / base
      if (!surfaceCrossing && !duplicateSolid && (depth < minDepth || ratio < minRatio)) continue
      const state = cls.state === 'none' && surfaceCrossing ? 'mutual' : cls.state
      /* 计数来自完整流式扫描；样本存满不代表覆盖不完整。 */
      const capped = !scan.complete
      hits.push({
        a: ma.part, aId: ma.id, b: mb.part, bId: mb.id,
        depth, depthMean: mean, ratio,
        overlapFaces: scan.overlapCount,
        overlapCapped: capped,
        insideSamples: insideTotal,
        evidence: surfaceCrossing ? 'triangle-crossing' : duplicateSolid ? 'coincident-solid' : 'inside-samples',
        surfaceCrossing, crossingFaces: scan.crossingCount, witness: scan.witness,
        depthEstimated: true,
        belowDepthThreshold: depth < minDepth || ratio < minRatio,
        /* 状态分类：穿出 / 嵌入 / 插入 / 互穿 / 重合 */
        state,
        stateLabel: STATE_LABELS[state] || state,
        axisName: cls.axisName,
        stateDetail: (cls.state === 'none' && surfaceCrossing ? '零厚度表面存在真实横穿交线' : cls.detail)
          + '；分类是空间形态提示，不证明装配合理',
        pokeThrough: cls.state === 'poke-through',
      })
    }
  }
  /* 排序：严重状态优先，然后按比例。
   * 「穿出」比普通插入严重得多，不能因为比例小而排在后面。 */
  const sev = (h) => (SEVERE_STATES.has(h.state) ? 1 : 0)
  hits.sort((x, y) => sev(y) - sev(x) || y.ratio - x.ratio)
  /* grounded = 被豁免的「接地」对数（物体扎进地面/地形）。
   * 这不是错误，但要说出来——否则「穿模 0 对」会让人以为检查和实际情况脱节。 */
  return {
    hits, candidates, checked, skipped, trianglePairsCapped,
    triangleWork, triangleWorkLimit, triangleWorkPerPairLimit,
    triangleCandidateCount, triangleOverlapCount, incompletePairs,
    complete: skipped === 0 && trianglePairsCapped === 0,
    grounded,
    groundContacts,
    groundSurfaces: ground.details,
  }
}

/** 全表面接触图：未知与无接触分开，包围盒仅用于候选筛选。 */
export function isolatedMeshes(meshes, opts = {}) {
  const contactGap = Math.max(0, opts.contactGap ?? 1e-5)
  const gapRatio = Math.max(0, opts.gapRatio ?? 0.01)
  const gapAbsCap = Math.max(0, opts.gapAbsCap ?? 0.01)
  const tolOf = m => Math.max(contactGap, Math.min((m.diag || 0)*gapRatio, gapAbsCap))
  const workLimit = workBudget(opts.maxTriangleWork, SCENE_TRIANGLE_WORK_LIMIT)
  const pairLimit = workBudget(opts.maxTriangleWorkPerPair, TRIANGLE_WORK_LIMIT)
  const contacts = [], unknownPairs = [], hits = []
  const adjacency = new Map(meshes.map(m => [m.id, new Set()]))
  const uncertain = new Set()
  const nearest = new Map()
  let work = 0, candidates = 0, reused = 0, unknownPairCount = 0
  const rememberGap = (m, other, gap, kind) => {
    if (gap < (nearest.get(m.id)?.gap ?? Infinity)) nearest.set(m.id, { nearest: other.part, gap, gapKind: kind })
  }
  for (let i = 0; i < meshes.length; i++) for (let j = i+1; j < meshes.length; j++) {
    const a = meshes[i], b = meshes[j]
    const gap = Math.hypot(...[0,1,2].map(k => Math.max(0, a.bbox[k]-b.bbox[k+3], b.bbox[k]-a.bbox[k+3])))
    const tolerance = Math.min(tolOf(a), tolOf(b))
    rememberGap(a, b, gap, 'bbox-lower-bound')
    rememberGap(b, a, gap, 'bbox-lower-bound')
    if (gap > tolerance) continue
    candidates++
    let scan = opts.pairScans?.get(JSON.stringify([a.id, b.id].sort()))
    if (scan?.overlapCount > 0) reused++
    else {
      // 即使零间隙扫描未发现交线，仍检查容差内的边边/点面最近距离。
      scan = scanTrianglePairs(a, b, { exact: true, contactGap: tolerance,
        sampleLimit: 1, stopAtSampleLimit: true, maxWork: Math.min(pairLimit, Math.max(0, workLimit-work)) })
      work += scan.work
    }
    if (scan.overlapCount > 0) {
      adjacency.get(a.id).add(b.id); adjacency.get(b.id).add(a.id)
      contacts.push({ aId: a.id, bId: b.id, a: a.part, b: b.part, tolerance,
        evidence: scan.witness?.distance > 0 ? 'within-tolerance' : 'surface-intersection', witness: scan.witness })
    } else if (!scan.complete) {
      uncertain.add(a.id); uncertain.add(b.id)
      unknownPairCount++
      if (unknownPairs.length < 1000) unknownPairs.push({ aId: a.id, bId: b.id, a: a.part, b: b.part, reason: 'contact_work_limit' })
    }
  }
  for (const m of meshes) {
    if (meshes.length <= 1 || adjacency.get(m.id).size || uncertain.has(m.id)) continue
    hits.push({ id: m.id, part: m.part, dims: m.dims, meta: m.meta || {},
      ...(nearest.get(m.id) || { nearest: null, gap: null, gapKind: 'unavailable' }),
      tolerance: tolOf(m), evidence: 'no-surface-contact' })
  }
  hits.sort((a, b) => (b.gap || 0) - (a.gap || 0))
  return { hits, shown: hits.slice(0, opts.maxItems ?? 30), contacts, unknownPairs,
    unknownPairCount, unknownOmitted: unknownPairCount - unknownPairs.length,
    complete: unknownPairCount === 0, work, workLimit, candidates, reused,
    checked: meshes.length, skippedSingleton: meshes.length <= 1, contactGap, gapRatio, gapAbsCap }
}

function sampleVertices(mesh, cap) {
  // 顶点 + 三角形重心一起采样：只取顶点会漏掉"最近点落在面中央"的情况，
  // 对立方体这类低模会系统性高估间距（顶点到面的距离大于面到面）。
  const out = []
  const nv = mesh.vertices
  const step = Math.max(1, Math.ceil(nv / Math.max(1, cap >> 1)))
  for (let i = 0; i < nv && out.length < cap; i += step) {
    out.push([mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]])
  }
  const nt = mesh.triangles
  const tstep = Math.max(1, Math.ceil(nt / Math.max(1, cap >> 1)))
  for (let t = 0; t < nt && out.length < cap * 2; t += tstep) {
    out.push(triCentroid(mesh.positions, mesh.indices, t))
  }
  return out
}

/* ─────────────────────────── 文案 ─────────────────────────── */

export function pct(x) { return (Number(x) * 100).toFixed(2) + '%' }

export function num(x) {
  const v = Number(x)
  if (!Number.isFinite(v)) return String(x)
  if (v === 0) return '0'
  if (Math.abs(v) >= 1) return v.toFixed(3)
  if (Math.abs(v) >= 0.01) return v.toFixed(4)
  return v.toFixed(5)
}

export function interferenceLine(h) {
  const faces = h.overlapCapped ? '≥' + h.overlapFaces : String(h.overlapFaces)
  return '命名为「' + h.a + '」的部件，与命名为「' + h.b + '」的部件穿模程度为 ' + pct(h.ratio) +
    '（估计深度 ' + num(h.depth) + '，平均 ' + num(h.depthMean) + '，相交三角对 ' + faces
    + (h.surfaceCrossing ? '，有三角面横穿证据' : '') + '；是否预期装配需结合用途核实）'
}

export function isolationLine(h) {
  const gapTxt = !Number.isFinite(h.gap)
    ? '场景里没有其它 mesh'
    : (h.gap === 0 ? '0' : num(h.gap))
  return '命名为「' + h.part + '」的部件，与周围所有 mesh 都不接触'
    + (Number.isFinite(h.gap)
      ? (h.gapKind === 'bbox-lower-bound'
        ? '（候选邻件「' + (h.nearest ?? '无') + '」，包围盒间距下界 ' + gapTxt + '，不是真实最近距离）'
        : '（最近的是「' + (h.nearest ?? '无') + '」，距离 ' + gapTxt + '）')
      : '（' + gapTxt + '）')
}

/* ────────────────────── 形状分类 / 必看视角 ────────────────────── */

export function classifyDims(dims) {
  const d = [...dims].map((x) => Math.abs(Number(x) || 0)).sort((a, b) => a - b)
  const [s, , l] = d
  if (l <= EPS) return 'point'
  if (s <= EPS || s / l < 0.2) return 'flat'
  if (l / s >= 4) return 'elongated'
  return 'blocky'
}

/**
 * 固定的五视图。这是验收用的最小集合，不能因为形状不同而减少。
 *
 * 为什么是这五张：
 *   - 正/侧/顶：工程图的三个标准投影，覆盖「长宽高各是多少」
 *   - **背面**：正视看不到的部分全在这里。建模最常见的偷懒就是只做朝向
 *     相机的那一面，背面随便糊一下——从背面看立刻露馅。
 *   - 正视剪影：去掉材质阴影只剩轮廓，只有它能和参考图逐像素比对
 *
 * 形状只影响**正交方向**（哪个轴朝相机），不影响「必须看几张」。
 */
export const VIEW_NAMES = ['front', 'back', 'side', 'top', 'front_silhouette']

/** 视图的中文名，用于文案。 */
export const VIEW_LABELS = {
  front: '正视',
  back: '背面',
  side: '侧视',
  left: '左视',
  right: '右视',
  top: '顶视',
  iso: '等轴',
  front_silhouette: '正视剪影',
}

export function requiredViews(kind, dims, axisMap) {
  const d = dims.map((x) => Math.abs(Number(x) || 0))
  const shape = kind === 'scene' ? 'scene' : classifyDims(d)
  const ax = axisMap || { front: 'Y', side: 'X', top: 'Z' }
  const aName = ['X', 'Y', 'Z']
  const longAxis = aName[d.indexOf(Math.max(...d))]

  return {
    views: VIEW_NAMES.slice(),
    shape,
    axisMap: ax,
    reason: '固定五视图：正视（沿 ' + ax.front + ' 轴看）、**背面**（沿 ' + ax.front + ' 轴反向看）、'
      + '侧视（沿 ' + ax.side + ' 轴看）、顶视（沿 ' + ax.top + ' 轴看），再加一张正视剪影。'
      + '背面这张是专门查偷懒的：只做正面、背面随便糊，从背面一看就露馅。'
      + '剪影去掉材质阴影只剩轮廓，用来和参考图逐像素比对。'
      + '长轴是 ' + longAxis + '，如果某个视图看到的是一条线而不是面，说明视角轴选错了。',
  }
}

/** 五视图在标准坐标里的相机方向（正交）。 */
export const VIEW_DIRECTIONS = {
  front: [0, -1, 0],
  back: [0, 1, 0],
  side: [-1, 0, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, 0, 1],
  iso: [1, -1, 0.8],
  front_silhouette: [0, -1, 0],
}

/**
 * 对比正面与背面两张图，估算背面是否明显偷工。
 *
 * 判据：如果是「左右/前后对称」的部件，背面和正面应该长得差不多，
 * 剪影面积比接近 1。比值偏离太多说明背面形状和正面差很远。
 *
 * 注意：这不是强制判错，只是给模型一个提示。有些部件本来就该
 * 正反不同（比如有靠背的椅子），所以只报数值和提示，不判罚。
 */
export function compareFrontBack(frontGray, backGray, w, h, threshold = 128) {
  const n = Math.min(w * h, frontGray.length, backGray.length)
  let cf = 0
  let cb = 0
  for (let i = 0; i < n; i++) {
    if (frontGray[i] >= threshold) cf++
    if (backGray[i] >= threshold) cb++
  }
  if (n === 0) return { ratio: null, frontRatio: 0, backRatio: 0 }
  const fr = cf / n
  const br = cb / n
  const ratio = fr === 0 ? (br === 0 ? 1 : null) : br / fr
  return { ratio, frontRatio: fr, backRatio: br }
}

/* ───────────────────── 剪影比对 ───────────────────── */

/**
 * 把两张图缩到同一尺寸，逐像素算"实体区域"的交并比。
 *
 * 调用方传入的是 PNG 的**灰度平面**（0-255，按行铺开）。这里只做统计，
 * 不做 PNG 解码——解码在 Node 侧由调用方负责，保持核心与文件格式无关。
 */
export function silhouetteIoU(aGray, bGray, w, h, threshold = 128) {
  const n = Math.min(w * h, aGray.length, bGray.length)
  let inter = 0
  let union = 0
  let ca = 0
  let cb = 0
  for (let i = 0; i < n; i++) {
    const fa = aGray[i] >= threshold
    const fb = bGray[i] >= threshold
    if (fa) ca++
    if (fb) cb++
    if (fa || fb) union++
    if (fa && fb) inter++
  }
  return {
    iou: union === 0 ? 1 : inter / union,
    aRatio: n === 0 ? 0 : ca / n,
    bRatio: n === 0 ? 0 : cb / n,
    overlap: inter,
    union,
  }
}

/**
 * 判定"外形是否与参考几乎一致"。
 *
 * 阈值 0.92 是按"人工能看出明显差别"反推的：IoU 低于 0.92 时，
 * 轮廓上至少有一处明显鼓出或凹进。这个数字偏严是有意的——
 * 外形是验收项，不是建议项。
 */
export const SILHOUETTE_PASS_IOU = 0.92

export function judgeSilhouette(iou, passThreshold = SILHOUETTE_PASS_IOU) {
  if (!Number.isFinite(iou)) return { pass: false, verdict: '无法判定（缺少参考或渲染失败）' }
  const pctv = (iou * 100).toFixed(2) + '%'
  if (iou >= passThreshold) {
    return { pass: true, verdict: '轮廓重合 ' + pctv + '，达到 ' + (passThreshold * 100) + '% 的门槛，外形可以算一致' }
  }
  if (iou >= 0.85) {
    return { pass: false, verdict: '轮廓重合 ' + pctv + '，接近但还不到 ' + (passThreshold * 100) + '%，有局部比例偏差，需要修' }
  }
  return { pass: false, verdict: '轮廓重合 ' + pctv + '，与参考差距明显，外形还不对' }
}
