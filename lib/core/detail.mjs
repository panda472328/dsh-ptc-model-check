/** 默认细化流程：主动设计与有依据的复核并用，不用面数或对象数冒充细节质量。 */
export const AUTONOMOUS_DETAIL_WORKFLOW = `### 默认自主细化：构思 → 主体 → 结构 → 表面 → 看图修正

普通完整建模任务默认主动执行这个流程，用户无需再说「多做细节」，也不必逐轮确认。
用户指定的风格、参考、用途、时间和几何预算优先；草模、低模、简约或局部修复按该范围完成。

1. 开工时先按物品身份、用途和风格发散可选方向：轮廓与负空间、功能分区、装配连接、
   加工工艺、操作维护、材料对比与使用状态。选择能相互支持的设计语言，再随草模逐步确定参数。
   原创细节可由功能和风格推导，明确是设计设想即可，不要求每项创意都有网页出处。
   不必把所有角度都做进模型，也不要只扩写计划；先落实最影响辨识度与层次的设计。
2. 主体成型后，按这个物品的身份和参考找缺口：先看轮廓、比例和辨识特征，
   再看组成、连接和功能结构，最后看适合该风格的表面几何层次。
   例如机械的外壳分区与连接、建筑的入口和窗框、生物的关节和形体转折；按对象选，别套同一份配件表。
3. 从实际缺口或选定的原创设计中选当前最影响成品的一批，写成「部位 + 功能/视觉依据 → 具体几何动作 + 可见收益」，
   然后直接调用建模工具落实。已有清单可补进去；不用为此另建强制计划或等待用户确认。
   缺少结构依据时只查对应问题，拿到依据就回到建模，不反复搜索或只扩写计划。
4. 在主体完成、细化批次完成或准备交付时，主动获取视图并复核。
   用 model_review 把目标、风格和用途传给检测员；禁用子代理或预算受限时用 reviewer: 'self' 自查，落实可执行缺口后再复查；
   中间小改仍用快速检查。细节在全景里看不清时聚焦相关组/部位或用 look 看近景，不能据缩略图宣称已完成。
5. 按目标观看距离分配细节：先把大轮廓和结构做好，再做近景能读出的表面变化。
   改变轮廓、厚度、连接和明显遮挡的细节用几何；只影响微小表面质感的留给材质阶段。
   需要留白、对称或重复的设计要保留；不要靠随机散件、全表面刻线、增加面数或材质掩盖结构缺失。
6. 每批改完对照新图确认收益；同一问题反复出现时更换做法，视图不足时先补视图。
   已满足用户目标且没有有依据、可见的高价值缺口时就停止；预算用尽或工具受限时说明具体遗留项。
   不设最低轮数和零件数量，不为填满每一面无限加装饰。最终仍对整场景执行 model_loop 完整验收。

### 多物品场景的自主细化

按用户的整体场景目标启用，不等建出多个组。先构想功能分区、空间序列和主次体块，
把选定的布局写入任务记忆，先完成全局草模，再逐区细化；细化不能只是在主角上继续加零件。按轮次交替检查：
主次与前中后景、地面/边界/连接和落点、符合主题的环境系统、重复元素的变化、
大中小细节与留白、全局风格统一。每轮选一个最有收益的场景关系或环境构件实际建模，
再看整场景图确认比例、距离、遮挡、密度和叙事是否改善；主题不需要的装饰不添加。
场景阶段只是开放式下一步提示，不是固定物体数量、装饰数量或面数门槛。
`

const SCENE_DETAIL_STAGES = [
  {
    name: '构图与层级',
    next: (focus) => '把整场景当成一个构图处理：从' + focus + '中确认主视觉焦点，安排其它组形成前景、中景或远景，调整相对尺寸、距离、朝向和遮挡；若主题需要，再补一个能说明空间关系的环境构件。',
    checklist: [
      '对照整体布局，是否只完成一个主角而遗漏选定的主要分区；组数本身不证明覆盖。',
      '主视觉焦点是否清楚，次要组有没有抢主体。',
      '前景、中景、远景是否有尺度和距离变化，而不是所有组平铺在同一层。',
      '组间的遮挡、留白和视线通道是否服务主题。',
    ],
  },
  {
    name: '空间落点与连接',
    next: () => '检查每个主要组如何落地、承托、进入和离开空间：按主题补地面、台阶、道路、边界、支撑、连接或过渡构件，修正悬空、漂浮和互相穿入；不要用随机小件掩盖空间关系。',
    checklist: [
      '主要物体是否有合理的地面、支撑或悬挂依据。',
      '组与组之间是否有道路、边界、连接、间隙或明确的相对关系。',
      '场景边缘、底部和转角是否需要有能解释空间的过渡。',
    ],
  },
  {
    name: '主题环境系统',
    next: () => '从任务主题推导环境语义：选择少量真正能说明地点、用途或事件的系统性构件，并让它们与主体发生关系；优先做成可复用但有位置依据的模块，不套固定配件表。',
    checklist: [
      '环境构件是否能说明场景发生在哪里、用于什么或发生过什么。',
      '环境构件是否与主体有功能、动线、遮挡或尺度关系。',
      '是否把没有语义的散件误当成场景丰富度。',
    ],
  },
  {
    name: '重复变化与叙事',
    next: () => '找出场景里重复出现的构件，给它们加入有依据的变化：尺寸、间距、方向、状态、材质或损坏程度；让变化形成使用痕迹、时间感或功能差异，避免复制粘贴感。',
    checklist: [
      '重复元素是否有节奏和变化，而不是完全等距、等角度、同一状态。',
      '变化是否能由功能、受力、使用、时间或风格解释。',
      '叙事是否通过物体之间的关系表达，而不是只在单件表面加纹理。',
    ],
  },
  {
    name: '密度与留白',
    next: () => '从整场景检查大、中、小体块和留白的节奏：把高价值细节放在视线会经过、能形成尺度参照或能加强主题的位置；疏密不均时调整空间关系，不盲目堆装饰。',
    checklist: [
      '主体附近、中景和远景的细节密度是否有层次。',
      '是否保留必要的留白、通道和视觉呼吸，避免所有区域同样拥挤。',
      '小细节是否从整场景仍能读出作用，还是只增加噪声。',
    ],
  },
  {
    name: '全局统一',
    next: () => '最后从整场景统一检查尺度、风格、色彩/材质语言、光照受光和视觉焦点；把互相矛盾的设计取舍统一起来，再回到仍有证据的局部缺口。',
    checklist: [
      '不同组的尺度、细节级别和风格语言是否属于同一个场景。',
      '材质、颜色、明暗和受光是否帮助区分主次，而不是各自独立。',
      '全景缩小时仍能读出主题，近看时又有合理的层次。',
    ],
  },
]

function sceneFocusText(groups, digest) {
  const rows = Array.isArray(digest?.groups) ? digest.groups : []
  const byName = new Map(rows.map((r) => [r.name, r]))
  const ranked = [...groups].sort((a, b) => {
    const ai = Number(byName.get(a.name)?.issueCount) || 0
    const bi = Number(byName.get(b.name)?.issueCount) || 0
    return bi - ai || (Number(b.triangles) || 0) - (Number(a.triangles) || 0)
  })
  const names = ranked.slice(0, 3).map((g) => '「' + String(g.name || '未命名组') + '」')
  return names.length ? names.join('、') : '当前物品组'
}

/**
 * 多物品场景的细化状态。它只提供开放式下一步，不把丰富度变成数量门禁。
 * 传入的 groups 只读名称和摘要字段，不把完整 mesh 数据写回上下文。
 */
export function buildSceneDetailGuidance(o = {}) {
  const groups = Array.isArray(o.groups)
    ? o.groups.filter((g) => g && g.name)
    : []
  const target = String(o.target || 'scene')
  const scope = o.designIntent?.scope
  const active = target === 'scene' && scope !== 'single' && scope !== 'local'
    && (scope === 'scene' || groups.length > 1)
    && o.stopped !== true && o.modelingComplete !== true
  const round = Math.max(1, Number(o.round) || 1)
  if (!active) {
    return {
      active: false,
      stage: 'inactive',
      stageIndex: -1,
      round,
      groupCount: groups.length,
      meshCount: Number(o.meshCount) || 0,
      focus: [],
      next: '',
      checklist: [],
    }
  }
  const stageIndex = scope === 'scene' && groups.length < 2 ? 0 : (round - 1) % SCENE_DETAIL_STAGES.length
  const stage = SCENE_DETAIL_STAGES[stageIndex]
  const focus = groups.slice(0, 3).map((g) => String(g.name))
  const focusText = sceneFocusText(groups, o.groupDigest)
  return {
    active: true,
    stage: stage.name,
    stageIndex,
    round,
    groupCount: groups.length,
    meshCount: Number(o.meshCount) || groups.reduce((n, g) => n + (Array.isArray(g.parts) ? g.parts.length : 0), 0),
    focus,
    next: (scope === 'scene' ? '对照整体布局意图' + (o.designIntent.layout ? '「' + String(o.designIntent.layout).slice(0, 350) + '」' : '（先把选定的分区与空间关系写入任务记忆）')
      + '，核对全局体块与主要分区是否已落实；当前组数不证明完成或缺失。' : '') + stage.next(focusText),
    checklist: stage.checklist.slice(),
    signals: {
      dirtyGroups: Number(o.groupDigest?.dirtyGroups) || 0,
      ungrouped: groups.filter((g) => g.by === 'ungrouped').map((g) => String(g.name)),
    },
  }
}

/** 与每轮工具结果一起反馈，避免规则只停留在初始长提示词中。 */
export function buildDetailGuidance(o = {}) {
  const target = o.target || 'scene'
  /* 传入 sceneGroups 时按当前状态重算；这样签收后又改动场景时，
   * 上下文不会继续复用旧的 inactive 场景状态。 */
  const sceneDetail = Array.isArray(o.sceneGroups) ? buildSceneDetailGuidance({
    target,
    designIntent: o.designIntent,
    groups: o.sceneGroups,
    groupDigest: o.groupDigest,
    meshCount: o.meshCount,
    round: o.round,
    stopped: o.stopped,
    modelingComplete: o.modelingComplete,
  }) : (o.sceneDetail || buildSceneDetailGuidance({
    target,
    designIntent: o.designIntent,
    groups: o.sceneGroups,
    groupDigest: o.groupDigest,
    meshCount: o.meshCount,
    round: o.round,
    stopped: o.stopped,
    modelingComplete: o.modelingComplete,
  }))
  const review = o.review || {}
  const promptCount = Number(review.reviewPromptCount) || (review.lastPromptAt ? 1 : 0)
  const resultCount = Number(review.reviewResultPromptCount)
    || (review.receivedAt && !review.lastPromptAt ? 1 : 0)
  const reviewPending = promptCount > resultCount
  const reviewInvalid = !reviewPending && review.receivedAt && review.resultValid === false
  const visualReady = o.visualReady === true
  const selfReview = review.latestTask?.reviewer === 'self'
  let stage
  let next
  if (o.stopped || o.modelingComplete) {
    return { stage: 'complete', target, visualReady, next: '', lines: [], sceneDetail }
  }
  if (reviewPending && review.lastPromptExpectedImageCount > 0 && !review.lastPromptVisualComplete) {
    stage = 'restore_views'
    next = '当前复核任务缺少完整图片，先恢复视图再重新生成 model_review 任务；不要在缺图任务上编造结论。'
  } else if (reviewPending) {
    stage = 'await_review'
    next = selfReview
      ? '先按当前任务附图完成自查，保留任务标识并回传结果；不调用子代理。再按具体缺口细化，不另起重复复核任务。'
      : '先完成当前独立视觉复核并回传有效结果，再按其中的具体缺口细化；不要另起重复复核任务。'
  } else if (reviewInvalid) {
    stage = 'repeat_review'
    next = '最新回传无效，按当前复核方式重新取得格式完整的结果，再据此细化；不能把无效清单当成通过。'
  } else if ((review.pendingActions || []).length) {
    if (review.editsAfterReview > 0) {
      stage = 'verify_revision'
      next = '已记录复核后的改动，确认相关清单都已落实后，针对改动范围重新调用 model_review 复查；有场景改动不代表待办已解决。'
    } else {
      stage = 'revise'
      next = '先落实最新复核清单的相关改动，再针对改动范围重新复核；不要用无关的小装饰代替待办。'
    }
  } else if (o.inspectionComplete === false) {
    stage = 'inspection_limit'
    next = '检查覆盖受限不等于模型有错；先按报告调整检测或抽取预算，保留细节和 Collection。不要反复减面、删件或 join 零件；同一限制仍存在时说明工具边界，停止无效重试。'
  } else if (o.groupingOk === false) {
    stage = 'repair'
    next = '先按完整物品修复 Collection 分组，让后续视图和细化有可靠范围，再继续补结构和表面细节。'
  } else if (o.quickCheck) {
    stage = 'prepare_visual'
    next = '本轮未渲图，不能据技术通过认定细节到位。到主体或当前细化批次完成时，主动用 model_review 获取重点组视图并按可用复核方式检查。'
  } else if (!visualReady) {
    stage = 'restore_views'
    next = '本轮视图没有完整附给模型。先恢复图片输出或获取可见视图，再判断缺失细节；不要编造看图结论。'
  } else {
    stage = 'assess_detail'
    next = '现在看本轮视图，依次核对轮廓与辨识特征、连接与功能结构、表面几何层次。结合选定的原创设计，落实符合用途且在目标视距可见的高价值改进；关键批次用 model_review 复核。没有高价值缺口时按用户目标收尾。'
  }
  const lines = ['自主细化：' + next]
  if (stage === 'assess_detail' || stage === 'prepare_visual') {
    lines.push('  按物品身份、风格和用途主动设计细节，分清来源事实和原创设想；几何自洽不等于成品丰富。已有 next_improvement 优先落实，不另建重复计划。')
  }
  /* 场景指导放在普通细化阶段，复核/修复等硬待办优先显示。 */
  if (sceneDetail.active && (stage === 'assess_detail' || stage === 'prepare_visual')) {
    lines.push('场景细化（第 ' + (Number(sceneDetail.stageIndex) + 1) + ' 阶段：' + sceneDetail.stage + '）：' + sceneDetail.next)
    lines.push('  场景级核对：' + sceneDetail.checklist.join('；'))
    lines.push('  本轮不要只给单件物体加零件；至少处理一个有依据的组间关系、空间过渡或环境层次。')
  }
  return { stage, target, visualReady, next, lines, sceneDetail }
}
