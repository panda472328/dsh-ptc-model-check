/**
 * 验证「专职视觉检测智能体」的完整机制：
 *   ① 里程碑视觉复核提供五视图（不依赖参考图）
 *   ② 每个组都出图（不截断）
 *   ③ 检测智能体只回答三个问题
 *   ④ 输出可执行的修改清单
 *   ⑤ 必须收到有效回传，清单改完后还要复核确认才可签收
 *
 *   node tests/verify_review_agent.mjs
 */

import { buildTools } from '../lib/tools.mjs'
import {
  REVIEW_QUESTIONS, buildReviewerPrompt, parseReview, formatReviewDirective,
} from '../lib/core/review.mjs'
import { pickGroupsForViews, groupMeshesIntoItems } from '../lib/core/grouping.mjs'

const originalFetch = globalThis.fetch
let failReviewImages = false
globalThis.fetch = async (_url, init) => {
  const request = JSON.parse(init.body)
  return {
    ok: true,
    async json() {
      return {
        jsonrpc: '2.0', id: request.id,
        result: failReviewImages
          ? { isError: true, content: [{ type: 'text', text: 'render unavailable' }] }
          : { content: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }] },
      }
    },
  }
}

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

console.log('=== 1. 只问三个问题 ===')
{
  console.log('  问题清单: ' + REVIEW_QUESTIONS.map((r) => r.q).join(' / '))
  expect('恰好三个问题', REVIEW_QUESTIONS.length === 3, String(REVIEW_QUESTIONS.length))
  expect('问题一是结构', REVIEW_QUESTIONS[0].q === '结构对吗', REVIEW_QUESTIONS[0].q)
  expect('问题二是现实', REVIEW_QUESTIONS[1].q === '现实中是这样吗', REVIEW_QUESTIONS[1].q)
  expect('问题三是改进', REVIEW_QUESTIONS[2].q === '还能更好吗', REVIEW_QUESTIONS[2].q)
}

console.log('\n=== 2. 交给检测智能体的任务文本 ===')
{
  const p = buildReviewerPrompt({
    groups: [
      { name: '桌子', parts: ['桌面', '桌腿1', '桌腿2'], dims: [2, 1, 1] },
      { name: '椅子', parts: ['座面', '靠背'], dims: [0.5, 0.5, 0.9] },
    ],
    target: '整场景',
    data: '穿模：2 对\n孤立件：0 个',
    sceneNote: '做一个末日废墟场景，包含倒塌的建筑和废弃车辆',
    reference: null,
  })
  console.log('  文本长度: ' + p.length)
  expect('含三个问题标题', /1\. 结构对吗？/.test(p) && /2\. 现实中是这样吗？/.test(p)
    && /3\. 还能更好吗？/.test(p), p.slice(0, 200))
  expect('含场景背景', p.includes('末日废墟场景'), '')
  expect('含物品组清单', p.includes('桌子') && p.includes('椅子'), '')
  expect('含检测数据', p.includes('穿模：2 对'), '')
  expect('要求输出固定格式', p.includes('## 必须修的（优先级排序）'), '')
  expect('明确禁止做别的事', /不要建模/.test(p) && /不要给材质/.test(p), '')
  expect('要求每组都看图', /每组都要逐个看/.test(p), '')
  expect('有背景时仍自主检查轮廓、结构与表面几何三层',
    p.includes('主体轮廓与比例') && p.includes('结构构件与连接') && p.includes('表面几何细节')
      && p.includes('不需要主智能体另外提交细节清单'), '')
  expect('改进需要视角证据和可见收益',
    p.includes('[组名/部位/视角] 可见证据') && p.includes('改后能看出什么')
      && p.includes('按可见收益排序'), '')
  expect('不把空面或不可见区域自动当缺失',
    p.includes('大块空面本身不等于缺细节') && p.includes('不能编造缺失'), '')
  expect('保留有依据的完成出口，避免无限装饰',
    p.includes('已到位/无需修改') && p.includes('无限加细节')
      && p.includes('不影响目标效果的可选装饰可以舍弃'), '')
  expect('结构身份示例不再要求材质旧化',
    p.includes('楼层比例、门窗开口、入口与支撑关系')
      && !p.includes('该有风化和水渍') && !p.includes('塑料模型'), '')

  const simple = buildReviewerPrompt({
    target: '小屋', style: '低多边形 / 灰模 blockout / 简约',
    groups: [{ name: '小屋', parts: ['屋体', '屋顶'] }], imageCount: 5,
  })
  expect('没有背景时也传递结构画风', simple.includes('**画风：低多边形 / 灰模 blockout / 简约**'), '')
  expect('简化任务按用途、观看距离与预算评估',
    simple.includes('用途、最终观看距离') && simple.includes('时间/面数预算')
      && simple.includes('允许简化') && simple.includes('不要强加写实螺丝'), '')
  expect('结构复核仍只输出三个固定问题',
    (simple.match(/^### \d+\./gm) || []).length === 3, '')

  const material = buildReviewerPrompt({ mode: 'material', target: '小屋', style: '卡通' })
  expect('结构细节策略不进入材质模式',
    !material.includes('## 结构细节的判断标准') && material.includes('**画风：卡通**')
      && material.includes('你只判断材质和 UV'), '')
}

console.log('\n=== 3. 解析检测结果 ===')
{
  const sample = [
    '## 问题 1：结构对吗',
    '结论：基本对但有 2 处问题',
    '问题清单：',
    '  - [桌子] 桌腿没有插进桌面，中间有缝 → 把桌腿上移 0.03 让它插进去',
    '  - [椅子] 靠背悬空，没有和座面连接 → 加一块连接板',
    '',
    '## 问题 2：现实中是这样吗',
    '结论：不是',
    '问题清单：',
    '  - [大楼A] 整栋楼没有地基，直接浮在地面上 → 加 0.5m 高的地基',
    '',
    '## 问题 3：还能更好吗',
    '结论：还能改',
    '改进清单：',
    '  - [桌子] [顶视图] 桌面是光板，没有拼板缝 → 分成 3 段各留 2mm 缝',
    '',
    '## 必须修的（优先级排序）',
    '1. [椅子] 靠背悬空 → 加连接板',
    '2. [大楼A] 没有地基 → 加 0.5m 高地基',
    '3. [桌子] 桌腿没插进桌面 → 上移 0.03',
  ].join('\n')

  const r = parseReview(sample)
  console.log('  parsed: ' + r.parsed)
  console.log('  actions: ' + JSON.stringify(r.actions))
  console.log('  conclusions: ' + JSON.stringify(r.conclusions))
  expect('解析成功', r.parsed === true, '')
  expect('抽出 3 条行动', r.actions.length === 3, String(r.actions.length))
  expect('行动含具体做法', /加连接板/.test(r.actions[0] || ''), String(r.actions[0]))
  expect('抽到三个结论', Object.keys(r.conclusions).length === 3,
    JSON.stringify(r.conclusions))

  const directive = formatReviewDirective(r)
  console.log('\n  --- 渲染给主智能体的指令 ---')
  console.log('  ' + directive.split('\n').slice(0, 10).join('\n  '))
  expect('指令说「必须修改」', /必须修改/.test(directive), '')
  expect('指令列了行动条目', /靠背悬空/.test(directive), '')
}

console.log('\n=== 4. 解析「无需修改」的情形 ===')
{
  const r = parseReview([
    '## 问题 1：结构对吗', '结论：结构完整',
    '## 问题 2：现实中是这样吗', '结论：比例合理',
    '## 问题 3：还能更好吗', '结论：已到位',
    '## 必须修的（优先级排序）', '无需修改', '依据：正后左右顶视图均已检查。',
  ].join('\n'))
  expect('识别出无需修改', r.noChangeNeeded === true, JSON.stringify(r.noChangeNeeded))
  expect('三问齐全时结果有效', r.valid === true, JSON.stringify(r))
  const d = formatReviewDirective(r)
  expect('指令说明无需修改', /无需修改/.test(d), d.slice(0, 200))

  const malformed = parseReview('## 问题 3：还能更好吗\n结论：已到位')
  expect('仅有「已到位」结论不算无需修改', malformed.noChangeNeeded === false, JSON.stringify(malformed))
  expect('缺少结构化清单时结果无效', malformed.valid === false, JSON.stringify(malformed))
}

console.log('\n=== 5. 解析失败时保留原文（不丢内容）===')
{
  const r = parseReview('这是一段完全不符合格式的回答，但里面有重要信息：桌腿断了')
  expect('标记为未解析', r.parsed === false, String(r.parsed))
  expect('保留原文', r.raw.includes('桌腿断了'), '')
  const d = formatReviewDirective(r)
  expect('指令里带出原文', /桌腿断了/.test(d), d.slice(0, 300))
}

console.log('\n=== 6. 每个组都出图（不截断）===')
{
  const fake = []
  for (let i = 0; i < 12; i++) {
    fake.push({
      id: 'm' + i, part: '零件' + i, triangles: 100,
      bbox: [i, 0, 0, i + 1, 1, 1], dims: [1, 1, 1], diag: 1.7,
      meta: { collections: ['组' + (i % 12)] },
    })
  }
  const groups = groupMeshesIntoItems(fake)
  console.log('  分组数: ' + groups.length)
  const all = pickGroupsForViews(groups, { problems: [], outliers: [] }, undefined)
  expect('不传 limit → 全部组', all.length === groups.length,
    all.length + ' vs ' + groups.length)
  const all2 = pickGroupsForViews(groups, { problems: [], outliers: [] }, 0)
  expect('limit=0 → 全部组', all2.length === groups.length, String(all2.length))
  const lim = pickGroupsForViews(groups, { problems: [], outliers: [] }, 3)
  expect('显式 limit=3 → 只取 3', lim.length === 3, String(lim.length))
}

console.log('\n=== 7. 主智能体没照清单改 → 不许停 ===')
{
  const st = { modelingComplete: false }
  /* 加上派发相关字段：新门禁要求「先拿任务文本 → 真的派 subagent」才能回传结果。
   * 这个测试直接调 apply_result，所以要模拟那两步。 */
  const rs = {
    pendingActions: [], receivedAt: 0, noChangeNeeded: false, editsAfterReview: 0,
    lastSubagentAt: 0, lastSubagentPromptCount: 0, subagentCount: 0, lastPromptAt: 0,
    reviewPromptCount: 0, reviewResultPromptCount: 0, resultValid: false, resultParsed: false,
    lastPromptImageCount: 0, lastPromptExpectedImageCount: 0, lastPromptVisualComplete: false,
    latestTask: null,
  }

  const tools = buildTools({
    sourceFor: () => ({
      describe: () => 'live', async resolve() { return 'live' },
      async info() { return { meshes: 2 } },
      async extract() {
        /* 两个零件位置错开：同位置会被判 coincident（重合）→ pass 永远 false，
         * 那样就测不到「改过之后允许停」这一项了。 */
        const mk = (id, cx) => ({
          id, part: id, triangles: 12,
          positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          indices: new Uint32Array([0, 1, 2]),
          bbox: [cx, 0, 0, cx + 1, 1, 1], dims: [1, 1, 1], diag: 1.7,
          meta: { collections: ['物品'] },
        })
        /* 用足够大的偏移：包围盒完全不重叠 → 无穿模。
         * 但这两件会互相孤立——所以给它们各加一个贴近的伴件。 */
        return { meshes: [mk('甲', 0), mk('甲伴', 0.9), mk('乙', 10), mk('乙伴', 10.9)],
          skipped: [], source: 'fake' }
      },
      async namingScan() { return { totalMeshes: 2, named: 2, generic: 0, duplicates: [] } },
      async renderShots(s) { return { shots: s.map((x) => ({ ...x, path: null, attached: false })) } },
      async dispose() {},
    }),
    config: () => ({ maxObjects: 100, maxTriangles: 1000, minDepth: 0.0005, minRatio: 0.005 }),
    remember: () => {},
    hostCtx: { get: (name) => name === 'attachments'
      ? { saveImage: async () => ({ id: 'review-image' }) }
      : undefined },
    getRefState: () => ({ given: false, analyzed: false }),
    markRefAnalyzed: () => {},
    getPhaseState: () => ({ ...st }),
    markModelingComplete: () => {},
    resetPhase: () => {},
    getModelingState: () => ({ dirtySinceCheck: false, editCount: 1, lookSinceEdit: 0 }),
    noteCheck: () => {},
    noteReviewResult: (r) => {
      rs.pendingActions = (r.actions || []).slice()
      rs.receivedAt = Date.now()
      rs.noChangeNeeded = !!r.noChangeNeeded
      rs.resultParsed = !!r.parsed
      rs.resultValid = !!r.valid
      rs.resultTechnicalOverride = !!r.technicalOverride
      rs.resultMode = r.mode
      rs.resultScope = r.scope
      rs.resultCoverageComplete = r.coverageComplete
      rs.resultVisualComplete = r.visualComplete
      rs.resultProvenanceComplete = r.provenanceComplete
      rs.resultTaskId = r.taskId
      rs.reviewResultPromptCount = rs.reviewPromptCount
      rs.editsAfterReview = 0
    },
    getReviewState: () => ({ ...rs }),
    /* 模拟插件在 model_review 给出任务文本时记账 */
    noteReviewPrompt: (info) => {
      rs.lastPromptAt = Date.now()
      rs.reviewPromptCount++
      rs.lastPromptImageCount = info.imageCount
      rs.lastPromptExpectedImageCount = info.expectedImageCount
      rs.lastPromptVisualComplete = info.visualComplete
      rs.latestTask = {
        taskId: info.taskId,
        mode: info.mode,
        target: info.target,
        scope: info.scope,
        coverageComplete: info.coverageComplete,
        groups: info.groups,
        tasks: info.tasks,
        outputs: {},
      }
    },
  })

  /* ① 先让检测给出清单 */
  const rt = tools.find((x) => x.name === 'model_review')

  /* 按真实流程的顺序走三步：
   *   ① model_review 拿任务文本（noteReviewPrompt 记录 lastPromptAt）
   *   ② 派 subagent（插件在 pre-execute 记录 lastSubagentAt）
   *   ③ apply_result 回传
   * 新门禁核对 ①→②→③ 的顺序，所以这里必须按顺序模拟。 */
  const promptStep = await rt.execute({ scene_note: '测试：一个物品组' },
    { signal: new AbortController().signal })
  expect('第 ① 步拿到任务文本', !!promptStep.reviewerPrompt, '')
  expect('任务附齐物品组五视图', promptStep.visualComplete === true
    && promptStep.imageCount === 5, JSON.stringify({ images: promptStep.imageCount, complete: promptStep.visualComplete }))
  expect('复核任务记录整场景覆盖状态', rs.latestTask.scope === 'scene'
    && rs.latestTask.coverageComplete === true, JSON.stringify(rs.latestTask))
  expect('唯一任务标识注入派发 prompt', rs.latestTask.tasks.length === 1
    && promptStep.reviewerPrompt.includes(rs.latestTask.tasks[0].token),
  JSON.stringify(rs.latestTask.tasks))
  /* ② 模拟 subagent/end 为任务标识记录了完整回答 */
  const firstAnswer = '## 必须修的（优先级排序）\n1. [物品] 甲和乙没有连接 → 加一块连接板\n2. 乙缺一条边 → 补上'
  rs.latestTask.outputs[rs.latestTask.tasks[0].token] = [firstAnswer]
  rs.subagentCount = 1

  const applied = await rt.execute({ apply_result: firstAnswer }, { signal: new AbortController().signal })
  console.log('  apply 分支 actionCount: ' + applied.actionCount)
  expect('apply 解析出 2 条', applied.actionCount === 2, String(applied.actionCount))
  expect('完整结构全场景结果可作为技术命中覆盖依据', applied.technicalOverride === true,
    JSON.stringify({ mode: applied.mode, scope: applied.scope, coverage: applied.coverageComplete }))
  expect('记账了 pendingActions', rs.pendingActions.length === 2, String(rs.pendingActions.length))

  /* ② 一条没改就想 done → 应被拦 */
  const lt = tools.find((x) => x.name === 'model_loop')
  const exec = { signal: new AbortController().signal }
  await lt.execute({ reset: true, verdict: 'continue', next_improvement: 'X' }, exec)
  await lt.execute({ verdict: 'continue', landed_previous: true, next_improvement: 'Y' }, exec)
  await lt.execute({ verdict: 'continue', landed_previous: true, next_improvement: 'Z' }, exec)

  const v1 = await lt.execute({
    verdict: 'done', landed_previous: true,
    stop_reason: 'OK', detail_notes: '外露边加了倒角，连接处做了分缝处理',
  }, exec)
  const txt1 = lt.output.render({}, v1).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  console.log('  canStop: ' + v1.canStop + '  reviewSatisfied 相关阻断: '
    + JSON.stringify(v1.stopBlockers.filter((b) => /视觉检测/.test(b))))
  expect('没照清单改 → 不许停', v1.canStop === false, String(v1.canStop))
  expect('阻断语提到视觉检测', v1.stopBlockers.some((b) => /视觉检测/.test(b)),
    JSON.stringify(v1.stopBlockers))
  expect('文案列出待改条目', /连接板/.test(txt1), txt1.slice(-600))

  /* ③ 先复查但还没回传 → 仍不允许停；收到有效「无需修改」结果后放行。 */
  rs.editsAfterReview = 2
  const followupPrompt = await rt.execute({ scene_note: '改动后的复查：一个物品组' }, exec)
  expect('改后重新生成复查任务', !!followupPrompt.reviewerPrompt, '')
  const waiting = await lt.execute({
    verdict: 'done', stop_reason: '等待复查结果',
  }, exec)
  expect('复查结果未回传时继续阻止签收', waiting.canStop === false, JSON.stringify(waiting.stopBlockers))
  expect('阻断说明等待有效回传', waiting.stopBlockers.some((b) => /还没有收到有效回传/.test(b)),
    JSON.stringify(waiting.stopBlockers))

  const clearedAnswer = [
      '## 问题 1：结构对吗', '结论：连接完整',
      '## 问题 2：现实中是这样吗', '结论：比例合理',
      '## 问题 3：还能更好吗', '结论：已到位',
      '## 必须修的（优先级排序）', '无需修改', '依据：连接板和缺失边均已检查。',
    ].join('\n')
  rs.latestTask.outputs[rs.latestTask.tasks[0].token] = [clearedAnswer]
  rs.subagentCount++
  const clearedReview = await rt.execute({ apply_result: clearedAnswer }, exec)
  expect('复查清单确认无需修改', clearedReview.valid === true && clearedReview.noChangeNeeded === true,
    JSON.stringify(clearedReview))

  const v2 = await lt.execute({
    verdict: 'done', landed_previous: true,
    stop_reason: 'OK', detail_notes: '按检测清单加了连接板，补齐了缺失的边',
  }, exec)
  console.log('  canStop(改过后): ' + v2.canStop
    + '  blockers: ' + JSON.stringify(v2.stopBlockers))
  expect('改过之后允许停', v2.canStop === true, JSON.stringify(v2.stopBlockers))
  const txt2 = lt.output.render({}, v2).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  expect('文案确认最新视觉复核有效且无待办',
    /视觉复核结果有效，且没有未处理的修改项/.test(txt2), txt2.slice(-500))

  console.log('\n=== 8. 缺少五视图时，格式正确的回答也不能签收 ===')
  {
  failReviewImages = true
  const rt = tools.find((x) => x.name === 'model_review')
  const exec = { signal: new AbortController().signal }
  const prompt = await rt.execute({ scene_note: '没有成功渲染的测试复核' }, exec)
  expect('标记视觉覆盖不完整', prompt.visualComplete === false && prompt.imageCount === 0,
    JSON.stringify({ visualComplete: prompt.visualComplete, imageCount: prompt.imageCount }))

  const incompleteVisualAnswer = [
      '## 问题 1：结构对吗', '结论：结构完整',
      '## 问题 2：现实中是这样吗', '结论：比例合理',
      '## 问题 3：还能更好吗', '结论：已到位',
      '## 必须修的（优先级排序）', '无需修改', '依据：检查过全部视图。',
    ].join('\n')
  rs.latestTask.outputs[rs.latestTask.tasks[0].token] = [incompleteVisualAnswer]
  rs.subagentCount++
  const result = await rt.execute({ apply_result: incompleteVisualAnswer }, exec)
  expect('答案结构正确但视觉复核无效', result.parsed === true && result.valid === false,
    JSON.stringify(result))
  const text = rt.output.render({}, result).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  expect('明确提示切回 live 场景重做复核', /没有附齐五视图/.test(text), text.slice(0, 400))
  }
}

console.log('\n' + (failed === 0 ? 'REVIEW_AGENT_OK' : 'REVIEW_AGENT_FAILED ' + failed))
globalThis.fetch = originalFetch
process.exitCode = failed === 0 ? 0 : 1
