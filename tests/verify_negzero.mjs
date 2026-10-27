/**
 * 验证返回值里不出现负零（-0）。
 *
 * 背景：宿主的无损 JSON 校验会把 -0 判为非法值
 * （Object.is(-0, 0) 为 false），导致整个工具返回值被拒。
 * 几何计算里很容易产生 -0（比如 0.0 * -1、坐标相减）。
 */
import { sanitizeJson } from '../lib/tools.mjs'
import { makeMesh, classifyInterference } from '../lib/core/geometry.mjs'

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

/* 简单立方体 */
function box(id, cx, cy, cz, s) {
  const p = [], idx = []
  const h = s / 2
  const v = [
    [-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h],
    [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h],
  ]
  for (const [a, b, c] of v) p.push(cx + a, cy + b, cz + c)
  for (const f of [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) {
    idx.push(f[0], f[1], f[2], f[0], f[2], f[3])
  }
  return makeMesh(id, id, new Float32Array(p), new Uint32Array(idx))
}

/** 找出所有 -0 和非法值 */
function findNegZero(root) {
  const out = []
  const walk = (v, p) => {
    if (v === null) return
    const t = typeof v
    if (t === 'number') {
      if (Object.is(v, -0)) out.push(p + ' = -0')
      else if (!Number.isFinite(v)) out.push(p + ' = ' + v)
      return
    }
    if (t !== 'object') return
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, p + '[' + i + ']'))
    else for (const k of Object.keys(v)) walk(v[k], p + '.' + k)
  }
  walk(root, '$')
  return out
}

console.log('=== 1. 几何计算不产生 -0 ===')
{
  /* 位置对称的物体：坐标相减很容易出 -0 */
  const a = box('对称A', -1.5, -1.5, -1.5, 3)
  const b = box('对称B', 0, 0, 0, 1)
  const cls = classifyInterference(a, b)
  const bad = findNegZero(cls)
  console.log('  classifyInterference 结果: ' + JSON.stringify(cls))
  expect('分类结果无 -0', bad.length === 0, bad.join('、'))
}

console.log('\n=== 2. sanitizeJson 把 -0 归 0 ===')
{
  const dirty = { a: -0, b: [-0, -0], c: { d: -0 } }
  const clean = sanitizeJson(dirty)
  const bad = findNegZero(clean)
  console.log('  净化后: ' + JSON.stringify(clean))
  expect('无 -0 残留', bad.length === 0, bad.join('、'))
  expect('值变成 0', clean.a === 0 && !Object.is(clean.a, -0), String(clean.a))
}

console.log('\n=== 3. 真实几何运算的值 ===')
{
  /* 制造一堆可能产生 -0 的运算 */
  const vals = []
  for (const x of [0, -0, 1, -1]) {
    vals.push(x * -1)
    vals.push(x - x)
    vals.push(-Math.abs(x) + Math.abs(x))
  }
  const after = sanitizeJson({ vals })
  const bad = findNegZero(after)
  console.log('  原始含 -0: ' + findNegZero({ vals }).length + ' 个')
  console.log('  净化后 -0: ' + bad.length + ' 个')
  expect('净化消除了全部 -0', bad.length === 0, bad.join('、'))
}

console.log('\n' + (failed === 0 ? 'NEGZERO_OK' : 'NEGZERO_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
