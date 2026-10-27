/**
 * 端到端验证 model_reference_image 工具。
 *   node tests/verify_reference_tool.mjs
 */

import { buildTools } from '../lib/tools.mjs'
import { fileURLToPath } from 'node:url'
import { detectSubject } from '../lib/core/subject.mjs'

const fixturePath = fileURLToPath(new URL('./subject_fixture.png', import.meta.url))

const tools = buildTools({
  sourceFor: () => ({}),
  config: () => ({}),
  hostCtx: { get: () => undefined },
})
const tool = tools.find((t) => t.name === 'model_reference_image')
const exec = { signal: new AbortController().signal }

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

console.log('=== 纯色背景的测试图（1024×1024，白底 + 中央深灰块 + 橙色横带）===')
const v = await tool.execute({ path: fixturePath }, exec)
const blocks = tool.output.render({}, v)
const text = blocks.map((b) => b.text).join('\n')
console.log(text.split('\n').slice(0, 22).join('\n'))

expect('工具执行成功', !!v.kind)
expect('识别出主体（未退回整图）', v.subject.fallback === false,
  'fallback=' + v.subject.fallback + ' reason=' + v.subject.reason)
expect('主体框大致在中央', v.subject.bbox.x0 > 150 && v.subject.bbox.x1 < 880,
  JSON.stringify(v.subject.bbox))
expect('网格密度按 1K 规则（每格 ≤50px）', v.gridSize.cellPx <= 55,
  'cellPx=' + v.gridSize.cellPx)
expect('网格数量足够细', v.gridSize.cols * v.gridSize.rows >= 100,
  String(v.gridSize.cols * v.gridSize.rows))
expect('识别出白底背景', v.subject.background.hex === '#fafafa', v.subject.background.hex)
expect('聚类出深灰和橙色', v.colors.length >= 2, String(v.colors.length))
expect('允许标签与图案使用纹理', v.textureAllowed === true, String(v.textureAllowed))
expect('禁止照片平面冒充重建', /不能用照片平面冒充立体重建/.test(text), text.slice(-300))
expect('颜色区域不能证明物理分件', /不直接对应物理零件/.test(text))
expect('色差不直接判定材质错误', /色差不直接等于材质错误/.test(text))

console.log('\n=== 自定义 cell_px ===')
const v2 = await tool.execute({
  path: fixturePath,
  cell_px: 25,
}, exec)
expect('cell_px=25 时格子更多', v2.gridSize.cols > v.gridSize.cols,
  v2.gridSize.cols + ' vs ' + v.gridSize.cols)

console.log('\n=== 跳过主体识别 ===')
const v3 = await tool.execute({
  path: fixturePath,
  skip_subject: true,
}, exec)
expect('skip_subject 时整图分析', v3.subject.confidence === 'skipped', v3.subject.confidence)

console.log('\n=== 合成复杂背景（不依赖工作区以外图片）===')
const rgb = new Uint8Array(160 * 160 * 3)
for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 71 + Math.floor(i / 480) * 43) % 256
const complex = detectSubject({ width: 160, height: 160, rgb })
expect('复杂背景时如实退回', complex.fallback === true, String(complex.fallback))
expect('退回时给出原因', !!complex.reason, String(complex.reason))

console.log('\n' + (failed === 0 ? 'REFERENCE_TOOL_OK' : 'REFERENCE_TOOL_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
