/**
 * 独立上下文守卫：建模模式不许被外部内容污染。
 *
 * 背景（用户明确要求）：
 *   「让这个插件有独立的上下文，拒绝长期记忆和 agent 手册的写入和注入」
 *
 * 建模模式的行为应该**只由本插件决定**。以下三类外部内容一律不许进来：
 *
 *   ① agent 手册（AGENTS.md / CLAUDE.md）
 *      由 @deepseek-ai/dsh-agent-instructions 加载。
 *      那些文件是给**代码 agent** 写的（怎么改代码、怎么提 PR、
 *      用什么提交格式），和建模毫无关系，还会随工作区变化，
 *      导致同一份建模流程在不同目录下表现不一致。
 *
 *   ② 技能 / 长期记忆（skill catalog）
 *      由 @deepseek-ai/dsh-skill-filesystem + @deepseek-ai/dsh-tool-skill 提供。
 *      技能是跨会话累积的经验，会随着使用越来越长，
 *      而且内容不可控——对「每次都要走同一条建模路径」的模式是噪音。
 *
 *   ③ 开发上下文（harness dev context / tmux context）
 *      这些是给调试 DSH 本身用的，更不该进建模模式。
 *
 * 这个测试**只读 cordis.patch.yml**，检查上述插件都不在生效状态。
 * 跑得很快，适合放进每次改动后的回归。
 *
 *   node tests/verify_independent_context.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')
const YML = path.join(PKG, 'cordis.patch.yml')

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

const text = fs.readFileSync(YML, 'utf8')
const lines = text.split('\n')

/* 收集所有「生效」的插件名（跳过注释行） */
const activeNames = []
const activeIds = []
for (const line of lines) {
  const t = line.trim()
  if (t.startsWith('#')) continue
  const mName = t.match(/^-?\s*name:\s*'([^']+)'/)
  const mId = t.match(/^-?\s*id:\s*([A-Za-z0-9_-]+)/)
  if (mName) activeNames.push(mName[1])
  if (mId) activeIds.push(mId[1])
}

console.log('=== ① agent 手册不许注入 ===')
{
  const banned = '@deepseek-ai/dsh-agent-instructions'
  const on = activeNames.includes(banned)
  expect('dsh-agent-instructions 不在生效列表', !on, on ? '它会把 AGENTS.md 注入上下文' : '')
  /* 确认它确实被写成了注释（而不是整个删掉、以后没人知道为什么没有） */
  const mentioned = text.includes(banned)
  expect('文件里仍保留说明（注释形式）', mentioned,
    mentioned ? '' : '删干净了会让后来人不知道为什么没有手册')
}

console.log('\n=== ② 技能 / 长期记忆不许注入 ===')
for (const banned of [
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-tool-skill',
]) {
  const on = activeNames.includes(banned)
  expect(banned.split('/')[1] + ' 不在生效列表', !on, on ? '技能会跨会话累积，污染建模流程' : '')
}

console.log('\n=== ③ 开发上下文不许注入 ===')
for (const banned of [
  '@deepseek-ai/dsh-harness-dev-context',
  '@deepseek-ai/dsh-tmux-context',
]) {
  const on = activeNames.includes(banned)
  expect(banned.split('/')[1] + ' 不在生效列表', !on, '')
}

console.log('\n=== ④ 该保留的必须还在 ===')
/* persona 提供建模人格，是我们要的 */
expect('persona 仍在（建模人格）', activeNames.includes('@deepseek-ai/dsh-persona'),
  '这是本模式的身份，不能丢')
/* time-context 只给时间，无害且有用 */
expect('time-context 仍在（当前时间）', activeNames.includes('@deepseek-ai/dsh-time-context'), '')
/* 本插件自己当然要在 */
expect('ptc-model-check 仍在', activeNames.includes('@local/ptc-model-check'), '')

console.log('\n=== ⑤ 上下文注入源清点 ===')
/* 把所有可能注入上下文的插件列出来，确认只剩预期的那些 */
const INJECTORS = [
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/dsh-agent-instructions',
  '@deepseek-ai/dsh-time-context',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-tool-skill',
  '@deepseek-ai/dsh-harness-dev-context',
  '@deepseek-ai/dsh-tmux-context',
]
const activeInjectors = INJECTORS.filter((x) => activeNames.includes(x))
console.log('  生效的注入源：' + (activeInjectors.length ? activeInjectors.join(', ') : '无'))
const ALLOWED = ['@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-time-context']
const unexpected = activeInjectors.filter((x) => !ALLOWED.includes(x))
expect('没有预期之外的注入源', unexpected.length === 0, unexpected.join(', '))

console.log('\n=== ⑥ YAML 结构完好 ===')
expect('没有 tab 字符', !/\t/.test(text), 'YAML 禁用 tab')
{
  let odd = 0
  for (const l of lines) {
    if (!l.trim() || l.trim().startsWith('#')) continue
    const m = l.match(/^ */)
    if (m && m[0].length % 2 !== 0) odd++
  }
  expect('缩进都是偶数', odd === 0, odd + ' 行奇数缩进')
}
expect('有 preset-modeling 声明', text.includes('preset-modeling'), '')
expect('有 insert 段', text.includes('insert:'), '')

/* persona 前缀是一条很长的普通标量（末尾带审美测试声明）。普通标量里出现
 * ASCII 冒号+空格会被 YAML 当成映射、出现「 #」会被当成注释起点，整行会
 * 静默变形而不报错——所以这里按住格式，改文案时别加这两个字符。 */
{
  const prefixLine = lines.find((l) => l.trim().startsWith('prefix: ')) || ''
  const val = prefixLine.slice(prefixLine.indexOf('prefix: ') + 'prefix: '.length)
  expect('persona prefix 是非空标量', val.length > 0, '')
  expect('prefix 里没有 ASCII 冒号+空格', !/: /.test(val), '')
  expect('prefix 里没有注释起点的「 #」', !/ #/.test(val), '')
  expect('prefix 里没有制表符', !/\t/.test(val), '')
  expect('prefix 带审美测试声明', val.includes('极致的审美测试任务'), '')
  expect('prefix 保留限定从句', val.includes('该声明只要求不因预算'), '')
}

console.log('\n' + (failed === 0 ? 'INDEPENDENT_CONTEXT_OK' : 'INDEPENDENT_CONTEXT_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
