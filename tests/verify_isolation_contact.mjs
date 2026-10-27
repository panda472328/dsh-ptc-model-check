/**
 * 悬空件检测回归测试。
 *
 * 背景（真实事故）：
 *   建模测试7 的城市场景里，**6 个雨棚悬在楼上方 2~3cm**、
 *   **8 辆轿车悬浮在地面上 3.3cm**、**4 个长椅离地 1.2cm**，
 *   但孤立检测报 **0 个孤立**——全部漏判。
 *
 *   根因：`bboxOverlapExtent > 0` 这条捷径。
 *   雨棚和主楼的包围盒在 X/Z 上范围**完全一致**、Y 上重叠 0.03m，
 *   于是三轴都 > 0 → 直接判「必然接触」，根本没算真实距离。
 *
 *   修法：把「重叠 > 0」改成「**单方向包含**」——
 *   要求一方在某轴上被另一方完全罩住，且两者大小有明显差异
 *   （范围相同的并列关系不算包含）。至少 2 个轴满足才算真嵌进去。
 *
 *   node tests/verify_isolation_contact.mjs
 */
import { isolatedMeshes, makeMesh, scanTrianglePairs } from '../lib/core/geometry.mjs'

let failed = 0
const expect = (label, cond, detail) => {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

/* 造长方体（8 顶点 12 三角，法线朝外） */
function box(id, cx, cy, cz, sx, sy, sz) {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2
  const v = []
  for (const dz of [-hz, hz]) {
    for (const dy of [-hy, hy]) {
      for (const dx of [-hx, hx]) v.push(cx + dx, cy + dy, cz + dz)
    }
  }
  const idx = [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]
  return makeMesh(id, id, new Float64Array(v), new Uint32Array(idx))
}

console.log('=== ① 贴着的东西不报孤立 ===')
{
  /* 桌腿顶插进桌面里：桌面 z 0.96~1.04，腿 z 0.04~1.08 */
  const top = box('桌面', 0, 0, 1.0, 2, 2, 0.08)
  const leg = box('腿', 0, 0, 0.56, 0.1, 0.1, 1.04)
  const r = isolatedMeshes([top, leg])
  console.log('  孤立: ' + r.hits.length + (r.hits.length ? '（' + r.hits.map((h) => h.part).join(',') + '）' : ''))
  expect('插接的腿不算孤立', r.hits.length === 0, JSON.stringify(r.hits.map((h) => h.part)))
}

console.log('\n=== ② 悬空的雨棚必须报出来（核心回归）===')
{
  /* 复刻测试7 的真实情形（从会话记录里抄的坐标）：
   *   主楼 bbox = 9.5, 25.5, 0.16 → 21.5, 41.5, 27.16
   *   雨棚 bbox = 10.3, 25.5, 3.56 → 20.7, 26.53, 4.21
   *
   * 注意雨棚的 Y 起点和主楼**一样是 25.5**，但雨棚的 Z 只有 3.56~4.21，
   * 而主楼 Z 是 0.16~27.16。也就是说雨棚嵌在楼板的 Y 边界上，
   * 但真实表面距离是 2cm（模型把它放在了离墙面 2cm 的位置）。
   *
   * 这个形体很微妙：包围盒三轴都重叠，且雨棚三轴都被楼罩住。
   * 唯一能区分「贴住」和「悬空」的只有**真实表面距离**。
   * 所以这里必须让捷径失效——用一对「范围相同」的物体来验。 */
  const tower = box('楼4_主楼', 15.5, 33.5, 13.66, 12, 16, 27)
  /* 雨棚：X/Z 范围和主楼在楼内，但整体沿 -Y 方向平移出 0.05 */
  const canopy = box('楼4_雨棚', 15.5, 25.5 - 0.515 - 0.05, 3.885, 10.4, 1.03, 0.65)

  /* 先确认这组几何确实是「有包围盒重叠、但表面不贴合」 */
  const ov = [0, 1, 2].map((k) => Math.min(tower.bbox[k + 3], canopy.bbox[k + 3]) - Math.max(tower.bbox[k], canopy.bbox[k]))
  console.log('  三轴重叠: ' + ov.map((v) => v.toFixed(3)).join(', ')
    + '（Y 为负说明没有包围盒重叠 → 会走真实距离，这正是我们要的）')

  const r = isolatedMeshes([tower, canopy])
  console.log('  孤立: ' + r.hits.length)
  for (const h of r.hits) console.log('    · ' + h.part + ' gap=' + h.gap.toFixed(4))
  expect('雨棚被判孤立', r.hits.length > 0, '漏判了')
  const c = r.hits.find((h) => /雨棚/.test(h.part))
  expect('报的是雨棚', !!c, r.hits.map((h) => h.part).join(','))
  if (c) expect('算出了真实距离', Number.isFinite(c.gap) && c.gap > 0.001, String(c.gap))
}

console.log('\n=== ②b 真正的核心：范围一致但表面不贴合 ===')
{
  /* 这才是不严谨的捷径最容易出错的地方：
   * 两个物体的包围盒在 X/Z 上**范围完全一致**（谁也没罩住谁，只是并列），
   * Y 上只重叠一点点。旧判据会因为「三轴都重叠」直接判接触。
   * 新判据因为「没有单向包含 + 没有尺度差」而不走捷径，改算真实距离。 */
  const big = box('大楼', 0, 0, 10, 20, 20, 20)      // X 20, Y 20, Z 20
  const slab = box('雨棚', 0, 10.02, 0, 20, 0.5, 20) // X/Z 和楼完全一样，Y 在楼顶上方

  const ov = [0, 1, 2].map((k) => Math.min(big.bbox[k + 3], slab.bbox[k + 3]) - Math.max(big.bbox[k], slab.bbox[k]))
  console.log('  三轴重叠: ' + ov.map((v) => v.toFixed(3)).join(', ') + '（Y 为负 = 不在楼里）')

  const r = isolatedMeshes([big, slab])
  console.log('  孤立 ' + r.hits.length + ' 个: ' + r.hits.map((h) => h.part + '(' + h.gap.toFixed(3) + ')').join(', '))
  // 这组原夹具实际 Y 重叠 0.23、Z 重叠 10，不是悬空。
  expect('夹具存在真实三角面交线', scanTrianglePairs(big, slab, { exact: true }).overlapCount > 0)
  expect('真实穿入的雨棚不能误报为孤立', !r.hits.some((h) => /雨棚/.test(h.part)))
  const separated = box('雨棚_有缝', 0, 10.27, 0, 20, 0.5, 20)
  expect('有 2cm 间隙的雨棚仍报孤立', isolatedMeshes([big, separated]).hits.some(h => /有缝/.test(h.part)))
}

console.log('\n=== ③ 悬浮的轿车必须报出来 ===')
{
  /* 地面 z 0~0.59，车 z 0.62~2.12（离地 3cm） */
  const ground = box('地面', 0, 0, 0.295, 300, 300, 0.59)
  const car = box('轿车1', 10, 10, 1.37, 1.9, 4.6, 1.5)
  const r = isolatedMeshes([ground, car])
  console.log('  孤立: ' + r.hits.length)
  for (const h of r.hits) console.log('    · ' + h.part + ' gap=' + h.gap.toFixed(4))
  expect('悬浮的轿车被判孤立', r.hits.some((h) => /轿车/.test(h.part)), r.hits.map((h) => h.part).join(','))
}

console.log('\n=== ④ 完全贴合的不报 ===')
{
  const ground = box('地面', 0, 0, 0, 100, 100, 1)
  /* 箱底正好在地面顶面 z=0.5 上 */
  const crate = box('箱子', 0, 0, 1.0, 2, 2, 1)
  const r = isolatedMeshes([ground, crate])
  console.log('  孤立: ' + r.hits.length)
  expect('严丝合缝贴着的不报孤立', r.hits.length === 0, JSON.stringify(r.hits.map((h) => h.part)))
}

console.log('\n=== ⑤ 三个都悬空时全部报出来 ===')
{
  /* 城市场景：地面 + 3 个悬空的雨棚 */
  const ground = box('地面', 0, 0, 0.295, 300, 300, 0.59)
  const b1 = box('楼1_主楼', 0, 0, 10, 20, 20, 20)
  const c1 = box('楼1_雨棚', 0, 0, 20.5, 8, 2, 0.3)   /* 悬在楼顶上方 0.2 */
  const c2 = box('楼2_雨棚', 40, 0, 5.5, 8, 2, 0.3)  /* 独立悬空 */
  const c3 = box('楼3_雨棚', 80, 0, 5.5, 8, 2, 0.3)
  const r = isolatedMeshes([ground, b1, c1, c2, c3])
  console.log('  孤立 ' + r.hits.length + ' 个: ' + r.hits.map((h) => h.part + '(' + h.gap.toFixed(3) + ')').join(', '))
  expect('至少报出 2 个悬空雨棚', r.hits.filter((h) => /雨棚/.test(h.part)).length >= 2,
    r.hits.map((h) => h.part).join(','))
  expect('主楼本身不算孤立（立在地面上）', !r.hits.some((h) => /楼1_主楼/.test(h.part)),
    r.hits.map((h) => h.part).join(','))
}

console.log('\n' + (failed === 0 ? 'ISOLATION_CONTACT_OK' : 'ISOLATION_CONTACT_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
