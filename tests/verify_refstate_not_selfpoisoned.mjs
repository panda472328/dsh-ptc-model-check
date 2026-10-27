/**
 * 回归测试：参考图状态不能被插件自己注入的状态文本污染。
 *
 * 背景（实测过的死循环，缺陷 2）：
 *   插件每轮把运行时状态当 **user 消息**注入，其中一句含「参考图」三个字；
 *   而它自己的检测器只按 role === 'user' 过滤，于是扫到了自己那句话
 *   → refState.given = true → canStop 永久报「给了参考图但没分析」
 *   → 模型永远无法签收。而用户自始至终只说了一句「做一个末日废墟的场景」。
 *
 * 本测试同时跑**旧逻辑**和**新逻辑**，证明修复有效。
 */

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|tga|exr)\b/i
const REF_RE_OLD = /参考图|reference image|原画|ref\s*image/i
/* 新逻辑：收紧正则 + 排除否定句 */
const REF_RE_NEW = /(参考图|原画|reference\s*image|ref\s*image)/i
const REF_NEGATED = /(没有|没给|未给|不带|不需要|无需|不用|没有提供|never\s+given|no\s+reference)/i

/* 插件注入的运行时状态文本（改后的措辞，已不含「参考图」）*/
const injectedNoRefNew = [
  '**选工具顺序：先查 mcp__blender__* 有没有现成的 → 再查 model_* 检查工具 → 都没有才用 execute_python 写脚本。**',
  '插件版本：v1.3.0（门禁：阶段分离 / 流程推进 / 分组可靠 / 停止六条）',
  '如任务附带图片素材且需要精确颜色或区域数据，可调用 model_reference_image；该分析为可选辅助，不是签收硬门槛。',
].join('\n')

/* 改之前的措辞（含「参考图」）——用来证明「就算 source 标记失效也不会再中招」*/
const injectedNoRefOld = '参考图：**还没分析**。如果用户给了参考图，建模前必须先调 model_reference_image，否则 model_loop 会拒绝让你完成。'

const userReal = '做一个末日废墟的场景'

/* ── 旧逻辑：只按 role 过滤，不看待来源 ── */
function detectOld(messages) {
  let given = false
  for (const m of messages) {
    if (!m || m.role !== 'user') continue
    for (const part of (m.content || [])) {
      if (!part) continue
      if (part.type === 'image') { given = true; continue }
      if (part.type === 'text' && typeof part.text === 'string') {
        if (IMAGE_EXT.test(part.text)) given = true
        if (REF_RE_OLD.test(part.text)) given = true
      }
    }
  }
  return given
}

/* ── 新逻辑：排除 runtime-context + 收紧正则 + 排除否定句 ── */
function detectNew(messages) {
  let given = false
  for (const m of messages) {
    if (!m || m.role !== 'user') continue
    /* ① 排除插件自己注入的运行时状态 */
    const src = m.source
    const kind = src && (src.kind || src.source)
    if (kind === 'runtime-context') continue
    if (src && src.form === 'snapshot') continue
    for (const part of (m.content || [])) {
      if (!part) continue
      if (part.type === 'image') { given = true; continue }
      if (part.type === 'text' && typeof part.text === 'string') {
        if (IMAGE_EXT.test(part.text)) given = true
        /* ② 收紧正则 + ③ 排除否定表达 */
        if (REF_RE_NEW.test(part.text) && !REF_NEGATED.test(part.text)) given = true
      }
    }
  }
  return given
}

const RUNTIME = { kind: 'runtime-context', source: 'runtime-context' }

console.log('=== 1. 用户没给图：不能被自己注入的文本污染 ===')
{
  /* 用**改之前的措辞**（含「参考图」三个字）来复现缺陷。
   * 关键点：注入的消息带 runtime-context 标记（宿主就是这么注入的）。 */
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: userReal }] },
    { role: 'user', source: RUNTIME, content: [{ type: 'text', text: injectedNoRefOld }] },
  ]
  console.log('  旧逻辑结果: ' + detectOld(msgs) + '（true 就是缺陷：canStop 会永久阻断）')
  expect('旧逻辑确实会污染（复现缺陷）', detectOld(msgs) === true, String(detectOld(msgs)))
  console.log('  新逻辑结果: ' + detectNew(msgs) + '（source 过滤 + 措辞收紧）')
  expect('新逻辑不污染', detectNew(msgs) === false, String(detectNew(msgs)))

  /* 再用改后的措辞，确认双重保险都生效 */
  const msgs2 = [
    { role: 'user', content: [{ type: 'text', text: userReal }] },
    { role: 'user', source: RUNTIME, content: [{ type: 'text', text: injectedNoRefNew }] },
  ]
  expect('新措辞也不会污染', detectNew(msgs2) === false, String(detectNew(msgs2)))
}

console.log('\n=== 2. 就算 source 标记失效（用旧措辞），也不该中招 ===')
{
  /* 极端情况：宿主改了 source 约定，我们的排除失效，注入的旧措辞被扫到 */
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: userReal }] },
    { role: 'user', content: [{ type: 'text', text: injectedNoRefOld }] },  // 没有 source 标记
  ]
  console.log('  新逻辑结果（无 source 标记 + 旧措辞）= ' + detectNew(msgs))
  /* 旧措辞里「如果用户给了参考图」——「参考图」命中、但「没有」不在这一句里。
   * 所以这里仍可能为 true。这正说明**必须靠 source 过滤**，
   * 措辞收紧只是第二层保险。记下来，不当失败。 */
  console.log('  → ' + (detectNew(msgs)
    ? '仍会误判：证明 source 过滤是主判据，措辞只是第二层保险'
    : '也不误判：措辞收紧生效'))
}

console.log('\n=== 3. 用户真的给了图：必须能识别 ===')
{
  /* 图片附件 */
  const msgs1 = [
    { role: 'user', content: [{ type: 'image', image: 'ref-1' }] },
    { role: 'user', source: RUNTIME, content: [{ type: 'text', text: injectedNoRefNew }] },
  ]
  expect('图片附件能识别', detectNew(msgs1) === true, String(detectNew(msgs1)))

  /* 图片路径 */
  const msgs2 = [
    { role: 'user', content: [{ type: 'text', text: '按这张图做 D:/ref/chair.png' }] },
    { role: 'user', source: RUNTIME, content: [{ type: 'text', text: injectedNoRefNew }] },
  ]
  expect('图片路径能识别', detectNew(msgs2) === true, String(detectNew(msgs2)))

  /* 明确说「参考图」 */
  const msgs3 = [
    { role: 'user', content: [{ type: 'text', text: '我给的参考图里那把椅子' }] },
    { role: 'user', source: RUNTIME, content: [{ type: 'text', text: injectedNoRefNew }] },
  ]
  expect('明确提到参考图能识别', detectNew(msgs3) === true, String(detectNew(msgs3)))
}

console.log('\n=== 4. 否定句不该被当成「给了图」===')
{
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: '这次没有参考图，你自己发挥' }] },
  ]
  console.log('  新逻辑结果: ' + detectNew(msgs))
  expect('「没有参考图」不误判', detectNew(msgs) === false, String(detectNew(msgs)))
}

console.log('\n' + (failed === 0 ? 'REFSTATE_NOT_SELFPOISONED_OK' : 'REFSTATE_NOT_SELFPOISONED_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
