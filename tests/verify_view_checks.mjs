/**
 * 看图即检测：look / render_preview 的结果里必须同时带穿模与孤立两项。
 *
 * 背景（用户要求）：
 *   「孤立工具和穿模工具需要绑定在看图工具里一起使用，只要看图，
 *     就会同时返回这两个工具一起检测的结果」
 *
 * 这里验两层：
 *   ① 检测本身：buildViewCheckReport 用真实几何跑出穿模命中 + 孤立命中；
 *   ② 接线：index.js 用 tools/post-execute 把报告追加到 look/render_preview 的
 *      同一个结果里，且遵守宿主契约（不能同时替换 value 和 content、
 *      监听器抛错会让工具调用变成 isError）。
 *
 * 不连接 Blender：几何全部是内存里的三角面。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildViewCheckReport } from '../lib/tools.mjs'
import { makeMesh } from '../lib/core/geometry.mjs'

const CUBE = [
  new Float64Array([
    -1, -1, -1, 1, -1, -1, -1, 1, -1, 1, 1, -1,
    -1, -1, 1, 1, -1, 1, -1, 1, 1, 1, 1, 1,
  ]),
  new Uint32Array([
    0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6,
    0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7,
    0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5,
  ]),
]

function cube(part, dx = 0, group = '物品') {
  const [base, idx] = CUBE
  const pos = new Float64Array(base.length)
  for (let i = 0; i < base.length; i += 3) {
    pos[i] = base[i] + dx
    pos[i + 1] = base[i + 1]
    pos[i + 2] = base[i + 2]
  }
  const m = makeMesh(part, part, pos, idx)
  m.meta = { collections: [group] }
  return m
}

/* 两个立方体互相插入 → 穿模；第三个放在远处 → 孤立 */
const meshes = [cube('主体_壳'), cube('主体_盖', 1), cube('环境_地面', 12, '环境')]

const src = {
  describe: () => 'fake-memory',
  resolve: async () => 'file',
  extract: async () => ({ meshes, skipped: [] }),
}
const cfg = { minDepth: 0.0005, minRatio: 0.005, maxObjects: 3000, maxTriangles: 2000000 }

console.log('=== 1. 检测本身 ===')
const report = await buildViewCheckReport(src, cfg, { maxItems: 6 })
console.log(report.text)
assert.equal(report.ok, true)
assert.ok(report.hits >= 1, '应至少命中一对穿模，实际 ' + report.hits)
assert.ok(report.isolated >= 1, '应至少命中一个孤立件，实际 ' + report.isolated)
assert.match(report.text, /【看图附带检测】/)
assert.match(report.text, /穿模 \d+ 对/)
assert.match(report.text, /孤立 \d+ 个/)
assert.match(report.text, /命名为「主体_壳」的部件/)
assert.match(report.text, /命名为「环境_地面」的部件/)

console.log('\n=== 2. 空场景不报错 ===')
const empty = await buildViewCheckReport({ ...src, extract: async () => ({ meshes: [], skipped: [] }) }, cfg)
assert.equal(empty.ok, false)
assert.match(empty.text, /没有 mesh/)

console.log('\n=== 3. 接线：post-execute 追加到看图结果 ===')
const index = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
assert.match(index, /'tools\/post-execute'/, '必须有 post-execute 监听')
assert.match(index, /const VIEW_TOOLS = new Set\(\['look', 'render_preview'\]\)/, '必须绑定 look 与 render_preview')
assert.match(index, /buildViewCheckReport\(sourceFor\(\)/, '必须复用同一套检测')
assert.match(index, /kind !== 'accept'/, '只处理 accept 决策')
assert.match(index, /content: contentOf\(\)\.concat\(\[\{ type: 'text', text: report\.text \}\]\)/, '报告追加进同一结果')
assert.doesNotMatch(index, /value:.*report/, '不得替换 value（宿主禁止同时替换 value 与 content）')
assert.match(index, /viewCheck: z\.boolean\(\)\.default\(true\)/, '配置项 viewCheck 存在且默认开启')
assert.match(index, /viewCheckTimeoutMs/, '有超时兜底')

console.log('\nVIEW_CHECKS_OK')
