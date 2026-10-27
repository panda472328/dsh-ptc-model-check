/**
 * 文件结构自检：防止「脚本改坏源码」这类事故。
 *
 * 背景（真实事故）：
 *   我用一个脚本压缩「MCP 工具清单」那一段时，脚本用 `indexOf('### 典型建模流程')`
 *   定位锚点。但那个标题在文件里**出现了两次**（一次在模板字符串内、一次在
 *   模板外残留的副本里），脚本改到了不该改的地方，还把模板字符串的闭合反引号
 *   转义掉了 —— 结果 `MODEL_CHECK_SECTION` 一路吞掉了整个 `apply` 实现，
 *   文件里出现两份 `export function apply`，语法直接崩。
 *
 * 这个测试检查的就是那类结构问题：重复定义、模板闭合位置、括号配平。
 * 改完源码立刻跑它，比等到运行时发现要早得多。
 *
 *   node tests/verify_source_structure.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

function countAll(text, needle) {
  const at = []
  let i = -1
  while ((i = text.indexOf(needle, i + 1)) >= 0) at.push(i)
  return at
}

/* ═══ 检查 lib/index.js ═══ */
console.log('=== 1. lib/index.js 结构 ===')
{
  const p = path.join(PKG, 'lib', 'index.js')
  const t = fs.readFileSync(p, 'utf8')
  const lines = t.split('\n')
  console.log('  ' + lines.length + ' 行 · ' + t.length + ' 字符')

  /* 顶层定义不能重复 —— 重复意味着有一份意外的副本 */
  const mustBeSingle = [
    'const MODEL_CHECK_SECTION',
    'export function apply',
    'function buildStateText',
    'function normalizeConfig',
    'const PLUGIN_VERSION',
    'const PACKAGE_DIR',
  ]
  for (const k of mustBeSingle) {
    const at = countAll(t, k)
    expect('「' + k + '」只出现一次', at.length === 1,
      at.length === 0 ? '没找到' : '出现 ' + at.length + ' 次，行 ' +
        at.map((pos) => t.slice(0, pos).split('\n').length).join(', '))
  }

  /* 模板字符串必须正常闭合，且闭合后紧跟 apply */
  const msIdx = t.indexOf('const MODEL_CHECK_SECTION = `')
  expect('MODEL_CHECK_SECTION 用模板字符串定义', msIdx >= 0, '')
  if (msIdx >= 0) {
    const bodyStart = msIdx + 'const MODEL_CHECK_SECTION = `'.length
    let i = bodyStart
    let end = -1
    while (i < t.length) {
      if (t[i] === '`') {
        let bs = 0
        let k = i - 1
        while (k >= 0 && t[k] === '\\') { bs++; k-- }
        if (bs % 2 === 0) { end = i; break }
      }
      i++
    }
    expect('模板字符串有闭合反引号', end > 0, '找不到闭合')
    if (end > 0) {
      const after = t.slice(end, end + 80)
      expect('闭合后紧接着 apply 定义', /^`\s*\n\s*\nexport function apply/.test(after),
        JSON.stringify(after.slice(0, 60)))
      const bodyLen = end - bodyStart
      console.log('    模板内容 ' + bodyLen + ' 字符')
      /* 模板不会太长：超过 5 万字符说明可能又吞掉了代码 */
      expect('模板长度合理（< 50000 字符）', bodyLen < 50000, String(bodyLen))
    }
  }

  /* 括号配平（粗检：统计数量） */
  const opens = (t.match(/\{/g) || []).length
  const closes = (t.match(/\}/g) || []).length
  console.log('    { ' + opens + '  } ' + closes)
  expect('花括号数量接近配平', Math.abs(opens - closes) <= 2,
    opens + ' vs ' + closes)
}

/* ═══ 检查 lib/tools.mjs ═══ */
console.log('\n=== 2. lib/tools.mjs 结构 ===')
{
  const p = path.join(PKG, 'lib', 'tools.mjs')
  const t = fs.readFileSync(p, 'utf8')
  const lines = t.split('\n')
  console.log('  ' + lines.length + ' 行')

  for (const k of ['export function buildTools', 'export function sanitizeJson']) {
    const at = countAll(t, k)
    expect('「' + k + '」只出现一次', at.length === 1, '出现 ' + at.length + ' 次')
  }
  expect('含 model_loop 工具定义', t.includes("name: 'model_loop'"), '')
  expect('含 model_review 工具定义', t.includes("name: 'model_review'"), '')

  const opens = (t.match(/\{/g) || []).length
  const closes = (t.match(/\}/g) || []).length
  expect('花括号数量接近配平', Math.abs(opens - closes) <= 2, opens + ' vs ' + closes)
}

/* ═══ 检查 preset 配置 ═══ */
console.log('\n=== 3. cordis.patch.yml ===')
{
  const p = path.join(PKG, 'cordis.patch.yml')
  const raw = fs.readFileSync(p, 'utf8')
  const buf = fs.readFileSync(p)
  expect('没有 BOM', !(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF), '')
  expect('含 preset-modeling', raw.includes('preset-modeling'), '')
  expect('含 ptc-model-check 行', raw.includes("@local/ptc-model-check"), '')
  /* 呈现模式：必须是 native（ptc 需要 ptcRuntime，本部署没有） */
  expect('呈现模式是 native', /mode:\s*native/.test(raw),
    '当前: ' + ((raw.match(/mode:\s*(\w+)/) || [])[1] || '未找到'))
}

/* ═══ 检查没有残留的旧措辞 ═══ */
console.log('\n=== 4. 旧措辞已清理 ===')
{
  const t = fs.readFileSync(path.join(PKG, 'lib', 'index.js'), 'utf8')
  /* 这些是实测压制了批量建模效率的说法，已改成按重复规律选工具 */
  for (const old of ['不要自己写脚本做', '只有这三种情况才算合理', '只是因为「写脚本更自由」']) {
    expect('已清除「' + old + '」', !t.includes(old), '还残留')
  }
  expect('自主脚本适用于单件、批量和材质节点',
    /优先让模型用 execute_python.*自主编写[\s\S]*单件、批量、参数化和材质节点/.test(
      fs.readFileSync(path.join(PKG, 'lib/core/workflow.mjs'), 'utf8')), '')
}

console.log('\n' + (failed === 0 ? 'SOURCE_STRUCTURE_OK' : 'SOURCE_STRUCTURE_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
