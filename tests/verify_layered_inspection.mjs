/** 数学可确定的实体/薄片、连接簇及工具入口回归，不修改活动 Blender。 */
import assert from 'node:assert/strict'
import { makeMesh, interferencePairs, isolatedMeshes, scanTrianglePairs } from '../lib/core/geometry.mjs'
import { groupMeshesIntoItems } from '../lib/core/grouping.mjs'
import { inspectHierarchy } from '../lib/core/hierarchy.mjs'
import { buildTools } from '../lib/tools.mjs'

const faces = [0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7]
function box(id, center, size, group = id) {
  const corners = [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]]
  return makeMesh(id, id, new Float64Array(corners.flatMap(v => v.map((x,k) => center[k]+x*size[k]/2))),
    new Uint32Array(faces), { collections: [group] })
}
function sheet(id, points, group = id) {
  return makeMesh(id, id, new Float64Array(points.flat()), new Uint32Array([0,1,2,0,2,3]), { collections: [group] })
}
const strict = { ignoreGround: false, contactGap: 1e-7, gapRatio: 0 }
const inspect = meshes => {
  const pairScans = new Map()
  const inter = interferencePairs(meshes, { ignoreGround: false, pairScans })
  const iso = isolatedMeshes(meshes, { ...strict, pairScans })
  return { inter, iso, hierarchy: inspectHierarchy(meshes, groupMeshesIntoItems(meshes), inter, iso) }
}

// 面中部横穿：顶点不在接合位置、零厚度，不能再被深度阈值过滤。
const belt = sheet('传动带', [[-8,-1,0],[8,-1,0],[8,1,0],[-8,1,0]], '传动')
const wheel = sheet('轮面', [[0.13,-3,-3],[0.13,3,-3],[0.13,3,3],[0.13,-3,3]], '传动')
const beltResult = inspect([belt, wheel])
assert.equal(beltResult.iso.hits.length, 0)
assert.equal(beltResult.iso.reused, 1, '两层复用穿模扫描的面接触证据')
assert.equal(beltResult.inter.hits.length, 1)
assert.equal(beltResult.inter.hits[0].surfaceCrossing, true)
assert.ok(beltResult.inter.hits[0].witness)
const flat = sheet('平片', [[-2,-2,0],[2,-2,0],[2,2,0],[-2,2,0]])
const diagonal = sheet('沿剖分边穿片', [[-2,-2,-2],[2,2,-2],[2,2,2],[-2,-2,2]])
assert.equal(inspect([flat,diagonal]).inter.hits.length, 1, '交线与三角剖分边重合也必须发现横穿')
const touchingEdge = sheet('只贴边', [[2,-2,-2],[2,2,-2],[2,2,2],[2,-2,2]])
assert.equal(inspect([flat,touchingEdge]).inter.hits.length, 0, '贴着薄片外边缘不等于穿入')

// 几公里长的薄构件在局部横穿，不能按整件对角线比例忽略。
const longA = box('长板', [0,0,0], [2000,2,0.01])
const longB = box('长杆', [0.13,0,0], [0.02,2000,0.02])
const thin = inspect([longA, longB]).inter
assert.equal(thin.hits.length, 1)
assert.equal(thin.hits[0].belowDepthThreshold, true)

// 反法线不改变真实封闭实体包含，真正有间隔的空腔也不能凭包围盒算接触。
const outer = box('外体', [0,0,0], [4,4,4])
outer.indices = new Uint32Array(Array.from(outer.indices).reverse())
const inner = box('内体', [0,0,0], [0.3,0.3,0.3])
assert.equal(inspect([outer, inner]).inter.hits[0].containment, true)
assert.equal(inspect([outer, inner]).iso.hits.length, 2, '有实体包含不等于表面已贴合')
const cage = [box('左边', [-2,0,0], [0.1,5,0.1]), box('右边', [2,0,0], [0.1,5,0.1])]
const cagePositions = cage.flatMap(m => Array.from(m.positions))
const cageMesh = makeMesh('框架', '框架', new Float64Array(cagePositions),
  new Uint32Array([...cage[0].indices, ...Array.from(cage[1].indices, i => i+8)]))
assert.equal(inspect([cageMesh, inner]).iso.hits.length, 2)
assert.equal(inspect([cageMesh, inner]).inter.hits.length, 0)

// 三角边内部接近，双方顶点都很远：真实边边距离仍可证明在容差内。
const edgeA = sheet('横带', [[-4,-0.1,0],[4,-0.1,0],[4,0.1,0],[-4,0.1,0]])
const edgeB = sheet('竖带', [[-0.1,-4,0.002],[0.1,-4,0.002],[0.1,4,0.002],[-0.1,4,0.002]])
assert.equal(isolatedMeshes([edgeA,edgeB], { contactGap: 0.003, gapRatio: 0 }).hits.length, 0)
assert.equal(isolatedMeshes([edgeA,edgeB], { contactGap: 0.001, gapRatio: 0 }).hits.length, 2)

// 旋转后的贴合面不能因为包围盒三轴重叠就报穿透。
const rotate = m => makeMesh(m.id, m.part, new Float64Array(Array.from({length:m.vertices}, (_,i) => {
  const [x,y,z] = m.positions.slice(i*3, i*3+3)
  return [x*0.8-y*0.6, x*0.6+y*0.8, z]
}).flat()), m.indices, m.meta)
assert.equal(inspect([rotate(box('贴合A',[0,0,0],[1,1,1])), rotate(box('贴合B',[1,0,0],[1,1,1]))]).inter.hits.length, 0)

// 整组浮空：组内零件互相接触，全球逐零件孤立检测不会报，组间图必须显示。
const base = box('地座', [0,0,0], [8,8,1], '地座')
const a = box('浮组_甲', [0,0,5], [1,1,1], '浮组')
const b = box('浮组_乙', [1,0,5], [1,1,1], '浮组')
let r = inspect([base,a,b])
assert.equal(r.iso.hits.some(h => h.id === a.id || h.id === b.id), false)
assert.equal(r.hierarchy.global.isolation.componentCount, 2)
assert.equal(r.hierarchy.internal.find(g => g.name === '浮组').isolation.componentCount, 1)

// 组内部两个彼此分离的连通小团，且其中一件仅接触外组，仍应报告组内断连。
const c = box('浮组_丙', [4,0,5], [1,1,1], '浮组')
const d = box('浮组_丁', [5,0,5], [1,1,1], '浮组')
const outside = box('邻组', [6,0,5], [1,1,1], '邻组')
r = inspect([base,a,b,c,d,outside])
const own = r.hierarchy.internal.find(g => g.name === '浮组')
assert.equal(own.isolation.componentCount, 2)
assert.ok(own.isolation.components.some(c => c.externalContacts.includes('邻组')))
assert.equal(own.collisions.count, 0)

// 同一批网格内同时存在组间和组内穿透，结果不丢任一层。
const colliders = [box('主件',[0,0,0],[2,2,2],'甲组'), box('配件',[0.3,0,0],[0.6,3,0.4],'甲组'),
  box('外件',[0,0.3,0],[3,0.4,0.6],'乙组')]
const two = inspect(colliders).hierarchy
assert.ok(two.global.pairs.some(p => p.collisions.count > 0))
assert.ok(two.internal.find(g => g.name === '甲组').collisions.count > 0)

// 工作预算耗尽时不得把未知当孤立，也不得声称全部已接触。
const unknown = isolatedMeshes([belt,wheel], { ...strict, maxTriangleWork: 0 })
assert.equal(unknown.complete, false)
assert.equal(unknown.hits.length, 0)
assert.equal(unknown.unknownPairs.length, 1)
const unknownReport = inspectHierarchy([belt,wheel], groupMeshesIntoItems([belt,wheel]), { hits: [], complete: true }, unknown)
assert.equal(unknownReport.internal[0].isolation.components[0].status, 'unknown')
const crowded = Array.from({length:50}, (_, i) => box('重叠件'+i,[0,0,0],[1,1,1]))
const limited = isolatedMeshes(crowded, { ...strict, maxTriangleWork: 0 })
assert.equal(limited.unknownPairCount, 1225)
assert.equal(limited.unknownPairs.length, 1000, '预算耗尽时也限制未知样本占用')
assert.equal(limited.unknownOmitted, 225)
assert.equal(limited.hits.length, 0)
const limitedHierarchy = inspectHierarchy(crowded, groupMeshesIntoItems(crowded), {hits:[],complete:true}, limited)
assert.ok(limitedHierarchy.global.isolation.components.every(c=>c.status==='unknown'))
const partial = inspectHierarchy([base,a,b], groupMeshesIntoItems([base,a,b]), r.inter, r.iso, { extractionSkipped: 1 })
assert.equal(partial.complete, false)

// 被识别为地面仍保留实际接触；严重下沉不能一律豁免。
const floor = sheet('地面', [[-30,-30,0],[30,-30,0],[30,30,0],[-30,30,0]])
const planted = Array.from({length:7}, (_,i) => box('柱'+i, [i*3-9,2,0.9],[0.5,0.5,2]))
const sunken = box('下沉箱', [0,-3,-0.5], [2,2,2])
const ground = interferencePairs([floor,...planted,sunken])
assert.ok(ground.grounded > 0)
assert.ok(ground.groundContacts[0].witness)
assert.ok(ground.hits.some(h => h.aId === sunken.id || h.bId === sunken.id))

// 从两个真实工具入口检查报告、局部范围保留组外邻居和缺失抽取。
let currentMeshes = colliders, skipped = []
const tools = buildTools({
  sourceFor: () => ({ describe: () => 'fixture', resolve: async () => 'file',
    extract: async () => ({meshes:currentMeshes, skipped}), renderShots: async () => ({shots:[]}) }),
  config: () => ({minDepth:0.0005,minRatio:0.005}), hostCtx: {get:()=>undefined},
})
const call = (name,args) => tools.find(t=>t.name===name).execute(args,{})
for (const name of ['model_loop','model_isolation']) {
  const result = await call(name, { quick_check:true, verdict:'continue', next_improvement:'核对两层', scope:undefined })
  assert.ok(result.hierarchy.global.pairs.some(p=>p.collisions.count>0), name)
  assert.ok(result.hierarchy.internal.find(g=>g.name==='甲组').collisions.count>0, name)
  assert.match(result.lines.join('\n'), /两层检测/)
}
currentMeshes = [a,b]
const scoped = await call('model_isolation',{scope:[a.id]})
assert.equal(scoped.hits, 0, '只查询一个部件也保留邻接对象作为证据')
skipped = [{id:'遗漏件',why:'预算'}]
assert.equal((await call('model_isolation',{})).complete, false)
currentMeshes = [edgeA,edgeB]; skipped = []
const capped = await call('model_loop',{quick_check:true, contact_work_budget:0, verdict:'done', stop_reason:'试签收'})
assert.equal(capped.stopped, false)
assert.equal(capped.isolation.complete, false)
assert.match(capped.stopBlockers.join('\n'), /接触检测/)
console.log('LAYERED_INSPECTION_OK')
