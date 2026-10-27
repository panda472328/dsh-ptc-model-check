/** 从实际上下文注入和工具钩子验证签收、回修、预览、合并与调研依赖。 */
import assert from 'node:assert/strict'
import { makeMesh } from '../lib/core/geometry.mjs'
import { createHostFixture } from './host_fixture.mjs'

const mesh = makeMesh('A', 'A', new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  new Uint32Array([0, 1, 2]), { collections: ['物品'] })
const host = await createHostFixture([mesh])
const loop = (args) => host.tools.get('model_loop').execute(args, {})
try {
  assert.ok(host.staticText.length < 6500, 'the actual injected static context stays bounded')
  assert.match(host.staticText, /硬表面/)
  assert.match(host.staticText, /reviewer: 'self'/)
  assert.match(host.staticText, /重新打开实际导出的文件/)
  assert.doesNotMatch(host.staticText, /绝对不要把零件 join|建模就此冻结|同时派出去/)
  assert.equal(host.native('add_primitive').kind, 'next')
  assert.equal(host.native('render_preview').kind, 'next', 'process previews remain available before inspection')
  assert.equal(host.native('save_blend').kind, 'next')
  assert.equal(host.native('export_file').kind, 'deny', 'unchecked edits still require an inspection before export')
  await loop({ target: 'A', verdict: 'done', stop_reason: '局部完成' })
  assert.equal(host.native('export_file').kind, 'deny', 'local inspection cannot clear the scene dirty state')
  await loop({ verdict: 'done', stop_reason: '整场景技术检查完成' })
  assert.equal(host.native('export_file').kind, 'next')
  assert.doesNotMatch(host.runtime(), /默认自主细化：|自主细化下一步：/)
  assert.equal(host.native('bevel').kind, 'next')
  assert.match(host.runtime(), /旧签收后又有场景改动/)
  assert.match(host.runtime(), /自主细化下一步：/)
  assert.equal(host.native('export_file').kind, 'deny', 'editing after signoff invalidates the old inspection')
  assert.equal(host.native('join_objects', { names: ['part-1', 'part-2'] }).kind, 'next')
  assert.match(host.runtime(), /合并提醒/)
  await loop({ quick_check: true, verdict: 'continue', next_improvement: '检查着色' })
  assert.doesNotMatch(host.runtime(), /合并提醒/)
  assert.equal(host.native('execute_python', { code: "print(','.join(['a', 'b']))" }).kind, 'next')
  assert.doesNotMatch(host.runtime(), /合并提醒/, 'string joins do not create geometry-merge warnings')
  assert.equal(host.native('execute_python', {
    code: "import bpy\nbpy.ops.wm.obj_export(filepath='scene.obj')",
  }).kind, 'deny', 'direct Python exports use the checked export_file path')

  host.emit('agent/pre-step', { messages: [{ role: 'user', content: [{ type: 'text', text: '高保真复刻巴黎圣母院' }] }] }, () => {})
  const blocked = await loop({ verdict: 'done', stop_reason: '尝试签收' })
  assert.equal(blocked.stopped, false)
  assert.match(blocked.stopBlockers.join('\n'), /结构调研没做完/,
    'the host passes its real research state into model_loop')
  host.emit('tools/result', { name: 'model_reference', arguments: { query: '巴黎圣母院 飞扶壁 结构' } }, {
    answer: '巴黎圣母院的飞扶壁通过外侧支墩和拱券承接高侧墙的侧向推力。肋拱将屋顶荷载传递至束柱，主廊、侧廊与扶壁构成相互支撑的结构体系，门窗开口需避开主要受力构件。',
  })
  const checked = await loop({ verdict: 'done', stop_reason: '资料已核实，完成技术检查' })
  assert.equal(checked.stopped, true, JSON.stringify(checked.stopBlockers))
  console.log('WORKFLOW_HOST_OK: injected ' + host.staticText.length + ' characters')
} finally {
  host.dispose()
}

const other = makeMesh('B', 'B', new Float64Array([3, 0, 0, 4, 0, 0, 3, 1, 0]),
  new Uint32Array([0, 1, 2]), { collections: ['物品'] })
const failedHost = await createHostFixture([mesh, other])
try {
  failedHost.native('execute_python', { code: 'build_panels()' })
  const check = (args) => failedHost.tools.get('model_loop').execute(args, {})
  const failed = await check({ quick_check: true, verdict: 'continue', next_improvement: '确认板件间距' })
  assert.equal(failed.pass, false, 'the fixture must have unacknowledged isolation hits')
  assert.equal(failedHost.native('export_file').kind, 'deny', 'merely running a failed check cannot permit export')
  assert.match(failedHost.native('export_file').reason, /已经执行过检查/)
  assert.match(failedHost.native('export_file').reason, /重复同一检查不会消除命中/)
  await check({ target: 'A', quick_check: true, verdict: 'continue', next_improvement: '核对范围' })
  assert.equal(failedHost.native('export_file').kind, 'deny', 'a clean local check cannot replace a failed global check')
  const passed = await check({ quick_check: true, verdict: 'continue', next_improvement: '核对外观',
    acknowledge_isolated: ['A', 'B'].map((part) => ({ part, reason: '两块独立展板按设计留有展示间距' })),
  })
  assert.equal(passed.pass, true)
  assert.equal(failedHost.native('export_file').kind, 'next')
  await check({ target: 'A', quick_check: true, verdict: 'continue', next_improvement: '局部观察' })
  assert.equal(failedHost.native('export_file').kind, 'next', 'local inspection without edits preserves the accepted global check')
} finally {
  failedHost.dispose()
}

// 现场回归：检查实际执行后仍说「还没跑过」，且把覆盖不足误算成从未检查。
const overlap = makeMesh('C', 'C', mesh.positions, mesh.indices, { collections: ['物品'] })
const statusHost = await createHostFixture([mesh, overlap])
try {
  const check = (args) => statusHost.tools.get('model_loop').execute(args, {})
  assert.match(statusHost.runtime(), /还没跑过自检/)
  for (let i = 0; i < 12; i++) statusHost.native('execute_python', { code: 'build_parts()' })
  const limited = await check({ quick_check: true, triangle_work_budget: 0,
    verdict: 'continue', next_improvement: '恢复检查覆盖' })
  assert.equal(limited.interference.complete, false)
  let runtime = statusHost.runtime()
  assert.doesNotMatch(runtime, /还没跑过自检/, 'an incomplete attempt still counts as an actual inspection')
  assert.match(runtime, /上次自检.*整场景/)
  assert.match(runtime, /覆盖不完整/)
  assert.doesNotMatch(runtime, /自上次检查以来有 12 次/)
  assert.equal(statusHost.native('export_file').kind, 'deny', 'recording an attempt must not grant export acceptance')

  await check({ target: 'A', quick_check: true, verdict: 'continue', next_improvement: '整场景复查' })
  runtime = statusHost.runtime()
  assert.doesNotMatch(runtime, /还没跑过自检/)
  assert.match(runtime, /局部检查.*不能替代整场景/)
  assert.equal(statusHost.native('export_file').kind, 'deny')
  await check({ quick_check: true, verdict: 'continue', next_improvement: '核对外观' })
  assert.equal(statusHost.native('export_file').kind, 'next')
  statusHost.native('execute_python', { code: 'move_part()' })
  assert.match(statusHost.runtime(), /检查后又有场景改动/)
  assert.equal(statusHost.native('export_file').kind, 'deny')
  console.log('INSPECTION_STATUS_OK: incomplete, local, complete and stale results stay distinct')
} finally {
  statusHost.dispose()
}
