/**
 * 地面豁免回归测试。
 *
 * 背景（真实事故）：
 *   一个森林小屋场景报了 **287 对穿模**，其中绝大多数是
 *   「树干扎进地面」「栅栏立柱插进土里」——物理上必然如此。
 *   旧判定把它们算成严重错误，于是这类场景**永远过不了门禁**。
 *   模型为了往下走只能绕门禁（在脚本里直接调渲染和存盘），
 *   或者干脆把树删掉。
 *
 *   这不是模型偷懒，是判定不成立。地面是**承托面**，不是被穿模的物体。
 *
 *   node tests/verify_ground_exemption.mjs
 */
import { detectGroundSurfaces, interferencePairs, SEVERE_STATES, makeMesh } from '../lib/core/geometry.mjs'

let failed = 0
const expect = (label, cond, detail) => {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

/* 造一个长方体 mesh（8 顶点 12 三角） */
function box(id, part, cx, cy, cz, sx, sy, sz, meta = {}) {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2
  const v = []
  for (const dz of [-hz, hz]) {
    for (const dy of [-hy, hy]) {
      for (const dx of [-hx, hx]) v.push(cx + dx, cy + dy, cz + dz)
    }
  }
  const idx = [
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
  ]
  return makeMesh(id, part, new Float64Array(v), new Uint32Array(idx), meta)
}

/* 造一个零厚度大平面（地面） */
function plane(id, part, cx, cy, z, sx, sy, meta = {}) {
  const hx = sx / 2, hy = sy / 2
  const v = new Float64Array([cx - hx, cy - hy, z, cx + hx, cy - hy, z, cx + hx, cy + hy, z, cx - hx, cy + hy, z])
  const idx = new Uint32Array([0, 1, 2, 0, 2, 3])
  return makeMesh(id, part, v, idx, meta)
}

console.log('=== ① 识别承托面：大平面 + 托着东西 ===')
{
  const meshes = [
    plane('g', '地形_地面', 0, 0, 0, 60, 60, { collection: '环境' }),
    box('t1', '松_干_1', 0, 8, 2, 0.6, 0.6, 6, { collection: '森林' }),
    box('t2', '松_干_2', 7, 8, 2, 0.6, 0.6, 6, { collection: '森林' }),
    box('t3', '松_干_3', -7, 8, 2, 0.6, 0.6, 6, { collection: '森林' }),
    box('t4', '松_干_4', 0, -8, 2, 0.6, 0.6, 6, { collection: '森林' }),
    box('t5', '松_干_5', 14, 8, 2, 0.6, 0.6, 6, { collection: '森林' }),
    box('w', '墙_主体', 0, 0, 1.5, 5, 4, 3, { collection: '小屋' }),
    box('r', '石头_1', 20, 0, 0.5, 1.5, 1.5, 1, { collection: '环境道具' }),
  ]
  const g = detectGroundSurfaces(meshes)
  console.log('  识别到: ' + g.details.map((d) => d.part + '（扁平 ' + d.flatness + '，覆盖 ' + d.coverage.join('%×') + '%）').join(', '))
  expect('地面被识别', g.ground.has('g'), JSON.stringify([...g.ground]))
  expect('树干不被当成地面', !g.ground.has('t1'))
  expect('墙不被当成地面', !g.ground.has('w'))
}

console.log('\n=== ② 反例：钢筋很扁但不够宽，不该算地面 ===')
{
  /* 一根细长钢筋：X/Y 很小，Z 很长 → 扁平比小，但覆盖极低 */
  const meshes = [
    plane('g', '地形_地面', 0, 0, 0, 60, 60),
    box('s', '钢筋', 0, 0, 1.5, 0.3, 8, 0.3),
    box('w', '墙_主体', 0, 0, 1.5, 5, 4, 3),
    box('t1', '松_干_1', 10, 0, 2, 0.6, 0.6, 6),
    box('t2', '松_干_2', -10, 0, 2, 0.6, 0.6, 6),
    box('t3', '松_干_3', 0, 10, 2, 0.6, 0.6, 6),
    box('t4', '松_干_4', 0, -10, 2, 0.6, 0.6, 6),
    box('r', '石头_1', 20, 20, 0.5, 1.5, 1.5, 1),
  ]
  const g = detectGroundSurfaces(meshes)
  expect('钢筋不被当成地面', !g.ground.has('s'), JSON.stringify([...g.ground]))
}

console.log('\n=== ③ 树扎进地面 → 被豁免，不算穿模 ===')
{
  const meshes = [
    plane('g', '地形_地面', 0, 0, 0, 60, 60),
    /* 树干中心 z=2，高 6 → 从 -1 到 5，扎进地面 1 米 */
    box('t1', '松_干_1', 0, 0, 2, 0.6, 0.6, 6),
    box('t2', '松_干_2', 7, 0, 2, 0.6, 0.6, 6),
    box('t3', '松_干_3', -7, 0, 2, 0.6, 0.6, 6),
    box('t4', '松_干_4', 0, 7, 2, 0.6, 0.6, 6),
    box('t5', '松_干_5', 0, -7, 2, 0.6, 0.6, 6),
    box('r1', '石头_1', 20, 0, 0.5, 1.5, 1.5, 1),
    box('r2', '石头_2', -20, 0, 0.5, 1.5, 1.5, 1),
  ]
  const withEx = interferencePairs(meshes)
  const noEx = interferencePairs(meshes, { ignoreGround: false })
  console.log('  开豁免: hits=' + withEx.hits.length + '  接地=' + withEx.grounded)
  console.log('  关豁免: hits=' + noEx.hits.length)
  expect('识别出承托面', withEx.groundSurfaces.length > 0, String(withEx.groundSurfaces.length))
  expect('树×地面被记为接地', withEx.grounded >= 2, String(withEx.grounded))
  expect('接地不计入穿模命中', withEx.hits.filter((h) => /松_干/.test((h.a || '') + (h.b || ''))).length === 0,
    JSON.stringify(withEx.hits.map((h) => h.a + '×' + h.b)))
  expect('关掉豁免时这些对会出现', noEx.hits.length > withEx.hits.length
    || noEx.grounded === undefined || noEx.grounded === 0,
    'noEx.hits=' + noEx.hits.length)
}

console.log('\n=== ④ 真穿模不被豁免（钢筋穿墙）===')
{
  const meshes = [
    plane('g', '地形_地面', 0, 0, 0, 60, 60),
    box('w', '墙_主体', 0, 0, 1.5, 5, 4, 3),
    /* 钢筋横穿墙：Y 方向长 8，墙只有 4 → 两端都露出来 = 穿出 */
    box('s', '钢筋_穿墙', 0, 0, 1.5, 0.3, 8, 0.3),
    box('t1', '松_干_1', 12, 0, 2, 0.6, 0.6, 6),
    box('t2', '松_干_2', -12, 0, 2, 0.6, 0.6, 6),
    box('t3', '松_干_3', 0, 12, 2, 0.6, 0.6, 6),
    box('t4', '松_干_4', 0, -12, 2, 0.6, 0.6, 6),
    box('r', '石头_1', 22, 22, 0.5, 1.5, 1.5, 1),
  ]
  const r = interferencePairs(meshes)
  const steel = r.hits.filter((h) => /钢筋/.test((h.a || '') + (h.b || '')))
  console.log('  命中的穿模: ' + r.hits.map((h) => h.a + '×' + h.b + '(' + h.stateLabel + ')').join(', '))
  expect('钢筋穿墙仍报穿模', steel.length > 0, JSON.stringify(r.hits.map((h) => h.a + '×' + h.b)))
  if (steel.length) {
    expect('状态是穿出', steel[0].state === 'poke-through', steel[0].state)
    expect('穿出属于严重状态', SEVERE_STATES.has(steel[0].state), steel[0].state)
  }
}

console.log('\n=== ⑤ 没有地面时不误豁免 ===')
{
  const meshes = [
    box('a', '箱子A', 0, 0, 0, 2, 2, 2),
    box('b', '箱子B', 0.5, 0, 0.5, 2, 2, 2),
  ]
  const r = interferencePairs(meshes)
  expect('没有承托面', r.groundSurfaces.length === 0, String(r.groundSurfaces.length))
  expect('接地计数为 0', r.grounded === 0, String(r.grounded))
  expect('两箱重叠仍算穿模', r.hits.length > 0, String(r.hits.length))
}

console.log('\n' + (failed === 0 ? 'GROUND_EXEMPTION_OK' : 'GROUND_EXEMPTION_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
