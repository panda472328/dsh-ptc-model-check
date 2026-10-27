/**
 * 验证：主体识别 + 自适应像素网格（1K 图 ≥50px 一格）
 *   node tests/verify_subject_grid.mjs <图片路径>
 */

import { readFile } from 'node:fs/promises'
import { analyzeReference } from '../lib/core/color.mjs'

const path = process.argv[2]
if (!path) {
  console.error('用法：node tests/verify_subject_grid.mjs <png路径>')
  process.exit(2)
}

const buf = await readFile(path)
const r = analyzeReference(buf, {})

console.log('=== 图像 ===')
console.log('  尺寸: ' + r.width + 'x' + r.height)

console.log('\n=== 主体识别 ===')
console.log('  背景色: ' + r.subject.background.hex + ' rgb(' + r.subject.background.rgb.join(',') + ')'
  + '  占边缘像素 ' + (r.subject.background.ratio * 100).toFixed(0) + '%')
console.log('  主体框: (' + r.subject.bbox.x0 + ',' + r.subject.bbox.y0 + ') - ('
  + r.subject.bbox.x1 + ',' + r.subject.bbox.y1 + ')')
console.log('  主体占比: ' + (r.subject.coverage * 100).toFixed(1) + '%')
console.log('  置信度: ' + r.subject.confidence + (r.subject.fallback ? '（退回整图）' : ''))
if (r.subject.reason) console.log('  说明: ' + r.subject.reason)
console.log('  连通域数: ' + r.subject.components)

console.log('\n=== 分析区域 ===')
const rg = r.region
console.log('  (' + rg.x0 + ',' + rg.y0 + ') - (' + rg.x1 + ',' + rg.y1 + ')'
  + '  = ' + r.regionSize.width + 'x' + r.regionSize.height)

console.log('\n=== 网格密度 ===')
console.log('  ' + r.gridSize.cols + ' 列 × ' + r.gridSize.rows + ' 行 = '
  + (r.gridSize.cols * r.gridSize.rows) + ' 格')
console.log('  每格约 ' + r.gridSize.cellPx + 'px × ' + r.gridSize.cellPxY + 'px')

/* 核心断言：1K 原画至少 50px 一格。
 * 注意按**原图**长边算——裁剪到主体后区域变小，但格子密度要求不因此放宽。 */
const longEdge = Math.max(r.width, r.height)
const expectedMinCell = longEdge >= 1000 ? 50 : Math.round(longEdge / 20)
console.log('  期望每格 ≤ ' + expectedMinCell + 'px（原图长边 ' + longEdge
  + (longEdge >= 1000 ? ' 属于 1K 量级，硬要求 50px' : '，按 1/20 推算') + '）')

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

console.log('\n=== 断言 ===')
expect('每格像素数不超过要求', r.gridSize.cellPx <= expectedMinCell + 5,
  'cellPx=' + r.gridSize.cellPx + ' 要求 ≤' + expectedMinCell)
expect('网格总数在合理范围', r.gridSize.cols * r.gridSize.rows >= 100
  && r.gridSize.cols * r.gridSize.rows <= 1600,
  (r.gridSize.cols * r.gridSize.rows) + ' 格')
expect('主体识别有结论', ['high', 'medium', 'low', 'skipped'].includes(r.subject.confidence),
  r.subject.confidence)
if (r.subject.fallback) {
  expect('退回整图时给出原因', !!r.subject.reason, String(r.subject.reason))
}

console.log('\n=== 颜色聚类（前 5）===')
for (const c of r.cluster.slice(0, 5)) {
  console.log('  #' + c.rank + ' ' + c.hex + ' 占 ' + (c.ratio * 100).toFixed(1) + '%  ' + c.kind
    + '  出现在 ' + (r.buildOrder.find((b) => b.hex === c.hex)?.cellCount ?? '?') + ' 个格子')
}

console.log('\n=== 网格预览（前 3 行，仅前 12 列）===')
for (let ry = 0; ry < Math.min(3, r.gridSize.rows); ry++) {
  const row = r.grid.cells.filter((c) => c.row === ry).slice(0, 12)
  console.log('  第' + (ry + 1) + '行: ' + row.map((c) => c.hex).join(' '))
}

console.log('\n' + (failed === 0 ? 'SUBJECT_GRID_OK' : 'SUBJECT_GRID_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
