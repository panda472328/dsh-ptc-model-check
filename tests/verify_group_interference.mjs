/**
 * 验证分组穿模：组内 vs 组间语义不同。
 *   node tests/verify_group_interference.mjs
 */

import { makeMesh } from '../lib/core/geometry.mjs'
import { groupMeshesIntoItems, analyzeGroupInterference } from '../lib/core/grouping.mjs'
import { buildTools } from '../lib/tools.mjs'

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

/** 造一个指定位置和尺寸的立方体（法线保证朝外） */
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
    [0, 1, 2], [0, 2, 3],
    [4, 6, 5], [4, 7, 6],
    [0, 4, 5], [0, 5, 1],
    [3, 2, 6], [3, 6, 7],
    [0, 3, 7], [0, 7, 4],
    [1, 5, 6], [1, 6, 2],
  ]
  /* 逐面校验朝向：法线必须背离立方体中心，否则翻转绕序。
   * 手写绕序很容易出错，而出错会让「点是否在内部」的判定全反。 */
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
    if (nx * mx + ny * my + nz * mz < 0) {
      idx.push(i0, i2, i1)   // 翻转
    } else {
      idx.push(i0, i1, i2)
    }
  }
  return makeMesh(id, id, new Float32Array(pos), new Uint32Array(idx))
}

function fakeSource(meshes) {
  return {
    describe: () => 'fake',
    async resolve() { return 'blender' },
    async info() { return { meshes: meshes.length } },
    async extract() {
      /* 测试用：给 mesh 补上 collections 元数据，
       * 模拟「已经在 Blender 里建好物品组」的状态——
       * 否则新规则会判分组不可靠，pass 永远是 false。 */
      const withColl = meshes.map((m) => {
        const name = String(m.part || m.id)
        const mm = name.match(/^(.+?)[_\-.|:/\\ ]/)
        const g = mm && mm[1] ? mm[1] : name
        return { ...m, meta: { ...(m.meta || {}), collections: [g] } }
      })
      return { meshes: withColl, skipped: [], source: 'fake' }
    },
    async namingScan() { return { totalMeshes: meshes.length, named: meshes.length, generic: 0, duplicates: [] } },
    async renderShots(shots) { return shots.map((s) => ({ ...s, path: null, why: 'fake' })) },
    async dispose() {},
  }
}

console.log('=== 场景 A：只有组内插接（腿插进桌面）→ 应通过 ===')
{
  const meshes = [
    box('桌_桌面', 0, 0, 1.0, 2, 2, 0.06),   // 薄板 0.97~1.03
    box('桌_腿1', -0.8, -0.8, 0.725, 0.08, 0.08, 0.55), // 0.45~1.0，顶藏在板内
    box('桌_腿2', 0.8, 0.8, 0.725, 0.08, 0.08, 0.55),
  ]
  const groups = groupMeshesIntoItems(meshes)
  console.log('  分组: ' + groups.map((g) => g.name + '(' + g.parts.length + ')').join(', '))

  const cfg = { maxObjects: 500, maxTriangles: 100000, minDepth: 0.0005, minRatio: 0.005 }
  const tools = buildTools({
    sourceFor: () => fakeSource(meshes),
    config: () => cfg,
    remember: () => {},
    hostCtx: { get: () => undefined },
    getRefState: () => ({ given: false, analyzed: false }),
    markRefAnalyzed: () => {},
    getPhaseState: () => ({ modelingComplete: false }),
    markModelingComplete: () => {},
    resetPhase: () => {},
  })
  const t = tools.find((x) => x.name === 'model_loop')
  const v = await t.execute(
    { reset: true, verdict: 'continue', next_improvement: 'X', per_mesh_views: false },
    { signal: new AbortController().signal },
  )
  const blocks = t.output.render({}, v)
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')

  console.log('  组内 ' + v.interference.internalCount + ' 对，组间 ' + v.interference.crossCount + ' 对')
  expect('检出组内插接', v.interference.internalCount > 0, String(v.interference.internalCount))
  expect('组间穿模为 0', v.interference.crossCount === 0, String(v.interference.crossCount))
  expect('组内插接不阻止通过', v.pass === true, 'pass=' + v.pass + ' blockers=' + JSON.stringify(v.stopBlockers))
  expect('文案区分插入和穿出', /插入\*\*（没露出来）：通常合理/.test(text), text.slice(0, 900))
  expect('组内几何状态先核实，不把特效和有意装配直接判错',
    /几何状态不证明设计错误/.test(text) && !/穿出 \/ 互穿 \/ 重合\*\*：必须修/.test(text), text.slice(0, 900))
}

console.log('\n=== 场景 B：组间穿模（椅子插进桌子）→ 必须失败 ===')
{
  const meshes = [
    box('桌_桌面', 0, 0, 1.0, 2, 2, 0.06),
    box('桌_腿1', -0.8, -0.8, 0.725, 0.08, 0.08, 0.55),
    box('椅_座面', 0.5, 0, 1.0, 0.6, 0.6, 0.05),  // 和桌面重叠
  ]
  const cfg = { maxObjects: 500, maxTriangles: 100000, minDepth: 0.0005, minRatio: 0.005 }
  const tools = buildTools({
    sourceFor: () => fakeSource(meshes),
    config: () => cfg,
    remember: () => {},
    hostCtx: { get: () => undefined },
    getRefState: () => ({ given: false, analyzed: false }),
    markRefAnalyzed: () => {},
    getPhaseState: () => ({ modelingComplete: false }),
    markModelingComplete: () => {},
    resetPhase: () => {},
  })
  const t = tools.find((x) => x.name === 'model_loop')
  const v = await t.execute(
    { reset: true, verdict: 'continue', next_improvement: 'X', per_mesh_views: false },
    { signal: new AbortController().signal },
  )
  const blocks = t.output.render({}, v)
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')

  console.log('  组内 ' + v.interference.internalCount + ' 对，组间 ' + v.interference.crossCount + ' 对')
  expect('检出组间穿模', v.interference.crossCount > 0, String(v.interference.crossCount))
  expect('组间穿模导致 pass=false', v.pass === false, 'pass=' + v.pass)
  expect('文案用 ⛔ 标记组间穿模', /⛔ \*\*组间穿模/.test(text), text.slice(0, 600))
  expect('说明必须修', /必须修/.test(text), text.slice(0, 600))
  expect('组间相交必须结合用途判断，保留真实问题与合理特效',
    /非预期的实体穿透或错位时必须修/.test(text)
      && /雾效、火焰和背景交叠可能合理/.test(text)
      && /未解释的命中仍保留/.test(text)
      && !/两个不同物品不能互相插入|不同物品占同一块空间，必须修/.test(text), text.slice(0, 900))
  expect('逐组优先级摘要不能冒充整体验收通过',
    /不等于整体验收通过/.test(text) && !/个干净，/.test(text), text.slice(-1500))

  const cg = v.interference.crossGroup[0]
  expect('组间数据含组名', !!cg.aGroup && !!cg.bGroup,
    JSON.stringify(cg))
}

console.log('\n=== 场景 C：结构化数据含每组的视图完成度 ===')
{
  const meshes = [
    box('椅_座面', 0, 0, 0.5, 0.6, 0.6, 0.05),
    box('椅_靠背', 0, 0.3, 0.8, 0.6, 0.05, 0.5),
  ]
  const cfg = { maxObjects: 500, maxTriangles: 100000, minDepth: 0.0005, minRatio: 0.005 }
  const tools = buildTools({
    sourceFor: () => fakeSource(meshes),
    config: () => cfg,
    remember: () => {},
    hostCtx: { get: () => undefined },
    getRefState: () => ({ given: false, analyzed: false }),
    markRefAnalyzed: () => {},
    getPhaseState: () => ({ modelingComplete: false }),
    markModelingComplete: () => {},
    resetPhase: () => {},
  })
  const t = tools.find((x) => x.name === 'model_loop')
  const v = await t.execute(
    { reset: true, verdict: 'continue', next_improvement: 'X', per_mesh_views: false },
    { signal: new AbortController().signal },
  )
  console.log('  groups: ' + JSON.stringify(v.groups?.map((g) => ({
    name: g.name, parts: g.parts.length, viewsComplete: g.viewsComplete,
  }))))
  expect('返回 groups 数组', Array.isArray(v.groups) && v.groups.length > 0,
    JSON.stringify(v.groups))
  expect('每组含 parts', (v.groups[0]?.parts || []).length > 0, JSON.stringify(v.groups[0]))
  expect('每组含 viewsComplete 标记',
    typeof v.groups[0]?.viewsComplete === 'boolean', String(v.groups[0]?.viewsComplete))
  expect('返回 groupCount', typeof v.groupCount === 'number', String(v.groupCount))
}

console.log('\n' + (failed === 0 ? 'GROUP_INTERFERENCE_OK' : 'GROUP_INTERFERENCE_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
