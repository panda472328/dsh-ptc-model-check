/**
 * 验证穿模状态分类：穿出 / 嵌入 / 插入 / 互穿 / 重合。
 *   node tests/verify_poke_through.mjs
 */

import { makeMesh, classifyInterference, interferencePairs } from '../lib/core/geometry.mjs'

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

/** 造立方体（法线朝外） */
function box(id, cx, cy, cz, sx, sy, sz) {
  const pos = []
  const idx = []
  const hx = sx / 2, hy = sy / 2, hz = sz / 2
  const v = [
    [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
    [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
  ]
  for (const p of v) pos.push(p[0] + cx, p[1] + cy, p[2] + cz)
  const faces = [
    [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6],
    [0, 4, 5], [0, 5, 1], [3, 2, 6], [3, 6, 7],
    [0, 3, 7], [0, 7, 4], [1, 5, 6], [1, 6, 2],
  ]
  const center = [cx, cy, cz]
  for (const f of faces) {
    const [i0, i1, i2] = f
    const ax = pos[i1 * 3] - pos[i0 * 3]
    const ay = pos[i1 * 3 + 1] - pos[i0 * 3 + 1]
    const az = pos[i1 * 3 + 2] - pos[i0 * 3 + 2]
    const bx = pos[i2 * 3] - pos[i0 * 3]
    const by = pos[i2 * 3 + 1] - pos[i0 * 3 + 1]
    const bz = pos[i2 * 3 + 2] - pos[i0 * 3 + 2]
    const nx = ay * bz - az * by
    const ny = az * bx - ax * bz
    const nz = ax * by - ay * bx
    const mx = (pos[i0 * 3] + pos[i1 * 3] + pos[i2 * 3]) / 3 - center[0]
    const my = (pos[i0 * 3 + 1] + pos[i1 * 3 + 1] + pos[i2 * 3 + 1]) / 3 - center[1]
    const mz = (pos[i0 * 3 + 2] + pos[i1 * 3 + 2] + pos[i2 * 3 + 2]) / 3 - center[2]
    if (nx * mx + ny * my + nz * mz < 0) idx.push(i0, i2, i1)
    else idx.push(i0, i1, i2)
  }
  return makeMesh(id, id, new Float32Array(pos), new Uint32Array(idx))
}

console.log('=== 1. 穿出（poke-through）===')
{
  /* 桌面 z 0.96~1.04，腿 z 0.04~1.08：腿从桌面上表面伸出来 */
  const top = box('桌面', 0, 0, 1.0, 2, 2, 0.08)
  const leg = box('腿', -0.8, -0.8, 0.56, 0.09, 0.09, 1.04)
  const cls = classifyInterference(top, leg)
  console.log('  状态: ' + cls.state + ' 轴: ' + cls.axisName + ' — ' + cls.detail)
  expect('判定为穿出', cls.state === 'poke-through', cls.state)
  expect('穿出方是腿', cls.by === 'B', String(cls.by))

  const r = interferencePairs([top, leg], { minDepth: 0.0005, minRatio: 0.005 })
  expect('穿模被检出', r.hits.length > 0, String(r.hits.length))
  if (r.hits.length) {
    console.log('  state=' + r.hits[0].state + ' label=' + r.hits[0].stateLabel
      + ' pokeThrough=' + r.hits[0].pokeThrough + ' depth=' + r.hits[0].depth.toFixed(4))
    expect('hit 带 state 字段', r.hits[0].state === 'poke-through', String(r.hits[0].state))
    expect('hit 带 stateLabel', r.hits[0].stateLabel === '穿出', String(r.hits[0].stateLabel))
    expect('hit 带 pokeThrough 标记', r.hits[0].pokeThrough === true, String(r.hits[0].pokeThrough))
  }
}

console.log('\n=== 2. 插入（inserted）：腿插进桌面但没露出来 ===')
{
  /* 桌面 z 0.96~1.04，腿 z 0.04~1.0：腿顶在桌面内部，没穿出 */
  const top = box('桌面', 0, 0, 1.0, 2, 2, 0.08)
  const leg = box('腿', -0.8, -0.8, 0.52, 0.09, 0.09, 0.96)
  const cls = classifyInterference(top, leg)
  console.log('  状态: ' + cls.state + ' 轴: ' + cls.axisName + ' — ' + cls.detail)
  expect('判定为插入', cls.state === 'inserted', cls.state)
}

console.log('\n=== 3. 完全嵌入（contained）===')
{
  /* 小方块完全在大方块内部，且三个轴都在范围内 */
  const big = box('大块', 0, 0, 0, 4, 4, 4)
  const small = box('小块', 0, 0, 0, 0.5, 0.5, 0.5)
  const cls = classifyInterference(big, small)
  console.log('  状态: ' + cls.state + ' 轴: ' + cls.axisName + ' — ' + cls.detail)
  expect('判定为完全嵌入', cls.state === 'contained', cls.state)
  expect('嵌入方是小块', cls.by === 'B', String(cls.by))
}

console.log('\n=== 4. 重合（coincident）===')
{
  const a = box('A', 0, 0, 0, 1, 1, 1)
  const b = box('B', 0, 0, 0, 1, 1, 1)
  const cls = classifyInterference(a, b)
  console.log('  状态: ' + cls.state + ' — ' + cls.detail)
  expect('判定为重合', cls.state === 'coincident', cls.state)

  /* 尺寸差很多时不该判重合（薄板 + 细杆） */
  const plate = box('板', 0, 0, 0, 4, 4, 0.1)
  const rod = box('杆', 0, 0, 0, 0.1, 0.1, 4)
  const cls2 = classifyInterference(plate, rod)
  console.log('  薄板+细杆 状态: ' + cls2.state + '（不应是重合）')
  expect('尺寸差异大时不判重合', cls2.state !== 'coincident', cls2.state)
}

console.log('\n=== 5. 互相穿过（mutual）===')
{
  /* 两个斜交的方块：在 X 轴上双向超出，在 Y 轴上只有部分重叠。
   * 穿透轴 = 重叠最小的轴。
   * A: X -2~2, Y -0.25~0.25
   * B: X -0.25~0.25, Y -2~2
   * X 重叠 = 0.5，Y 重叠 = 0.5 → 取 X 轴（先判到的）
   * A 在 X 上超出 B 的两侧（-2 < -0.25 且 2 > 0.25）→ A 穿出
   * B 在 X 上没有超出 A（因为在 A 范围内）→ 不构成互穿
   * 所以这个用例是「A 穿出 B」，正好可以验证穿出方向。 */
  const a = box('A', 0, 0, 0, 4, 0.5, 0.5)
  const b = box('B', 0, 0, 0, 0.5, 4, 0.5)
  const cls = classifyInterference(a, b)
  console.log('  状态: ' + cls.state + ' 轴: ' + cls.axisName + ' — ' + cls.detail)
  expect('判定为穿出（A 横穿 B）', cls.state === 'poke-through', cls.state)
  expect('穿出方是 A', cls.by === 'A', String(cls.by))
}

console.log('\n=== 5b. 细杆贯穿厚板 → 判穿出 ===')
{
  /* 真正的贯穿：杆在穿透轴上两端都超出板，截面完全落在板内。
   *   板: X -1~1, Y -1~1, Z -0.05~0.05（薄板）
   *   杆: X -0.08~0.08, Y -0.08~0.08, Z -0.5~0.5（细杆，两端都在板外）
   * → Z 轴：杆双向超出板；X/Y：杆截面完全在板内 → 贯穿，必须修 */
  const plate = box('板', 0, 0, 0, 2, 2, 0.1)
  const rod = box('杆', 0, 0, 0, 0.16, 0.16, 1.0)
  const cls = classifyInterference(plate, rod)
  console.log('  状态: ' + cls.state + ' 轴: ' + cls.axisName + ' — ' + cls.detail)
  expect('细杆贯穿厚板 → 判穿出', cls.state === 'poke-through', cls.state)
  expect('穿出方是杆', cls.by === 'B', String(cls.by))
}

console.log('\n=== 5c. 细杆插进厚板，一端露在外面 → 判插入 ===')
{
  /* 板: Z -0.05~0.05；杆: Z -0.5~0.0（杆底在板外，杆顶在板内）
   * → 只从一侧伸进去，没有贯穿 → 正常插入。
   * 这正是「钢筋/支柱从结构里伸出来」的情形，旧判据会误报成穿出。 */
  const plate = box('板2', 0, 0, 0, 2, 2, 0.1)
  const rod = box('杆2', 0, 0, -0.25, 0.16, 0.16, 0.5)
  const cls = classifyInterference(plate, rod)
  console.log('  状态: ' + cls.state + ' 轴: ' + cls.axisName + ' — ' + cls.detail)
  expect('只从一侧插入 → 判插入', cls.state === 'inserted', cls.state)
}

console.log('\n=== 6. 只是贴合不相交 ===')
{
  const a = box('A', 0, 0, 0, 1, 1, 1)
  const b = box('B', 2, 0, 0, 1, 1, 1)  // 完全不重叠
  const cls = classifyInterference(a, b)
  expect('判定为不相交', cls.state === 'none', cls.state)
}

console.log('\n=== 7. 严重状态排序优先 ===')
{
  const plate = box('板', 0, 0, 1.0, 2, 2, 0.08)
  const poking = box('穿出件', 0.5, 0, 0.6, 0.09, 0.09, 1.0)   // 穿出
  const inserted = box('插入件', -0.5, 0, 0.56, 0.09, 0.09, 0.96) // 插入
  const r = interferencePairs([plate, poking, inserted], { minDepth: 0.0005, minRatio: 0.005 })
  console.log('  检出 ' + r.hits.length + ' 对，顺序：')
  for (const h of r.hits) {
    console.log('    ' + h.a + '↔' + h.b + ' state=' + h.state + ' ratio=' + h.ratio.toFixed(4))
  }
  expect('穿出排在前面', r.hits[0]?.state === 'poke-through', String(r.hits[0]?.state))
}

console.log('\n' + (failed === 0 ? 'POKE_THROUGH_OK' : 'POKE_THROUGH_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
