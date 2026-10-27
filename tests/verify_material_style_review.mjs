import { buildReviewerPrompt } from '../lib/core/review.mjs'

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

console.log('=== ① 材质模式 + 卡通风 → 必须说明平涂是对的 ===')
{
  const p = buildReviewerPrompt({
    mode: 'material',
    target: '卡通机甲',
    style: '卡通',
    scene_note: '做一个卡通机甲模型',
    groups: [{ name: '卡通机甲', parts: ['头', '身'] }],
  })
  expect('含画风声明', /\*\*画风：卡通\*\*/.test(p), '')
  expect('说明平涂是刻意的', /平涂是刻意做出来的，不是缺点/.test(p), '')
  expect('明确禁止因不写实判错', /不要因为「金属没有金属反光」/.test(p), '')
  expect('第一问是画风不是现实', /这个材质是它该有的画风吗/.test(p), '')
  expect('不含「现实中是这样的吗」', !/这个材质在现实中是这样的吗/.test(p), '')
  expect('禁止改几何', /不要改几何/.test(p), '')
  console.log('\n  --- 画风段落 ---')
  const i = p.indexOf('## 这个场景的画风')
  console.log(p.slice(i, i + 520).split('\n').map((l) => '  ' + l).join('\n'))
}

console.log('\n=== ② 材质模式 + 写实风 → 新旧状态由任务决定 ===')
{
  const p = buildReviewerPrompt({ mode: 'material', target: '大楼A', style: '写实', scene_note: '末日废墟' })
  expect('画风是写实', /\*\*画风：写实\*\*/.test(p), '')
  expect('新制品允许干净，不强制旧化', /新制品可以干净均匀，不强制磨损或积灰/.test(p), '')
  expect('不凭物品名指定材料或旧化', /不要仅凭名称指定材料、强制旧化/.test(p), '')
  expect('纯常量材质无需 UV', /纯常量材质不要求 UV/.test(p), '')
  expect('不出现卡通专属说明', !/平涂是刻意做出来的/.test(p), '')
}

console.log('\n=== ③ 材质模式 + 没传画风 → 要求它自己判断画风 ===')
{
  const p = buildReviewerPrompt({ mode: 'material', target: '墙' })
  expect('提示没说明画风', /没有明确说明画风/.test(p), '')
  expect('要求它自己看画风', /从图上看它是哪种风格/.test(p), '')
  expect('强调不要一律按写实标准', /不要一律按写实标准/.test(p), '')
}

console.log('\n=== ④ 结构模式不受影响 ===')
{
  const p = buildReviewerPrompt({ target: '椅子', scene_note: '做椅子' })
  expect('三问是结构版', ['结构对吗', '现实中是这样吗', '还能更好吗'].every((q) => p.includes(q)), '')
  expect('没有画风段落', !/## 这个场景的画风/.test(p), '')
}

console.log('\n=== ⑤ 低多边形/像素风也要区别对待 ===')
{
  const p1 = buildReviewerPrompt({ mode: 'material', target: 'x', style: '低多边形' })
  expect('低多边形：棱角是刻意的', /低多边形是刻意的棱角分明/.test(p1), '')
  const p2 = buildReviewerPrompt({ mode: 'material', target: 'x', style: '像素' })
  expect('像素风：色板限制是刻意的', /像素风要严格限制色板/.test(p2), '')
}

console.log('\n' + (failed === 0 ? 'MATERIAL_STYLE_REVIEW_OK' : 'MATERIAL_STYLE_REVIEW_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
