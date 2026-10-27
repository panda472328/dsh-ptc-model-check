/**
 * 删除守卫单测：
 *   ① 删掉一个「大树」→ 应该判 restore（体量大 + 同组 + 有邻接）
 *   ② 删掉一个「2cm 螺丝」→ 应该判 keep-deleted
 *   ③ 原处被占 → offset 方案要给让开距离
 *   ④ 整组删空 → 强烈建议加回
 *
 *   node tests/verify_delete_guard.mjs
 */
import { judgeDeleted, restorePlan, snapshotMesh } from '../lib/core/geometry.mjs'

let failed = 0
const expect = (label, cond, detail) => {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

/* 造一个 mesh 形状的输入 */
function mk(id, part, bbox, extra = {}) {
  const [x0, y0, z0, x1, y1, z1] = bbox
  return {
    id, part,
    bbox,
    dims: [x1 - x0, y1 - y0, z1 - z0],
    diag: Math.hypot(x1 - x0, y1 - y0, z1 - z0),
    triangles: 100, vertices: 80,
    meta: { collection: extra.collection || null, materials: extra.materials || [] },
  }
}

console.log('=== ① snapshotMesh 保留必要字段 ===')
{
  const m = mk('t1', '松树_A', [0, 0, 0, 2, 2, 8], { collection: '森林', materials: ['树皮'] })
  const s = snapshotMesh(m)
  expect('有 bbox', Array.isArray(s.bbox) && s.bbox.length === 6, JSON.stringify(s.bbox))
  expect('有 center', Array.isArray(s.center) && s.center.length === 3, JSON.stringify(s.center))
  expect('center 正确', s.center[0] === 1 && s.center[2] === 4, JSON.stringify(s.center))
  expect('有 dims', Array.isArray(s.dims) && s.dims[2] === 8, JSON.stringify(s.dims))
  expect('记住所属组', s.collection === '森林', String(s.collection))
  expect('记住材质', s.materials.includes('树皮'), JSON.stringify(s.materials))
}

console.log('\n=== ② 删掉大树 + 同组 + 有邻接 → 建议加回 ===')
{
  /* 场景：一棵树被删了，旁边还有另一棵树紧挨着 */
  const surviving = [
    mk('t2', '松树_B', [2.5, 0, 0, 4.5, 2, 8], { collection: '森林' }),
    mk('g1', '地形_地面', [-30, -30, 0, 30, 30, 0], { collection: '环境' }),
  ]
  const deleted = snapshotMesh(mk('t1', '松树_A', [0, 0, 0, 2, 2, 8], { collection: '森林' }))
  const sceneDiag = Math.hypot(60, 60, 8)
  const j = judgeDeleted(deleted, surviving, { sceneDiag, groupNames: ['森林', '环境'] })
  console.log('  判定: ' + j.verdict)
  for (const r of j.reasons) console.log('    - ' + r)
  expect('判为 restore', j.verdict === 'restore', j.verdict)
  expect('给了复原方案', !!j.where && !!j.where.exact, JSON.stringify(j.where && Object.keys(j.where)))
}

console.log('\n=== ③ 删掉小螺丝 → 可以不加回 ===')
{
  const surviving = [
    mk('g1', '地形_地面', [-30, -30, 0, 30, 30, 0], { collection: '环境' }),
    mk('w1', '墙_主体', [-5, -4, 0, 5, 4, 3], { collection: '小屋' }),
  ]
  /* 一个 2cm 的螺丝，孤立在很远的地方，不属于任何组 */
  const deleted = snapshotMesh(mk('s1', '螺丝_x', [20, 20, 5, 20.02, 20.02, 5.02], {}))
  const sceneDiag = Math.hypot(60, 60, 6)
  const j = judgeDeleted(deleted, surviving, { sceneDiag, groupNames: ['环境', '小屋'] })
  console.log('  判定: ' + j.verdict)
  for (const r of j.reasons) console.log('    - ' + r)
  expect('判为 keep-deleted', j.verdict === 'keep-deleted', j.verdict)
}

console.log('\n=== ④ 整组被删空 → 强烈建议加回 ===')
{
  /* 「森林」组一个都不剩了 */
  const surviving = [
    mk('g1', '地形_地面', [-30, -30, 0, 30, 30, 0], { collection: '环境' }),
  ]
  const deleted = snapshotMesh(mk('t1', '松树_A', [0, 0, 0, 2, 2, 8], { collection: '森林' }))
  const j = judgeDeleted(deleted, surviving, {
    sceneDiag: Math.hypot(60, 60, 8), groupNames: ['森林', '环境'],
  })
  console.log('  判定: ' + j.verdict)
  for (const r of j.reasons) console.log('    - ' + r)
  expect('判为 restore', j.verdict === 'restore', j.verdict)
  expect('理由提到整组删空', j.reasons.some((r) => /整组被删空/.test(r)), j.reasons.join(' | '))
}

console.log('\n=== ⑤ 原处被占 → 给 offset 方案 ===')
{
  /* 删掉的物体原位置，现在被另一个物体占住了 */
  const deleted = snapshotMesh(mk('a1', '箱子', [0, 0, 0, 2, 2, 2], { collection: '道具' }))
  const surviving = [
    mk('b1', '新箱子', [0.5, 0.5, 0.5, 2.5, 2.5, 2.5], { collection: '道具' }),
  ]
  const plan = restorePlan(deleted, surviving)
  console.log('  exact: ' + JSON.stringify(plan.exact.location))
  console.log('  offset: ' + (plan.offset ? plan.offset.note + ' → ' + JSON.stringify(plan.offset.location) : '（无）'))
  expect('给了 offset 方案', !!plan.offset, 'null')
  expect('说明被谁占了', !!(plan.offset && plan.offset.blockedBy), '')
  expect('让开后的位置与原位置不同',
    !!plan.offset && JSON.stringify(plan.offset.location) !== JSON.stringify(plan.exact.location), '')
}

console.log('\n=== ⑥ 原处空着 → exact 可以直接用 ===')
{
  const deleted = snapshotMesh(mk('a1', '箱子', [0, 0, 0, 2, 2, 2], { collection: '道具' }))
  const surviving = [mk('b1', '远处的箱子', [50, 50, 0, 52, 52, 2], { collection: '道具' })]
  const plan = restorePlan(deleted, surviving)
  expect('没有 offset（原处空着）', !plan.offset, JSON.stringify(plan.offset))
  expect('exact 是原中心点', JSON.stringify(plan.exact.location) === '[1,1,1]', JSON.stringify(plan.exact.location))
  expect('给了 anchored（贴靠参考）', !!plan.anchored, '')
}

console.log('\n' + (failed === 0 ? 'DELETE_GUARD_OK' : 'DELETE_GUARD_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
