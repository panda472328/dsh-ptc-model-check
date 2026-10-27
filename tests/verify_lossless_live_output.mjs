/**
 * 回归测试：工具返回值必须是**无损 JSON**。
 *
 * 背景（实测过的致命缺陷，缺陷 1）：
 *   宿主的返回值校验遇到 undefined / NaN / Infinity / -0 时，
 *   判定**整个返回值非法**并抛 ToolCallError（value is not lossless JSON），
 *   不是跳过那一个键。
 *
 *   而 `attachBase64Images` 里写了 `base64: undefined` 来剥离图片数据，
 *   于是**真机上 model_loop 每一次调用都报错、一次都没成功**——
 *   模型拿不到检查数据，只能自己写脚本截图，整条检查流程失效。
 *
 *   为什么测试没抓到：现有夹具的 renderShots 全部返回 `path: null`，
 *   出图路径根本不执行。本测试补上「出图成功」分支，把这个盲区堵掉。
 *
 * 不需要 Blender：用假源模拟出图成功。
 */

import { buildTools, sanitizeJson } from '../lib/tools.mjs'

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

/** 找出所有过不了无损 JSON 校验的值 */
function findOffenders(root) {
  const out = []
  const ancestors = new Set()
  const walk = (v, p) => {
    if (v === null) return
    const t = typeof v
    if (t === 'boolean' || t === 'string') return
    if (t === 'number') {
      if (!Number.isFinite(v)) out.push(p + ' = ' + v)
      else if (Object.is(v, -0)) out.push(p + ' = -0')
      return
    }
    if (t !== 'object') { out.push(p + ' = typeof ' + t); return }
    if (ancestors.has(v)) { out.push(p + ' = CYCLE'); return }
    ancestors.add(v)
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, p + '[' + i + ']'))
    else for (const k of Object.keys(v)) walk(v[k], p + '.' + k)
    ancestors.delete(v)
  }
  walk(root, '$')
  return out
}

/* ── 先验证 sanitizeJson 本身 ── */
console.log('=== 1. sanitizeJson 的净化能力 ===')
{
  const dirty = {
    a: 1, b: undefined, c: NaN, d: Infinity, e: -Infinity, f: -0,
    g: null, h: 'ok', i: [1, undefined, -0, NaN],
    j: { k: undefined, l: 2 },
    m: () => {},
  }
  const clean = sanitizeJson(dirty)
  const off = findOffenders(clean)
  console.log('  净化后 offenders: ' + off.length)
  expect('净化后没有非法值', off.length === 0, off.join('、'))
  expect('undefined 键被删掉', !('b' in clean), JSON.stringify(Object.keys(clean)))
  expect('NaN 归 0', clean.c === 0, String(clean.c))
  expect('Infinity 归 0', clean.d === 0, String(clean.d))
  expect('-0 归 0', !Object.is(clean.f, -0) && clean.f === 0, String(clean.f))
  /* 数组：undefined 剔除，NaN/-0 归 0 保留（它们是数值位，归 0 比删掉更合理） */
  expect('数组里 undefined 被剔除、数值非法值归 0', clean.i.length === 3,
    JSON.stringify(clean.i))
  expect('数组元素值正确', JSON.stringify(clean.i) === '[1,0,0]', JSON.stringify(clean.i))
  expect('嵌套对象也被净化', !('k' in clean.j), JSON.stringify(clean.j))
  expect('函数被剔除', !('m' in clean), JSON.stringify(Object.keys(clean)))
}

/* ── 造一个「出图成功」的假源：这是缺陷 1 的复现条件 ── */
console.log('\n=== 2. 假源出图成功时（缺陷 1 的复现条件）===')
function makeSource({ imagesOk }) {
  return {
    describe: () => 'live',
    async resolve() { return 'live' },
    async info() { return { meshes: 2 } },
    async namingScan() { return { totalMeshes: 2, named: 2, generic: 0, duplicates: [] } },
    async extract() {
      const mk = (id, cx) => ({
        id, part: id, triangles: 12,
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        indices: new Uint32Array([0, 1, 2]),
        bbox: [cx, 0, 0, cx + 1, 1, 1],
        dims: [1, 1, 1], diag: 1.73,
        meta: { collections: ['测试物品'] },
      })
      return { meshes: [mk('零件A', 0), mk('零件B', 0.5)], skipped: [], source: 'fake' }
    },
    /* 出图：返回真 base64 —— 这才是缺陷 1 走到的路径 */
    async renderShots(shots) {
      return {
        shots: shots.map((s) => ({
          view: s.view,
          path: null,
          attached: false,
          base64: imagesOk ? 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' : undefined,
          mimeType: 'image/png',
        })),
      }
    },
    async perMeshViews() { return [] },
    async dispose() {},
  }
}

function makeTools(src) {
  const cfg = { maxObjects: 100, maxTriangles: 10000, minDepth: 0.0005, minRatio: 0.005 }
  return buildTools({
    sourceFor: () => src,
    config: () => cfg,
    remember: () => {},
    hostCtx: {
      get: (k) => (k === 'attachments'
        ? { saveImage: async () => ({ id: 'att-1', mediaType: 'image/png', width: 1, height: 1, name: 'n' }) }
        : undefined),
    },
    getRefState: () => ({ given: false, analyzed: false }),
    markRefAnalyzed: () => {},
    getPhaseState: () => ({ modelingComplete: false }),
    markModelingComplete: () => {},
    resetPhase: () => {},
    getModelingState: () => ({ dirtySinceCheck: false, editCount: 0, lookSinceEdit: 0 }),
    noteCheck: () => {},
  })
}

for (const imagesOk of [true, false]) {
  const label = imagesOk ? '出图成功' : '出图失败'
  console.log('\n=== 3.' + (imagesOk ? '1' : '2') + ' ' + label + ' ===')
  const src = makeSource({ imagesOk })
  const tools = makeTools(src)
  const t = tools.find((x) => x.name === 'model_loop')
  try {
    const v = await t.execute(
      { reset: true, verdict: 'continue', next_improvement: '测试' },
      { signal: new AbortController().signal },
    )
    const off = findOffenders(v)
    console.log('  返回值 offenders: ' + off.length)
    if (off.length) console.log('  ' + off.slice(0, 8).join('\n  '))
    expect(label + '：返回值无损 JSON', off.length === 0, off.slice(0, 6).join('、'))
    expect(label + '：能成功返回（不抛错）', true)
    console.log('  perMeshViews: ' + JSON.stringify(v.perMeshViews && {
      count: v.perMeshViews.count,
      attached: v.perMeshViews.attached,
    }))
  } catch (e) {
    expect(label + '：能成功返回（不抛错）', false, String(e.message).slice(0, 200))
  }
}

/* ── 直接冲 attachBase64Images 那条路径 ── */
console.log('\n=== 4. 直接验证 attachBase64Images 不产生 undefined ===')
{
  const src = makeSource({ imagesOk: true })
  const tools = makeTools(src)
  const t = tools.find((x) => x.name === 'model_loop')
  /* 强制走逐 mesh 五视图渲染路径 */
  const v = await t.execute(
    { reset: true, verdict: 'continue', next_improvement: '测试', per_mesh_views: true },
    { signal: new AbortController().signal },
  )
  const off = findOffenders(v)
  expect('强制逐 mesh 五视图时也无非法值', off.length === 0, off.slice(0, 6).join('、'))
  /* perMeshImages 必须保留——投影器靠它把图片附到输出块。
   * 关键是它**不能带 undefined**（这会毁掉整个返回值）。 */
  expect('返回值保留 perMeshImages（投影器要用）', Array.isArray(v.perMeshImages),
    JSON.stringify(Object.keys(v).slice(0, 20)))
  const badKeys = []
  for (let i = 0; i < (v.perMeshImages || []).length; i++) {
    const item = v.perMeshImages[i]
    for (const k of Object.keys(item || {})) {
      if (item[k] === undefined) badKeys.push('perMeshImages[' + i + '].' + k)
    }
  }
  expect('perMeshImages 里没有 undefined 键', badKeys.length === 0, badKeys.join('、'))
  expect('perMeshImages 里不带 base64（图片已转 attachment）',
    (v.perMeshImages || []).every((x) => !('base64' in x)),
    JSON.stringify((v.perMeshImages || []).map((x) => Object.keys(x))))
  expect('返回值含 perMeshViews 元信息', !!v.perMeshViews,
    JSON.stringify(Object.keys(v).slice(0, 20)))
}

console.log('\n' + (failed === 0 ? 'LOSSLESS_OUTPUT_OK' : 'LOSSLESS_OUTPUT_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
