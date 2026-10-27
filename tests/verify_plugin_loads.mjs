/**
 * 插件加载自检：包结构、版本一致性、模块可加载、工具注册、上下文关键内容。
 *
 *   node tests/verify_plugin_loads.mjs
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')
/* Windows 上 import 需要 file:// URL */
const u = (rel) => pathToFileURL(path.join(PKG, rel)).href

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

console.log('=== 1. package.json 合法性 ===')
let ver = null
{
  const raw = fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')
  let ok = true
  try {
    const o = JSON.parse(raw)
    ver = o.version
  } catch (e) { ok = false }
  /* 检查控制字符——GBK 转码事故会留下坏字符 */
  let badChar = 0
  for (const ch of raw) {
    const c = ch.codePointAt(0)
    if (c < 0x20 && ch !== '\n' && ch !== '\r' && ch !== '\t') { badChar = c; break }
  }
  expect('JSON 可解析', ok, '解析失败')
  expect('无非法控制字符', !badChar, '发现 U+' + (badChar || 0).toString(16))
  expect('版本号格式合法', /^\d+\.\d+\.\d+$/.test(String(ver)), String(ver))
}

console.log('\n=== 2. 版本一致性 ===')
{
  const idx = fs.readFileSync(path.join(PKG, 'lib', 'index.js'), 'utf8')
  const m = idx.match(/const PLUGIN_VERSION = '([^']+)'/)
  expect('lib/index.js 有 PLUGIN_VERSION 常量', !!m, '没找到')
  expect('两处版本一致', m && m[1] === ver, 'index.js=' + (m && m[1]) + ' package.json=' + ver)
  console.log('  version: ' + ver)
}

console.log('\n=== 3. 核心模块可加载 ===')
for (const m of ['core/geometry.mjs', 'core/grouping.mjs', 'core/iteration.mjs',
  'core/precision.mjs', 'core/review.mjs', 'core/reality.mjs', 'core/color.mjs',
  'core/research.mjs', 'core/review-provenance.mjs',
  'core/png.mjs', 'core/subject.mjs', 'core/segment.mjs', 'core/adaptive.mjs',
  'core/planning.mjs', 'core/pbr-sources.mjs', 'core/workflow.mjs', 'core/detail.mjs']) {
  let ok = true, err = ''
  try { await import(u('lib/' + m)) } catch (e) { ok = false; err = String(e.message).slice(0, 120) }
  expect(m + ' 可加载', ok, err)
}
{
  let ok = true, detail = ''
  try {
    const entry = await import(u('lib/index.js'))
    ok = typeof entry.apply === 'function'
    if (!ok) detail = '没有导出 apply'
  } catch (e) {
    const hostDependencyMissing = e.code === 'ERR_MODULE_NOT_FOUND'
      && String(e.message).includes("package '@deepseek-ai/dsh-tools'")
    if (hostDependencyMissing) {
      try { execFileSync(process.execPath, ['--check', path.join(PKG, 'lib', 'index.js')]) }
      catch (syntaxError) { ok = false; detail = String(syntaxError.message).slice(0, 160) }
      if (ok) detail = '宿主 peer dependency 未安装；入口语法检查通过'
    } else {
      ok = false
      detail = String(e.message).slice(0, 160)
    }
  }
  expect('插件入口可解析（宿主依赖可用时同时验证导入）', ok, detail)
}

/* 公共 deps：几个测试块共用 */
function makeDeps(over = {}) {
  return {
    sourceFor: () => ({}),
    config: () => ({ source: 'auto', blend: '', obj: '', url: '', cdpPort: 0,
      targetMatch: '', blenderPath: '', minDepth: 0.0005, minRatio: 0.005,
      maxObjects: 3000, maxTriangles: 2000000 }),
    remember: () => {},
    hostCtx: { get: () => undefined },
    getRefState: () => ({ given: false, analyzed: false }),
    markRefAnalyzed: () => {},
    getPhaseState: () => ({ modelingComplete: false }),
    markModelingComplete: () => {},
    resetPhase: () => {},
    getModelingState: () => ({ dirtySinceCheck: false, editCount: 0, lookSinceEdit: 0 }),
    noteCheck: () => {},
    noteModelingEdit: () => {},
    noteReviewResult: () => {},
    getReviewState: () => ({ pendingActions: [], receivedAt: 0, editsAfterReview: 0, lastPromptAt: 0, lastSubagentAt: 0 }),
    noteReviewPrompt: () => {},
    getMaterialState: () => ({ touchedGroups: {}, editCount: 0 }),
    noteMaterialEdit: () => {},
    getDeletedLog: () => ({ batches: [], pending: [], resolved: [], pendingCount: 0 }),
    noteDeleted: () => {},
    noteDeleteVerdict: () => {},
    ...over,
  }
}

console.log('\n=== 4. 工具注册 ===')
{
  const { buildTools } = await import(u('lib/tools.mjs'))
  const tools = buildTools(makeDeps())
  /* v2.18 删掉了 model_check 和 model_interference——
   * 它们的功能被 model_loop 完全覆盖，提示词里也从未提及。 */
  expect('11 个工具', tools.length === 11, String(tools.length))
  for (const name of ['model_groups', 'model_loop', 'model_review', 'model_deleted',
    'model_isolation', 'model_naming',
    'model_source', 'model_pbr_search', 'model_reference', 'model_reference_image',
    'blender_ready']) {
    expect('含 ' + name, tools.some((t) => t.name === name))
  }
  /* 明确确认这两个已删除，防止将来误加回来 */
  expect('不含 model_check（已并入 model_loop）',
    !tools.some((t) => t.name === 'model_check'))
  expect('不含 model_interference（已并入 model_loop）',
    !tools.some((t) => t.name === 'model_interference'))
}

console.log('\n=== 5. 删除守卫工具可用 ===')
{
  const { buildTools } = await import(u('lib/tools.mjs'))
  const tools = buildTools(makeDeps())
  const t = tools.find((x) => x.name === 'model_deleted')
  expect('model_deleted 存在', !!t, '没找到')
  expect('有 list/verdict 两个 action',
    !!t && !!t.parameters && !!t.parameters.action, '')
  expect('有 decision 参数',
    !!t && !!t.parameters && !!t.parameters.decision, '')
}

console.log('\n=== 6. 上下文关键内容 ===')
{
  const t = fs.readFileSync(path.join(PKG, 'lib', 'core', 'workflow.mjs'), 'utf8')
  const need = ['todo_write', 'model_reference', 'model_reference_image',
    'model_naming', 'model_groups', 'model_loop', 'model_review', 'model_deleted',
    'quick_check: true', "reviewer: 'self'", 'stop_reason', 'Boolean', 'Bevel', 'GLB', 'Backfacing']
  for (const k of need) expect('含「' + k + '」', t.includes(k))
}

console.log('\n' + (failed === 0 ? 'PLUGIN_LOADS_OK' : 'PLUGIN_LOADS_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
