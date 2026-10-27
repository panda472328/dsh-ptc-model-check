/**
 * 场景取景回归测试。
 *
 * 背景（真机实测，不是推演）：
 *   建模测试27 的场景 AURORA-9 空间站里，主体 RING_DETAIL / CORE_MAST 约 71~79 单位、
 *   中心在原点；而两个环境球 ENV_ATMO / ENV_EARTH 是 425~462 单位、中心在
 *   [3167, 4091, 4095]（约 6500 单位外）。
 *   整场景取景以环境球为准 → 空间站被压成亚像素 → look 返回一整张背景灰。
 *   指定 focus 后三视角立刻正常。
 *
 * 这个测试守住两件事：
 *   ① 有环境命名时按名字排除；命名认不出时按统计离群排除；
 *   ② 安全阀：剔除比例过大时**放弃剔除**，宁可可能出空图也不能把主体剔掉。
 *
 * 不连接 Blender：夹具是内存里的立方体。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pickFramingFocus, isEnvName } from '../lib/core/framing.mjs'
import { makeMesh } from '../lib/core/geometry.mjs'

/** 造一个位于 center、边长 size 的立方体 mesh（与生产同一套 makeMesh 结构） */
function box(id, center, size, collections = []) {
  const h = size / 2
  const pos = []
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        pos.push(center[0] + sx * h, center[1] + sy * h, center[2] + sz * h)
      }
    }
  }
  const idx = [0, 2, 1, 1, 2, 3, 4, 6, 5, 5, 6, 7, 0, 4, 1, 1, 4, 5, 2, 6, 3, 3, 6, 7, 0, 2, 4, 4, 2, 6, 1, 3, 5, 5, 3, 7]
  const m = makeMesh(id, id, new Float64Array(pos), new Uint32Array(idx))
  m.meta = { collections }
  return m
}

console.log('=== 1. 环境名识别 ===')
for (const n of ['ENV_ROOT', 'ENVIRONMENT', 'BG_SKY', 'ENV_ATMO', 'ENV_EARTH', 'Sky', '地面', '环境层']) {
  assert.equal(isEnvName(n), true, '应判为环境：' + n)
}
for (const n of ['STATION', 'RING_MAIN', 'CORE', 'SOLAR_WINGS', 'SPACE_STATION', 'TOWER', 'DETAIL_SET']) {
  assert.equal(isEnvName(n), false, '不应判为环境：' + n)
}
console.log('  ✓ 环境词命中，且不误伤 SPACE_STATION / STATION 之类')

console.log('\n=== 2. 真实场景形状：按集合名排除（collection 模式） ===')
{
  /* 用实测数字：主体在原点约 72 单位；环境球 437/425 单位、中心在 6500 外 */
  const meshes = [
    box('CORE_MAST', [0, 0, -0.7], 78.6, ['CORE']),
    box('RING_DETAIL', [0, 0, 0.1], 71.4, ['RING_MAIN']),
    box('SOLAR_WINGS', [0.4, 0, -23.4], 137.8, ['SOLAR']),
    box('ENV_ATMO', [3167, 4091, 4095], 437, ['ENV_ROOT']),
    box('ENV_EARTH', [3167, 4091, 4095], 425, ['ENV_ROOT']),
  ]
  const f = pickFramingFocus(meshes)
  assert.equal(f.mode, 'collection', '有 ENV_ROOT 时应走命名识别')
  assert.deepEqual(f.excluded.sort(), ['ENV_ATMO', 'ENV_EARTH'])
  assert.equal(f.names.length, 3)
  assert.ok(!f.names.includes('ENV_ATMO'))
  console.log('  ✓ 排除 ' + f.excluded.join('、') + '，保留 ' + f.names.length + ' 个主体对象')
}

console.log('\n=== 3. 命名认不出时：统计离群（outlier 模式） ===')
{
  /* 故意把环境物命名成无害的 SPHERE_A / SPHERE_B —— 名字认不出，只能靠几何 */
  const meshes = [
    box('CORE_MAST', [0, 0, -0.7], 78.6, ['CORE']),
    box('RING_DETAIL', [0, 0, 0.1], 71.4, ['RING_MAIN']),
    box('RING_SUB', [0, 0, 20], 32, ['RING_SUB']),
    box('SPHERE_A', [3167, 4091, 4095], 437, ['MISC']),
    box('SPHERE_B', [3167, 4091, 4095], 425, ['MISC']),
  ]
  const f = pickFramingFocus(meshes)
  assert.equal(f.mode, 'outlier', '名字认不出时应回退统计')
  assert.deepEqual(f.excluded.sort(), ['SPHERE_A', 'SPHERE_B'])
  assert.equal(f.names.length, 3)
  console.log('  ✓ 统计剔除 ' + f.excluded.join('、'))
}

console.log('\n=== 4. 统计模式：离群过半时不猜 ===')
{
  /* 一半对象在 5000 单位外。中位数会被这半拉走，阈值随之失真——
   * 正确的行为是**放弃剔除**，而不是乱框几个对象。
   * （命名模式没有这个限制：显式命名是意图，不是推断。） */
  const meshes = [
    box('A', [0, 0, 0], 10, ['MAIN']),
    box('B', [12, 0, 0], 10, ['MAIN']),
    box('FAR_1', [5000, 0, 0], 10, ['MISC']),
    box('FAR_2', [-5000, 0, 0], 10, ['MISC']),
  ]
  const f = pickFramingFocus(meshes)
  assert.equal(f.mode, 'all', '离群过半时应放弃剔除')
  assert.equal(f.names.length, 4, '放弃剔除时必须保留全部对象')
  assert.equal(f.dropped, 0)
  console.log('  ✓ 50% 离群 → 回退全部（' + f.reason + '）')
}

console.log('\n=== 4b. 全是环境物时不许剔空 ===')
{
  /* 3 个对象全在环境集合里：命名模式留下 0 个主体 → 不该生效，
   * 统计模式也凑不出离群，最终应回退成「全部参与取景」。 */
  const meshes = [
    box('E1', [0, 0, 0], 10, ['ENV_ROOT']),
    box('E2', [0, 0, 0], 10, ['ENV_ROOT']),
    box('E3', [0, 0, 0], 10, ['ENV_ROOT']),
  ]
  const f = pickFramingFocus(meshes)
  assert.notEqual(f.mode, 'collection', '不能把主体剔空')
  assert.equal(f.names.length, 3, '必须保留对象')
  console.log('  ✓ 全环境 → 保留全部（mode=' + f.mode + '）')
}

console.log('\n=== 5. 正常场景不受影响 ===')
{
  const meshes = [
    box('CORE_MAST', [0, 0, 0], 78.6, ['CORE']),
    box('RING_DETAIL', [0, 0, 0], 71.4, ['RING_MAIN']),
    box('TOWER', [0, 0, 60], 40, ['TOWER']),
  ]
  const f = pickFramingFocus(meshes)
  assert.equal(f.mode, 'all', '没有环境物时不该剔除任何东西')
  assert.equal(f.names.length, 3)
  const single = pickFramingFocus([box('ONLY', [0, 0, 0], 10)])
  assert.equal(single.mode, 'all')
  assert.equal(pickFramingFocus([]).names.length, 0)
  console.log('  ✓ 无环境物 / 单对象 / 空场景都不误剔')
}

console.log('\n=== 6. 取景参数真的接到了场景级渲染上 ===')
{
  const src = readFileSync(new URL('../lib/tools.mjs', import.meta.url), 'utf8')
  /* 场景五视图（model_loop）与整场景视图（model_review）都必须传 focus。 */
  assert.match(src, /const framing = target \? null : pickFramingFocus\(allMeshes\)/)
  assert.match(src, /focus: framing && framing\.mode !== 'all' \? framing\.names : undefined/)
  assert.match(src, /const sceneFraming = pickFramingFocus\(allMeshes\)/)
  assert.match(src, /focus: sceneFraming\.mode !== 'all' \? sceneFraming\.names : undefined/)
  /* 排除说明必须进报告，否则模型会以为环境没做 */
  assert.match(src, /取景只框主体/)
  assert.match(src, /它们\*\*仍在画面里\*\*|它们仍在画面里/)
  const adapter = readFileSync(new URL('../lib/adapters/index.mjs', import.meta.url), 'utf8')
  assert.match(adapter, /renderOpts\.focus/, 'renderShots 必须把 focus 转发给 renderLive')
  console.log('  ✓ 两个场景级调用点都传了 focus，renderShots 会转发，报告有说明')
}

console.log('\nFRAMING_FOCUS_OK')
