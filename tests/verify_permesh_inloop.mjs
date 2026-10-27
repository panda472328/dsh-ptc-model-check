/**
 * 验证 model_loop 里的逐 mesh 隔离检查 + 精度一致性。
 *   node tests/verify_permesh_inloop.mjs
 */

import { makeMesh } from '../lib/core/geometry.mjs'
import { buildTools } from '../lib/tools.mjs'

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

/* 造一个假建模源，直接给几何，不依赖 Blender */
function fakeSource(meshes) {
  return {
    describe: () => 'fake',
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
    async shots(shots) {
      return shots.map((s) => ({ ...s, path: null, why: 'fake 源不出图' }))
    },
    async renderShots(shots) {
      /* 假渲染：不出图，只返回结构，让上层能继续跑检测逻辑 */
      return shots.map((s) => ({ ...s, path: null, attached: false, why: 'fake 源不出图' }))
    },
    async dispose() {},
  }
}

function cubeMesh(id, size, segments) {
  const pos = []
  const idx = []
  const s = size / 2
  const faces = [
    { axis: 0, sign: 1 }, { axis: 0, sign: -1 },
    { axis: 1, sign: 1 }, { axis: 1, sign: -1 },
    { axis: 2, sign: 1 }, { axis: 2, sign: -1 },
  ]
  for (const f of faces) {
    const base = pos.length / 3
    for (let i = 0; i <= segments; i++) {
      for (let j = 0; j <= segments; j++) {
        const u = (i / segments) * 2 - 1
        const v = (j / segments) * 2 - 1
        const p = [0, 0, 0]
        p[f.axis] = f.sign * s
        p[(f.axis + 1) % 3] = u * s
        p[(f.axis + 2) % 3] = v * s
        pos.push(p[0], p[1], p[2])
      }
    }
    for (let i = 0; i < segments; i++) {
      for (let j = 0; j < segments; j++) {
        const a = base + i * (segments + 1) + j
        const b = a + 1
        const c = a + (segments + 1)
        const d = c + 1
        idx.push(a, c, b, b, c, d)
      }
    }
  }
  return makeMesh(id, id, new Float32Array(pos), new Uint32Array(idx))
}

/** 造一个带位置偏移的立方体。
 * cubeMesh 只接受 (id, size, segments)，多个同尺寸立方体默认都在原点重合，
 * 那会被判成 coincident（重合）导致检查失败。检查用例需要位置错开。 */
function boxAt(id, cx, cy, cz, size, seg = 4) {
  const m = cubeMesh(id, size, seg)
  const pos = new Float32Array(m.positions.length)
  for (let i = 0; i < m.positions.length; i += 3) {
    pos[i] = m.positions[i] + cx
    pos[i + 1] = m.positions[i + 1] + cy
    pos[i + 2] = m.positions[i + 2] + cz
  }
  return makeMesh(id, id, pos, m.indices)
}

function sphereMesh(id, radius, seg, rings) {
  const pos = []
  const idx = []
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI
    for (let s = 0; s <= seg; s++) {
      const theta = (s / seg) * Math.PI * 2
      pos.push(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.cos(phi),
        radius * Math.sin(phi) * Math.sin(theta),
      )
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < seg; s++) {
      const a = r * (seg + 1) + s
      const b = a + 1
      const c = a + (seg + 1)
      const d = c + 1
      idx.push(a, c, b, b, c, d)
    }
  }
  return makeMesh(id, id, new Float32Array(pos), new Uint32Array(idx))
}

function makeTools(meshes) {
  const cfg = { maxObjects: 5000, maxTriangles: 3000000, minDepth: 0.0005, minRatio: 0.005 }
  return buildTools({
    sourceFor: () => fakeSource(meshes),
    config: () => cfg,
    remember: () => {},
    hostCtx: { get: () => undefined },
    getRefState: () => ({ given: false, analyzed: false }),
    markRefAnalyzed: () => {},
  })
}

async function run(tools, name, args) {
  const t = tools.find((x) => x.name === name)
  const v = await t.execute(args, { signal: new AbortController().signal })
  const b = t.output.render(args, v)
  return { value: v, text: b.filter((x) => x.type === 'text').map((x) => x.text).join('\n') }
}

console.log('=== 场景 A：三个精度一致的立方体 ===')
{
  /* 同一物品的三个零件（共享组前缀），错开位置避免重合判定。
   * 用同一个组名是因为新规则要求「一个完整物品 = 一个 Collection」，
   * 三个不同组会互相插入 → 组间穿模 → 检查不通过。 */
  const meshes = [
    boxAt('箱_面', 0, 0, 0, 2),
    boxAt('箱_侧', 0.5, 0, 0, 2),
    boxAt('箱_底', 0, 0.5, 0, 2),
  ]
  const tools = makeTools(meshes)
  const r = await run(tools, 'model_loop', { reset: true, verdict: 'continue', next_improvement: 'X' })
  expect('返回 perMesh 字段', !!r.value.perMesh, JSON.stringify(Object.keys(r.value)))
  expect('检查了 3 个 mesh', r.value.perMesh.count === 3, String(r.value.perMesh.count))
  expect('无逐 mesh 问题', r.value.perMesh.problems.length === 0,
    JSON.stringify(r.value.perMesh.problems.map((p) => p.part)))
  expect('精度无离群', r.value.perMesh.precision.outliers.length === 0,
    JSON.stringify(r.value.perMesh.precision.outliers.map((o) => o.part)))
  expect('文案含逐 mesh 检查', /逐 mesh 隔离检查/.test(r.text), r.text.slice(0, 300))
  expect('文案含精度一致性', /精度一致性/.test(r.text), r.text.slice(0, 300))
  expect('本身检测通过', r.value.pass === true, 'pass=' + r.value.pass)
}

console.log('\n=== 场景 B：混入一个过密的球 → 不算通过 ===')
{
  const meshes = [
    cubeMesh('箱体', 2, 4), cubeMesh('盖板', 2, 4), cubeMesh('支架', 2, 4),
    sphereMesh('球_过密', 1, 64, 32),
  ]
  const tools = makeTools(meshes)
  const r = await run(tools, 'model_loop', { reset: true, verdict: 'continue', next_improvement: 'X' })
  expect('检出精度离群', r.value.perMesh.precision.outliers.length > 0,
    JSON.stringify(r.value.perMesh.precision.outliers.map((o) => o.part)))
  expect('过密球被点名',
    r.value.perMesh.precision.outliers.some((o) => o.part === '球_过密'),
    JSON.stringify(r.value.perMesh.precision.outliers.map((o) => o.part)))
  console.log('  pass=' + r.value.pass + '（精度不一致必须导致不通过）')
  expect('精度不一致时 pass=false', r.value.pass === false, 'pass=' + r.value.pass)
  expect('文案说明了怎么修', /同尺寸组内精度一致|过密降细分|过粗加细分/.test(r.text), r.text.slice(-400))
}

console.log('\n=== 场景 C：混入一个碎成渣的 mesh → 不算通过 ===')
{
  const a = cubeMesh('正常件', 2, 4)
  const another = cubeMesh('另一个', 2, 4)
  /* 碎渣：200 个互不相连的三角面。这才是真问题——
   * 单纯"多块"是合法的（道路、栏杆都是多段拼的），
   * 但碎成几百个单三角面就是拼接失败了。 */
  const pos = []
  const idx = []
  for (let i = 0; i < 200; i++) {
    const base = pos.length / 3
    const x = i * 0.5
    pos.push(x, 0, 0, x + 0.4, 0, 0.1, x, 0.4, 0)
    idx.push(base, base + 1, base + 2)
  }
  const broken = makeMesh('碎渣件', '碎渣件', new Float32Array(pos), new Uint32Array(idx))

  const meshes = [a, another, cubeMesh('第三个', 2, 4), cubeMesh('第四个', 2, 4), broken]
  const tools = makeTools(meshes)
  const r = await run(tools, 'model_loop', { reset: true, verdict: 'continue', next_improvement: 'X' })
  expect('检出逐 mesh 问题', r.value.perMesh.problems.length > 0,
    JSON.stringify(r.value.perMesh.problems.map((p) => p.part)))
  expect('碎渣件被点名',
    r.value.perMesh.problems.some((p) => p.part === '碎渣件'),
    JSON.stringify(r.value.perMesh.problems.map((p) => p.part)))
  const pb = r.value.perMesh.problems.find((p) => p.part === '碎渣件')
  if (pb) {
    console.log('  碎渣件：islands=' + pb.islands + ' 问题=' + pb.issues.map((i) => i.kind).join(','))
    expect('报告了 fragmented', pb.issues.some((i) => i.kind === 'fragmented'),
      JSON.stringify(pb.issues.map((i) => i.kind)))
  }
  expect('有碎渣时 pass=false', r.value.pass === false, 'pass=' + r.value.pass)
}

console.log('\n=== 场景 C2：合法多块（两个分离件合在一个 mesh）→ 不该报错 ===')
{
  const b1 = cubeMesh('tmp', 2, 4)
  const pos = new Float32Array([...b1.positions, ...b1.positions.map((v, i) => (i % 3 === 0 ? v + 10 : v))])
  const idx = new Uint32Array([...b1.indices, ...Array.from(b1.indices, (v) => v + b1.vertices)])
  const twoParts = makeMesh('两段拼接件', '两段拼接件', pos, idx)

  const meshes = [
    cubeMesh('A', 2, 4), cubeMesh('B', 2, 4), cubeMesh('C', 2, 4),
    cubeMesh('D', 2, 4), twoParts,
  ]
  const tools = makeTools(meshes)
  const r = await run(tools, 'model_loop', { reset: true, verdict: 'continue', next_improvement: 'X' })
  console.log('  两段拼接件 islands=' + (r.value.perMesh.problems.find((p) => p.part === '两段拼接件')?.islands ?? '未报'))
  expect('合法多块不报逐 mesh 问题',
    !r.value.perMesh.problems.some((p) => p.part === '两段拼接件'),
    JSON.stringify(r.value.perMesh.problems.map((p) => p.part)))
}

console.log('\n=== 场景 D：model_loop 也带这项检查 ===')
{
  /* 精度比较需要至少 4 个样本，所以这里给足 5 个 */
  const meshes = [
    cubeMesh('X', 2, 4), cubeMesh('Y', 2, 4), cubeMesh('W', 2, 4), cubeMesh('V', 2, 4),
    sphereMesh('Z_密', 1.5, 64, 32),
  ]
  const tools = makeTools(meshes)
  const r = await run(tools, 'model_loop', { verdict: 'continue', next_improvement: 'x' })
  expect('model_loop 返回 perMesh', !!r.value.perMesh, JSON.stringify(Object.keys(r.value)))
  expect('model_loop 的 perMesh 有精度数据', !!r.value.perMesh.precision,
    JSON.stringify(r.value.perMesh))
  expect('model_loop 检出离群', r.value.perMesh.precision.outliers.length > 0,
    JSON.stringify(r.value.perMesh.precision.outliers.map((o) => o.part)))
}

console.log('\n' + (failed === 0 ? 'PERMESH_INLOOP_OK' : 'PERMESH_INLOOP_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
