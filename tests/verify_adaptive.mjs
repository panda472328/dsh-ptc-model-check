/**
 * 验证自适应标定在不同类型图上都能得出合理阈值。
 *   node tests/verify_adaptive.mjs
 */

import { readFileSync, existsSync } from 'node:fs'
import { analyzeImageCharacteristics } from '../lib/core/adaptive.mjs'
import { decodePngRgb } from '../lib/core/color.mjs'

const candidates = [
  ['扁平合成图（白底+色块）', 'tests/subject_fixture.png'],
  ['哑铃形状图', 'tests/shape_fixture.png'],
  ['真实参考图（暗色渲染）', 'D:/dsh建模/ref_panel1.png'],
  ['另一张真实参考图', 'D:/dsh建模/cls_blade.png'],
]

const results = []

for (const [label, path] of candidates) {
  if (!existsSync(path)) {
    console.log('\n=== ' + label + ' === （跳过：文件不存在）')
    continue
  }
  const img = decodePngRgb(readFileSync(path))
  const { diag, cal } = analyzeImageCharacteristics(img)

  console.log('\n=== ' + label + ' ===')
  console.log('  尺寸 ' + img.width + '×' + img.height)
  console.log('  类型：' + diag.type + ' — ' + diag.reason)
  console.log('  统计：颜色数 ' + diag.stats.uniqueColors
    + ' · 边缘 p95 ' + diag.stats.edgeP95
    + ' · 亮度区间 ' + diag.stats.lumaBins)
  console.log('  标定：')
  console.log('    硬边阈值   ' + cal.hardEdge + '（Otsu ' + cal.percentiles.otsu + '）')
  console.log('    颜色容差   ' + cal.colorTolerance)
  console.log('    区域容差   ' + cal.regionTolerance)
  console.log('    背景容差   ' + cal.bgTolerance + '（边缘离散度 ' + cal.edgeSd + '）')
  console.log('    细采样     ' + cal.detailPx + 'px')
  console.log('    布局网格   ' + cal.layoutPx + 'px')
  console.log('    分位       p50=' + cal.percentiles.p50
    + ' p75=' + cal.percentiles.p75
    + ' p95=' + cal.percentiles.p95)

  results.push({ label, diag, cal, img })
}

console.log('\n=== 通用性断言 ===')
let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

if (results.length >= 3) {
  /* 关键：不同类型图必须得出**不同的**标定，说明它真的在自适应 */
  const types = new Set(results.map((r) => r.diag.type))
  expect('诊断出多种图片类型', types.size >= 2, [...types].join(', '))

  const bgTols = results.map((r) => r.cal.bgTolerance)
  const bgRange = Math.max(...bgTols) - Math.min(...bgTols)
  expect('背景容差随图不同而不同', bgRange > 5,
    bgTols.map((v) => v.toFixed(0)).join(' vs '))

  /* 所有标定值必须落在合理范围，不能出现负值或荒谬值 */
  for (const r of results) {
    const c = r.cal
    expect(r.label + '：硬边阈值合理',
      c.hardEdge > 3 && c.hardEdge < 400, String(c.hardEdge))
    expect(r.label + '：颜色容差合理',
      c.colorTolerance > 2 && c.colorTolerance < 200, String(c.colorTolerance))
    expect(r.label + '：背景容差合理',
      c.bgTolerance >= 25 && c.bgTolerance <= 120, String(c.bgTolerance))
    expect(r.label + '：采样精度合理',
      c.detailPx >= 2 && c.detailPx <= 40, String(c.detailPx))
    expect(r.label + '：布局网格合理',
      c.layoutPx >= 8 && c.layoutPx <= 200, String(c.layoutPx))
  }
} else {
  console.log('  （有效样本不足 3 张，跳过通用性断言）')
}

console.log('\n' + (failed === 0 ? 'ADAPTIVE_OK' : 'ADAPTIVE_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
