/**
 * 验证「建模 / 贴图硬隔离」门禁。
 *   node tests/verify_phase_gate.mjs
 */

import { makeMesh } from '../lib/core/geometry.mjs'
import { buildTools } from '../lib/tools.mjs'

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

function cubeMesh(id, size, segments) {
  const pos = []
  const idx = []
  const s = size / 2
  const faces = [
    { axis: 0, sign: 1 }, { axis: 0, sign: -1 },
    { axis: 1, sign: 1 }, { axis: 1, sign: -1 },
    { axis: 2, sign: 1 }, { axis: 2, sign: -1 },
  ]
  for (const f of faces) {
    const base = pos.length / 3
    for (let i = 0; i <= segments; i++) {
      for (let j = 0; j <= segments; j++) {
        const u = (i / segments) * 2 - 1
        const v = (j / segments) * 2 - 1
        const p = [0, 0, 0]
        p[f.axis] = f.sign * s
        p[(f.axis + 1) % 3] = u * s
        p[(f.axis + 2) % 3] = v * s
        pos.push(p[0], p[1], p[2])
      }
    }
    for (let i = 0; i < segments; i++) {
      for (let j = 0; j < segments; j++) {
        const a = base + i * (segments + 1) + j
        const b = a + 1
        const c = a + (segments + 1)
        const d = c + 1
        idx.push(a, c, b, b, c, d)
      }
    }
  }
  return makeMesh(id, id, new Float32Array(pos), new Uint32Array(idx))
}

/** 造一个带位置偏移的立方体（法线朝外） */
function boxAt(id, cx, cy, cz, size, seg = 2) {
  const m = cubeMesh(id, size, seg)
  const half = size / 2
  const pos = new Float32Array(m.positions.length)
  for (let i = 0; i < m.positions.length; i += 3) {
    pos[i] = m.positions[i] + cx
    pos[i + 1] = m.positions[i + 1] + cy
    pos[i + 2] = m.positions[i + 2] + cz
  }
  return makeMesh(id, id, pos, m.indices)
}

function denseWall(id, segments) {
  const positions = []
  const indices = []
  for (let x = 0; x <= segments; x++) {
    for (let z = 0; z <= segments; z++) positions.push(x / segments, 0, z / segments)
  }
  const row = segments + 1
  for (let x = 0; x < segments; x++) {
    for (let z = 0; z < segments; z++) {
      const a = x * row + z
      const b = a + 1
      const c = a + row
      const d = c + 1
      indices.push(a, b, c, b, d, c)
    }
  }
  return makeMesh(id, id, new Float32Array(positions), new Uint32Array(indices))
}


function fakeSource(meshes, opts = {}) {
  return {
    describe: () => 'fake',
    async resolve() { return 'blender' },
    async info() { return { meshes: meshes.length } },
    async extract() {
      /* 测试用：给 mesh 补上 collections 元数据，
       * 模拟「已经在 Blender 里建好物品组」的状态——
       * 否则新规则会判分组不可靠，pass 永远是 false。 */
      const withColl = meshes.map((m) => {
        const name = String(m.part || m.id)
        const mm = name.match(/^(.+?)[_\-.|:/\\ ]/)
        const g = mm && mm[1] ? mm[1] : name
        return { ...m, meta: { ...(m.meta || {}), collections: [g] } }
      })
      return { meshes: withColl, skipped: opts.skipped || [], source: 'fake' }
    },
    async namingScan() { return { totalMeshes: meshes.length, named: meshes.length, generic: 0, duplicates: [] } },
    async renderShots(shots) {
      if (opts.metrics) opts.metrics.renderCalls += 1
      return { shots: shots.map((s) => ({ ...s, path: null, why: 'fake' })) }
    },
    async dispose() {},
  }
}

/* 阶段状态：模拟插件的 getPhaseState / markModelingComplete / resetPhase */
function makePhase() {
  const st = { modelingComplete: false, signedOffAt: 0, signoff: null }
  return {
    state: st,
    getPhaseState: () => ({ ...st }),
    markModelingComplete: (s) => { st.modelingComplete = true; st.signoff = s; st.signedOffAt = Date.now() },
    resetPhase: () => { st.modelingComplete = false; st.signoff = null; st.signedOffAt = 0 },
  }
}

const cfg = { maxObjects: 5000, maxTriangles: 3000000, minDepth: 0.0005, minRatio: 0.005 }

function makeTools(meshes, ph, opts = {}) {
  return buildTools({
    sourceFor: () => fakeSource(meshes, opts),
    getReviewState: () => opts.reviewState || null,
    config: () => cfg,
    remember: () => {},
    hostCtx: { get: () => undefined },
    getRefState: () => ({ given: false, analyzed: false }),
    markRefAnalyzed: () => {},
    getPhaseState: ph.getPhaseState,
    markModelingComplete: ph.markModelingComplete,
    resetPhase: ph.resetPhase,
  })
}

async function run(tools, name, args) {
  const t = tools.find((x) => x.name === name)
  try {
    const v = await t.execute(args, { signal: new AbortController().signal })
    const b = t.output.render(args, v)
    return { ok: true, value: v, text: b.filter((x) => x.type === 'text').map((x) => x.text).join('\n') }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
}

console.log('=== 1. 材质资源检索不受建模阶段限制 ===')
{
  const ph = makePhase()
  const tools = makeTools([cubeMesh('A', 2, 4), cubeMesh('B', 2, 4)], ph)

  /* 贴图阶段工具受门禁保护。用 model_pbr_search 做样本——
   * 画风数值工具已删除（预制数值表会让 AI 只会照抄，不去自己判断）。 */
  const r1 = await run(tools, 'model_pbr_search', { query: '木头' })
  expect('model_pbr_search 可用', r1.ok, r1.error)
  expect('检索不冒充几何签收', ph.state.modelingComplete === false)

  const r2 = await run(tools, 'model_pbr_search', { query: '木头' })
  expect('重复资源检索仍可用', r2.ok, r2.error)
}

console.log('\n=== 2. 建模工具不受门禁限制 ===')
{
  const ph = makePhase()
  const tools = makeTools([cubeMesh('A', 2, 4), cubeMesh('B', 2, 4), cubeMesh('C', 2, 4)], ph)

  /* model_check 已在 v2.18 删除（功能并入 model_loop），
   * 这里改用 model_isolation 和 model_loop 验证「建模阶段工具可用」。 */
  const r2 = await run(tools, 'model_isolation', {})
  expect('model_isolation 可用', r2.ok, r2.error)
  const r3 = await run(tools, 'model_loop', { verdict: 'continue', next_improvement: 'x' })
  expect('model_loop 可用', r3.ok, r3.error)
}

console.log('\n=== 2a. 快速检查跳过渲染，done 自动补齐 ===')
{
  const ph = makePhase()
  const metrics = { renderCalls: 0 }
  const tools = makeTools([cubeMesh('单件', 2, 4)], ph, { metrics })
  const quick = await run(tools, 'model_loop', {
    verdict: 'continue', next_improvement: '检查后微调边缘', quick_check: true,
  })
  expect('quick_check 标记已启用', quick.value?.quickCheck === true, JSON.stringify(quick.value))
  expect('快速检查标记没有实际渲染的视图', quick.value?.views?.length === 0, JSON.stringify(quick.value?.views))
  expect('继续迭代时不渲图', metrics.renderCalls === 0, String(metrics.renderCalls))

  const final = await run(tools, 'model_loop', {
    verdict: 'done', stop_reason: '已完成最终检查', quick_check: true,
  })
  expect('done 自动关闭快速模式', final.value?.quickCheck === false, JSON.stringify(final.value))
  expect('done 仍执行完整五视图渲染', metrics.renderCalls === 1, String(metrics.renderCalls))
}

console.log('\n=== 2d. 真正的计算预算不足时不能签收，样本满不会阻断 ===')
{
  const ph = makePhase()
  const tools = makeTools([denseWall('墙A', 48), denseWall('墙B', 48)], ph)
  const result = await run(tools, 'model_loop', {
    verdict: 'done', stop_reason: '尝试签收',
    triangle_pair_work_budget: 64, triangle_work_budget: 256,
  })
  expect('返回真实检测计算预算诊断',
    /达到检测计算预算/.test((result.value?.stopBlockers || []).join('\n')),
    JSON.stringify(result.value?.stopBlockers))
  expect('预算不足时不解锁阶段', ph.state.modelingComplete === false, JSON.stringify(ph.state))
  expect('报告具体未检查完的对象对',
    result.value?.interference?.incompletePairs?.[0]?.a === '墙A'
      && result.value?.interference?.incompletePairs?.[0]?.b === '墙B', JSON.stringify(result.value?.interference))
  expect('预算限制时不诱导反复减面', /不要为过关反复减面/.test(result.text), result.text.slice(-600))
  const retry = await run(tools, 'model_loop', { verdict: 'done', stop_reason: '只恢复默认检测预算，不改变几何' })
  expect('同样的几何恢复检测预算后完成覆盖', retry.value?.interference?.complete === true,
    JSON.stringify(retry.value?.stopBlockers))
  expect('超过4000个候选的扫描不再被样本上限阻断',
    retry.value?.interference?.triangleCandidates > 4000 && retry.value?.stopped === true,
    JSON.stringify(retry.value?.interference))
}

console.log('\n=== 2b. 几何源跳过对象时不能签收 ===')
{
  const ph = makePhase()
  const tools = makeTools([cubeMesh('完整件', 2, 4)], ph, {
    skipped: [{ id: '预算外对象', why: '超过 maxTriangles 预算' }],
  })
  const result = await run(tools, 'model_loop', {
    verdict: 'done', stop_reason: '尝试签收',
  })
  expect('报告指出被跳过对象', /几何源跳过 1 个对象/.test((result.value?.stopBlockers || []).join('\n')),
    JSON.stringify(result.value?.stopBlockers))
  expect('跳过对象后不解锁贴图阶段', ph.state.modelingComplete === false, JSON.stringify(ph.state))
}

console.log('\n=== 2e. 对象对预算可恢复，不能误导为抽取或三角形预算 ===')
{
  const ph = makePhase()
  const tools = makeTools([denseWall('预算A', 1), denseWall('预算B', 1)], ph)
  const result = await run(tools, 'model_loop', {
    verdict: 'done', stop_reason: '验证对象对覆盖', mesh_pair_budget: 0,
    triangle_work_budget: 20000000, triangle_pair_work_budget: 5000000,
  })
  expect('对象对限额独立于三角形工作预算', result.value?.interference?.skippedPairs === 1
    && result.value?.interference?.candidatePairBudget === 0 && !result.value?.interference?.complete,
    JSON.stringify(result.value?.interference))
  expect('报告要求提高正确预算，不把候选跳过归因于抽取',
    /提高 mesh_pair_budget/.test(result.text) && /不是抽取面数上限/.test(result.text)
      && !/几何源跳过对象时检查抽取预算/.test(result.text), result.text.slice(0, 1600))
  expect('对象对覆盖受限不能签收', ph.state.modelingComplete === false, JSON.stringify(ph.state))
  const retry = await run(tools, 'model_loop', {
    verdict: 'done', stop_reason: '只调整检测预算，保留相同模型', mesh_pair_budget: 1,
  })
  expect('不改模型也能补齐对象对覆盖', retry.value?.interference?.complete === true
    && retry.value?.interference?.skippedPairs === 0 && retry.value?.stopped === true,
    JSON.stringify(retry.value?.stopBlockers))
  const capped = await run(tools, 'model_loop', {
    quick_check: true, verdict: 'continue', next_improvement: '核对外观', mesh_pair_budget: 999999,
  })
  expect('对象对预算保留运行时上限', capped.value?.interference?.candidatePairBudget === 200000,
    JSON.stringify(capped.value?.interference))
}

console.log('\n=== 2c. 视觉复核待办必须复核确认 ===')
{
  const ph = makePhase()
  const reviewState = {
    receivedAt: Date.now(),
    subagentCount: 1,
    lastPromptAt: Date.now(),
    reviewPromptCount: 1,
    reviewResultPromptCount: 1,
    resultValid: true,
    resultParsed: true,
    pendingActions: ['补上缺失的连接板'],
    editsAfterReview: 2,
  }
  const tools = makeTools([cubeMesh('单件', 2, 4)], ph, { reviewState })
  const blocked = await run(tools, 'model_loop', {
    verdict: 'done', stop_reason: '试图签收',
  })
  expect('已有建模改动但复核仍有待办时阻止签收',
    (blocked.value?.stopBlockers || []).some((x) => /复核确认/.test(x)),
    JSON.stringify(blocked.value?.stopBlockers))
  expect('待办未复核时不解锁阶段', ph.state.modelingComplete === false, JSON.stringify(ph.state))

  reviewState.pendingActions = []
  reviewState.receivedAt = Date.now()
  const cleared = await run(tools, 'model_loop', {
    verdict: 'done', stop_reason: '改动已复核确认',
  })
  expect('复核确认无待办后允许签收', cleared.value?.stopped === true, JSON.stringify(cleared.value))
}

console.log('\n=== 2d. 复核任务和无效结果不能被当成已完成 ===')
{
  const pendingState = {
    lastPromptAt: Date.now(), reviewPromptCount: 1, reviewResultPromptCount: 0,
    subagentCount: 1, pendingActions: [], receivedAt: 0, resultValid: false,
  }
  const pendingTools = makeTools([cubeMesh('单件', 2, 4)], makePhase(), {
    reviewState: pendingState,
  })
  const pending = await run(pendingTools, 'model_loop', {
    verdict: 'done', stop_reason: '检测数据通过',
  })
  expect('已派发但未回传时阻止签收', pending.value?.stopped === false,
    JSON.stringify(pending.value?.stopBlockers))
  expect('阻断要求有效回传',
    (pending.value?.stopBlockers || []).some((x) => /还没有收到有效回传/.test(x)),
    JSON.stringify(pending.value?.stopBlockers))

  const invalidState = {
    lastPromptAt: Date.now(), reviewPromptCount: 1, reviewResultPromptCount: 1,
    subagentCount: 1, pendingActions: [], receivedAt: Date.now(), resultValid: false,
  }
  const invalidTools = makeTools([cubeMesh('单件', 2, 4)], makePhase(), {
    reviewState: invalidState,
  })
  const invalid = await run(invalidTools, 'model_loop', {
    verdict: 'done', stop_reason: '检测数据通过',
  })
  expect('格式错误且无待办时仍阻止签收', invalid.value?.stopped === false,
    JSON.stringify(invalid.value?.stopBlockers))
  expect('阻断要求修复复核格式',
    (invalid.value?.stopBlockers || []).some((x) => /没有解析成有效清单/.test(x)),
    JSON.stringify(invalid.value?.stopBlockers))
}

console.log('\n=== 3. model_loop 拿到 done 后解锁贴图 ===')
{
  /* 同一物品组，位置错开但相互插入（插入不算失败，这样才通得过门禁） */
  const meshes = [
    boxAt('椅_座面', 0, 0, 1.0, 2), boxAt('椅_靠背', 0, 0.9, 1.0, 2),
    boxAt('椅_腿1', -0.9, -0.5, 0.9, 2), boxAt('椅_腿2', 0.9, 0.5, 0.9, 2),
  ]
  const ph = makePhase()
  const tools = makeTools(meshes, ph)
  const exec = { signal: new AbortController().signal }

  /* 先跑到满足条件：3 轮 + 连续落实 + detail_notes */
  await run(tools, 'model_loop', { reset: true, verdict: 'continue', next_improvement: 'X' })
  await run(tools, 'model_loop', { verdict: 'continue', landed_previous: true, next_improvement: 'Y' })
  await run(tools, 'model_loop', { verdict: 'continue', landed_previous: true, next_improvement: 'Z' })

  /* 先确认：还没 done 时不允许贴图 */
  const before = await run(tools, 'model_pbr_search', { query: '木' })
  expect('done 之前材质资源工具也可用', before.ok, before.error)

  /* done 签收 */
  const done = await run(tools, 'model_loop', {
    verdict: 'done', landed_previous: true,
    stop_reason: '形体与参考一致，检测全过',
    detail_notes: '外露边加了 0.5mm 倒角，面板分三段，螺丝 12 颗',
  })
  console.log('  canStop=' + done.value?.canStop + ' stopped=' + done.value?.stopped)
  console.log('  阶段: ' + JSON.stringify(ph.state.modelingComplete))
  expect('done 后阶段已解锁', ph.state.modelingComplete === true,
    JSON.stringify(done.value?.stopBlockers))
  expect('文案提示建模完成', /建模阶段已完成/.test(done.text), done.text.slice(-500))
  expect('签收与工具权限分开说明', /材质与几何操作始终可用/.test(done.text), done.text.slice(-400))
  expect('允许回修且提示旧签收失效', /几何再次修改会使旧签收失效/.test(done.text)
    && !/建模就此冻结/.test(done.text), done.text.slice(-400))
  expect('材质计划按复杂度可选，纯几何任务可直接交付',
    /复杂的多物品\/UV\/烘焙工作可用 todo_write 规划/.test(done.text)
      && /任务只要求几何建模，核对实际视图/.test(done.text)
      && !/必须.*todo_write/.test(done.text), done.text.slice(-500))

  /* 现在贴图工具应该可用 */
  const after = await run(tools, 'model_pbr_search', { query: '木' })
  expect('解锁后 model_pbr_search 可用', after.ok, after.error)
}

console.log('\n=== 4. reset 会退回建模阶段 ===')
{
  /* 同一物品组：细腿插进桌面（插入状态，不算失败） */
  const meshes = [
    boxAt('桌_面', 0, 0, 1.0, 2), boxAt('桌_腿1', -0.85, -0.85, 0.95, 0.3),
    boxAt('桌_腿2', 0.85, 0.85, 0.95, 0.3), boxAt('桌_腿3', 0, 0.85, 0.95, 0.3),
  ]
  const ph = makePhase()
  const tools = makeTools(meshes, ph)

  await run(tools, 'model_loop', { reset: true, verdict: 'continue', next_improvement: 'X' })
  await run(tools, 'model_loop', { verdict: 'continue', landed_previous: true, next_improvement: 'Y' })
  await run(tools, 'model_loop', { verdict: 'continue', landed_previous: true, next_improvement: 'Z' })
  const d = await run(tools, 'model_loop', {
    verdict: 'done', landed_previous: true,
    stop_reason: 'OK', detail_notes: '外露边加倒角，螺丝八颗都装好了',
  })
  expect('先解锁', ph.state.modelingComplete === true, JSON.stringify(d.value?.stopBlockers))

  await run(tools, 'model_loop', { reset: true, verdict: 'continue', next_improvement: '改了形体' })
  expect('reset 后回到建模阶段', ph.state.modelingComplete === false,
    JSON.stringify(ph.state))
  const blocked = await run(tools, 'model_pbr_search', { query: '木' })
  expect('reset 后材质工具仍可用', blocked.ok, blocked.error)
}

console.log('\n=== 4a. 局部签收和空白理由不能签收全场景 ===')
{
  const ph = makePhase()
  const tools = makeTools([cubeMesh('主体', 2, 2)], ph)
  const local = await run(tools, 'model_loop', { target: '主体', verdict: 'done', stop_reason: '完成该组' })
  expect('局部可以结束', local.value?.stopped === true, JSON.stringify(local.value?.stopBlockers))
  expect('局部不签收全场景', ph.state.modelingComplete === false)
  const scoped = await run(tools, 'model_loop', { scope: ['主体'], verdict: 'done', stop_reason: '完成指定范围' })
  expect('scope 结果正确标记局部范围', scoped.value?.target !== 'scene')
  expect('scope 不签收全场景', ph.state.modelingComplete === false)
  const blank = await run(tools, 'model_loop', { verdict: 'done', stop_reason: '  \n  ' })
  expect('空白理由不结束检查', blank.value?.stopped === false)
  expect('空白理由不签收全场景', ph.state.modelingComplete === false)
}

console.log('\n=== 5. 分组：完整物品 + 配件 ===')
{
  const meshes = [
    cubeMesh('桌_桌面', 2, 4), cubeMesh('桌_腿1', 2, 4),
    cubeMesh('桌_腿2', 2, 4), cubeMesh('椅_座面', 2, 4),
    cubeMesh('椅_靠背', 2, 4), cubeMesh('椅_腿1', 2, 4),
  ]
  const { groupMeshesIntoItems } = await import('../lib/core/grouping.mjs')
  const groups = groupMeshesIntoItems(meshes)
  console.log('  分组数: ' + groups.length)
  for (const g of groups) {
    console.log('    「' + g.name + '」' + g.parts.length + ' 件: ' + g.parts.join(', '))
  }
  expect('按前缀分成 2 组', groups.length === 2, String(groups.length))
  expect('桌子组有 3 件',
    groups.some((g) => g.name === '桌' && g.parts.length === 3),
    JSON.stringify(groups.map((g) => [g.name, g.parts.length])))
  expect('椅子组有 3 件',
    groups.some((g) => g.name === '椅' && g.parts.length === 3),
    JSON.stringify(groups.map((g) => [g.name, g.parts.length])))
}

console.log('\n' + (failed === 0 ? 'PHASE_GATE_OK' : 'PHASE_GATE_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
