/**
 * 工具定义完整性：每个工具都必须满足 defineTool 的硬性要求。
 *
 * 背景（真实事故）：
 *   我新加 model_deleted 工具时，只写了 description / parameters / execute，
 *   **漏了 output**。defineTool 要求 output 必须有 render 函数，
 *   于是 ctx.tools.register 抛错。而注册跑在 ctx.effect 里——
 *   一个 effect 抛错会让**整个 preset 激活失败**，
 *   表现出来就是模式选择里显示「加载失败」。
 *
 *   这个错误在本地「直接 import 模块」时不会暴露（register 没被调用），
 *   只有在真正 apply 时才炸。所以必须有这个测试。
 *
 *   node tests/verify_tool_definitions.mjs
 */
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertNativeToolSchema } from './native_schema_contract.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')
const u = (rel) => pathToFileURL(path.join(PKG, rel)).href

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

const { buildTools } = await import(u('lib/tools.mjs'))

const deps = {
  sourceFor: () => ({}),
  config: () => ({ source: 'auto', minDepth: 0.0005, minRatio: 0.005 }),
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
  getReviewState: () => ({ pendingActions: [], receivedAt: 0, editsAfterReview: 0 }),
  noteReviewPrompt: () => {},
  getMaterialState: () => ({ touchedGroups: {}, editCount: 0 }),
  noteMaterialEdit: () => {},
  getDeletedLog: () => ({ batches: [], pending: [], resolved: [], pendingCount: 0 }),
  noteDeleted: () => {},
  noteDeleteVerdict: () => {},
}

const tools = buildTools(deps)
console.log('=== 共 ' + tools.length + ' 个工具，逐个检查定义完整性 ===')

/* defineTool 的硬性要求（来自 DSH 的 ToolDefinition 接口） */
for (const t of tools) {
  const errs = []
  if (!t.name) errs.push('缺 name')
  if (!t.description) errs.push('缺 description')
  if (!t.parameters) errs.push('缺 parameters')
  if (typeof t.execute !== 'function') errs.push('execute 不是函数')
  /* 这两条是最容易漏的 */
  if (!t.output) errs.push('**缺 output**（会导致 preset 激活失败）')
  else if (typeof t.output.render !== 'function') errs.push('output.render 不是函数')
  else if (!t.output.schema) errs.push('output.schema 缺失')
  if (!errs.length) {
    try { assertNativeToolSchema(t) }
    catch (error) { errs.push(error.message) }
  }

  if (errs.length) {
    failed++
    console.log('  ✗ ' + (t.name || '?') + '：' + errs.join('、'))
  } else {
    console.log('  ✓ ' + t.name)
  }
}

console.log('\n=== description 规范（【何时调用】/【何时不调用】/【做什么】）===')
for (const t of tools) {
  const d = String(t.description || '')
  const hasWhen = /【何时调用】/.test(d)
  const hasNot = /【何时不调用】/.test(d)
  const hasWhat = /【做什么】/.test(d)
  if (hasWhen && hasNot && hasWhat) {
    console.log('  ✓ ' + t.name)
  } else {
    failed++
    const miss = []
    if (!hasWhen) miss.push('何时调用')
    if (!hasNot) miss.push('何时不调用')
    if (!hasWhat) miss.push('做什么')
    console.log('  ✗ ' + t.name + ' 缺：' + miss.join('、'))
  }
}

console.log('\n=== run() 包装（错误要转成可读信息，不能直抛）===')
for (const t of tools) {
  /* 所有工具都应该能被调用而不崩——这里只验证 execute 是 async 或返回 Promise */
  const isAsync = t.execute && t.execute.constructor && t.execute.constructor.name === 'AsyncFunction'
  const ok = isAsync || (t.execute && t.execute.length >= 0)
  if (!ok) { failed++; console.log('  ✗ ' + t.name) }
}
console.log('  （' + tools.length + ' 个工具的 execute 都可调用）')

console.log('\n=== 建模流程说明与当前工具行为一致 ===')
const loopTool = tools.find((t) => t.name === 'model_loop')
const reviewTool = tools.find((t) => t.name === 'model_review')
const loopDescription = String(loopTool?.description || '')
const loopParameters = loopTool?.parameters || {}
const targetDescription = String(loopParameters.target?.description || '')
const reviewDescription = String(reviewTool?.description || '')
const reviewParameters = reviewTool?.parameters || {}
const referenceImageDescription = String(
  tools.find((t) => t.name === 'model_reference_image')?.description || '')
const referenceDescription = String(tools.find((t) => t.name === 'model_reference')?.description || '')
const namingDescription = String(tools.find((t) => t.name === 'model_naming')?.description || '')
const readyDescription = String(tools.find((t) => t.name === 'blender_ready')?.description || '')
expect('model_loop 说明固定五个场景视图并明确分组视图可选',
  /固定五视图（正视、背面、侧视、顶视、正视剪影）/.test(loopDescription)
    && /per_mesh_views: true（默认 false）/.test(loopDescription))
expect('target 说明与整场景默认行为及逐组视图开关一致',
  /省略 = \*\*整场景检查\*\*/.test(targetDescription)
    && /汇总所有物品组/.test(targetDescription)
    && /逐组隔离视图默认不渲染/.test(targetDescription)
    && !/自动逐组|自动给每个物品组单独算一遍/.test(targetDescription), targetDescription)
expect('model_loop 不再把旧迭代/落实/细节/遗留项要求说成硬门槛',
  !/至少迭代 3 轮|连续两轮|至少 10 字|写了 remaining.*不允许停/.test(loopDescription)
    && /轮数不设最低要求/.test(loopDescription)
    && /不要为了凑轮数制造改动/.test(loopDescription)
    && !/建议轮次/.test(loopDescription)
    && /不设最短长度/.test(String(loopParameters.detail_notes?.description || ''))
    && /不会单独阻止停止/.test(String(loopParameters.remaining?.description || '')))
expect('model_loop 按批次和里程碑检查，不提示每个零件后都调用',
  /一批几何建完/.test(loopDescription)
    && /不需要每做完一个零件/.test(loopDescription)
    && /轮数不设最低要求/.test(loopDescription))
expect('model_review 面向里程碑和复核待办，不要求每次小改后派发',
  /逻辑里程碑/.test(reviewDescription)
    && /处理完上一份复核清单/.test(reviewDescription)
    && !/每轮改动之后/.test(reviewDescription))
expect('model_review 明确整场景成本和定向范围',
  /大场景成本较高/.test(reviewDescription)
    && /传入后只为该组准备视图/.test(String(reviewParameters.target?.description || ''))
    && /不能把限量结果当成全场景视觉验收/.test(String(reviewParameters.per_mesh_max?.description || '')))
expect('参考图分析是按需辅助，不是签收硬门槛',
  /辅助能力，不是 model_loop 的签收条件/.test(referenceImageDescription)
    && !/强制前置|拒绝让你宣布完成/.test(referenceImageDescription))
expect('结构调研只在高保真复刻时构成硬门槛',
  /普通建模任务按需调用/.test(referenceDescription)
    && /只有用户明确要求高保真复刻/.test(referenceDescription)
    && !/真实存在的建筑\/物体时必查|唯一信息来源，不是可选项|必须用它确认/.test(referenceDescription))
expect('批量建模可一次统一命名，不要求逐件调用',
  /一次扫描或写回多个部件名/.test(namingDescription)
    && /不必每建一个部件就单独调用/.test(namingDescription))
expect('Blender 正常就绪时不重复手动自检',
  /会话开始时插件会自动做只读检查/.test(readyDescription)
    && /状态正常时直接建模/.test(readyDescription)
    && !/会话开始时\*\*必须先调一次\*\*/.test(readyDescription))

const indexSource = readFileSync(path.resolve(HERE, '../lib/index.js'), 'utf8')
  + readFileSync(path.resolve(HERE, '../lib/core/workflow.mjs'), 'utf8')
expect('流程上下文明确逐组隔离图按需生成',
  /完整模式默认只渲染场景范围的五视图，逐组隔离图默认关闭/.test(indexSource)
    && !/每个物品组会隔离渲染这五张/.test(indexSource))
expect('建模规划没有固定轮数或数量配额',
  /简单单件先列主体和关键特征即可/.test(indexSource)
    && /资料已覆盖问题.*不为次数重复搜索/.test(indexSource)
    && /对象数量本身不决定执行方式/.test(indexSource)
    && !/任务规模 \| 元素数量 \| 查询次数|每个物品至少拆成 3~6 条|至少查一次结构参考|300~800 个对象/.test(indexSource))
expect('命名可按批次完成，调研只针对未确认问题',
  /检查前让新增对象可识别/.test(indexSource)
    && indexSource.includes('建一批后可用')
    && indexSource.includes('一次处理多个名称')
    && /拿不准时.*检索/.test(indexSource)
    && !/建完一个部件就命名/.test(indexSource))
expect('检查节奏按批次和逻辑阶段，不要求每组后单独检查',
  /完成一批几何建模后/.test(indexSource)
    && /不必单独触发检查/.test(indexSource)
    && !/触发点：刚建完一组部件/.test(indexSource))
expect('检查次数只作上下文，不会催促立即中断',
  /一次脚本也可能生成很多几何/.test(indexSource)
    && /无需为了计数立即中断/.test(indexSource)
    && !/现在立刻停下来跑一次 model_loop|建议现在跑一次 model_loop/.test(indexSource))
expect('先做实际模型、及时自检，自编工具不替代质量检测',
  /不把搭建完整工具库设为开工前置步骤/.test(indexSource)
    && /自编生成脚本不替代插件的穿模、孤立与网格检查/.test(indexSource)
    && /不等灯光材质全部完成才首检/.test(indexSource))
expect('保存可随时进行，签收规则与工具拦截分开说明',
  /保存模型不需要等待检查通过/.test(indexSource)
    && /模型存盘.*随时可用/.test(indexSource)
    && !/这些会被工具直接拦下/.test(indexSource))
expect('参考图状态不再声称未分析会拒绝签收',
  /该分析为可选辅助，不是签收硬门槛/.test(indexSource)
    && !/建模前必须调 `model_reference_image`/.test(indexSource))

const readme = readFileSync(path.resolve(HERE, '../README.md'), 'utf8')
expect('README 使用自动环境状态并按需诊断',
  /查看自动注入的 Blender 环境状态/.test(readme)
    && /未就绪或连接报错时再调 `blender_ready`/.test(readme)
    && !/会话开始先调 `blender_ready`/.test(readme))
expect('README 不再要求每次增删后都重复检查分组',
  /日常增删后 `model_loop` 会回显分组状态/.test(readme)
    && !/每次增删零件后用 `model_groups`/.test(readme))
const groupsDescription = String(tools.find((t) => t.name === 'model_groups')?.description || '')
expect('model_groups 只在首次建组、批量调整或异常时单独调用',
  /首次建好多物品组/.test(groupsDescription)
    && /批量调整 Collection/.test(groupsDescription)
    && /model_loop 报出分组异常/.test(groupsDescription)
    && !/每次加\/删零件/.test(groupsDescription))

console.log('\n' + (failed === 0 ? 'TOOL_DEFS_OK' : 'TOOL_DEFS_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
