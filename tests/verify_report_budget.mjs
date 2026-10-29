/**
 * 建模测试 35 暴露的两个问题的回归：
 *   ① 地面层组的五视图必然空图 → 改成「顶视+斜视、不隔离」，且只要求 2 张
 *   ② model_loop 单次返回 36 万字符（31 只有 4.5 万）→ 结构化负载必须截断
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isGroundLikeGroup, limitDeep, fitPayload } from '../lib/tools.mjs'

console.log('=== 1. 地面层识别 ===')
/* 35 的街道环境：140m 见方、几米高 */
assert.equal(isGroundLikeGroup([140, 140, 5]), true, '140×140×5 是地面层')
assert.equal(isGroundLikeGroup([40, 40, 1]), true, '40×40×1 广场是地面层')
/* 普通建筑不能被误判 */
assert.equal(isGroundLikeGroup([20, 20, 30]), false, '20×20×30 是建筑')
assert.equal(isGroundLikeGroup([12, 12, 12]), false, '立方体不是地面')
/* 单块小薄板也不是（跨度不到 12） */
assert.equal(isGroundLikeGroup([2, 2, 0.1]), false, '小薄板不当地面层')
assert.equal(isGroundLikeGroup([0, 0, 0]), false, '空尺寸不炸')
assert.equal(isGroundLikeGroup(null), false, 'null 不炸')
console.log('  ✓ 地面层判定不误伤建筑与小件')

console.log('\n=== 2. 结构化负载截断 ===')
{
  /* 造一个 35 那样的层级：963 个 mesh */
  const big = {
    groups: ['街道环境_Street', '便利店'],
    items: Array.from({ length: 963 }, (_, i) => ({
      name: 'MESH_' + i,
      parts: Array.from({ length: 6 }, (_, j) => 'part_' + i + '_' + j),
      note: 'x'.repeat(400),
    })),
  }
  const before = JSON.stringify(big).length
  const after = JSON.stringify(limitDeep(big, { items: 10, str: 100, depth: 5 })).length
  console.log('  ' + before + ' → ' + after + ' 字符（压缩 ' + Math.round(after / before * 100) + '%）')
  assert.ok(after < before / 3, '至少要压到 1/3 以下')

  const small = limitDeep(big, { items: 10, str: 100, depth: 5 })
  assert.ok(Array.isArray(small.items), '必须保留数组形状')
  assert.equal(small.items.length, 11, '10 条 + 1 条省略标记')
  assert.equal(small.items[10].omitted, 953, '省略条数要准确')
  assert.ok(/model_loop\(target=组名\)/.test(small.items[10].note), '要告诉模型去哪查细节')
  assert.equal(small.groups.length, 2, '短数组不该被动')

  /* 深字符串截断 */
  const s = limitDeep({ t: 'y'.repeat(1000) }, { items: 10, str: 50, depth: 5 })
  assert.ok(s.t.length <= 51, '字符串要截断')
  /* 标量/空值不炸 */
  assert.equal(limitDeep(null), null)
  assert.equal(limitDeep(42), 42)
}
console.log('  ✓ 大对象压缩到 1/3 以下、形状与计数保留')


console.log('\n=== 2b. 总量预算：按「少量条目 × 长文本」也压得住 ===')
{
  /* 36 的真实形状：5 组，每组内 10 条 internalItems，每条带 300 字 observation；
   * 按条数限流完全不够——条数没超，单条很长。 */
  const mkPair = (i) => ({
    a: 'PART_' + i, b: 'PART_' + (i + 1),
    observation: '穿出，估计深度 0.5，' + 'x'.repeat(260),
    next: '观察两件的接合处和场景中的相对位置，判断是否符合预期连接；', 
  })
  const payload = {
    kind: 'loop', verdict: 'continue', pass: false,
    lines: ['报告正文'],
    hierarchy: { pairs: Array.from({ length: 40 }, (_, i) => ({ groups: ['A', 'B'], contacts: mkPair(i), collisions: mkPair(i) })) },
    groups: Array.from({ length: 5 }, (_, g) => ({ name: 'G' + g, parts: Array.from({ length: 354 }, (_, i) => 'p' + i), internalItems: Array.from({ length: 10 }, (_, i) => mkPair(i)) })),
    interference: { crossGroup: Array.from({ length: 30 }, (_, i) => mkPair(i)) },
    isolation: { items: Array.from({ length: 30 }, (_, i) => mkPair(i)) },
    perMeshImages: [{ object: 'G0', view: 'front' }],
  }
  const before = JSON.stringify(payload).length
  const out = fitPayload(payload)
  const after = JSON.stringify(out).length
  console.log('  ' + before + ' → ' + after + ' 字符（' + Math.round(after / before * 100) + '%）')
  assert.ok(after <= 20000, '必须压到 20K 预算内，实际 ' + after)
  assert.equal(out.kind, 'loop', '关键字段必须保留')
  assert.equal(out.verdict, 'continue')
  assert.ok(Array.isArray(out.lines), '报告正文不能被压')
  assert.ok(out.perMeshImages, 'perMeshImages 必须保留（投影器要附图片）')
}
console.log('  ✓ 18 万级负载压到 2 万以内，关键字段与图片清单完好')
console.log('\n=== 3. 接线：渲染策略与门禁 ===')
{
  const t = readFileSync(new URL('../lib/tools.mjs', import.meta.url), 'utf8')
  assert.match(t, /views: flat \? \['top', 'iso'\] : undefined/, '地面层要改成 top+iso')
  assert.match(t, /hideOthers: !flat/, '地面层不隔离（要保留其它物体作参照）')
  assert.match(t, /const expectedPerGroup = \(g\) => \(isGroundLikeGroup\(g\.dims\) \? 2 : 5\)/,
    '门禁要按组区分期望张数')
  assert.match(t, /地面\/环境层：横向铺开、厚度很薄/, '要说明为什么这类组不是缺图')
  assert.match(t, /hierarchy: limitDeep\(hierarchy/, 'loop 返回的 hierarchy 要截断')
  assert.match(t, /problemCount: each\.problems\.length/, 'perMesh 要保留总数')
  assert.match(t, /partsTotal: g\.parts\.length/, 'groups.parts 要保留总数')
  assert.match(t, /return fitPayload\(value\)/, 'loop 返回值必须过总预算')

  const live = readFileSync(new URL('../lib/adapters/live.mjs', import.meta.url), 'utf8')
  assert.match(live, /hideOthers: opts\.hideOthers !== false/, '底层要支持按组关闭隔离')
}
console.log('  ✓ 渲染策略、门禁、负载截断都已接线')

console.log('\nREPORT_BUDGET_OK')
