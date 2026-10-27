/**
 * 穿出状态分类的回归测试。
 *
 * 覆盖五类真实结构，重点区分「正常伸出」和「真贯穿」：
 *   ① 钢筋插进墙墩，一端露在外面   → inserted（正常）
 *   ② 支柱从楼板下往上撑，顶端露出  → inserted（正常）
 *   ③ 瓦砾互相压着                  → inserted（正常）
 *   ④ 杆真的从结构一侧穿到另一侧     → poke-through（必须修）
 *   ⑤ 螺栓从板的一面穿到另一面       → poke-through（必须修）
 *   ⑥ 两个相同物体完全重叠           → coincident（必须修）
 *
 * 背景（实测过的误判，缺陷 3）：
 *   旧判据只看「某轴上包围盒双侧超出」，于是**整类「钢筋/支柱/管道
 *   从结构里伸出来」的正常模型被判成必须修的严重错误**——
 *   而这正是工业、废墟、机械类模型的核心特征。
 */

import { classifyInterference, makeMesh } from '../lib/core/geometry.mjs'

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

/* 圆柱杆：从 z0 到 z1，半径 r，中心在 (x,y) */
function rod(id, part, x, y, z0, z1, r) {
  const pos = [], idx = []
  const n = 8
  for (const z of [z0, z1]) for (let i = 0; i < n; i++) {
    const a = 2 * Math.PI * i / n
    pos.push(x + r * Math.cos(a), y + r * Math.sin(a), z)
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    idx.push(i, j, n + j, i, n + j, n + i)
    idx.push(n + i, n + j, j, n + i, j, i)
  }
  return makeMesh(id, part, new Float32Array(pos), new Uint32Array(idx))
}

/* 长方体：中心 (cx,cy,cz)，尺寸 (sx,sy,sz)。
 * 顶点绕序经过校验，保证法线朝外——否则「点在内部」的判定会全反。 */
function boxM(id, part, cx, cy, cz, sx, sy, sz) {
  const pos = [], idx = []
  const v = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ]
  for (const [a, b, c] of v) pos.push(cx + a * sx / 2, cy + b * sy / 2, cz + c * sz / 2)
  const F = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]
  for (const f of F) idx.push(f[0], f[1], f[2], f[0], f[2], f[3])
  return makeMesh(id, part, new Float32Array(pos), new Uint32Array(idx))
}

console.log('=== ① 钢筋插进墙墩，顶端露在外面 → 应判 inserted ===')
{
  /* 墙 z 0~11.4；杆 z -0.05~1.2（底埋在墙里 5cm，顶端还在墙内 1.2 处）*/
  const wall = boxM('墙', '外墙', 0, 0, 5.7, 3, 3, 11.4)
  const bar = rod('钢筋', '钢筋', 0, 0, -0.05, 1.2, 0.03)
  const c = classifyInterference(wall, bar)
  console.log('  state = ' + c.state + ' | ' + c.detail)
  expect('钢筋插进墙 → 正常插入', c.state === 'inserted', c.state)
}

console.log('\n=== ② 支柱插进楼板，顶端从楼板上面露出来 → 应判 inserted ===')
{
  /* 楼板 z 0~0.2；柱 z -0.1~3.0。柱底在板下、柱顶在板上，
   * 但柱**没有贯穿板**吗？——它在 Z 上两端都超出板（-0.1 < 0 且 3.0 > 0.2），
   * 截面又完全在板内 → 这其实是**贯穿**！
   *
   * 所以真实场景里要区分：
   *   - 柱穿过一整块薄板（两端都露） → 那是真的穿模，必须修
   *   - 柱插进一块厚墙/墩，一端露     → 正常
   *
   * 这里用「柱插进厚墙墩、顶端露在外面」构造正常情形。 */
  const pier = boxM('墙墩', '墙墩', 0, 0, 2.0, 1.0, 1.0, 4.0)   // z 0~4
  const col = rod('支柱', '支柱', 0, 0, 0.5, 5.5, 0.1)          // z 0.5~5.5，顶在墩外
  const c = classifyInterference(pier, col)
  console.log('  state = ' + c.state + ' | ' + c.detail)
  expect('支柱一端露在外面 → 正常插入', c.state === 'inserted', c.state)
}

console.log('\n=== ③ 瓦砾互相压着 → 应判 inserted ===')
{
  const big = boxM('瓦大', '瓦砾', 0, 0, 0.15, 1.0, 1.0, 0.3)
  const sml = boxM('瓦小', '瓦砾', 0.1, 0.1, 0.30, 0.8, 0.8, 0.3)
  const c = classifyInterference(big, sml)
  console.log('  state = ' + c.state + ' | ' + c.detail)
  expect('瓦砾互压 → 正常插入', c.state === 'inserted', c.state)
}

console.log('\n=== ④ 杆真的从厚墙一侧穿到另一侧 → 应判 poke-through ===')
{
  /* 墙 z 0~4；杆 z -0.5~4.5，两端都在墙外，截面完全在墙内 → 真贯穿 */
  const wall = boxM('墙4', '外墙', 0, 0, 2.0, 3, 3, 4.0)
  const bar = rod('穿杆', '杆', 0, 0, -0.5, 4.5, 0.05)
  const c = classifyInterference(wall, bar)
  console.log('  state = ' + c.state + ' | ' + c.detail)
  expect('真贯穿 → 判穿出', c.state === 'poke-through', c.state)
  expect('穿出方是杆', c.by === 'B', String(c.by))
}

console.log('\n=== ⑤ 螺栓从薄板一面穿到另一面 → 应判 poke-through ===')
{
  const plate = boxM('板', '板', 0, 0, 0, 2, 2, 0.1)    // z -0.05~0.05
  const bolt = rod('螺栓', '螺栓', 0, 0, -0.5, 0.5, 0.08) // 两端都露
  const c = classifyInterference(plate, bolt)
  console.log('  state = ' + c.state + ' | ' + c.detail)
  expect('螺栓穿透薄板 → 判穿出', c.state === 'poke-through', c.state)
}

console.log('\n=== ⑥ 两个相同物体完全重叠 → 应判 coincident ===')
{
  const a = boxM('A', 'A', 0, 0, 0, 1, 1, 1)
  const b = boxM('B', 'B', 0, 0, 0, 1, 1, 1)
  const c = classifyInterference(a, b)
  console.log('  state = ' + c.state + ' | ' + c.detail)
  expect('完全重叠 → 判重合', c.state === 'coincident', c.state)
}

console.log('\n=== ⑦ 小方块完全埋在大方块里 → 应判 contained ===')
{
  const big = boxM('大', '大', 0, 0, 0, 4, 4, 4)
  const small = boxM('小', '小', 0, 0, 0, 0.5, 0.5, 0.5)
  const c = classifyInterference(big, small)
  console.log('  state = ' + c.state + ' | ' + c.detail)
  expect('完全嵌入 → 判 contained', c.state === 'contained', c.state)
}

console.log('\n=== ⑧ 不相交 → 应判 none ===')
{
  const a = boxM('A8', 'A', 0, 0, 0, 1, 1, 1)
  const b = boxM('B8', 'B', 5, 0, 0, 1, 1, 1)
  const c = classifyInterference(a, b)
  expect('不相交 → 判 none', c.state === 'none', c.state)
}

console.log('\n' + (failed === 0 ? 'POKE_THROUGH_CASES_OK' : 'POKE_THROUGH_CASES_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
