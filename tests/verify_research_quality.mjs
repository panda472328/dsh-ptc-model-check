/**
 * 「空结果不算有效调研」回归测试。
 *
 * 背景（用户亲自发现的真 bug）：
 *   模型确实调了 3 次 model_reference，计数器显示「调研完成 3/3」。
 *   但每次返回的 snippet 全是 null、excerpts 全是 []，
 *   只有标题和链接，没有一句正文。构件组成还是靠自己常识补的。
 *
 * 两层 bug：
 *   ① 代码读 res.content —— DSH 的 web.search 根本不返回这个字段，
 *      正确字段是 res.answer 和 sources[].snippet。所以摘要永远是空的。
 *   ② 门禁只数「调用次数」，不校验「有没有拿到内容」。
 *      结果：空调 3 次空结果就能过关，比不调更糟。
 *
 * 这个测试守住：
 *   ① 空结果（只有标题链接）不计入有效次数
 *   ② 有 answer 或实质 snippet 才算有效
 *   ③ 门禁用 effectiveCount 而不是 calls
 *
 *   node tests/verify_research_quality.mjs
 */
import fs from 'node:fs'

let failed = 0
const expect = (label, cond, detail) => {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 160) : '')) }
}

const PKG = 'D:/dsh插件制作/ptc-model-check'
const idx = fs.readFileSync(PKG + '/lib/index.js', 'utf8')
const tools = fs.readFileSync(PKG + '/lib/tools.mjs', 'utf8')
const iteration = fs.readFileSync(PKG + '/lib/core/iteration.mjs', 'utf8')

console.log('=== ① 代码必须读对 DSH 的字段 ===')
{
  /* DSH web.search 返回 { sources, answer?, truncated }，
   * 每条 source 有 { title, url, snippet?, publishedAt? }。
   * 读 res.content 是错的——那个字段不存在。 */
  expect('不再读不存在的 res.content', !/res\.content/.test(tools), '')
  expect('读 res.answer', /res\.answer/.test(tools), '')
  expect('读 sources[].snippet', /s\.snippet|\.snippet/.test(tools), '')
}

console.log('\n=== ② 空结果要明确告知，不能假装查到了 ===')
{
  expect('有「这次没有拿到正文」的提示', tools.includes('这次没有拿到正文'), '')
  expect('提示换词重查', /换更具体的结构词重查/.test(tools), '')
  expect('提示用 deep 模式', /depth.*deep|deep.*抓正文/.test(tools), '')
  expect('明确说「只有链接不算查到」', /只有链接不算/.test(tools), '')
}

console.log('\n=== ③ 门禁必须看「有效次数」而不是「调用次数」 ===')
{
  expect('researchState 有 effectiveCount', idx.includes('effectiveCount'), '')
  expect('researchState 有 emptyCount', idx.includes('emptyCount'), '')
  expect('noteResearch 判断有效性', /let effective = false/.test(idx), '')
  /* 现在的实现是「把所有文本收集起来统一判断」，
   * 而不是分别给 answer / snippet 设长度门槛。
   * 所以断言改成检查新的判据。 */
  expect('有统一的长度门槛', /const longEnough = howMuch >= \d+/.test(idx), '')
  expect('有关键词收集逻辑', /collected = parts\.join/.test(idx), '')
  expect('有结构词正则', /STRUCT_TERMS/.test(idx), '')
  expect('结构词覆盖斗拱', /斗拱/.test(idx), '')
  expect('结构词覆盖飞扶壁', /飞扶壁/.test(idx), '')
  expect('satisfied 用 effectiveCount', /satisfied: researchState\.effectiveCount >= researchState\.required/.test(idx), '')
  expect('门禁传 effectiveCount', /researchCalls: research\.effectiveCount/.test(tools), '')
}

console.log('\n=== ④ 记账必须能拿到返回值（移到 tools/result） ===')
{
  expect('noteResearch 在 tools/result 里调用', /noteResearch\(q, v\)/.test(idx), '')
  expect('pre-execute 里已删掉只记次数的调用', !/noteResearch\(q\)/.test(idx), '')
  expect('代码里说明了为什么用 tools/result', /pre-execute 只能拿到调用参数/.test(idx), '')
}

console.log('\n=== ⑤ 状态行要显示「有效次数」和空结果警告 ===')
{
  expect('显示有效资料覆盖状态', /有效资料 ' \+ eff \+ '\/' \+ rs\.required/.test(idx), '')
  expect('有空结果时单独警告', /只拿到标题和链接、没有正文/.test(idx), '')
  expect('说明调研门槛仅适用于明确的高保真复刻', /只对用户明确要求高保真复刻的任务构成签收条件/.test(idx), '')
  expect('普通任务调研按需，不作为签收条件', /结构调研：按需调用，不是签收条件/.test(idx), '')
}

console.log('\n=== ⑥ 门禁文案要说清「空的」不算 ===')
{
  expect('blocker 说明需要有效结构资料', /有效的构件组成\/连接资料/.test(iteration), '')
  expect('blocker 给出补救方式', /model_reference/.test(iteration), '')
}

console.log('\n=== ⑦ 相关性判定（防跑题）===')
{
  expect('有结构词列表', /STRUCT_TERMS/.test(idx), '')
  expect('查询和返回都要检查结构词', /queryHasStructWord/.test(idx) && /responseHasStructWord/.test(idx), '')
  expect('有跑题计数', /offTopicCount/.test(idx), '')
  expect('状态行提示跑题', /内容跑题/.test(idx), '')
  expect('提示改具体结构词', /斗拱 构件 名称 排列/.test(idx), '')
}

console.log('\n' + (failed === 0 ? 'RESEARCH_QUALITY_OK' : 'RESEARCH_QUALITY_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
